# Lindela Lite Platform Guide

This guide describes Lindela Lite as an operating platform: what it does, how the pieces fit together, how to run it, and how teams should use it for climate-conflict, climate-disaster, intervention-management, alerting, RapidPro, and reporting workflows.

For deeper topic guides, see [architecture.md](architecture.md), [data-model.md](data-model.md), [ingestion.md](ingestion.md), [dashboard.md](dashboard.md), [configuration.md](configuration.md), [runbook.md](runbook.md), [developer-guide.md](developer-guide.md), [api.md](api.md), and [openapi.yaml](openapi.yaml).

## Platform Purpose

Lindela Lite is a standalone, open-source decision-support platform for public-good climate-conflict and climate-disaster operations. It ingests public/open-source signals, accepts user-supplied operational data, computes transparent risk and service-impact signals, coordinates interventions, sends and receives RapidPro SMS workflows, and packages operational information into scheduled reports.

The platform is intentionally not the full commercial Lindela system. It avoids proprietary data fusion, classified workflows, calibrated prediction models, full report-management systems, AAR automation, wargaming, enterprise collaboration, and source-reputation internals. The Lite edition favors transparency, portability, and auditability over hidden automation.

## Core Capabilities

### Public Data Ingestion

Lite ingests selected public/open-source data sources:

- `open_meteo`: current and forecast weather observations.
- `gdacs`: disaster alerts and hazard feeds.
- `glofas`: flood forecast RSS signals.
- `chirps`: rainfall dataset availability metadata.
- `nasa_firms`: active fire detections.
- `service_assets`: user-provided service infrastructure.
- `conflict_csv`: user-provided conflict-event CSV.
- `acled_csv`: user-provided ACLED-compatible licensed CSV.

Regular public-source ingestion is schedule-driven. Lite stores ingestion schedules, next-run times, source health, failure streaks, retry/timeout policies, and per-run diagnostics. Deployments call `POST /api/v1/ingest/run-due` from cron, systemd timers, GitHub Actions, or another scheduler.

### Risk And Impact Analytics

Lite computes transparent baseline analytics:

- Flood risk scores from precipitation forecasts and hazard alerts.
- Climate-conflict pressure scores from climate and conflict signals.
- Service-delivery impact assessments for exposed service assets.
- Data-quality summaries for source freshness, geocoding coverage, confidence, errors, and stale inputs.

These outputs are decision-support signals. They are not automated determinations and should not be used as the sole basis for high-impact decisions.

### Operations And Intervention Management

The operations layer turns monitoring into auditable response records:

- `incidents`: situations needing monitoring or response.
- `interventions`: response plans linked to incidents.
- `intervention_tasks`: assigned work under interventions.
- `field_reports`: field updates, needs, and observed impacts.
- `response_resources`: supplies, teams, equipment, or other deployable capacity.
- `action_logs`: immutable create/update/action records.

Operators can create incidents from risk/event context, attach interventions and tasks, record field reports, track resources, and export operational snapshots.

### Alerts

Lite includes lightweight alert rules and alert events:

- Rules evaluate current operational counts, data quality, and summary metrics.
- Evaluation creates auditable alert events.
- Alert events can be acknowledged, resolved, exported, or dispatched through RapidPro.

Alert actions are declarative inside Lite. RapidPro is the built-in external SMS dispatch path.

### RapidPro SMS Integration

RapidPro support covers two operational paths:

- Outbound SMS: send alert events or report summaries through RapidPro flow starts or broadcasts.
- Inbound SMS/webhook: receive field reports from RapidPro flows and convert them into Lite field reports.

Inbound messages are recorded, linked to field reports, and can create a holding incident when no incident or intervention id is provided.

### Reporting

Lite includes deterministic reporting:

- Reusable report templates.
- Generated report instances.
- Deterministic sections with source references.
- Markdown and JSON report export.
- CSV and GeoJSON source appendices.
- Distribution runs for local artifacts, webhook delivery, and RapidPro SMS summaries.
- Report schedules and schedule-run history.

Reports are designed to be explainable: generated sections include source refs and warnings instead of opaque conclusions.

### Dashboard

The dashboard at `/` provides a lightweight operator interface:

- Source selection and ingestion execution.
- Default public-source schedule creation and due-run execution.
- Source freshness and health display.
- Service asset import.
- Operations and intervention creation.
- Alert rule creation and evaluation.
- RapidPro status and activity.
- Report template, report, schedule, distribution, and preview views.
- Risk cards, event tables, and a simple GeoJSON point viewer.

