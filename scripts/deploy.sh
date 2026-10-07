#!/usr/bin/env bash
#
# Deploy Lindela Lite to a remote host over SSH.
#
#   ./scripts/deploy.sh deploy@edge.example.org
#   ./scripts/deploy.sh deploy@203.0.113.10:2222 --ref main --port 4177
#
# The remote host needs Docker with Compose. Everything else — the image build,
# PostgreSQL, secrets, the periodic driver — is what `deploy/one-click.sh` and
# `docker-compose.yml` already do; this script only moves the code across and
# then runs that same stack there. It deliberately does not have a second
# deployment story, because a second one is a second thing that can be wrong.
#
# What it will not do, and why:
#
#   - It will not copy your local `.env` to the host. That file holds whatever
#     API key this workstation uses. A deployment that inherits it makes your
#     dev credentials the production credentials. Secrets are generated on the
#     host, once, and never overwritten afterwards.
#   - It will not `--delete` anything on the host. The Postgres volume and the
#     `.env` live on the far side of that flag; a deploy must not be able to
#     destroy the database it is deploying against.
#   - It will not print the API key unless you ask for it, because this output
#     is the first thing that ends up in a ticket or a CI log.
#
set -euo pipefail

# bash 3.2, because that is what macOS ships and this runs on the operator's
# machine, not in the image. No associative arrays, no ${var,,}.
IFS=$'\n\t'
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

ENDPOINT=""
REMOTE_REF=""
REMOTE_DIR=""
REMOTE_HOME=""
REMOTE_PORT=""
TRANSPORT="auto"
INIT_SCHEDULES=1
SHOW_KEY=0
DRY_RUN=0
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Usage:
  scripts/deploy.sh <user@host[:port]> [options]

Arguments:
  <user@host[:port]>   SSH destination. A ~/.ssh/config alias is fine.

Options:
  --ref <ref>          Git ref to deploy (branch, tag or SHA).
                       Default: the current branch.
  --dir <path>         Install directory on the host. Default: ~/lindela-lite
  --port <n>           Host port to publish. Default: 4177
  --transport <t>      git | rsync | auto. Default: auto
                       auto uses git, falling back to rsync.
  --no-init-schedules  Do not create the default ingestion schedules.
  --show-key           Print the host's API key at the end.
  --dry-run            Print what would happen and stop.
  -h, --help           This message.

Notes:
  The host needs Docker with Compose. `git` is used when both ends have the
  repo; otherwise the working tree is copied with rsync. Either way the host
  builds its own image from its own copy of the source.

  After the first deploy, the API key lives only on the host, in <dir>/.env.
  Read it with:
    ssh <user@host> 'grep LINDELA_LITE_API_KEY <dir>/.env'
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '\033[2m·\033[0m %s\n' "$*"; }
step() { printf '\033[1m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run]'; printf ' %q' "$@"; printf '\n'
    return 0
  fi
  "$@"
}

remote() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] ssh'; printf ' %q' "${SSH_OPTS[@]}" "$ENDPOINT" "$@"; printf '\n'
    return 0
  fi
  # The remote command is assembled here and expanded by the far shell, which is
  # the point — but it also means it must never be built from unchecked input.
  # Every call site interpolates only REMOTE_DIR / REMOTE_PORT / ENDPOINT, all of
  # which are validated above.
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$ENDPOINT" "$@"
}

# ---------------------------------------------------------------- arguments

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REMOTE_REF="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; REMOTE_DIR="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; REMOTE_PORT="$2"; shift 2 ;;
    --transport) [ $# -ge 2 ] || die "--transport needs a value"; TRANSPORT="$2"; shift 2 ;;
    --no-init-schedules) INIT_SCHEDULES=0; shift ;;
    --show-key) SHOW_KEY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *)
      [ -z "$ENDPOINT" ] || die "unexpected argument: $1 — the endpoint takes one value"
      ENDPOINT="$1"; shift ;;
  esac
done

