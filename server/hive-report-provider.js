import { renderTextTemplate, limitNewlines, extractHttpLinks } from "./inference-text.js";
import { inferenceProviderForResponse } from "./inference.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hiveReportTypes } from "./repositories/hive-reports.js";
import { inferenceConfigured, inferenceFetchCompatibility } from "./inference.js";

const defaultReportModel = "zai/glm-5.3";

const reportPromptFiles = Object.freeze({
  system: "prompts/hive/reports/hive_report_writer_system_v1.md",
  common: "prompts/hive/reports/hive_report_common_v1.md",
  phaseInitial: "prompts/hive/reports/phase_initial_v1.md",
  phaseFinal: "prompts/hive/reports/phase_final_v1.md",
  userMessage: "prompts/hive/reports/user_message_v1.md",
  initialReportSection: "prompts/hive/reports/initial_report_section_v1.md",
  verifierSummarySection: "prompts/hive/reports/verifier_summary_section_v1.md",
  byType: {
    rewarded_task: "prompts/hive/reports/rewarded_task_v1.md",
    operative: "prompts/hive/reports/operative_v1.md",
    kol: "prompts/hive/reports/kol_v1.md",
    development: "prompts/hive/reports/development_v1.md",
    qa: "prompts/hive/reports/qa_v1.md",
    executive: "prompts/hive/reports/executive_v1.md",
    hive_intelligence: "prompts/hive/reports/hive_intelligence_v1.md",
    board_manager_planning: "prompts/hive/reports/board_manager_planning_v1.md",
  },
});

const reportPromptCache = new Map();

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function hiveReportModel() {
  return safeText(process.env.TASKNODE_HIVE_REPORT_MODEL || process.env.TASKNODE_BOARD_MANAGER_MODEL || defaultReportModel, 160);
}

function hiveReportReasoningEffort(type = "") {
  if (type === "hive_intelligence") {
    return safeText(process.env.TASKNODE_HIVE_INTELLIGENCE_REPORT_REASONING_EFFORT || "xhigh", 40);
  }
  if (type === "board_manager_planning") {
    return safeText(process.env.TASKNODE_BOARD_MANAGER_PLANNING_REPORT_REASONING_EFFORT || "high", 40);
  }
  return safeText(process.env.TASKNODE_HIVE_REPORT_REASONING_EFFORT || "high", 40);
}

function providerTimeoutMs() {
  return Math.max(30000, Number(process.env.TASKNODE_HIVE_REPORT_PROVIDER_TIMEOUT_MS || 240000));
}

function hiveReportMaxTokens(type = "") {
  const parsedGlobalMax = Number(process.env.TASKNODE_HIVE_REPORT_MAX_TOKENS || 0);
  const globalMax = Number.isFinite(parsedGlobalMax) ? parsedGlobalMax : 0;
  // Reasoning tokens count against max_tokens; 10K truncated every run once
  // the xhigh-thinking report grew past ~8K of output (2026-09-23).
  if (type === "hive_intelligence") {
    return Math.max(24000, Number(globalMax || 24000));
  }
  if (type === "board_manager_planning") {
    return Math.max(
      14000,
      Number(process.env.TASKNODE_BOARD_MANAGER_PLANNING_REPORT_MAX_TOKENS || globalMax || 14000)
    );
  }
  return Math.max(3000, Number(globalMax || 9000));
}

export function hiveReportsProviderConfigured() {
  return process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true" || inferenceConfigured();
}

