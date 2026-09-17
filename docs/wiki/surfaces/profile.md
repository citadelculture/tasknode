# Profile

Profile is the member-facing trust surface. It should explain what the system knows about the account, what the member has earned, what profile image/NFT state exists, and which private account-level reads are available.

The profile is account-scoped. Wallets can change over time, but the profile belongs to the signup identity cloud, not to a single current wallet. Profile NFT rows are account-owned cache records across current and historical wallets, but private Studio reads are wallet-primary: when the signed-in account has a linked wallet, `/api/profile/nfts` returns that wallet's rows plus walletless drafts. The user can mark one account-owned NFT as the selected profile picture; public avatar surfaces prefer that selected row and otherwise fall back to the newest usable row by `created_at`.

## Hive Handle And Public Aliases

The pseudonymous identity plan is now retired as a plan. The implemented v1 surface is a small account-level identity control: each signed-in account can choose one public Hive handle and can decide which linked provider aliases are public.

Runtime endpoints:

- `GET /api/profile/identity`
- `GET /api/profile/handle/availability?handle=<handle>`
- `POST /api/profile/handle`
- `POST /api/profile/identity/alias`

The Hive handle is the public routing name for the account. It is normalized by the server, globally unique within Task Node, checked against reserved names, and stored on the internal account record rather than on a wallet. Provider usernames are never copied into the public Hive namespace unless the user explicitly chooses that handle and it is available.

Profile visibility defaults to public for every account. Public means the account can appear in discovery features when the rest of the required public/discoverable inputs exist. Private is an explicit opt-out. When a member switches private, recommended-connections indexing removes that member from the compute path.

Linked provider aliases remain private by default. The user can make an alias public from the identity controls and can independently choose whether the public alias shows the provider handle and a verified badge. Public profile reads receive only the explicit public alias set from `identity.publicAliases`; private provider identities are excluded from public profile copy, task rows, Hive cards, and Board Manager-facing public display state.

Current UI entry points:

- first-sign-in handle dialog from `src/features/identity/IdentityControls.jsx`;
- Settings identity controls from the same component;
- Profile identity card from `src/features/profile/ProfileIdentityCard.jsx`.

Implementation references:

- `server/account-identity.js`: handle normalization, reserved-name checks, availability, suggestions, and alias disclosure shaping;
- `server/profile-routes.js`: identity, handle, alias, and public profile routes;
- `server/runtime-store.js`: account-scoped persistence and linked-provider state;
- `server/repositories/profile-public.js`: public profile packet shaping with explicit public aliases only.

Not implemented in v1: public member search, Hive mention resolution, provider-photo import, and admin impersonation review queues. Recommended connections now exist as a private-profile discovery surface, described below.

## Viewing profile artwork

The large public profile portrait loads the original image eagerly, including
when its display size comes from a responsive CSS variable. Small directory and
chat avatars retain the thumbnail path. The profile portrait, public and private
NFT gallery pictures, and completed Studio preview open an expanded picture on
click or keyboard activation. The viewer fits the entire original artwork within
the screen without cropping, closes with Escape, its close button or the backdrop,
and returns focus to the picture that opened it. Profiles without artwork have no
expand control; loading failures remain visible in the viewer.

## Public Profile

The public profile is now a read model over deterministic account metrics plus one generated profile snapshot.

This page is the current product contract for public profile data, generated
copy, NFT image state, and profile reward facts. Historical profile planning has
been folded into this surface doc and the current architecture docs.

It should not contain mock connections, fake member-since history, Sybil scores, graph language, or placeholder NFT ownership.

Runtime endpoints:

- `GET /api/profile/public`
- `POST /api/profile/public/regenerate`
- `GET /api/profile/nfts`
- `POST /api/profile/nft/select`

The deterministic fields come from Postgres and runtime wallet-link state:

- primary/display wallet from the account wallet cloud, task history, and account-scoped profile NFT rows;
- lifetime task reward PFT from canonical rewarded `task_projections` rows with positive `reward_actual_pft`, nonzero `event_count`, and non-empty `last_event_tx_hash` plus `last_event_cid`;
- lifetime daily airdrop PFT from submitted `profile_daily_airdrop_issuances`;
- total lifetime PFT as task rewards plus issued airdrops;
- alignment score from the latest completed `profile_daily_airdrop_runs.alignment_score_7d`;
- contribution tier from positive task rewards in the trailing 30 days;
- public NFT gallery from account-scoped public `profile_nfts` rows, up to the bounded 240-row response cap.

The model-generated fields come from `profile_public_snapshots`:

- role title;
- role summary;
- skills;
- archetype;
- archetype contrast;
- useful-to sentence;
- data caveat when evidence is thin.

The public profile snapshot prompt is `prompts/profile/public_profile_snapshot_v1.md`.

Public profile snapshots are generated in two ways:

- manually, when the signed-in user calls `POST /api/profile/public/regenerate`;
- automatically, by `server/public-profile-snapshot-worker.js` in the
  `worker:memory-profile` process.

The automatic worker scans bounded batches of accounts with public profile
activity from Network Tasks or profile NFTs. It skips accounts with a recent
running snapshot, reuses completed snapshots when the deterministic input
fingerprint is already current, and retries failed accounts only after the
configured retry window. This prevents public profile pages and Hive Brain task
packets from staying on `Profile snapshot pending` for contributors who already
have task or NFT history.

