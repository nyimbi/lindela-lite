#!/usr/bin/env bash
#
# Run Lindela Lite locally, straight from this checkout.
#
#   ./run.sh                  # http://127.0.0.1:4177, JSON store, no Docker
#   ./run.sh --seed           # seed a demo store first (needs network)
#   ./run.sh --check          # preflight only; start nothing
#   ./run.sh --host 0.0.0.0   # reachable from your network
#
# This is a developer runner, not a deployment. For a real deployment use
# deploy/one-click.sh (Compose), scripts/deploy.sh (over SSH), or install.sh.
# The difference that matters is below, under "What this will not do".
#
# Defaults, and why each:
#
#   loopback only   `npm start` binds 0.0.0.0 by default — the container needs
#                   that, and a bare-metal run inherits it — and with no tokens
#                   configured, auth is off. On a laptop that publishes an
#                   unauthenticated platform holding field reports to the whole
#                   office network. So this binds 127.0.0.1 unless told
#                   otherwise, and says which it did.
#   JSON store      No Docker, no PostgreSQL, no migrations. `npm start` alone
#                   needs none of them, and a first run should not either.
#   no auth         Matches `npm start` with a bare environment. Convenient on
#                   loopback, which is why the default is loopback. Use --key
#                   to switch it on.
#
# bash 3.2, because that is what macOS ships.
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT
cd "$REPO_ROOT"

