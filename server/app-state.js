import {
  authProviders,
  chatModes,
  contextActions,
  devAuthStatus,
  readiness,
  usageActions,
  walletActions,
} from "./product-contracts.js";
import {
  ethereumDepositConfigStatus,
  publicDepositAccount,
  usdcTopUpGrantThresholdUsd,
} from "./ethereum-deposits.js";
import {
  conversationIdForSession,
  resolveWalletInitiationGrantStatus,
} from "./runtime-store.js";
import { getAccountIdentityProfile } from "./repositories/account-profiles.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import { getEthereumDepositAccount } from "./repositories/ethereum-deposit-accounts.js";
import {
  getHiveConversation,
  getChatMessages,
  hasUsageCreditForSource,
  listChatConversations,
  usageSummary,
} from "./repositories/chat-billing.js";
import {
  getContextDocument,
  getContextHistory,
} from "./repositories/context.js";
import {
  __resetAppStateGateForTests,
  appStateGateSnapshot,
  tryAcquireAppStateCompute,
} from "./app-state-gate.js";
import { listTaskState } from "./repositories/tasks.js";
import { scheduleLinkedWalletTaskProjectionRefresh } from "./task-projection-refresh.js";
import { expertAccessFromTaskState } from "./expert-badge.js";
import { deepResearchAvailable } from "./corbanu-deep-research.js";

const signedOutUsageSummary = Object.freeze({
  currentSpendUsd: 0,
  currentCreditUsd: 0,
  availableCreditUsd: 0,
  ledgerEntryCount: 0,
});

const DEFAULT_APP_STATE_CACHE_TTL_MS = 3000;
const DEFAULT_APP_STATE_CACHE_MAX_ENTRIES = 1000;
const ANON_APP_STATE_CACHE_KEY = "anon";
const appStateCache = new Map();
const appStateCacheGenerations = new Map();
let appStateCacheEpoch = 0;

let appStateComputeForCache = (...args) => appState(...args);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function appStateCacheTtlMs() {
  return positiveInteger(process.env.APP_STATE_CACHE_TTL_MS, DEFAULT_APP_STATE_CACHE_TTL_MS);
}

function appStateCacheMaxEntries() {
  return positiveInteger(process.env.APP_STATE_CACHE_MAX_ENTRIES, DEFAULT_APP_STATE_CACHE_MAX_ENTRIES);
}

function appStateCacheKey(session = null) {
  return session?.accountId || ANON_APP_STATE_CACHE_KEY;
}

function touchCacheEntry(key, entry) {
  appStateCache.delete(key);
  appStateCache.set(key, entry);
}

function trimAppStateCache() {
  const maxEntries = appStateCacheMaxEntries();
  while (appStateCache.size > maxEntries) {
    const oldestKey = appStateCache.keys().next().value;
    if (!oldestKey) return;
    appStateCache.delete(oldestKey);
  }
}

