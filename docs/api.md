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

## Trigger Protocols

### `GET /api/v1/trigger-protocols`

Auth: none required. Returns list of all trigger protocol objects.

Response: `{ success, data: TriggerProtocol[] }`

### `POST /api/v1/trigger-protocols/:id/backtest`

Auth: `write:incidents` or `*`. Runs the trigger protocol against historical data.

Body: `{ from: ISO, to: ISO }`

Response: `{ success, data: { hits, misses, false_positives, threshold, events: [] } }`

### `POST /api/v1/trigger-protocols/:id/shadow-run`

Auth: `write:incidents` or `*`. Evaluates the protocol against current conditions without dispatching.

Response: `{ success, data: { would_trigger: bool, score, conditions } }`

---

## CAP Export

### `GET /api/v1/alert-events/:id.cap`

Auth: none required. Returns a CAP 1.2 XML document for the specified alert event.

Response: `Content-Type: application/xml` with valid CAP 1.2 envelope.

Precondition: alert event with `:id` must exist; returns 404 otherwise.

---

## Scenarios

### `POST /api/v1/scenarios`

Auth: none required. Creates a shareable scenario token encoding a set of filter/view parameters.

Body: `{ params: Record<string,string> }`

Response: `{ success, token, url }` where `url` is `/api/v1/scenarios/<token>`.

### `GET /api/v1/scenarios/:token`

Auth: none required. Decodes and returns the scenario params embedded in the token.

Response: `{ success, data: { params } }`

---

## Bias Correction

### `POST /api/v1/analytics/bias-correct`

Auth: none required. Applies quantile-mapping bias correction to a climate observation series.

Body: `{ observations: [{ value, date }], reference: [{ value }] }`

Response: `{ success, data: { corrected: [number], method: 'quantile_map' } }`

---

## Population at Risk

### `GET /api/v1/impact/population-at-risk`

Auth: none required. Returns the latest population-at-risk assessments.

Query: standard `filterRecords` params (`district`, `country`, `limit`, `offset`, `sort`).

Response: `{ success, data: PopulationAtRisk[] }`

---

## Data Lineage

### `GET /api/v1/data-lineage`

Auth: none required. Returns lineage records tracking provenance of derived data.

Response: `{ success, data: DataLineage[] }`

---

## Outbox

### `GET /api/v1/outbox`

Auth: none required. Returns pending and sent outbox events.

Response: `{ success, data: OutboxEvent[] }`

### `POST /api/v1/outbox/dispatch`

Auth: `admin:*` or `*`. Flushes pending outbox events to registered webhook subscribers.

Response: `{ success, dispatched: int }`

---

## Webhooks

### `POST /api/v1/webhooks`

Auth: none required. Registers a webhook subscription.

Body: `{ url, events: string[], secret?: string }`

Response: `{ success, data: WebhookSubscription }` — 201 on create.

### `GET /api/v1/webhooks`

Auth: none required. Lists registered webhook subscriptions.

Response: `{ success, data: WebhookSubscription[] }`

### `PATCH /api/v1/webhooks/:id`

Auth: none required. Updates url or events list of an existing subscription.

Body: `{ url?, events? }`

Response: `{ success, data: WebhookSubscription }`

---

## Connectors Registry

### `GET /api/v1/connectors`

Auth: none required. Returns the list of available ingestion connector definitions (from `connectors.registry.json`).

Response: `{ success, data: ConnectorSpec[] }`

---

## PII Maintenance

### `POST /api/v1/maintenance/apply-retention`

Auth: `admin:*`. Applies configured data-retention policy: anonymises or deletes PII fields on records older than the retention window.

Body: `{ dry_run?: bool, actor?: string }`

Response: `{ success, affected: int, dry_run: bool }`

Side effect: modifies field_reports, rapidpro_inbound_messages, and action_logs in-place. Writes an action_log entry per affected collection.

---

## OGC Features

### `GET /ogc/collections/:id/items`

Auth: none required. Returns GeoJSON FeatureCollection for the specified collection id.

Supported ids: `alert_events`, `hazard_events`, `service_assets`, `field_reports`.

Query: `bbox` (minLon,minLat,maxLon,maxLat), `limit`, `offset`.

Response: `Content-Type: application/geo+json` with a standard OGC Features response envelope.

---

## Phase 1c routes (CHW Mobile Web)

### `POST /api/v1/chw/report`

Auth: `role:chw` or `*`. Submits a CHW field report.

Body: `{ description, category, location?: { latitude, longitude }, reporter_phone?, reporter_name?, anonymous? }`

Response: `{ success, data: FieldReport }` — 201.

Side effects: creates field_report and rapidpro_inbound_message. PII redacted per policy.

### `POST /api/v1/chw/reply`

Auth: `role:chw` or `*`. Submits a CHW reply to an active alert.

Body: `{ alert_event_id, message }`

Response: `{ success, data: RapidProInboundMessage }` — 201.

---

## Phase 1d routes (KPI, Equity, Community Feedback, CO Dashboard)

### `GET /api/v1/kpi/quarterly`

Auth: none required. Returns quarterly KPI computation matched to UNICEF bid indicators.

Query: `quarter` (Q1|Q2|Q3|Q4, default current), `year` (int, default current).

