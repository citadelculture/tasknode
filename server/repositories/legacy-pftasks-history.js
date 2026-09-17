import { createHash } from "node:crypto";
import { query } from "../db/pool.js";
import { taskLifecycleActions, taskStatusInfo } from "../../shared/task-lifecycle.js";
import { formatTaskDeadline, formatTaskTimestamp } from "../../shared/task-time-format.js";
import { numeric, relativeAge, safeObject, safeText, titleCase, toIso } from "./task-projection-contract.js";
import { normalizeTaskSteps } from "../../shared/task-steps.js";

const legacySource = "legacy_pftasks_archive";

function digest(value = "") {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

export function legacyConversationId({ legacyUserId = "", chatType = "chat" } = {}) {
  return `legacy_pftasks_${digest(`${legacyUserId}:${chatType}`)}`;
}

export function legacyChatTitle(chatType = "chat") {
  const normalized = safeText(chatType || "chat", 120);
  const withoutNamespace = normalized.includes(":") ? normalized.split(":").slice(1).join(":") : normalized;
  const title = titleCase(withoutNamespace || "chat");
  if (normalized.startsWith("task_")) return `${title} task history`;
  return title === "Chat" ? "PFTasks chat history" : `${title} history`;
}

export async function listLegacyChatConversations({ accountId = "", limit = 30 } = {}) {
  const normalizedAccountId = safeText(accountId, 160);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  if (!normalizedAccountId) return [];
  const result = await query(
    `SELECT
       messages.conversation_id,
       messages.legacy_user_id,
       messages.chat_type,
       min(messages.source_created_at) AS created_at,
       max(messages.source_created_at) AS updated_at,
       count(*)::integer AS message_count,
       (array_agg(messages.body ORDER BY messages.source_created_at DESC, messages.source_message_id DESC))[1]
         AS last_message_preview
     FROM legacy_pftasks_chat_messages messages
     JOIN account_linked_wallets wallets
       ON wallets.wallet_address = messages.wallet_address
      AND wallets.account_id = $1
      AND wallets.status = 'linked'
     GROUP BY messages.conversation_id, messages.legacy_user_id, messages.chat_type
     ORDER BY updated_at DESC, messages.conversation_id DESC
     LIMIT $2`,
    [normalizedAccountId, normalizedLimit]
  );
  return result.rows.map((row) => ({
    id: row.conversation_id,
    conversationId: row.conversation_id,
    title: legacyChatTitle(row.chat_type),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastMessageAt: toIso(row.updated_at),
    lastMessagePreview: safeText(row.last_message_preview, 140),
    messageCount: Number(row.message_count || 0),
    unreadCount: 0,
    unread: false,
    readOnly: true,
    source: legacySource,
  }));
}

export async function getLegacyChatMessages({ accountId = "", conversationId = "", limit = 200 } = {}) {
  const normalizedAccountId = safeText(accountId, 160);
  const normalizedConversationId = safeText(conversationId, 180);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  if (!normalizedAccountId || !normalizedConversationId) return [];
  const result = await query(
    `SELECT messages.*
       FROM legacy_pftasks_chat_messages messages
       JOIN account_linked_wallets wallets
         ON wallets.wallet_address = messages.wallet_address
        AND wallets.account_id = $1
        AND wallets.status = 'linked'
      WHERE messages.conversation_id = $2
      ORDER BY messages.source_created_at DESC, messages.source_message_id DESC
      LIMIT $3`,
    [normalizedAccountId, normalizedConversationId, normalizedLimit]
  );
  return result.rows.reverse().map((row) => ({
    id: `legacy_${row.source_message_id}`,
    role: row.role,
    body: row.body,
    createdAt: toIso(row.source_created_at),
    mode: row.chat_type || undefined,
    metadata: {
      ...safeObject(row.source_metadata_json),
      readOnly: true,
      source: legacySource,
      sourceMessageId: row.source_message_id,
    },
  }));
}

export async function searchLegacyChatConversations({ accountId = "", searchText = "", limit = 20 } = {}) {
  const normalizedAccountId = safeText(accountId, 160);
  const normalizedSearch = safeText(searchText, 200).toLowerCase();
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  if (!normalizedAccountId || normalizedSearch.length < 2) return [];
  const conversations = await listLegacyChatConversations({ accountId: normalizedAccountId, limit: 100 });
  const titleMatches = new Map(
    conversations
      .filter((conversation) => conversation.title.toLowerCase().includes(normalizedSearch))
      .map((conversation) => [conversation.conversationId, {
        ...conversation,
        snippet: conversation.lastMessagePreview,
        matchSource: "title",
      }])
  );
  const messageMatches = await query(
    `SELECT DISTINCT ON (messages.conversation_id)
       messages.conversation_id, messages.body, messages.source_created_at
     FROM legacy_pftasks_chat_messages messages
     JOIN account_linked_wallets wallets
       ON wallets.wallet_address = messages.wallet_address
      AND wallets.account_id = $1
      AND wallets.status = 'linked'
     WHERE position($2 in lower(messages.body)) > 0
     ORDER BY messages.conversation_id, messages.source_created_at DESC, messages.source_message_id DESC`,
    [normalizedAccountId, normalizedSearch]
  );
  const conversationById = new Map(conversations.map((conversation) => [conversation.conversationId, conversation]));
  const merged = new Map(titleMatches);
  for (const row of messageMatches.rows) {
    if (merged.has(row.conversation_id)) continue;
    const conversation = conversationById.get(row.conversation_id);
    if (!conversation) continue;
    merged.set(row.conversation_id, {
      ...conversation,
      snippet: safeText(row.body, 160),
      matchSource: "message",
      updatedAt: toIso(row.source_created_at),
    });
  }
  return [...merged.values()]
    .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""))
    .slice(0, normalizedLimit);
}