[ -n "$ENDPOINT" ] || { usage >&2; exit 1; }

# The endpoint is interpolated into an ssh command line, so it is validated
# rather than quoted-and-hoped. Without this, a destination of
# `--dry-run; rm -rf ~` would be accepted and read as an ssh option plus a
# second command. Bash 3.2 has no ${var,,}, hence the tr for the dash test.
case "$(printf '%s' "$ENDPOINT" | tr '[:upper:]' '[:lower:]')" in
  -*) die "endpoint may not start with a dash — that would be read as an ssh option" ;;
esac
# Three legitimate shapes: user@host, user@host:port, and a bare host or
# ~/.ssh/config alias. Everything else is refused rather than escaped.
if ! printf '%s' "$ENDPOINT" \
  | grep -Eq '^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+(:[0-9]{1,5})?$'; then
  die "endpoint must look like user@host, user@host:port, or a host/alias (got: $ENDPOINT)"
fi
case "$ENDPOINT" in
  *:0|*:00000) die "port 0 is not a destination port" ;;
esac
# The regex above caps the ssh port at five digits but not at 65535, so 99999
# passed validation and reached the push stage before failing. Check the range
# on whatever the user actually asked for.
ssh_port="${ENDPOINT##*:}"
case "$ENDPOINT" in
  *:*)
    case "$ssh_port" in
      ''|*[!0-9]*) die "port must be numeric (got: $ssh_port)" ;;
    esac
    [ "$ssh_port" -ge 1 ] && [ "$ssh_port" -le 65535 ] \
      || die "ssh port out of range: $ssh_port"
    ;;
esac

if [ -z "$REMOTE_REF" ]; then
  REMOTE_REF="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
fi
[ -n "$REMOTE_PORT" ] || REMOTE_PORT=4177
case "$REMOTE_PORT" in
  ''|*[!0-9]*) die "port must be numeric (got: $REMOTE_PORT)" ;;
esac
[ "$REMOTE_PORT" -ge 1 ] && [ "$REMOTE_PORT" -le 65535 ] || die "port out of range: $REMOTE_PORT"

case "$TRANSPORT" in
  auto|git|rsync) ;;
  *) die "transport must be git, rsync or auto (got: $TRANSPORT)" ;;
esac

# ------------------------------------------------------------------ preflight

step "Checking $ENDPOINT"
if ! run ssh "${SSH_OPTS[@]}" "$ENDPOINT" true; then
  die "cannot reach $ENDPOINT over SSH. Add a key or an ssh_config entry, then rerun."
fi
info "reachable"

if [ "$DRY_RUN" = 0 ]; then
  if ! remote 'command -v docker >/dev/null 2>&1'; then
    die "$ENDPOINT has no docker. This deploys the published Compose stack; there is no bare-metal path."
  fi
  if ! remote 'docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1'; then
    die "$ENDPOINT has docker but no Compose. Install the compose plugin and rerun."
  fi
  if ! remote 'docker info >/dev/null 2>&1'; then
    die "docker is installed on $ENDPOINT but not running or not accessible to $USER."
  fi
fi
info "docker + compose present"

# A compose file the host cannot build is the most common late failure, so it is
# worth catching before anything is transferred.
# A port already in use is the most common late failure, and it is cheap to see
# before anything is transferred. ${REMOTE_PORT} needs braces: `$REMOTE_PORT[`
# parses as an array subscript and silently mangles the pattern.
if [ "$DRY_RUN" = 0 ]; then
  busy="$(remote "ss -ltn 2>/dev/null || netstat -an 2>/dev/null || true" \
    | grep -E "[:.]${REMOTE_PORT}[[:space:]]" || true)"
  if [ -n "$busy" ]; then
    warn "port $REMOTE_PORT already has a listener on the host."
    warn "Choose another with --port, or stop whatever holds it."
  fi
fi

# ------------------------------------------------------------------- code

step "Transferring the source"

