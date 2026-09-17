import assert from "node:assert/strict";
import {
  TASK_STATUS,
  TASK_TABS,
  statusFromRewardAmount,
  taskLifecycleActions,
  taskRefreshMetadata,
  taskRequiresRefresh,
  taskStatusTab,
} from "../shared/task-lifecycle.js";
import { taskgenPromptForInput, validateTaskgenOutput } from "../server/task-generation-worker.js";
import { isSafeEvidenceUrlLiteral } from "../server/task-review-worker.js";
import { isProjectionBehindCachedPointer } from "../server/repositories/tasks.js";

assert.equal(taskStatusTab(TASK_STATUS.verificationRequested), TASK_TABS.verification);
// verification_requested waits on the user's own response, so it is a
// slow-tier state and must not force fast refresh. The states genuinely
// awaiting the review worker stay on the fast tier.
assert.equal(taskRequiresRefresh(TASK_STATUS.verificationRequested), false);
assert.equal(taskRequiresRefresh(TASK_STATUS.submitted), true);
assert.equal(taskRequiresRefresh(TASK_STATUS.verificationResponseSubmitted), true);
assert.equal(taskRequiresRefresh(TASK_STATUS.rewardDecided), true);
assert.equal(taskLifecycleActions(TASK_STATUS.verificationRequested).canSubmitVerificationEvidence, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canAccept, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canRefuse, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canStop, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).stopAction, "refuse");
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).stopLabel, "Refuse task");
assert.equal(statusFromRewardAmount("2.50"), TASK_STATUS.rewarded);
assert.equal(statusFromRewardAmount("0"), TASK_STATUS.rewarded);

