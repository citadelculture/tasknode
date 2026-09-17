# Deathmarch Local Harness

`deathmarch` is a local-only Discord posting harness for Task Node task events. It does not start the Task Node app.

The harness watches or ingests Task Node PFTL task actions, asks GLM 5.3 through Vercel first, with Ambient backup, to summarize what the user just did, and posts the resulting plain-English update to the Discord Death March channel.

Default watched wallet:

```text
rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx
```

## Team fan-out

The watched wallet's account is treated as the manager. On every poll the
harness resolves the team from the collaboration database: each account with
an active `task_history_grants` row where the manager is the viewer (that is,
a direct report or collaborator whose task history is shared with the manager)
is polled too, through both the PFTL wallet history and direct-write
`task_events` rows (matched by wallet or `account_id`). Every post is
attributed with the member's public hive handle as a header line
(`**@handle** · **Evidence submitted**`).

- Accounts related to the manager but without an incoming task-history grant
  are skipped and logged as `deathmarch_member_skipped:<account_id>:task_history_not_shared`;
  they are never polled and their handles are never logged.
- Accounts without a linked wallet are skipped as `wallet_not_linked`.
- One on-chain/off-chain event is one post: the tx-based `eventKey` dedupes
  across feeds and members inside a batch, and the state file dedupes across
  restarts.
- The handle is attribution only. It is added outside the sanitized packet, so
  the classifier and summarizer never see it and redaction is unchanged.

Configuration:

```bash
export DEATHMARCH_WALLET_HANDLE=goodalexander   # header handle for the watched wallet
export DEATHMARCH_TEAM_ACCOUNT_ID=acct_...      # optional; default resolves from the wallet
export DEATHMARCH_TEAM_FANOUT=false             # single-wallet mode
export DEATHMARCH_MEMBERS="alphadev=rWallet1,betadev=rWallet2"   # explicit list, bypasses the database lookup
```

Before enabling fan-out on an existing deployment run `--mark-existing` once so
the members' historical events are recorded as seen instead of being posted as
a backlog.

The local proxy unit `ops/systemd/tasknode-mpg-proxy.service` must point at the
cluster production is attached to (`zp2wjrejjv5odn4q` since the 2026-08-31
recovery); a proxy left on the previous cluster silently empties the
`task_events` feed while the wallet feed keeps working.

## Configuration

Required:

```bash
export AMBIENT_API_KEY=...
export DEATHMARCH_DISCORD_WEBHOOK_URL=...
```

`DEATHMARCH_DISCORD_WEBHOOK_URL` should be a webhook created for the Discord Death March channel.

Bot-token mode is also supported:

```bash
export DISCORD_BOT_TOKEN=...
export DEATHMARCH_DISCORD_CHANNEL_ID=...
```

Optional:

```bash
export DEATHMARCH_WALLET=rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx
export DEATHMARCH_SEED_FILE=deathmarchseed.txt
export DEATHMARCH_AMBIENT_MODEL=z-ai/glm-5.2
export DEATHMARCH_AMBIENT_CLASSIFY_MODEL=z-ai/glm-5.2
export DEATHMARCH_AMBIENT_TIMEOUT_MS=20000
export DEATHMARCH_DISCORD_TIMEOUT_MS=10000
export DEATHMARCH_ANONYMITY_LEVEL=3
export DEATHMARCH_STATE_PATH=.deathmarch-state.json
```

`DEATHMARCH_ANONYMITY_LEVEL` is a redaction floor, not a disclosure override.
The per-event classifier can always choose a lower, more restrictive level.
The effective level is `min(DEATHMARCH_ANONYMITY_LEVEL, classified level)`.

`DEATHMARCH_AMBIENT_MAX_TOKENS` is intentionally unset by default. Set it only
for a temporary provider-cost cap. If Ambient returns an empty content message
after spending tokens on reasoning, Deathmarch falls back to deterministic event
formatting for that task packet instead of dropping the event.

Wallet polling uses the existing PFTL history helper. In local dev, sourcing
`.env.tasknodeofficial-dev` is enough: when `PFTL_HISTORY_*` is not configured,
the helper inherits `PFTL_WSS_URL`, `PFTL_RPC_URL`, and their fallbacks. Set
history-specific endpoints only when you intentionally want archive lookup:

```bash
export PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org
export PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/
```

If encrypted task payloads need to be decrypted, the local environment also needs the Task Node service/encryption seed already used by the repo:

```bash
export TASKNODE_SERVICE_SEED=...
```

As a local-only convenience, `deathmarch` also auto-loads `deathmarchseed.txt` from the current repo directory when no service seed env var is already configured. When using the npm script from `tasknode`, it also checks one directory above the repo, which covers `/home/pfrpc/repos/deathmarchseed.txt`. The file is gitignored. You can point at a different file with:

```bash
npm run deathmarch -- --poll --seed-file /path/to/deathmarchseed.txt
```

