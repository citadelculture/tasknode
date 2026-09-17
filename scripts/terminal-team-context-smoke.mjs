import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

if (!new URL(process.env.DATABASE_URL || "postgresql://localhost/missing").pathname.endsWith("_test")) {
  throw new Error("terminal_team_context_requires_disposable_test_database");
}
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_TEAM_ENABLED = "true";
const { query, closePool } = await import("../server/db/pool.js");
const { getOrCreateProviderAccount } = await import("../server/repositories/accounts.js");
const auth = await import("../server/repositories/terminal-auth.js");
const team = await import("../server/repositories/team-context.js");
const { handleTaskNodeTerminalRoute } = await import("../server/tasknode-terminal-routes.js");
const { routePolicyForPath } = await import("../server/route-policies.js");
const route = "/api/terminal/tasknode/team/context";
assert.equal(routePolicyForPath(route).auth, "bearer");
assert.deepEqual(routePolicyForPath(route).methods, ["GET"]);
const suffix = randomUUID();
async function identity(label) {
  const account = await getOrCreateProviderAccount({ provider: "github", providerUserId: `${label}-${suffix}`, username: `${label}-${suffix}`, displayName: label });
  const request = await auth.createTerminalAuthRequest({ provider: "github", origin: "http://127.0.0.1" });
  assert.equal((await auth.completeTerminalAuthRequest({ requestId: request.requestId, accountId: account.id, provider: "github" })).ok, true);
  const session = await auth.consumeTerminalAuthRequestSession({ requestId: request.requestId, pollToken: request.pollToken });
  return { accountId: account.id, token: session.terminalToken };
}
const alice = await identity("viewer");
const bob = await identity("collaborator");
const eve = await identity("unrelated");
const grant = randomUUID();
await query(`INSERT INTO task_history_grants (grant_id, subject_account_id, viewer_account_id, subject_wallet_address, canonical_payload, wallet_signature, signer_public_key, signature_hash) VALUES ($1,$2,$3,'rFixture','{}'::jsonb,'fixture','fixture',$4)`, [grant,bob.accountId,alice.accountId,suffix]);
await team.enqueueTeamContextReport({ accountId: alice.accountId });
const job = (await query("SELECT * FROM team_context_jobs WHERE account_id=$1", [alice.accountId])).rows[0];
await team.completeTeamContextJob({ job, report: { overview: "Shared fixture overview", members: [{ account_id: bob.accountId, focus: "Fixture shared focus", completed_changes: ["Fixture shared change"], operational_effect: "Fixture shared effect", recent_work: "Fixture shared summary" }] } });
function json(res,status,body) { res.writeHead(status,{"content-type":"application/json"}); res.end(JSON.stringify(body)); }
const server = createServer(async (req,res) => {
  try {
    const handled = await handleTaskNodeTerminalRoute({ req,res,json,readJson: async () => ({}),url: new URL(req.url,"http://127.0.0.1"),origin:"http://127.0.0.1",responseHeadersForAuthResult:()=>({}) });
    if (!handled) json(res,404,{error:"not_found"});
  } catch (error) { json(res,500,{error:error.message}); }
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
async function request(token,method="GET",search="") {
  const result = await fetch(`http://127.0.0.1:${server.address().port}${route}${search}`,{method,headers: token?{authorization:`Bearer ${token}`}:{}});
  return {status:result.status,body:await result.json()};
}
try {
  assert.equal((await request()).status,401);
  assert.equal((await request("invalid")).status,401);
  for (const method of ["POST","PATCH","DELETE"]) assert.equal((await request(alice.token,method)).status,405);
  const actual = await request(alice.token);
  assert.equal(actual.status,200);
  assert.deepEqual(actual.body,await team.getTeamContextState({accountId:alice.accountId}));
  assert.equal(actual.body.members[0].focus,"Fixture shared focus");
  assert.deepEqual((await request(alice.token,"GET",`?accountId=${eve.accountId}`)).body,actual.body);
  const unrelated=await request(eve.token,"GET",`?accountId=${alice.accountId}`);
  assert.deepEqual(unrelated.body.members,[]);
  assert.equal(JSON.stringify(unrelated.body).includes("Fixture shared"),false);
  process.env.TASKNODE_TEAM_ENABLED="false";
  assert.equal((await request(alice.token)).status,503);
  process.env.TASKNODE_TEAM_ENABLED="true";
  await query("UPDATE task_history_grants SET status='revoked' WHERE grant_id=$1",[grant]);
  const revoked=await request(alice.token);
  assert.deepEqual(revoked.body.members,[]);
  assert.equal(revoked.body.overview,"");
  assert.equal(JSON.stringify(revoked.body).includes("Fixture shared"),false);
  await auth.revokeTerminalSessionByToken(alice.token);
  assert.equal((await request(alice.token)).status,401);
  console.log("terminal Team Context: passed auth, read-only methods, web parity, account isolation, feature gate, grant revocation and session revocation");
} finally {
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await closePool();
}
