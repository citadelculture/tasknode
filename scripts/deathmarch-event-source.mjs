import { isIdentifierChar, replaceCharacterRuns } from "../shared/text-protocol.js";
import fs from "node:fs/promises";
import pg from "pg";

import { fetchHistoricalAccountTransactions, extractPftPointerEvents } from "../server/context-history-rpc.js";
import { fetchContextIpfsJson } from "../server/context-ipfs.js";
import { fetchAndDecryptTasknodePayload } from "../server/task-payloads.js";
import {
  configuredDeathmarchUserMnemonic,
  decryptTasknodeUserMnemonicPayload,
} from "./deathmarch-identity.mjs";

const { Pool } = pg;

const TASK_KIND_LABELS = new Set(["TASK", "TASK_UPDATE", "TASK_SUBMISSION", "REWARD"]);
const TASK_SCHEMAS = new Set([
  "pf.task.request.v1",
  "pf.task.offer.v1",
  "pf.task.update.v1",
  "pf.task.submission.v1",
  "pf.task.verification_response.v1",
  "pf.reward.v1",
]);
let deathmarchDbPool = null;

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function safeErrorCode(error) {
  return replaceCharacterRuns(safeText(error?.code || error?.message || error?.name || "deathmarch_error", 240),char=>!isIdentifierChar(char)&&char!=="."&&char!==":","_")
    .slice(0, 240);
}

function deathmarchDatabaseUrl(env = process.env) {
  return safeText(env.DEATHMARCH_DATABASE_URL || env.DATABASE_URL || "", 4000);
}

function databaseEventsEnabled(env = process.env) {
  return env.DEATHMARCH_DATABASE_EVENTS_ENABLED !== "false" && Boolean(deathmarchDatabaseUrl(env));
}

export function observeDeathmarchDatabasePool(pool, { logger = console } = {}) {
  if (!pool || typeof pool.on !== "function") {
    throw new Error("deathmarch_database_pool_invalid");
  }
  pool.on("error", (error) => {
    try {
      logger.error?.(`deathmarch_database_pool_error:${safeErrorCode(error)}`);
    } catch {
      // A logger failure must never turn a recoverable idle-client error into a process crash.
    }
  });
  return pool;
}

async function deathmarchDatabaseQuery(text, params = [], env = process.env) {
  const connectionString = deathmarchDatabaseUrl(env);
  if (!connectionString) throw new Error("deathmarch_database_url_missing");
  if (!deathmarchDbPool) {
    deathmarchDbPool = observeDeathmarchDatabasePool(new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: clampInteger(env.DEATHMARCH_DATABASE_CONNECTION_TIMEOUT_MS, 5000, 500, 60000),
      idleTimeoutMillis: clampInteger(env.DEATHMARCH_DATABASE_IDLE_TIMEOUT_MS, 30000, 1000, 300000),
      query_timeout: clampInteger(env.DEATHMARCH_DATABASE_QUERY_TIMEOUT_MS, 10000, 500, 120000),
      application_name: "tasknodeofficial:deathmarch",
    }));
  }
  return deathmarchDbPool.query(text, params);
}

function normalizeActionKind({ schema = "", payload = {}, pointer = {} } = {}) {
  const normalizedSchema = safeText(schema || payload.schema || payload.event_type, 160);
  const phase = safeText(payload.phase, 120);
  const transition = safeText(payload.transition || payload.status_after || payload.status, 120);
  const kind = safeText(pointer.kindLabel || pointer.kind || payload.kind, 120).toUpperCase();
  if (normalizedSchema === "pf.task.request.v1") return "task_request";
  if (normalizedSchema === "pf.task.offer.v1") return "task_offer";
  if (normalizedSchema === "pf.task.update.v1") return transition ? `task_update_${transition}` : "task_update";
  if (normalizedSchema === "pf.task.submission.v1" && phase === "verification_response") return "verification_response";
  if (normalizedSchema === "pf.task.submission.v1") return "initial_verification";
  if (normalizedSchema === "pf.task.verification_response.v1") return "verification_response";
  if (normalizedSchema === "pf.reward.v1") return "reward_outcome";
  if (kind === "TASK_SUBMISSION") return "task_submission";
  if (kind === "TASK_UPDATE") return "task_update";
  return "task_pointer";
}

