import assert from "node:assert/strict";

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (databaseUrl && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const {
  createGeneratingProfileNft,
  failStaleGeneratingProfileNfts,
  getProfileNft,
  markProfileNftFailed,
} = await import("../server/repositories/profile-nfts.js");
const {
  claimProfileNftRenderJob,
  completeProfileNftRenderJob,
  enqueueProfileNftRenderJob,
} = await import("../server/repositories/profile-nft-render-jobs.js");
const {
  profileNftRenderConcurrency,
  startProfileNftRenderWorker,
} = await import("../server/profile-nft-render-worker.js");

assert.equal(profileNftRenderConcurrency({}), 3);
assert.equal(profileNftRenderConcurrency({ TASKNODE_PROFILE_NFT_RENDER_CONCURRENCY: "99" }), 6);
let schedulerCalls = 0;
const scheduler = startProfileNftRenderWorker({
  env: { TASKNODE_PROFILE_NFT_RENDER_CONCURRENCY: "3", TASKNODE_PROFILE_NFT_RENDER_INTERVAL_MS: "60000" },
  runOnce: async () => {
    schedulerCalls += 1;
    return { ok: true, processed: false };
  },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(scheduler.concurrency, 3);
assert.equal(schedulerCalls, 3, "the scheduler must fill every configured renderer slot");

const interruptedPattern = /interrupted before it reached the durable render queue/;
const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const suffix = `${Date.now()}`;

// Runtime-store sweep coverage (no database required).
const previousDisabled = process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_DISABLED = "true";

const runtimeAccountId = `account_profile_nft_recovery_runtime_${suffix}`;
const runtimeOtherAccountId = `${runtimeAccountId}_other`;
const runtimeStale = await createGeneratingProfileNft({
  accountId: runtimeAccountId,
  title: "Stale runtime draft",
});
const runtimeFresh = await createGeneratingProfileNft({
  accountId: runtimeAccountId,
  title: "Fresh runtime draft",
});
const runtimeOtherStale = await createGeneratingProfileNft({
  accountId: runtimeOtherAccountId,
  title: "Stale runtime draft (other account)",
});
// The runtime store returns the stored record reference, so backdating the
// returned object backdates the stored row.
runtimeStale.updatedAt = staleIso;
runtimeOtherStale.updatedAt = staleIso;

const runtimeSwept = await failStaleGeneratingProfileNfts({ accountId: runtimeAccountId });
assert.equal(runtimeSwept.length, 1);
assert.equal(runtimeSwept[0].id, runtimeStale.id);
assert.equal(runtimeSwept[0].status, "failed");
assert.match(runtimeSwept[0].error, interruptedPattern);

const runtimeFreshAfter = await getProfileNft({ accountId: runtimeAccountId, nftId: runtimeFresh.id });
assert.equal(runtimeFreshAfter.status, "generating", "a fresh in-flight generation must never be swept");

const runtimeOtherAfter = await getProfileNft({
  accountId: runtimeOtherAccountId,
  nftId: runtimeOtherStale.id,
});
assert.equal(runtimeOtherAfter.status, "generating", "account-scoped sweep must not touch other accounts");

// The stale threshold is floored above the worst-case in-flight image timeout,
// so even an aggressive staleMinutes cannot sweep a fresh in-flight row.
const aggressiveSwept = await failStaleGeneratingProfileNfts({
  accountId: runtimeAccountId,
  staleMinutes: 1,
});
assert.equal(aggressiveSwept.length, 0);
const runtimeFreshFinal = await getProfileNft({ accountId: runtimeAccountId, nftId: runtimeFresh.id });
assert.equal(runtimeFreshFinal.status, "generating");

if (previousDisabled === undefined) {
  delete process.env.TASKNODE_DATABASE_DISABLED;
} else {
  process.env.TASKNODE_DATABASE_DISABLED = previousDisabled;
}

if (!databaseUrl) {
  console.log("profile-nft-recovery-smoke ok (runtime store only; set DATABASE_URL for the Postgres sweep)");
  process.exit(0);
}

const { migrateDatabase } = await import("../server/db/migrate.js");
const { closePool, query } = await import("../server/db/pool.js");

await migrateDatabase();

const accountId = `account_profile_nft_recovery_${suffix}`;
const otherAccountId = `${accountId}_other`;

const staleDraft = await createGeneratingProfileNft({
  accountId,
  title: "Stale generating draft",
});
const freshDraft = await createGeneratingProfileNft({
  accountId,
  title: "Fresh generating draft",
});
const otherStaleDraft = await createGeneratingProfileNft({
  accountId: otherAccountId,
  title: "Stale generating draft (other account)",
});
const queuedDraft = await createGeneratingProfileNft({
  accountId,
  title: "Queued generating draft",
});
const queuedJob = await enqueueProfileNftRenderJob({
  profileNftId: queuedDraft.id,
  sanitizedPrompt: "A privacy-safe queued prompt.",
  model: "gpt-image-2.5-sunburst",
  size: "1024x1024",
  quality: "high",
  outputFormat: "png",
});

await query(
  `UPDATE profile_nfts
      SET updated_at = now() - interval '1 hour'
    WHERE id = ANY($1::text[])`,
  [[staleDraft.id, otherStaleDraft.id, queuedDraft.id]]
);

const swept = await failStaleGeneratingProfileNfts({ accountId });
assert.equal(swept.length, 1);
assert.equal(swept[0].id, staleDraft.id);
assert.equal(swept[0].status, "failed");
assert.match(swept[0].error, interruptedPattern);

const staleAfter = await getProfileNft({ accountId, nftId: staleDraft.id });
assert.equal(staleAfter.status, "failed");
assert.match(staleAfter.error, interruptedPattern);
assert.ok(
  new Date(staleAfter.updatedAt).getTime() > Date.now() - 5 * 60 * 1000,
  "swept rows must get a fresh updated_at"
);

const freshAfter = await getProfileNft({ accountId, nftId: freshDraft.id });
assert.equal(freshAfter.status, "generating", "a fresh in-flight generation must never be swept");
assert.equal(freshAfter.error, "");

const queuedAfterSweep = await getProfileNft({ accountId, nftId: queuedDraft.id });
assert.equal(
  queuedAfterSweep.status,
  "generating",
  "a durable queued render must never be mislabeled as interrupted"
);
const queuedClaim = await claimProfileNftRenderJob();
assert.equal(queuedClaim.id, queuedJob.id);
await completeProfileNftRenderJob(queuedClaim);

const reclaimDraft = await createGeneratingProfileNft({
  accountId,
  title: "Failed draft with a retryable render job",
});
await enqueueProfileNftRenderJob({
  profileNftId: reclaimDraft.id,
  sanitizedPrompt: "A privacy-safe reclaim prompt.",
  model: "gpt-image-2.5-sunburst",
  size: "1024x1024",
  quality: "high",
  outputFormat: "png",
});
await markProfileNftFailed({
  accountId,
  nftId: reclaimDraft.id,
  error: "Incorrect stale-state label",
});
const claimed = await claimProfileNftRenderJob();
assert.equal(claimed.profileNftId, reclaimDraft.id);
const reclaimedNft = await getProfileNft({ accountId, nftId: reclaimDraft.id });
assert.equal(reclaimedNft.status, "generating", "claiming durable work must restore generating state");
assert.equal(reclaimedNft.error, "", "claiming durable work must clear an obsolete failure message");
await completeProfileNftRenderJob(claimed);

const otherAfter = await getProfileNft({ accountId: otherAccountId, nftId: otherStaleDraft.id });
assert.equal(otherAfter.status, "generating", "account-scoped sweep must not touch other accounts");

const globalSwept = await failStaleGeneratingProfileNfts({});
assert.ok(globalSwept.some((nft) => nft.id === otherStaleDraft.id));
const otherFinal = await getProfileNft({ accountId: otherAccountId, nftId: otherStaleDraft.id });
assert.equal(otherFinal.status, "failed");
assert.match(otherFinal.error, interruptedPattern);

await query(`DELETE FROM profile_nfts WHERE account_id = ANY($1::text[])`, [[accountId, otherAccountId]]);
await closePool();

console.log(`profile-nft-recovery-smoke ok: ${accountId}`);