## Architecture

### Runtime

Lite is a Node.js HTTP server with no frontend build step. The server is in `src/server.js`; static dashboard assets are in `public/`.

The API is served under `/api/v1/*`. Requests outside `/api/v1/*` are served from the static dashboard.

### Main Modules

| Module | Responsibility |
| --- | --- |
| `src/server.js` | HTTP server, routing, API handlers, static file serving. |
| `src/schema.js` | Source ids, enum values, empty store shape, public source catalog. |
| `src/store.js` | JSON store and collection merge behavior. |
| `src/postgres-store.js` | PostgreSQL JSONB-backed store. |
| `src/storage.js` | Storage-mode selection from environment. |
| `src/ingestion.js` | Connector registry, ingestion runs, source policies, schedules, source health. |
| `src/connectors/*` | Source-specific public/user data connectors. |
| `src/analytics.js` | Risk, impact, data-quality computation. |
| `src/operations.js` | Incident/intervention/task/field-report/resource normalization and action logs. |
| `src/alerts.js` | Alert rules and alert event evaluation. |
| `src/rapidpro.js` | RapidPro status, outbound dispatch, inbound field-report parsing. |
| `src/reports.js` | Report templates, generation, exports, distribution, schedules. |
| `src/utils.js` | Common id, filtering, CSV, GeoJSON, JSON response helpers. |

### Storage Model

Lite stores records in named collections. JSON mode writes them to one local JSON file. PostgreSQL mode stores each record as JSONB in a generic `lite_records` table keyed by collection and id.

Important collections:

| Collection | Purpose |
| --- | --- |
| `source_runs` | One record per source ingestion attempt. |
| `ingestion_schedules` | Regular source ingestion schedules and next-run metadata. |
| `climate_observations` | Weather, rainfall, and climate records. |
| `hazard_events` | Disaster, flood, fire, and hazard records. |
| `conflict_events` | User-supplied conflict records. |
| `service_assets` | Facilities/infrastructure exposed to risk. |
| `risk_scores` | Flood and climate-conflict risk scores. |
| `impact_assessments` | Service impact assessments. |
| `data_quality` | Source quality and confidence summaries. |
| `incidents` | Operational situations. |
| `interventions` | Response plans. |
| `intervention_tasks` | Assigned intervention work. |
| `field_reports` | Field updates from users or RapidPro. |
| `response_resources` | Deployable resources. |
| `alert_rules` | Lightweight alert definitions. |
| `alert_events` | Alert outputs from rule evaluation. |
| `rapidpro_dispatches` | Outbound RapidPro attempts. |
| `rapidpro_inbound_messages` | Inbound RapidPro webhook payloads. |
| `report_templates` | Reusable report structures. |
| `reports` | Generated report instances. |
| `report_distribution_runs` | Report delivery/export attempts. |
| `report_schedules` | Recurring report schedules. |
| `report_schedule_runs` | Report schedule run history. |
| `action_logs` | Auditable mutation/action history. |

## Operating Workflows

### 1. First Run

Install dependencies and run the server:

```bash
npm install
npm test
npm start
```

Open the dashboard:

```text
http://127.0.0.1:4177
```

If `LINDELA_LITE_API_KEY` is configured, paste the key into the dashboard API key field. Read-only panels still load without the key, but dashboard actions that mutate data send `x-api-key` from that field.

Check service health:

```bash
curl http://127.0.0.1:4177/api/v1/health
```

### 2. Configure Storage

Use JSON mode for demos and local tests:

```bash
LINDELA_LITE_DB_MODE=json npm start
```

Use local pg0 mode when available:

```bash
LINDELA_LITE_DB_MODE=pg0 npm start
```

Use external PostgreSQL for hosted or production-like deployments:

```bash
LINDELA_LITE_DB_MODE=postgres \
LINDELA_LITE_DATABASE_URL=postgresql://user:pass@host:5432/lindela_lite \
npm start
```

See [storage.md](storage.md).

### 3. Run Public Ingestion

Manual ingestion:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{
    "sources": ["open_meteo", "gdacs", "glofas", "chirps", "nasa_firms"],
    "regions": [
      { "name": "Turkana", "country": "KE", "lat": 3.1, "lon": 35.6 }
    ]
  }'
```

Create default schedules for regular public sources:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/schedules/defaults
```

