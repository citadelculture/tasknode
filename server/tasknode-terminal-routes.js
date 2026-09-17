import { createHash } from "node:crypto";
import { appearancePageHead } from "./appearance-page.js";
import { handleCampaignTrackerRoute } from "./campaign-tracker-routes.js";
import { handleCollaborationRoute } from "./collaboration-routes.js";
import { authStart, chatModes, chatSend, chatStreamStart } from "./product-contracts.js";
import { executeChatStream, logChatProviderError } from "./chat-router.js";
import { startChatStreamHeartbeat } from "./chat-stream-heartbeat.js";
import { conversationIdForChatWrite, explicitConversationId } from "./chat-conversation-ids.js";
import { fetchPftBalance } from "./pftl-balance.js";
import { getContextDocument, saveContextDocument } from "./repositories/context.js";
import {
  getTerminalTaskProjectionDetail,
  listTaskProjectionCounts,
  listTaskProjectionRewards,
  listTaskProjectionTasks,
} from "./repositories/tasks.js";
import { contextBodyText, contextLineCount } from "../shared/context-line-map.js";
import { normalizeTaskSteps } from "../shared/task-steps.js";
import { getOwnedTaskRequest, listTaskRequests } from "./repositories/task-requests.js";
import {
  conversationIdForSession,
} from "./runtime-store.js";
import { getLinkedProviderForAccount } from "./repositories/accounts.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import {
  consumeTerminalAuthRequestSession,
  createTerminalAuthRequest,
  getTerminalAuthRequest,
  getTerminalSessionByToken,
  revokeTerminalSessionByToken,
} from "./repositories/terminal-auth.js";
import {
  getChatMessages,
  listChatConversations,
  searchChatConversations,
} from "./repositories/chat-billing.js";
import { chatConversationExistsForAccount } from "./repositories/chat-conversation-lookup.js";
import { recordChatFailureObservability } from "./repositories/user-observability.js";
import {
  offchainTaskLifecycleDualWriteEnabled,
  offchainTaskLifecycleEnabled,
} from "./offchain-task-lifecycle.js";
import { taskLifecycleAction } from "./task-actions.js";
import { terminalTaskRequestAction } from "./task-request.js";
import { taskSubmissionAction } from "./task-submission.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  const boundary = [...header].findIndex(character => character === " " || character === "\t");
  return boundary > 0 && header.slice(0, boundary).toLowerCase() === "bearer"
    ? header.slice(boundary).trim()
    : "";
}

function terminalHandoffUrl(origin = "", taskId = "") {
  const normalizedOrigin = safeText(origin, 500).replace(/\/+$/, "");
  const path = taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks";
  return normalizedOrigin ? `${normalizedOrigin}${path}` : path;
}

function linkUrl(origin = "") {
  const normalizedOrigin = safeText(origin, 500).replace(/\/+$/, "");
  return normalizedOrigin
    ? `${normalizedOrigin}/settings/accounts/github`
    : "/settings/accounts/github";
}

function githubNotLinked(origin = "") {
  return {
    ok: false,
    error: "github_not_linked",
    message: "Link GitHub in Task Node before using /tasknode.",
    linkUrl: linkUrl(origin),
  };
}

async function terminalSession(req, origin = "") {
  const token = bearerToken(req);
  const session = token ? await getTerminalSessionByToken(token) : null;
  if (!session?.accountId) {
    return {
      error: {
        status: 401,
        body: {
          ok: false,
          error: "terminal_login_required",
          message: "Task Node is not linked in this Corbanu profile. Run /tasknode link, choose your GitHub account, then run /tasknode status.",
        },
      },
    };
  }
  if (!(await getLinkedProviderForAccount({ accountId: session.accountId, provider: "github" }))) {
    return {
      error: {
        status: 409,
        body: githubNotLinked(origin),
      },
    };
  }
  return { session, token };
}

function terminalTaskActionsEnabled() {
  return offchainTaskLifecycleEnabled() && !offchainTaskLifecycleDualWriteEnabled();
}