function normalizeEvent(input = {}) {
  const row = safeObject(input);
  const payload = safeObject(row.payload || row.rawPayload || row.payload_json || row.payloadJson);
  const pointer = safeObject(row.pointer || row.pointer_json || row.pointerJson);
  const schema = safeText(
    row.event_type || row.eventType || row.schema || payload.schema || pointer.schema || "",
    180
  );
  const txHash = safeText(
    row.source_tx_hash || row.sourceTxHash || row.tx_hash || row.txHash || pointer.txHash || pointer.tx_hash || "",
    180
  ).toUpperCase();
  const cid = safeText(row.source_cid || row.sourceCid || row.cid || pointer.cid || "", 240);
  const taskId = safeText(
    row.task_id || row.taskId || payload.task_id || payload.taskId || pointer.taskId || pointer.task_id || "",
    180
  );
  const normalized = {
    schema,
    actionKind: normalizeActionKind({ schema, payload, pointer }),
    taskId,
    txHash,
    cid,
    memoIndex: row.memo_index ?? row.memoIndex ?? pointer.memoIndex ?? pointer.memo_index ?? 0,
    occurredAt: safeText(row.occurred_at || row.occurredAt || row.created_at || row.createdAt || pointer.createdAt || "", 80),
    pointerKind: safeText(row.pointer_kind || row.pointerKind || pointer.kindLabel || pointer.kind || "", 80),
    payload,
    pointer,
    raw: row,
  };
  normalized.eventKey = [
    normalized.txHash || "no_tx",
    normalized.memoIndex,
    normalized.cid || "no_cid",
    normalized.schema || normalized.actionKind,
  ].join(":");
  return normalized;
}

function fileEventsFromValue(value) {
  if (Array.isArray(value)) return value.flatMap(fileEventsFromValue);
  const object = safeObject(value);
  if (Array.isArray(object.traced_events)) return object.traced_events;
  if (Array.isArray(object.reward_events)) return object.reward_events;
  if (Array.isArray(object.events)) return object.events;
  if (Array.isArray(object.samples)) return object.samples.flatMap((sample) => {
    return safeArray(sample.reward_events).map((event) => ({
      ...event,
      task_id: event.task_id || sample.task_id,
      title: sample.title,
      project_id: sample.project_id,
    }));
  });
  return [object];
}

export function isDeathmarchTaskEvent(event = {}) {
  const schema = safeText(event.schema || event.payload?.schema, 120);
  if (schema === "pf.daily_airdrop.v1") return false;
  if (schema === "pf.task.reward_decision.v1") return false;
  if (TASK_SCHEMAS.has(schema)) return true;
  const pointerKind = safeText(event.pointerKind || event.pointer?.kindLabel || "", 120).toUpperCase();
  if (pointerKind === "REWARD") return false;
  return TASK_KIND_LABELS.has(pointerKind);
}

async function loadEventsFromFile(filePath) {
  const value = JSON.parse(await fs.readFile(filePath, "utf8"));
  return fileEventsFromValue(value).map(normalizeEvent).filter(isDeathmarchTaskEvent);
}

async function fetchAndDecryptDeathmarchPayload({ cid, env = process.env } = {}) {
  try {
    return await fetchAndDecryptTasknodePayload({ cid, env });
  } catch (serviceError) {
    const mnemonic = configuredDeathmarchUserMnemonic(env);
    if (!mnemonic) throw serviceError;
    try {
      const fetched = await fetchContextIpfsJson({ cid });
      if (!fetched?.ok) throw new Error(fetched?.error || "task_ipfs_fetch_failed");
      const payload = await decryptTasknodeUserMnemonicPayload({ blob: fetched.payload, mnemonic });
      return { cid: fetched.cid || cid, gateway: fetched.gateway || "", payload };
    } catch (userError) {
      const error = new Error(`task_payload_decrypt_failed:service=${serviceError?.message || serviceError}:user=${userError?.message || userError}`);
      error.serviceError = serviceError;
      error.userError = userError;
      throw error;
    }
  }
}

async function loadEventsFromWallet({
  wallet,
  limit,
  maxPages,
  env = process.env,
  chainHistoryImpl = fetchHistoricalAccountTransactions,
} = {}) {
  const history = await chainHistoryImpl({ walletAddress: wallet, limit, maxPages, env });
  const pointers = extractPftPointerEvents(safeArray(history?.transactions), wallet)
    .filter((pointer) => TASK_KIND_LABELS.has(safeText(pointer.kindLabel, 80).toUpperCase()));
  const events = [];
  for (const pointer of pointers) {
    let payload = {};
    let payloadError = "";
    try {
      const decrypted = await fetchAndDecryptDeathmarchPayload({ cid: pointer.cid, env });
      payload = safeObject(decrypted.payload);
    } catch (error) {
      payloadError = error?.message || String(error);
    }
    events.push(normalizeEvent({
      schema: payload.schema || "",
      task_id: payload.task_id || pointer.taskId || "",
      source_tx_hash: pointer.txHash,
      source_cid: pointer.cid,
      memo_index: pointer.memoIndex,
      occurred_at: pointer.createdAt,
      pointer_kind: pointer.kindLabel,
      pointer,
      payload: payloadError ? { schema: payload.schema || "", task_id: pointer.taskId || "", payload_error: payloadError } : payload,
    }));
  }
  return events.sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt || "") || 0;
    const rightTime = Date.parse(right.occurredAt || "") || 0;
    return leftTime - rightTime;
  });
}