Run due schedules:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run-due
```

Inspect source health:

```bash
curl http://127.0.0.1:4177/api/v1/ingest/status
```

Best practice is to run `ingest/run-due` from a deployment scheduler rather than relying on an in-process timer. This keeps Lite easy to operate in simple environments and avoids hidden background behavior.

### 4. Import User Data

Import service assets:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/service-assets \
  -H 'content-type: application/json' \
  -d '{
    "service_assets": [
      {
        "name": "Clinic A",
        "service_type": "health",
        "country": "KE",
        "latitude": 3.13,
        "longitude": 35.63
      }
    ]
  }'
```

Import conflict events through `POST /api/v1/ingest/run` with `sources:["conflict_csv"]` and a `conflict_csv` payload.

### 5. Review Risk And Quality

Useful endpoints:

```text
GET /api/v1/flood-risk
GET /api/v1/conflict-risk
GET /api/v1/service-impacts
GET /api/v1/data-quality
GET /api/v1/assessments
```

Use `/api/v1/data-quality` before making decisions. Stale, low-confidence, or degraded source runs should be visible in reports and operational briefings.

### 6. Manage Operations

Create an incident:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/incidents \
  -H 'content-type: application/json' \
  -d '{
    "title": "Clinic flood access disruption",
    "incident_type": "flood_access",
    "priority": "high",
    "country": "KE",
    "latitude": 3.13,
    "longitude": 35.63
  }'
```

Create interventions, tasks, field reports, and resources against the returned ids. Review:

```text
GET /api/v1/operations/summary
GET /api/v1/incidents
GET /api/v1/interventions
GET /api/v1/tasks
GET /api/v1/field-reports
GET /api/v1/response-resources
GET /api/v1/action-logs
```

### 7. Configure Alerts

Create an alert rule:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/alert-rules \
  -H 'content-type: application/json' \
  -d '{
    "name": "Open incidents watch",
    "metric": "operations.counts.open_incidents",
    "operator": ">=",
    "threshold": 1,
    "severity": "high",
    "actions": [{ "type": "notify", "target": "response-lead" }]
  }'
```

Evaluate rules:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/alerts/evaluate
```

Alert events are stored in `/api/v1/alert-events`.

### 8. Connect RapidPro

Set RapidPro environment variables:

```bash
RAPIDPRO_BASE_URL=https://rapidpro.io
RAPIDPRO_API_TOKEN=your-token
RAPIDPRO_ALERT_FLOW_UUID=your-flow-uuid
RAPIDPRO_WEBHOOK_SECRET=shared-secret
npm start
```

Send an alert event:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/rapidpro/alert-events/alert_123/send \
  -H 'content-type: application/json' \
  -d '{"urns":["+254700000000"],"mode":"flow_start"}'
```

Receive field reports at:

```text
POST /api/v1/rapidpro/field-report
```

See [rapidpro.md](rapidpro.md).

### 9. Create Reports

Create a template:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/report-templates \
  -H 'content-type: application/json' \
  -d '{
    "name": "Daily operations SITREP",
    "report_type": "situation_report",
    "title_pattern": "Daily operations SITREP - {{country}} - {{date}}",
    "default_filters": { "country": "KE" },
    "sections": [
      "executive_summary",
      "incident_summary",
      "intervention_summary",
      "field_report_summary",
      "alert_summary",
      "data_quality_summary",
      "appendix_sources"
    ]
  }'
```

Create and generate a report:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/reports \
  -H 'content-type: application/json' \
  -d '{
    "template_id": "report_template_...",
    "scope": { "country": "KE" },
    "generate": true
  }'
```

Approve and distribute:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/reports/report_123/approve
curl -X POST http://127.0.0.1:4177/api/v1/reports/report_123/distribute \
  -H 'content-type: application/json' \
  -d '{ "channels": [{ "channel": "markdown_download" }] }'
```

Export:

```text
GET /api/v1/reports/report_123/export.md
GET /api/v1/reports/report_123/export.json
GET /api/v1/reports/report_123/export.csv
GET /api/v1/reports/report_123/export.geojson
```

### 10. Schedule Reports

Create a report schedule:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/report-schedules \
  -H 'content-type: application/json' \
  -d '{
    "template_id": "report_template_...",
    "timezone": "Africa/Nairobi",
    "recurrence": { "type": "daily", "time": "07:00" },
    "next_run_at": "2026-05-19T04:00:00.000Z",
    "auto_distribute": false
  }'
```