export async function legacyConversationReadable({ accountId = "", conversationId = "" } = {}) {
  const result = await query(
    `SELECT 1
       FROM legacy_pftasks_chat_messages messages
       JOIN account_linked_wallets wallets
         ON wallets.wallet_address = messages.wallet_address
        AND wallets.account_id = $1
        AND wallets.status = 'linked'
      WHERE messages.conversation_id = $2
      LIMIT 1`,
    [safeText(accountId, 160), safeText(conversationId, 180)]
  );
  return Boolean(result.rows[0]);
}

function legacyStatusKey(status = "") {
  return safeText(status, 80).toLowerCase() === "rewarded" ? "rewarded" : "refused";
}

export function publicLegacyTask(row = {}) {
  const statusKey = legacyStatusKey(row.source_status);
  const statusInfo = taskStatusInfo(statusKey);
  const sourceStatus = safeText(row.source_status || "archived", 80);
  const taskCategory = safeText(row.task_category || "personal", 80).toLowerCase();
  const deadlineAt = toIso(row.deadline_at || row.due_at);
  const formattedDue = formatTaskDeadline(deadlineAt, { locale: "en-US" });
  const updatedAt = toIso(
    row.source_updated_at || row.reward_paid_at || row.verified_at || row.submitted_at || row.source_created_at
  );
  const actual = row.reward_amount_actual;
  const estimate = row.reward_amount_estimate;
  const pft = actual !== null && actual !== undefined ? numeric(actual) : numeric(estimate);
  const taskId = `legacy_pftasks_task_${row.source_task_id}`;
  return {
    id: taskId.slice(0, 12),
    fullId: taskId,
    taskId,
    title: row.title || "Untitled historical task",
    kind: taskCategory === "network" || taskCategory === "alpha" ? titleCase(taskCategory) : "Personal",
    originalKind: titleCase(taskCategory || "task"),
    taskClass: taskCategory,
    isNetworkTask: taskCategory === "network" || taskCategory === "alpha",
    status: titleCase(sourceStatus || "archived"),
    statusKey,
    statusTone: statusInfo.tone,
    statusColor: statusInfo.color,
    statusTab: statusInfo.tab,
    lifecycle: statusInfo,
    due: formattedDue,
    fullDue: formattedDue || "Historical",
    dueLabel: deadlineAt ? "Deadline" : "Archive",
    dueAt: deadlineAt,
    deadlineAt,
    ago: relativeAge(updatedAt),
    pft,
    description: row.description || "",
    steps: normalizeTaskSteps(row.steps_json, { clean: safeText }),
    verification: {
      title: row.verification_type ? `Submit ${titleCase(row.verification_type)}` : "Historical verification",
      body: safeText(safeObject(row.verification_criteria_json).criteria || "", 2000),
      policy: safeObject(row.verification_criteria_json),
    },
    submissionRequirement: {
      type: row.verification_type || "",
      criteria: safeText(safeObject(row.verification_criteria_json).criteria || "", 2000),
    },
    verificationPolicy: safeObject(row.verification_criteria_json),
    submissionType: row.verification_type || "",
    txHash: row.reward_tx_hash || "",
    source: legacySource,
    legacyReadOnly: true,
    updatedAt,
    updatedAtDisplay: formatTaskTimestamp(updatedAt, { locale: "en-US" }),
    lastEventAt: updatedAt,
    lastEventAtDisplay: formatTaskTimestamp(updatedAt, { locale: "en-US" }),
    metadata: {
      sourceTaskId: row.source_task_id,
      legacyUserId: row.legacy_user_id,
      sourceStatus,
      refusalReason: row.refusal_reason || undefined,
      cancellationReason: row.cancellation_reason || undefined,
      rejectionReason: row.rejection_reason || undefined,
      ...safeObject(row.source_metadata_json),
    },
  };
}