function appStateWithRefreshFlag(value) {
  return value && typeof value === "object" ? { ...value, refreshing: true } : value;
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function signedOutAppStateIsCacheSafe(value) {
  if (!value || typeof value !== "object") return false;
  if (value.session?.status !== "signed_out") return false;
  if (value.session?.accountId || value.session?.id) return false;
  if (value.session?.walletLink?.address) return false;
  if (value.wallet?.pftWallet?.address || value.wallet?.ethereumDeposit?.address) return false;
  if (hasNonEmptyArray(value.chat?.recents) || hasNonEmptyArray(value.chat?.seedMessages)) return false;
  if (value.chat?.hiveConversation) return false;
  if (value.context?.document?.accountId || value.context?.history?.accountId) return false;
  if (value.context?.history?.walletAddress) return false;
  if (hasNonEmptyArray(value.tasks?.outstanding)) return false;
  if (hasNonEmptyArray(value.tasks?.verification)) return false;
  if (hasNonEmptyArray(value.tasks?.rewarded)) return false;
  if (hasNonEmptyArray(value.tasks?.refused)) return false;
  if (hasNonEmptyArray(value.tasks?.requests?.items)) return false;
  return true;
}

function shouldCacheAppState(key, value) {
  if (key !== ANON_APP_STATE_CACHE_KEY) return true;
  const safe = signedOutAppStateIsCacheSafe(value);
  if (!safe) {
    console.warn("app_state_anon_cache_skipped", {
      reason: "signed_out_payload_not_cache_safe",
    });
  }
  return safe;
}

function scheduleProjectionRefreshFromCachedState({ key, value, refreshTaskProjection = false } = {}) {
  if (!refreshTaskProjection || key === ANON_APP_STATE_CACHE_KEY) return;
  if (!value?.tasks?.sync?.forceProjectionRefresh) return;
  const walletAddress = value?.wallet?.pftWallet?.address || value?.session?.walletLink?.address || "";
  const walletLinked = value?.wallet?.pftWallet?.status === "linked" ||
    value?.session?.walletLink?.status === "linked";
  if (!walletLinked || !walletAddress) return;
  scheduleLinkedWalletTaskProjectionRefresh({
    accountId: key,
    walletAddress,
    syncKind: "task_list_refresh",
  });
}

async function computeAndStoreAppState(key, session, options, entry, { allowOverflow = false } = {}) {
  const release = tryAcquireAppStateCompute({ allowOverflow });
  if (!release) {
    return null;
  }

  const targetEntry = entry || appStateCache.get(key) || {
    value: null,
    expiresAt: 0,
    refreshPromise: null,
  };
  const generationAtStart = appStateCacheGenerations.get(key) || 0;
  const epochAtStart = appStateCacheEpoch;
  let refreshPromise;
  refreshPromise = (async () => {
    try {
      const value = await appStateComputeForCache(session, options);
      const cacheStillCurrent = epochAtStart === appStateCacheEpoch &&
        generationAtStart === (appStateCacheGenerations.get(key) || 0);
      if (cacheStillCurrent && shouldCacheAppState(key, value)) {
        targetEntry.value = value;
        targetEntry.expiresAt = Date.now() + appStateCacheTtlMs();
        touchCacheEntry(key, targetEntry);
        trimAppStateCache();
      } else if (cacheStillCurrent) {
        appStateCache.delete(key);
      }
      return value;
    } finally {
      release();
      if (targetEntry.refreshPromise === refreshPromise) {
        targetEntry.refreshPromise = null;
      }
    }
  })();
  targetEntry.refreshPromise = refreshPromise;
  touchCacheEntry(key, targetEntry);
  trimAppStateCache();
  return refreshPromise;
}

function startBackgroundAppStateRefresh(key, session, options, entry) {
  const refreshPromise = computeAndStoreAppState(key, session, options, entry, {
    allowOverflow: false,
  });
  if (refreshPromise) {
    refreshPromise.catch((error) => {
      console.warn("app_state_cache_refresh_failed", {
        key: key === ANON_APP_STATE_CACHE_KEY ? ANON_APP_STATE_CACHE_KEY : "account",
        error: safeError(error),
      });
    });
  }
  return refreshPromise;
}

export async function getCachedAppState(session = null, { refreshTaskProjection = false } = {}) {
  const key = appStateCacheKey(session);
  const entry = appStateCache.get(key);
  const now = Date.now();
  const options = { refreshTaskProjection };

  if (entry) {
    touchCacheEntry(key, entry);
  }

  if (refreshTaskProjection && key !== ANON_APP_STATE_CACHE_KEY) {
    if (entry?.refreshPromise) {
      return entry.refreshPromise;
    }
    if (entry?.value) {
      scheduleProjectionRefreshFromCachedState({ key, value: entry.value, refreshTaskProjection });
    }
    const refreshPromise = computeAndStoreAppState(key, session, options, entry, {
      allowOverflow: false,
    });
    if (refreshPromise) return refreshPromise;
    if (entry?.value) return appStateWithRefreshFlag(entry.value);
    return appStateComputeForCache(session, options);
  }

  if (entry?.value && now < entry.expiresAt) {
    scheduleProjectionRefreshFromCachedState({ key, value: entry.value, refreshTaskProjection });
    return entry.value;
  }

  if (entry?.value) {
    if (!entry.refreshPromise) {
      startBackgroundAppStateRefresh(key, session, options, entry);
    }
    scheduleProjectionRefreshFromCachedState({ key, value: entry.value, refreshTaskProjection });
    return appStateWithRefreshFlag(entry.value);
  }

  if (entry?.refreshPromise) {
    return entry.refreshPromise;
  }

  const refreshPromise = computeAndStoreAppState(key, session, options, entry, {
    allowOverflow: true,
  });
  return refreshPromise || appStateComputeForCache(session, options);
}

export function invalidateCachedAppState(session = null) {
  const key = appStateCacheKey(session);
  appStateCacheGenerations.set(key, (appStateCacheGenerations.get(key) || 0) + 1);
  appStateCache.delete(key);
}

// Fire-and-forget: populate the cache for a session whose account is about to
// load the app (for example right after an account switch) so the first
// /api/app-state request after the reload is a cache hit.
export function prewarmAppState(session = null) {
  if (!session?.accountId) return null;
  invalidateCachedAppState(session);
  const promise = getCachedAppState(session, { refreshTaskProjection: false });
  Promise.resolve(promise).catch((error) => {
    console.warn("app_state_prewarm_failed", { error: safeError(error) });
  });
  return promise;
}

export function __resetAppStateCacheForTests() {
  appStateCacheEpoch += 1;
  appStateCacheGenerations.clear();
  appStateCache.clear();
  appStateComputeForCache = (...args) => appState(...args);
  __resetAppStateGateForTests();
}

export function __setAppStateComputeForTests(compute) {
  appStateComputeForCache = typeof compute === "function" ? compute : (...args) => appState(...args);
}

export function __appStateCacheStatsForTests() {
  return {
    size: appStateCache.size,
    keys: [...appStateCache.keys()],
    gate: appStateGateSnapshot(),
  };
}

function safeError(error) {
  return String(error?.message || error || "app_state_section_failed").slice(0, 500);
}

async function appStateSection(section, work, fallback) {
  try {
    return await work();
  } catch (error) {
    console.warn("app_state_section_failed", {
      section,
      error: safeError(error),
    });
    return typeof fallback === "function" ? fallback(error) : fallback;
  }
}

function fallbackInitiationGift(reason = "status_unavailable") {
  return {
    eligible: false,
    reason,
    amountPft: 0,
    amountDrops: "0",
    message: "Wallet grant status is temporarily unavailable.",
  };
}

function defaultContextBody() {
  return [
    "# Task Node Context",
    "",
    "## Identity",
    "",
    "## Preferences",
    "",
    "## Active Projects",
    "",
    "## Notes",
  ].join("\n");
}

function fallbackContextDocument({ accountId = "" } = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const now = new Date().toISOString();
  return {
    id: `ctx_${normalizedAccountId || "signed_out"}`,
    accountId: normalizedAccountId || null,
    title: "Task Node Context",
    body: defaultContextBody(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    canEdit: Boolean(normalizedAccountId),
    savePath: "/api/context/edit/save",
  };
}

function fallbackContextHistory({ accountId = "", walletAddress = "" } = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedWalletAddress = String(walletAddress || "").trim();
  return {
    id: `ctx_history_${normalizedAccountId || "signed_out"}`,
    accountId: normalizedAccountId || null,
    source: "pftl_cache_context_projection",
    revision: 0,
    projectedAt: null,
    walletAddress: normalizedWalletAddress || null,
    pointerCount: 0,
    contextUpdateCount: 0,
    taskEventCount: 0,
    latestContextPointer: null,
    contextUpdates: [],
    taskEvents: [],
    hydration: {
      plaintextHydrated: false,
      requiresWalletUnlock: true,
      ipfsFetchReady: true,
      fetchPath: "/api/context/history/ipfs/:cid",
      note: "Context history is temporarily unavailable.",
    },
    sync: {
      source: "pftl_cache_context_projection",
      status: "database_error",
      archiveComplete: false,
      lastHotSyncAt: null,
      lastArchiveSyncAt: null,
      lastError: "context_history_unavailable",
    },
    canHydrate: Boolean(normalizedAccountId && normalizedWalletAddress),
  };
}

function sessionState(session, providers, runtimeReadiness, linkedWallet, identityProfile = null) {
  const base = {
    accountLinks: providers,
    devAuth: devAuthStatus(),
    walletLink: {
      status: linkedWallet?.status || "not_linked",
      address: linkedWallet?.address || null,
      mode: "seed_based_pftl",
      canDelinkForTesting: true,
      seedStorageReady: runtimeReadiness.wallet.seedStorageReady,
      challengeProofReady: runtimeReadiness.wallet.challengeProofReady,
    },
  };

  if (!session) {
    return {
      ...base,
      status: "signed_out",
      displayName: null,
      primaryProvider: null,
      linkedProviders: [],
    };
  }

  const { id: _sessionToken, deviceAccountSetId: _deviceAccountSetId, ...publicSession } = session;
  return {
    ...base,
    ...publicSession,
    status: "signed_in",
    displayName: identityProfile?.displayName || session.displayName,
    hiveHandle: identityProfile?.hiveHandle || session.hiveHandle || "",
    publicDisplayName: identityProfile?.publicDisplayName || session.publicDisplayName || "",
    identityProfile,
  };
}

async function qaWorkerAccessForAccount(accountId = "") {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) {
    return {
      checkedAt: new Date().toISOString(),
      usdcTopUp: false,
      proofMethod: "billing_ledger_usdc_top_up",
    };
  }
  const usdcTopUp = await hasUsageCreditForSource({
    accountId: normalizedAccountId,
    source: "ethereum_deposit",
    metadata: { asset: "USDC" },
  }).catch(() => false);
  return {
    checkedAt: new Date().toISOString(),
    usdcTopUp: Boolean(usdcTopUp),
    proofMethod: "billing_ledger_usdc_top_up",
  };
}

function sectionTimer() {
  const timings = {};
  return {
    timings,
    async time(section, work) {
      const startedAt = Date.now();
      try {
        return await work();
      } finally {
        timings[section] = Date.now() - startedAt;
      }
    },
  };
}

function logAppStateTimings(accountId, timings, totalMs) {
  console.info("app_state_timing", {
    key: accountId ? "account" : "anon",
    totalMs,
    sections: timings,
  });
}

export async function appState(session = null, { refreshTaskProjection = false } = {}) {
  const startedAt = Date.now();
  const timer = sectionTimer();
  const timed = (section, work, fallback) => timer.time(section, () => appStateSection(section, work, fallback));
  const providers = authProviders();
  const accountId = session?.accountId || "";
  const signedOut = !accountId;
  const modes = chatModes({ signedOut });
  const enabledMode = signedOut
    ? modes.find((mode) => mode.label === "Help" && mode.enabled) || modes.find((mode) => mode.enabled)
    : (
        modes.find((mode) => mode.label === "Instant" && mode.enabled) ||
        modes.find((mode) => mode.enabled)
      );
  const conversationId = conversationIdForSession(session);
  const ethDepositStatus = ethereumDepositConfigStatus();
  const usdcGrantThresholdUsd = usdcTopUpGrantThresholdUsd();

  // Phase 1: everything that only depends on the session. These used to run
  // serially (p50 4.5s on production); they are independent and run together.
  const [
    runtimeReadiness,
    usage,
    linkedWallet,
    ethDepositAccount,
    baseIdentityProfile,
    qaWorkerAccess,
    chatRecents,
    hiveConversation,
    seedMessages,
    contextDocument,
  ] = await Promise.all([
    timed("readiness", () => readiness(), () => ({
      wallet: {
        seedStorageReady: true,
        challengeProofReady: true,
        pftlRpcConfigured: false,
      },
      billing: {
        chatEstimateReady: true,
        chatExecutionReady: false,
        adminCreditReady: false,
        ledgerReady: false,
        durableLedgerReady: false,
      },
      context: {
        importReady: false,
        editReady: true,
        historyCacheReady: false,
        encryptedCidHydrationReady: false,
        manifestInkReady: false,
      },
    })),
    accountId
      ? timed("usage_summary", () => usageSummary({ accountId, conversationId }), signedOutUsageSummary)
      : signedOutUsageSummary,
    timer.time("linked_wallet", () => getLinkedWallet({ accountId })),
    timer.time("eth_deposit_account", () => getEthereumDepositAccount({ accountId })),
    accountId ? timer.time("identity_profile", () => getAccountIdentityProfile({ accountId })) : null,
    accountId ? timer.time("qa_worker_access", () => qaWorkerAccessForAccount(accountId)) : null,
    accountId ? timed("chat_conversations", () => listChatConversations({ accountId }), []) : [],
    accountId ? timed("hive_conversation", () => getHiveConversation({ accountId }), null) : null,
    accountId ? timed("chat_messages", () => getChatMessages({ accountId, conversationId }), []) : [],
    timed(
      "context_document",
      () => getContextDocument({ accountId }),
      () => fallbackContextDocument({ accountId })
    ),
  ]);

  const creditedUsdcUsd = Number(ethDepositAccount?.creditedBalances?.USDC?.amount || 0);
  const walletLinked = linkedWallet.status === "linked" && Boolean(linkedWallet.address);
  const walletAddress = walletLinked ? linkedWallet.address : "";

  // Phase 2: everything that depends on the linked wallet.
  const [initiationGift, usdcTopUpGrantStatus, tasks, contextHistory] = await Promise.all([
    timed(
      "wallet_initiation_grant",
      () => resolveWalletInitiationGrantStatus({ accountId, walletAddress }),
      () => fallbackInitiationGift(walletLinked ? "status_unavailable" : "wallet_not_linked")
    ),
    walletLinked
      ? timed(
          "usdc_top_up_grant",
          () => resolveWalletInitiationGrantStatus({
            accountId,
            walletAddress: linkedWallet.address,
            source: "usdc_top_up",
          }),
          () => fallbackInitiationGift("status_unavailable")
        )
      : null,
    timed(
      "task_state",
      () => listTaskState({
        accountId,
        walletAddress,
      }),
      () => ({
        outstanding: [],
        verification: [],
        rewarded: [],
        refused: [],
        requests: {
          items: [],
          sync: {
            source: "task_requests",
            status: "database_error",
            walletAddress,
            requestCount: 0,
            lastUpdatedAt: null,
          },
        },
        networkTasks: {
          schema: "pf.task_node.network_task_eligibility.v1",
          status: "unavailable",
          label: "Network task routing unavailable",
          summary: "Task Node could not inspect Network Task routing state.",
          nextAction: "Try again after task state reloads.",
          gates: [],
        },
        sync: {
          source: "task_projections",
          status: "database_error",
          walletAddress: walletLinked ? linkedWallet.address : null,
          projectionCount: 0,
          lastSyncedAt: null,
          requiresRefresh: true,
          forceProjectionRefresh: false,
          nextPollMs: 5000,
          refreshReason: "task_state_unavailable",
          activeRequestCount: 0,
          refreshTaskIds: [],
        },
      })
    ),
    timed(
      "context_history",
      () => getContextHistory({ accountId, walletAddress }),
      () => fallbackContextHistory({ accountId, walletAddress })
    ),
  ]);
  if (refreshTaskProjection && walletLinked && tasks?.sync?.forceProjectionRefresh) {
    scheduleLinkedWalletTaskProjectionRefresh({
      accountId,
      walletAddress: linkedWallet.address,
      syncKind: "task_list_refresh",
    });
  }
  const usdcTopUpInitiationGift = !walletLinked
    ? {
        eligible: false,
        reason: "wallet_not_linked",
        amountPft: initiationGift.amountPft,
        amountDrops: initiationGift.amountDrops,
        message: "Create and link a wallet before the USDC top-up grant can be sent.",
      }
    : usdcTopUpGrantStatus.eligible && creditedUsdcUsd <= usdcGrantThresholdUsd
      ? {
          ...usdcTopUpGrantStatus,
          eligible: false,
          reason: "usdc_top_up_required",
          creditedUsdcUsd,
          thresholdUsd: usdcGrantThresholdUsd,
          message: `Credit more than $${usdcGrantThresholdUsd.toLocaleString("en-US")} USDC before sending the PFT initiation grant.`,
        }
      : { ...usdcTopUpGrantStatus, creditedUsdcUsd, thresholdUsd: usdcGrantThresholdUsd };
  const identityProfile = baseIdentityProfile
    ? {
        ...baseIdentityProfile,
        expertAccess: await timer.time("expert_access", () => expertAccessFromTaskState({ accountId, taskState: tasks })),
        qaWorkerAccess,
      }
    : null;
  logAppStateTimings(accountId, timer.timings, Date.now() - startedAt);

  return {
    generatedAt: new Date().toISOString(),
    session: sessionState(session, providers, runtimeReadiness, linkedWallet, identityProfile),
    chat: {
      conversationId,
      conversationsPath: "/api/chat/conversations",
      historyPath: "/api/chat/history",
      recents: chatRecents,
      hiveConversation,
      defaultMode: signedOut ? "Help" : enabledMode?.label || "Instant",
      deepResearchAvailable: deepResearchAvailable({ accountId }),
      modes,
      seedMessages,
    },
    tasks,
    wallet: {
      pftBalanceDrops: walletLinked ? null : 0,
      pftBalanceStatus: walletLinked ? "checking" : "not_linked",
      pftBalanceSource: null,
      pftBalanceFetchedAt: null,
      pftBalancePath: "/api/wallet/balance",
      pftTransactionsPath: "/api/wallet/transactions",
      lifecycle: {
        oneWalletPerAccount: true,
        delinkForTestingRequired: true,
        relinkRequiresOwnershipProof: true,
        localSeedStorageReady: runtimeReadiness.wallet.seedStorageReady,
      },
      pftWallet: {
        ...linkedWallet,
        pftlRpcConfigured: runtimeReadiness.wallet.pftlRpcConfigured,
        seedStorageReady: runtimeReadiness.wallet.seedStorageReady,
        challengeProofReady: runtimeReadiness.wallet.challengeProofReady,
        signingRequiredFor: [
          "Send PFT",
          "Sign PFT verifications",
          "Ink context manifests to PFTL pointers",
        ],
      },
      actions: walletActions(),
      initiationGift,
      usdcTopUpInitiationGift,
      chatCreditUsd: usage.availableCreditUsd,
      fundingRails: [
        {
          label: "Ethereum mainnet deposit address",
          status: ethDepositStatus.status,
          note:
            "Account-scoped custodial receive address for ETH, USDC, and USDT. No wallet-connect or user withdrawal surface.",
        },
      ],
      ethereumDeposit: publicDepositAccount(ethDepositAccount),
    },
    usage: {
      billingModel: "usage_based",
      currentSpendUsd: usage.currentSpendUsd,
      currentCreditUsd: usage.currentCreditUsd,
      availableCreditUsd: usage.availableCreditUsd,
      currentPeriod: "Dev session",
      estimatePath: "/api/chat/estimate",
      chatSendPath: "/api/chat/send",
      chatStreamPath: "/api/chat/stream",
      actionsPath: "/api/usage/actions",
      fundingActions: usageActions(),
      ethereumDeposit: publicDepositAccount(ethDepositAccount),
      chatEstimateReady: runtimeReadiness.billing.chatEstimateReady,
      chatExecutionReady: runtimeReadiness.billing.chatExecutionReady,
      adminCreditReady: runtimeReadiness.billing.adminCreditReady,
      ledgerReady: runtimeReadiness.billing.ledgerReady,
      durableLedgerReady: runtimeReadiness.billing.durableLedgerReady,
      ledgerEntryCount: usage.ledgerEntryCount,
      controls: [
        "Show estimated cost before expensive actions",
        "Confirm large context imports and deep reasoning calls",
        "Make all credits, debits, rewards, and refunds ledger-backed",
      ],
    },
    context: {
      actions: contextActions(),
      document: contextDocument,
      history: contextHistory,
      savePath: "/api/context/edit/save",
      historyPath: "/api/context/history",
      importReady: runtimeReadiness.context.importReady,
      editReady: runtimeReadiness.context.editReady,
      historyCacheReady: runtimeReadiness.context.historyCacheReady,
      encryptedCidHydrationReady: runtimeReadiness.context.encryptedCidHydrationReady,
      manifestInkReady: runtimeReadiness.context.manifestInkReady,
      sources: [
        {
          label: "PFT Context",
          status: runtimeReadiness.context.historyCacheReady ? "cache projection ready" : "supported later",
          note:
            "PFTL wallet sync stores account transactions in Postgres; reducer events project encrypted context CIDs into the context history read model.",
        },
        {
          label: "Google Docs share link",
          status: "research",
          note:
            "Import via shared URL without forcing Google login for the first release path.",
        },
        {
          label: "Notion shared document",
          status: "research",
          note:
            "Evaluate current Notion backend hooks before promising native edit support.",
        },
      ],
      manifestPolicy:
        "Context is useful before wallet setup. Users explicitly choose when to ink a PFTL pointer manifest.",
    },
  };
}