The prompt is tuned for member discovery. It should translate concrete task history into durable professional capabilities rather than repeating narrow task titles or internal implementation trivia. Ledger, wallet, replay, event stream, evidence, and verification work should be expressed as crypto protocol reliability, indexing, auditability, integration debugging, or verification systems work when the packet supports that interpretation.

The public copy should be useful to someone deciding whether to assign work, follow, hire, or collaborate with the member. The prompt treats the public profile as a work-assignment signal, not a task log. It groups rewarded task history into repeated work themes, avoids project names and ticket summaries as identity labels, and returns exactly four discoverable skills.

The summarizer is also instructed to infer the most relevant industry when the packet is not explicit. The work should read as applicable to financial systems when that is the clearest industry fit. It should describe outcomes a contributor drives, not the mechanical implementation steps, and it should be understandable to someone who has never seen the evidence packet.

The public snapshot input includes up to 24 recent rewarded tasks so the model can identify repeated themes instead of overfitting to the latest tickets. Each task entry is deliberately compact:

```json
{
  "task_proposal": {
    "title": "...",
    "description": "...",
    "kind": "...",
    "reward_offer_pft": 0,
    "submission_requirement": "..."
  },
  "reward_text": {
    "reward_paid_pft": 0,
    "decision": "...",
    "text": "..."
  }
}
```

The public profile model does not receive verification requests, verification responses, transaction hashes, CIDs, evidence references, processed artifacts, completion scores, or evidence-quality scores. The intent is to summarize the proposed work and the final reward feedback, not the intermediate verification loop.

The public profile role layout renders the model summary as exactly two sentences, then separates `Best fit`, skills, archetype, and caveat so the page remains readable.

Provider policy:

- model: Vercel `deepseek/deepseek-v4-flash-0731` by default;
- provider: `vercel` through the shared strict-JSON capability, with Ambient backup;
- temperature `0`;
- structured JSON output;
- no user billing in v1.

The model receives only a compact public profile packet. It does not receive raw private context documents, raw chat memory, raw evidence files, wallet seeds, or the private NFT image prompt. Numeric scores, task counts, wallet addresses, reward totals, and NFT state are deterministic and are not generated by the model.

Snapshot idempotency uses the deterministic input fingerprint plus prompt digest and model. Changing the prompt intentionally creates a new completed snapshot from the same task packet; re-running with the same packet, prompt, and model reuses the existing snapshot.

### Contribution Level

Contribution level is deterministic and task-reward based. Airdrops count toward earned PFT display but do not count toward the level calculation.

The backend stores an internal numeric tier for sorting and future cohorting:

```text
T0: no positive task rewards
T1: at least 1 rewarded task or at least 1 task-reward PFT in trailing 30 days
T2: at least 5 rewarded tasks or at least 10 task-reward PFT in trailing 30 days
T3: at least 12 rewarded tasks or at least 35 task-reward PFT in trailing 30 days
T4: at least 25 rewarded tasks or at least 100 task-reward PFT in trailing 30 days
```

The public page does not expose `T3 / T4` style labels because they read like arbitrary game tiers. It maps the internal tier to a human label such as `Core contributor` and displays the factual basis, for example `12 rewarded tasks and 20.45 task-reward PFT in the trailing 30 days`. It does not display percentile claims such as `Top 18%` until a real cross-account percentile table exists.

### Public NFT Gallery

The public NFT gallery renders real `profile_nfts` rows only. It returns the account's usable public profile NFT history across current and historical wallets, bounded to 240 rows, and includes a total count so the UI can distinguish a complete list from a capped one. Failed and still-generating rows are private-only and do not render on public profiles.

Private and public NFT galleries render 10 NFT tiles per page. Pagination is client-side over cached `profile_nfts` rows, and gallery images remain lazy-loaded through `/api/profile/nft/image/:cid` when an `imageCid` exists. Owners can use `POST /api/profile/nft/select` from the gallery to set one account-owned NFT as the profile picture; the setter clears any previous selection in the same transaction. This prevents large migrated NFT libraries from expanding the profile page or eagerly opening every image request at once.

The directory, public profile, recommendations and signed-in shell use a shared profile portrait. A selected usable NFT takes priority, then the newest usable NFT. While an image loads, when its gateways fail, or before an account earns artwork, a deterministic local illustrated starter PFP fills the space. Starter portraits do not claim an earned creature level or on-chain ownership. Directory portraits are 64px and show the public creature and hyperstition traits when available.

### Network badge freshness

Network badge cards load current linked-provider proof alongside durable badge state, and refresh when the browser window regains focus. A verified, unexpired KOL badge displays Ready even if the original session snapshot predates linking X. Provider proof is scoped to the current account; stale links and badges from another account are ignored.

### Profile Pic NFT art and privacy

The product and collection are **Profile Pic NFT**. Each newly generated artwork gets its own model-generated title during Kimi's existing image-review call, using the rendered portrait and approved anonymous specification. The naming prompt is `prompts/profile/profile_nft_title_v1.md`; no extra model call is needed for normal new renders, and naming does not change the OpenAI art prompt. Titles are public metadata, checked for format and private identifiers, then saved with the image checkpoint and published to the NFT row. Galleries and mint metadata use that saved title, and retries retain it. A job resuming an older checkpoint without a title obtains one from its anonymous art spec without regenerating the image. Previously completed artwork is not renamed by this change.

