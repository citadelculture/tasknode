# Death March team fan-out — end-to-end verification (2026-09-12)

Task: task_83cdd58fdab5304b1e09212766126f7d. Branch `deathmarch-team-fanout`
(PR #242), commits 52f4673, 0730d48, 3876a3c (bounded error detail, current
Fly inference key + off-chain title enrichment, Discord message id capture).
Poller: user service `tasknode-deathmarch` on the operator host. Channel
1229917290254827521 (bot transport). All times UTC.

## 1. Service state

- `git branch --show-current` in /home/pfrpc/repos/tasknode → `deathmarch-team-fanout`;
  service `WorkingDirectory` is that checkout, `ExecStart` = `run-deathmarch-supervised.sh --poll`.
- `systemctl --user cat tasknode-mpg-proxy` → `fly mpg proxy zp2wjrejjv5odn4q --local-port 16433`
  (production cluster since the 2026-08-31 recovery; previously 3x9jv02yd3dr6qp7, whose
  `task_events` had zero rows in the last 7 days).
- Running poller env (hashes only): `VERCEL_AI_GATEWAY_API_KEY` sha256[:8] `d3d87588`
  = Fly secret; `AMBIENT_API_KEY` present. Journal since restart has no
  `inference_not_configured` warning.
- Dry run of a real off-chain submission event with the service env: classifier
  level 3 "internal tooling"; message carries title
  "Extend Deathmarch Harness to Fan Out All Team Member Reports" and the
  evidence PR link — not the bare deterministic fallback.
- Poll log every ~65 s: `{"ok":true,"checked":513,...,"failed":0}` (513 = 7 members × chain + DB feeds).

## 2. Live posts (state file `.deathmarch-state.json`, `postedAt >= 02:00`)

| member | posts | action kinds |
|---|---|---|
| goodalexander | 7 | offer 1, accepted 1, evidence 1, verification requested 1, verification response 1, reward 2 |
| donravle | 27 | offer 9, accepted 4, evidence 2, verification requested 4, verification response 4, reward 4 |
| iridiumeagle | 1 | offer 1 |

Duplicate check across all posts since 02:00 on (taskId, actionKind, cid): none.

The donravle / iridiumeagle posts (02:09–02:14) were historical events posted
when the proxy restart cascaded into the poller before the state seed ran
(see task_1c89c2c9 evidence). They prove attributed direct-report delivery
end to end; they are not events that occurred in the window.

Latest post: goodalexander `task_update_accepted` for task_83cdd58f at 02:33:52,
Discord message id `1548159686937673789` (first post recorded with an id).

## 3. Database cross-check (window 02:15 → 02:35, after the state seed)

`task_events` rows for the seven member accounts (schemas request/offer/update/
submission/verification_response/reward) versus state:

| member | DB events | posted | seeded (mark-existing) | missing |
|---|---|---|---|---|
| goodalexander | 6 | 6 | 0 | 0 |
| corbanuai, 0xpostfiatchad, secondfmaster, donravle, jimricketts, iridiumeagle | 0 | 0 | 0 | 0 |

No direct report produced a task event in this window (02:15–02:35 UTC, i.e.
late evening US); every event that did occur has exactly one post.

Redaction: the classifier ran on every post (levels recorded per event); the
public handle is added outside the sanitized packet
(`deathmarch-team-fanout-smoke` asserts packet equality with/without member).

## 4. Restart safety

02:31 — `systemctl --user restart tasknode-mpg-proxy`, then
`systemctl --user restart tasknode-deathmarch`. State had 1657 seen entries.
Next cycles: 02:31:53 `posted 0 failed 0`; 02:33:52 `posted 1` (a genuinely
new event, message id above). Zero re-posts of seen events.

## 5. Fixes made during verification

- 3876a3c `postToDiscord` now records the Discord `messageId` per post
  (bot transport) in results and state; smoke asserts ids are recorded and
  persisted.

## Residual

- A live task event from two different direct reports inside the window was
  not observed; the fan-out path for those accounts is proven by the 28
  attributed posts at 02:09–02:14 and by the replay counts (corbanuai 74,
  0xpostfiatchad 61 events in the prior 7 days now all in state). The next
  direct-report event will post automatically; re-run `/tmp`-free check:
  `node` cross-check against `task_events` per account vs `.deathmarch-state.json`.
