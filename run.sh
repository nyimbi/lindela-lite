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
#                   to switch it on. Auth already in the environment (a
#                   LINDELA_LITE_TOKENS list, or LINDELA_LITE_API_KEY) is
#                   inherited — this runner stopped stripping it out, because
#                   silently discarding the operator's configured auth and then
#                   saying "authentication is disabled" was two bugs in one.
#
# bash 3.2, because that is what macOS ships.
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT
cd "$REPO_ROOT"

PORT=""
PORT_EXPLICIT=0
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
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Usage:
  ./run.sh [options]

Options:
  --port <n>        Port to listen on. Default: 4177, else the next free one.
                    1–65535.
  --host <addr>     Bind address. Default: 127.0.0.1 (this machine only).
                    Use 0.0.0.0 to reach it from other machines — see below.
  --store <path>    JSON store path. Default: data/lindela-lite-store.json
  --postgres <url>  Use PostgreSQL instead of the JSON store. Applies the
                    schema, so the first run against a fresh database migrates.
  --key <value>     Require this API key. Without a key from this flag or the
                    environment, auth is disabled.
  --seed            Seed a demo store first. Ingests live public sources, so
                    it needs network and takes a few minutes.
  --fresh           Delete the JSON store before starting. It does not touch a
                    PostgreSQL store — that would mean truncating a database
                    from a flag.
  --check           Preflight only. Report what would happen and stop.
  -h, --help        This message.

Environment:
  LINDELA_LITE_TOKENS / LINDELA_LITE_API_KEY are inherited as-is; --key
  overrides LINDELA_LITE_API_KEY but refuses to be combined with a token list
  the server would prefer anyway.

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
    --port) [ $# -ge 2 ] || die "--port needs a value"; [ -n "$2" ] || die "--port needs a non-empty value"; PORT="$2"; PORT_EXPLICIT=1; shift 2 ;;
    --host)  [ $# -ge 2 ] || die "--host needs a value"; [ -n "$2" ] || die "--host needs a non-empty value";  HOST_ADDR="$2"; shift 2 ;;
    --store) [ $# -ge 2 ] || die "--store needs a value"; [ -n "$2" ] || die "--store needs a non-empty value"; STORE="$2"; shift 2 ;;
    --postgres) [ $# -ge 2 ] || die "--postgres needs a value"; [ -n "$2" ] || die "--postgres needs a non-empty value"; DB_URL="$2"; shift 2 ;;
    --key) [ $# -ge 2 ] || die "--key needs a value"; [ -n "$2" ] || die "--key needs a non-empty value"; API_KEY="$2"; shift 2 ;;
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
  if [ "$FRESH" = 1 ]; then
    warn "--fresh does not apply to a PostgreSQL store — it would mean truncating
      a database from a flag. The JSON --fresh is the only one this script does."
    FRESH=0
  fi
else
  STORE_MODE="json"
  [ -n "$STORE" ] || STORE='data/lindela-lite-store.json'
fi

# An occupied port is the most common reason a "just running it locally" fails,
# and it is cheaper to find than to diagnose from a connection refused. An
# explicit --port is not second-guessed: it fails loudly at bind time instead.
case "$PORT" in
  ''|*[!0-9]*) [ "$PORT" = "" ] || die "port must be numeric (got: $PORT)" ;;
esac
if [ "$PORT" != "" ]; then
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "port out of range (1–65535): $PORT"
fi
if [ "$PORT_EXPLICIT" = 0 ]; then
  PORT="${LINDELA_LITE_PORT:-4177}"
  case "$PORT" in
    ''|*[!0-9]*) die "LINDELA_LITE_PORT must be numeric (got: $PORT)" ;;
  esac
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    candidate="$PORT"
    # Inclusive bound, and it stops on the first free port. The loop used to
    # walk past the last scanned port and hand the caller whatever it held.
    while [ "$candidate" -le 4300 ] && lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; do
      candidate=$((candidate + 1))
    done
    [ "$candidate" -le 4300 ] || die "ports 4177–4300 are all in use. Free one, or pass --port."
    warn "port $PORT is in use — using $candidate instead"
    PORT="$candidate"
  fi
fi
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "port out of range (1–65535): $PORT"

step "Configuration"
info "mode     $STORE_MODE"
if [ "$STORE_MODE" = postgres ]; then
  # The password is a URL credential and is not printed. The rest is useful.
  printf '  %-8s %s\n' "database" "$(printf '%s' "$DB_URL" | sed -E 's#://([^:]*):[^@]*@#://\1:***@#')"
else
  info "store    $STORE"
  if [ -f "$STORE" ]; then
    size="$(du -h "$STORE" 2>/dev/null | cut -f1)"
    if [ "$FRESH" = 1 ]; then
      info "          $size — will be removed by --fresh before this starts"
    else
      info "          $size, existing data will be kept"
    fi
  else
    info "          does not exist yet — starts empty"
  fi
fi
info "bind     $HOST_ADDR:$PORT"

