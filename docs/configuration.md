# Lindela Lite Configuration Reference

This guide lists environment variables and configuration patterns for Lindela Lite.

## Core Server

| Variable | Default | Description |
| --- | --- | --- |
| `LINDELA_LITE_PORT` | `4177` | HTTP port used by the Node server. |
| `LINDELA_LITE_API_KEY` | unset | Optional API key required as `x-api-key` for non-GET API requests. |
| `NODE_ENV` | unset | Runtime environment flag. Docker sets `production`. |

When `LINDELA_LITE_API_KEY` is set:

- Mutating API calls require `x-api-key`.
- Dashboard mutating actions require the key in the dashboard API-key field.
- RapidPro inbound field-report webhooks can authenticate with `RAPIDPRO_WEBHOOK_SECRET`.

## Storage

| Variable | Default | Description |
| --- | --- | --- |
| `LINDELA_LITE_DB_MODE` | `auto` | `auto`, `json`, `pg0`, or `postgres`. |
| `LINDELA_LITE_STORE` | `data/lindela-lite-store.json` | JSON store path for JSON mode. |
| `LINDELA_LITE_DATABASE_URL` | unset | PostgreSQL URL for `postgres` mode or auto mode. |
| `DATABASE_URL` | unset | Fallback PostgreSQL URL. |

Mode behavior:

- `json`: use local JSON file.
- `postgres`: require `LINDELA_LITE_DATABASE_URL` or `DATABASE_URL`.
- `pg0`: start/use a local pg0 PostgreSQL process.
- `auto`: prefer external PostgreSQL, then pg0 when available, then JSON.

## pg0

| Variable | Default | Description |
| --- | --- | --- |
| `PG0_BIN` | `pg0` | pg0 command name/path. |
| `PG0_NAME` | `lindela-lite` | pg0 instance name. |
| `LINDELA_LITE_PG0_NAME` | unset | Alternate pg0 instance name. |
| `PG0_PORT` | unset | pg0 port. |
| `LINDELA_LITE_PG0_PORT` | unset | Alternate pg0 port. |
| `PG0_DATA_DIR` | unset | pg0 data directory. |
| `LINDELA_LITE_PG0_DATA_DIR` | unset | Alternate pg0 data directory. |
| `PG0_USERNAME` | `postgres` | pg0 user. |
| `PG0_PASSWORD` | `postgres` | pg0 password. |
| `PG0_DATABASE` | `postgres` | pg0 database. |
| `LINDELA_LITE_PG0_TIMEOUT_MS` | `20000` | pg0 startup timeout. |

## Public Sources

| Variable | Default | Description |
| --- | --- | --- |
| `NASA_FIRMS_MAP_KEY` | `OPEN_KEY` | NASA FIRMS map key. |

Most source options are passed in ingestion requests or schedules:

- `regions`
- `timeout_ms`
- `retries`
- `interval_minutes`
- `stale_after_minutes`
- Source-specific feed URLs or CSV/GeoJSON payloads.

## RapidPro

| Variable | Default | Description |
| --- | --- | --- |
| `RAPIDPRO_BASE_URL` | `https://rapidpro.io` | RapidPro host. `/api/v2` is appended when absent. |
| `RAPIDPRO_API_TOKEN` | unset | RapidPro API token. Required for outbound sends. |
| `RAPIDPRO_ALERT_MODE` | `flow_start` if flow UUID is set, otherwise `broadcast` | Outbound mode. |
| `RAPIDPRO_ALERT_FLOW_UUID` | unset | Flow UUID for `flow_start` mode. |
| `RAPIDPRO_ALERT_URNS` | unset | Default comma-separated URNs. |
| `RAPIDPRO_ALERT_CONTACTS` | unset | Default comma-separated contact UUIDs. |
| `RAPIDPRO_ALERT_GROUPS` | unset | Default comma-separated group UUIDs. |
| `RAPIDPRO_BASE_LANGUAGE` | `eng` | Broadcast language code. |
| `RAPIDPRO_WEBHOOK_SECRET` | unset | Shared secret for inbound field-report webhooks. |

## Docker Compose

The one-click stack uses:

| Variable | Description |
| --- | --- |
| `POSTGRES_DB` | PostgreSQL database name. |
| `POSTGRES_USER` | PostgreSQL user. |
| `POSTGRES_PASSWORD` | PostgreSQL password. |
| `LINDELA_LITE_SCHEDULER_INTERVAL_SECONDS` | Sidecar scheduler loop interval. |

The generated `.env` is based on `.env.example`.

## Example Local JSON Configuration

```bash
LINDELA_LITE_DB_MODE=json
LINDELA_LITE_STORE=data/lindela-lite-store.json
LINDELA_LITE_PORT=4177
```

## Example Production-Like Configuration

```bash
LINDELA_LITE_PORT=4177
LINDELA_LITE_API_KEY=replace-with-long-random-secret
LINDELA_LITE_DB_MODE=postgres
LINDELA_LITE_DATABASE_URL=postgresql://lindela:password@db:5432/lindela_lite
RAPIDPRO_BASE_URL=https://rapidpro.io
RAPIDPRO_API_TOKEN=replace-if-used
RAPIDPRO_ALERT_FLOW_UUID=replace-if-used
RAPIDPRO_WEBHOOK_SECRET=replace-if-used
```

## Configuration Checks

Run:

```bash
npm run validate
npm test
docker compose --env-file .env.example config
```

When Docker is available, also build/start the one-click stack:

```bash
./deploy/one-click.sh
```

