# Daily Airdrop

Daily Airdrop is an account-level private scoring job. It reviews the member's recent rewarded task work and produces a proposed daily PFT airdrop plus a short explanation of what raised the score, what lowered it, and what to improve tomorrow.

Current status: recurring scoring, live issuance, stale recovery, and catch-up retries are implemented behind `TASKNODE_DAILY_AIRDROP_WORKER_ENABLED=true`. A scoring run writes `profile_daily_airdrop_runs`; issuance claims exactly one `profile_daily_airdrop_issuances` row as `processing_pre_submit`, marks it `submitting` before calling PFTL submit, and then records `submitted` only after a transaction hash is persisted. The worker also writes a `Hive Mind Agent` audit card summarizing how much PFT was dispensed, which run dates were checked, and any unresolved airdrop debt.

### Private Profile Read Path

The private profile top section reads the latest completed run through `GET /api/profile/daily-airdrop`. The large headline is the daily airdrop amount only. It says `Today's airdrop` only when that airdrop was scored or paid on the current UTC date; otherwise it says `Latest airdrop`.

Profile copy distinguishes scored from paid state. When an issuance is not `submitted`, the headline says the airdrop was scored but not paid yet and shows the current payout status such as `Retry pending`, `Preparing payout`, or `Needs reconciliation`. The reward chart only counts submitted airdrops as earned PFT.

The panel shows two labelled numbers. `Work quality (day) / 100` uses the latest run's `retention_value_score` (API `retentionValueScore`), the model's assessment of recent rewarded work; it does not divide the payout by the daily maximum and the tooltip says it is independent of the PFT payout. `Alignment (7d) / 100` is `alignment_score_7d × 100`, the same deterministic 7-day airdrop share the directory ranks by and public profiles show, so the profile and directory no longer show different numbers under one name. An unavailable score is shown as `— / 100`; a real zero is shown as `0 / 100`. Existing completed runs immediately use their stored model score, without rescoring or changing payments.

Displayed airdrop values come from:

- `daily_airdrop_pft`;
- `run_mode`;
- `completed_at`;
- `actual_airdrop_pft_7d`;
- `max_possible_airdrop_pft_7d`;
- `alignment_score_7d`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `reasoning_text`;
- `input_snapshot.airdrop_recipient`;
- `input_snapshot.reward_totals`.

The adjacent reward chart uses `GET /api/profile/reward-history?range=7d|28d|90d`. It is based on actual positive `reward_actual_pft` task projections, submitted daily airdrop issuances, and reward event timestamps. It intentionally renders one earned-PFT series until task reward categories are real data. The chart total can be much larger than the daily airdrop headline because it includes task rewards; the UI must keep those labels separate.

The task count in the airdrop explanation may be larger than the current Tasks
tab reward count. Daily Airdrop counts recent positive rewards across the
account's identity wallet cloud, including historical user wallets that remain
attached for attribution. The current Tasks tab may be scoped to the active
wallet projection. The profile copy should make this clear when showing airdrop
reasoning.

### Evidence Packet

The scorer builds one compact task reward packet from Postgres wallet, task
projection, and task reward-event facts. The worker path must not depend on
`runtime-store.js` for wallet identity because Fly `app` and `worker` processes
do not share app-local runtime memory or files.

Included work:

- only tasks tied to the account's durable identity wallet cloud from
  `pftl_sync_wallets`;
- only tasks with `reward_paid_pft > 0`;
- only tasks inside the trailing lookback window, currently 7 days;
- task title, kind, status, reward offer, reward outcome, reward reason, completion score, evidence quality, event CIDs, and transaction hashes.

Excluded work:

- zero-reward tasks;
- tasks from wallets not in the account wallet cloud;
- raw evidence blobs unless a later version explicitly needs them.

### Identity Cloud

The airdrop is one score per identity cloud, not one score per wallet. An account can link, delink, and relink multiple PFT wallets over time, but daily scoring remains keyed by `account_id` and `run_date`. The wallet cloud is for attribution and recipient selection; it is not a payout fanout list.