function promptDigest(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function readReportPromptFile(relativePath = "") {
  const promptPath = safeText(relativePath, 240);
  if (!promptPath) return "";
  if (reportPromptCache.has(promptPath)) return reportPromptCache.get(promptPath);
  const body = readFileSync(new URL(`../${promptPath}`, import.meta.url), "utf8").trim();
  reportPromptCache.set(promptPath, body);
  return body;
}

function renderPromptTemplate(template = "", values = {}) { return renderTextTemplate(template, values); }

function markdownBody(value = "") {
  const body = safeText(value, 250_000);
  if (!body) throw new Error("hive_report_provider_empty_markdown");
  const first = body.trimStart().slice(0, 1);
  if (first === "{" || first === "[") throw new Error("hive_report_provider_json_blob_rejected");
  return body;
}

function cleanUserFacingReportMarkdown(value = "") {
    const body = safeText(value, 250_000);
    const metadataLabels = new Set(["generated", "model", "source packet", "source packet digest", "source run", "source run id"]);
    const cleaned = body.split("\n").filter((line) => {
      const colon = line.indexOf(":");
      const label = line.slice(0, colon).split("**").join("").trim().toLowerCase();
      return colon < 0 || !metadataLabels.has(label);
    }).join("\n");
    return limitNewlines(cleaned, 2).trim() || body;
  }

function compactJson(value, maxLength = 70_000, space = 2) {
  const text = JSON.stringify(value, null, space);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.72))}\n\n[...middle truncated for report prompt...]\n\n${text.slice(-Math.floor(maxLength * 0.28))}`;
}

function reportInstructions(type = "", phase = "initial") {
  const definition = hiveReportTypes[type] || {};
  const common = renderPromptTemplate(readReportPromptFile(reportPromptFiles.common), {
    report_label: definition.label || type,
    report_type: type,
    report_purpose: definition.summary || "Hive operating report.",
  });
  const typeInstructions = readReportPromptFile(reportPromptFiles.byType[type] || "");
  const phaseInstructions = readReportPromptFile(phase === "final" ? reportPromptFiles.phaseFinal : reportPromptFiles.phaseInitial);
  return [common, typeInstructions, phaseInstructions].filter(Boolean).join("\n");
}

function reportMessages({ type = "", sourcePacket = {}, phase = "initial", initialMarkdown = "", verifierSummary = "" } = {}) {
  const system = readReportPromptFile(reportPromptFiles.system);
  const user = limitNewlines(renderPromptTemplate(readReportPromptFile(reportPromptFiles.userMessage), {
    instructions: reportInstructions(type, phase),
    initial_report_section: initialMarkdown
      ? renderPromptTemplate(readReportPromptFile(reportPromptFiles.initialReportSection), { initial_markdown: initialMarkdown })
      : "",
    verifier_summary_section: verifierSummary
      ? renderPromptTemplate(readReportPromptFile(reportPromptFiles.verifierSummarySection), { verifier_summary: verifierSummary })
      : "",
    source_packet_json: compactJson(
      sourcePacket,
      ["hive_intelligence", "board_manager_planning"].includes(type) ? 180_000 : 70_000,
      type === "board_manager_planning" ? 0 : 2
    ),
  }), 2).trim();
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function openRouterUsage(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

function mockMarkdownReport({ type = "", sourcePacket = {}, phase = "initial", verifierSummary = "" } = {}) {
  if (type === "hive_intelligence") {
    const counts = safeObject(sourcePacket.sourceCounts);
    return markdownBody([
      "# Hive Intelligence Report",
      "",
      "## A] Classification",
      "Public, Hive Mind",
      "",
      "## B] Title And Key Question",
      "Title: PFT Network Value From Current Hive Work",
      "",
      "Key Question: Are current rewards, operators, and board tactics likely to increase the value of PFT?",
      "",
      "## C] BLUF / Key Judgments",
      `- The intelligence pipeline is live and has ${counts.upstreamReportCount || 0} upstream reports available. Confidence: High; this is almost certainly true because the source packet contains the generated report inventory. Uncertainty: mock mode does not evaluate live report quality.`,
      "- Reward routing should be judged by whether it creates product capability, community growth, or useful economic outcomes for PFT. Confidence: Moderate; this is likely the correct north star because it follows the stated network premise. Uncertainty: mock mode cannot price downstream market impact.",
      "",
      "## D] Scope / Note / Context",
      "This mock intelligence brief validates the Hive Intelligence Report pipeline from upstream Hive reports, Harvest Report, Live Task Packet, and Board Secretary memos.",
      "",
      "## E] Discussion / Analysis",
      "Confirmed fact: the source packet assembled the upstream reports and generated a Markdown brief. Analytic estimate: future production reports should focus on whether PFT rewards are producing value-accretive outputs. Alternative hypothesis: more task volume alone could matter, but that is weaker unless the tasks create visible product, community, or economic utility.",
      "",
      "## F] Implications / Outlook",
      "Watch whether rewarded work maps to shipped product improvements, useful network growth, and operator accountability. The Board Manager action space should prioritize task deployment, targeted messages, and founder recommendations that tighten reward-value alignment.",
      verifierSummary ? ["", "## Verification", verifierSummary].join("\n") : "",
    ].filter(Boolean).join("\n"));
  }
  if (type === "board_manager_planning") {
    const counts = safeObject(sourcePacket.sourceCounts);
    return markdownBody([
      "# Board Manager Planning Report",
      "",
      "## BLUF",
      `- The planning packet is live with ${counts.activeBoardCount || 0} active boards, ${counts.outstandingNetworkTaskCount || 0} outstanding Network Tasks, and ${counts.pendingGenerationJobCount || 0} pending generation jobs.`,
      "- This mock report validates the advisory Board Manager Planning Report path. It does not execute ADD_BOARD, ARCHIVE_BOARD, or UNARCHIVE_BOARD actions.",
      "",
      "## Current Board Portfolio",
      `- Active boards: ${counts.activeBoardCount || 0}`,
      `- Archived boards indexed: ${counts.archivedBoardIndexCount || 0}`,
      `- Board comments in packet: ${counts.boardCommentCount || 0}`,
      `- Project Leader context rows: ${counts.projectLeaderContextCount || 0}`,
      "",
      "## Board Ranking",
      "- Mock mode does not score real board quality. Production reports rank each board by outcome clarity, KPI believability, budget effectiveness, upside/downside, and sequencing feasibility.",
      "",
      "## Recommended Actions",
      "### ADD_BOARD",
      "- No action recommended.",
      "",
      "### ARCHIVE_BOARD",
      "- No action recommended.",
      "",
      "### UNARCHIVE_BOARD",
      "- No action recommended.",
      "",
      "## Reasoning",
      "Confirmed fact: the source packet assembled Hive Intelligence, live board state, live task state, board comments, Project Leader context, Live Task Packet contributor context, and archived-board index data. Analytic estimate: the production report should recommend board changes only when that evidence supports a PFT-value improving portfolio decision.",
      "",
      "## What The Task Management Agent Should Know",
      "- Treat this report as advisory portfolio context. Any later executor must re-read live board state and re-check add/archive/unarchive guardrails before mutating anything.",
      verifierSummary ? ["", "## Verification", verifierSummary].join("\n") : "",
    ].filter(Boolean).join("\n"));
  }
  const label = hiveReportTypes[type]?.label || type;
  const counts = safeObject(sourcePacket.sourceCounts);
  const generatedAt = safeText(sourcePacket.generatedAt, 80) || new Date().toISOString();
  const roleLines = Object.entries(safeObject(sourcePacket.roles?.byRole))
    .map(([role, rows]) => `- ${role}: ${safeArray(rows).length} verified operators`)
    .join("\n");
  return markdownBody([
    `# ${label} Report`,
    "",
    `Generated: ${generatedAt}`,
    `Phase: ${phase}`,
    "",
    "## Snapshot",
    `- Verified role accounts: ${counts.roleAccountCount || 0}`,
    `- Dynamic projects in scope: ${counts.projectCount || 0}`,
    `- Rewarded Network Tasks in packet: ${counts.rewardedTaskCount || 0}`,
    `- Active Network Tasks in packet: ${counts.activeTaskCount || 0}`,
    `- Hive chat entries in packet: ${counts.hiveChatCount || 0}`,
    "",
    "## Roles",
    roleLines || "- No verified role rows were present in the source packet.",
    "",
    "## Observations",
    `This mock report validates the ${label} report pipeline without calling OpenRouter. Production generation uses the configured Hive report model.`,
    verifierSummary ? ["", "## Verification", verifierSummary].join("\n") : "",
  ].filter(Boolean).join("\n"));
}

