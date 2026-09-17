import { isWhitespace, replaceCharacterRuns, titleWords } from "../../shared/text-protocol.js";
import { taskProductConfig } from "../task-product-config.js";
import { emptyTaskRequestState } from "./task-requests.js";
import {
  normalizeTaskStatus,
  taskLifecycleActions,
  taskStatusInfo,
  taskStatusLabel,
  taskStatusTab,
} from "../../shared/task-lifecycle.js";
import { formatTaskDeadline, formatTaskTimestamp } from "../../shared/task-time-format.js";
import { normalizeTaskSteps } from "../../shared/task-steps.js";

export function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

export function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

export function hasNumericValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function titleCase(value = "") {
  return titleWords(replaceCharacterRuns(replaceCharacterRuns(String(value || ""),char=>char==="_"||char==="-"," "),isWhitespace," ")
    .trim());
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function timelineEventIdentity(event = {}) {
  const schema = safeText(event.schema, 120);
  const txHash = safeText(event.txHash, 240);
  const cid = safeText(event.cid, 240);
  if (txHash || cid) return [schema, txHash, cid].join("|").toLowerCase();
  return [schema, safeText(event.eventDigest || event.id, 240)].join("|").toLowerCase();
}

export function timelineEventSortMs(event = {}) {
  const parsed = Date.parse(event.observedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeTaskForensicsTimeline(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const event of Array.isArray(group) ? group : []) {
      const identity = timelineEventIdentity(event);
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => (
    timelineEventSortMs(a) - timelineEventSortMs(b) ||
    Number(a.index || 0) - Number(b.index || 0) ||
    safeText(a.id, 180).localeCompare(safeText(b.id, 180))
  ));
}

export function objectKeyCount(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

export function relativeAge(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function maxIso(values = []) {
  const timestamps = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

export function emptyTaskState({ walletLinked = false, walletAddress = "" } = {}) {
  return {
    ...taskProductConfig(),
    requests: emptyTaskRequestState({ walletLinked, walletAddress }),
    outstanding: [], verification: [], refused: [], rewarded: [],
    sync: {
      source: "task_projections",
      status: walletLinked ? "empty" : "wallet_required",
      walletAddress: walletAddress || null,
      projectionCount: 0, lastSyncedAt: null, requiresRefresh: false, nextPollMs: null,
      refreshReason: "", activeRequestCount: 0, refreshTaskIds: [],
    },
  };
}

// Only processing requests (signing/queued/generating/recently published) count
// toward refresh pressure. Failed requests are attention states: they stay
// visible in the request strip, but no projection refresh can resolve them.
export function refreshActiveRequestCount(requests = {}) {
  return Array.isArray(requests?.items)
    ? requests.items.filter((request) => request?.isProcessing).length
    : 0;
}

export function taskProjectionReadErrorState({
  error,
  networkTasks,
  requests,
  walletAddress = "",
} = {}) {
  return {
    ...emptyTaskState({ walletLinked: true, walletAddress }),
    networkTasks,
    requests,
    sync: {
      source: "task_projections",
      status: "database_error",
      walletAddress,
      projectionCount: 0,
      lastSyncedAt: null,
      requiresRefresh: true,
      // A forced sync/reduce write pass against a failing database is the
      // wrong remediation; the client polls with backoff instead.
      forceProjectionRefresh: false,
      nextPollMs: 5000,
      refreshReason: "task_projection_read_failed",
      activeRequestCount: refreshActiveRequestCount(requests),
      refreshTaskIds: [],
      error: safeText(error?.message || error, 500),
    },
  };
}

export function emptyTaskReadIntegrity({ error = "" } = {}) {
  return {
    byTaskId: new Map(),
    totals: {
      pendingReducerCount: 0,
      processingReducerCount: 0,
      failedReducerCount: 0,
      indexingLagCount: 0,
      integrityUnavailable: Boolean(error),
      error: safeText(error, 500),
    },
  };
}

export function taskSteps(row, generatedTask = {}) {
  const generatedSteps = normalizeTaskSteps(generatedTask.steps, { clean: safeText });
  if (generatedSteps.length) return generatedSteps;
  const requirement = safeText(row.submission_requirement_text || "", 2000);
  if (!requirement) return [];
  return [requirement];
}

export function publicTask(row) {
  const rewardActual = numeric(row.reward_actual_pft);
  const rewardOffer = numeric(row.reward_offer_pft);
  const actualRewardRecorded = hasNumericValue(row.reward_actual_pft);
  const statusKey = normalizeTaskStatus(row.status);
  const statusInfo = taskStatusInfo(statusKey);
  const pft = statusKey === "rewarded" && actualRewardRecorded ? rewardActual : rewardOffer;
  const metadata = safeObject(row.metadata_json);
  const generatedTask = safeObject(metadata.generatedTask);
  const networkTask = safeObject(generatedTask.network_task);
  const taskClass = safeText(generatedTask.task_class || networkTask.task_class, 80);
  const isNetworkTask = taskClass === "network" || taskClass === "alpha" || objectKeyCount(networkTask) > 0;
  const taskKindLabel = taskClass === "alpha" ? "Alpha" : isNetworkTask ? "Network" : "Personal";
  const verification = safeObject(row.verification_policy_json);
  const acceptBy = toIso(row.accept_by);
  const deadlineAt = toIso(row.deadline_at);
  const acceptWindowApplies = statusKey === "proposed" && Boolean(acceptBy);
  const dueAt = deadlineAt || (acceptWindowApplies ? acceptBy : null);
  const formattedDue = formatTaskDeadline(dueAt, { locale: "en-US" });
  const dueLabel = deadlineAt ? "Deadline" : acceptWindowApplies ? "Accept by" : "Deadline";

  return {
    id: String(row.task_id || "").slice(0, 12),
    fullId: row.task_id,
    taskId: row.task_id,
    title: row.title || "Untitled task",
    kind: taskKindLabel,
    originalKind: titleCase(row.task_kind || "task"),
    taskClass,
    isNetworkTask,
    status: taskStatusLabel(statusKey),
    statusKey,
    statusTone: statusInfo.tone,
    statusColor: statusInfo.color,
    statusTab: statusInfo.tab,
    lifecycle: statusInfo,
    due: formattedDue,
    fullDue: formattedDue,
    dueLabel,
    dueAt,
    acceptBy,
    deadlineAt,
    ago: relativeAge(row.updated_at || row.last_event_at),
    pft,
    description: row.description || "",
    steps: taskSteps(row, generatedTask),
    verification: {
      title: row.submission_type ? `Submit ${titleCase(row.submission_type)}` : "Submit evidence",
      body:
        row.submission_requirement_text ||
        verification.criteria ||
        generatedTask?.submission_requirement?.criteria ||
        "Submit evidence that satisfies the task requirement.",
      policy: verification,
    },
    submissionRequirement: {
      type: row.submission_type || generatedTask?.submission_requirement?.type || "",
      criteria:
        row.submission_requirement_text ||
        generatedTask?.submission_requirement?.criteria ||
        generatedTask?.submission_requirement?.description ||
        "",
    },
    verificationPolicy: verification,
    submissionType: row.submission_type || generatedTask?.submission_requirement?.type || "",
    requestBundleCid: row.request_bundle_cid || "",
    contextCid: row.context_cid || "",
    txHash: row.last_event_tx_hash || "",
    source: row.source || "pftl_replay",
    updatedAt: toIso(row.updated_at),
    updatedAtDisplay: formatTaskTimestamp(row.updated_at, { locale: "en-US" }),
    lastEventAt: toIso(row.last_event_at),
    lastEventAtDisplay: formatTaskTimestamp(row.last_event_at, { locale: "en-US" }),
    metadata: {
      requestId: row.request_id || undefined, eventCount: Number(row.event_count || 0),
      sourceRunId: metadata.runId || undefined, openaiResponseId: metadata.taskgen?.openai_response_id || undefined,
      model: metadata.taskgen?.model || undefined,
      networkTask: objectKeyCount(networkTask) ? networkTask : undefined,
      networkProjectId: generatedTask.network_project_id || networkTask.project_id || undefined,
      networkAllocationId: generatedTask.network_allocation_id || networkTask.allocation_id || undefined,
      routingProfileDigest: generatedTask.routing_profile_digest || networkTask.routing_profile_digest || undefined,
    },
  };
}

export function groupTasks(tasks) {
  const outstanding = [];
  const verification = [];
  const refused = [];
  const rewarded = [];

  for (const task of tasks) {
    const tab = taskStatusTab(task.statusKey);
    if (tab === "rewarded") {
      rewarded.push(task);
    } else if (tab === "refused") {
      refused.push(task);
    } else if (tab === "verification") {
      verification.push(task);
    } else {
      outstanding.push(task);
    }
  }

  return { outstanding, verification, refused, rewarded };
}

export function taskRequestHandoffState({ requests = {}, taskItems = [] } = {}) {
  const items = Array.isArray(requests?.items) ? requests.items : [];
  // Request pages put unresolved rows first; that is not chronological order.
  const latest = items.reduce((newest, item) => {
    const time = Date.parse(item.updatedAt || item.createdAt || "") || 0;
    const previous = Date.parse(newest?.updatedAt || newest?.createdAt || "") || 0;
    return !newest || time > previous ? item : newest;
  }, null);
  if (!latest) {
    return {
      latestRequestId: "",
      latestRequestStatus: "",
      latestRequestUpdatedAt: null,
      generatedTaskId: "",
      generatedTaskVisible: false,
      requestHandoffState: "none",
      lastError: "",
      isProcessing: false,
      needsAttention: false,
    };
  }

  const generatedTaskId = safeText(latest.generatedTaskId, 180);
  const visibleTask = generatedTaskId
    ? taskItems.find((task) => [task.taskId, task.fullId, task.id].some((value) => safeText(value, 180) === generatedTaskId))
    : null;
  const status = safeText(latest.status, 80);
  const generatedTaskVisible = Boolean(visibleTask);
  const requestHandoffState = generatedTaskId
    ? generatedTaskVisible
      ? "generated_visible"
      : "generated_projection_pending"
    : latest.needsAttention || status === "failed"
      ? "failed"
      : latest.isProcessing || ["signing", "published", "queued", "generating"].includes(status)
        ? status || "processing"
        : latest.isTerminal
          ? "terminal"
          : "waiting";

  return {
    latestRequestId: latest.requestId || "",
    latestRequestStatus: status,
    latestRequestUpdatedAt: latest.updatedAt || null,
    generatedTaskId,
    generatedTaskVisible,
    visibleTaskId: visibleTask?.taskId || "",
    requestHandoffState,
    lastError: latest.lastError || "",
    isProcessing: Boolean(latest.isProcessing),
    needsAttention: Boolean(latest.needsAttention),
  };
}

export function taskActionState(status = "") {
  return taskLifecycleActions(status);
}

export function latestPointerSortValue(row = {}) {
  return [
    Number(row.ledger_index || 0),
    Date.parse(row.close_time || "") || 0,
    String(row.tx_hash || ""),
    Number(row.memo_index || 0),
  ].join(":");
}

export function directWriteProjectionIsAuthoritative(row = {}, latest = {}) {
  const pointerKind = safeText(latest.pointer_kind || latest.pointerKind, 120).toUpperCase();
  if (pointerKind === "REWARD") return false;
  const source = safeText(row.source, 120).toLowerCase();
  const projectionTx = safeText(row.last_event_tx_hash, 240).toLowerCase();
  const projectionCid = safeText(row.last_event_cid, 240).toLowerCase();
  const metadata = safeObject(row.metadata_json);
  const offchainLifecycle = safeObject(metadata.offchainLifecycle);
  return source === "direct_write" ||
    projectionTx.startsWith("offchain:") ||
    projectionCid.startsWith("postgres:") ||
    (offchainLifecycle.enabled === true && offchainLifecycle.dualWrite !== true);
}

export function isProjectionBehindCachedPointer(row = {}, latest = {}) {
  if (!latest?.tx_hash && !latest?.cid) return false;
  if (directWriteProjectionIsAuthoritative(row, latest)) return false;
  const projectionTx = safeText(row.last_event_tx_hash, 240);
  const projectionCid = safeText(row.last_event_cid, 240);
  const cachedTx = safeText(latest.tx_hash, 240);
  const cachedCid = safeText(latest.cid, 240);
  if (cachedTx && projectionTx && cachedTx === projectionTx) return false;
  if (cachedCid && projectionCid && cachedCid === projectionCid) return false;
  return Boolean(cachedTx || cachedCid);
}

export function emptyTaskCounts() {
  return {
    outstanding: 0,
    verification: 0,
    refused: 0,
    rewarded: 0,
  };
}

export function countTaskProjectionRows(rows = []) {
  const counts = emptyTaskCounts();
  for (const row of Array.isArray(rows) ? rows : []) {
    const tab = taskStatusTab(normalizeTaskStatus(row.status));
    if (tab === "rewarded") {
      counts.rewarded += 1;
    } else if (tab === "refused") {
      counts.refused += 1;
    } else if (tab === "verification") {
      counts.verification += 1;
    } else {
      counts.outstanding += 1;
    }
  }
  return counts;
}