const taskgenBase = {
  schema: "pf.taskgen.output.v1",
  title: "Build deterministic task taxonomy check",
  description: "Produce a compact artifact showing task type normalization.",
  task_kind: "engineering",
  steps: ["Create the fixture.", "Run the check."],
  submission_requirement: { type: "text", criteria: "Submit the resulting artifact as text." },
  verification_policy: { followup_required: true, mode: "standard_followup", verification_type: "text" },
  reward_offer: { amount_estimate_pft: "3.2" },
  deadline: { accept_by: "2026-05-26T00:00:00.000Z", deadline_at: null },
};
assert.equal(validateTaskgenOutput(taskgenBase).task_kind, "personal");
assert.equal(validateTaskgenOutput({ ...taskgenBase, task_kind: "alpha" }).task_kind, "alpha");
assert.equal(validateTaskgenOutput(taskgenBase, { task_class: "network" }).task_kind, "network");
// Step limits clamp, never reject. A thorough model output (many or long steps)
// must not burn a generation attempt with taskgen_steps_invalid.
{
  const { TASK_MAX_STEPS, TASK_STEP_MAX_CHARS } = await import("../shared/task-steps.js");
  const sevenSteps = Array.from({ length: 7 }, (_, index) => `Step ${index + 1}: do the thing thoroughly.`);
  assert.equal(validateTaskgenOutput({ ...taskgenBase, steps: sevenSteps }).steps.length, 7);
  const fifteenSteps = Array.from({ length: 15 }, (_, index) => `Step ${index + 1}: do the thing.`);
  assert.equal(validateTaskgenOutput({ ...taskgenBase, steps: fifteenSteps }).steps.length, TASK_MAX_STEPS);
  const longStep = `Audit the event source. ${"detail ".repeat(500)}`.trim();
  assert.ok(longStep.length > 3000);
  const longResult = validateTaskgenOutput({ ...taskgenBase, steps: [longStep, "Ship it."] }).steps;
  assert.equal(longResult.length, 2);
  assert.equal(longResult[0], longStep.slice(0, TASK_STEP_MAX_CHARS));
  assert.deepEqual(validateTaskgenOutput({ ...taskgenBase, steps: ["  Trim me.  ", "", 42, "Then run."] }).steps, ["Trim me.", "Then run."]);
  assert.throws(() => validateTaskgenOutput({ ...taskgenBase, steps: ["Only one step."] }), /taskgen_steps_invalid/);
  assert.throws(() => validateTaskgenOutput({ ...taskgenBase, steps: "not a list" }), /taskgen_steps_invalid/);
}
const normalizedRelativeDeadline = validateTaskgenOutput({
  ...taskgenBase,
  deadline: { accept_by: "24h", deadline_at: "tomorrow" },
}).deadline;
assert.equal(normalizedRelativeDeadline.accept_by, null);
assert.equal(normalizedRelativeDeadline.deadline_at, null);
const policyDeadline = validateTaskgenOutput({
  ...taskgenBase,
  deadline: { accept_by: "2026-05-26T21:00:00.000Z", deadline_at: "2026-05-29T00:00:00.000Z" },
}, {
  deadline: {
    accept_by: "2026-05-26T20:47:04.186Z",
    deadline_at: null,
  },
}).deadline;
assert.equal(policyDeadline.accept_by, "2026-05-26T20:47:04.186Z");
assert.equal(policyDeadline.deadline_at, null);
const domainLanguageTask = validateTaskgenOutput({
  ...taskgenBase,
  title: "Update the compliance page and acceptance gates",
  description: "Change the named compliance page and document the final verdict.",
  steps: ["Update the compliance page.", "Run its acceptance gates."],
  submission_requirement: { type: "text", criteria: "Submit the exact edits and final verdict." },
});
assert.equal(domainLanguageTask.title, "Update the compliance page and acceptance gates");
assert.deepEqual(taskgenPromptForInput({ request: { requestText: "Build a personal task" } }), {
  path: "task_engine/taskgen_personal_v1.md",
  version: "taskgen_personal_v1",
});
assert.deepEqual(taskgenPromptForInput({
  request: { requestText: "Network Task", requestedTaskKind: "network" },
  network_task: { project_id: "project_1", project_need_summary: "Patch a named surface." },
  policy: { task_class: "network" },
}), {
  path: "task_engine/taskgen_network_v1.md",
  version: "taskgen_network_v1",
});
assert.equal(isSafeEvidenceUrlLiteral("https://example.com/proof").ok, true);
assert.equal(isSafeEvidenceUrlLiteral("file:///etc/passwd").reason, "unsupported_protocol");
assert.equal(isSafeEvidenceUrlLiteral("http://localhost:5174").reason, "localhost_not_allowed");
assert.equal(isSafeEvidenceUrlLiteral("http://127.0.0.1:5174").reason, "private_ip_not_allowed");
assert.equal(isSafeEvidenceUrlLiteral("http://169.254.169.254/latest/meta-data").reason, "private_ip_not_allowed");
assert.equal(isSafeEvidenceUrlLiteral("https://user:pass@example.com").reason, "credentials_not_allowed");

// verification_requested now sits on the slow 10s tier: the next event is the
// user's own verification response, not a worker decision.
const activeReview = taskRefreshMetadata({
  tasks: [
    {
      taskId: "task_review_loop",
      statusKey: TASK_STATUS.verificationRequested,
    },
  ],
});
assert.equal(activeReview.requiresRefresh, true);
assert.equal(activeReview.nextPollMs, 10000);
assert.equal(activeReview.forceProjectionRefresh, false);
assert.equal(activeReview.refreshReason, "task_state_active");
assert.deepEqual(activeReview.refreshTaskIds, ["task_review_loop"]);

const submittedReviewLoop = taskRefreshMetadata({
  tasks: [{ taskId: "task_submitted", statusKey: TASK_STATUS.submitted }],
});
assert.equal(submittedReviewLoop.requiresRefresh, true);
assert.equal(submittedReviewLoop.nextPollMs, 2500);
assert.equal(submittedReviewLoop.forceProjectionRefresh, true);
assert.equal(submittedReviewLoop.refreshReason, "task_review_active");

