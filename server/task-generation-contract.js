import { collapseWhitespace, isIdentifierChar, isWhitespace } from "./inference-text.js";
import { createHash } from "node:crypto";
import { Wallet } from "xrpl";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { buildTaskgenReplayKey } from "./repositories/taskgen-replay-cache.js";
import { reviewTaskGenerationReadiness } from "./task-generation-readiness.js";
import { TASK_MIN_STEPS, normalizeTaskSteps } from "../shared/task-steps.js";
import {
  INFERENCE_MODELS,
  inferenceChatCompletion,
  resolveInferenceModel,
} from "./inference.js";

const TASKGEN_PERSONAL_PROMPT = {
  path: "task_engine/taskgen_personal_v1.md",
  version: "taskgen_personal_v1",
};
const TASKGEN_NETWORK_PROMPT = {
  path: "task_engine/taskgen_network_v1.md",
  version: "taskgen_network_v1",
};
const TASKGEN_NETWORK_V2_PROMPT = {
  path: "task_engine/taskgen_network_v2.md",
  version: "taskgen_network_v2",
};
const TASKGEN_REPLAY_ACCEPT_BY_MIN_FRESH_MS = 5 * 60 * 1000;
const TASKGEN_REPLAY_ACCEPT_BY_FALLBACK_MS = 24 * 60 * 60 * 1000;

const taskgenResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "taskgen_output",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        schema: { type: "string", enum: ["pf.taskgen.output.v1"] },
        title: { type: "string", minLength: 5, maxLength: 240 },
        description: { type: "string", minLength: 20, maxLength: 8000 },
        task_kind: { type: "string", enum: ["personal", "network", "alpha"] },
        steps: { type: "array", minItems: TASK_MIN_STEPS, items: { type: "string" } },
        submission_requirement: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["text", "url", "github_commit", "screenshot", "file", "mixed"] },
            criteria: { type: "string", minLength: 20, maxLength: 4000 },
          },
          required: ["type", "criteria"],
        },
        verification_policy: {
          type: "object",
          additionalProperties: false,
          properties: {
            followup_required: { type: "boolean" },
            mode: { type: "string" },
            verification_type: {
              type: "string",
              enum: ["text", "url", "github_commit", "screenshot", "file", "mixed"],
            },
          },
          required: ["followup_required", "mode", "verification_type"],
        },
        reward_offer: {
          type: "object",
          additionalProperties: false,
          properties: { amount_estimate_pft: { type: "string" } },
          required: ["amount_estimate_pft"],
        },
        deadline: {
          type: "object",
          additionalProperties: false,
          properties: {
            accept_by: { type: "string" },
            deadline_at: { type: ["string", "null"] },
          },
          required: ["accept_by", "deadline_at"],
        },
      },
      required: [
        "schema",
        "title",
        "description",
        "task_kind",
        "steps",
        "submission_requirement",
        "verification_policy",
        "reward_offer",
        "deadline",
      ],
    },
  },
};