export function databaseRowsToDeathmarchEvents(rows = []) {
  return safeArray(rows).map((row) => {
    // Direct-write submission / update / reward rows carry no title; the task
    // projection does. Without it the summary can only echo the task id.
    const title = safeText(row?.task_title, 240);
    const payload = safeObject(row?.payload_json);
    return title && !payload.title
      ? normalizeEvent({ ...row, payload_json: { ...payload, title } })
      : normalizeEvent(row);
  }).filter(isDeathmarchTaskEvent);
}

async function loadEventsFromDatabase({
  wallet,
  accountId = "",
  limit,
  env = process.env,
  queryImpl = deathmarchDatabaseQuery,
} = {}) {
  if (!databaseEventsEnabled(env)) return [];
  const boundedLimit = clampInteger(limit, 100, 20, 400);
  const walletAddress = safeText(wallet, 120);
  const normalizedAccountId = safeText(accountId, 120);
  const eventTypes = Array.from(TASK_SCHEMAS);
  const result = await queryImpl(
    `SELECT *
       FROM (
         SELECT e.event_type,
                e.task_id,
                e.account_id,
                e.source_tx_hash,
                e.source_cid,
                e.occurred_at,
                e.wallet_address,
                e.payload_json,
                e.pointer_json,
                p.title AS task_title
           FROM task_events e
           LEFT JOIN task_projections p ON p.task_id = e.task_id
          WHERE e.event_type = ANY($1::text[])
            AND (
              ($2::text = '' AND $4::text = '')
              OR e.wallet_address = $2
              OR e.payload_json->>'wallet_address' = $2
              OR e.payload_json->>'subject_wallet' = $2
              OR e.payload_json->>'authority_wallet' = $2
              OR ($4::text <> '' AND e.account_id = $4)
            )
          ORDER BY e.occurred_at DESC, e.created_at DESC
          LIMIT $3
       ) recent
      ORDER BY occurred_at ASC`,
    [eventTypes, walletAddress, boundedLimit, normalizedAccountId],
    env
  );
  return databaseRowsToDeathmarchEvents(result.rows);
}

function mergeDeathmarchEvents(...groups) {
  const byKey = new Map();
  for (const event of groups.flat()) {
    if (!event?.eventKey || byKey.has(event.eventKey)) continue;
    byKey.set(event.eventKey, event);
  }
  return Array.from(byKey.values()).sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt || "") || 0;
    const rightTime = Date.parse(right.occurredAt || "") || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return safeText(left.eventKey, 500).localeCompare(safeText(right.eventKey, 500));
  });
}

function normalizeMember(input = {}) {
  const member = safeObject(input);
  const rawHandle = safeText(member.handle || member.hiveHandle, 80);
  const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
  return {
    accountId: safeText(member.accountId || member.account_id, 120),
    handle,
    walletAddress: safeText(member.walletAddress || member.wallet || member.wallet_address, 120),
  };
}

// DEATHMARCH_MEMBERS: explicit fan-out list, "handle=rWallet,handle2=rWallet2"
// or a JSON array of { handle, walletAddress, accountId }. Used for tests and
// for running without the collaboration database.
export function parseConfiguredMembers(value = "") {
  const text = safeText(value, 20000);
  if (!text) return [];
  let entries = [];
  if (text.startsWith("[")) {
    try { entries = JSON.parse(text); } catch { throw new Error("deathmarch_members_invalid_json"); }
  } else {
    entries = text.split(",").map((part) => {
      const [handle, wallet] = part.split("=").map((piece) => safeText(piece, 120));
      return wallet ? { handle, walletAddress: wallet } : { walletAddress: handle };
    });
  }
  return safeArray(entries).map(normalizeMember).filter((member) => member.walletAddress);
}

async function managerAccountIdForWallet({ wallet, queryImpl, env }) {
  const walletAddress = safeText(wallet, 120);
  if (!walletAddress) return "";
  const result = await queryImpl(
    `SELECT account_id FROM account_linked_wallets WHERE wallet_address = $1 AND status = 'linked' LIMIT 1`,
    [walletAddress],
    env
  );
  return safeText(result.rows?.[0]?.account_id, 120);
}