While generation is pending, the fallback title remains **Profile Pic NFT**. Techno Mordor names the internal art direction, not the profile picture. Migration 138 repaired the previous default on existing records, including generating drafts; custom titles and previously pinned/on-chain metadata were preserved.

The live generation contract is `techno-mordor-v2`. Public prompt sources are `prompts/profile/techno_mordor_spec_v2.md`, `techno_mordor_review_v2.md` and `techno_mordor_image_v2.md`. The reference JSON retains the requested original Bread and Circuses and Hostile AGI prompts from navstrategies with source path and SHA256. The old v1 hydration prompt is historical compatibility code; the live renderer does not call it.

Art direction restores the historical ink lineage: Virgil Finlay → Moebius / Philippe Druillet → Katsuhiro Otomo → Tsutomu Nihei → Ian Miller. It uses clean white backgrounds, deliberate black masses, intricate industrial linework, purposeful action and bionic anatomy. Higher hyperstition increases visual complexity while the creature axis controls anatomy. Both Kimi's specification and OpenAI's fixed image guide receive this direction; artist references are public prompt text, never private user evidence. New generations use the restored guide. Already prepared jobs keep their saved prompt for reliable retries, and existing images change only through regeneration.

The two axes are independent:

- **Hyperstition, 0–100:** usefulness of demonstrated work to the fictional future AGI. Bread and Circuses and Hostile AGI are supporting lenses. This controls visual intensity from ordinary ink to extreme recursive biomechanical art.
- **Creature, 0–11:** demonstrated execution aggression and increasing abstraction: Office worker, Goblin, Orc, Genetically modified Orc, Ogre, Troll, Wyvern, Sorcerer, Dragon, Nazgul, Balrog, Sauron. Three completed tasks unlock artwork; they do not grant level 3. Self replication, coordinated autonomous legions and an actual economic network require completed-work evidence for the upper levels.

Recent work pace independently drives gesture, speed lines and ink pressure. The image is one original fictional central figure in ink on warm paper, with exactly two selected accent colors. It contains no writing, logos or identifiable people.

`POST /api/profile/nft/generate` acknowledges a durable job with HTTP 202. It ignores client-supplied task history, context documents and claimed scores. The background worker reads up to 200 recent non-fixture, account-owned task projections plus all-time and recent completion aggregates. It includes task titles/descriptions and relative activity ages, not raw chats, context documents, evidence blobs, wallet/account IDs or provider identities. Optional style text is untrusted input. Any identity information embedded in task prose remains within the private stage.

The private spec and independent review are pinned to `moonshotai/kimi-k3` on Vercel. The account is already configured for ZDR; every request additionally sets `providerOptions.gateway.zeroDataRetention=true`. Missing Vercel credentials, provider failure or lack of a compliant route cannot fall back to Ambient. This exception is limited to the NFT pipeline; general chat defaults remain GLM 5.3.

Kimi creates detailed anonymous visual fields and separate public scores. A second Kimi ZDR call reviews privacy, prompt injection, evidence grounding and the art contract, returning a corrected complete spec or rejection. Explicit type/bounds checks and identifier-overlap checks reject malformed or leaking results without regex. Private evidence refs are discarded. Only the reviewed visual fields, public art traits and fixed art guide form the OpenAI request. No task history, private rationale or account identifier is sent to OpenAI. Vercel ZDR applies to the private Kimi stage and does not configure the separate OpenAI account.

The isolated OpenAI Images provider uses `gpt-image-2.5-sunburst`. A Kimi K3 ZDR vision review checks the resulting image for privacy and art compliance before IPFS pinning. Public `metadataJson.art` contains only the anonymous spec and traits; mint metadata preserves those traits. Errors expose fixed messages and typed codes, never raw provider responses that could echo inputs.

Private Profile Studio treats the active linked wallet as the primary NFT scope. When a wallet is linked, `/api/profile/nfts` returns current-wallet rows plus walletless drafts and reports `walletScoped=true`; if no wallet is linked, it falls back to account-scoped rows. Imported chain inventory from `promptSource='pftl_chain_inventory'` is gallery history, not the primary Studio draft. The `latest` field prefers the newest native Studio row in the current wallet scope when one exists so large on-chain libraries and previous-wallet rows do not hide the user's current generated, prepared, mint-error, or failed draft. If the scoped rows only contain chain-imported rows, `latest` falls back to the newest chain row.

### Profile NFT Generation Recovery

Profile NFT generation is recoverable from the `profile_nfts` row itself. When
the user starts generation, the backend creates a durable row with
`status='generating'` before calling the image provider or pinning to IPFS. The
Profile Studio and private NFT gallery render that row as an in-progress saved
draft, and the Studio polls `/api/profile/nfts` while it is pending. The user can
navigate away, refresh, or close the app; on return, the latest row hydrates the
Studio back into the same in-progress state.

The NFT row and job are created in one transaction under an account lock. Concurrent starts reuse the same queued/rendering job. Private preparation runs after the worker claims it. The approved anonymous spec and prompt digest are persisted once and reused on retries. After image review and IPFS pinning, an asset checkpoint avoids regenerating a pinned image if final database publication must retry. The renderer also saves a 192px WebP in that checkpoint before publishing the NFT row; web machines can serve its 48/96/192px derivatives immediately through an indexed image-CID lookup. Local disk caching is optional, so an unwritable cache cannot hide an otherwise available new portrait. Root-run operator warmups preserve the parent volume owner on the cache directory so the application can continue writing it.