PORT=""
HOST_ADDR="127.0.0.1"
STORE=""
DB_URL=""
API_KEY=""
DO_SEED=0
FRESH=0
CHECK_ONLY=0

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[2m·\033[0m %s\n' "$*"; }
step() { printf '\033[1m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Usage:
  ./run.sh [options]

Options:
  --port <n>        Port to listen on. Default: 4177, else the next free one.
  --host <addr>     Bind address. Default: 127.0.0.1 (this machine only).
                    Use 0.0.0.0 to reach it from other machines — see below.
  --store <path>    JSON store path. Default: data/lindela-lite-store.json
  --postgres <url>  Use PostgreSQL instead of the JSON store. Applies the
                    schema, so the first run against a fresh database migrates.
  --key <value>     Require this API key. Without it, auth is disabled.
  --seed            Seed a demo store first. Ingests live public sources, so
                    it needs network and takes a few minutes.
  --fresh           Delete the store before starting. Asks nothing; the store
                    is the only thing removed and it is not a git checkout.
  --check           Preflight only. Report what would happen and stop.
  -h, --help        This message.

Examples:
  ./run.sh --check
  ./run.sh --seed
  ./run.sh --key my-dev-key --port 4180
  ./run.sh --postgres postgresql://lindela:lindela@127.0.0.1:5432/lindela_lite
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2 ;;
    --host)  [ $# -ge 2 ] || die "--host needs a value";  HOST_ADDR="$2"; shift 2 ;;
    --store) [ $# -ge 2 ] || die "--store needs a value"; STORE="$2"; shift 2 ;;
    --postgres) [ $# -ge 2 ] || die "--postgres needs a value"; DB_URL="$2"; shift 2 ;;
    --key) [ $# -ge 2 ] || die "--key needs a value"; API_KEY="$2"; shift 2 ;;
    --seed) DO_SEED=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) die "unexpected argument: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- preflight

step "Checking the toolchain"

command -v node >/dev/null 2>&1 || die "node is not on PATH. Lindela Lite needs Node 20 or newer."

# Compare major versions numerically rather than by string, so Node 9 does not
# read as newer than Node 20.
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node $node_major found; Lindela Lite needs 20 or newer."
info "node $(node --version)"

if [ ! -d node_modules ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "node_modules is missing — run 'npm ci' first"
  else
    step "Installing dependencies"
    npm ci
  fi
else
  info "dependencies installed"
fi

# ------------------------------------------------------------------ config

if [ -n "$DB_URL" ]; then
  STORE_MODE="postgres"
else
  STORE_MODE="json"
  [ -n "$STORE" ] || STORE='data/lindela-lite-store.json'
fi

# An occupied port is the most common reason a "just running it locally" fails,
# and it is cheaper to find than to diagnose from a connection refused.
if [ -z "$PORT" ]; then
  PORT="${LINDELA_LITE_PORT:-4177}"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    candidate="$PORT"
    while lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1 && [ "$candidate" -lt 4300 ]; do
      candidate=$((candidate + 1))
    done
    warn "port $PORT is in use — using $candidate instead"
    PORT="$candidate"
  fi
fi
case "$PORT" in
  ''|*[!0-9]*) die "port must be numeric (got: $PORT)" ;;
esac

step "Configuration"
info "mode     $STORE_MODE"
if [ "$STORE_MODE" = postgres ]; then
  # The password is a URL credential and is not printed. The rest is useful.
  printf '  %-8s %s\n' "database" "$(printf '%s' "$DB_URL" | sed -E 's#://([^:]*):[^@]*@#://\1:***@#')"
else
  info "store    $STORE"
  if [ -f "$STORE" ]; then
    size="$(du -h "$STORE" 2>/dev/null | cut -f1)"
    info "          $size, existing data will be kept"
  else
    info "          does not exist yet — starts empty"
  fi
fi
info "bind     $HOST_ADDR:$PORT"

if [ -z "$API_KEY" ]; then
  warn "no --key: authentication is disabled, every route is open"
  if [ "$HOST_ADDR" = "127.0.0.1" ] || [ "$HOST_ADDR" = "localhost" ]; then
    info "          acceptable on loopback; not acceptable on any other bind"
  else
    die "refusing to start unauthenticated on $HOST_ADDR — pass --key, or bind 127.0.0.1"
  fi
else
  info "auth     API key required"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  step "Preflight passed — nothing was started"
  exit 0
fi

# ----------------------------------------------------------------- prepare

if [ "$FRESH" = 1 ] && [ "$STORE_MODE" = json ] && [ -f "$STORE" ]; then
  step "Removing $STORE"
  rm -f "$STORE"
  info "gone — this is not recoverable, which is why --fresh asks you for the flag"
fi

mkdir -p data 2>/dev/null || true

if [ "$DO_SEED" = 1 ]; then
  step "Seeding a demo store"
  warn "this ingests live public sources and needs network access"
  if [ "$STORE_MODE" = postgres ]; then
    LINDELA_LITE_DB_MODE=postgres \
    LINDELA_LITE_DATABASE_URL="$DB_URL" \
      node scripts/seed-demo.mjs
  else
    LINDELA_LITE_DB_MODE=json \
    LINDELA_LITE_STORE="$STORE" \
      node scripts/seed-demo.mjs
  fi
  info "seeded"
fi

# ------------------------------------------------------------------- start

# One process, so Ctrl-C stops it. A wrapper that keeps running after the child
# dies leaves a port occupied and a stale store lock, which is the worst
# possible thing for a script whose whole job is to be repeatable.
export LINDELA_LITE_PORT="$PORT"
export LINDELA_LITE_HOST="$HOST_ADDR"
unset LINDELA_LITE_TOKENS LINDELA_LITE_API_KEY LINDELA_LITE_DB_MODE \
      LINDELA_LITE_STORE LINDELA_LITE_DATABASE_URL DATABASE_URL

if [ "$STORE_MODE" = postgres ]; then
  export LINDELA_LITE_DB_MODE=postgres
  export LINDELA_LITE_DATABASE_URL="$DB_URL"
else
  export LINDELA_LITE_DB_MODE=json
  export LINDELA_LITE_STORE="$STORE"
fi

[ -n "$API_KEY" ] && export LINDELA_LITE_API_KEY="$API_KEY"

step "Starting"
if [ "$HOST_ADDR" = "127.0.0.1" ] || [ "$HOST_ADDR" = "localhost" ]; then
  URL="http://127.0.0.1:$PORT"
else
  URL="http://$HOST_ADDR:$PORT"
fi
cat <<EOF
  $URL
  Health: $URL/api/v1/health

EOF
if [ -n "$API_KEY" ]; then
  cat <<EOF
  Paste this into the dashboard's API key field — it has no session and sends
  the key per request:
    $API_KEY

EOF
else
  cat <<EOF
  No API key is required on this instance.

EOF
fi
cat <<'EOF'
  Ctrl-C to stop.

EOF

exec node src/server.js