const rewardDecidedLoop = taskRefreshMetadata({
  tasks: [{ taskId: "task_reward_decided", statusKey: TASK_STATUS.rewardDecided }],
});
assert.equal(rewardDecidedLoop.requiresRefresh, true);
assert.equal(rewardDecidedLoop.nextPollMs, 2500);
assert.equal(rewardDecidedLoop.forceProjectionRefresh, true);
assert.deepEqual(rewardDecidedLoop.refreshTaskIds, ["task_reward_decided"]);

const acceptedOpenLoop = taskRefreshMetadata({
  tasks: [{ taskId: "task_accepted", statusKey: TASK_STATUS.accepted }],
});
assert.equal(acceptedOpenLoop.requiresRefresh, true);
assert.equal(acceptedOpenLoop.nextPollMs, 10000);
assert.equal(acceptedOpenLoop.forceProjectionRefresh, false);
assert.equal(acceptedOpenLoop.refreshReason, "task_state_active");
assert.deepEqual(acceptedOpenLoop.refreshTaskIds, ["task_accepted"]);

const processingRequestRefresh = taskRefreshMetadata({
  activeRequestCount: 1,
});
assert.equal(processingRequestRefresh.requiresRefresh, true);
assert.equal(processingRequestRefresh.nextPollMs, 2500);
assert.equal(processingRequestRefresh.forceProjectionRefresh, true);
assert.equal(processingRequestRefresh.refreshReason, "task_requests_active");

const pendingGeneratedProjection = taskRefreshMetadata({
  handoffProjectionPending: true,
});
assert.equal(pendingGeneratedProjection.requiresRefresh, true);
assert.equal(pendingGeneratedProjection.nextPollMs, 2500);
assert.equal(pendingGeneratedProjection.forceProjectionRefresh, true);
assert.equal(pendingGeneratedProjection.refreshReason, "task_request_handoff_projection_pending");
assert.equal(pendingGeneratedProjection.handoffProjectionPending, true);
assert.deepEqual(pendingGeneratedProjection.refreshTaskIds, []);

const terminalReward = taskRefreshMetadata({
  tasks: [
    {
      taskId: "task_rewarded",
      statusKey: TASK_STATUS.rewarded,
    },
  ],
});
assert.equal(terminalReward.requiresRefresh, false);
assert.equal(terminalReward.forceProjectionRefresh, false);
assert.deepEqual(terminalReward.refreshTaskIds, []);

const laggedProposedTask = taskRefreshMetadata({
  tasks: [{ taskId: "task_proposed", statusKey: TASK_STATUS.proposed }],
  projectionRefreshRequired: true,
  projectionRefreshReason: "task_projection_indexing_lag",
});
assert.equal(laggedProposedTask.requiresRefresh, true);
assert.equal(laggedProposedTask.nextPollMs, 2500);
assert.equal(laggedProposedTask.forceProjectionRefresh, true);
assert.equal(laggedProposedTask.refreshReason, "task_projection_indexing_lag");
assert.deepEqual(laggedProposedTask.refreshTaskIds, []);

assert.equal(
  isProjectionBehindCachedPointer(
    {
      source: "direct_write",
      last_event_tx_hash: "offchain:evt_direct_submit",
      last_event_cid: "postgres:evt_direct_submit",
      metadata_json: { offchainLifecycle: { enabled: true, dualWrite: false } },
    },
    {
      tx_hash: "OLD_POINTER_TX",
      cid: "QmOldPointerCid",
      pointer_kind: "TASK_SUBMISSION",
    }
  ),
  false,
  "direct-write projections are authoritative over stale lifecycle pointers"
);
assert.equal(
  isProjectionBehindCachedPointer(
    {
      source: "direct_write",
      last_event_tx_hash: "offchain:evt_direct_submit",
      last_event_cid: "postgres:evt_direct_submit",
      metadata_json: { offchainLifecycle: { enabled: true, dualWrite: false } },
    },
    {
      tx_hash: "REWARD_POINTER_TX",
      cid: "QmRewardPointerCid",
      pointer_kind: "REWARD",
    }
  ),
  true,
  "reward anchors remain pointer-backed integrity signals"
);

console.log("task lifecycle smoke ok");
