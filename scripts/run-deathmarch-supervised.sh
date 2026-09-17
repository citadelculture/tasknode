#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
fly_bin="${FLY_BIN:-/home/pfrpc/.fly/bin/fly}"
app_name="${DEATHMARCH_FLY_APP:-tasknodeofficial-dev}"
local_port="${DEATHMARCH_MPG_LOCAL_PORT:-16433}"

cd "$repo_dir"

if [[ -f .env.tasknodeofficial-dev ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.tasknodeofficial-dev
  set +a
fi

remote_database_url="$($fly_bin ssh console --quiet --app "$app_name" --command 'printenv DATABASE_URL' 2>/dev/null \
  | awk '/^postgres(ql)?:\/\// { value = $0 } END { print value }')"
if [[ -z "$remote_database_url" ]]; then
  echo "deathmarch_supervisor_error:remote_database_url_missing" >&2
  exit 1
fi

# Inference uses Vercel first and Ambient as backup. Credentials stay in memory.
# The Fly app's secrets are the source of truth: a stale key in the local .env
# file silently downgraded every post to the deterministic fallback (401s).
for inference_key_name in VERCEL_AI_GATEWAY_API_KEY AMBIENT_API_KEY; do
  inference_key_value="$($fly_bin ssh console --quiet --app "$app_name" --command "printenv $inference_key_name" 2>/dev/null | awk 'NF { value = $0 } END { print value }' || true)"
  if [[ -n "$inference_key_value" && "$inference_key_value" != *$'\n'* ]]; then
    export "$inference_key_name=$inference_key_value"
  elif [[ -z "${!inference_key_name:-}" ]]; then
    echo "deathmarch_supervisor_warning:${inference_key_name}_unavailable" >&2
  fi
done
unset inference_key_value
if [[ -z "${VERCEL_AI_GATEWAY_API_KEY:-${AI_GATEWAY_API_KEY:-${AMBIENT_API_KEY:-}}}" ]]; then
  echo "deathmarch_supervisor_warning:inference_not_configured_using_safe_fallback" >&2
fi

export DEATHMARCH_DATABASE_URL="$(
  REMOTE_DATABASE_URL="$remote_database_url" LOCAL_DATABASE_PORT="$local_port" \
    /usr/bin/node -e '
      const url = new URL(process.env.REMOTE_DATABASE_URL);
      url.hostname = "127.0.0.1";
      url.port = process.env.LOCAL_DATABASE_PORT;
      url.searchParams.delete("sslmode");
      process.stdout.write(url.toString());
    '
)"
export DEATHMARCH_DISCORD_CHANNEL_ID="${DEATHMARCH_DISCORD_CHANNEL_ID:-${DEATHMARCH_CHANNEL_ID:-}}"
# Team fan-out: the watched wallet's account is the manager; every account that
# shares task history with it (direct reports / collaborators) is polled too and
# attributed by public handle. DEATHMARCH_TEAM_FANOUT=false restores single-wallet.
export DEATHMARCH_WALLET_HANDLE="${DEATHMARCH_WALLET_HANDLE:-goodalexander}"
export DEATHMARCH_DATABASE_CONNECTION_TIMEOUT_MS="${DEATHMARCH_DATABASE_CONNECTION_TIMEOUT_MS:-15000}"
export DEATHMARCH_DATABASE_QUERY_TIMEOUT_MS="${DEATHMARCH_DATABASE_QUERY_TIMEOUT_MS:-30000}"

exec /usr/bin/npm run deathmarch -- "$@"