Response:

```json
{
  "success": true,
  "data": {
    "people_reached": 0,
    "percent_children_u18": null,
    "percent_women_and_girls": null,
    "percent_pwd": null,
    "community_reporters_count": 0,
    "youth_mappers_count": 0,
    "oss_releases_count": 3,
    "warning_to_action_median_hours": null,
    "feeding_supply_repositioning_rate": null,
    "cold_chain_protection_rate": null,
    "false_alert_rate": null,
    "api_uptime_pct": 100.0,
    "cohort": { "total": 0, "u18": null, "women_and_girls": null, "pwd": null, "refugees_idps": null },
    "period": { "quarter": "Q3", "year": 2026, "from": "...", "to": "..." },
    "data_gaps": [{ "field": "percent_children_u18", "reason": "..." }],
    "generated_at": "2026-08-09T..."
  }
}
```

Result is cached 5 minutes keyed on quarter/year/record-counts. Null fields denote missing demographic data; see `data_gaps` for explanation.

### `GET /api/v1/kpi/quarterly.pdf`

Auth: none required. Returns the quarterly KPI report as a minimal PDF 1.4 document (Helvetica, single page, title + KPI table + cohort table + SHA-256 signature footer).

Query: same as `/api/v1/kpi/quarterly`.

Response: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="unicef-kpi-<year>-<quarter>.pdf"`.

### `GET /api/v1/equity/by-district`

Auth: none required. Returns per-district accuracy metrics grouped from alert_events and rapidpro_dispatches.

Response: `{ success, data: EquityDistrict[] }` where each row includes `district`, `dispatched`, `acknowledged`, `false_positive`, `accuracy_pct`, `alerts_by_severity`, and `data_gaps`.

### `GET /api/v1/equity/breaches`

Auth: none required. Returns districts where `accuracy_pct < threshold` AND `dispatched >= 5`.

Query: `threshold` (float, default 80).

Response: `{ success, data: [{ district, accuracy_pct, dispatched }] }`

### `POST /api/v1/equity/scan`

Auth: none required. Idempotently creates `equity_audit_action` workflow instances for each accuracy breach district.

Response: `{ success, created: int, ids: string[] }` — 201.

Side effect: writes workflow_instances to store. Idempotent: districts with an existing open audit workflow are skipped.

### `POST /api/v1/community-feedback`

Auth: `role:chw`, `write:incidents`, or `*`. Creates a community feedback record.

Body:

```json
{
  "alert_event_id": "ae-...",
  "source": "chw",
  "reporter_urn": "tel:+254700000001",
  "sentiment": "positive",
  "message": "Alert was accurate",
  "was_action_taken": true
}
```

`reporter_urn` is hashed on write (SHA-256/16 chars); the raw value is never stored.

Response: `{ success, data: CommunityFeedback, outbox_event: string }` — 201.

### `GET /api/v1/community-feedback`

Auth: none required. Returns filtered list of feedback records.

Query: standard filterRecords params.

Response: `{ success, data: CommunityFeedback[] }`

### `GET /api/v1/community-feedback/summary`

Auth: none required. Returns feedback grouped by alert_event_id with count and sentiment distribution.

Response:

```json
{
  "success": true,
  "data": [
    {
      "alert_event_id": "ae-001",
      "count": 2,
      "sentiment": { "positive": 1, "negative": 1, "unclear": 0 },
      "action_taken_count": 1
    }
  ]
}
```

---

## Parametric disbursement (testnet only)

See [parametric.md](parametric.md) for full details. All chains are testnets; mainnet chains are rejected explicitly.

### `GET /api/v1/parametric-rules`

List all parametric rules.

Response: `{ success, data: ParametricRule[], count }`

### `POST /api/v1/parametric-rules`

Create a parametric rule. Scope: `admin:*`.

Body: `{ name, chain, trigger_metric, trigger_threshold, disbursement_amount_local_currency, currency, recipient_group_id, requires_focal_point_approval, status? }`

Response: `{ success, data: ParametricRule }` — HTTP 201.

`chain` must be one of `ethereum-sepolia`, `polygon-mumbai`, `celo-alfajores`. Mainnet chains return HTTP 400 with a "testnet-only per pilot commitment" message.

### `PATCH /api/v1/parametric-rules/:id`

Update a parametric rule. Scope: `admin:*`.

### `POST /api/v1/parametric-rules/:id/simulate`

Simulate a disbursement against the given rule. Scope: `role:operator` or `admin:*`.

Body: `{ focal_point_approved: bool, actor: string }`

Returns HTTP 409 when `requires_focal_point_approval` is true and `focal_point_approved` is false.

Response: `{ success, data: { simulated: true, disbursement_id, chain, tx_hash, amount, currency, recipient_group_id, rule_id, status: 'simulated', simulated_at } }`

`tx_hash` always begins with `sim_`. No on-chain transaction is made.

The disbursement is persisted to the `parametric_disbursements` collection.

### `GET /api/v1/parametric-disbursements`

List all simulated disbursements.

Response: `{ success, data: ParametricDisbursement[], count }`

---

## OpenAPI

The OpenAPI 3.1 contract is available at [openapi.yaml](openapi.yaml).