# A stale heartbeat reads as a broken install to whoever opens the dashboard:
# /api/v1/health answers 503 until a cycle completes. The store's own last
# completed cycle is knowable here, so say it before the browser ever asks.
if [ "$CHECK_ONLY" = 1 ] && [ -f "$STORE" ]; then
  hb_age="$(node -e '
    try {
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const hb = s && s.system_heartbeat && s.system_heartbeat[0]
      if (hb && hb.at) console.log(Math.max(0, Math.round((Date.now() - Date.parse(hb.at)) / 1000)))
    } catch { /* unreadable store: the server will say so */ }
  ' "$STORE" 2>/dev/null || true)"
  if [ -n "$hb_age" ] && [ "$hb_age" -gt 1800 ]; then
    warn "this store's last completed pipeline cycle is ${hb_age}s old. /api/v1/health will answer 503 until a cycle completes — the boot tick takes minutes (it ingests live public sources), or force one now with:"
    warn "  curl -X POST http://127.0.0.1:$PORT/api/v1/ingest/run-due"
  fi
fi

# Authentication: --key wins, then whatever the environment already carries.
# The runner used to unset both environment variables at start-up, which
# silently stripped an operator's configured token list — and then warned that
# auth was off. The server prefers a token list over an API key, so --key is
# refused next to one rather than quietly ignored.
if [ -n "$API_KEY" ] && [ -n "${LINDELA_LITE_TOKENS:-}" ]; then
  die "--key and LINDELA_LITE_TOKENS in your environment would both set auth; the server prefers the token list and --key would be ignored. Unset one."
fi
if [ -n "$API_KEY" ]; then
  if [ -n "${LINDELA_LITE_API_KEY:-}" ] && [ "$API_KEY" != "$LINDELA_LITE_API_KEY" ]; then
    warn "--key overrides LINDELA_LITE_API_KEY already in your environment"
  fi
  info "auth     API key required"
elif [ -n "${LINDELA_LITE_TOKENS:-}" ]; then
  info "auth     token list inherited from LINDELA_LITE_TOKENS"
  if [ -n "${LINDELA_LITE_API_KEY:-}" ]; then
    warn "the environment sets both LINDELA_LITE_TOKENS and LINDELA_LITE_API_KEY; the server uses the token list and ignores the API key"
  fi
elif [ -n "${LINDELA_LITE_API_KEY:-}" ]; then
  info "auth     API key inherited from LINDELA_LITE_API_KEY"
else
  warn "no --key and none in the environment: authentication is off, every route is open"
  case "$HOST_ADDR" in
    127.0.0.1|localhost|::1) info "          acceptable on loopback; not acceptable on any other bind" ;;
    *) die "refusing to start unauthenticated on $HOST_ADDR — pass --key, or bind 127.0.0.1"
  esac
fi

if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$DO_SEED" = 1 ]; then
    info "--seed was requested; --check does not run it"
  fi
  if [ "${FRESH:-0}" = 1 ]; then
    info "--fresh was requested; --check does not run it"
  fi
  step "Preflight passed — nothing was started"
  exit 0
fi

# ----------------------------------------------------------------- prepare

if [ "$FRESH" = 1 ] && [ "$STORE_MODE" = json ] && [ -f "$STORE" ]; then
  step "Removing $STORE"
  rm -f "$STORE"
  info "gone — this is not recoverable, which is why --fresh is only honored on the JSON store"
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
# Environment honesty: auth variables not chosen for this run leave the
# environment, so what the preflight said is what the server will see. The
# chosen source is kept rather than re-exported — an inherited token list is
# the operator's file, and passing it through verbatim is all that is required.
unset LINDELA_LITE_DB_MODE LINDELA_LITE_STORE LINDELA_LITE_DATABASE_URL DATABASE_URL
if [ -n "$API_KEY" ]; then
  unset LINDELA_LITE_TOKENS
  export LINDELA_LITE_API_KEY="$API_KEY"
elif [ -n "${LINDELA_LITE_TOKENS:-}" ]; then
  # The token list is the chosen auth; the server prefers it over any API key
  # anyway, so an inherited API key would only be dead weight next to it.
  unset LINDELA_LITE_API_KEY
else
  unset LINDELA_LITE_TOKENS
fi

if [ "$STORE_MODE" = postgres ]; then
  export LINDELA_LITE_DB_MODE=postgres
  export LINDELA_LITE_DATABASE_URL="$DB_URL"
else
  export LINDELA_LITE_DB_MODE=json
  export LINDELA_LITE_STORE="$STORE"
fi

step "Starting"
case "$HOST_ADDR" in
  127.0.0.1|localhost|::1) URL="http://127.0.0.1:$PORT" ;;
  0.0.0.0|'::')
    URL="http://127.0.0.1:$PORT"
    echo "  Bound to every interface ($HOST_ADDR) — reachable from your network." ;;
  *) URL="http://$HOST_ADDR:$PORT" ;;
esac
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
elif [ -n "${LINDELA_LITE_TOKENS:-}" ]; then
  cat <<EOF
  Authentication comes from the LINDELA_LITE_TOKENS list in your environment;
  present one as a bearer token as the dashboard would.

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