export function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value, fallback, { min = 1, max = 1_200_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function taskGenerationProviderTimeoutMs(env = process.env) {
  return positiveInteger(env.TASKNODE_TASK_GENERATION_PROVIDER_TIMEOUT_MS, 240_000, {
    min: 5_000,
    max: 20 * 60 * 1000,
  });
}

function taskInputIsNetwork(taskInput = {}) {
  const networkTask = safeObject(taskInput.network_task);
  const policy = safeObject(taskInput.policy);
  const request = safeObject(taskInput.request);
  const taskClass = safeText(policy.task_class ?? policy.taskClass ?? request.requestedTaskKind ?? request.requested_task_kind, 80).toLowerCase();
  return objectKeyCount(networkTask) > 0 || taskClass === "network" || taskClass === "alpha";
}

export function networkTaskGenerationV2Enabled(env = process.env) {
  return env.TASKNODE_NETWORK_TASK_GENERATION_V2_ENABLED === "true" ||
    env.TASKNODE_HIVE_TASK_GENERATION_V2_ENABLED === "true";
}

function objectValue(source = {}, keys = []) {
  const object = safeObject(source);
  for (const key of keys) {
    if (Object.hasOwn(object, key)) return { present: true, value: object[key] };
  }
  return { present: false, value: undefined };
}

export function objectKeyCount(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

export function taskgenPromptForInput(taskInput = {}) {
  if (taskInputIsNetwork(taskInput)) {
    if (networkTaskGenerationV2Enabled()) return TASKGEN_NETWORK_V2_PROMPT;
    return TASKGEN_NETWORK_PROMPT;
  }
  return TASKGEN_PERSONAL_PROMPT;
}

export function taskgenProviderForInput(_taskInput = {}, env = process.env) {
  if (env.TASKNODE_TASKGEN_PROVIDER_MOCK === "true") return "mock";
  return "vercel";
}

export function taskgenModelForInput(taskInput = {}, env = process.env) {
  if (env.TASKNODE_TASKGEN_PROVIDER_MOCK === "true") return "mock-taskgen";
  let requestedModel = "";
  if (taskInputIsNetwork(taskInput) && networkTaskGenerationV2Enabled(env)) {
    requestedModel = safeText(
      env.TASKNODE_NETWORK_TASKGEN_MODEL ||
        env.TASKNODE_HIVE_TASK_GENERATION_MODEL ||
        env.TASKNODE_TASKGEN_MODEL ||
        INFERENCE_MODELS.structured,
      160
    );
  } else {
    requestedModel = safeText(env.TASKNODE_TASKGEN_MODEL || INFERENCE_MODELS.structured, 160);
  }
  return resolveInferenceModel({
    model: requestedModel,
    capability: "strict_json",
    env,
  });
}

export function taskgenReasoningEffort(taskInput = {}, env = process.env) {
  if (taskInputIsNetwork(taskInput) && networkTaskGenerationV2Enabled(env)) {
    return safeText(
      env.TASKNODE_NETWORK_TASKGEN_REASONING_EFFORT ||
        env.TASKNODE_HIVE_TASK_GENERATION_REASONING_EFFORT ||
        env.TASKNODE_TASKGEN_REASONING_EFFORT ||
        "xhigh",
      40
    );
  }
  return safeText(env.TASKNODE_TASKGEN_REASONING_EFFORT || "xhigh", 40);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function taskAuthoritySeed(env = process.env) {
  return safeText(
    env.TASKNODE_AUTHORITY_SEED ||
      env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      ""
  );
}

export function taskAuthorityWallet(env = process.env) {
  const seed = taskAuthoritySeed(env);
  if (!seed) throw new Error("task_authority_seed_missing");
  return Wallet.fromSeed(seed);
}

function recentMessages(bundle = {}) {
  const conversations = Array.isArray(bundle.recent_chat?.conversations)
    ? bundle.recent_chat.conversations
    : [];
  return conversations.flatMap((conversation) => {
    return (Array.isArray(conversation.messages) ? conversation.messages : []).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: safeText(message.content || message.body || "", 800),
      created_at: message.created_at || null,
    }));
  }).filter((message) => message.content).slice(-8);
}

function relevantHistorySummary(bundle = {}) {
  const items = Array.isArray(bundle.relevant_history?.items) ? bundle.relevant_history.items : [];
  return safeText(
    items
      .slice(0, 8)
      .map((item) => safeText(item?.summary, 500))
      .filter(Boolean)
      .join("; "),
    4_000
  );
}

function projectedMemoryEntries(entries = [], limit = 0) {
  return safeArray(entries)
    .slice(-limit)
    .map((entry) => ({
      kind: safeText(entry?.kind, 80),
      digest: safeText(entry?.digest, 180),
      conversation_title: safeText(entry?.conversation_title, 240),
      memory_text: safeText(entry?.memory_text, 1_200),
      created_at: entry?.created_at || null,
    }))
    .filter((entry) => entry.memory_text);
}