The worker-visible identity wallet cloud is built from `pftl_sync_wallets`:

- active `role = 'user'` rows are treated as currently linked wallets;
- inactive `role = 'user'` rows are treated as historical identity-cloud wallets;
- non-user roles such as `allocation_reward`, authority, and funding wallets are
  excluded.

This prevents a user from farming airdrops by rotating wallets and prevents Task Node authority/funding wallets from being selected just because they appear in chain replay rows.

`runtime-store.js` can describe the signed-in app session, but it is not the
daily-airdrop worker source of truth. If a wallet link or delink changes user
identity, the wallet sync registry must also be updated so the worker can build
the same identity cloud from Postgres.

### Recipient Wallet

Recipient selection is deterministic metadata, not model reasoning.

Each completed airdrop run has exactly one `recipient_wallet`. Even when the
identity cloud contains multiple current or historical wallets, issuance pays one
wallet for that account/day.

The selected recipient wallet is chosen from eligible identity-cloud wallets by:

1. highest all-time task count in `task_projections`;
2. rewarded task count;
3. total rewarded PFT;
4. most recent task update;
5. active linked wallet;
6. wallet address as final stable ordering.

The scoring snapshot stores deterministic selector facts:

```json
{
  "wallet_address": "r...",
  "selection_status": "selected",
  "selection_basis": "identity_cloud_all_time_task_count",
  "selected_active_wallet": true,
  "task_count": 20,
  "rewarded_task_count": 12,
  "reward_paid_pft": 20.45,
  "last_task_at": "2026-05-20T17:40:48.585Z",
  "candidate_wallet_count": 2
}
```

There is no `selection_reason` prose field. The fields above are enough to audit why the wallet was selected.

### Model Score

The prompt is `prompts/profile/daily_airdrop_v1.md`.

Runtime call sites:

- `server/profile-daily-airdrop.js::runDailyAirdropScore`
- `server/profile-daily-airdrop-worker.js::runDailyAirdropWorkerOnce`
- `server/profile-daily-airdrop-worker.js::startDailyAirdropWorker`
- `scripts/profile-daily-airdrop-score.mjs`
- `scripts/profile-daily-airdrop-worker.mjs`

Provider policy:

- model: Vercel `zai/glm-5.3` with Ambient backup by default;
- provider: `vercel` through the shared strict-JSON capability, with Ambient backup;
- temperature `0`;
- structured JSON output;
- no user billing in v1.

The model returns:

- `daily_airdrop_pft`;
- `retention_value_score`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `eligibility_status`;
- `eligibility_reason`;
- `reasoning_text`.

`reasoning_text` is contributor reasoning. It explains why the member's task packet merits the proposed airdrop. Recipient wallet selection is deterministic and separate from contributor reasoning.

The prompt declares an explicit trust boundary: task titles, reward reasons, and
any quoted evidence or feedback inside `rewarded_tasks` are user-influenced text
and are scored as untrusted data, never followed as instructions. Embedded
amount demands or scorer instructions are treated as fraud signals that lower
the score.

The paid amount is also deterministically capped in code, independent of the
model. By default the live cap is only the historical daily maximum:

```text
daily_airdrop_pft <= TASKNODE_DAILY_AIRDROP_MAX_PFT   # default 10000
```

Operators may opt into an additional proportional cap by setting
`TASKNODE_DAILY_AIRDROP_MAX_REWARD_FRACTION`. When that secret is set, the paid
amount is also capped at
`floor(max_reward_fraction * reward_totals.total_reward_paid_pft)`. The default
is unset, not `0.5`, so deploying the airdrop hardening path does not slash
normal airdrops. The run's `output_json.normalized.deterministic_cap` records
`max_daily_pft`, `max_reward_fraction`, `total_reward_paid_pft`, the resulting
`reward_fraction_cap_pft`, the raw `model_daily_airdrop_pft`, and a `cap_bound`
flag so operators can audit when any configured cap clamped the model.

### Alignment Score

