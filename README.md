# Lindela Lite

Lindela Lite is a standalone, open-source climate-conflict and flood-impact toolkit. It ingests selected public data sources, normalizes them into simple schemas, computes transparent baseline risk scores, exposes formatted data through an API, and provides a lightweight dashboard.

This package is intentionally separate from the full Lindela platform. It does not include Lindela's proprietary fusion, source reliability, calibrated prediction, report management, wargaming, classified workflow, or enterprise orchestration systems.

## What It Does

- Ingests public climate, disaster, flood, fire, and service-asset data.
- Schedules regular public-source ingestion runs and exposes source health/staleness.
- Supports optional conflict-event imports through user-supplied ACLED-compatible CSV or the Lite conflict schema.
- Computes baseline flood risk, climate-conflict risk, and service-delivery impact scores.
- Tracks operational incidents, interventions, tasks, field reports, resources, and action logs.
- Evaluates lightweight alert rules into auditable alert events for downstream notifications or tickets.
- Integrates with RapidPro for SMS alert dispatch and inbound field-report webhooks.
- Creates, displays, exports, distributes, and schedules operational reports.
- Publishes source data-quality and confidence signals for decision support.
- Serves formatted JSON, GeoJSON, and CSV through `/api/v1/*` endpoints.
- Provides a local dashboard at `/`.

## What It Does Not Do

- It does not ingest GDELT.
- It does not copy or depend on WorldMonitor code.
- It does not include Lindela's commercial models, calibrated coefficients, intelligence fusion, report distribution, AAR, or wargaming systems.

## Run

```bash
npm test
npm start
```

The server listens on `LINDELA_LITE_PORT` or `4177`.

```bash
curl http://127.0.0.1:4177/api/v1/health
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{"sources":["open_meteo","gdacs"],"regions":[{"name":"Turkana","lat":3.1,"lon":35.6,"country":"KE"}]}'
```

Create default public-source schedules and run sources that are due:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/schedules/defaults
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run-due
curl http://127.0.0.1:4177/api/v1/ingest/status
```

## One-Click Deployment

For the default production-like deployment, run:

```bash
./deploy/one-click.sh
```

This creates `.env` with local secrets, builds the Docker image, starts PostgreSQL, starts the app, starts a scheduler sidecar, waits for health, and initializes default public-source ingestion schedules.

See [docs/deployment.md](docs/deployment.md).

## Storage

Lindela Lite supports four storage modes:

- `auto` defaults to external Postgres when `LINDELA_LITE_DATABASE_URL` or `DATABASE_URL` is set, then tries local `pg0`, then falls back to JSON.
- `pg0` starts a local pg0 PostgreSQL instance and stores records in Postgres.
- `postgres` uses an external PostgreSQL database URL.
- `json` uses the original local JSON file store.

```bash
LINDELA_LITE_DB_MODE=pg0 npm start
LINDELA_LITE_DB_MODE=postgres LINDELA_LITE_DATABASE_URL=postgresql://user:pass@host:5432/db npm start
LINDELA_LITE_DB_MODE=json npm start
```

See [docs/storage.md](docs/storage.md).

## Sources

Built-in source ids:

- `open_meteo`
- `gdacs`
- `glofas`
- `chirps`
- `nasa_firms`
- `service_assets`
- `acled_csv`
- `conflict_csv`

## Operations

Lite includes a portable intervention-management layer for public-good response coordination:

- Create incidents from operator input or linked event/risk context.
- Track interventions, tasks, field reports, and response resources.
- Review action logs and operations summaries through the API and dashboard.
- Keep high-impact actions human-reviewed; Lite remains decision support, not an automated command system.

## RapidPro SMS

Set RapidPro environment variables to send alert events through RapidPro and receive field reports from RapidPro flows:

```bash
RAPIDPRO_BASE_URL=https://rapidpro.io
RAPIDPRO_API_TOKEN=your-token
RAPIDPRO_ALERT_FLOW_UUID=your-alert-flow-uuid
RAPIDPRO_WEBHOOK_SECRET=shared-inbound-secret
npm start
```

- `POST /api/v1/rapidpro/alert-events/:id/send` sends an alert event to RapidPro.
- `POST /api/v1/rapidpro/field-report` receives RapidPro webhook payloads and creates field reports.
- `GET /api/v1/rapidpro/status`, `/dispatches`, and `/inbound` expose integration state and audit logs.

See [docs/rapidpro.md](docs/rapidpro.md).

## Reporting

Lite includes dependency-light reporting for operational products:

- Create reusable templates for SITREPs, incident briefs, intervention updates, data-quality reports, and alert digests.
- Generate deterministic report sections with source references and data-quality warnings.
- Preview reports in the dashboard and export Markdown or JSON.
- Record local, webhook, and RapidPro SMS-summary distribution runs.
- Schedule templates with explicit `run-due` execution for cron, systemd timers, GitHub Actions, or another deployment scheduler.

See [docs/reporting-prd.md](docs/reporting-prd.md) for the full product requirements and implementation shape.

The registry rejects `gdelt` to keep this package aligned with the open-source boundary.

## API

Start with the [platform guide](docs/platform.md). The docs directory also includes focused guides for [architecture](docs/architecture.md), [data model](docs/data-model.md), [ingestion](docs/ingestion.md), [dashboard usage](docs/dashboard.md), [configuration](docs/configuration.md), [operations runbooks](docs/runbook.md), [developer workflows](docs/developer-guide.md), [API reference](docs/api.md), [OpenAPI](docs/openapi.yaml), and [service assets](docs/service-assets.md).

## Open-Source Boundary

See [docs/open-source-boundary.md](docs/open-source-boundary.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Trigger Protocol Examples

Example downstream trigger configurations are in [examples/trigger-protocols](examples/trigger-protocols).

## Security And Releases

See [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).