Each render attempt has a unique token, a renewable lease and a heartbeat. Publication and failure transitions verify current ownership under a row lock; an expired worker cannot overwrite its replacement. The existing renderer runs up to three jobs concurrently, with bounded provider/storage timeouts and up to three attempts per job. The daily ledger records `rendering` while work is queued/in flight and only records `generated` after an image exists. A stale-generation sweep cannot fail a draft backed by a queued/rendering job. Unfinished pre-v2 jobs receive a new Kimi spec on their next claim; completed older art and explicit selections remain available.

When generation and IPFS pinning finish, the same row is updated to
`status='generated'` with the image CID and becomes mintable. If generation
fails, the same row becomes `status='failed'` with an error message and remains
visible privately so the user can understand what happened and retry. Pending
and failed rows are not used as profile avatars and are filtered out of public
profile output; public profile surfaces only expose generated, prepared, or
minted NFT rows.

Mint preparation and submit failures are tracked as mint errors on the existing
row and do not change a generated or prepared image row to `status='failed'`.
Only image-generation failures and stale in-flight generation recovery mark a
row failed, so a wallet mismatch, reserve error, or submit failure does not make
Studio show the error as a broken image generation.

If the server restarts while a generation request is in flight (for example
during a deploy), the row would otherwise be stranded at `status='generating'`
with no running request behind it. A staleness sweep on the next
`/api/profile/nfts` read marks any `generating` row older than the configured threshold
(`TASKNODE_PROFILE_NFT_GENERATION_STALE_MINUTES`, default 10 minutes, always
floored above the worst-case in-flight image timeout) as `status='failed'` with
an interruption error, so the Studio recovers into the normal failed-row retry
path on the next Profile load instead of waiting forever.

### Daily Profile NFT Awards

Help → System Status exposes `daily_profile_nft_worker` with four operator states (`disabled`, `failing`, `stale`, `healthy`). Enabled alone is never healthy; award-table query failures mark **failing**.

Daily Profile NFT awards are generated by `server/profile-nft-daily-worker.js`
inside the airdrop worker process. The worker is gated by
`TASKNODE_PROFILE_NFT_DAILY_WORKER_ENABLED` and creates at most
`TASKNODE_PROFILE_NFT_DAILY_BATCH_LIMIT` awards per tick. Production ticks every
10 minutes, but idempotency remains one award per account per UTC day. Failed
same-day awards can retry up to
`TASKNODE_PROFILE_NFT_DAILY_MAX_ATTEMPTS`; interrupted running awards are
recovered after `TASKNODE_PROFILE_NFT_DAILY_STALE_RUNNING_MS` (10 minutes in
production).

Eligibility is at least **three completed tasks in total**, combining personal, network and alpha tasks. Explicit completed projections and positive full/partial reward outcomes count; rejected zero-reward terminal outcomes and fixtures do not. Accounts without a wallet qualify. If an active wallet exists, the artwork is associated with it; otherwise it is a walletless draft that can be minted after wallet linkage. Profiles without usable art are prioritized, followed by due retries. Active account render jobs are excluded to avoid duplicate work. Idempotency is
one `profile_nft_daily_awards` row per account per UTC day. The award row stores
the eligibility counts, selected wallet, status, and the generated
`profile_nfts.id`.

The `worker-airdrop` process holds a referenced
`background_worker_liveness_keepalive` handle so its unref'd worker timers do
not allow the process to exit. The startup self-check logs the role, handle
type, referenced state, and started groups (`daily_airdrop` and
`daily_profile_nft`). The durable heartbeat table is
`profile_nft_daily_worker_heartbeats`; the award table remains the source of
award state and `board_manager_leases` records the worker lease heartbeat.

Operational safety gates default to the safe path: daily generation runs with
`TASKNODE_PROFILE_NFT_DAILY_DRY_RUN=true`, forward execution disabled, and
backfill disabled. A forward or backfill run requires an explicit operator
override; production execution remains prohibited until post-deploy liveness
approval.

The bounded backfill is manifest-first and read-only until explicitly executed:

```sh
node server/profile-nft-daily-worker.js backfill-manifest --run-dates <YYYY-MM-DD,...> --max-accounts 41 --output <path>
node server/profile-nft-daily-worker.js backfill-execute --manifest <path> --sha256 <sha256> --dry-run
```

The manifest selects at most 41 accounts using the most-recent-missed-slot
rule. Remaining historical slots are recorded as ledger-skipped (the current
reconciled set contains 82 unselected slots) rather than silently regenerated.

Daily awards do not mark `profile_nfts.status='minted'` and do not silently mint
from the server. The server cannot complete a user-owned PFTL NFT mint without a
wallet signature. The worker generates a claimable Profile NFT image row; the
existing `/api/profile/nft/mint` flow still prepares the transaction and requires
the linked wallet to sign before the NFT becomes chain-minted.

### Wallet NFT Inventory From Chain

The durable NFT source of truth is the PFTL wallet, not the old PFTasks database and not Task Node's `profile_nfts` cache.

To discover NFTs for any wallet:

