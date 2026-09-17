#!/usr/bin/env node
import { collapseWhitespace, isIdentifierChar, textTokens, isWhitespace, replaceClassifiedSpan, stripMarkdownFence } from "../server/inference-text.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INFERENCE_MODELS, inferenceChatCompletion, inferenceConfigured } from "../server/inference.js";
import {
  databaseRowsToDeathmarchEvents,
  isDeathmarchTaskEvent,
  loadDeathmarchEvents,
  observeDeathmarchDatabasePool,
  resolveDeathmarchMembers,
} from "./deathmarch-event-source.mjs";
import {
  DEFAULT_DEATHMARCH_SEED_FILE,
  deathmarchEnvWithSeedFile,
  decryptTasknodeUserMnemonicPayload,
  tasknodePublicKeyFromUserMnemonic,
} from "./deathmarch-identity.mjs";

export {
  databaseRowsToDeathmarchEvents,
  deathmarchEnvWithSeedFile,
  decryptTasknodeUserMnemonicPayload,
  observeDeathmarchDatabasePool,
  tasknodePublicKeyFromUserMnemonic,
};

const DEFAULT_WALLET = "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx";
const DEFAULT_STATE_PATH = ".deathmarch-state.json";
const DEFAULT_SEED_FILE = DEFAULT_DEATHMARCH_SEED_FILE;
const DEFAULT_INFERENCE_MODEL = INFERENCE_MODELS.structured;
const DEFAULT_INFERENCE_TIMEOUT_MS = 20000;
const DEFAULT_DISCORD_TIMEOUT_MS = 10000;
const CLASSIFIER_FAILURE_CATEGORY = "classification unavailable";

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function compactWhitespace(value = "") { return collapseWhitespace(safeText(value, 4000)); }

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
  // Keep the bounded message: a bare "Error" hides Discord/inference failure
  // detail such as discord_bot_error:429 from the poll log.
  const detail = safeText(error?.code || error?.message || error?.name || "deathmarch_error", 240);
  return [...detail].map((char) => isIdentifierChar(char) || ".:".includes(char) ? char : "_").join("");
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs, timeoutCode) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      const error = new Error(timeoutCode);
      error.code = timeoutCode;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    file: "",
    wallet: process.env.DEATHMARCH_WALLET || DEFAULT_WALLET,
    statePath: process.env.DEATHMARCH_STATE_PATH || DEFAULT_STATE_PATH,
    seedFile: process.env.DEATHMARCH_SEED_FILE || DEFAULT_SEED_FILE,
    seedFileExplicit: Boolean(process.env.DEATHMARCH_SEED_FILE),
    anonymity: process.env.DEATHMARCH_ANONYMITY_LEVEL || "3",
    dryRun: false,
    noState: false,
    markExisting: false,
    poll: false,
    once: false,
    limit: process.env.DEATHMARCH_ACCOUNT_TX_LIMIT || "100",
    maxPages: process.env.DEATHMARCH_ACCOUNT_TX_MAX_PAGES || "1",
    processLimit: process.env.DEATHMARCH_PROCESS_LIMIT || "25",
    intervalMs: process.env.DEATHMARCH_POLL_INTERVAL_MS || "60000",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || "";
    if (arg === "--file") args.file = next();
    else if (arg === "--wallet") args.wallet = next();
    else if (arg === "--state") args.statePath = next();
    else if (arg === "--seed-file") {
      args.seedFile = next();
      args.seedFileExplicit = true;
    }
    else if (arg === "--anonymity" || arg === "--level") args.anonymity = next();
    else if (arg === "--limit") args.limit = next();
    else if (arg === "--max-pages") args.maxPages = next();
    else if (arg === "--process-limit") args.processLimit = next();
    else if (arg === "--interval-ms") args.intervalMs = next();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-state") args.noState = true;
    else if (arg === "--mark-existing") args.markExisting = true;
    else if (arg === "--poll") args.poll = true;
    else if (arg === "--once") args.once = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (!args.file && !arg.startsWith("-")) args.file = arg;
    else throw new Error(`unknown_arg:${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Deathmarch local Discord harness",
    "",
    "Usage:",
    "  npm run deathmarch -- --once --dry-run",
    "  npm run deathmarch -- --poll",
    "  npm run deathmarch -- --once --mark-existing",
    "  npm run deathmarch -- --file ./task-events.json --anonymity 2",
    "  npm run deathmarch -- --poll --seed-file ./deathmarchseed.txt",
    "",
    "Required env:",
    "  VERCEL_AI_GATEWAY_API_KEY (primary); AMBIENT_API_KEY (backup)",
    "  DEATHMARCH_DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN + DEATHMARCH_DISCORD_CHANNEL_ID",
    "",
    "Optional env:",
    `  DEATHMARCH_WALLET=${DEFAULT_WALLET}`,
    `  DEATHMARCH_SEED_FILE=${DEFAULT_SEED_FILE}`,
    `  DEATHMARCH_INFERENCE_MODEL=${DEFAULT_INFERENCE_MODEL}`,
    `  DEATHMARCH_STATE_PATH=${DEFAULT_STATE_PATH}`,
    "  DEATHMARCH_DATABASE_URL=postgres://...  # optional direct-write task_events feed",
    "  DEATHMARCH_DATABASE_EVENTS_ENABLED=false  # disable database feed",
  ].join("\n");
}

function eventTextBlob(event = {}) {
  const payload = safeObject(event.payload);
  return [
    event.raw?.title,
    payload.title,
    payload.description,
    payload.objective,
    payload.summary,
    payload.request_text,
    payload.user_request,
    payload.prompt,
    payload.submission_requirement?.criteria,
    payload.submission_requirement?.description,
    payload.verification_ask,
    payload.verification_request?.verification_ask,
    payload.response_text,
    payload.response,
    payload.reward_summary,
    payload.score?.reason,
    payload.score?.user_feedback,
    safeArray(payload.evidence_items).map((item) => `${item?.type || ""} ${item?.text || item?.summary || ""}`).join(" "),
  ].filter(Boolean).join("\n");
}

function compactEvidenceItemDetail(item = {}) {
  const evidence = safeObject(item);
  const file = safeObject(evidence.file);
  const artifactType = safeText(evidence.artifact_type || evidence.type || "evidence", 80);
  const fileName = safeText(file.name || evidence.file_name || "", 180);
  const body = compactWhitespace(
    evidence.text ||
      evidence.summary ||
      evidence.value ||
      file.description ||
      file.text ||
      evidence.notes ||
      ""
  ).slice(0, 360);
  const label = fileName ? `${artifactType} ${fileName}` : artifactType;
  if (!body) return label;
  return `${label}: ${body}`;
}

function compactEvidenceDetail(payload = {}) {
  const responseText = compactWhitespace(payload.response_text || payload.response || "").slice(0, 700);
  if (responseText) return responseText;
  const items = safeArray(payload.evidence_items)
    .map(compactEvidenceItemDetail)
    .filter(Boolean)
    .slice(0, 2);
  if (items.length) return items.join(" | ").slice(0, 900);
  const evidence = safeObject(payload.evidence || payload.submission);
  const nestedItems = safeArray(evidence.evidence_items)
    .map(compactEvidenceItemDetail)
    .filter(Boolean)
    .slice(0, 2);
  if (nestedItems.length) return nestedItems.join(" | ").slice(0, 900);
  return compactWhitespace(
    evidence.value ||
      evidence.text ||
      evidence.summary ||
      evidence.notes ||
      safeObject(evidence.file).description ||
      safeObject(evidence.file).text ||
      ""
  ).slice(0, 700);
}

function formatPftAmount(value = "") {
  const text = safeText(value, 80);
  if (!text) return "";
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return `${text} PFT`;
  return `${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })} PFT`;
}

function compactRewardDetail(payload = {}, actionKind = "") {
  const score = safeObject(payload.score || payload.reward_score);
  const amount = formatPftAmount(
    payload.reward_pft ||
      payload.economic_reward_pft ||
      payload.reward_actual_pft ||
      payload.reward_paid ||
      score.reward_pft ||
      ""
  );
  const carrierDrops = safeText(payload.carrier_amount_drops || payload.carrier_drops || "", 80);
  const decision = compactWhitespace(
    payload.reward_tier ||
      payload.reward_decision ||
      score.decision ||
      ""
  ).split("_").join(" ");
  const evidenceQuality = safeText(payload.evidence_quality || score.evidence_quality || "", 40);
  const reason = compactWhitespace(
    payload.reward_summary ||
      payload.summary ||
      score.user_feedback ||
      score.reason ||
      ""
  ).slice(0, 360);
  const kind = safeText(actionKind, 160).toLowerCase();
  if (!amount && !decision && !evidenceQuality && !reason) return "";
  if (kind === "reward_outcome") {
    const amountText = amount || "reward outcome";
    const carrierText = carrierDrops && Number(carrierDrops) > 0
      ? " The transaction is a one-drop carrier for a zero-PFT outcome."
      : "";
    const prefix = `Recorded terminal reward outcome: ${amountText}.${carrierText}`;
    return [prefix, reason].filter(Boolean).join(" ");
  }
  const parts = [];
  if (decision) parts.push(`outcome ${decision}`);
  if (amount) parts.push(`amount ${amount}`);
  if (evidenceQuality) parts.push(`evidence quality ${evidenceQuality}/100`);
  const prefix = parts.length ? `Recorded reward ${parts.join(", ")}.` : "Recorded reward outcome.";
  return [prefix, reason].filter(Boolean).join(" ");
}

function publicPayloadFields(event = {}) {
  const payload = safeObject(event.payload);
  const evidenceSummary = safeArray(payload.evidence_items).map((item, index) => ({
    index: index + 1,
    type: item?.type || item?.artifact_type || "",
    text: compactEvidenceItemDetail(item),
  })).slice(0, 5);
  return {
    schema: event.schema || payload.schema,
    action_kind: event.actionKind,
    task_id: event.taskId,
    title: payload.title || event.raw?.title || "",
    description: payload.description || "",
    transition: payload.transition || payload.status_after || payload.status || "",
    phase: payload.phase || "",
    request_text: payload.request_text || payload.request?.request_text || "",
    user_detail_text: payload.user_detail_text || payload.request?.user_detail_text || "",
    requested_task_kind: payload.requested_task_kind || payload.request?.requested_task_kind || "",
    request_bundle_summary: payload.request_bundle?.summary || payload.recent_chat?.summary || "",
    reward_pft: payload.reward_pft || payload.economic_reward_pft || payload.reward_actual_pft || payload.score?.reward_pft || "",
    reward_outcome: payload.reward_tier || payload.reward_decision || payload.score?.decision || "",
    carrier_amount_drops: payload.carrier_amount_drops || "",
    reward_detail: compactRewardDetail(payload, event.actionKind),
    reward_summary: payload.reward_summary || payload.summary || payload.score?.user_feedback || payload.score?.reason || "",
    verification_ask: payload.verification_ask || payload.verification_request?.verification_ask || "",
    response_text: payload.response_text || payload.response || "",
    submission_detail: compactEvidenceDetail(payload),
    evidence_summary: evidenceSummary,
    payload_error: payload.payload_error || "",
  };
}

function deathmarchActionLabel(actionKind = "") {
  const kind = safeText(actionKind, 160).toLowerCase();
  if (kind === "task_request") return "Task requested";
  if (kind === "task_offer") return "Task proposed";
  if (kind === "initial_verification" || kind === "task_submission") return "Evidence submitted";
  if (kind === "verification_response") return "Verification response submitted";
  if (kind === "reward_outcome") return "Reward outcome";
  if (kind.startsWith("task_update_")) {
    const transition = kind.slice("task_update_".length).split("_").join(" ");
    if (transition === "accepted") return "Task accepted";
    if (transition === "refused") return "Task refused";
    if (transition === "cancelled" || transition === "canceled") return "Task cancelled";
    if (transition === "verification requested") return "Verification requested";
    if (transition === "reward decided") return "Reward outcome pending";
    if (transition === "rewarded") return "Task rewarded";
    return `Task updated: ${transition}`;
  }
  if (kind === "task_update") return "Task updated";
  return "Task activity";
}

function stripGeneratedDiscordNoise(summary = "", txHash = "") {
  const text = stripMarkdownFence(safeText(summary, 1200));
  const tokens = textTokens(text);
  let cleaned = "";
  let cursor = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!txHash || token.value.toLowerCase() !== txHash.toLowerCase()) continue;
    let start = token.start;
    const preceding = tokens[i - 1];
    const label = preceding?.value.toLowerCase();
    if (preceding && [...text.slice(preceding.end, token.start)].every((char) => char === ":" || isWhitespace(char))) {
      if (["tx", "transaction"].includes(label)) start = preceding.start;
      if (label === "hash" && tokens[i - 2]?.value.toLowerCase() === "transaction") start = tokens[i - 2].start;
    }
    cleaned += text.slice(cursor, start);
    cursor = token.end;
  }
  return compactWhitespace(cleaned + text.slice(cursor)).slice(0, 360);
}

function isSubmissionAction(actionKind = "") {
  const kind = safeText(actionKind, 160).toLowerCase();
  return ["initial_verification", "task_submission", "verification_response"].includes(kind);
}

function isGenericSubmissionSummary(summary = "") {
  const text = compactWhitespace(summary).toLowerCase();
  if (!text) return true;
  return [
    "a new task was submitted",
    "task was submitted",
    "evidence was submitted",
    "initial verification",
    "verification response was submitted",
    "now in initial verification",
    "awaiting review",
  ].some((phrase) => text.includes(phrase));
}

function submissionSummaryWithDetail({ summary = "", actionKind = "", payload = {} } = {}) {
  if (!isSubmissionAction(actionKind)) return summary;
  const detail = compactWhitespace(payload.submission_detail || "").slice(0, 420);
  if (!detail) return summary;
  if (!isGenericSubmissionSummary(summary)) return summary;
  if (safeText(actionKind, 160).toLowerCase() === "verification_response") {
    return `Submitted verification response: ${detail}`;
  }
  return `Submitted evidence: ${detail}`;
}

function isRewardAction(actionKind = "") {
  const kind = safeText(actionKind, 160).toLowerCase();
  return kind === "reward_outcome";
}

function isGenericRewardSummary(summary = "") {
  const text = compactWhitespace(summary).toLowerCase();
  if (!text) return true;
  return [
    "reward was paid",
    "reward paid",
    "reward outcome",
    "reward was recorded",
    "task was rewarded",
    "rewarded the task",
    "scored the submitted evidence",
  ].some((phrase) => text.includes(phrase));
}

function rewardSummaryWithDetail({ summary = "", actionKind = "", payload = {} } = {}) {
  if (!isRewardAction(actionKind)) return summary;
  const detail = compactWhitespace(payload.reward_detail || "").slice(0, 520);
  if (!detail) return summary;
  if (isGenericRewardSummary(summary)) return detail;
  if (detail.includes(" PFT") && !summary.includes(" PFT")) return detail;
  return summary;
}

export function formatDeathmarchDiscordMessage({ summary = "", event = {} } = {}) {
  const txHash = safeText(event.tx_hash || event.txHash, 220).toUpperCase();
  if (!txHash) throw new Error("deathmarch_tx_hash_missing");
  const actionLabel = deathmarchActionLabel(event.action_kind || event.actionKind);
  const payload = safeObject(event.event);
  const title = compactWhitespace(payload.title || event.title || "").slice(0, 140);
  const taskId = safeText(event.task_id || event.taskId || payload.task_id, 180);
  const cleanedSummary = rewardSummaryWithDetail({
    summary: submissionSummaryWithDetail({
      summary: stripGeneratedDiscordNoise(summary, txHash),
      actionKind: event.action_kind || event.actionKind,
      payload,
    }),
    actionKind: event.action_kind || event.actionKind,
    payload,
  });
  const fallbackSummary = taskId
    ? `${actionLabel.toLowerCase()} for task ${taskId}.`
    : `${actionLabel.toLowerCase()}.`;
  const memberHandle = safeText(event.member_handle || event.member?.handle, 80);
  const lines = [
    memberHandle ? `**@${memberHandle}** · **${actionLabel}**` : `**${actionLabel}**`,
    title ? `**${title}**` : "",
    cleanedSummary || fallbackSummary,
    taskId ? `Task: \`${taskId}\`` : "",
    `tx: ${txHash}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function safeClassificationCategory(value = "") {
  return safeText(value || "confidential task", 120) || "confidential task";
}

function safeClassifierFallback() {
  return {
    // Provider failure must be availability-safe and disclosure-safe. Level 1
    // strips the event down to directional metadata when the classifier could
    // not identify exact redaction spans.
    level: 1,
    category: CLASSIFIER_FAILURE_CATEGORY,
    sensitive_entities: [],
    sensitive_strategy_details: [],
  };
}

function parseClassifierJson(content = "") {
  const parsed = JSON.parse(safeText(content, 2000));
  const object = safeObject(parsed);
  const level = clampInteger(object.level, 0, 1, 3);
  if (!level) throw new Error("deathmarch_classifier_level_invalid");
  const sensitiveEntities = safeArray(object.sensitive_entities)
    .slice(0, 16)
    .map((entry) => {
      const entity = safeObject(entry);
      const kind = safeText(entity.kind, 40).toLowerCase();
      const name = compactWhitespace(entity.name).slice(0, 160);
      if (!name || !["client", "investor"].includes(kind)) return null;
      return { kind, name };
    })
    .filter(Boolean)
    .filter((entity, index, entities) => {
      return entities.findIndex((candidate) => {
        return candidate.kind === entity.kind && candidate.name.toLowerCase() === entity.name.toLowerCase();
      }) === index;
    });
  const sensitiveStrategyDetails = safeArray(object.sensitive_strategy_details)
    .slice(0, 8)
    .map((value) => compactWhitespace(value).slice(0, 600))
    .filter((value) => value.length >= 12)
    .filter((value, index, values) => {
      return values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index;
    });
  return {
    level,
    category: safeClassificationCategory(object.category || "classified task"),
    sensitive_entities: sensitiveEntities,
    sensitive_strategy_details: sensitiveStrategyDetails,
  };
}

function deathmarchClassifierPrompt() {
  return [
    "You classify Task Node Death March event disclosure risk.",
    "Return strict JSON only: {\"level\":1|2|3,\"category\":\"short category without names\",\"sensitive_entities\":[{\"kind\":\"client\"|\"investor\",\"name\":\"exact name from event\"}],\"sensitive_strategy_details\":[\"smallest exact confidential substring from event\"]}.",
    "",
    "Level 1: the event contains exact proprietary strategy or intellectual-property mechanics that should not be public, such as formulas, algorithm steps, signal definitions, portfolio construction rules, execution logic, confidential research methods, or similarly concrete secret know-how.",
    "Do not use level 1 for a general topic, task direction, industry, instrument, ticker, product area, public documentation, ordinary business work, or a generic request to develop a strategy. The event must contain concrete proprietary mechanics.",
    "For level 1, copy only the smallest exact substrings containing the secret mechanics into sensitive_strategy_details. Do not copy an entire title, description, or evidence item when a narrower phrase or sentence isolates the secret. Non-secret context must remain publishable.",
    "Level 2: the event contains the specific proper name of an external client/customer or investor, but no level-1 strategy detail. List each exact client or investor name in sensitive_entities so it can be removed before summarization.",
    "Level 3: everything else. Ordinary client work without a client name, fundraising without a named investor, legal/team/partner/protocol/product/open-source work, public organization names, contributor names, and project names are level 3.",
    "",
    "sensitive_entities must contain only explicit proper-name identifiers for clients/customers or investors. Never include generic roles, project names, team members, vendors, protocols, or organizations that are not identified as a client/customer or investor.",
    "When uncertain, choose level 3. Redact only the three requested classes: exact client names, exact investor names, and exact proprietary strategy/IP details.",
  ].join("\n");
}

export async function classifyEventAnonymity({
  event,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!inferenceConfigured(env)) return safeClassifierFallback();
  const requestBody = {
    model: (env.DEATHMARCH_INFERENCE_CLASSIFY_MODEL || env.DEATHMARCH_AMBIENT_CLASSIFY_MODEL) || (env.DEATHMARCH_INFERENCE_MODEL || env.DEATHMARCH_AMBIENT_MODEL) || DEFAULT_INFERENCE_MODEL,
    messages: [
      { role: "system", content: deathmarchClassifierPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Classify this event for Death March Discord disclosure.",
          event_text: eventTextBlob(event),
        }, null, 2),
      },
    ],
    temperature: 0,
    max_tokens: 1200,
  };
  try {
    const result = await inferenceChatCompletion({ env, fetchImpl, body: requestBody, capability: "strict_json", timeoutMs: clampInteger(
      (env.DEATHMARCH_INFERENCE_TIMEOUT_MS || env.DEATHMARCH_AMBIENT_TIMEOUT_MS),
      DEFAULT_INFERENCE_TIMEOUT_MS,
      1000,
      120000
    ) });
    const content = safeText(result.text, 2000);
    if (!content) return safeClassifierFallback();
    return parseClassifierJson(content);
  } catch {
    return safeClassifierFallback();
  }
}

function effectiveAnonymityLevel({ globalFloor = 3, classifiedLevel = 3 } = {}) {
  return Math.min(
    clampInteger(globalFloor, 3, 1, 3),
    clampInteger(classifiedLevel, 1, 1, 3)
  );
}

export function sanitizeEventForAnonymity(event = {}, anonymity = 3, classification = {}) {
  const level = clampInteger(anonymity, 3, 1, 3);
  const sensitiveEntities = safeArray(classification.sensitive_entities);
  const sensitiveStrategyDetails = safeArray(classification.sensitive_strategy_details);
  const redactProtectedText = (value) => {
    if (typeof value === "string") {
      const withoutStrategyDetails = sensitiveStrategyDetails.reduce((text, detail) => {
        const protectedDetail = compactWhitespace(detail).slice(0, 600);
        if (protectedDetail.length < 12) return text;
        return replaceClassifiedSpan(text, protectedDetail, "[redacted strategy detail]");
      }, value);
      return sensitiveEntities.reduce((text, entry) => {
        const entity = safeObject(entry);
        const kind = safeText(entity.kind, 40).toLowerCase();
        const name = compactWhitespace(entity.name).slice(0, 160);
        if (!name || !["client", "investor"].includes(kind)) return text;
        return replaceClassifiedSpan(text, name, `[redacted ${kind}]`);
      }, withoutStrategyDetails);
    }
    if (Array.isArray(value)) return value.map(redactProtectedText);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactProtectedText(entry)]));
    }
    return value;
  };
  const category = safeClassificationCategory(redactProtectedText(
    classification.category || event.category || "classified task"
  ));
  const txHash = event.txHash;
  const base = {
    anonymity_level: level,
    tx_hash: txHash,
    cid: event.cid,
    task_id: event.taskId,
    action_kind: event.actionKind,
    occurred_at: event.occurredAt,
  };
  const redactedEvent = redactProtectedText(publicPayloadFields(event));
  if (level === 1 && sensitiveStrategyDetails.length === 0) {
    return {
      level,
      category,
      disclosure_policy: "strategy detail classification lacked safe spans; directional fallback applied",
      directional_category: category,
      public_instruction:
        "The classifier did not provide safe redaction spans. Give only a broad directional category.",
    };
  }
  if (level === 1) {
    return {
      ...base,
      category,
      disclosure_policy: "only exact proprietary strategy or IP spans and protected names were redacted",
      public_instruction:
        "Protected names and exact strategy details have already been replaced. Summarize the remaining context and do not reconstruct redacted text.",
      redacted_entity_kinds: [...new Set(sensitiveEntities.map((entry) => safeText(entry?.kind, 40)).filter(Boolean))],
      redacted_strategy_detail_count: sensitiveStrategyDetails.length,
      event: redactedEvent,
    };
  }
  if (level === 2) {
    return {
      ...base,
      category,
      disclosure_policy: "specific client and investor names redacted; other packet details allowed",
      public_instruction:
        "Client and investor names have already been replaced. Summarize the remaining details and do not reconstruct or guess any redacted name.",
      redacted_entity_kinds: [...new Set(sensitiveEntities.map((entry) => safeText(entry?.kind, 40)).filter(Boolean))],
      event: redactedEvent,
    };
  }
  return {
    ...base,
    category,
    disclosure_policy: sensitiveEntities.length
      ? "specific client and investor names redacted; other packet details allowed"
      : "no client names, investor names, or exact proprietary strategy details identified",
    public_instruction: sensitiveEntities.length
      ? "Client and investor names have already been replaced. Do not reconstruct or guess them."
      : "Summarize the event normally without inventing private details.",
    event: redactedEvent,
  };
}

function formatEventForAnonymity(event = {}, sanitized = {}) {
  // The public hive handle is attribution, not disclosure: it is shown at every
  // anonymity level and never passed through the classifier or summarizer.
  const memberHandle = safeText(event.member?.handle, 80);
  if (clampInteger(sanitized.anonymity_level || sanitized.level, 3, 1, 3) !== 1) {
    return memberHandle ? { ...sanitized, member_handle: memberHandle } : sanitized;
  }
  return {
    ...sanitized,
    member_handle: memberHandle,
    tx_hash: event.txHash,
    cid: event.cid,
    task_id: event.taskId,
    action_kind: event.actionKind,
    occurred_at: event.occurredAt,
  };
}

async function readPrompt() {
  const currentFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(currentFile), "..");
  return fs.readFile(path.join(repoRoot, "prompts/non_production/deathmarch_local/deathmarch_summary_v1.md"), "utf8");
}

export async function callDeepSeekSummary({
  event,
  anonymity,
  classification = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const classified = classification || await classifyEventAnonymity({ event, env, fetchImpl });
  const level = effectiveAnonymityLevel({
    globalFloor: anonymity,
    classifiedLevel: classified.level,
  });
  const sanitized = sanitizeEventForAnonymity(event, level, classified);
  const formatEvent = formatEventForAnonymity(event, sanitized);
  const deterministicFallback = () => formatDeathmarchDiscordMessage({ summary: "", event: formatEvent });
  if (!inferenceConfigured(env)) {
    if (env.DEATHMARCH_DETERMINISTIC_FALLBACK !== "false") return deterministicFallback();
    throw new Error("inference_not_configured");
  }
  const prompt = await readPrompt();
  const requestBody = {
    model: (env.DEATHMARCH_INFERENCE_MODEL || env.DEATHMARCH_AMBIENT_MODEL) || DEFAULT_INFERENCE_MODEL,
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Write the Death March Discord update for this task event.",
          event: sanitized,
        }, null, 2),
      },
    ],
    temperature: 0.2,
  };
  if (safeText((env.DEATHMARCH_INFERENCE_MAX_TOKENS || env.DEATHMARCH_AMBIENT_MAX_TOKENS), 40)) {
    requestBody.max_tokens = clampInteger(
      (env.DEATHMARCH_INFERENCE_MAX_TOKENS || env.DEATHMARCH_AMBIENT_MAX_TOKENS),
      4000,
      128,
      12000
    );
  }
  let result;
  try {
    result = await inferenceChatCompletion({ env, fetchImpl, body: requestBody, capability: "reasoning_text", timeoutMs: clampInteger(
      (env.DEATHMARCH_INFERENCE_TIMEOUT_MS || env.DEATHMARCH_AMBIENT_TIMEOUT_MS),
      DEFAULT_INFERENCE_TIMEOUT_MS,
      1000,
      120000
    ) });
  } catch (error) {
    if (env.DEATHMARCH_DETERMINISTIC_FALLBACK !== "false") return deterministicFallback();
    throw error;
  }
  const content = safeText(result.text, 2000);
  if (!content) {
    const choice = safeObject(result.body?.choices?.[0]);
    const message = safeObject(choice.message);
    const detail = [
      choice.finish_reason ? `finish_reason=${safeText(choice.finish_reason, 80)}` : "",
      message.reasoning_content ? `reasoning_tokens_only=${safeText(message.reasoning_content, 10000).length}` : "",
    ].filter(Boolean).join(",");
    if (env.DEATHMARCH_DETERMINISTIC_FALLBACK !== "false") {
      return deterministicFallback();
    }
    throw new Error(`inference_error:empty_response${detail ? `:${detail}` : ""}`);
  }
  return formatDeathmarchDiscordMessage({ summary: content, event: formatEvent });
}

export async function postToDiscord({
  content,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const message = safeText(content, 1900);
  if (!message) throw new Error("discord_message_empty");
  const timeoutMs = clampInteger(
    env.DEATHMARCH_DISCORD_TIMEOUT_MS,
    DEFAULT_DISCORD_TIMEOUT_MS,
    1000,
    60000
  );
  const webhookUrl = safeText(env.DEATHMARCH_DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL, 2000);
  if (webhookUrl) {
    const response = await fetchWithTimeout(fetchImpl, webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: message,
        allowed_mentions: { parse: [] },
      }),
    }, timeoutMs, "discord_webhook_timeout");
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`discord_webhook_error:${response.status}:${safeText(text, 300)}`);
    }
    return { ok: true, transport: "webhook" };
  }

  const token = safeText(env.DISCORD_BOT_TOKEN || env.DEATHMARCH_DISCORD_BOT_TOKEN, 4000);
  const channelId = safeText(
    env.DEATHMARCH_DISCORD_CHANNEL_ID || env.DEATHMARCH_CHANNEL_ID || env.DISCORD_CHANNEL_ID,
    120
  );
  if (!token || !channelId) throw new Error("discord_destination_missing");
  const response = await fetchWithTimeout(fetchImpl, `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bot ${token}`,
    },
    body: JSON.stringify({
      content: message,
      allowed_mentions: { parse: [] },
    }),
  }, timeoutMs, "discord_bot_timeout");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`discord_bot_error:${response.status}:${safeText(text, 300)}`);
  }
  // Keep the Discord message id so posts can be audited per event.
  const messageId = await discordMessageId(response);
  return { ok: true, transport: "bot", channelId, ...(messageId ? { messageId } : {}) };
}

async function discordMessageId(response) {
  if (typeof response?.json !== "function") return "";
  try {
    const body = await response.json();
    return safeText(body?.id, 64);
  } catch {
    return "";
  }
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return {
      seen: safeObject(parsed.seen),
      updatedAt: safeText(parsed.updatedAt, 80),
    };
  } catch {
    return { seen: {}, updatedAt: "" };
  }
}

async function writeState(statePath, state) {
  await fs.writeFile(statePath, JSON.stringify({
    ...state,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

export async function processDeathmarchEvents({
  events,
  anonymity = 3,
  dryRun = false,
  statePath = DEFAULT_STATE_PATH,
  noState = false,
  markExisting = false,
  processLimit = 25,
  env = process.env,
  fetchImpl = fetch,
  stdout = console.log,
} = {}) {
  const state = noState ? { seen: {} } : await readState(statePath);
  const batchKeys = new Set();
  let candidates = events
    .filter(isDeathmarchTaskEvent)
    .filter((event) => noState || !state.seen[event.eventKey])
    // Duplicate delivery inside one batch (same event from two feeds or two
    // member polls) is still one Death March post.
    .filter((event) => {
      if (!event.eventKey || batchKeys.has(event.eventKey)) return false;
      batchKeys.add(event.eventKey);
      return true;
    });
  if (!markExisting) {
    candidates = candidates.slice(0, clampInteger(processLimit, 25, 1, 200));
  }
  const results = [];
  if (markExisting) {
    for (const event of candidates) {
      state.seen[event.eventKey] = {
        txHash: event.txHash,
        cid: event.cid,
        taskId: event.taskId,
        actionKind: event.actionKind,
        markedAt: new Date().toISOString(),
        discord: { ok: false, transport: "not_posted_mark_existing" },
      };
      results.push({ ok: true, marked: true, eventKey: event.eventKey });
    }
    if (!noState) await writeState(statePath, state);
    return { ok: true, checked: events.length, marked: results.length, posted: 0, results };
  }
  for (const event of candidates) {
    try {
      const classification = await classifyEventAnonymity({ event, env, fetchImpl });
      const summary = await callDeepSeekSummary({ event, anonymity, classification, env, fetchImpl });
      if (dryRun) {
        stdout(summary);
        results.push({ ok: true, dryRun: true, eventKey: event.eventKey, member: event.member?.handle || "", summary });
        continue;
      }
      const discord = await postToDiscord({ content: summary, env, fetchImpl });
      state.seen[event.eventKey] = {
        txHash: event.txHash,
        cid: event.cid,
        taskId: event.taskId,
        actionKind: event.actionKind,
        member: event.member?.handle || "",
        postedAt: new Date().toISOString(),
        discord,
      };
      if (!noState) await writeState(statePath, state);
      results.push({ ok: true, eventKey: event.eventKey, member: event.member?.handle || "", discord });
    } catch (error) {
      const failure = {
        ok: false,
        eventKey: event.eventKey,
        txHash: event.txHash,
        cid: event.cid,
        taskId: event.taskId,
        actionKind: event.actionKind,
        error: safeErrorCode(error),
      };
      if (dryRun) stdout(`deathmarch_event_error:${failure.error}`);
      results.push(failure);
    }
  }
  const failed = results.filter((result) => result.ok === false).length;
  const posted = results.filter((result) => result.ok === true && !result.dryRun).length;
  return { ok: failed === 0, checked: events.length, posted, failed, results };
}

async function runOnce(args) {
  const env = await deathmarchEnvWithSeedFile({
    seedFile: args.seedFile,
    explicitSeedFile: args.seedFileExplicit,
  });
  let members = null;
  if (!args.file) {
    const resolved = await resolveDeathmarchMembers({ wallet: args.wallet, env });
    members = resolved.members;
    for (const skipped of resolved.skipped) {
      console.error(`deathmarch_member_skipped:${safeText(skipped.accountId, 120)}:${safeText(skipped.reason, 80)}`);
    }
  }
  const events = await loadDeathmarchEvents({
    file: args.file,
    wallet: args.wallet,
    members,
    limit: args.limit,
    maxPages: args.maxPages,
    env,
  });
  return processDeathmarchEvents({
    events,
    anonymity: args.anonymity,
    dryRun: args.dryRun,
    statePath: args.statePath,
    noState: args.noState,
    markExisting: args.markExisting,
    processLimit: args.processLimit,
    env,
  });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.poll) {
    const intervalMs = clampInteger(args.intervalMs, 60000, 5000, 3_600_000);
    while (true) {
      try {
        const result = await runOnce(args);
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      } catch (error) {
        console.error(`deathmarch_error:${error?.message || error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  const result = await runOnce(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