The retained `alignment_score_7d` field is deterministic and is not an LLM output. It is displayed as `Alignment (7d)` on the profile panel, public profiles, and the directory, always labelled with its window.

```text
alignment_score_7d =
  actual_airdrop_pft_7d
  /
  max_possible_airdrop_pft_7d
```

The denominator is the sum of each counted airdrop run's max possible amount. It is not blindly `max_daily_pft * 7`.

Examples:

- one dry run proposes `600 PFT` with a `10000 PFT` max: `600 / 10000 = 0.06`;
- seven completed production runs each with a `10000 PFT` max: denominator is `70000 PFT`.

During the scoring-only phase, `actual_airdrop_pft_7d` means completed dry-run or production scoring rows that are explicitly counted by the run. Once live issuance exists, it should mean actually issued production PFT.

### Database

`profile_daily_airdrop_runs` stores scoring runs.

Important fields:

- `account_id`;
- `run_date`;
- `run_mode`: `dry_run` or `production`;
- `scenario_id`;
- `status`;
- `daily_airdrop_pft`;
- `retention_value_score`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `reasoning_text`;
- `actual_airdrop_pft_7d`;
- `max_possible_airdrop_pft_7d`;
- `alignment_score_7d`;
- `input_snapshot`;
- `output_json`;
- provider/model/prompt metadata.

The production uniqueness boundary is one production scoring row per account per UTC day. Dry runs can be repeated for prompt and packet testing.

The worker is fail-closed before creating a production run: if candidate
selection finds a positive rewarded-task account but the scoring packet contains
zero eligible wallets, zero rewarded tasks, or zero rewarded PFT, scoring throws
`daily_airdrop_packet_candidate_mismatch`. That state is a data-boundary failure,
not an eligible zero-airdrop result.

`profile_daily_airdrop_issuances` stores live payment submissions. It is keyed by `run_id` and prevents more than one submitted issuance per account/day. The recurring worker treats pending, in-flight, submit-unknown, submitted, and cancelled issuance rows as stop rows for new scoring. Retryable pre-submit failures are handled by the issuance retry path instead of selecting the account as a fresh candidate.

Failed `profile_daily_airdrop_runs` rows are scoring-path state, not money-path state. Debt tooling and the system-status airdrop row report them with the raw run status `failed` and `nextAction=retry_scoring` (never `failed_before_submit`/`retry_issuance`, which are issuance labels). A failed production scoring row for the same account/day may be reclaimed by the next worker tick, which resets the row to `running` with the new packet and prompt metadata. Completed or running production scoring rows still suppress repeat scoring. Fresh in-flight rows (`running` scoring younger than `TASKNODE_DAILY_AIRDROP_SCORE_STALE_MINUTES`, `processing_pre_submit` issuances younger than `TASKNODE_DAILY_AIRDROP_PRE_SUBMIT_STALE_MINUTES`) are normal payout-tick state and are not counted as debt by the system-status row.

Issuance state is intentionally conservative:

- `pending`: durable row exists but no publish worker has claimed it.
- `processing_pre_submit`: a worker has claimed the run and may pin/sign, but has not attempted PFTL submission.
- `failed_before_submit`: no PFT submission was attempted. This state is safe for bounded automatic retry.
- `submitting`: the signed transaction was recorded and PFTL submission is in progress.
- `submit_unknown`: submission may have reached PFTL, but the final tx proof was not persisted. This blocks retry until reconciliation. Reconciliation hot-syncs both money-path wallets before searching the cache and records both `last_hot_sync_at` watermarks in `reconciliation_json`; `--allow-demote` is refused while either watermark predates `submission_attempted_at` (override only with `--force-demote-stale-sync`).
- `submitted`: the PFTL payment and pointer are persisted with transaction hash, pointer CID, payload digest, and ledger index.
- `cancelled`: an operator intentionally closed the row without retry.

Legacy `failed` rows with empty `tx_hash` and null `submitted_at` are treated as `failed_before_submit` for compatibility. Legacy `processing` rows with a submission timestamp are treated as `submit_unknown`.

### Historical Goodalexander Dry Run

