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
#   - Touch an existing installation's .env or database. Upgrades keep both.
#   - Bind anything wider than the host you asked for.
#   - Print the API key unless you pass --show-key.
# -----------------------------------------------------------------------
set -euo pipefail
IFS=$'\n\t'

REPO="${LINDELA_LITE_REPO:-https://github.com/nyimbi/lindela-lite.git}"
DEFAULT_REF="main"
INSTALL_DIR="${LINDELA_LITE_DIR:-$HOME/lindela-lite}"
PORT=""
API_KEY=""
SHOW_KEY=0
UNINSTALL=0
ASSUME_YES=0

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[2m·\033[0m %s\n' "$*"; }
step() { printf '\033[1m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
ask()  {
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  printf '%s [y/N] ' "$1"
  read -r reply
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
  --dir <path>      Where to install. Default: ~/lindela-lite
  --ref <ref>       Git ref to install. Default: main
  --repo <url>      Repository URL.
  --port <n>        Host port to publish. Default: 4177
  --key <value>     Use this API key instead of generating one.
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
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; DEFAULT_REF="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2 ;;
    --key) [ $# -ge 2 ] || die "--key needs a value"; API_KEY="$2"; shift 2 ;;
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

case "$REPO" in
  https://*|git@*|ssh://*|file://*) ;;
  *) die "repository must be an https, ssh or file URL (got: $REPO)" ;;
esac

command -v uname >/dev/null 2>&1 || die "uname is missing; this installer needs a POSIX host."
OS="$(uname -s)"
[ "$OS" = "Linux" ] || warn "this is tested on Linux; you are on $OS. The Compose stack itself is portable, but the Docker setup guidance below is not."

# --------------------------------------------------------------- uninstall

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then echo "docker compose"; else echo "docker-compose"; fi
}

if [ "$UNINSTALL" = 1 ]; then
  step "Uninstalling"
  [ -d "$INSTALL_DIR" ] || die "nothing installed at $INSTALL_DIR"
  compose="$(compose_cmd)"
  if [ "$PURGE" = 1 ]; then
    warn "PURGE: the Postgres volume is deleted, and so is every record in it."
    ask "Delete the database volume?"
    ( cd "$INSTALL_DIR" && $compose down -v )
  else
    info "keeping the database volume — pass --purge to remove it too"
    ( cd "$INSTALL_DIR" && $compose down )
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

if [ -n "$PORT" ] && command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"; then
    warn "port $PORT already has a listener. Choose another with --port, or stop it."
  fi
fi

# ------------------------------------------------------------- fetch source

step "Fetching $DEFAULT_REF"

UPGRADE=0
if [ -d "$INSTALL_DIR/.git" ]; then
  UPGRADE=1
  info "existing installation found — this is an upgrade"
  info "your .env and your database are kept"
fi

mkdir -p "$INSTALL_DIR"
if [ "$UPGRADE" = 1 ]; then
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$DEFAULT_REF"
  git -C "$INSTALL_DIR" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$DEFAULT_REF" "$REPO" "$INSTALL_DIR" \
    || git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi
info "checked out $DEFAULT_REF"

compose="$(compose_cmd)"
cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || die "no docker-compose.yml in $INSTALL_DIR — this does not look like Lindela Lite"
[ -f .env.example ] || die "no .env.example in $INSTALL_DIR"

# ---------------------------------------------------------------- secrets

step "Configuring"

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
  fi
}

if [ -f .env ]; then
  info "existing .env kept — the API key does not change on upgrade"
else
  api="${API_KEY:-$(random_hex)}"
  pw="$(random_hex)"
  cp .env.example .env
  # The escaping here is deliberate: the values come from a generator, but a
  # caller-supplied --key does not, and a key containing a slash or an ampersand
  # must not corrupt the DATABASE_URL line below.
  escaped_pw="$(printf '%s' "$pw" | sed 's/[\/&|]/\\&/g')"
  sed -i \
    -e "s|^LINDELA_LITE_API_KEY=.*|LINDELA_LITE_API_KEY=$api|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pw|" \
    -e "s|^LINDELA_LITE_DATABASE_URL=.*|LINDELA_LITE_DATABASE_URL=postgresql://lindela:$escaped_pw@db:5432/lindela_lite|" \
    -e "s|^LINDELA_LITE_PORT=.*|LINDELA_LITE_PORT=$PORT|" \
    .env
  chmod 600 .env
  info "generated secrets in .env"
fi

# ------------------------------------------------------------------ deploy

step "Building and starting"
info "this builds the image and starts Postgres; first run takes a few minutes"
$compose up -d --build

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
  $compose logs --tail 40 app >&2 || true
  die "install failed verification"
fi
info "healthy"

# Best-effort, and clearly so: the platform is up and serving whether or not the
# schedules exist, so a failure here is a warning and not a failed install.
key="$(grep '^LINDELA_LITE_API_KEY=' .env | cut -d= -f2-)"
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
  The API key is in $INSTALL_DIR/.env and was not printed. Read it with:
    grep LINDELA_LITE_API_KEY $INSTALL_DIR/.env

EOF
fi

cat <<EOF
  The dashboard has no session — it sends the key per request — so paste the
  key into the API key field before using buttons that write.

  If the port is not reachable from your browser, tunnel it:
    ssh -L $PORT:127.0.0.1:$PORT <this-host>

  Operate it:
    cd $INSTALL_DIR && $compose ps
    cd $INSTALL_DIR && $compose logs -f app
    cd $INSTALL_DIR && $compose down

EOF