export async function generateHiveReportMarkdown({
  type = "",
  sourcePacket = {},
  phase = "initial",
  initialMarkdown = "",
  verifierSummary = "",
  fetchImpl = fetch,
} = {}) {
  if (process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true") {
    return {
      bodyMarkdown: cleanUserFacingReportMarkdown(mockMarkdownReport({ type, sourcePacket, phase, verifierSummary })),
      provider: "mock",
      model: type === "hive_intelligence" ? "mock-glm-xhigh-thinking" : "mock-glm-high-thinking",
      responseId: `mock_hive_report_${type}_${phase}`,
      promptDigest: promptDigest(reportInstructions(type, phase)),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      },
    };
  }
  if (!inferenceConfigured()) {
    const error = new Error("hive_report_inference_not_configured");
    error.status = 409;
    throw error;
  }
  const model = hiveReportModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs() * 2 + 1000);
  const startedAt = Date.now();
  const messages = reportMessages({ type, sourcePacket, phase, initialMarkdown, verifierSummary });
  try {
    const response = await inferenceFetchCompatibility(fetchImpl, "", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        reasoning: { effort: hiveReportReasoningEffort(type) },
        temperature: 0.2,
        max_tokens: hiveReportMaxTokens(type),
        usage: { include: true },
        metadata: {
          app: "tasknodeofficial",
          worker: "hive_reports",
          report_type: type,
          report_phase: phase,
        },
      }),
    }, { capability: "strict_json", timeoutMs: providerTimeoutMs() });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `Inference Hive Report HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      bodyMarkdown: markdownBody(cleanUserFacingReportMarkdown(body?.choices?.[0]?.message?.content || "")),
      provider: inferenceProviderForResponse(body),
      model: safeText(body?.model || model, 160),
      responseId: safeText(body?.id, 200),
      promptDigest: promptDigest(JSON.stringify(messages)),
      usage: {
        ...openRouterUsage(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("hive_report_inference_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractLinksFromText(text = "") { return extractHttpLinks(text).slice(0, 30); }

function collectText(value, depth = 0) {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).join("\n");
  if (value && typeof value === "object") return Object.values(value).map((item) => collectText(item, depth + 1)).join("\n");
  return "";
}

async function fetchWithTimeout(url, { fetchImpl = fetch, method = "HEAD", timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      signal: controller.signal,
      headers: {
        "user-agent": "TaskNodeHiveReportVerifier/1.0",
        ...headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkUrl(url, fetchImpl = fetch) {
  try {
    let response = await fetchWithTimeout(url, { fetchImpl, method: "HEAD" });
    if (response.status === 405 || response.status === 403 || response.status === 400) {
      response = await fetchWithTimeout(url, { fetchImpl, method: "GET" });
    }
    return {
      url,
      ok: response.ok,
      status: response.status,
      contentType: response.headers?.get?.("content-type") || "",
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      error: safeText(error?.message || "fetch_failed", 180),
    };
  }
}

function verificationMarkdown({ title = "", checks = [], note = "" } = {}) {
  const okCount = checks.filter((item) => item.ok).length;
  return markdownBody([
    `# ${title}`,
    "",
    `- Checked: ${checks.length}`,
    `- Reachable: ${okCount}`,
    `- Unreachable or unknown: ${Math.max(0, checks.length - okCount)}`,
    note ? `- Note: ${note}` : "",
    "",
    "## Checks",
    checks.length
      ? checks.map((item) => `- ${item.ok ? "Confirmed" : "Unverified"}: ${item.url} (${item.status || item.error || "no status"})`).join("\n")
      : "- No public links were available for this verifier.",
  ].filter(Boolean).join("\n"));
}