1. Query PFTL `account_nfts` for the wallet.
2. Read each NFT's hex `URI`.
3. Decode the URI into an IPFS metadata URI such as `ipfs://bafk...`.
4. Fetch that metadata JSON from IPFS.
5. Read `image` from the metadata and resolve the image CID.
6. Render the image directly, or upsert a `profile_nfts` cache row so profile/Hive/recommended-connections surfaces can render it.

Operator command:

```bash
npm run wallet-nft-inventory -- \
  --wallet rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx \
  --pretty
```

Fast chain-only check, without fetching IPFS metadata:

```bash
npm run wallet-nft-inventory -- \
  --wallet rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx \
  --pretty \
  --no-metadata
```

Bound metadata fetches when the IPFS gateways are slow:

```bash
npm run wallet-nft-inventory -- \
  --wallet rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx \
  --pretty \
  --timeout-ms 3000 \
  --metadata-concurrency 6
```

Local PFTL endpoints may use self-signed TLS. For those internal endpoints only, prefix the command with `PFTL_WSS_REJECT_UNAUTHORIZED=false TASKNODE_ALLOW_INSECURE_PFTL_TLS=true`.

If IPFS metadata cannot be fetched, the inventory still returns the NFT token id, decoded metadata URI, metadata CID, and `metadataFetch` status. Cache import only upserts rows with both `metadataCid` and `imageCid`; retry unreachable metadata later or use the old PFTasks cache import only as a historical fallback when preserving already-known image CIDs during cutover.

Profile NFT rendering should not make the browser depend on one public gateway
for every gallery tile. For rows with an `imageCid`, full-resolution gallery and
hero images use the same-origin image proxy at `/api/profile/nft/image/:cid`;
the server validates the CID, races the replication gateway, w3s.link,
nftstorage.link, Pinata, dweb.link, and ipfs.io with a 20-second per-gateway
default timeout, cancels losing fetches, rejects
non-image content, enforces an 8 MB default size limit, and caches successful
image bytes in memory for 24 hours by default
(`server/profile-nft-image-proxy.js`). Because CIDs are immutable,
successful proxy responses use `Cache-Control: public, max-age=31536000,
immutable`, an ETag derived from the CID, and conditional `If-None-Match` 304
handling. Concurrent same-CID misses share one in-flight gateway fetch. If the
same-origin proxy fails, private and public profile views try the stored gateway
URL plus the same public fallbacks directly instead of treating one gateway
failure as a missing NFT. As a final recovery path for older CIDs whose public
blocks disappeared, gallery tiles try immutable 192, 96, and 48 pixel
thumbnails already persisted on the app volume. The cached-only thumbnail route
returns 404 instead of a warming response when that exact thumbnail is
absent. Gallery tiles use
`loading="lazy"` and `decoding="async"` so a profile with many NFTs does not
eagerly request every full-size IPFS image at once.

### Profile NFT PFP Thumbnails

Small avatars must not request the full-resolution NFT image. Avatar surfaces
use:

```text
GET /api/profile/nft/pfp/<cid>?size=48|96|192
```

The server derives a square thumbnail with `sharp`, encodes WebP by default
with PNG fallback, and stores the result in a durable `/data` disk cache keyed
by CID, size, and format (`server/profile-nft-image-proxy.js:323`,
`server/profile-nft-image-proxy.js:350`). Successful thumbnail responses are
immutable and conditional-cacheable with an ETag derived from CID, size, and
format (`server/profile-nft-image-proxy.js:95`,
`server/profile-nft-image-proxy.js:400`). The source image is fetched once
through the same gateway-race and single-flight proxy path as the full-size
image.

New binary image pins are dual-written before the NFT row is marked generated.
Pinata returns the canonical CID, then Task Node writes the same bytes directly
to the authenticated first-party Kubo API, rejects any CID mismatch, and calls
the authenticated replication endpoint to queue the CID across the clean
cluster. A missing or stale first-party API credential therefore fails the
render job instead of accepting an NFT whose only copy cannot be retrieved.

The thumbnail generation lane is intentionally bounded. A global generation
slot count is controlled by
`TASKNODE_PROFILE_NFT_THUMBNAIL_GENERATION_CONCURRENCY`, and the waiting queue
is bounded by `TASKNODE_PROFILE_NFT_THUMBNAIL_GENERATION_QUEUE_MAX`
(`server/profile-nft-image-proxy.js:7`, `server/profile-nft-image-proxy.js:364`).
When the lane is saturated, direct thumbnail generation returns 429 instead of
opening unbounded gateway and CPU work. A cold public thumbnail request returns HTTP 202 JSON with `status=warming`, `no-store` and a retry hint, and schedules work in the bounded thumbnail queue. It does not return a successful placeholder image. The shared portrait component keeps its local starter visible, polls with backoff while mounted, and swaps in the real raster once it is ready. It also recognizes and ignores the legacy 200 SVG response during rolling deployments. Only portraits near the viewport start requests; cold misses do not fan out full-resolution source-image fetches. Fetches and timers are cancelled on unmount.

Frontend avatar helpers use the thumbnail route at roughly 2x the rendered CSS
size, while full-resolution profile gallery and hero views keep using
`/api/profile/nft/image/:cid` (`src/features/profile/profile-nft-images.js:1`).
Directory rows, Hive profile badges, recommended-connection cards, and compact
profile avatars therefore download small cached thumbnails instead of multi-MB
PNG originals. If the thumbnail request fails, the shared avatar helper now
tries the same-origin full image proxy before falling back to a stored public
gateway URL, so a thumbnail-cache or gateway failure does not leave the browser
without a first-party image fallback.