function projectedTaskQueue(queue = {}) {
  const source = safeObject(queue);
  const taskItems = (value) => safeArray(value).slice(0, 6).map((item) => ({
    task_id: safeText(item?.task_id, 180),
    title: safeText(item?.title, 240),
    status: safeText(item?.status, 80),
    reward_pft: item?.reward_pft ?? null,
    updated_at: item?.updated_at || null,
  }));
  return {
    outstanding: taskItems(source.outstanding),
    verification: taskItems(source.verification),
    refused: taskItems(source.refused),
    rewarded: taskItems(source.rewarded),
    summary: safeText(source.summary, 1_000),
  };
}

export function projectTaskgenInput(bundle = {}, { bundleCid = "", bundleDigest = "" } = {}) {
  const contextDoc = safeObject(bundle.context?.primary_context_doc);
  const networkTask = safeObject(bundle.network_task);
  const taskLineage = safeObject(networkTask.task_lineage);
  return {
    schema: "pf.taskgen.input.v1",
    request_bundle: {
      bundle_id: bundle.bundle_id || "",
      cid: bundleCid,
      digest: bundleDigest,
    },
    request: safeObject(bundle.request),
    context: {
      context_cid: contextDoc.cid || null,
      context_digest: contextDoc.digest || "",
      summary: safeText(contextDoc.summary, 3_000),
    },
    chat: {
      recent_chat_summary: safeText(bundle.recent_chat?.summary, 2_400),
      relevant_history_summary: relevantHistorySummary(bundle),
      recent_messages: recentMessages(bundle),
      summary: safeText(bundle.recent_chat?.summary, 2_400),
    },
    memory: {
      deep_memory: projectedMemoryEntries(bundle.memory?.deep_memory, 3),
      recent_memory: projectedMemoryEntries(bundle.memory?.recent_memory, 4),
    },
    task_queue: projectedTaskQueue(bundle.task_queue),
    network_task: bundle.network_task || null,
    hive_policy: {
      operator_standing_policy: safeArray(networkTask.operator_standing_policy),
      generation_quality_policy: safeObject(networkTask.generation_quality_policy),
    },
    prior_output_corpus: networkTask.prior_output_corpus || {},
    task_lineage: taskLineage,
    operator_transparency: {
      task_work_type: safeText(networkTask.task_work_type, 80),
      referenced_outputs: safeArray(taskLineage.referenced_outputs),
      deduped_against: safeArray(taskLineage.deduped_against),
      escalation_stage: safeText(networkTask.escalation_stage, 120),
    },
    wallet: bundle.wallet || {},
    policy: bundle.policy || {},
  };
}

function parseJsonObject(text = "") {
  try { return JSON.parse(String(text || "").trim()); }
  catch { throw new Error("taskgen_output_json_invalid"); }
}

function normalizeReward(value, policy = {}) {
  const min = Number(policy.reward_offer_min_pft ?? policy.rewardOfferMinPft ?? 0.5);
  const max = Number(policy.reward_offer_max_pft ?? policy.rewardOfferMaxPft ?? 5);
  const safeMin = Number.isFinite(min) ? Math.max(0.5, min) : 0.5;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : Math.max(safeMin, 5);
  const fallback = safeMax > 5 ? safeMin : 3.2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < safeMin || parsed > safeMax) return fallback.toFixed(2);
  return parsed.toFixed(2);
}

function normalizeDeadlineTimestamp(value, { fallbackMs = null } = {}) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const text = safeText(value, 80);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (Number.isFinite(fallbackMs)) return new Date(Date.now() + fallbackMs).toISOString();
  return null;
}

function policyDeadlineValue(policy = {}, field = "accept_by") {
  const keys = field === "deadline_at" ? ["deadline_at", "deadlineAt"] : ["accept_by", "acceptBy"];
  const nested = objectValue(safeObject(policy).deadline, keys);
  if (nested.present) return nested;
  return objectValue(policy, keys);
}

