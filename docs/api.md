# Lindela Lite API

All endpoints return JSON unless otherwise noted. The default server is local and unauthenticated. Set `LINDELA_LITE_API_KEY` to require `x-api-key` on mutating endpoints.

## Endpoints

- `GET /api/v1/health` returns service status, storage mode, store counts, and available source ids.
- `GET /api/v1/sources` lists source capabilities and last source runs.
- `POST /api/v1/ingest/run` runs one or more ingestors.
- `GET /api/v1/ingest/status` returns per-source health, policy, schedule, last run, and failure-streak details.
- `GET /api/v1/ingest/schedules` and `POST /api/v1/ingest/schedules` list and create ingestion schedules.
- `GET /api/v1/ingest/schedules/:id` and `PATCH /api/v1/ingest/schedules/:id` inspect, pause, resume, or update ingestion schedules.
- `POST /api/v1/ingest/schedules/defaults` creates default schedules for regular public/open-source connectors.
- `POST /api/v1/ingest/schedules/:id/run` runs one ingestion schedule immediately.
- `POST /api/v1/ingest/run-due` runs every active ingestion schedule whose `next_run_at` is due.
- `GET /api/v1/events` returns hazard and conflict events.
- `GET /api/v1/climate` returns climate observations.
- `GET /api/v1/flood-risk` returns flood risk scores.
- `GET /api/v1/conflict-risk` returns climate-conflict risk scores.
- `GET /api/v1/service-assets` returns imported service assets.
- `POST /api/v1/service-assets` imports service assets from JSON, CSV, or GeoJSON.
- `GET /api/v1/service-impacts` returns service-delivery impact assessments.
- `GET /api/v1/data-quality` returns source freshness, geocoding coverage, and confidence summaries.
- `GET /api/v1/operations/summary` returns operational counts and status breakdowns.
- `GET /api/v1/incidents` and `POST /api/v1/incidents` list and create incidents.
- `GET /api/v1/incidents/:id` and `PATCH /api/v1/incidents/:id` inspect and update an incident.
- `GET /api/v1/interventions` and `POST /api/v1/interventions` list and create intervention plans.
- `GET /api/v1/interventions/:id` and `PATCH /api/v1/interventions/:id` inspect and update an intervention.
- `GET /api/v1/tasks` and `POST /api/v1/tasks` list and create intervention tasks.
- `GET /api/v1/tasks/:id` and `PATCH /api/v1/tasks/:id` inspect and update a task.
- `GET /api/v1/field-reports` and `POST /api/v1/field-reports` list and create field reports.
- `GET /api/v1/response-resources` and `POST /api/v1/response-resources` list and create response resources.
- `GET /api/v1/field-reports/:id` and `PATCH /api/v1/field-reports/:id` inspect and update a field report.
- `GET /api/v1/response-resources/:id` and `PATCH /api/v1/response-resources/:id` inspect and update a response resource.
- `GET /api/v1/action-logs` returns immutable operational action logs.
- `GET /api/v1/alert-rules` and `POST /api/v1/alert-rules` list and create lightweight alert rules.
- `GET /api/v1/alert-rules/:id` and `PATCH /api/v1/alert-rules/:id` inspect and update an alert rule.
- `POST /api/v1/alerts/evaluate` evaluates active alert rules against current counts and operations summaries.
- `GET /api/v1/alert-events` returns alert events created by rule evaluation.
- `GET /api/v1/alert-events/:id` and `PATCH /api/v1/alert-events/:id` inspect, acknowledge, or resolve an alert event.
- `GET /api/v1/rapidpro/status` returns RapidPro configuration status without exposing secrets.
- `POST /api/v1/rapidpro/alert-events/:id/send` sends an alert event through RapidPro and records a dispatch.
- `POST /api/v1/rapidpro/field-report` receives a RapidPro webhook payload and creates a field report.
- `GET /api/v1/rapidpro/dispatches` returns RapidPro outbound dispatch logs.
- `GET /api/v1/rapidpro/inbound` returns RapidPro inbound webhook logs.
- `GET /api/v1/report-templates` and `POST /api/v1/report-templates` list and create reusable report templates.
- `GET /api/v1/report-templates/:id` and `PATCH /api/v1/report-templates/:id` inspect and update report templates.
- `POST /api/v1/report-templates/:id/copy` copies a report template into a new version-1 template.
- `GET /api/v1/reports` and `POST /api/v1/reports` list and create report instances.
- `GET /api/v1/reports/:id` and `PATCH /api/v1/reports/:id` inspect and update draft/ready reports.
- `POST /api/v1/reports/:id/generate` regenerates deterministic sections for a draft or ready report.
- `POST /api/v1/reports/:id/approve` approves a generated report.
- `POST /api/v1/reports/:id/distribute` creates distribution runs for local Markdown/JSON, webhook, or RapidPro SMS-summary channels.
- `GET /api/v1/reports/:id/export.md`, `/export.json`, `/export.csv`, and `/export.geojson` export a report or its source appendix.
- `GET /api/v1/report-distributions` returns report distribution runs.
- `GET /api/v1/report-distributions/:id` inspects one distribution run.
- `POST /api/v1/report-distributions/:id/retry` retries a distribution run with the original channel options.
- `GET /api/v1/report-schedules` and `POST /api/v1/report-schedules` list and create report schedules.
- `GET /api/v1/report-schedules/:id` and `PATCH /api/v1/report-schedules/:id` inspect and update schedules.
- `POST /api/v1/report-schedules/:id/run` runs one schedule immediately.
- `POST /api/v1/report-schedules/run-due` runs all schedules whose `next_run_at` is due.
- `GET /api/v1/report-schedule-runs` returns schedule run history.
- `GET /api/v1/report-schedule-runs/:id` inspects one schedule run.
- `POST /api/v1/report-schedule-runs/:id/retry` retries the schedule that produced the run.
- `GET /api/v1/assessments` returns a combined assessment package.
- `GET /api/v1/export.geojson` returns event and service features as GeoJSON.
- `GET /api/v1/export.csv` returns events as CSV.