The warmer script pre-generates durable thumbnails and is idempotent. Run it on
the app machine where `/data` is mounted, not on a worker machine with a
different filesystem:

```bash
node scripts/profile-nft-thumbnail-warm.mjs --execute --limit 1000 --sizes 48,96,192 --concurrency 1
```

Without `--execute` it prints the planned CID/thumbnail count only
(`scripts/profile-nft-thumbnail-warm.mjs:31`,
`scripts/profile-nft-thumbnail-warm.mjs:89`).

Cache import for a linked Task Node account:

```bash
npm run wallet-nft-inventory -- \
  --wallet rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx \
  --account-id acct_oauth_... \
  --import-profile-cache \
  --dry-run

npm run wallet-nft-inventory -- \
  --wallet rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx \
  --account-id acct_oauth_... \
  --import-profile-cache \
  --execute
```

Example application code:

```js
import { fetchWalletNftInventory } from "../server/pftl-nfts.js";

const inventory = await fetchWalletNftInventory({
  walletAddress: "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",
});

for (const nft of inventory.nfts) {
  console.log(nft.title, nft.imageGatewayUrl, nft.metadataCid);
}
```

`scripts/import-pftasks-profile-nfts.mjs` remains useful for historical cutover because old PFTasks already stored mint dates, tx hashes, and image CIDs. It is not the canonical NFT discovery path.

### Legacy NFT CID Repin

Old PFTasks profile NFTs can only be trusted if their original CIDs remain resolvable. The minted token points at an IPFS metadata CID, and that metadata points at an image CID. Those CIDs are content addresses. Task Node must not silently replace them with new CIDs because that would make the app render something different from the on-chain NFT.

The temporary production bridge is `TASKNODE_PROFILE_NFT_IMAGE_GATEWAYS`, which may include old PFTasks gateways so users can see their historical images during cutover. That bridge is not the final state. The final state is: every old metadata, image, and thumbnail CID resolves from current IPFS infrastructure, then the old PFTasks gateways can be removed from the profile image proxy config.

Bulk repin operator flow:

```bash
# Export minted old PFTasks nft_mints rows to JSON first.
# The JSON may be either an array or { "rows": [...] } and should include
# image_cid, metadata_cid, thumbnail_cid, wallet_address, owner_wallet_address,
# status, id, nft_name/display_name, minted_at, and tx_hash when available.

npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --dry-run \
  --limit 100 \
  --concurrency 4 \
  --timeout-ms 8000

npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --execute \
  --limit 250 \
  --offset 0 \
  --no-verify-after \
  --concurrency 4 \
  --timeout-ms 8000

npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --verify-only \
  --concurrency 8 \
  --timeout-ms 8000
```

`profile-nft-cid-repin` dedupes all `image_cid`, `metadata_cid`, and `thumbnail_cid` values before doing network work. It first checks current gateways, then old PFTasks gateways. In execute mode it calls Pinata `pinByHash` only for CIDs that are not already current-resolvable and are proven reachable through a legacy gateway. The output is a JSON report with one row per unique CID and status counts. For a full migration, repeat execute batches by increasing `--offset` by the batch size until `offset >= uniqueCids`, then run unbounded `--verify-only`.

Status meanings:

- `already_current_resolvable`: safe; no action needed.
- `needs_repin`: legacy gateway can serve it, but current gateways cannot yet.
- `repinned_and_verified`: safe; current gateways resolved it after repin.
- `repin_requested_not_yet_verified`: Pinata accepted the pin request, but current gateways have not caught up; rerun `--verify-only`.
- `missing_from_legacy_gateways`: not safe to remove old infrastructure for this CID; investigate old IPFS node/block availability or mark as an exception.
- `repin_failed`: operator must inspect the Pinata error and retry or move the block by another exact-CID path.

Do not remove old PFTasks gateways from `TASKNODE_PROFILE_NFT_IMAGE_GATEWAYS` until a full `--verify-only` run over the exported historical NFT set has zero `needs_repin`, `missing_from_legacy_gateways`, `repin_requested_not_yet_verified`, and `repin_failed` rows.

## Recommended Connections

Recommended connections are the private-profile discovery surface that answers one product question: who should this member know or work with next, and why?

The implementation reuses the existing Postgres pgvector infrastructure already used by Jobs chat retrieval. It does not introduce a separate vector database.

Runtime endpoints:

- `GET /api/profile/visibility`
- `POST /api/profile/visibility`
- `GET /api/profile/member`
- `GET /api/profile/recommended-connections`
- `POST /api/profile/recommended-connections/refresh`
- `POST /api/profile/recommended-connections/event`

The pipeline is:

1. Build one compact recommended-connections packet per discoverable member.
2. Embed that packet with the shared embedding provider, currently `text-embedding-3-small` with 1536 dimensions.
3. Store the packet and embedding in a member-specific pgvector table, not in the Jobs corpus tables.
4. For a target member, retrieve at most the top 50 discoverable candidate profiles by vector similarity.
5. Run one DeepSeek V4 Pro rerank per target profile no more than once per week unless an operator or manual profile refresh forces refresh.
7. Persist the final 3-4 recommendations with plain-English reasons, supporting signals, source packet digests, prompt/model metadata, expiry, and user feedback events.