function normalizeTaskKind(value = "", policy = {}) {
  const policyTaskClass = safeText(policy.task_class ?? policy.taskClass, 80).toLowerCase();
  if (policyTaskClass === "network" || policyTaskClass === "alpha") return policyTaskClass;
  const normalized = safeText(value, 80).toLowerCase();
  if (normalized === "network" || normalized === "alpha") return normalized;
  return "personal";
}

export function validateTaskgenOutput(output = {}, policy = {}) {
  const outputText = (value, minimum, maximum) => typeof value === "string" && value.trim().length >= minimum && value.trim().length <= maximum;
  const required = ["title", "description", "task_kind", "submission_requirement", "verification_policy", "reward_offer", "deadline"];
  const missing = required.filter((key) => output[key] === undefined || output[key] === null);
  if (missing.length) throw new Error(`taskgen_output_missing:${missing.join(",")}`);
  if (output.schema !== "pf.taskgen.output.v1") throw new Error("taskgen_output_schema_invalid");
  if (!outputText(output.title, 5, 240) || !outputText(output.description, 20, 8000)) throw new Error("taskgen_description_invalid");
  const requirement = safeObject(output.submission_requirement);
  const evidenceTypes = ["text", "url", "github_commit", "screenshot", "file", "mixed"];
  if (!evidenceTypes.includes(requirement.type) || !outputText(requirement.criteria, 20, 4000)) throw new Error("taskgen_submission_requirement_invalid");
  const verification = safeObject(output.verification_policy);
  if (!evidenceTypes.includes(verification.verification_type) || !outputText(verification.mode, 1, 120) || typeof verification.followup_required !== "boolean") throw new Error("taskgen_verification_policy_invalid");
  // Clamp, never reject: a thorough model output must not burn a generation.
  const steps = normalizeTaskSteps(output.steps, { clean: safeText });
  if (steps.length < TASK_MIN_STEPS) throw new Error("taskgen_steps_invalid");
  const reward = safeObject(output.reward_offer);
  const policyAcceptBy = policyDeadlineValue(policy, "accept_by");
  const policyDeadlineAt = policyDeadlineValue(policy, "deadline_at");
  const normalizedPolicyAcceptBy = policyAcceptBy.present ? normalizeDeadlineTimestamp(policyAcceptBy.value) : null;
  const normalizedPolicyDeadlineAt = policyDeadlineAt.present ? normalizeDeadlineTimestamp(policyDeadlineAt.value) : null;
  const normalizedOutputDeadlineAt = normalizeDeadlineTimestamp(output.deadline?.deadline_at);
  const normalized = {
    ...output,
    title: safeText(output.title, 240),
    description: safeText(output.description, 8000),
    task_kind: normalizeTaskKind(output.task_kind, policy),
    steps,
    submission_requirement: {
      type: safeText(requirement.type, 80),
      criteria: safeText(requirement.criteria, 4000),
    },
    verification_policy: {
      followup_required: Boolean(verification.followup_required),
      mode: safeText(verification.mode, 120),
      verification_type: safeText(verification.verification_type, 80),
    },
    reward_offer: {
      amount_estimate_pft: normalizeReward(reward.amount_estimate_pft, policy),
    },
    deadline: {
      // Tasks never die by clock. An accept-by stamp appears only when the
      // routing policy explicitly requested a window (accept_window_hours > 0
      // upstream); the model cannot invent one and there is no default.
      accept_by: normalizedPolicyAcceptBy || null,
      deadline_at: policyDeadlineAt.present ? normalizedPolicyDeadlineAt : normalizedOutputDeadlineAt,
    },
  };
  return normalized;
}

