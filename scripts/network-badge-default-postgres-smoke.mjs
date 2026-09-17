import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

// Requires an explicitly supplied disposable database. All fixtures live in an
// isolated schema; the production repository and its SQL execute unchanged.
const url = process.env.TASKNODE_TEST_DATABASE_URL;
assert.ok(url, "TASKNODE_TEST_DATABASE_URL is required");
const schema = `badge_default_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: url });
const testUrl = new URL(url);
testUrl.searchParams.set("options", `-c search_path=${schema}`);
process.env.TASKNODE_DATABASE_ENABLED = "false";
process.env.TASKNODE_PROJECT_LEADER_HIVE_HANDLES = "jollydinger";
process.env.TASKNODE_STORE_PATH = join(mkdtempSync(join(tmpdir(), "badge-default-pg-")), "store.json");
const runtime = await import("../server/runtime-store.js");
const account = runtime.getOrCreateProviderAccount({
  provider: "x", providerUserId: "postgres-badge-default", username: "jollydinger",
  metadata: { publicMetrics: { followersCount: 12000 } },
});
assert.equal(runtime.setAccountHiveHandle({ accountId: account.id, handle: "jollydinger" }).ok, true);
process.env.DATABASE_URL = testUrl.toString();
process.env.TASKNODE_DATABASE_ENABLED = "true";
const db = await import("../server/db/pool.js");
const repo = await import("../server/repositories/identity-approvals.js");
const pool = db.getPool();
const defaults = async () => (await db.query(
  "SELECT badge_id FROM account_network_badges WHERE account_id=$1 AND selected_default AND status='verified' ORDER BY badge_id", [account.id]
)).rows.map(row => row.badge_id);
const refresh = () => repo.refreshIdentityApprovalsFromProjection({ accountId: account.id });
const choose = badgeId => repo.setDefaultNetworkBadge({ accountId: account.id, badgeId });

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.query("CREATE TABLE app_accounts (account_id text PRIMARY KEY, account_json jsonb NOT NULL)");
  await db.query("CREATE TABLE task_projections (account_id text, task_kind text, status text)");
  await db.query(readFileSync(new URL("../server/db/migrations/072_network_badges_identity_approvals.sql", import.meta.url), "utf8"));
  await db.query("INSERT INTO app_accounts VALUES ($1,$2::jsonb)", [account.id, JSON.stringify(runtime.getAccount(account.id))]);
  await refresh();
  assert.deepEqual(await defaults(), ["kol"]);
  await choose("project_leader");
  await refresh();
  assert.deepEqual(await defaults(), ["project_leader"], "sequential refresh preserves selection");
  console.log("PASS sequential durable selection");

  // Hold the real refresh immediately after its selection read, then issue a
  // concurrent real save. Without serialization the save commits first and the
  // refresh later overwrites it with its stale snapshot.
  if (process.env.BADGE_DEFAULT_CASE !== "eligibility") {
  await choose("kol");
  let releaseRead;
  let reachedRead;
  const readReached = new Promise(resolve => { reachedRead = resolve; });
  const readRelease = new Promise(resolve => { releaseRead = resolve; });
  const originalConnect = pool.connect.bind(pool);
  let interceptNext = true;
  let selectionPid;
  pool.connect = async (...args) => {
    if (typeof args[0] === "function") return originalConnect(...args);
    const client = await originalConnect(...args);
    if (!interceptNext) {
      selectionPid = client.processID;
      return client;
    }
    interceptNext = false;
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      const result = await originalQuery(sql, params);
      if (/SELECT badge_id\s+FROM account_network_badges/.test(String(sql))) {
        reachedRead();
        await readRelease;
      }
      return result;
    };
    const originalRelease = client.release.bind(client);
    client.release = (...releaseArgs) => {
      client.query = originalQuery;
      client.release = originalRelease;
      return originalRelease(...releaseArgs);
    };
    return client;
  };
  const concurrentRefresh = refresh();
  await readReached;
  let selectionFinished = false;
  const concurrentSelection = choose("project_leader").then(value => { selectionFinished = true; return value; });
  try {
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (!selectionFinished && !blocked && Date.now() < deadline) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'", [selectionPid || 0]);
      blocked = result.rowCount > 0;
      if (!blocked && !selectionFinished) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(selectionFinished || blocked, "save must commit or demonstrably wait on the account lock");
  } finally {
    releaseRead();
    pool.connect = originalConnect;
    await Promise.all([concurrentRefresh, concurrentSelection]);
  }
  assert.deepEqual(await defaults(), ["project_leader"], "concurrent save must survive refresh");
  console.log("PASS concurrent save survives paused refresh");
  }

  // A valid operator default outside the runtime projection remains selected.
  await db.query("INSERT INTO account_network_badges (id,account_id,badge_id,status,evidence_json) VALUES ('manual',$1,'core_contributor','verified','{\"source\":\"operator_manual_approval\"}')", [account.id]);
  await choose("core_contributor");
  await refresh();
  assert.deepEqual(await defaults(), ["core_contributor"]);
  console.log("PASS valid manual default outside projection");

  // Keep KOL metrics but remove its public handle from the actual account.
  await choose("kol");
  const missingHandle = structuredClone(runtime.getAccount(account.id));
  for (const identity of missingHandle.linkedProviders || []) identity.username = "";
  await db.query("UPDATE app_accounts SET account_json=$2::jsonb WHERE account_id=$1", [account.id, JSON.stringify(missingHandle)]);
  const result = await refresh();
  assert.ok(result.projection.verifiedBadgeIds.includes("kol"), "fixture must still project metric-only KOL");
  assert.ok(!result.materialized.badgeIds.includes("kol"), "KOL without handle must not materialize");
  assert.deepEqual(await defaults(), ["project_leader"], "skipped old KOL default must not suppress fallback");
  console.log("PASS missing-handle KOL default replaced by materialized fallback");
} finally {
  await db.closePool();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