If the seed file is a 24-word Task Node wallet mnemonic, it is used as the local user decryption identity. If it is a service seed and no service seed env var is already configured, it is used as `TASKNODE_SERVICE_SEED`. The harness does not print the seed.

## Data Feed

Wallet mode reads the local PFTL feed for the configured wallet and, when
`DATABASE_URL` is configured, also reads recent direct-write `task_events` rows
for that wallet. This is required because the production task lifecycle can run
with `TASKNODE_OFFCHAIN_TASK_LIFECYCLE=true`, where events have
`source_tx_hash` values such as `offchain:evt_...` and do not appear in PFTL
wallet history.

Local pollers that read Fly `task_events` should use `DEATHMARCH_DATABASE_URL`
pointed at a reachable local Fly MPG proxy, rather than inheriting a Fly-private
`DATABASE_URL` hostname. Set `DEATHMARCH_DATABASE_EVENTS_ENABLED=false` to force
wallet-only mode.

1. `fetchHistoricalAccountTransactions` polls PFTL account history for `DEATHMARCH_WALLET`, defaulting to `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`.
2. `extractPftPointerEvents` extracts `pf.ptr/v4` memo pointers from account transactions.
3. The harness filters pointer kinds to `TASK`, `TASK_UPDATE`, `TASK_SUBMISSION`, and `REWARD`.
4. Each pointer CID is fetched from IPFS through the existing context gateways.
5. Encrypted payloads are decrypted locally with `TASKNODE_SERVICE_SEED`, or with the user mnemonic in `deathmarchseed.txt` when the payload is addressed to that wallet's Task Node encryption key.
6. Direct-write database events are normalized from `task_events.payload_json`
and `task_events.pointer_json`, then deduped with wallet events by event key.

Default PFTL endpoints come from the repo's history RPC helper. Explicit
`PFTL_HISTORY_*` values win. Otherwise the helper uses the app's current
`PFTL_WSS_URL` and `PFTL_RPC_URL` values before falling back to public archive
defaults:

```bash
PFTL_WSS_URL=wss://178.156.143.199:6005
PFTL_RPC_URL=http://178.156.143.199:5005
```

IPFS gateway overrides use:

```bash
TASKNODE_IPFS_GATEWAY=...
TASKNODE_IPFS_GATEWAYS=...
IPFS_GATEWAY_URL=...
```

## Commands

Dry-run the default wallet without posting:

```bash
npm run deathmarch -- --once --dry-run
```

Poll continuously:

```bash
npm run deathmarch -- --poll
```

Before running the poller for the first time, mark the current wallet history as already seen so the bot starts live instead of replaying old task events into Discord:

```bash
npm run deathmarch -- --once --mark-existing --seed-file ./deathmarchseed.txt
```

Poll continuously with an explicit local seed file:

```bash
npm run deathmarch -- --poll --seed-file ./deathmarchseed.txt
```

## Supervised Local Service

The always-on poller runs on the Task Node operator host under user systemd. It
uses a dedicated supervised Fly MPG proxy on local port `16433`; the launch
wrapper reads the current production database credential from the Fly app at
startup and never writes that credential to disk. The supervised path allows 15
seconds to connect and 30 seconds for a query because the database is reached
through a WAN proxy; both remain overrideable with the existing
`DEATHMARCH_DATABASE_*_TIMEOUT_MS` variables.

Repository units:

```text
ops/systemd/tasknode-mpg-proxy.service
ops/systemd/tasknode-deathmarch.service
```

