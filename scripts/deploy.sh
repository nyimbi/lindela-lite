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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

ENDPOINT=""
REMOTE_REF=""
REMOTE_DIR=""
REMOTE_HOME=""
REMOTE_PORT=""
REMOTE_PORT_EXPLICIT=0
TRANSPORT="auto"
INIT_SCHEDULES=1
SHOW_KEY=0
DRY_RUN=0
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
# The same options as a single string. It must stay literal rather than
# "${SSH_OPTS[*]}": with IFS=$'\n\t' the [*] join separates on a newline, and an
# rsync -e value of "ssh -o\nBatchMode=yes…" is not a remote-shell command — it
# is a broken one. rsync -e, the tar-over-ssh pipeline, and GIT_SSH_COMMAND
# below all read from this one string.
RSH="ssh -o BatchMode=yes -o ConnectTimeout=15"

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Usage:
  scripts/deploy.sh <user@host[:port]> [options]

Arguments:
  <user@host[:port]>   SSH destination. A ~/.ssh/config alias is fine.

Options:
  --ref <ref>          Git ref to deploy in --transport git (branch, tag or
                       SHA). Default: the current branch.
  --dir <path>         Install directory on the host. Default: ~/lindela-lite
  --port <n>           Host port to publish. Default: 4177
  --transport <t>      git | rsync | auto. Default: auto
                       auto uses git, falling back to rsync.
  --no-init-schedules  Do not create the default ingestion schedules.
  --show-key           Print the host's API key at the end.
  --dry-run            Print what would happen and stop.
  -h, --help           This message.

Notes:
  The host needs Docker with Compose. A git checkout on the host is updated by
  a push over SSH; otherwise the working tree is copied with rsync (or tar
  when rsync is missing on either end). Either way the host builds its own
  image from its own copy of the source. Endpoints are user@host, host, or an
  ~/.ssh/config alias, with an optional :port — IPv6 literals are not
  supported, because :port is ambiguous inside [::1].

  After the first deploy, the API key lives only on the host, in <dir>/.env.
  Read it with:
    ssh <user@host> 'grep LINDELA_LITE_API_KEY <dir>/.env'
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '\033[2m·\033[0m %s\n' "$*"; }
step() { printf '\033[1m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

# REMOTE_DIR travels into single quotes on the far shell and, in the tar
# transport, is unquoted there. The endpoint takes this same treatment:
# validated rather than quoted-and-hoped. A value of `x'; touch /tmp/x; '`
# closes the quote and runs a second command on the host — "it is the
# operator's own host" is not a defence when the script's offer is that it
# carries checked values only.
validate_remote_dir() {
  case "$1" in
    ''|*[!A-Za-z0-9._+/-]*)
      die "--dir must be a simple path: letters, digits and ./_+- only — quotes, spaces, \$, ';' and '|' would reach the shell on the host (got: $1)" ;;
    -*|*..*)
      die "--dir may not start with '-' or contain '..' (got: $1)" ;;
  esac
}

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
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; [ -n "$2" ] || die "--dir needs a non-empty value"; REMOTE_DIR="$2"; validate_remote_dir "$REMOTE_DIR"; shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; [ -n "$2" ] || die "--port needs a non-empty value"; REMOTE_PORT="$2"; REMOTE_PORT_EXPLICIT=1; shift 2 ;;
    --transport) [ $# -ge 2 ] || die "--transport needs a value"; [ -n "$2" ] || die "--transport needs a non-empty value"; TRANSPORT="$2"; shift 2 ;;
    --no-init-schedules) INIT_SCHEDULES=0; shift ;;
    --show-key) SHOW_KEY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *)
      [ -z "$ENDPOINT" ] || die "unexpected argument: $1 — the endpoint takes one value"
      [ -n "$1" ] || die "empty argument"
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
  [ -n "$REMOTE_HOME" ] || die "$ENDPOINT reported an empty $HOME — pass --dir explicitly"
else
  REMOTE_HOME='<remote-home>'
fi
[ -n "$REMOTE_DIR" ] || REMOTE_DIR="$REMOTE_HOME/lindela-lite"
# The explicit --dir was validated at parse time. The derived default is
# validated here — but not in dry-run, where the value is a placeholder
# (<remote-home>) because no connection is made to learn the host's HOME.
if [ "$DRY_RUN" = 0 ]; then
  validate_remote_dir "$REMOTE_DIR"
fi
readonly REMOTE_DIR

