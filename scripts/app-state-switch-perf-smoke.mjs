import assert from "node:assert/strict";
import {
  __resetAppStateCacheForTests,
  __setAppStateComputeForTests,
  appState,
  getCachedAppState,
  prewarmAppState,
} from "../server/app-state.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 1. Account switch pre-warm: the first /api/app-state after the reload must be
//    a cache hit, not a full compute on the critical path.
async function runPrewarmCheck() {
  __resetAppStateCacheForTests();
  process.env.APP_STATE_CACHE_TTL_MS = "60000";
  let computeCount = 0;
  __setAppStateComputeForTests(async (session) => {
    computeCount += 1;
    await delay(20);
    return {
      generatedAt: `prewarm_${computeCount}`,
      session: { status: "signed_in", accountId: session.accountId, walletLink: { status: "not_linked", address: null } },
      chat: { recents: [], hiveConversation: null, seedMessages: [] },
      tasks: { outstanding: [], verification: [], rewarded: [], refused: [], requests: { items: [] } },
      wallet: { pftWallet: { address: null } },
      context: { document: {}, history: {} },
    };
  });
  const session = { accountId: "acct_switch_target" };
  assert.equal(prewarmAppState(null), null, "anonymous sessions are never pre-warmed");
  const warm = prewarmAppState(session);
  assert.ok(warm, "pre-warm should start a compute for the target account");
  await warm;
  assert.equal(computeCount, 1);
  const startedAt = Date.now();
  const state = await getCachedAppState(session);
  assert.equal(state.generatedAt, "prewarm_1", "post-switch read should be served from the pre-warmed cache");
  assert.equal(computeCount, 1, "post-switch read must not recompute");
  assert.ok(Date.now() - startedAt < 15, "cache hit should be immediate");
}

// 2. The real appState executes end to end without a database (repositories
//    fall back to in-memory runtime stores) and emits one app_state_timing
//    record with per-section durations. Production concurrency is proven by
//    the route_observability_summary p50/p95 before/after numbers recorded in
//    docs/verification; this check guards the payload shape and the timing
//    instrumentation that those numbers depend on.
async function runConcurrencyCheck() {
  __resetAppStateCacheForTests();
  const timings = [];
  const originalInfo = console.info;
  console.info = (event, payload) => {
    if (event === "app_state_timing") timings.push(payload);
  };
  try {
    const startedAt = Date.now();
    const state = await appState({ accountId: "acct_perf_smoke", authenticated: true, status: "signed_in" });
    const wallMs = Date.now() - startedAt;
    assert.ok(state?.session, "appState should still produce a session block");
    assert.ok(Array.isArray(state.chat.recents));
    assert.ok(state.tasks && typeof state.tasks === "object");
    assert.ok(state.context.document, "context document should be present");
    const record = timings.at(-1);
    assert.ok(record, "appState should log app_state_timing once per compute");
    assert.equal(record.key, "account");
    for (const section of ["readiness", "usage_summary", "linked_wallet", "task_state", "context_document", "context_history", "chat_conversations"]) {
      assert.ok(section in record.sections, `timing for ${section} should be recorded`);
    }
    assert.ok(record.totalMs <= wallMs + 5);
  } finally {
    console.info = originalInfo;
  }
}

await runPrewarmCheck();
await runConcurrencyCheck();
console.log("app-state switch perf smoke ok");