## Common Filters

- `bbox=west,south,east,north`
- `country=KE`
- `source=gdacs`
- `event_type=flood`
- `severity=high`
- `status=active`
- `priority=critical`
- `incident_id=incident_...`
- `intervention_id=intervention_...`
- `service_type=health`
- `from=2026-01-01`
- `to=2026-01-31`
- `limit=100`

## Ingestion Example

```json
{
  "sources": ["open_meteo", "gdacs", "glofas", "chirps", "nasa_firms"],
  "regions": [
    { "name": "Turkana", "lat": 3.1, "lon": 35.6, "country": "KE" }
  ]
}
```

`gdelt` is not a valid source id.

## Regular Ingestion Example

Create default public-source schedules:

```json
{
  "sources": ["open_meteo", "gdacs", "glofas", "chirps", "nasa_firms"]
}
```

Create a custom schedule:

```json
{
  "source": "gdacs",
  "interval_minutes": 60,
  "timeout_ms": 20000,
  "retries": 2,
  "next_run_at": "2026-05-18T07:00:00.000Z"
}
```

Deployments can call `POST /api/v1/ingest/run-due` from cron, a systemd timer, GitHub Actions, or another scheduler. Source runs record status, attempts, retry configuration, timeout, records by collection, errors, and schedule linkage.

## Operations Example

```json
{
  "title": "Clinic flood access disruption",
  "incident_type": "flood_access",
  "priority": "high",
  "country": "KE",
  "latitude": 3.13,
  "longitude": 35.63
}
```

Create an intervention against the returned `incident_id`, then add tasks, field reports, and resources. Mutating operational endpoints append records to `/api/v1/action-logs`.

## Alert Rule Example

```json
{
  "name": "Open incidents watch",
  "metric": "operations.counts.open_incidents",
  "operator": ">=",
  "threshold": 1,
  "severity": "high",
  "actions": [{ "type": "notify", "target": "response-lead" }]
}
```

Evaluate rules with `POST /api/v1/alerts/evaluate`. Alert actions are declarative instructions for downstream systems; Lite does not send external notifications by itself.

## RapidPro Examples

Send an alert event:

```json
{
  "urns": ["+254700000000"],
  "mode": "flow_start"
}
```

Receive a field report webhook:

```json
{
  "id": "rapidpro-message-1",
  "from": "+254711111111",
  "content": "REPORT incident_abc123 Access route blocked needs: fuel, water 3.12,35.63",
  "contact": { "uuid": "contact-1", "name": "Field Agent" }
}
```

If `RAPIDPRO_WEBHOOK_SECRET` is set, include it as `x-rapidpro-secret` or as a bearer token. When `LINDELA_LITE_API_KEY` is also enabled, this RapidPro secret can authenticate the inbound webhook endpoint without an additional `x-api-key`.

## Reporting Examples

Create a template:

```json
{
  "name": "Daily operations SITREP",
  "report_type": "situation_report",
  "title_pattern": "Daily operations SITREP - {{country}} - {{date}}",
  "default_filters": { "country": "KE" },
  "sections": ["executive_summary", "incident_summary", "field_report_summary", "alert_summary", "data_quality_summary", "appendix_sources"]
}
```

Create and generate a report:

```json
{
  "template_id": "report_template_...",
  "scope": { "country": "KE" },
  "generate": true
}
```

Distribute a generated report:

```json
{
  "channels": [
    { "channel": "markdown_download" },
    { "channel": "csv" },
    { "channel": "geojson" },
    { "channel": "webhook", "url": "https://example.org/lindela-report" },
    { "channel": "rapidpro_sms", "urns": ["+254700000000"] }
  ]
}
```

Create a due schedule and run it:

```json
{
  "template_id": "report_template_...",
  "timezone": "Africa/Nairobi",
  "recurrence": { "type": "daily", "time": "07:00" },
  "next_run_at": "2026-05-19T04:00:00.000Z",
  "auto_distribute": false
}
```

## OpenAPI

The OpenAPI 3.1 contract is available at [openapi.yaml](openapi.yaml).