remote_compose() {
  # The full command, not just the subcommand: this text is interpolated into
  # the shell line that starts the stack. An earlier draft echoed `compose`
  # here, which is not a command on any host — the stack then failed at
  # start-up instead of at preflight.
  remote "cd '$REMOTE_DIR' && if docker compose version >/dev/null 2>&1; then echo 'docker compose'; else echo docker-compose; fi"
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
    if [ "$DRY_RUN" = 1 ]; then
      info "dry-run: the host's state is unknown, so auto assumes git — pass --transport rsync (or tar by disabling rsync locally) to read that flow instead"
    fi
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
    # erase the target's database is not a deploy. The secret exclude is `.env`
    # exactly — `.env.*` would also have excluded `.env.example`, which the
    # first deploy on the host needs to build its .env from, and the secrets
    # step refuses to run without it.
    run rsync -az \
      --exclude '.git/' --exclude 'node_modules/' --exclude 'data/' \
      --exclude '.env' --exclude '.env.qa' \
      --exclude 'artifacts/' --exclude '*.log' \
      -e "$RSH" \
      "$REPO_ROOT/" "$ENDPOINT:$REMOTE_DIR/"
    info "working tree copied to $REMOTE_DIR" ;;
  tar)
    run ssh "${SSH_OPTS[@]}" "$ENDPOINT" "mkdir -p '$REMOTE_DIR'"
    run bash -c \
      "tar -czf - -C '$REPO_ROOT' --exclude=.git --exclude=node_modules --exclude=data --exclude=.env --exclude=.env.qa --exclude=artifacts --exclude='*.log' . | $RSH '$ENDPOINT' 'tar -xzf - -C $REMOTE_DIR'"
    info "working tree streamed to $REMOTE_DIR" ;;
  git)
    [ -d "$REPO_ROOT/.git" ] || die "--transport git needs this checkout to be a git repository; use --transport rsync"
    if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$REMOTE_REF^{commit}" >/dev/null 2>&1; then
      die "--transport git: ref '$REMOTE_REF' does not resolve in this checkout"
    fi
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]; then
      warn "this checkout has uncommitted changes; git transports commit $REMOTE_REF only"
      warn "to ship the working tree as it stands, rerun with --transport rsync"
    fi
    # An earlier draft did `git push "$REMOTE_REF" HEAD:"$REMOTE_REF"` — which
    # asks git to push to a *remote named* after the branch and never worked.
    # A non-bare checkout also refuses a push to its checked-out branch, so the
    # commit goes to a dedicated deploy branch and the host checks it out
    # detached: never refused, and it never moves a branch an operator may be
    # standing on.
    case "$REMOTE_DIR" in
      /*) git_push_path="/$REMOTE_DIR" ;;  # ssh://user@host//absolute/path
      *)  git_push_path="$REMOTE_DIR" ;;  # ssh://user@host/home-relative/path
    esac
    GIT_PUSH_URL="ssh://$ENDPOINT$git_push_path"
    if [ "$DRY_RUN" = 0 ]; then
      # A previous rsync deploy leaves modified tracked files on the host; the
      # push would succeed and the checkout would then refuse. Say so first.
      dirty="$(remote "cd '$REMOTE_DIR' && git status --porcelain --untracked-files=no")"
      if [ -n "$dirty" ]; then
        die "the host checkout at $REMOTE_DIR has modified tracked files. Use --transport rsync to overwrite the working tree, or clean the host."
      fi
      # Contacts the host: proves this checkout can push there before the rest
      # of a long deploy says no. BatchMode keeps a missing key from hanging.
      if ! env GIT_SSH_COMMAND="$RSH" git -C "$REPO_ROOT" push -f --dry-run \
           "$GIT_PUSH_URL" "$REMOTE_REF:refs/heads/lindela-deploy" >/dev/null 2>&1; then
        die "cannot push to $GIT_PUSH_URL — no key this checkout trusts, or an unwritable checkout. Use --transport rsync."
      fi
    fi
    run env GIT_SSH_COMMAND="$RSH" git -C "$REPO_ROOT" push -f --quiet \
      "$GIT_PUSH_URL" "$REMOTE_REF:refs/heads/lindela-deploy"
    info "pushed $REMOTE_REF to $GIT_PUSH_URL (refs/heads/lindela-deploy)"
    run ssh "${SSH_OPTS[@]}" "$ENDPOINT" "cd '$REMOTE_DIR' && git checkout -q --detach refs/heads/lindela-deploy"
    if [ "$DRY_RUN" = 0 ]; then
      # The push is a claim; the host rev-parse is the evidence. If they
      # disagree, the checkout failed and the deploy must not continue on the
      # strength of a port-scan or a log tail.
      local_rev="$(git -C "$REPO_ROOT" rev-parse --verify "$REMOTE_REF^{commit}")"
      host_rev="$(remote "git -C '$REMOTE_DIR' rev-parse HEAD")"
      if [ "$host_rev" != "$local_rev" ]; then
        die "host checked out ${host_rev:-nothing}, pushed $local_rev — the checkout failed; a dirty working tree is the usual cause"
      fi
      info "host verified at $(printf '%.12s' "$local_rev")"
    fi ;;
esac

# ---------------------------------------------------------------- secrets

step "Preparing configuration on the host"

if [ "$DRY_RUN" = 0 ]; then
  if remote "test -f '$REMOTE_DIR/.env'"; then
    info "existing .env kept — the API key on this host is unchanged"
    if [ "$REMOTE_PORT_EXPLICIT" = 1 ]; then
      # An explicit --port is an instruction, not a fallback; apply it to the
      # kept .env so the stack that starts right after listens there.
      remote "cd '$REMOTE_DIR' && tmp=.env.port.\$\$ && sed -e \"s|^LINDELA_LITE_PORT=.*|LINDELA_LITE_PORT=$REMOTE_PORT|\" .env > \"\$tmp\" && mv \"\$tmp\" .env && chmod 600 .env" \
        || die "could not rewrite the port in $REMOTE_DIR/.env on $ENDPOINT"
      info "published port updated in the host's .env"
    fi
  else
    # Secrets are made on the host and never leave it. Generation prefers
    # openssl, falls back to od, and is verified before use — in both
    # directions. A shadowing `od` on PATH (it happened, to the installer's
    # writer, on a normal developer machine) would otherwise have written
    # garbage onto that line, and an EMPTY generation would have written
    # LINDELA_LITE_API_KEY= — an empty value the server treats as
    # "authentication off" — publishing the platform unauthenticated by
    # accident, which is exactly the failure class this script refuses to
    # produce.
    remote "cd '$REMOTE_DIR' && \
      api=\$(openssl rand -hex 24 2>/dev/null || od -An -tx1 -N24 /dev/urandom | tr -d ' \n') && \
      pw=\$(openssl rand -hex 24 2>/dev/null || od -An -tx1 -N24 /dev/urandom | tr -d ' \n') && \
      printf '%s' \"\$api\" | grep -Eq '^[0-9a-f]{48}\$' && \
      printf '%s' \"\$pw\" | grep -Eq '^[0-9a-f]{48}\$' && \
      cp .env.example .env && \
      tmp=.env.gen.\$\$ && \
      sed \
        -e \"s|^LINDELA_LITE_API_KEY=.*|LINDELA_LITE_API_KEY=\$api|\" \
        -e \"s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=\$pw|\" \
        -e \"s|^LINDELA_LITE_DATABASE_URL=.*|LINDELA_LITE_DATABASE_URL=postgresql://lindela:\$pw@db:5432/lindela_lite|\" \
        -e \"s|^LINDELA_LITE_PORT=.*|LINDELA_LITE_PORT=$REMOTE_PORT|\" \
        .env > \"\$tmp\" && mv \"\$tmp\" .env && chmod 600 .env" \
      || die "could not generate secrets on $ENDPOINT — no openssl, no od, or an od that does not behave"
    info "generated fresh secrets on the host"
  fi
fi

# ------------------------------------------------------------------ deploy

step "Building and starting the stack"
compose_cmd="docker compose"
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
    remote "cd '$REMOTE_DIR' && $compose_cmd logs --tail 40 app" >&2 || true
    die "deploy failed verification — nothing above is a guess, the host is the source"
  }
  info "healthy"

  if [ "$INIT_SCHEDULES" = 1 ]; then
    key="$(remote "grep '^LINDELA_LITE_API_KEY=' '$REMOTE_DIR/.env' | cut -d= -f2-")"
    # The key came from an .env an operator may have rotated by hand. A key
    # whose characters cannot travel inside a single-quoted shell request is
    # skipped, loudly, rather than sent mangled and silently failed.
    case "$key" in
      ''|*[!A-Za-z0-9._-]*)
        warn "cannot create default ingestion schedules: the host's API key has characters this script will not interpolate — create them by hand over SSH"
        ;;
      *)
        if remote "curl -fsS -X POST 'http://127.0.0.1:$REMOTE_PORT/api/v1/ingest/schedules/defaults' -H 'x-api-key: $key' >/dev/null 2>&1"; then
          info "default ingestion schedules created"
        else
          warn "could not create default ingestion schedules — the stack is up, this is not fatal"
        fi
        ;;
    esac
  fi
fi

# ------------------------------------------------------------------ report

version="unknown"
pipeline_healthy="unknown"
DRY_LABEL=""
if [ "$DRY_RUN" = 0 ]; then
  health_json="$(remote "curl -fsS 'http://127.0.0.1:$REMOTE_PORT/api/v1/health' 2>/dev/null || echo '{}'")"
  pipeline_healthy="$(printf '%s' "$health_json" | sed -n 's/.*"healthy":\(true\|false\).*/\1/p' | head -1)"
  version="$(printf '%s' "$health_json" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"
else
  DRY_LABEL=" (dry-run — nothing was changed)"
fi

printf '\n'
step "Deployed $ENDPOINT$DRY_LABEL"
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
    ssh $ENDPOINT 'cd $REMOTE_DIR && $compose_cmd logs -f app'
    ssh $ENDPOINT 'cd $REMOTE_DIR && $compose_cmd ps'
    ssh $ENDPOINT 'cd $REMOTE_DIR && $compose_cmd down'
    ssh $ENDPOINT 'cd $REMOTE_DIR && $compose_cmd up -d --build'   # redeploy

EOF