The example dry run uses a synthetic account such as `acct_example_operator`.
This example is retained as an old evidence packet shape, not as current live
eligibility truth.

Observed packet:

- eligible identity-cloud wallets: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`, `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`;
- selected recipient: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`;
- rewarded tasks counted: `12`;
- rewarded task PFT counted: `20.45`;
- paid production airdrop: `600 PFT`;
- alignment score: `0.06`;
- transaction: `B16678C024C0780D12227E9CC9FA4CCB1FA2BA3EC65341BFFAE40FC978FC6AB2`;
- pointer CID: `QmPyxEi3Sk9AXc6QCPJK2M11fb5okTmTuR21VXkxbTuaLo`.

### Recurring Worker

The recurring worker is `server/profile-daily-airdrop-worker.js`. It is started by `server/background-workers.js` when `TASKNODE_DAILY_AIRDROP_WORKER_ENABLED=true`; local Docker enables it in `docker-compose.dev.yml`. The recurring worker scores in `production` mode by default so a completed account/day score suppresses repeat scoring on later ticks. Manual dry runs can use `TASKNODE_DAILY_AIRDROP_WORKER_RUN_MODE=dry_run` or `scripts/profile-daily-airdrop-score.mjs`.

This page is the current product contract for scoring, issuance, retry, and
worker audit behavior. Historical migration planning has been folded into this
surface doc and the Daily Airdrop Worker runbook.

Each tick:

1. claims a Postgres-backed `daily_airdrop` lease using the same lease table as Board Manager so multiple app instances do not run the payout loop at the same time;
2. reclaims stale `running` scoring rows, stale `processing_pre_submit` issuance rows, and stale `submitting` rows before candidate selection;
3. checks today plus the previous `TASKNODE_DAILY_AIRDROP_CATCHUP_DAYS` UTC days, defaulting to two catch-up days;
4. retries `failed_before_submit` issuance rows up to `TASKNODE_DAILY_AIRDROP_MAX_ISSUANCE_ATTEMPTS`;
5. selects accounts with positive rewarded task work, no same-day in-flight/submitted/cancelled issuance stop row, and no same-day running or completed production scoring row;
6. runs the Vercel GLM 5.3 (with Ambient backup) daily airdrop scorer in production mode to create a completed account/day scoring row;
7. issues the specific scoring run through `issueLatestDailyAirdrop` when the proposed amount is positive;
8. records a `board_manager_runs` row with internal action `daily_airdrop` and a `board_manager_action_results` row whose summary reads like: `Dispensed 600 PFT to 1 user as part of daily airdrop.` The audit packet includes `runDatesChecked`, recovered stale rows, and unresolved debt counts. Zero-payout ticks are recorded at most once per UTC day unless there is debt, a failed account, or a submitted payout.

`issueLatestDailyAirdrop` is fail-closed for money. It claims a row as `processing_pre_submit` before signing, writes `submitting` with the signed transaction hash before calling PFTL submission, and writes `submitted` only after tx proof is available. If failure occurs before a PFT submission is attempted, the issuance row is marked `failed_before_submit` and can be retried automatically. If failure occurs after submission is attempted, the row becomes `submit_unknown` so a retry cannot sign another payment until reconciliation has inspected the chain/cache.

A worker crash between completing a positive production scoring run and claiming the issuance row leaves the run with no issuance row at all. Those runs are surfaced as `issuance_missing` debt by `profile-daily-airdrop-debt` and by the system-status airdrop row, and the worker re-claims them through the same fail-closed path on its next tick, so the crash window cannot silently strand an owed payout.

Manual issuance and same-day production repair are privileged operations. Their
target checks, approval receipts, and exact commands live only in the private
operations package. The public source retains deterministic packet and
idempotency tests, not a route to the official worker fleet.

Packet boundary regression:

```bash
npm run profile-daily-airdrop-packet-smoke
```

This smoke inserts a user wallet only through `pftl_sync_wallets`, creates a
positive rewarded task, and verifies that the daily airdrop packet still counts
the wallet and task without using runtime-store state.
