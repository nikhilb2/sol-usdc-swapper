#!/usr/bin/env bash
# make-secret.sh — create/update sol-swapper-secrets in the nikhil namespace
# from your local .env, without writing any secret to disk or shell history.
#
#   ./k8s/make-secret.sh [--dry-run]
#
# DATABASE_URL: your local .env points at 127.0.0.1:5436, which the cluster
# cannot reach. Set K8S_DATABASE_URL in .env to the in-cluster URL and this
# script prefers it. Percent-encode the password — a literal # truncates the
# URL at the fragment.

set -euo pipefail

NS=nikhil
NAME=sol-swapper-secrets
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

[[ -f "$ENV_FILE" ]] || { echo "❌ $ENV_FILE not found"; exit 1; }

# Read .env without executing it, so a stray backtick can't run anything.
get() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  [[ -z "$line" ]] && { echo ""; return; }
  line="${line#*=}"
  # strip one layer of surrounding quotes
  [[ "$line" == \"*\" ]] && line="${line:1:${#line}-2}"
  [[ "$line" == \'*\' ]] && line="${line:1:${#line}-2}"
  printf '%s' "$line"
}

PRIVATE_KEY="$(get PRIVATE_KEY)"
RPC_URL="$(get RPC_URL)"
DASHBOARD_USER="$(get DASHBOARD_USER)"
DASHBOARD_PASSWORD="$(get DASHBOARD_PASSWORD)"
JUPITER_API_KEY="$(get JUPITER_API_KEY)"
COINGECKO_API_KEY="$(get COINGECKO_API_KEY)"

DB="$(get K8S_DATABASE_URL)"
if [[ -z "$DB" ]]; then
  DB="$(get DATABASE_URL)"
  if [[ "$DB" == *"127.0.0.1"* || "$DB" == *"localhost"* ]]; then
    cat >&2 <<MSG
❌ DATABASE_URL points at $(sed -E 's#.*@([^/]+).*#\1#' <<<"$DB"), which no pod can reach.

   Create the database on the shared instance, then add the in-cluster URL to .env:

     K8S_DATABASE_URL=postgresql://solswapper:<encoded-pw>@postgres.db.svc.cluster.local:5432/sol-swapper

MSG
    exit 1
  fi
fi

# Fail loudly rather than shipping a half-configured secret.
missing=()
[[ -z "$PRIVATE_KEY" ]]        && missing+=(PRIVATE_KEY)
[[ -z "$RPC_URL" ]]            && missing+=(RPC_URL)
[[ -z "$DB" ]]                 && missing+=(K8S_DATABASE_URL)
[[ -z "$DASHBOARD_USER" ]]     && missing+=(DASHBOARD_USER)
[[ -z "$DASHBOARD_PASSWORD" ]] && missing+=(DASHBOARD_PASSWORD)
if (( ${#missing[@]} )); then
  echo "❌ missing in .env: ${missing[*]}" >&2; exit 1
fi
if (( ${#DASHBOARD_PASSWORD} < 12 )); then
  echo "❌ DASHBOARD_PASSWORD is ${#DASHBOARD_PASSWORD} chars; the server requires >= 12" >&2; exit 1
fi

# Rendered to YAML on stdout then piped into apply, so this both creates and
# updates, and no value ever appears in `ps` output or your shell history.
# (macOS ships bash 3.2, where "${arr[@]}" on an empty array trips `set -u` —
# hence the plain if/else rather than an args array.)
render() {
  kubectl -n "$NS" create secret generic "$NAME" \
    --from-literal=PRIVATE_KEY="$PRIVATE_KEY" \
    --from-literal=RPC_URL="$RPC_URL" \
    --from-literal=DATABASE_URL="$DB" \
    --from-literal=DASHBOARD_USER="$DASHBOARD_USER" \
    --from-literal=DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD" \
    --from-literal=JUPITER_API_KEY="$JUPITER_API_KEY" \
    --from-literal=COINGECKO_API_KEY="$COINGECKO_API_KEY" \
    --dry-run=client -o yaml
}

if [[ "${1:-}" == "--dry-run" ]]; then
  # Redact before showing: this prints to a terminal.
  render | sed -E 's/^([[:space:]]+)(PRIVATE_KEY|DATABASE_URL|RPC_URL|DASHBOARD_PASSWORD):.*/\1\2: <redacted>/'
  exit 0
fi

render | kubectl apply -f - >/dev/null

echo "✅ $NS/$NAME applied ($(sed -E 's#://[^@]*@#://***@#' <<<"$DB"))"
echo "   restart to pick it up:  kubectl -n $NS rollout restart deploy/sol-swapper"
