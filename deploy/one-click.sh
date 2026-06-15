#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  fi
}

COMPOSE="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    echo "Docker Compose is required. Install Docker Desktop or docker compose, then rerun this script." >&2
    exit 1
  fi
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running or is not accessible. Start Docker, then rerun this script." >&2
  exit 1
fi

ENV_FILE="$ROOT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  API_KEY="$(random_secret)"
  DB_PASSWORD="$(random_secret)"
  sed \
    -e "s/^LINDELA_LITE_API_KEY=.*/LINDELA_LITE_API_KEY=$API_KEY/" \
    -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$DB_PASSWORD/" \
    -e "s#^LINDELA_LITE_DATABASE_URL=.*#LINDELA_LITE_DATABASE_URL=postgresql://lindela:$DB_PASSWORD@db:5432/lindela_lite#" \
    .env.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created .env with generated local secrets."
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

PORT="${LINDELA_LITE_PORT:-4177}"
BASE_URL="http://127.0.0.1:${PORT}"

$COMPOSE up -d --build

echo "Waiting for Lindela Lite at ${BASE_URL} ..."
for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsS "${BASE_URL}/api/v1/health" >/dev/null
curl -fsS -X POST "${BASE_URL}/api/v1/ingest/schedules/defaults" -H "x-api-key: ${LINDELA_LITE_API_KEY}" >/dev/null || true

cat <<EOF

Lindela Lite is deployed.

Dashboard: ${BASE_URL}
Health:    ${BASE_URL}/api/v1/health
Docs:      ${BASE_URL}/docs/platform.md

Useful commands:
  $COMPOSE ps
  $COMPOSE logs -f app
  $COMPOSE logs -f scheduler
  $COMPOSE down

EOF
