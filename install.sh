#!/usr/bin/env bash
#
# Lindela Lite installer. Runs on the machine being installed, not on yours.
#
#   curl -fsSL https://raw.githubusercontent.com/nyimbi/lindela-lite/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/nyimbi/lindela-lite/main/install.sh | bash -s -- --port 8080
#
# Requires Docker with Compose. It will not install Docker for you: an installer
# that silently modifies the host's package manager is a much larger thing to
# trust than one that reads the host and tells you what is missing. If Docker is
# absent it says so, points at the install instructions, and stops.
#
# -----------------------------------------------------------------------
# Read this before piping an untrusted script into a shell.
#
#   curl … | bash runs whatever the server returns, as root-equivalent, with no
#   review step and no way to see what you are about to execute. That is a
#   property of the pattern, not of this script. Two ways to reduce it:
#
#     1. Read it first.   curl -fsSL <url> -o install.sh && less install.sh && bash install.sh
#     2. Pin a commit.    …/main/install.sh pins nothing — `main` moves. Use a
#                         tag or a SHA for anything you care about.
#
#   This script therefore prints a checksum of itself and its source URL before
#   doing anything, so the run you are looking at later can be tied to the exact
#   bytes that ran. It cannot make the download trustworthy; it can only make the
#   thing you ran identifiable afterwards.
#
# What it will not do:
#   - Touch an existing installation's .env or database. Upgrades keep both;
#     LINDELA_LITE_PORT is rewritten only when you pass --port.
#   - Bind anything wider than the host you asked for.
#   - Print the API key unless you pass --show-key.
#   - Install a ref it cannot resolve. A failed tag checkout must not fall back
#     to `main` — that would silently install something other than what was
#     pinned, and pinning is the whole point of the flag.
# -----------------------------------------------------------------------
set -euo pipefail
IFS=$'\n\t'

REPO="${LINDELA_LITE_REPO:-https://github.com/nyimbi/lindela-lite.git}"
DEFAULT_REF="main"
INSTALL_DIR="${LINDELA_LITE_DIR:-$HOME/lindela-lite}"
ENV_FILE=""
PORT=""
PORT_EXPLICIT=0
API_KEY=""
SHOW_KEY=0
UNINSTALL=0
ASSUME_YES=0

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[2m·\033[0m %s\n' "$*"; }
step() { printf '\033[1m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

# Two words today ("docker compose"), one binary on older hosts
# ("docker-compose"). It must be called as a function, not echoed and expanded
# unquoted: this script runs with IFS=$'\n\t', so an unquoted `docker compose`
# variable would arrive at the shell as one word — `command not found`.
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}
compose_label() {
  if docker compose version >/dev/null 2>&1; then printf 'docker compose'; else printf 'docker-compose'; fi
}

ask()  {
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ -t 0 ]; then
    printf '%s [y/N] ' "$1"
    IFS= read -r reply || die "could not read a reply — rerun with --yes if you mean it"
  else
    # The answer has to come from the terminal: stdin may be the script's own
    # pipe (`curl … | bash`), and a `read` from it would eat the next lines of
    # the script and treat them as the reply. On hosts with no controlling
    # terminal at all (CI, non-interactive shells) the open fails silently and
    # the install stops instead of guessing.
    if ! { printf '%s [y/N] ' "$1" > /dev/tty; } 2>/dev/null; then
      die "no terminal to confirm on — rerun with --yes if you mean it"
    fi
    IFS= read -r reply < /dev/tty
  fi
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) die "declined — nothing was changed" ;;
  esac
}

usage() {
  cat <<'EOF'
Lindela Lite installer

Usage:
  install.sh [options]

Options:
  --dir <path>      Where to install. Default: ~/lindela-lite. Refused for the
                    filesystem's load-bearing directories and for anything
                    containing '..'.
  --ref <ref>       Git ref to install. Default: main. Branches and tags work;
                    a raw SHA is refused (GitHub will not serve it to a
                    shallow clone) — use a tag.
  --repo <url>      Repository URL.
  --port <n>        Host port to publish. Default: 4177
  --key <value>     Use this API key instead of generating one. Single line;
                    any printable characters.
  --show-key        Print the generated API key at the end.
  --yes             Do not prompt.
  --uninstall       Remove the stack and this directory. The database volume
                    is left alone unless --purge.
  --purge           With --uninstall, also delete the Postgres volume. This
                    destroys the deployment's data.
  -h, --help        This message.

Environment:
  LINDELA_LITE_REPO, LINDELA_LITE_DIR  Override the repository and directory.
EOF
}

