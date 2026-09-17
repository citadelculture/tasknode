// Single source of truth for task step limits.
//
// Steps are free-form operator text persisted as JSONB. The only hard
// requirement is "enough steps to act on"; count and length caps exist to bound
// display and payload size, never as a reason to discard a model generation.
// Consumers must clamp with normalizeTaskSteps, not reject.
export const TASK_MIN_STEPS = 2;
export const TASK_MAX_STEPS = 12;
export const TASK_STEP_MAX_CHARS = 8000;

export function normalizeTaskSteps(value, { clean = (text, max) => String(text || "").trim().slice(0, max) } = {}) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((step) => (typeof step === "string" ? clean(step, TASK_STEP_MAX_CHARS) : ""))
    .filter(Boolean)
    .slice(0, TASK_MAX_STEPS);
}