# Resolved from the host rather than assumed, because a quoted `~` does not
# expand — not locally and not remotely either.
if [ "$DRY_RUN" = 0 ]; then
  # Single-quoted on purpose: $HOME must expand on the host, not here.
  # shellcheck disable=SC2016
  REMOTE_HOME="$(remote 'printf %s "$HOME"')"
else
  REMOTE_HOME='<remote-home>'
fi
[ -n "$REMOTE_DIR" ] || REMOTE_DIR="$REMOTE_HOME/lindela-lite"
readonly REMOTE_DIR

remote_compose() {
  remote "cd '$REMOTE_DIR' && if docker compose version >/dev/null 2>&1; then echo compose; else echo docker-compose; fi"
}

have_remote_repo() {
  remote "test -d '$REMOTE_DIR/.git'"
}

rsync_both_ends() {
  command -v rsync >/dev/null 2>&1 && remote 'command -v rsync >/dev/null 2>&1'
}

# auto: git when the host already has the repository (fast, and it keeps the
# host's own history), rsync when it does not. A bare host is the common case
# for a first deploy, and rsync needs no credentials on the far side.
mode=""
case "$TRANSPORT" in
  rsync)
    rsync_both_ends || die "--transport rsync, but rsync is not installed on both ends"
    mode=rsync ;;
  git)
    have_remote_repo || die "--transport git, but $REMOTE_DIR is not a git repository on the host"
    mode=git ;;
  auto)
    if have_remote_repo; then
      mode=git
    elif rsync_both_ends; then
      mode=rsync
      info "no repository on the host yet — copying the working tree"
    else
      mode=tar
      info "no repository on the host and no rsync — streaming a tarball"
    fi ;;
esac

case "$mode" in
  rsync)
    # No --delete, and data/ and .env are excluded outright. A deploy that can
    # erase the target's database is not a deploy.
    run rsync -az \
      --exclude '.git/' --exclude 'node_modules/' --exclude 'data/' \
      --exclude '.env' --exclude '.env.qa' --exclude '.env.*' \
      --exclude 'artifacts/' --exclude '*.log' \
      -e "ssh ${SSH_OPTS[*]}" \
      "$REPO_ROOT/" "$ENDPOINT:$REMOTE_DIR/"
    info "working tree copied to $REMOTE_DIR" ;;
  tar)
    run ssh "${SSH_OPTS[@]}" "$ENDPOINT" "mkdir -p '$REMOTE_DIR'"
    run bash -c \
      "tar -czf - -C '$REPO_ROOT' --exclude=.git --exclude=node_modules --exclude=data --exclude='.env*' . | ssh ${SSH_OPTS[*]} '$ENDPOINT' 'tar -xzf - -C $REMOTE_DIR'"
    info "working tree streamed to $REMOTE_DIR" ;;
  git)
    # Pushing to a remote requires the host to hold a key this repository trusts.
    # If it does not, say so and offer the transport that does not need one,
    # rather than failing on a permission error at the end of a long build.
    if ! git -C "$REPO_ROOT" push --dry-run "$REMOTE_REF" "HEAD:$REMOTE_REF" >/dev/null 2>&1; then
      die "cannot push to '$REMOTE_REF' on the host — it has no key this repository trusts. Use --transport rsync."
    fi
    run git -C "$REPO_ROOT" push "$REMOTE_REF" "HEAD:$REMOTE_REF"
    info "pushed HEAD to $REMOTE_REF on $REMOTE_DIR" ;;
esac

# ---------------------------------------------------------------- secrets

step "Preparing configuration on the host"