export async function verifyKolReportLinks({ markdown = "", sourcePacket = {}, fetchImpl = fetch } = {}) {
  const links = [...new Set([
    ...extractLinksFromText(markdown),
    ...extractLinksFromText(collectText(sourcePacket.rewardedTasksByRole?.kol)),
    ...extractLinksFromText(collectText(sourcePacket.roles?.byRole?.kol)),
  ])].slice(0, 20);
  if (process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true") {
    return verificationMarkdown({
      title: "KOL Link Verification",
      checks: links.slice(0, 5).map((url) => ({ url, ok: true, status: 200 })),
      note: links.length ? "Mock verifier treated sampled links as reachable." : "Mock verifier found no links.",
    });
  }
  const checks = [];
  for (const link of links) {
    checks.push(await checkUrl(link, fetchImpl));
  }
  return verificationMarkdown({
    title: "KOL Link Verification",
    checks,
    note: "The verifier only confirms public link reachability; it does not validate off-platform audience quality.",
  });
}

async function githubJson(url, fetchImpl = fetch) {
  const headers = {
    "user-agent": "TaskNodeHiveReportVerifier/1.0",
    accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchWithTimeout(url, { fetchImpl, method: "GET", timeoutMs: 12000, headers });
  if (!response.ok) return { ok: false, status: response.status, body: null };
  const body = await response.json().catch(() => null);
  return { ok: true, status: response.status, body };
}

export async function verifyDevelopmentReportRepos({ markdown = "", sourcePacket = {}, fetchImpl = fetch } = {}) {
  const sourceText = [markdown, collectText(sourcePacket.rewardedTasksByRole?.core_contributor), collectText(sourcePacket.activeTasksByRole?.core_contributor)].join("\n");
  const repoLinks = extractLinksFromText(sourceText)
    .filter((link) => new URL(link).hostname.toLowerCase() === "github.com" && new URL(link).pathname.toLowerCase().startsWith("/postfiatorg/"))
    .slice(0, 20);
  if (process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true") {
    return verificationMarkdown({
      title: "Development Repository Verification",
      checks: repoLinks.slice(0, 5).map((url) => ({ url, ok: true, status: 200 })),
      note: repoLinks.length ? "Mock verifier treated sampled repository links as reachable." : "Mock verifier found no repository links.",
    });
  }
  const linkChecks = [];
  for (const link of repoLinks) {
    linkChecks.push(await checkUrl(link, fetchImpl));
  }
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(`org:postfiatorg updated:>=${since}`)}&per_page=10`;
  const githubSearch = await githubJson(searchUrl, fetchImpl).catch((error) => ({
    ok: false,
    status: 0,
    body: null,
    error: error?.message || "github_search_failed",
  }));
  const checks = [
    ...linkChecks,
    {
      url: searchUrl,
      ok: githubSearch.ok,
      status: githubSearch.status,
      error: githubSearch.error || "",
    },
  ];
  const totalCount = Number(githubSearch.body?.total_count || 0);
  return verificationMarkdown({
    title: "Development Repository Verification",
    checks,
    note: `GitHub issue/PR search for postfiatorg updated since ${since} returned ${totalCount} visible items.`,
  });
}