The member packet is keyed by account id and requires a completed Network Diagnostic Report. A linked runtime wallet identity is optional metadata, not a prerequisite for entering the recommendation corpus. The packet includes the full Network Diagnostic Report, relevant current task text, public profile snapshot fields, reward totals, contribution tier, public aliases when present, current focus, primary contribution ability, and public/discoverable identity fields. The accepted Network Task text for `Fix Recommended Connections On Private Profile Page` is a valid example of task context to include when it represents the user's current work.

Privacy is a hard check. A member whose profile is private or not discoverable must not be embedded, indexed, retrieved, sent to DeepSeek, or included in another member's candidate set. Private profiles should be outside the recommendation compute path entirely, not merely filtered after retrieval. If a member switches from discoverable to private, the worker must delete or disable that member's vector profile row and expire any outstanding recommendations that include that member. If they switch back to discoverable, the packet and embedding must be regenerated from current public/discoverable inputs.

Tables:

- `recommended_connection_profiles`: one current packet and embedding per discoverable account.
- `recommended_connection_runs`: one rerank run per target account and week-scale refresh window.
- `recommended_connections`: the 3-4 persisted recommendations from the latest successful run.
- `recommended_connection_events`: lightweight interaction telemetry such as profile views, wallet clicks, and wallet copies.

The recurring worker is `server/recommended-connections-worker.js`, started by `server/background-workers.js` unless `TASKNODE_RECOMMENDED_CONNECTIONS_WORKER_ENABLED=false`. It refreshes public/discoverable profile embeddings, then reranks stale target profiles. The default rerank limit is one target profile per tick, and a completed run suppresses another normal rerank for seven days. Manual refresh uses the same weekly guard unless explicitly forced by server code.

The prompt is `prompts/profile/recommended_connections_v1.md`. It receives the target packet plus at most 50 candidate packets and returns raw JSON containing 3-4 recommendations. The recommendation prompt bans internal jargon and asks for clear reasons, supporting signals, and a useful first move.

The private profile page renders recommendation cards from `GET /api/profile/recommended-connections`. Each card shows the recommended member's latest current-wallet generated/prepared/minted profile NFT image when present, falling back to initials when no image exists. It also shows the member's public handle or display name, a `View profile` action, wallet metadata when present, one role line, the plain-English reason, the strongest supporting signals, and a suggested first action. `GET /api/profile/member?accountId=...` returns only the same sanitized public profile read model used by the public profile tab, and only for public/discoverable accounts. It does not show raw vector scores, raw Network Diagnostic text, internal packet JSON, private aliases, private context, hidden task evidence, old-wallet NFT rows, or explicit Useful/Dismiss feedback controls. Profile and wallet interactions may record local recommendation events; they do not message another user or perform a connection action on the user's behalf.

## Daily Airdrop

Daily Airdrop is an account-level private scoring job. It reviews the member's recent rewarded task work and produces a proposed daily PFT airdrop plus a short explanation of what raised the score, what lowered it, and what to improve tomorrow.

Current status: recurring scoring, live issuance, stale recovery, and catch-up retries are implemented behind `TASKNODE_DAILY_AIRDROP_WORKER_ENABLED=true`. Scheduled production ticks are current-UTC-day-only; historical catch-up requires an explicit operator override and decision. The restart gate excludes the two default historical scan windows (Jul 13 and Jul 12 on this deployment); the read-only census found zero candidates or unresolved rows in those windows, while Jul 14 has one current-window candidate. A scoring run writes `profile_daily_airdrop_runs`; issuance claims exactly one `profile_daily_airdrop_issuances` row as `processing_pre_submit`, marks it `submitting` before the PFTL submit call, and records `submitted` only after transaction proof is persisted. Each actual worker run also creates a Hive Mind Agent card that says how much PFT was dispensed and whether unresolved airdrop debt remains.

### Private Profile Rendering

The private profile top section is now a read model over Postgres. It should not contain mock airdrop amounts, qualitative badges, or fake chart series.

Runtime endpoints:

- `GET /api/profile/daily-airdrop`
- `GET /api/profile/reward-history?range=7d|28d|90d`

The airdrop hero reads the latest completed `profile_daily_airdrop_runs` row for the signed-in `account_id`. The large headline is the latest daily airdrop amount only. It is labeled `Today's airdrop` only when the paid/scored airdrop date is the current UTC date; otherwise it is labeled `Latest airdrop`. Total earned PFT, including task rewards plus submitted daily airdrops, belongs in the adjacent range chart and summary line.

The hero must distinguish scored and paid state. If `profile_daily_airdrop_issuances.status` is not `submitted`, the visible label says the airdrop was scored but not paid yet and shows the current payout status, such as `Retry pending`, `Preparing payout`, or `Needs reconciliation`. The reward chart counts only submitted airdrops as earned PFT.

Visible fields:

- proposed daily airdrop: `daily_airdrop_pft`;
- run mode: `run_mode`, currently usually `dry_run`;
- score date: `completed_at` or `run_date`;
- alignment: `alignment_score_7d * 100`;
- rewarded task count from `input_snapshot.reward_totals.rewarded_task_count`;
- trailing 7-day actual/max PFT: `actual_airdrop_pft_7d` and `max_possible_airdrop_pft_7d`;
- recipient wallet from `input_snapshot.airdrop_recipient.wallet_address`;
- payout status and paid issuance proof from `profile_daily_airdrop_issuances`;
- model explanations: `what_raised_today`, `what_kept_it_lower`, `to_improve_tomorrow`, and `reasoning_text`.