// Team members are the accounts related to the manager through active
// task-history grants (the same relationships the web Team page shows). A
// member whose task history is NOT shared with the manager (no incoming grant)
// is skipped with a non-leaking log entry, never polled.
async function resolveTeamMembersFromDatabase({ wallet, env, queryImpl }) {
  const managerAccountId = safeText(env.DEATHMARCH_TEAM_ACCOUNT_ID, 120)
    || await managerAccountIdForWallet({ wallet, queryImpl, env });
  if (!managerAccountId) return { members: [], skipped: [], managerAccountId: "" };
  const grants = await queryImpl(
    `SELECT subject_account_id, viewer_account_id
       FROM task_history_grants
      WHERE (subject_account_id = $1 OR viewer_account_id = $1)
        AND scope = 'task_history_v1' AND status = 'active'`,
    [managerAccountId],
    env
  );
  const others = new Map();
  for (const row of safeArray(grants.rows)) {
    const subject = safeText(row.subject_account_id, 120);
    const viewer = safeText(row.viewer_account_id, 120);
    const other = subject === managerAccountId ? viewer : subject;
    if (!other || other === managerAccountId) continue;
    const entry = others.get(other) || { accountId: other, incoming: false };
    if (subject === other && viewer === managerAccountId) entry.incoming = true;
    others.set(other, entry);
  }
  const members = [];
  const skipped = [];
  for (const entry of others.values()) {
    if (!entry.incoming) {
      skipped.push({ accountId: entry.accountId, reason: "task_history_not_shared" });
      continue;
    }
    const [account, linked] = await Promise.all([
      queryImpl(`SELECT hive_handle FROM app_accounts WHERE account_id = $1 LIMIT 1`, [entry.accountId], env),
      queryImpl(
        `SELECT wallet_address FROM account_linked_wallets WHERE account_id = $1 AND status = 'linked' ORDER BY linked_at DESC LIMIT 1`,
        [entry.accountId],
        env
      ),
    ]);
    const walletAddress = safeText(linked.rows?.[0]?.wallet_address, 120);
    if (!walletAddress) {
      skipped.push({ accountId: entry.accountId, reason: "wallet_not_linked" });
      continue;
    }
    members.push(normalizeMember({
      accountId: entry.accountId,
      handle: account.rows?.[0]?.hive_handle || "",
      walletAddress,
    }));
  }
  return { members, skipped, managerAccountId };
}

export async function resolveDeathmarchMembers({
  wallet = "",
  env = process.env,
  queryImpl = deathmarchDatabaseQuery,
} = {}) {
  const primary = normalizeMember({
    handle: env.DEATHMARCH_WALLET_HANDLE || "",
    walletAddress: wallet,
  });
  const configured = parseConfiguredMembers(env.DEATHMARCH_MEMBERS);
  let team = { members: [], skipped: [], managerAccountId: "" };
  if (!configured.length && env.DEATHMARCH_TEAM_FANOUT !== "false" && databaseEventsEnabled(env)) {
    team = await resolveTeamMembersFromDatabase({ wallet, env, queryImpl });
    if (team.managerAccountId && !primary.accountId) primary.accountId = team.managerAccountId;
  }
  const byWallet = new Map();
  for (const member of [primary, ...configured, ...team.members]) {
    if (!member.walletAddress || byWallet.has(member.walletAddress)) continue;
    byWallet.set(member.walletAddress, member);
  }
  return { members: Array.from(byWallet.values()), skipped: team.skipped };
}

function tagMember(events, member) {
  const tag = member?.walletAddress
    ? { accountId: member.accountId, handle: member.handle, walletAddress: member.walletAddress }
    : null;
  if (!tag) return events;
  for (const event of events) {
    if (!event.member) event.member = tag;
  }
  return events;
}

export async function loadDeathmarchEvents({
  file = "",
  wallet = "",
  members = null,
  limit = 100,
  maxPages = 1,
  env = process.env,
  queryImpl = deathmarchDatabaseQuery,
  chainHistoryImpl = fetchHistoricalAccountTransactions,
} = {}) {
  if (file) return loadEventsFromFile(file);
  const boundedLimit = clampInteger(limit, 100, 20, 400);
  const boundedPages = clampInteger(maxPages, 1, 1, 30);
  const fanout = safeArray(members).length ? safeArray(members).map(normalizeMember) : [normalizeMember({ walletAddress: wallet })];
  const groups = [];
  for (const member of fanout) {
    if (!member.walletAddress) continue;
    const [chain, database] = await Promise.all([
      loadEventsFromWallet({ wallet: member.walletAddress, limit: boundedLimit, maxPages: boundedPages, env, chainHistoryImpl }),
      loadEventsFromDatabase({ wallet: member.walletAddress, accountId: member.accountId, limit: boundedLimit, env, queryImpl }),
    ]);
    groups.push(tagMember(chain, member), tagMember(database, member));
  }
  // One on-chain/off-chain event is one Death March post no matter how many
  // member feeds surfaced it: the tx-based eventKey dedupes across feeds and
  // members, and the persisted state dedupes across restarts.
  return mergeDeathmarchEvents(...groups);
}