export function taskgenReplayIdentity({
  taskInput = {},
  request = {},
  requestBundle = {},
  requestBundleCid = "",
  requestBundleDigest = "",
} = {}) {
  const taskgenPrompt = taskgenPromptForInput(taskInput);
  const systemPrompt = loadPrompt(taskgenPrompt.path);
  const policy = safeObject(taskInput.policy);
  const networkTask = safeObject(taskInput.network_task);
  const requestObject = safeObject(taskInput.request);
  const model = taskgenModelForInput(taskInput);
  const taskClass = safeText(
    policy.task_class ??
      policy.taskClass ??
      networkTask.task_class ??
      networkTask.taskClass ??
      requestObject.requestedTaskKind ??
      requestObject.requested_task_kind ??
      request.requestedTaskKind ??
      request.requested_task_kind ??
      "personal",
    80
  ).toLowerCase() || "personal";
  const identity = {
    schema: "pf.taskgen.replay_identity.v1",
    request_id: safeText(request.requestId || request.request_id || requestObject.request_id, 180),
    request_bundle_cid: safeText(requestBundleCid || request.requestBundleCid || request.request_bundle_cid, 240),
    request_bundle_digest: safeText(requestBundleDigest, 180),
    source_payload_digest: safeText(networkTask.source_payload_digest || networkTask.sourcePayloadDigest, 180),
    input_packet_digest: sha256(taskInput),
    prompt_version: taskgenPrompt.version,
    prompt_path: taskgenPrompt.path,
    prompt_digest: promptDigest(systemPrompt),
    model,
    task_class: taskClass,
    reward_policy_version: safeText(policy.reward_policy_version || policy.rewardPolicyVersion, 120),
    deadline_policy_version: safeText(
      policy.deadline_policy_version ||
        policy.deadlinePolicyVersion ||
        policy.task_policy_version ||
        policy.taskPolicyVersion ||
        "",
      120
    ),
    generation_policy_version: safeText(policy.generation_policy_version || policy.generationPolicyVersion, 120),
    bundle_id: safeText(requestBundle.bundle_id || request.bundleId || request.bundle_id, 180),
  };
  return {
    ...identity,
    replay_key: buildTaskgenReplayKey(identity),
  };
}

export function taskgenFromReplay(replay = {}, identity = {}) {
  return {
    output: safeObject(replay.taskgenOutput),
    metadata: {
      ...safeObject(replay.taskgenMetadata),
      replayed: true,
      replay_key: replay.replayKey || identity.replay_key || "",
      replay_status: replay.status || "",
      input_packet_digest: replay.inputPacketDigest || identity.input_packet_digest || "",
      prompt_version: replay.promptVersion || identity.prompt_version || "",
      prompt_digest: replay.promptDigest || identity.prompt_digest || "",
      model: replay.model || identity.model || "",
    },
  };
}

export function refreshTaskgenReplayDeadlineForPublish(taskgen = {}, policy = {}, { nowMs = Date.now() } = {}) {
  const normalizedOutput = validateTaskgenOutput(safeObject(taskgen.output), policy);
  const acceptByMs = Date.parse(normalizedOutput.deadline?.accept_by || "");
  const deadlineAtText = safeText(normalizedOutput.deadline?.deadline_at, 80);
  const deadlineAtMs = Date.parse(deadlineAtText);
  const minFreshMs = Number(nowMs) + TASKGEN_REPLAY_ACCEPT_BY_MIN_FRESH_MS;
  const hasAcceptBy = Boolean(normalizedOutput.deadline?.accept_by);
  const acceptByStale = hasAcceptBy && (!Number.isFinite(acceptByMs) || acceptByMs <= minFreshMs);
  const deadlineAtStale = Boolean(deadlineAtText) && (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= minFreshMs);
  if (!acceptByStale && !deadlineAtStale) {
    return {
      taskgen: {
        ...taskgen,
        output: normalizedOutput,
      },
      refreshed: false,
      staleAcceptBy: "",
    };
  }

  const refreshedAcceptBy = acceptByStale
    ? new Date(Number(nowMs) + TASKGEN_REPLAY_ACCEPT_BY_FALLBACK_MS).toISOString()
    : normalizedOutput.deadline.accept_by;
  const refreshedAcceptByMs = Date.parse(refreshedAcceptBy || "");
  const refreshedDeadlineAt = deadlineAtText && Number.isFinite(deadlineAtMs) && (!Number.isFinite(refreshedAcceptByMs) || deadlineAtMs > refreshedAcceptByMs)
    ? normalizedOutput.deadline.deadline_at
    : null;
  const refreshedOutput = {
    ...normalizedOutput,
    deadline: {
      ...normalizedOutput.deadline,
      accept_by: refreshedAcceptBy,
      deadline_at: refreshedDeadlineAt,
    },
  };
  return {
    taskgen: {
      ...taskgen,
      output: refreshedOutput,
      metadata: {
        ...safeObject(taskgen.metadata),
        output_digest: sha256(refreshedOutput),
        replay_deadline_refreshed: true,
        replay_deadline_refreshed_at: new Date(Number(nowMs)).toISOString(),
        replay_deadline_stale_accept_by: acceptByStale ? safeText(normalizedOutput.deadline?.accept_by, 80) : "",
        replay_deadline_stale_deadline_at: deadlineAtStale ? deadlineAtText : "",
      },
    },
    refreshed: true,
    staleAcceptBy: acceptByStale ? safeText(normalizedOutput.deadline?.accept_by, 80) : "",
  };
}

