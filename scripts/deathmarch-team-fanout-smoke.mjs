import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatDeathmarchDiscordMessage,
  processDeathmarchEvents,
  sanitizeEventForAnonymity,
} from "./deathmarch.mjs";
import {
  loadDeathmarchEvents,
  parseConfiguredMembers,
  resolveDeathmarchMembers,
} from "./deathmarch-event-source.mjs";

const MANAGER = { accountId: "acct_manager", handle: "goodalexander", walletAddress: "rManagerWallet000000000000000000000" };
const REPORTS = [
  { accountId: "acct_alpha", handle: "alphadev", walletAddress: "rAlphaWallet0000000000000000000000" },
  { accountId: "acct_beta", handle: "betadev", walletAddress: "rBetaWallet00000000000000000000000" },
  { accountId: "acct_gamma", handle: "gammadev", walletAddress: "rGammaWallet000000000000000000000" },
];
const UNSHARED = { accountId: "acct_private", handle: "privatedev", walletAddress: "rPrivateWallet00000000000000000000" };

// Fake collaboration database: manager has mutual grants with three reports,
// an outgoing-only grant with acct_private (their history is not shared), and
// acct_gamma has no linked wallet.
const grants = [
  ...REPORTS.map((member) => ({ subject_account_id: member.accountId, viewer_account_id: MANAGER.accountId })),
  ...REPORTS.map((member) => ({ subject_account_id: MANAGER.accountId, viewer_account_id: member.accountId })),
  { subject_account_id: MANAGER.accountId, viewer_account_id: UNSHARED.accountId },
];
const linkedWallets = new Map([
  [MANAGER.accountId, MANAGER.walletAddress],
  [REPORTS[0].accountId, REPORTS[0].walletAddress],
  [REPORTS[1].accountId, REPORTS[1].walletAddress],
  [UNSHARED.accountId, UNSHARED.walletAddress],
]);
const handles = new Map([MANAGER, ...REPORTS, UNSHARED].map((member) => [member.accountId, member.handle]));

function dbRow({ member, taskId, eventType = "pf.task.submission.v1", suffix = "" }) {
  return {
    event_type: eventType,
    task_id: taskId,
    account_id: member.accountId,
    wallet_address: member.walletAddress,
    source_tx_hash: `offchain:${taskId}${suffix}`,
    source_cid: `postgres:${taskId}${suffix}`,
    occurred_at: "2026-09-11T12:00:00.000Z",
    payload_json: { schema: eventType, task_id: taskId, title: `Task for ${member.handle}`, phase: eventType === "pf.task.submission.v1" ? "initial_submission" : "" },
    pointer_json: { schema: eventType, source: "direct_write", offchain: true },
  };
}
const eventsByAccount = new Map([
  [REPORTS[0].accountId, [dbRow({ member: REPORTS[0], taskId: "task_alpha_1" }), dbRow({ member: REPORTS[0], taskId: "task_alpha_2", eventType: "pf.reward.v1" })]],
  [REPORTS[1].accountId, [dbRow({ member: REPORTS[1], taskId: "task_beta_1", eventType: "pf.task.verification_response.v1" })]],
  [MANAGER.accountId, [dbRow({ member: MANAGER, taskId: "task_manager_1" })]],
  [UNSHARED.accountId, [dbRow({ member: UNSHARED, taskId: "task_private_1" })]],
]);
const queriedWallets = [];
async function fakeQuery(text, params) {
  if (text.includes("FROM task_history_grants")) return { rows: grants };
  if (text.includes("FROM account_linked_wallets WHERE wallet_address")) {
    const accountId = [...linkedWallets.entries()].find(([, wallet]) => wallet === params[0])?.[0] || "";
    return { rows: accountId ? [{ account_id: accountId }] : [] };
  }
  if (text.includes("FROM account_linked_wallets WHERE account_id")) {
    const wallet = linkedWallets.get(params[0]);
    return { rows: wallet ? [{ wallet_address: wallet }] : [] };
  }
  if (text.includes("FROM app_accounts")) return { rows: [{ hive_handle: handles.get(params[0]) || "" }] };
  if (text.includes("FROM task_events")) {
    queriedWallets.push(params[1]);
    const rows = (eventsByAccount.get(params[3]) || []).filter((row) => row.wallet_address === params[1] || row.account_id === params[3]);
    // The same off-chain row can also be surfaced through the wallet match; return it twice to
    // prove cross-feed dedupe.
    return { rows: [...rows, ...rows] };
  }
  throw new Error(`unexpected_query:${text.slice(0, 40)}`);
}

const env = {
  DEATHMARCH_DATABASE_URL: "postgres://fake",
  PFTL_HISTORY_DISABLED: "true",
  DEATHMARCH_DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
};

// 1. Member resolution: three direct reports resolved by handle and wallet; the
//    account without a shared task history and the one without a wallet are
//    skipped with a reason and never polled.
const resolved = await resolveDeathmarchMembers({ wallet: MANAGER.walletAddress, env, queryImpl: fakeQuery });
assert.deepEqual(resolved.members.map((member) => member.handle).sort(), ["", "alphadev", "betadev"].sort());
assert.equal(resolved.members[0].walletAddress, MANAGER.walletAddress, "manager wallet stays first");
assert.equal(resolved.members[0].accountId, MANAGER.accountId);
assert.deepEqual(resolved.skipped.sort((a, b) => a.accountId.localeCompare(b.accountId)), [
  { accountId: "acct_gamma", reason: "wallet_not_linked" },
  { accountId: "acct_private", reason: "task_history_not_shared" },
]);
assert.equal(JSON.stringify(resolved.skipped).includes("privatedev"), false, "skip log must not leak handles");