The private profile does not display `retention_value_score`. The backend still stores that model output for audit and future policy review, but it is not part of the private member-facing panel.

The top chart and PFT generation chart read actual earned PFT rows. They aggregate task rewards from canonical rewarded `task_projections` rows and daily airdrops from `profile_daily_airdrop_issuances.status = 'submitted'`. Local fixture rows such as `directory_polish_local_fixture`, `directoryPolishFixture`, `directory_polish_*`, and cancel-smoke projections are excluded. Until reward categories exist as first-class data, the chart is a single earned-PFT series rather than fabricated personal/network/alpha layers. The daily airdrop headline must not reuse the chart's total-earned number or imply that task rewards are the same thing as the airdrop payout.

### Evidence Packet

The scorer builds one compact task reward packet from Postgres task projections and task reward events.

Included work:

- only tasks tied to the account's identity wallet cloud;
- only tasks with `reward_paid_pft > 0` and canonical reward backing (`event_count`, last CID, and last tx hash);
- only tasks inside the trailing lookback window, currently 7 days;
- task title, kind, status, reward offer, reward outcome, reward reason, completion score, evidence quality, event CIDs, and transaction hashes.

Excluded work:

- zero-reward tasks;
- tasks from wallets not in the account wallet cloud;
- raw evidence blobs unless a later version explicitly needs them.

### Identity Cloud

The airdrop is one score per identity cloud, not one score per wallet. An account can link, delink, and relink multiple PFT wallets over time, but daily scoring remains keyed by `account_id` and `run_date`.

The worker-visible identity wallet cloud is built from `pftl_sync_wallets`:

- active `role = 'user'` rows are treated as currently linked wallets;
- inactive `role = 'user'` rows are treated as historical identity-cloud wallets;
- non-user roles such as allocation, authority, funding, and airdrop service wallets are excluded.

This prevents a user from farming airdrops by rotating wallets and prevents Task Node authority/funding wallets from being selected just because they appear in chain replay rows.

### Recipient Wallet

Recipient selection is deterministic metadata, not model reasoning.

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

### Alignment Score

Alignment score is deterministic. It is not an LLM output.

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

`profile_daily_airdrop_issuances` stores live payment submissions.

Important fields:

- `account_id`;
- `run_id`;
- `run_date`;
- `source_wallet`;
- `recipient_wallet`;
- `amount_pft`;
- `amount_drops`;
- `status`;
- `source_cid`;
- `tx_hash`;
- `ledger_index`;
- `payload_digest`.
- `attempt_count`;
- `last_attempt_at`;
- `last_error_code`;
- `last_error_message`;
- `submission_attempted_at`;
- `signed_tx_hash`;
- `reconciliation_json`;
- `reconciled_at`.

The issuance uniqueness boundary is one issuance row per `run_id` and one submitted issuance per account/day.

`profile_public_snapshots` stores public role snapshots.

Important fields:

- `account_id`;
- `status`;
- `input_fingerprint`;
- `input_snapshot`;
- `role_title`;
- `role_summary`;
- `skills`;
- `archetype`;
- `archetype_contrast`;
- `useful_to`;
- `data_caveat`;
- provider/model/prompt metadata;
- `completed_at`.

The snapshot uniqueness boundary is one completed row per account and input fingerprint. Re-running the snapshot with unchanged inputs should not create divergent public profile copy.

### Current Goodalexander Dry Run

The example dry run uses a synthetic account such as `acct_example_operator`.

Observed packet:

- eligible identity-cloud wallets: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`, `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`;
- selected recipient: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`;
- rewarded tasks counted: `12`;
- rewarded task PFT counted: `20.45`;
- paid production airdrop: `600 PFT`;
- alignment score: `0.06`;
- transaction: `B16678C024C0780D12227E9CC9FA4CCB1FA2BA3EC65341BFFAE40FC978FC6AB2`;
- pointer CID: `QmPyxEi3Sk9AXc6QCPJK2M11fb5okTmTuR21VXkxbTuaLo`.

### Live Issuance Boundary

Live issuance is owned by `server/profile-daily-airdrop-worker.js` when the worker is enabled. It claims a single `daily_airdrop` lease, recovers stale rows, checks today plus catch-up dates, scores eligible account/day packets, retries safe pre-submit failures, pays positive airdrops through the existing issuance path, and writes a Hive Mind Agent audit card. `scripts/profile-daily-airdrop-issue.mjs` remains available as a manual operator command for a specific completed run.

Issuance is fail-closed: after a run is claimed as `processing_pre_submit`, another worker cannot publish it. If a failure happens before PFT submission is attempted, the row becomes `failed_before_submit` and can be retried. If a failure happens after PFT submission is attempted, the row becomes `submit_unknown` until reconciliation or operator review proves whether a payment happened.

Operator commands:

```bash
npm run profile-daily-airdrop-worker -- --json
npm run profile-daily-airdrop-debt -- --json
npm run profile-daily-airdrop-reconcile -- --run-id=<run_id> --json
```