if [ "$DRY_RUN" = 0 ]; then
  if remote "test -f '$REMOTE_DIR/.env'"; then
    info "existing .env kept — the API key on this host is unchanged"
  else
    remote "cd '$REMOTE_DIR' && cp .env.example .env && chmod 600 .env"
    remote "cd '$REMOTE_DIR' && \
      api=\$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n') && \
      pw=\$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n') && \
      sed -i \
        -e \"s|^LINDELA_LITE_API_KEY=.*|LINDELA_LITE_API_KEY=\$api|\" \
        -e \"s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=\$pw|\" \
        -e \"s|^LINDELA_LITE_DATABASE_URL=.*|LINDELA_LITE_DATABASE_URL=postgresql://lindela:\$pw@db:5432/lindela_lite|\" \
        -e \"s|^LINDELA_LITE_PORT=.*|LINDELA_LITE_PORT=$REMOTE_PORT|\" \
        .env"
    info "generated fresh secrets on the host"
  fi
fi

# ------------------------------------------------------------------ deploy

step "Building and starting the stack"
if [ "$DRY_RUN" = 0 ]; then
  compose_cmd="$(remote_compose)"
  info "using $compose_cmd"
  remote "cd '$REMOTE_DIR' && $compose_cmd up -d --build"
  info "stack started"
else
  remote "cd '$REMOTE_DIR' && docker compose up -d --build"
fi

# ------------------------------------------------------------------- verify

step "Waiting for health"
if [ "$DRY_RUN" = 0 ]; then
  ok=0
  for _ in $(seq 1 60); do
    if remote "curl -fsS 'http://127.0.0.1:$REMOTE_PORT/api/v1/health' >/dev/null 2>&1"; then
      ok=1; break
    fi
    sleep 3
  done
  [ "$ok" = 1 ] || {
    warn "the host did not report healthy in time. Recent app log:"
    remote "cd '$REMOTE_DIR' && docker compose logs --tail 40 app" >&2 || true
    die "deploy failed verification — nothing above is a guess, the host is the source"
  }
  info "healthy"

  if [ "$INIT_SCHEDULES" = 1 ]; then
    key="$(remote "grep '^LINDELA_LITE_API_KEY=' '$REMOTE_DIR/.env' | cut -d= -f2-")"
    if remote "curl -fsS -X POST 'http://127.0.0.1:$REMOTE_PORT/api/v1/ingest/schedules/defaults' -H 'x-api-key: $key' >/dev/null 2>&1"; then
      info "default ingestion schedules created"
    else
      warn "could not create default ingestion schedules — the stack is up, this is not fatal"
    fi
  fi
fi

# ------------------------------------------------------------------ report

health_json="$(remote "curl -fsS 'http://127.0.0.1:$REMOTE_PORT/api/v1/health' 2>/dev/null || echo '{}")"
pipeline_healthy="$(printf '%s' "$health_json" | sed -n 's/.*"healthy":\(true\|false\).*/\1/p' | head -1)"
version="$(printf '%s' "$health_json" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"

printf '\n'
step "Deployed $ENDPOINT"
cat <<EOF
  URL        http://$(printf '%s' "$ENDPOINT" | sed 's/.*@//'):$REMOTE_PORT
  Version    ${version:-unknown}
  Pipeline   ${pipeline_healthy:-unknown}
  Directory  $REMOTE_DIR

  The API key is in $REMOTE_DIR/.env on the host and was not printed.
EOF

if [ "$SHOW_KEY" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  printf '\n'
  printf '  API key   %s\n' "$(remote "grep '^LINDELA_LITE_API_KEY=' '$REMOTE_DIR/.env' | cut -d= -f2-")"
fi

cat <<EOF

  Paste the key into the dashboard's API key field. The dashboard has no
  session — it sends x-api-key per request — so it is blank until you do.

  Reach it, if the port is not already open:
    ssh -L $REMOTE_PORT:127.0.0.1:$REMOTE_PORT $ENDPOINT

  Operate it:
    ssh $ENDPOINT 'cd $REMOTE_DIR && docker compose logs -f app'
    ssh $ENDPOINT 'cd $REMOTE_DIR && docker compose ps'
    ssh $ENDPOINT 'cd $REMOTE_DIR && docker compose down'
    ssh $ENDPOINT 'cd $REMOTE_DIR && docker compose up -d --build'   # redeploy

EOF