Run due report schedules:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/report-schedules/run-due
```

## Configuration Reference

### Server

| Variable | Purpose |
| --- | --- |
| `LINDELA_LITE_PORT` | HTTP port. Defaults to `4177`. |
| `LINDELA_LITE_API_KEY` | Optional API key required as `x-api-key` for mutating endpoints. |

### Storage

| Variable | Purpose |
| --- | --- |
| `LINDELA_LITE_DB_MODE` | `auto`, `json`, `pg0`, or `postgres`. |
| `LINDELA_LITE_STORE` | JSON store path for JSON mode. |
| `LINDELA_LITE_DATABASE_URL` | PostgreSQL connection URL. |
| `DATABASE_URL` | Fallback PostgreSQL connection URL. |
| `PG0_BIN` | Optional pg0 binary path. |

### Public Sources

| Variable | Purpose |
| --- | --- |
| `NASA_FIRMS_MAP_KEY` | Optional NASA FIRMS map key. Defaults to `OPEN_KEY`. |

Most source behavior is controlled per request or per ingestion schedule through `timeout_ms`, `retries`, `interval_minutes`, and source-specific options.

### RapidPro

| Variable | Purpose |
| --- | --- |
| `RAPIDPRO_BASE_URL` | RapidPro host. Defaults to `https://rapidpro.io`. |
| `RAPIDPRO_API_TOKEN` | RapidPro API token. |
| `RAPIDPRO_ALERT_MODE` | `flow_start` or `broadcast`. |
| `RAPIDPRO_ALERT_FLOW_UUID` | Flow UUID for flow-start mode. |
| `RAPIDPRO_ALERT_URNS` | Default comma-separated URNs. |
| `RAPIDPRO_ALERT_CONTACTS` | Default comma-separated contact UUIDs. |
| `RAPIDPRO_ALERT_GROUPS` | Default comma-separated group UUIDs. |
| `RAPIDPRO_BASE_LANGUAGE` | Broadcast language code. Defaults to `eng`. |
| `RAPIDPRO_WEBHOOK_SECRET` | Shared secret for inbound field-report webhooks. |

## API Conventions

### Response Shape

Most JSON endpoints return:

```json
{
  "success": true,
  "data": []
}
```

Errors return:

```json
{
  "success": false,
  "error": "message"
}
```

### Filtering

Common list endpoints support:

```text
bbox=west,south,east,north
country=KE
source=gdacs
event_type=flood
severity=high
status=active
priority=critical
incident_id=incident_...
intervention_id=intervention_...
service_type=health
template_id=report_template_...
schedule_id=report_schedule_...
from=2026-01-01
to=2026-01-31
limit=100
```

### Mutating Endpoint Protection

By default, local mode is unauthenticated. Set `LINDELA_LITE_API_KEY` to require:

```text
x-api-key: <key>
```

on non-GET requests.

The RapidPro inbound field-report webhook can use `RAPIDPRO_WEBHOOK_SECRET` instead of `x-api-key` when both are configured, so RapidPro flows do not need the general operator API key.

## Deployment Patterns

For the recommended Docker Compose deployment path, see [deployment.md](deployment.md).

### Local Demo

- Storage: JSON.
- Scheduler: manual dashboard buttons.
- RapidPro: optional.
- Use case: demos, training, feature review.

### Community/Field Deployment

- Storage: pg0 or managed PostgreSQL.
- Scheduler: cron/systemd/GitHub Actions calling `ingest/run-due` and `report-schedules/run-due`.
- RapidPro: configured for alert SMS and inbound reports.
- Use case: lightweight field operations and coordination.

### Hosted Deployment

- Storage: managed PostgreSQL.
- API key enabled.
- HTTPS reverse proxy.
- External scheduler.
- Backup and log retention configured outside Lite.
- Use case: small operational deployment with stronger persistence.

## Recommended Scheduler Calls

Example cron entries:

```cron
*/15 * * * * curl -fsS -X POST http://127.0.0.1:4177/api/v1/ingest/run-due >/dev/null
*/15 * * * * curl -fsS -X POST http://127.0.0.1:4177/api/v1/report-schedules/run-due >/dev/null
```

If `LINDELA_LITE_API_KEY` is set:

```cron
*/15 * * * * curl -fsS -X POST http://127.0.0.1:4177/api/v1/ingest/run-due -H 'x-api-key: ...' >/dev/null
```

## Reliability And Operations

### Ingestion Health

Use:

```text
GET /api/v1/ingest/status
```