# ------------------------------------------- provenance, printed up front

FINGERPRINT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -r "${BASH_SOURCE[0]}" ]; then
  if command -v shasum >/dev/null 2>&1; then
    FINGERPRINT="$(shasum -a 256 "${BASH_SOURCE[0]}" 2>/dev/null | cut -d' ' -f1)"
  elif command -v sha256sum >/dev/null 2>&1; then
    FINGERPRINT="$(sha256sum "${BASH_SOURCE[0]}" 2>/dev/null | cut -d' ' -f1)"
  fi
fi

printf '\n\033[1mLindela Lite installer\033[0m\n'
if [ -n "$FINGERPRINT" ]; then
  info "script sha256 $FINGERPRINT"
else
  warn "could not fingerprint this script (piped from stdin)"
fi
info "will install $REPO@$DEFAULT_REF into $INSTALL_DIR"
printf '\n'

# ---------------------------------------------------------------- arguments

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; [ -n "$2" ] || die "--dir needs a non-empty value"; INSTALL_DIR="$2"; shift 2 ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; [ -n "$2" ] || die "--ref needs a non-empty value"; DEFAULT_REF="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; [ -n "$2" ] || die "--repo needs a non-empty value"; REPO="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; [ -n "$2" ] || die "--port needs a non-empty value"; PORT="$2"; PORT_EXPLICIT=1; shift 2 ;;
    --key) [ $# -ge 2 ] || die "--key needs a value"; [ -n "$2" ] || die "--key needs a non-empty value"; API_KEY="$2"; shift 2 ;;
    --show-key) SHOW_KEY=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) UNINSTALL=1; PURGE=1; shift ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) die "unexpected argument: $1 (try --help)" ;;
  esac
done
PURGE="${PURGE:-0}"

[ -n "$PORT" ] || PORT=4177
case "$PORT" in
  ''|*[!0-9]*) die "port must be numeric (got: $PORT)" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "port out of range: $PORT"

if [ -n "$API_KEY" ]; then
  # sed below is line-based; a key with a newline in it could not round-trip.
  case "$API_KEY" in
    *$'\n'*|*$'\r'*) die "--key must be a single line" ;;
  esac
fi

case "$REPO" in
  https://*|git@*|ssh://*|file://*) ;;
  *) die "repository must be an https, ssh or file URL (got: $REPO)" ;;
esac

