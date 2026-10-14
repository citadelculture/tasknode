import assert from "node:assert/strict";

// Exercise the real report and inference pipeline; replace only provider IO.
// No real provider credential, request, operator packet or database is needed.
process.env.TASKNODE_DATABASE_ENABLED = "false";
process.env.VERCEL_AI_GATEWAY_API_KEY = "synthetic-global-token-fixture";
process.env.AMBIENT_API_KEY = "";
process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK = "false";
process.env.TASKNODE_HIVE_REPORT_MODEL = "zai/glm-5.3";
globalThis.fetch = () => { throw new Error("unexpected_live_fetch"); };
const { generateHiveReportMarkdown } = await import("../server/hive-report-provider.js");

let requests = 0;
const failures = [];
function expectTokens(actual, expected, label) {
  if (actual !== expected) failures.push({ label, actual, expected });
}
async function tokenLimit(type, globalValue, specificValue) {
  for (const [key, value] of [
    ["TASKNODE_HIVE_REPORT_MAX_TOKENS", globalValue],
    ["TASKNODE_BOARD_MANAGER_PLANNING_REPORT_MAX_TOKENS", specificValue],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let maxTokens;
  const report = await generateHiveReportMarkdown({
    type,
    sourcePacket: {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(Object.hasOwn(body, "max_tokens"));
      maxTokens = body.max_tokens;
      requests += 1;
      return new Response(JSON.stringify({
        id: "synthetic-global-token-response",
        choices: [{ message: { content: "# Synthetic report\n\nToken configuration regression." } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.ok(report.bodyMarkdown.includes("Synthetic report"));
  return maxTokens;
}

for (const [type, fallback, floor] of [
  ["hive_intelligence", 24000, 24000],
  ["board_manager_planning", 14000, 14000],
  ["development", 9000, 3000],
]) {
  // All previously valid/default settings keep their original behavior.
  for (const [globalValue, expected] of [
    [undefined, fallback], ["", fallback], ["   ", fallback],
    ["0", fallback], ["-20", floor], ["4000", Math.max(floor, 4000)],
    ["18000", Math.max(floor, 18000)], ["32000", 32000],
    ["1.8e4", Math.max(floor, 18000)], ["0.5", floor],
  ]) {
    expectTokens(await tokenLimit(type, globalValue), expected, `${type}: finite/default ${globalValue}`);
  }
  // Non-finite and malformed global inputs use the normal per-type fallback.
  for (const globalValue of ["Infinity", "-Infinity", "1e999", "-1e999", "NaN", "15s"]) {
    expectTokens(await tokenLimit(type, globalValue), fallback, `${type}: malformed global ${globalValue}`);
  }
}
for (const globalValue of [undefined, "18000", "Infinity", "1e999"]) {
  expectTokens(await tokenLimit("board_manager_planning", globalValue, "16000"), 16000, "valid planning override16000");
  expectTokens(await tokenLimit("board_manager_planning", globalValue, "0"), 14000, "valid planning override0");
}
assert.equal(requests, 56);
if (failures.length) console.error(JSON.stringify({ syntheticRequests: requests, failures }));
assert.equal(failures.length, 0, "global token fallback controls must pass");
console.log("hive report global token fallback smoke ok: 56 real-pipeline synthetic requests, finite defaults/floors and valid planning overrides preserved");
