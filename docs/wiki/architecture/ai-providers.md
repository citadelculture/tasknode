# AI Providers

Task Node routes model inference through **Vercel AI Gateway first**, with
**Ambient as backup**. Thinking and existing GLM workers use GLM 5.3; Instant
and Team Context use GLM 5.3 Flash. The model layer is shared by chat, Docs
assistants, context, memory, tasks, Hive, profiles, and operator scripts.

## Models

| Workload | Vercel primary | Ambient backup |
| --- | --- | --- |
| Instant, Team Context | `zai/glm-5.3-flash` | `z-ai/glm-5.2` |
| Thinking, structured tasks, research, GLM workers | `zai/glm-5.3` | `z-ai/glm-5.2` |
| Help, memory, short narration | `deepseek/deepseek-v4-flash-0731` | `z-ai/glm-5.2` |
| Evidence images | `moonshotai/kimi-k2.7-code` | `google/gemma-4-26b-a4b-it` |

GLM 5.3 Flash accepts text and images and produces text. It does not generate
images. Instant can retain Flash for image input; text-only models switch to the
vision model when images are present. Files are extracted locally with byte,
page, archive-entry, and expansion limits before inference.

The [Ambient catalogue](https://api.ambient.xyz/v1/models), checked September 5,
2026, lists GLM 5.2 as ready and does not list GLM 5.3, Flash, DeepSeek, or Kimi.
Its vision entries, including Gemma 4, are not currently marked ready. Text
failover therefore changes the model version; vision backup availability is
limited by Ambient capacity. Failed vision analysis remains an error and never
becomes a zero task score. Actual provider and returned model are recorded on
completed work so a backup answer is identifiable.

## Shared Routing

`server/inference.js` owns dispatch, with policy, protocol, transport, text, and
usage helpers beside it. Feature modules use this boundary. The legacy
`ambient-inference.js` exports and Team Context's `vercel-inference.js` wrapper
also dispatch through it. Old function names are compatibility names, not
provider selectors.

Vercel is tried first when its key is configured. An enabled, configured Ambient
backup is tried after authentication, quota, rate-limit, model-unavailable,
network, timeout, or upstream server failures. Each provider has a bounded
attempt deadline covering headers and body reads. Invalid input, rejected
schemas, truncated output, and caller cancellation do not trigger failover.
Streaming may fail over only before the first visible text delta; it never
replays a partially delivered answer against the backup.

With only an Ambient key, inference runs in backup-only mode. Status exposes
primary and backup configuration separately. A configured key is not proof of
successful authentication or available model capacity.

## Configuration

- `VERCEL_AI_GATEWAY_API_KEY`, or alias `AI_GATEWAY_API_KEY`, configures primary inference.
- `VERCEL_AI_GATEWAY_BASE_URL` defaults to `https://ai-gateway.vercel.sh/v1`.
- `AMBIENT_API_KEY` configures backup inference.
- `AMBIENT_BASE_URL` defaults to `https://api.ambient.xyz/v1`.
- `INFERENCE_AMBIENT_BACKUP_ENABLED=false` disables backup; it is enabled by default.
- `INFERENCE_CHAT_ENABLED=false` disables chat inference.
- Capability overrides: `INFERENCE_MODEL_INSTANT`, `INFERENCE_MODEL_FAST_TEXT`, `INFERENCE_MODEL_REASONING`, `INFERENCE_MODEL_STRUCTURED`, `INFERENCE_MODEL_RESEARCH`, and `INFERENCE_MODEL_VISION`.
- Backup overrides: `AMBIENT_BACKUP_MODEL_INSTANT`, `AMBIENT_BACKUP_MODEL_FAST_TEXT`, `AMBIENT_BACKUP_MODEL_REASONING`, and `AMBIENT_BACKUP_MODEL_VISION`.

Existing `AMBIENT_MODEL_*` capability overrides remain lower-priority aliases.
Known GLM 5.2 pins resolve to GLM 5.3 on the primary route. Unknown primary model
IDs are rejected; add a reviewed registry entry before introducing a new model.
Model configuration never selects a different provider order.

## Search, Usage, And Persistence

Context Rewrite uses Vercel's server-executed search tools. Ambient backup uses
its bounded `/tools` protocol. Search counts and provider costs come from
provider metadata when reported; missing wholesale costs remain unknown.
The [Vercel model catalogue](https://ai-gateway.vercel.sh/v1/models) supplies live
pricing and capability information with a short cache and last-known-good data.

User chat tariffs remain separate from wholesale provider costs. This migration
does not change user tariffs. Existing provider/model history is retained;
new database defaults use Vercel. The shared completion carries actual provider
and model metadata, and Team Context stores per-member inference metadata.
Feature adapters must preserve actual provider/model metadata during fallback.
The obsolete Hive Task Manager adapter and accounting-harvester inference
path have been removed. NFT privacy retains its independent structured
reviewer and mechanical literal checks.

The shared inference modules use typed JSON/XML parsing and ordinary text
parsers. Regex is prohibited throughout LLM call paths by workspace policy.
`npm run inference-no-regex-check` covers direct inference callers and an
explicit helper inventory; it does not yet prove transitive JS, Rust or shell
call-path coverage. Passing that check must not be described as whole-system
compliance.

## Separate Services

Retrieval retains local `deterministic-bag-of-words-v1` embeddings at 1536
dimensions; existing vectors remain compatible. Corbanu research and the
independent Kimi board terminal runtime retain their own service contracts.

Profile NFT preparation and image review are pinned to `moonshotai/kimi-k3` on Vercel with `providerOptions.gateway.zeroDataRetention=true`, using the account's existing ZDR setup. Ambient fallback is prohibited for this pipeline, even when Vercel is unavailable. Kimi reads bounded canonical task history and produces an independently reviewed anonymous Techno Mordor art spec. Only that anonymous spec reaches the isolated `gpt-image-2.5-sunburst` OpenAI Images renderer; raw history, evidence refs and account identity do not. `PROFILE_NFT_OPENAI_API_KEY` belongs only to the renderer. The separate OpenAI account's retention controls are independent of Vercel ZDR. See [Profile](../surfaces/profile.md#techno-mordor-art-and-privacy).

## Verification

Run `npm run inference-failover-smoke`, `npm run inference-no-regex-check`, and
`npm run provider-egress-check` for the shared boundary. Feature smoke tests
cover chat, attachment extraction, task evidence, Hive, profiles, and Team
Context persistence. Synthetic live calls require valid provider credentials;
fixture success alone does not prove production availability.