# --dir: expand a lone leading tilde (quoted `~/x` is literal), then refuse
# targets whose loss is not recoverable from here. --uninstall ends in
# `rm -rf "$INSTALL_DIR"`, so the guard is not decoration.
case "$INSTALL_DIR" in
  '~') INSTALL_DIR="$HOME" ;;
  '~'/*) INSTALL_DIR="$HOME/${INSTALL_DIR#'~/'}" ;;
  '~'*) die "only a plain leading tilde is expanded; give a real path (got: $INSTALL_DIR)" ;;
esac
# Strip trailing slashes, but never reduce below one character: a lone '/' must
# survive to reach the dangerous-directory refusal, not die as an empty path.
if [ "${#INSTALL_DIR}" -gt 1 ]; then
  INSTALL_DIR="${INSTALL_DIR%/}"
fi
if [ -z "$INSTALL_DIR" ]; then
  die "--dir cannot resolve to an empty path"
fi
case "$INSTALL_DIR" in
  *'..'*) die "--dir must not contain '..' (got: $INSTALL_DIR)" ;;
  '.'|'/'|'/usr'|'/usr/local'|'/opt'|'/etc'|'/var'|'/home'|'/bin'|'/sbin'|'/lib'|'/boot'|'/dev'|'/proc'|'/sys'|'/run'|'/tmp'|'/root')
    die "refusing $INSTALL_DIR as the install directory" ;;
esac
if [ "$INSTALL_DIR" = "$HOME" ]; then
  die "refusing --dir $HOME as the install directory — uninstalling it would remove every file you own"
fi

command -v uname >/dev/null 2>&1 || die "uname is missing; this installer needs a POSIX host."
OS="$(uname -s)"
[ "$OS" = "Linux" ] || warn "this is tested on Linux; you are on $OS. The Compose stack itself is portable, but the Docker setup guidance below is not."

# --------------------------------------------------------------- uninstall

if [ "$UNINSTALL" = 1 ]; then
  step "Uninstalling"
  [ -d "$INSTALL_DIR" ] || die "nothing installed at $INSTALL_DIR"
  command -v docker >/dev/null 2>&1 || die "docker is gone from this host; the stack cannot be stopped here. Remove $INSTALL_DIR yourself."
  if [ "$PURGE" = 1 ]; then
    warn "PURGE: the Postgres volume is deleted, and so is every record in it."
    ask "Delete the database volume?"
    ( cd "$INSTALL_DIR" && compose down -v )
  else
    info "keeping the database volume — pass --purge to remove it too"
    ( cd "$INSTALL_DIR" && compose down )
  fi
  info "removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  step "Done. The database volume, if kept, is still there: docker volume ls | grep lindela"
  exit 0
fi

# --------------------------------------------------------------- preflight

step "Checking prerequisites"

command -v docker >/dev/null 2>&1 || {
  warn "docker is not installed."
  info "Install Docker Engine, then rerun this command:"
  info "  https://docs.docker.com/engine/install/"
  die "docker is required; install it and run this again"
}

if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  die "docker is installed but Compose is not. Install the compose plugin and rerun."
fi

if ! docker info >/dev/null 2>&1; then
  die "docker is installed but not running, or not accessible to $USER. Start it and rerun."
fi
info "docker $(docker --version 2>/dev/null | head -1 | tr -d '\n')"

command -v git >/dev/null 2>&1 || die "git is required to fetch the source."
command -v curl >/dev/null 2>&1 || die "curl is required for the health check after install."
info "git, curl present"

# Linux ships ss; a Mac running Docker Desktop ships lsof.
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    false
  fi
}
if port_busy; then
  warn "port $PORT already has a listener. Choose another with --port, or stop it."
fi

# ------------------------------------------------------------- fetch source

step "Fetching $DEFAULT_REF"

UPGRADE=0
if [ -d "$INSTALL_DIR/.git" ]; then
  UPGRADE=1
  info "existing installation found — this is an upgrade"
  info "your .env and your database are kept"
fi

# Shallow clone of a branch or tag. If the ref cannot be resolved by a shallow
# fetch, stop: falling back to the default branch would install a different
# checkout than the one that was asked for, without ever saying so.
if [ "$UPGRADE" = 1 ]; then
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$DEFAULT_REF" \
    || die "could not fetch '$DEFAULT_REF'. Branches and tags shallow-fetch; raw SHAs do not. Use a tag."
  git -C "$INSTALL_DIR" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$DEFAULT_REF" "$REPO" "$INSTALL_DIR" \
    || die "could not clone '$DEFAULT_REF'. Branches and tags shallow-clone; raw SHAs are refused by GitHub. Use a tag."
fi
info "checked out $DEFAULT_REF"

cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || die "no docker-compose.yml in $INSTALL_DIR — this does not look like Lindela Lite"
[ -f .env.example ] || die "no .env.example in $INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"

# ---------------------------------------------------------------- secrets

step "Configuring"

random_hex() {
  # openssl first, node second, od last and checked. On at least one developer
  # machine `od` on PATH was a shadowing CLI with none of the needed flags, so
  # the last resort is verified against what a secret must look like: 48 hex
  # characters. Fail closed rather than write garbage into the credentials.
  hex=""
  if command -v openssl >/dev/null 2>&1; then
    hex="$(openssl rand -hex 24 2>/dev/null || true)"
  fi
  if [ -z "$hex" ] && command -v node >/dev/null 2>&1; then
    hex="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' 2>/dev/null || true)"
  fi
  if [ -z "$hex" ]; then
    hex="$(od -An -tx1 -N24 /dev/urandom 2>/dev/null | tr -d ' \n' || true)"
  fi
  case "$hex" in
    ''|*[!0-9a-f]*) die "no usable secret generator on this host (openssl, node, od — checked in that order)" ;;
  esac
  [ "${#hex}" = "48" ] || die "the secret generator produced ${#hex} hex characters, expected 48"
  printf '%s' "$hex"
}

# Escape a value for the right side of a `s|…|<this>|` substitution:
# backslashes first, then the metacharacters of the replacement — `&` (which
# expands to the whole match) and the `|` delimiter. The values come from a
# generator usually, but a caller-supplied --key does not, and a key containing
# a slash or an ampersand must not corrupt the neighbouring lines.
sed_escape_replacement() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/[&|]/\\&/g'
}

if [ -f "$ENV_FILE" ]; then
  info "existing .env kept — the secrets do not change on upgrade"
  # An explicit --port on an upgrade changes the published port on purpose.
  # Everything else in .env is the operator's, and stays theirs.
  if [ "$PORT_EXPLICIT" = 1 ]; then
    existing_env_port="$(sed -n 's/^LINDELA_LITE_PORT=//p' "$ENV_FILE" | head -1)"
    if [ "$existing_env_port" != "$PORT" ]; then
      tmp=".env.tmp.$$"
      sed -e "s|^LINDELA_LITE_PORT=.*|LINDELA_LITE_PORT=$PORT|" "$ENV_FILE" > "$tmp" \
        || { rm -f "$tmp"; die "could not rewrite the port in $ENV_FILE"; }
      mv -f "$tmp" "$ENV_FILE"
      info "published port updated in .env: ${existing_env_port:-unset} → $PORT"
    fi
  fi
else
  api="${API_KEY:-$(random_hex)}"
  pw="$(random_hex)"
  api_escaped="$(sed_escape_replacement "$api")"
  pw_escaped="$(sed_escape_replacement "$pw")"
  cp .env.example "$ENV_FILE"
  tmp=".env.tmp.$$"
  sed \
    -e "s|^LINDELA_LITE_API_KEY=.*|LINDELA_LITE_API_KEY=$api_escaped|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pw_escaped|" \
    -e "s|^LINDELA_LITE_DATABASE_URL=.*|LINDELA_LITE_DATABASE_URL=postgresql://lindela:$pw_escaped@db:5432/lindela_lite|" \
    -e "s|^LINDELA_LITE_PORT=.*|LINDELA_LITE_PORT=$PORT|" \
    .env.example > "$tmp" || { rm -f "$tmp"; die "could not rewrite .env.example"; }
  mv -f "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "generated secrets in .env"
fi

# ------------------------------------------------------------------ deploy

step "Building and starting"
info "this builds the image and starts Postgres; first run takes a few minutes"
compose up -d --build

step "Waiting for health"
ok=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 3
done

if [ "$ok" != 1 ]; then
  warn "did not become healthy in time. Last 40 lines of the app log:"
  compose logs --tail 40 app >&2 || true
  die "install failed verification"
fi
info "healthy"

# Best-effort, and clearly so: the platform is up and serving whether or not the
# schedules exist, so a failure here is a warning and not a failed install.
key="$(grep '^LINDELA_LITE_API_KEY=' "$ENV_FILE" | cut -d= -f2-)"
if curl -fsS -X POST "http://127.0.0.1:$PORT/api/v1/ingest/schedules/defaults" \
     -H "x-api-key: $key" >/dev/null 2>&1; then
  info "default ingestion schedules created"
else
  warn "could not create the default ingestion schedules — the platform is up, this is not fatal"
fi

# ----------------------------------------------------------------- report

version="$(curl -fsS "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null \
  | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"
healthy="$(curl -fsS "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null \
  | sed -n 's/.*"healthy":\(true\|false\).*/\1/p' | head -1)"

printf '\n'
step "Lindela Lite is installed"
cat <<EOF
  URL        http://127.0.0.1:$PORT
  Version    ${version:-unknown}
  Pipeline   ${healthy:-unknown}
  Directory  $INSTALL_DIR

EOF

if [ "$SHOW_KEY" = 1 ]; then
  printf '  API key   %s\n\n' "$key"
else
  cat <<EOF
  The API key is in $ENV_FILE and was not printed. Read it with:
    grep LINDELA_LITE_API_KEY $ENV_FILE

EOF
fi

cat <<EOF
  The dashboard has no session — it sends the key per request — so paste the
  key into the API key field before using buttons that write.

  If the port is not reachable from your browser, tunnel it:
    ssh -L $PORT:127.0.0.1:$PORT <this-host>

  Operate it:
    cd $INSTALL_DIR && $(compose_label) ps
    cd $INSTALL_DIR && $(compose_label) logs -f app
    cd $INSTALL_DIR && $(compose_label) down

EOF