Install or refresh them with symlinks in `~/.config/systemd/user/`, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now tasknode-mpg-proxy.service
systemctl --user enable --now tasknode-deathmarch.service
systemctl --user status tasknode-deathmarch.service
```

Both units use `Restart=always`. An idle Postgres client disconnect is also
handled inside the poller, so it is logged as `deathmarch_database_pool_error`
without terminating Node. Ordinary query failures remain retryable on the next
poll interval.

Before the first supervised start after an outage, use `--mark-existing` to
checkpoint a reviewed backlog when replaying every missed event would flood the
channel. Back up `.deathmarch-state.json` first if later manual replay may be
needed.

Ingest an exported event JSON file:

```bash
npm run deathmarch -- --file docs/verification/evidence/task_8f8ff4b94792842a9b54a63769710afd_double_reward_event_path.json --anonymity 3
```

Run local smoke coverage:

```bash
npm run deathmarch-smoke
```

## Event Scope

The harness handles Task Node task/action schemas:

- `pf.task.request.v1`
- `pf.task.offer.v1`
- `pf.task.update.v1`
- `pf.task.submission.v1`
- `pf.task.verification_response.v1`
- `pf.reward.v1`

It treats `TASK`, `TASK_UPDATE`, and `TASK_SUBMISSION` pointer kinds as in-scope. It reads `REWARD` pointers only when the decrypted payload is `pf.reward.v1`.

## Discord Message Format

Deathmarch posts compact action cards:

```text
**Task proposed**
**Launch Death March Discord Protocol**
A task was proposed to publish safe Discord task updates without exposing private payload details.
Task: `task_cdd241775a0a65ddae909bae3b771d29`
tx: 7005B006FDFF2C30F8914BC050A4B3B6C6FC72305F65A1ACD8CE8CB77BBF7C0C
```

Each event makes two DeepSeek calls before posting: a fast classifier and then
the summarizer. The classifier returns strict JSON
`{level, category, sensitive_entities, sensitive_strategy_details}`.
`sensitive_entities` may contain only exact client/customer or investor names
copied from the event. `sensitive_strategy_details` contains the smallest exact
event substrings that expose concrete secret mechanics. The harness
deterministically replaces those names and spans before the second model call. The
summarizer receives only the packet allowed by that effective level. DeepSeek
writes only the plain-English explanation sentence. The harness adds the action
heading, optional task title when disclosure allows it, task id, and exactly one
`tx:` line. Generated summaries should not echo internal checklists, acceptance
gates, verification rubrics, or color-coded visibility models from the task
brief.

Provider availability is not channel availability. If the Ambient credential
is absent, the classifier or summarizer times out, or the provider returns no
usable text, Deathmarch posts a deterministic level-1 action card containing
only safe directional metadata. The event remains retryable only when Discord
delivery itself fails. The supervised local service loads `AMBIENT_API_KEY`
from the deployed Task Node app into process memory when it is not already
configured locally; it never persists that credential into the repository.

Submission updates must include the submitted artifact or response detail when it is safe to disclose:

```text
**Evidence submitted**
Submitted evidence: text: Published the Death March Discord protocol and posted the first compliant update.
Task: `task_cdd241775a0a65ddae909bae3b771d29`
tx: 4A22F4CA999E9582504EDB9E7134268784CDC0F9F051822D1E0CAAEB6D86EBCC
```

Reward outcome updates must come from `pf.reward.v1` and include amount and reason when present:

```text
**Reward outcome**
Recorded terminal reward outcome: 12,000 PFT. Evidence was accepted but before/after artifacts were incomplete.
Task: `task_cdd241775a0a65ddae909bae3b771d29`
tx: B3D7B19EA7E5D9CB7A5BE9E70696D3E6
```

The harness does not post legacy `pf.task.reward_decision.v1` events and does not infer a reward from a bare `REWARD` pointer when the decrypted payload is missing. The only terminal reward event is `pf.reward.v1`; zero-PFT outcomes use the one-drop carrier transaction described by the reward payload.

## DeepSeek Failure Behavior

Classifier failure is not treated as a blanket secrecy signal. If the
classifier API fails, returns non-JSON, or returns an invalid level, the event is
treated as Level 3 with category `classification unavailable` and no inferred
name list. The classifier is intentionally narrow: it redacts only exact named
clients/customers, named investors, and concrete proprietary strategy or IP
mechanics.

There is no local summary fallback for a failed summary call. If the summarizer
API fails, the harness reports the DeepSeek API error and does not post a
Discord message for that event. If the summarizer returns an empty content
message after spending tokens on reasoning, the deterministic event formatter
still formats the already-sanitized packet.

## Anonymity Levels

Level 1: exact proprietary strategy or IP mechanics.

- Used only when the event contains concrete secret know-how such as formulas,
  algorithm steps, signal definitions, construction rules, execution logic, or
  confidential research methods.
- A general task direction, market, industry, instrument, ticker, product area,
  or request to develop a strategy is not enough for Level 1.
- Replaces only the exact confidential spans with
  `[redacted strategy detail]`; surrounding public context remains available.
- If the classifier declares Level 1 but fails to return usable exact spans, the
  harness fails closed to a directional category for that event.

Level 2: exact client and investor name redaction.

- The classifier returns exact proper-name entities only when the event identifies
  them as an external client/customer or investor.
- The harness replaces those strings with `[redacted client]` or
  `[redacted investor]` before summarization.
- All other useful task and business details remain available to the summary.

Level 3: normal disclosure.

- Can disclose the task/action details present in the event packet when none of
  the three protected classes was identified.
- Public organization names, contributors, team members, vendors, projects,
  protocols, products, legal work, fundraising without a named investor, and
  client work without a named client remain Level 3.

The L1/L2/L3 decision is model-authored and per-event. It is intentionally not
implemented as local keyword or regular-expression matching, because the
classification boundary must handle paraphrases and adjacent sensitive content
instead of only known strings.

## State

The harness writes `.deathmarch-state.json` by default so reruns do not repost the same transaction. The file is gitignored.

Use `--no-state` for tests or one-off replays where duplicate posting protection is not wanted.

The poller records per-event failures in the loop result and continues to later
events in the same wallet page. A slow DeepSeek call, Discord timeout, or one
bad payload should not block a later reward event from posting. Failed events
remain unmarked in `.deathmarch-state.json`, so the next poll can retry them
without losing duplicate protection for events that did post.
