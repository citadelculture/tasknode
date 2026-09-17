# Account switch / app-state performance — 2026-09-12

Task: task_d62c6d4305dd33dd5fea6ee5dc59db31 (Ship Sub-Second Account Switching).
Production app: tasknodeofficial-dev (tasknode.postfiat.org). Before: release v738. After: release v739.

## Root cause

`GET /api/app-state` — the single bootstrap call the app waits on after every
cold load and after every account switch (`switchAccount` → `POST
/api/auth/accounts/switch` → `window.location.reload()`) — awaited ~14
independent repository/RPC sections one after another in
`server/app-state.js`. Each section is a ~110 ms database round trip from
the Fly app to Postgres, so the serial chain cost seconds. Landing on the
tasks view then fired a second full compute (`taskProjectionRefresh: true`
bypasses the fresh cache), and request Dismiss/Retry awaited that same
refresh before updating the row.

## Baseline (v738, production `route_observability_summary`)

| route | samples | p50 | p95 | max |
|---|---|---|---|---|
| GET /api/app-state authed | 20 | 4493 ms | 10734 ms | 11356 ms |

## Changes

1. `server/app-state.js` — `appState()` runs its sections concurrently in two
   phases (session-only sections, then wallet-dependent sections), keeps every
   existing fallback, and logs one `app_state_timing` record with per-section
   durations per compute.
2. `server/app-state.js` `prewarmAppState()` + `server/account-switching.js` —
   the switch route pre-warms the target account's app-state cache, so the
   first `/api/app-state` after the reload is a cache hit.
3. `src/app/App.jsx` — the tasks view no longer forces a projection refresh
   when app-state was fetched within the last 2 s (cold load or switch); the
   forced refresh after task/wallet/chat actions is unchanged.
4. `src/features/tasks/TaskRequestQueue.jsx` — Dismiss hides the row and Retry
   shows Queued as soon as the server accepts the write; the background
   refresh reconciles. Real server state wins once the request changes.
5. `scripts/app-state-switch-perf-smoke.mjs` (in `test:unit`) — pre-warm cache
   hit and app-state timing instrumentation.

## After (v739, production `app_state_timing`, first samples after deploy)

| compute | totalMs |
|---|---|
| authed app-state #1 | 453 |
| authed app-state #2 | 928 |
| authed app-state #3 | 684 |
| authed app-state #4 | 461 |

p50 ≈ 460 ms, max 928 ms (n=4) versus p50 4493 ms before. Phase-1 sections
all complete in one DB round trip (~110 ms); `task_state` (190–430 ms) is now
the long pole.

Public cold-load TTFB from this host (curl, 3 runs each): `/` 240–305 ms,
`/runtime-config.json` 240–319 ms, `/api/app-state` (anon, cached) 232–251 ms.

## Account switch path after this change

switch POST (one session write + pre-warm kick-off) → reload → HTML + cached
assets → `runtime-config.json` ∥ `/api/app-state` (cache hit) → usable. All
server legs are now sub-300 ms; no second app-state compute on tasks view.

## Verification

- `npm run app-state-switch-perf-smoke` → ok
- `npm run app-state-cache-gate-smoke` → ok (fresh-cache bypass on explicit task refresh preserved)
- `npm run task-app-state-refresh-smoke` → ok
- `npm run multi-account-password-wallet-smoke` → ok (isolated credentials, sessions, account set, wallets)
- `npm run qa-worker-access-smoke`, `runtime-store-smoke` → ok
- `npx eslint` on changed files, `npm run build` → ok
- Deployed: `npm run fly:deploy:prod` → release v739, worker guards ok.

## Residual

- Browser click-to-usable p50 on a real signed-in session is not measured
  from this host (no operator credentials in the harness); the server-side
  budget is now well under 1 s and the extra compute was removed.
- `task_state` is the remaining long pole; `listTaskState` could be split further.
- Phase-1 sections each cost one ~110 ms DB round trip; a single batched
  query would cut the floor further.