Health values:

- `never_run`: no source run exists.
- `fresh`: last run succeeded and is within freshness policy.
- `stale`: last successful/degraded run is older than policy.
- `degraded`: last run completed with errors or low records.
- `failed`: last run failed.

Investigate `source_runs[].diagnostics` for attempts, configured retries, timeout, duration, records by collection, and error count.

### Data Quality

Use:

```text
GET /api/v1/data-quality
```

Data quality should be reviewed before external reporting or operational escalation. Reports automatically include warnings when relevant data-quality records are stale or low confidence.

### Action Logs

Mutating operations append action-log records. Use:

```text
GET /api/v1/action-logs
```

Action logs provide lightweight auditability for creates, updates, ingestion actions, alert evaluation, report generation, distribution, and schedule runs.

## Security And Safety

- Enable `LINDELA_LITE_API_KEY` outside local-only demos.
- Put Lite behind HTTPS when exposing it outside localhost.
- Keep RapidPro API tokens out of committed files.
- Do not commit JSON stores, database dumps, source exports, or field-report payloads.
- Do not treat risk scores as automated determinations.
- Keep human review for high-impact or resource-moving actions.
- Avoid sending full operational reports over SMS; RapidPro report dispatches should remain summaries with report references.
- Review [SECURITY.md](../SECURITY.md) before public deployment.

## Troubleshooting

### Server Does Not Start

Check:

```bash
npm test
LINDELA_LITE_DB_MODE=json npm start
```

If PostgreSQL mode fails, verify `LINDELA_LITE_DATABASE_URL` and database reachability.

### Source Health Is `never_run`

Run ingestion manually:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{"sources":["gdacs"]}'
```

Then inspect:

```text
GET /api/v1/sources
GET /api/v1/ingest/status
GET /api/v1/data-quality
GET /api/v1/export.csv
```

There is no dedicated `/api/v1/source-runs` endpoint; source-run summaries are exposed through the health, status, quality, and export surfaces above.

### Scheduled Ingestion Does Not Run

Check schedules:

```text
GET /api/v1/ingest/schedules
```

Confirm:

- `status` is `active`.
- `next_run_at` is in the past or current time.
- External cron/systemd/GitHub Actions is actually calling `POST /api/v1/ingest/run-due`.
- API key header is present when configured.

### RapidPro Dispatch Fails

Check:

```text
GET /api/v1/rapidpro/status
GET /api/v1/rapidpro/dispatches
```

Confirm token, base URL, flow UUID, recipients, and mode.

### Reports Are Empty

Check report `scope`. A country, incident, intervention, date, or severity filter can exclude records. Also inspect source refs and warnings on the report.

### Dashboard Looks Empty

Run ingestion and refresh:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{"sources":["open_meteo","gdacs"]}'
```

Then open:

```text
http://127.0.0.1:4177
```

Use the dashboard Refresh button after manual API calls. The dashboard does not keep a live websocket connection.

## Verification

Run the default checks:

```bash
npm run validate
npm test
```

Syntax-check key modules:

```bash
node --check src/server.js
node --check src/ingestion.js
node --check src/reports.js
node --check public/app.js
```

Run PostgreSQL integration checks when a database is available:

```bash
LINDELA_LITE_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/lindela_lite_test npm run test:postgres
```

## Documentation Map

- [api.md](api.md): endpoint reference and request examples.
- [openapi.yaml](openapi.yaml): OpenAPI 3.1 contract.
- [architecture.md](architecture.md): runtime architecture and module boundaries.
- [data-model.md](data-model.md): store collections, relationships, and record conventions.
- [ingestion.md](ingestion.md): source ingestion, schedules, retries, and source health.
- [dashboard.md](dashboard.md): dashboard workflows and API key behavior.
- [configuration.md](configuration.md): environment variables and deployment configuration.
- [runbook.md](runbook.md): operational checks, incident response, backups, and updates.
- [developer-guide.md](developer-guide.md): local development and extension workflow.
- [storage.md](storage.md): JSON, pg0, and PostgreSQL storage.
- [operations.md](operations.md): intervention-management workflow.
- [rapidpro.md](rapidpro.md): RapidPro alert and field-report workflows.
- [service-assets.md](service-assets.md): service asset import formats.
- [reporting-prd.md](reporting-prd.md): reporting product requirements and implementation plan.
- [open-source-boundary.md](open-source-boundary.md): Lite vs full Lindela boundary.
