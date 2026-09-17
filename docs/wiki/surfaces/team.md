# Team

Team is the account collaboration screen under **More**. It lets users grant precise, directional read access to task history. It is not a social follow list and it does not grant document, wallet, Context, Memory, chat, or task-mutation authority.

## Relationships

Every relationship is represented by one or two explicit subject-to-viewer grants:

| Label | Effective visibility |
| --- | --- |
| Collaborator | Each person can read the other's task history. |
| Manager | The invited manager can read the inviter/direct report's tasks; the direct report cannot read the manager's tasks. |
| Direct Report | The inviter/manager can read the invitee/direct report's tasks; the report cannot read the manager's tasks. |

The cards say both directions explicitly: **You see their tasks** and **They see yours**. A relationship label is presentation over grants, not an independent authorization shortcut.

## User Flow

1. Open **More -> Team** and unlock the linked wallet.
2. Invite an exact Task Node handle or linked PFT wallet and choose the relationship.
3. The recipient accepts or declines the signed invitation. Acceptance creates only the reviewed grant directions.
4. When a grant permits it, select **View tasks** on the member card.
5. Select a task row to open its detail popout. Desktop uses a right-side panel; mobile uses a bottom sheet. The read-only view shows the teammate identity, status, reward, due date, brief, steps, evidence, activity, and task ID when available.
6. Close with the close button, backdrop, or Escape. Focus returns to the selected task row.
7. Stop sharing or revoke the applicable grant. Reads fail immediately after revocation.

## Team Context

Corbanu Terminal can read the same permission-filtered report. In a build with Team Context support, open `/tasknode team` or choose **Team Context** in `/tasknode`, then **Read full report**. Use the pager keys to scroll, Esc to return, and **Refresh Team Context** to reload current permissions and report status. Agents can use `corbanu tasknode team context --json` with their inherited profile scope. This read-only view is available regardless of the personal-context preference; it does not change that preference or grant access to private context documents. The terminal bridge is `GET /api/terminal/tasknode/team/context` and uses the linked terminal account's existing collaboration permissions.

The top of the Team page contains a one-page Team Context report presented as a scan-first briefing ledger rather than a card grid. It lists every current teammate, shows compact deterministic counts of rewarded tasks in the trailing 24 hours and trailing 7 days when the viewer has task-history access, presents each update as a semantic briefing with a focus statement, a numbered list of completed changes, and a separated operational effect, and exposes additional completed changes through an accessible per-member expansion control. Rewarded-work summaries preserve source-grounded systems, pages, APIs, datasets, runbooks, failure modes, scope quantities, and rollout details when those facts help a teammate understand what actually changed; unfamiliar terms are explained rather than deleted.

The counts are calculated from canonical rewarded task projections; the model never calculates or changes them. Members with no rewarded work are omitted from model input and receive the fixed no-work sentence directly from the server. For rewarded contributors, the model receives short request-scoped member keys rather than database account IDs, and the server deterministically restores account bindings after validating the complete rewarded-member key set. The 32,000-token completion ceiling and four-minute provider timeout provide ample headroom for GLM hidden reasoning plus the report, and a provider `length` finish is classified as truncation rather than parsed as malformed member data. A reward change or prompt-contract change invalidates a source fingerprint and queues a new report for every active viewer of that teammate's task history. Repeated page polling preserves an already pending or processing job, including its lock and retry time, instead of restarting generation. The `worker:memory-profile` process generates the replacement with Vercel AI Gateway model `zai/glm-5.3-flash`. There is no provider fallback for this workload. While a replacement is pending or processing, the Team page keeps the latest completed summary visible with its completion time and labels it as the previous report. That stale-while-refresh display is filtered through current task-history grants: revoked members disappear immediately, unsafe stale overview text is hidden, and newly added members show a scoped first-summary message. The personal-context prompt path remains stricter and injects only a current report.

The checkmark button **Include Team Context in personal context** is off by default and saves an account-scoped preference. When checked, only a current, currently authorized report is composed with the user's personal Context at chat execution time. It does not rewrite the user's editable Context document. Revoking a task-history grant removes that teammate from the source packet and from new chat/agent prompt assembly immediately, even before regeneration completes.

## Authorization Boundary

Both task list and individual task detail routes call the same `requireTaskHistoryGrant` gate before resolving the subject wallet:

- `GET /api/team/:accountId/tasks`
- `GET /api/team/:accountId/tasks/:taskId`

The server loads the task under the subject account and linked wallet; it never trusts a viewer-supplied wallet as the authorization boundary. Team is read-only. It cannot accept, refuse, cancel, submit, answer verification, or reward a teammate's task.

Invites, acceptance, and revocation use short-lived, single-use wallet challenges bound to the action, resource ID, and payload digest. Exact identity lookup prevents fuzzy directory enumeration.

## Nostr

Messaging is a separate first-class surface under **More -> Messages**. A user explicitly activates a wallet-bound Nostr identity there, and any discoverable Task Node member with an active public binding can exchange encrypted messages. A Team relationship is not required and does not create the binding. Nostr remains transport only: revoking Messages does not change Team permissions, and revoking Team permissions does not depend on relay delivery.

## Runtime

- UI: `src/features/team/TeamView.jsx`, `TeamTaskDetailPopout.jsx`, and `team.css`.
- API: `server/collaboration-routes.js`.
- Persistence and authorization: `server/repositories/collaboration.js` and `server/repositories/team-context.js`.
- Generation: `server/team-context-worker.js`, `server/vercel-inference.js`, and `prompts/team/team_context_v8.md`.
- Schema: migrations `110_docs_team_collaboration.sql` and `130_team_context_reports.sql`.
- Feature flag: `TASKNODE_TEAM_ENABLED`.

Verification: `npm run collaboration-contract-smoke`, `npm run team-task-popout-smoke`, and `docker exec tasknodeofficial-api-1 node scripts/team-context-smoke.mjs` in the local Docker stack.
