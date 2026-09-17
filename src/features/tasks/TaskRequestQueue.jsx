import { useEffect, useState } from "react";
import { requestJson } from "../../api";
import {
  activeTaskRequests,
  attentionTaskRequests,
  processingTaskRequests,
} from "./task-visible-state.js";

function statusSlug(status = "") {
  const value = String(status || "published").toLowerCase();
  return ["signing", "published", "queued", "generating", "proposed", "failed", "cancelled"].includes(value) ? value : "published";
}

function requestTitle(request = {}) {
  return request.userDetailText || request.requestText || "Task request";
}

function TaskRequestRow({ request, onRefresh }) {
  const [retry, setRetry] = useState({ pending: false, error: "" });
  const [optimistic, setOptimistic] = useState(null);
  // Once the server-side state for this request changes, the real row wins.
  useEffect(() => { setOptimistic(null); }, [request.status, request.workerAttemptCount, request.updatedAt]);
  async function updateRequest(phase) {
    setRetry({ pending: true, error: "" });
    try {
      const response = await requestJson("/api/tasks/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phase, expectedAccountId: request.accountId, requestId: request.requestId, expectedAttemptCount: request.workerAttemptCount }) });
      if (!response.ok || !response.body?.ok) throw new Error(response.body?.message || "Could not update this request.");
      // The server accepted the write; reflect it immediately instead of
      // holding the row in a pending state until the next app-state refresh.
      setOptimistic(phase);
      setRetry({ pending: false, error: "" });
      onRefresh?.()?.catch?.(() => null);
    } catch (error) { setRetry({ pending: false, error: error.message }); }
  }
  if (optimistic === "dismiss") return null;
  const statusClass = optimistic === "retry" ? "queued" : statusSlug(request.status);
  const statusLabel = optimistic === "retry" ? "Queued" : (request.statusLabel || "Published to PFT");
  const showActions = !optimistic;
  return (
    <article className={`task-request-row is-${statusClass}`}>
      <span className="task-request-status-dot" aria-hidden="true" />
      <div className="task-request-row-main">
        <div className="task-request-row-top">
          <strong>{statusLabel}</strong>
          <span>{optimistic ? "just now" : (request.ago || "just now")}</span>
        </div>
        <p>{requestTitle(request)}</p>
        {!optimistic && request.lastError && <p className="task-request-row-error">{request.lastError}</p>}
        {showActions && request.canRetry && <button className="task-request-text-button" type="button" disabled={retry.pending} onClick={() => updateRequest("retry")}>Retry request</button>}
        {showActions && request.canDismiss && <button className="task-request-text-button" type="button" disabled={retry.pending} onClick={() => updateRequest("dismiss")}>Dismiss</button>}
        {retry.pending && <span role="status">Updating request…</span>}
        {retry.error && <p className="task-request-row-error" role="alert">{retry.error}</p>}
      </div>
    </article>
  );
}

export function TaskRequestQueue({ requests = [], onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const activeRequests = activeTaskRequests(requests);
  if (!activeRequests.length) return null;
  const processingCount = processingTaskRequests(activeRequests).length;
  const attentionCount = attentionTaskRequests(activeRequests).length;
  const primary = activeRequests[0];
  const extraCount = activeRequests.length - 1;
  if (activeRequests.length === 1) {
    return (
      <section className="task-request-queue" aria-label="Active task request">
        <TaskRequestRow request={primary} onRefresh={onRefresh} />
      </section>
    );
  }

  return (
    <section className="task-request-queue" aria-label="Active task request">
      <div className="task-request-queue-head">
        <div>
          <strong>Task requests</strong>
          <span>
            {processingCount > 0 && `${processingCount} processing`}
            {processingCount > 0 && attentionCount > 0 && " / "}
            {attentionCount > 0 && `${attentionCount} need attention`}
          </span>
        </div>
        {extraCount > 0 && <em>+{extraCount}</em>}
      </div>
      {activeRequests.length > 2 && <button type="button" className="task-request-text-button" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer requests" : `Show all ${activeRequests.length} requests`}</button>}
      <div className="task-request-queue-list">
        {activeRequests.slice(0, expanded ? activeRequests.length : 2).map((request) => (
          <TaskRequestRow key={request.requestId} request={request} onRefresh={onRefresh} />
        ))}
      </div>
    </section>
  );
}
