# Lindela Lite Configuration Reference

This guide lists environment variables and configuration patterns for Lindela Lite.

## Core Server

| Variable | Default | Description |
| --- | --- | --- |
| `LINDELA_LITE_PORT` | `4177` | HTTP port used by the Node server. |
| `LINDELA_LITE_API_KEY` | unset | Optional API key required as `x-api-key` for non-GET API requests. |
| `LINDELA_LITE_MAX_BODY_BYTES` | `5242880` (5 MB) | Maximum accepted request body size. Larger bodies return HTTP 413. |
| `NODE_ENV` | unset | Runtime environment flag. Docker sets `production`. |

When `LINDELA_LITE_API_KEY` is set:

- Mutating API calls require `x-api-key`.
- Dashboard mutating actions require the key in the dashboard API-key field.
- RapidPro inbound field-report webhooks can authenticate with `RAPIDPRO_WEBHOOK_SECRET`.

Request bodies are capped at `LINDELA_LITE_MAX_BODY_BYTES` (default 5 MB).
`Content-Length` is checked first to reject oversized uploads before they are
buffered, then the streamed body is measured again so a missing or dishonest
`Content-Length` cannot bypass the limit. Malformed JSON returns HTTP 400.

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
| `NASA_FIRMS_MAP_KEY` | _(unset)_ | NASA FIRMS MAP_KEY. **Required** — FIRMS has no keyless access; the free key arrives by email from `firms.modaps.eosdis.nasa.gov/api/map_key`. When unset, the source reports an error and zero records rather than silently failing. |

Most source options are passed in ingestion requests or schedules:

- `regions`
- `timeout_ms`
- `retries`
- `interval_minutes`
- `stale_after_minutes`
- Source-specific feed URLs or CSV/GeoJSON payloads.

## Offline Tile Packs

| Variable | Default | Description |
| --- | --- | --- |
| `LINDELA_LITE_PACK_TILE_URL` | _(unset)_ | Tile URL template containing `{z}`, `{x}` and `{y}`, used as the source for offline PMTiles packs (`GET /api/v1/tile-packs`, ENH-42). Must point at a tile server that permits building archives from its tiles. |

Unset is the shipped default, and it is not a placeholder: **the public OSM and
CARTO tile servers prohibit this use by name.** The OSM Tile Usage Policy §4 is
headed *"Prohibited: bulk downloading ("scraping") and offline use"* and lists
*"Building tile archives (e.g. `.zip`, `.mbtiles`) for later distribution"*; the
CARTO Basemap Terms §9.c prohibit *"downloading or extracting map content in
bulk"*. Both are archived verbatim under
[`research/tile-packs/sources/`](./research/tile-packs/sources/INDEX.md). The
basemap proxy's upstreams are therefore **not** usable as a pack source, even
though the proxy itself is a correct use of both services.

A pack request with the variable unset is a `503` naming it, rather than a
fallback to a server whose terms forbid the request. OSM's policy names the
remedy in the same paragraph — *"use self-hosted tiles or a provider that
explicitly allows offline/prefetching"* — and that remedy is this variable.

The variable is operator configuration, so a caller never supplies a URL: it
supplies a bbox and a zoom range, and the coordinates are range-checked against
`2^z` before being substituted as text. The template is validated as a connector
URL, so an instance-metadata host is refused while an operator's own LAN tile
server (`http://192.168.x.x:8080/tiles/{z}/{x}/{y}.png`) is the expected case.

`GET /api/v1/tile-packs/plan` works with the variable unset — sizing a pack is
arithmetic, and an operator sizes one before standing a tile server up.

## Privacy

| Variable | Default | Description |
| --- | --- | --- |
| `LINDELA_LITE_PII_SALT` | generated at boot, ephemeral | Salt for pseudonymised names and phone numbers. |

PII redaction is **on by default** (`redactNames: true`) and can only be switched
off by a deliberate `"redactNames": false` in `data/pii-policy.json` or in
`LINDELA_LITE_PII_POLICY` — or, for a single submission, by an explicit
`anonymous: true` on the request. There is no path where an omitted flag means
"leave the reporter's name in the record".

Set the salt in any deployment that will hold field reports across a restart. The
same input must produce the same pseudonym on every process — the HTTP path and the
RapidPro webhook path both hash against it, and if they disagree, linking a field
report to the dispatch that answered it stops working. A generated salt is still a
salt: an unset variable never means *no salt*, because unsalted digests are
trivially reversible by dictionary attack over a population of district health
workers.

The cost of leaving it unset is not leakage; it is that pseudonyms do not survive a
restart, so yesterday's redacted reporter and today's are two unrelated people. The
process warns on stderr when it generates one.

```bash
openssl rand -hex 32   # → LINDELA_LITE_PII_SALT
```

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
| `RAPIDPRO_DISPATCH_ATTEMPTS` | `3` | Tries per alert dispatch. Below 1 is a configuration error and falls back to 3 — a typo must not restore "notify once and say nothing". A 4xx is never retried: the gateway has rejected the request. |
| `RAPIDPRO_DISPATCH_RETRY_BASE_MS` | `2000` | First backoff; doubles per attempt, capped at 30s. |
| `RAPIDPRO_DISPATCH_GRACE_MINUTES` | `15` | How long a chain may sit in a dispatched state with no accepted dispatch before the reconciliation calls it a delivery failure. A grace period, not a retry budget. |
| `RAPIDPRO_ACK_SLA_MINUTES` | by severity | Acknowledgement deadline, which is also when an unanswered page escalates. |
| `RAPIDPRO_ESCALATION_URNS` | unset | Where escalations go. Empty is reported as `escalation_target_unresolved`, never as "paged". |

## Docker Compose

The one-click stack uses:

| Variable | Description |
| --- | --- |
| `POSTGRES_DB` | PostgreSQL database name. |
| `POSTGRES_USER` | PostgreSQL user. |
| `POSTGRES_PASSWORD` | PostgreSQL password. |
| `LINDELA_LITE_SCHEDULER_INTERVAL_SECONDS` | How often the in-process periodic driver ticks. Also the staleness threshold `/api/v1/health` uses to return 503. |
| `LINDELA_LITE_PUBLIC_PATHS` | Comma-separated paths served without a token. Defaults to `/api/v1/health` and `/api/v1/ready`. Add `/stac` or `/ogc` to publish the spatial catalogues openly. |
| `LINDELA_LITE_CORS_ORIGINS` | Comma-separated origins allowed to read the API from a browser. Unset by default, which grants nothing: the API serves partner-scoped rows, so a wildcard is a decision an operator makes by naming `*` rather than one the server makes for them. |
| `LINDELA_LITE_TRUST_PROXY` | `1` when a reverse proxy in front of this process sets `x-forwarded-for`. The rate limiter then keys on the last hop — the one the proxy observed — instead of the socket address. Leave unset otherwise: an untrusted header is a client choosing its own budget. |
| `LINDELA_LITE_PII_POLICY` | JSON privacy policy. `retentionDays` (365) and `communityFeedbackDays` (180) are the retention windows; see [api.md](api.md#post-apiv1maintenanceapply-retention). |

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
# Only if this deployment builds offline tile packs, and only pointing at a tile
# server that permits it. See "Offline Tile Packs" above.
LINDELA_LITE_PACK_TILE_URL=
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