async function terminalChatConversationId(session = {}, requestedId = "") {
  return conversationIdForChatWrite({
    conversationIdForSession,
    existsForAccount: chatConversationExistsForAccount,
    requestedId,
    session,
  });
}

function terminalChatPayload(payload = {}, session = {}, conversationId = "") {
  const requestedMode = safeText(payload?.mode || "", 80);
  return {
    ...payload,
    accountId: session.accountId || "",
    conversationId,
    mode: requestedMode || "Thinking",
  };
}

async function linkedWalletForSession(session = {}) {
  const linkedWallet = await getLinkedWallet({ accountId: session.accountId || "" });
  return linkedWallet.status === "linked" && linkedWallet.address
    ? linkedWallet
    : { status: linkedWallet.status || "not_linked", address: "" };
}

function mapWalletRequired(result = {}, origin = "", taskId = "") {
  const error = result?.body?.error || "";
  if (![
    "task_wallet_required",
    "task_submission_wallet_required",
    "tasknode_encryption_key_missing",
  ].includes(error)) {
    return result;
  }
  return {
    status: 409,
    body: {
      ok: false,
      error: "wallet_action_required",
      message: "Open Task Node web wallet to complete this task action.",
      handoffUrl: terminalHandoffUrl(origin, taskId),
      upstreamError: error,
    },
  };
}

function terminalWriteUnavailable(origin = "", taskId = "") {
  return {
    status: 409,
    body: {
      ok: false,
      error: "wallet_action_required",
      message: "This Task Node deployment still requires wallet-signed task actions.",
      handoffUrl: terminalHandoffUrl(origin, taskId),
    },
  };
}