export async function listLegacyTasks({ accountId = "", walletAddress = "" } = {}) {
  const result = await query(
    `SELECT tasks.*
       FROM legacy_pftasks_tasks tasks
       JOIN account_linked_wallets wallets
         ON wallets.wallet_address = tasks.wallet_address
        AND wallets.account_id = $1
        AND wallets.status = 'linked'
      WHERE tasks.wallet_address = $2
      ORDER BY tasks.source_created_at DESC, tasks.source_task_id DESC
      LIMIT 500`,
    [safeText(accountId, 160), safeText(walletAddress, 180)]
  );
  return result.rows.map(publicLegacyTask);
}

export async function getLegacyTaskDetail({ accountId = "", walletAddress = "", taskId = "" } = {}) {
  const prefix = "legacy_pftasks_task_";
  const normalizedTaskId = safeText(taskId, 220);
  if (!normalizedTaskId.startsWith(prefix)) return null;
  const sourceTaskId = normalizedTaskId.slice(prefix.length);
  const result = await query(
    `SELECT tasks.*
       FROM legacy_pftasks_tasks tasks
       JOIN account_linked_wallets wallets
         ON wallets.wallet_address = tasks.wallet_address
        AND wallets.account_id = $1
        AND wallets.status = 'linked'
      WHERE tasks.source_task_id = $2
        AND tasks.wallet_address = $3
      LIMIT 1`,
    [safeText(accountId, 160), sourceTaskId, safeText(walletAddress, 180)]
  );
  const row = result.rows[0];
  if (!row) return null;
  const task = publicLegacyTask(row);
  return {
    ok: true,
    task,
    wallets: { user: row.wallet_address, authority: "", allocation: "" },
    actions: taskLifecycleActions(task.statusKey),
    submission: {
      summaries: [],
      generatedTask: {},
      verificationPolicy: safeObject(row.verification_criteria_json),
    },
    currentVerificationRequest: {},
    rewardOutcome: task.statusKey === "rewarded" ? {
      status: "paid",
      amountPft: task.pft,
      paymentTxHash: row.reward_tx_hash || "",
      paymentObservedAt: toIso(row.reward_paid_at || row.verified_at),
    } : null,
    forensics: {
      source: legacySource,
      eventCount: 0,
      requestBundleCid: "",
      contextCid: "",
      lastEventTxHash: row.reward_tx_hash || "",
      lastEventCid: "",
      cids: [],
      transactions: row.reward_tx_hash ? [{ txHash: row.reward_tx_hash, source: legacySource }] : [],
      timeline: [],
      pointerEvents: [],
      reducerEvents: [],
      integrity: {
        expectedEventCount: 0,
        pointerEventCount: 0,
        reducerEventCount: 0,
        renderedEventCount: 0,
        terminalLightweight: true,
      },
    },
    sync: { updatedAt: task.updatedAt, lastEventAt: task.lastEventAt, requiresRefresh: false, nextPollMs: null },
  };
}

export async function listLegacyContextRows({ accountId = "", walletAddress = "", limit = 250 } = {}) {
  const result = await query(
    `SELECT revisions.*
       FROM legacy_pftasks_context_revisions revisions
       JOIN account_linked_wallets wallets
         ON wallets.wallet_address = revisions.wallet_address
        AND wallets.account_id = $1
        AND wallets.status = 'linked'
      WHERE revisions.wallet_address = $2
      ORDER BY revisions.source_created_at DESC, revisions.source_revision_id DESC
      LIMIT $3`,
    [safeText(accountId, 160), safeText(walletAddress, 180), Math.min(Math.max(Number(limit) || 250, 1), 250)]
  );
  return result.rows.map((row) => ({
    id: `legacy_context_${row.source_revision_id}`,
    account_id: safeText(accountId, 160),
    wallet_address: row.wallet_address,
    cid: row.cid,
    pointer_type: "context",
    kind: 5,
    kind_label: "CONTEXT",
    schema: "legacy.pftasks.context_revision.v1",
    flags: 0,
    task_id: null,
    thread_id: null,
    context_id: `legacy_pftasks:${row.source_revision_id}`,
    tx_hash: row.tx_hash || null,
    ledger_index: null,
    memo_index: null,
    pointer_created_at: row.source_created_at,
    account_address: row.wallet_address,
    destination_address: null,
    direction: "historical",
    source: legacySource,
    version: null,
    word_count: row.word_count,
    created_at: row.imported_at,
  }));
}