// 2. Fan-out with cross-feed dedupe: one event per report even though each row
//    was returned twice, and the unshared member is never queried.
//    (Chain history is disabled in this env; wallet feed returns nothing.)
const events = await loadDeathmarchEvents({
  wallet: MANAGER.walletAddress,
  members: resolved.members,
  env,
  queryImpl: fakeQuery,
  chainHistoryImpl: async () => [],
});
assert.equal(queriedWallets.includes(UNSHARED.walletAddress), false, "unshared member must never be polled");
assert.deepEqual(events.map((event) => `${event.member.handle}:${event.taskId}:${event.actionKind}`).sort(), [
  ":task_manager_1:initial_verification",
  "alphadev:task_alpha_1:initial_verification",
  "alphadev:task_alpha_2:reward_outcome",
  "betadev:task_beta_1:verification_response",
].sort());
assert.equal(new Set(events.map((event) => event.eventKey)).size, events.length, "eventKeys are unique across feeds");

// 3. Posting: exactly one Discord post per event, attributed by handle, and a
//    restart (second run against the same state file) posts nothing.
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "deathmarch-fanout-"));
const statePath = path.join(tempDir, "state.json");
const posted = [];
const botEnv = { ...env, DEATHMARCH_DISCORD_WEBHOOK_URL: "", DISCORD_BOT_TOKEN: "test-token", DEATHMARCH_DISCORD_CHANNEL_ID: "123" };
const fetchImpl = async (url, options) => {
  posted.push(JSON.parse(options.body).content);
  return { ok: true, status: 200, text: async () => "", json: async () => ({ id: `msg_${posted.length}` }) };
};
const first = await processDeathmarchEvents({ events, anonymity: 3, statePath, env: botEnv, fetchImpl });
assert.equal(first.posted, 4);
assert.equal(first.failed, 0);
assert.deepEqual(first.results.map((result) => result.discord.messageId), ["msg_1", "msg_2", "msg_3", "msg_4"], "Discord message ids are recorded per post");
const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
assert.equal(Object.values(persisted.seen).filter((entry) => entry.discord?.messageId).length, 4, "message ids persist in state");
assert.equal(posted.filter((content) => content.startsWith("**@alphadev** · ")).length, 2);
assert.equal(posted.filter((content) => content.startsWith("**@betadev** · ")).length, 1);
assert.equal(posted.filter((content) => content.startsWith("**Evidence submitted**")).length, 1, "manager without configured handle keeps the legacy header");
const second = await processDeathmarchEvents({ events, anonymity: 3, statePath, env: botEnv, fetchImpl });
assert.equal(second.posted, 0, "restart with persisted state must not double-post");
assert.equal(posted.length, 4);
const duplicateDelivery = await processDeathmarchEvents({
  events: [...events, ...events],
  anonymity: 3,
  statePath: path.join(tempDir, "dup.json"),
  env: botEnv,
  fetchImpl,
});
assert.equal(duplicateDelivery.posted, 4, "duplicate delivery inside one batch posts once per event");
assert.equal(posted.length, 8);

// 4. Redaction unchanged: attribution is added outside the sanitized packet, so
//    the sanitized event and message body are byte-identical with or without a member.
const sensitive = {
  ...events.find((event) => event.member.handle === "alphadev"),
  payload: { schema: "pf.task.submission.v1", task_id: "task_alpha_1", title: "Client work", description: "Deliverable for ACME Capital" },
};
const classification = { level: 2, category: "client task", sensitive_entities: [{ kind: "client", name: "ACME Capital" }], sensitive_strategy_details: [] };
const withMember = sanitizeEventForAnonymity(sensitive, 2, classification);
const withoutMember = sanitizeEventForAnonymity({ ...sensitive, member: undefined }, 2, classification);
assert.deepEqual(withMember, withoutMember, "member attribution must not change the sanitized packet");
assert.equal(withMember.anonymity_level, 2);
assert.equal(Object.prototype.hasOwnProperty.call(withMember, "member_handle"), false, "handle never enters the sanitized packet");
assert.equal(JSON.stringify(withMember).includes("ACME Capital"), false);
const message = formatDeathmarchDiscordMessage({ summary: "Submitted the deliverable.", event: { ...withMember, member_handle: "alphadev" } });
const plain = formatDeathmarchDiscordMessage({ summary: "Submitted the deliverable.", event: withMember });
assert.equal(message, `**@alphadev** · ${plain}`);

// 5. Explicit member list config for environments without the collaboration database.
assert.deepEqual(parseConfiguredMembers("alphadev=rAlpha,@betadev=rBeta"), [
  { accountId: "", handle: "alphadev", walletAddress: "rAlpha" },
  { accountId: "", handle: "betadev", walletAddress: "rBeta" },
]);
assert.deepEqual(parseConfiguredMembers('[{"handle":"x","walletAddress":"rX","accountId":"acct_x"}]'), [
  { accountId: "acct_x", handle: "x", walletAddress: "rX" },
]);
const configuredOnly = await resolveDeathmarchMembers({ wallet: MANAGER.walletAddress, env: { ...env, DEATHMARCH_MEMBERS: "alphadev=rAlpha" }, queryImpl: async () => { throw new Error("must_not_query"); } });
assert.deepEqual(configuredOnly.members.map((member) => member.walletAddress), [MANAGER.walletAddress, "rAlpha"]);

await fs.rm(tempDir, { recursive: true, force: true });
console.log("deathmarch team fanout smoke ok");