function cleanText(value = "", max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanLines(lines = []) {
  return lines
    .map((line) => cleanText(line, 4000))
    .filter(Boolean);
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function wordCount(text = "") {
  const words = String(text || "").trim().match(/\S+/g);
  return words ? words.length : 0;
}

function terminalContextDocument(document = {}) {
  const body = String(document.body || "");
  const bodyText = contextBodyText(body);
  return {
    ...document,
    body,
    bodyText,
    terminal: {
      digest: `sha256:${sha256(body).slice(0, 16)}`,
      bodyDigest: `sha256:${sha256(body)}`,
      textDigest: `sha256:${sha256(bodyText)}`,
      lineCount: contextLineCount(body),
      wordCount: wordCount(bodyText),
      charCount: bodyText.length,
      editableBodyFormat: /<\/?[a-z][\s\S]*>/i.test(body) ? "html" : "text",
    },
  };
}

function terminalTaskId(task = {}) {
  return cleanText(task.taskId || task.fullId || task.id || "", 180);
}

function terminalTaskReward(task = {}) {
  const amount = Number(task.pft || 0);
  return `${Number.isFinite(amount) ? amount.toLocaleString("en-US") : "0"} PFT`;
}

function terminalTaskVerification(task = {}) {
  return cleanText(
    task.verification?.body ||
      task.submissionRequirement?.criteria ||
      task.verification?.title ||
      "",
    4000
  );
}

function terminalCurrentVerificationRequest(detail = {}) {
  const request = detail?.currentVerificationRequest || {};
  return cleanLines([
    request.body || request.verificationAsk || request.ask || "",
    request.reason ? `Reason: ${request.reason}` : "",
  ]).join("\n");
}

function terminalTaskBrief(detail = {}) {
  const task = detail?.task || {};
  const title = cleanText(task.title || "Untitled task", 240);
  const taskId = terminalTaskId(task);
  const requestId = cleanText(task.metadata?.requestId || "", 180);
  const networkProjectId = cleanText(task.metadata?.networkProjectId || "", 180);
  const networkAllocationId = cleanText(task.metadata?.networkAllocationId || "", 180);
  const status = cleanText(task.status || task.statusKey || "", 80);
  const kind = cleanText(task.kind || "Task", 80);
  const due = cleanText(task.fullDue || task.due || "", 120);
  const dueLabel = cleanText(task.dueLabel || "Deadline", 80);
  const description = cleanText(task.description || "", 8000);
  const steps = normalizeTaskSteps(task.steps, { clean: cleanText });
  const verification = terminalTaskVerification(task);
  const currentVerificationRequest = terminalCurrentVerificationRequest(detail);
  const sections = [
    "Task for Codex",
    "",
    ...cleanLines([
      `Title: ${title}`,
      taskId ? `Task ID: ${taskId}` : "",
      requestId ? `Request ID: ${requestId}` : "",
      networkProjectId ? `Network Project: ${networkProjectId}` : "",
      networkAllocationId ? `Network Allocation: ${networkAllocationId}` : "",
      kind ? `Kind: ${kind}` : "",
      status ? `Status: ${status}` : "",
      `Reward: ${terminalTaskReward(task)}`,
      due ? `${dueLabel}: ${due}` : "",
    ]),
    "",
    "Objective",
    description || "No description provided.",
  ];

  if (steps.length) {
    sections.push("", "Steps", ...steps.map((step, index) => `${index + 1}. ${step}`));
  }

  sections.push("", "Verification Requirements", verification || "Submit evidence that satisfies the task requirement.");

  if (currentVerificationRequest) {
    sections.push("", "Current Verification Request", currentVerificationRequest);
  }

  sections.push(
    "",
    "Requested Output",
    "Complete the task and return the evidence needed for the verification requirement. Include changed files, commands run, test results, links, screenshots, or concise proof artifacts when relevant."
  );

  return sections.join("\n");
}

function terminalEvidencePrompt(detail = {}) {
  const task = detail?.task || {};
  const actions = detail?.actions || {};
  const mode = actions.canSubmitVerificationEvidence ? "verification_response" : "initial_submission";
  const title = cleanText(task.title || "Untitled task", 240);
  const currentVerificationRequest = terminalCurrentVerificationRequest(detail);
  return {
    mode,
    title: `Submit ${mode === "verification_response" ? "verification response" : "evidence"} for ${title}`,
    body: currentVerificationRequest || terminalTaskVerification(task) || "Submit evidence that satisfies the task requirement.",
    acceptedTypes: ["text", "url", "github_pr", "git_commit"],
    examples: [
      "PR URL",
      "commit URL",
      "terminal output summary",
      "test command and result",
      "concise proof text",
    ],
    maxArtifacts: 2,
  };
}

function withTerminalTaskRendering(detail = {}) {
  if (!detail?.task) return detail;
  return {
    ...detail,
    terminal: {
      briefText: terminalTaskBrief(detail),
      evidencePrompt: terminalEvidencePrompt(detail),
    },
  };
}

function mapTaskRequestTerminalResult(result = {}, origin = "") {
  const error = result?.body?.error || "";
  if (error === "task_request_wallet_required") {
    return {
      status: 409,
      body: {
        ok: false,
        error: "wallet_not_linked",
        message: "Link a PFT wallet in Task Node before requesting a task.",
        handoffUrl: terminalHandoffUrl(origin),
      },
    };
  }
  return result;
}

function terminalAuthCompleteHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Task Node terminal linked</title>
${appearancePageHead}
<body style="font-family: system-ui, sans-serif; margin: 2rem;">
  <h1>Task Node linked</h1>
  <p>Return to the Corbanu profile where you started linking and run <code>/tasknode status</code>.</p>
</body>`;
}

function writeHtml(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

async function handleTerminalAuthRoute({
  json,
  readJson,
  req,
  res,
  url,
  origin,
  responseHeadersForAuthResult,
}) {
  if (url.pathname === "/api/auth/terminal/start/github") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const request = await createTerminalAuthRequest({
      provider: "github",
      origin,
      userAgent: req.headers["user-agent"] || "",
      ip: req.socket?.remoteAddress || "",
    });
    const base = origin.replace(/\/+$/, "");
    const verificationPath = `/api/auth/terminal/github/${encodeURIComponent(request.requestId)}`;
    json(res, 200, {
      ok: true,
      action: "terminal_github_auth_start",
      requestId: request.requestId,
      pollToken: request.pollToken,
      userCode: request.userCode,
      verificationUrl: base ? `${base}${verificationPath}` : verificationPath,
      expiresAt: request.expiresAt,
      pollIntervalMs: Number(payload?.pollIntervalMs || 2000),
    });
    return true;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "terminal" && parts[3] === "github" && parts[4]) {
    const requestId = safeText(decodeURIComponent(parts[4]), 180);
    const request = await getTerminalAuthRequest({ requestId });
    if (!request) {
      json(res, 404, {
        ok: false,
        error: "terminal_auth_request_not_found",
        message: "Terminal auth request was not found or expired.",
      });
      return true;
    }
    const result = await authStart("github", {
      origin,
      redirectPath: `/api/auth/terminal/complete?requestId=${encodeURIComponent(requestId)}`,
      terminalRequestId: requestId,
    });
    const headers = responseHeadersForAuthResult(req, result);
    if (result.status === 200 && result.body?.redirectUrl) {
      res.writeHead(302, {
        "cache-control": "no-store",
        ...headers,
        location: result.body.redirectUrl,
      });
      res.end("");
      return true;
    }
    json(res, result.status, result.body, headers);
    return true;
  }

  if (url.pathname === "/api/auth/terminal/complete") {
    writeHtml(res, 200, terminalAuthCompleteHtml());
    return true;
  }

  if (url.pathname === "/api/auth/terminal/session") {
    const requestId = url.searchParams.get("requestId") || "";
    const pollToken = url.searchParams.get("pollToken") || req.headers["x-tasknode-terminal-poll-token"] || "";
    const result = await consumeTerminalAuthRequestSession({ requestId, pollToken });
    if (!result.ok) {
      json(res, result.status, {
        ok: false,
        error: result.error,
        requestId,
        expiresAt: result.expiresAt || undefined,
        ...(result.error === "github_not_linked" ? githubNotLinked(origin) : {}),
      });
      return true;
    }
    json(res, 200, {
      ok: true,
      action: "terminal_session_issued",
      accountId: result.session.accountId,
      githubUsername: result.session.githubUsername || "",
      terminalToken: result.terminalToken,
      expiresAt: result.session.expiresAt,
      scopes: result.session.scopes || [],
    });
    return true;
  }

  if (url.pathname === "/api/auth/terminal/revoke") {
    const token = bearerToken(req);
    await revokeTerminalSessionByToken(token);
    json(res, 200, {
      ok: true,
      action: "terminal_session_revoked",
    });
    return true;
  }

  return false;
}

async function handleTerminalTaskNodeRoute({ json, readJson, req, res, url, origin }) {
  if (!url.pathname.startsWith("/api/terminal/tasknode")) return false;
  const resolved = await terminalSession(req, origin);
  if (resolved.error) {
    json(res, resolved.error.status, resolved.error.body);
    return true;
  }
  const session = resolved.session;
  if (await handleCampaignTrackerRoute({ json, readJson, req, res, url, session })) return true;

  if (url.pathname === "/api/terminal/tasknode/team/context") {
    const teamUrl = new URL(url);
    teamUrl.pathname = "/api/team/context";
    return handleCollaborationRoute({ json, readJson, req, res, url: teamUrl, session });
  }

  if (url.pathname === "/api/terminal/tasknode/status") {
    const wallet = await linkedWalletForSession(session);
    const projection = await listTaskProjectionCounts({
      accountId: session.accountId,
      walletAddress: wallet.address || "",
    });
    const github = await getLinkedProviderForAccount({ accountId: session.accountId, provider: "github" });
    json(res, 200, {
      ok: true,
      accountId: session.accountId,
      github: {
        linked: Boolean(github),
        username: github?.username || session.githubUsername || "",
        terminalBridgeEligible: Boolean(github),
      },
      wallet: {
        linked: wallet.status === "linked",
        address: wallet.address || "",
        signingRequiredForActions: !terminalTaskActionsEnabled(),
      },
      counts: projection.counts,
      sync: projection.sync,
      server: {
        offchainTaskLifecycle: offchainTaskLifecycleEnabled(),
        terminalTaskActions: terminalTaskActionsEnabled(),
      },
    });
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/context") {
    const current = await getContextDocument({ accountId: session.accountId });
    if (req.method === "GET") {
      json(res, 200, {
        ok: true,
        context: terminalContextDocument(current),
      });
      return true;
    }

    if (req.method !== "POST" && req.method !== "PATCH") {
      json(res, 405, {
        ok: false,
        error: "terminal_context_method_not_allowed",
        message: "Task Node context supports GET, POST, and PATCH.",
      });
      return true;
    }

    if (!current.canEdit) {
      json(res, 409, {
        ok: false,
        error: "terminal_context_read_only",
        message: "This Task Node context document is read-only for the terminal session.",
      });
      return true;
    }

    const payload = await readJson(req, 256 * 1024);
    const expectedRevision = Number(payload?.revision);
    if (
      Number.isFinite(expectedRevision) &&
      expectedRevision >= 0 &&
      expectedRevision !== Number(current.revision || 0)
    ) {
      json(res, 409, {
        ok: false,
        error: "terminal_context_revision_conflict",
        message: "Task Node context changed after it was opened. Refresh before saving.",
        context: terminalContextDocument(current),
      });
      return true;
    }

    const title = safeText(payload?.title || current.title || "Task Node Context", 120);
    const body = String(payload?.body ?? "");
    if (!body.trim()) {
      json(res, 400, {
        ok: false,
        error: "terminal_context_body_required",
        message: "Context body is required.",
      });
      return true;
    }

    const beforeDigest = sha256(current.body || "");
    const result = await saveContextDocument({
      accountId: session.accountId,
      title,
      body,
      source: "pfterminal",
      provenance: {
        surface: "pfterminal",
        terminal: true,
        previousRevision: current.revision || 0,
      },
    });

    if (!result.ok) {
      json(res, result.status || 400, {
        ok: false,
        error: result.error || "terminal_context_save_failed",
        message: "Task Node context could not be saved.",
      });
      return true;
    }

    const saved = result.document || current;
    json(res, 200, {
      ok: true,
      message: sha256(saved.body || "") === beforeDigest
        ? "Context unchanged."
        : "Context saved.",
      saved: sha256(saved.body || "") !== beforeDigest,
      context: terminalContextDocument(saved),
    });
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/chat/modes") {
    json(res, 200, {
      ok: true,
      defaultMode: "Instant",
      modes: chatModes({ signedOut: false }),
    });
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/chat/conversations") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 30), 1), 50);
    json(res, 200, {
      ok: true,
      conversations: await listChatConversations({
        accountId: session.accountId,
        limit,
      }),
    });
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/chat/history") {
    const conversationId = explicitConversationId(url.searchParams.get("conversationId") || "")
      || conversationIdForSession(session);
    json(res, 200, {
      ok: true,
      conversationId,
      messages: await getChatMessages({
        accountId: session.accountId,
        conversationId,
        limit: Math.min(Math.max(Number(url.searchParams.get("limit") || 80), 1), 200),
      }),
    });
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/chat/search") {
    const searchQuery = safeText(url.searchParams.get("q") || "", 120);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 50);
    json(res, 200, {
      ok: true,
      query: searchQuery,
      results: searchQuery.length < 2
        ? []
        : await searchChatConversations({
            accountId: session.accountId,
            query: searchQuery,
            limit,
          }),
    });
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/chat/send") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = await terminalChatConversationId(session, payload?.conversationId || "");
    const result = await chatSend(
      terminalChatPayload(payload, session, conversationId),
      req.method,
      { source: "pfterminal" }
    );
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/chat/stream") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = await terminalChatConversationId(session, payload?.conversationId || "");
    const started = await chatStreamStart(
      terminalChatPayload(payload, session, conversationId),
      req.method,
      { source: "pfterminal" }
    );

    if (!started.stream) {
      json(res, started.status, started.body);
      return true;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    writeSse(res, "meta", started.body);

    const controller = new AbortController();
    const heartbeat = startChatStreamHeartbeat(res);
    res.on("close", () => {
      heartbeat.stop();
      if (!res.writableEnded) controller.abort();
    });

    try {
      const result = await executeChatStream({
        ...started.chat,
        signal: controller.signal,
        onDelta: (delta) => writeSse(res, "delta", { delta }),
      });

      writeSse(res, "done", {
        ok: true,
        action: "terminal_chat_stream",
        message: "Chat response generated.",
        conversationId,
        mode: started.chat.mode,
        provider: result.provider,
        model: result.model,
        responseId: result.responseId,
        user: result.user,
        assistant: result.assistant,
        estimate: started.estimate,
        usage: {
          billingModel: "usage_based",
          currency: "USD",
          inputTokens: result.usage.inputTokens,
          promptCacheHitTokens: result.usage.promptCacheHitTokens || 0,
          promptCacheMissTokens: result.usage.promptCacheMissTokens || 0,
          promptCacheHitRate: result.usage.promptCacheHitRate || 0,
          cacheUsageReported: result.usage.cacheUsageReported === true,
          cacheSavingsUsd: result.usage.cacheSavingsUsd || 0,
          costSource: result.usage.costSource || "",
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          webSearchCalls: result.usage.webSearchCalls || 0,
          toolCostUsd: result.usage.toolCostUsd || 0,
          costUsd: result.usage.costUsd,
          estimated: result.usage.estimated === true,
        },
        ledgerEntry: result.ledgerEntry,
        contextStatus: result.contextStatus || started.chat.contextStatus,
      });
    } catch (error) {
      if (error?.status !== 499) {
        logChatProviderError(error, {
          action: "terminal_chat_stream",
          mode: started.chat.mode,
          provider: started.estimate?.provider,
          model: started.estimate?.model,
        });
        await recordChatFailureObservability({
          accountId: started.chat.accountId,
          conversationId,
          mode: started.chat.mode,
          provider: started.estimate?.provider,
          model: started.estimate?.model,
          status: error?.status || 502,
          error,
          sourceRoute: "server/tasknode-terminal-routes.js::/api/terminal/tasknode/chat/stream",
        }).catch(() => {});
        writeSse(res, "error", {
          ok: false,
          error: error?.message || "chat_provider_error",
          action: "terminal_chat_stream",
          message:
            error?.status === 504
              ? "The chat provider timed out before returning a response."
              : "The chat provider could not complete this response.",
          actionRequired:
            "Retry with a shorter prompt, choose another configured mode, or check provider health.",
          estimate: started.estimate,
        });
      }
    } finally {
      heartbeat.stop();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/tasks") {
    const tab = safeText(url.searchParams.get("tab") || "outstanding", 40);
    const wallet = await linkedWalletForSession(session);
    const state = await listTaskProjectionTasks({
      accountId: session.accountId,
      walletAddress: wallet.address || "",
      tab,
      limit: 200,
    });
    json(res, 200, {
      ok: true,
      tab: state.tab,
      tasks: state.tasks,
      counts: state.counts,
      sync: state.sync || {},
    });
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/requests") {
    const wallet = await linkedWalletForSession(session);
    if (req.method === "GET") {
      const requests = await listTaskRequests({
        accountId: session.accountId,
        walletAddress: wallet.address || "",
        limit: Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 50),
        cursor: url.searchParams.get("cursor") || "",
      });
      json(res, 200, {
        ok: true,
        ...requests,
      });
      return true;
    }

    if (wallet.status !== "linked" || !wallet.address) {
      json(res, 409, {
        ok: false,
        error: "wallet_not_linked",
        message: "Link a PFT wallet in Task Node before requesting a task.",
        handoffUrl: terminalHandoffUrl(origin),
      });
      return true;
    }

    if (!terminalTaskActionsEnabled()) {
      json(res, 409, {
        ok: false,
        error: "wallet_action_required",
        message: "This Task Node deployment still requires a wallet-signed task request.",
        handoffUrl: terminalHandoffUrl(origin),
      });
      return true;
    }

    const payload = await readJson(req, 64 * 1024);
    const result = await terminalTaskRequestAction({
      ...payload,
      phase: "submit",
      source: "pfterminal",
      sourceConversationTitle: payload.sourceConversationTitle || "Corbanu Terminal",
      requestedTaskKind: payload.requestedTaskKind || "personal",
    }, req.method, session);
    const mapped = mapTaskRequestTerminalResult(result, origin);
    json(res, mapped.status, mapped.body);
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/balance") {
    const wallet = await linkedWalletForSession(session);
    if (wallet.status !== "linked" || !wallet.address) {
      json(res, 409, {
        ok: false,
        error: "wallet_not_linked",
        message: "Link a PFT wallet in Task Node before reading a balance.",
      });
      return true;
    }
    const result = await fetchPftBalance(wallet.address, {
      force: url.searchParams.get("force") === "1",
    });
    json(res, result.status || (result.ok ? 200 : 502), result);
    return true;
  }

  if (url.pathname === "/api/terminal/tasknode/rewards") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 10), 1), 50);
    const wallet = await linkedWalletForSession(session);
    const projection = await listTaskProjectionRewards({
      accountId: session.accountId,
      walletAddress: wallet.address || "",
      limit,
    });
    json(res, 200, {
      ok: true,
      rewards: projection.rewards,
      sync: projection.sync,
    });
    return true;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[3] === "requests" && parts[4] && req.method === "GET") {
    const request = await getOwnedTaskRequest({
      accountId: session.accountId,
      requestId: decodeURIComponent(parts[4]),
    });
    if (!request) {
      json(res, 404, {
        ok: false,
        error: "terminal_task_request_not_found",
        message: "No Task Node request was found for this account.",
      });
      return true;
    }
    json(res, 200, {
      ok: true,
      request,
    });
    return true;
  }

  const taskId = parts[3] === "tasks" && parts[4] ? decodeURIComponent(parts[4]) : "";
  if (taskId && parts.length === 5 && req.method === "GET") {
    const wallet = await linkedWalletForSession(session);
    const detail = wallet.address
      ? await getTerminalTaskProjectionDetail({
          accountId: session.accountId,
          walletAddress: wallet.address,
          taskId,
        })
      : null;
    if (!detail) {
      json(res, wallet.address ? 404 : 409, {
        ok: false,
        error: wallet.address ? "task_not_found" : "wallet_not_linked",
        message: wallet.address
          ? "No indexed task projection was found for the linked wallet."
          : "Link a PFT wallet in Task Node before reading task detail.",
      });
      return true;
    }
    json(res, 200, withTerminalTaskRendering(detail));
    return true;
  }

  if (taskId && parts[5] === "action") {
    if (!terminalTaskActionsEnabled()) {
      const result = terminalWriteUnavailable(origin, taskId);
      json(res, result.status, result.body);
      return true;
    }
    const payload = req.method === "POST" ? await readJson(req, 64 * 1024) : {};
    const result = await taskLifecycleAction({
      ...payload,
      phase: "submit",
      taskId,
      taskAction: payload.action || payload.taskAction || payload.task_action,
      source: "pfterminal",
    }, req.method, session);
    const mapped = mapWalletRequired(result, origin, taskId);
    json(res, mapped.status, mapped.body);
    return true;
  }

  if (taskId && parts[5] === "evidence") {
    if (!terminalTaskActionsEnabled()) {
      const result = terminalWriteUnavailable(origin, taskId);
      json(res, result.status, result.body);
      return true;
    }
    const payload = req.method === "POST" ? await readJson(req, 1024 * 1024) : {};
    const evidenceItems = Array.isArray(payload.evidence) ? payload.evidence : [];
    const result = await taskSubmissionAction({
      ...payload,
      phase: "submit",
      taskId,
      method: payload.method || "text",
      value: payload.summary || payload.value || "",
      evidence_items: evidenceItems.map((item, index) => ({
        index: index + 1,
        artifact_type: item?.type || item?.artifact_type || "text",
        value: item?.url || item?.value || item?.text || "",
        notes: item?.notes || "",
      })),
      source: "pfterminal",
    }, req.method, session);
    const mapped = mapWalletRequired(result, origin, taskId);
    json(res, mapped.status, mapped.body);
    return true;
  }

  json(res, 404, {
    ok: false,
    error: "terminal_tasknode_route_not_found",
    message: "Unknown Task Node terminal route.",
  });
  return true;
}

export async function handleTaskNodeTerminalRoute(params) {
  return (
    await handleTerminalAuthRoute(params) ||
    await handleTerminalTaskNodeRoute(params)
  );
}