export function offerFromReplay(replay = {}) {
  return {
    taskId: replay.taskId || "",
    subjectWallet: replay.subjectWallet || "",
    offerPayload: safeObject(replay.offerPayload),
    offerCid: replay.offerCid || "",
    offerDigest: replay.offerDigest || "",
    txHash: replay.offerTxHash || "",
    ledgerIndex: null,
    engineResult: "replayed",
    replayed: true,
  };
}

export function taskgenApiConfig(taskInput = {}, env = process.env) {
  const provider = taskgenProviderForInput(taskInput, env);
  if (provider === "mock") {
    return {
      provider,
      model: "mock-taskgen",
      baseUrl: "",
      apiKey: "mock",
      headers: {},
    };
  }
  return {
    provider,
    model: taskgenModelForInput(taskInput, env),
    reasoningEffort: taskgenReasoningEffort(taskInput, env),
  };
}

function discordProofCriteriaSuffix(taskInput = {}) {
  return taskInputIsNetwork(taskInput)
    ? " Include Discord announcement proof as a message link/id or screenshot from an approved Post Fiat channel."
    : "";
}

function mockTaskgenOutput(taskInput = {}) {
  const networkTask = safeObject(taskInput.network_task);
  const policy = safeObject(taskInput.policy);
  const taskKind = normalizeTaskKind(networkTask.task_class || policy.task_class || "personal", policy);
  const reward = normalizeReward(networkTask.reward_band_pft?.min || policy.reward_offer_min_pft || "3.20", policy);
  const titleBase = safeText(networkTask.action_output || networkTask.project_need_summary || taskInput.request?.requestText || "Prepare Task Evidence", 80);
  return validateTaskgenOutput({
    schema: "pf.taskgen.output.v1",
    title: safeText(collapseWhitespace([...titleBase].map((char) => isIdentifierChar(char) || isWhitespace(char) ? char : " ").join("")) || "Prepare Task Evidence", 72),
    description: safeText(
      [
        networkTask.project_title ? `This task supports ${networkTask.project_title}.` : "This task supports the selected Task Node project.",
        safeText(networkTask.project_need_summary || taskInput.request?.requestText || "Prepare a concrete artifact and evidence packet.", 500),
      ].join(" "),
      900
    ),
    task_kind: taskKind,
    steps: [
      "Review the project need and any referenced source material.",
      "Create the requested artifact or evidence packet.",
      "Submit the artifact with enough proof for a reviewer to verify it.",
    ],
    submission_requirement: {
      type: taskInputIsNetwork(taskInput) ? "mixed" : "text",
      criteria: `Submit the completed artifact plus a concise note explaining what changed.${discordProofCriteriaSuffix(taskInput)}`,
    },
    verification_policy: {
      followup_required: taskInputIsNetwork(taskInput),
      mode: "standard_followup",
      verification_type: taskInputIsNetwork(taskInput) ? "mixed" : "text",
    },
    reward_offer: {
      amount_estimate_pft: reward,
    },
    deadline: {
      accept_by: normalizeDeadlineTimestamp(null, { fallbackMs: 24 * 60 * 60 * 1000 }),
      deadline_at: null,
    },
  }, policy);
}

