import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { claimPftlReducerEvents } from "../server/pftl-cache-reducer.js";

const url = process.env.TASKNODE_TEST_DATABASE_URL;
assert.ok(url, "TASKNODE_TEST_DATABASE_URL must point to a disposable test database");
const schema = `reducer_redrive_${process.pid}_${Date.now()}`;
const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(readFileSync(new URL("../server/db/migrations/008_pftl_cache_watcher.sql", import.meta.url), "utf8"));
  await client.query("BEGIN");
  // PostgreSQL now() stays constant throughout this transaction, so equality
  // tests measure the exact strict boundary without a wall-clock race.
  const fixtures = [
    ["elapsed", "failed", 2, 121, "target"],
    ["unelapsed", "failed", 2, 119, "target"],
    ["boundary", "failed", 2, 120, "target"],
    ["final", "failed", 49, 3601, "target"],
    ["capped", "failed", 50, 3601, "target"],
    ["stale", "processing", 5, 601, "target"],
    ["fresh", "processing", 5, 599, "target"],
    ["completed", "completed", 3, 3601, "target"],
    ["other", "failed", 2, 121, "other_task"],
  ];
  for (const [name, status, attempts, age, task] of fixtures) {
    await client.query(`INSERT INTO pftl_cache_reducer_events
      (dedupe_key,wallet_address,tx_hash,reducer_kind,task_id,status,attempts,updated_at)
      VALUES ($1,'fixture_wallet',$1,'task',$2,$3,$4,now()-($5*interval '1 second'))`,
    [name, task, status, attempts, age]);
  }
  const before = (await client.query("SELECT * FROM pftl_cache_reducer_events WHERE dedupe_key='completed'")).rows[0];
  const options = { limit: 100, taskId: "target", databaseEnabledImpl: () => true, transactionImpl: work => work(client) };
  const claimed = await claimPftlReducerEvents(options);
  assert.deepEqual(claimed.map(row => row.dedupe_key).sort(), ["elapsed", "final", "stale"]);
  const rows = (await client.query("SELECT * FROM pftl_cache_reducer_events")).rows;
  const state = Object.fromEntries(rows.map(row => [row.dedupe_key, row]));
  assert.equal(state.final.attempts, 50, "49 receives its final claim");
  assert.equal(state.capped.status, "failed", "50 must not be re-driven");
  assert.equal(state.capped.attempts, 50);
  for (const name of ["unelapsed", "boundary"]) assert.equal(state[name].status, "failed", name);
  assert.equal(state.stale.attempts, 6);
  assert.equal(state.fresh.status, "processing");
  assert.equal(state.fresh.attempts, 5);
  assert.equal(state.other.status, "pending", "retry scheduling is global; claiming remains task-filtered");
  assert.equal(state.other.attempts, 2);
  assert.deepEqual(state.completed, before, "completed row must remain byte-for-byte equivalent");
  assert.deepEqual(await claimPftlReducerEvents(options), [], "no immediate duplicate claim");
  await client.query("UPDATE pftl_cache_reducer_events SET status='failed',updated_at=now()-interval '2 hours' WHERE dedupe_key='final'");
  assert.deepEqual(await claimPftlReducerEvents({ ...options, txHash: "final" }), [], "final claim must not renew after reaching50");
  await client.query("ROLLBACK");
  console.log("pftl reducer redrive postgres smoke ok: elapsed/unelapsed/equality,49->50,cap,stale processing,task filter,completed unchanged,no duplicate");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release();
  await pool.end();
}