export async function generateTaskWithProvider(taskInput, {
  fetchImpl = fetch,
  providerTimeoutMs = taskGenerationProviderTimeoutMs(),
} = {}) {
  const taskgenPrompt = taskgenPromptForInput(taskInput);
  const systemPrompt = loadPrompt(taskgenPrompt.path);
  const apiConfig = taskgenApiConfig(taskInput);
  const model = apiConfig.model;
  const startedAt = Date.now();
  const baseInstruction = `Generate a minimal Task Node task from this input packet. Return JSON matching schema pf.taskgen.output.v1.\n\n${stableJson(taskInput)}`;
  if (apiConfig.provider === "mock") {
    const output = mockTaskgenOutput(taskInput);
    return {
      output,
      metadata: {
        provider: "mock",
        model,
        prompt_version: taskgenPrompt.version,
        prompt_path: taskgenPrompt.path,
        prompt_digest: promptDigest(systemPrompt),
        input_packet_digest: sha256(taskInput),
        output_digest: sha256(output),
        latency_ms: Date.now() - startedAt,
        parse_status: "ok",
        validation_attempts: 1,
      },
    };
  }
  let completion;
  try {
    completion = await inferenceChatCompletion({
      fetchImpl,
      capability: "strict_json",
      timeoutMs: providerTimeoutMs,
      totalTimeoutMs: Math.max(1000, Number(process.env.TASKNODE_TASK_GENERATION_TOTAL_TIMEOUT_MS) || 540_000),
      body: {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: baseInstruction },
        ],
        response_format: taskgenResponseFormat,
        max_tokens: Math.max(32768, Number(process.env.TASKNODE_TASK_GENERATION_MAX_OUTPUT_TOKENS) || 65536),
        reasoning: { effort: apiConfig.reasoningEffort },
      },
    });
  } catch (error) {
    if (error?.code === "inference_timeout") {
      throw Object.assign(new Error("taskgen_provider_timeout"), { code: "TASKGEN_PROVIDER_TIMEOUT", timeoutMs: providerTimeoutMs });
    }
    if (error?.code === "inference_response_truncated") {
      throw Object.assign(new Error("taskgen_provider_output_invalid"), { code: "TASKGEN_PROVIDER_OUTPUT_INVALID", validationError: "taskgen_output_truncated" });
    }
    throw error;
  }
  const body = completion.body;
  let output;
  try {
    if (body?.choices?.[0]?.finish_reason === "length") throw new Error("taskgen_output_truncated");
    output = validateTaskgenOutput(parseJsonObject(body?.choices?.[0]?.message?.content || ""), taskInput.policy || {});
  } catch (error) {
    throw Object.assign(new Error("taskgen_provider_output_invalid"), { code: "TASKGEN_PROVIDER_OUTPUT_INVALID", validationError: error.message });
  }
  const readiness = await reviewTaskGenerationReadiness(output, { fetchImpl });
  return {
    output,
    metadata: {
      provider: completion.provider,
      model: completion.model,
      prompt_version: taskgenPrompt.version,
      prompt_path: taskgenPrompt.path,
      prompt_digest: promptDigest(systemPrompt),
      input_packet_digest: sha256(taskInput),
      output_digest: sha256(output),
      latency_ms: Date.now() - startedAt,
      parse_status: "ok",
      provider_response_id: body.id || "",
      validation_attempts: 1,
      readiness,
    },
  };
}
