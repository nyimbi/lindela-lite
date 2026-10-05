# Lindela Lite API

All endpoints return JSON unless otherwise noted. The default server is local and unauthenticated. Set `LINDELA_LITE_API_KEY` to require `x-api-key` on mutating endpoints.

## Endpoints

- `GET /api/v1/health` returns service status, storage mode, store counts, and available source ids. Liveness only.
- `GET /api/v1/ready` probes the store and returns `503` when it cannot be read. Readiness: distinct from `/health`
  because the store is a separate dependency, and a load balancer polling only `/health` keeps an instance in
  rotation that cannot serve a single request. Public, like `/health`; carries no records.
- `GET /api/v1/sources` lists source capabilities and last source runs.
- `POST /api/v1/ingest/run` runs one or more ingestors.
- `GET /api/v1/ingest/status` returns per-source health, policy, schedule, last run, and failure-streak details.
- `GET /api/v1/ingest/schedules` and `POST /api/v1/ingest/schedules` list and create ingestion schedules.
- `GET /api/v1/ingest/schedules/:id` and `PATCH /api/v1/ingest/schedules/:id` inspect, pause, resume, or update ingestion schedules.
- `POST /api/v1/ingest/schedules/defaults` creates default schedules for regular public/open-source connectors.
- `POST /api/v1/ingest/schedules/:id/run` runs one ingestion schedule immediately.
- `POST /api/v1/ingest/run-due` runs every active ingestion schedule whose `next_run_at` is due.
- `GET /api/v1/upload` publishes the bulk-upload contract: every collection that can be uploaded into, the
  columns it requires and the columns it accepts. Fetch it rather than guessing — a guessed column is a
  validation report instead of a column list.
- `POST /api/v1/upload` bulk-imports CSV with a row-level validation report. Accepts `multipart/form-data`
  (part named `file`), raw `text/csv`, or `{csv, collection}` as JSON; all three reach one validator and
  produce one report. `dry_run=true` validates and writes nothing. Any rejected row means 422 and nothing
  is written. See [Bulk Upload](#bulk-upload).
- `GET /api/v1/events` returns hazard and conflict events.
- `GET /api/v1/climate` returns climate observations.
- `GET /api/v1/flood-risk` returns flood risk scores.
- `GET /api/v1/flood-depth` returns static flood depth for a water surface elevation, with per-level coverage, extent polygons, and model limits stated in the payload.
- `GET /api/v1/road-access` returns passage status for every road asset, plus a summary.
- `GET /api/v1/road-access/summary` returns road access counts and cut-off rate.
- `GET /api/v1/food-security` returns IPC acute food insecurity classifications, plus a Phase 3+ summary.
- `GET /api/v1/food-security/summary` returns the IPC Phase 3+ roll-up alone.
- `GET /api/v1/disease-observations` returns WHO GHO outbreak indicators with staleness verdicts.
- `POST /api/v1/flood-probability/train` fits the empirical rainfall–flood model per pilot district from the store, writing trained models and explicit refusals.
- `GET /api/v1/flood-probability/score` scores rainfall statistics against a trained model, carrying model card, validation, and basis.
- `GET /api/v1/flood-probability/models` lists trained models, refusals included.
- `POST /api/v1/routing/plan` plans delivery routes over current road access, returning per-leg routes and severed-segment diagnostics.
- `GET /api/v1/conflict-risk` returns climate-conflict risk scores.
- `GET /api/v1/service-assets` returns imported service assets.
- `POST /api/v1/service-assets` imports service assets from JSON, CSV, or GeoJSON.
- `GET /api/v1/service-impacts` returns service-delivery impact assessments.
- `GET /api/v1/data-quality` returns source freshness, geocoding coverage, and confidence summaries.
- `GET /api/v1/operations/summary` returns operational counts and status breakdowns.
  Two of its keys were renamed because they named something other than what they
  counted: `population_at_risk` and `facilities_at_risk` were both `.length` of a
  list, and those lists are keyed by hazard and by service type respectively — so
  "facilities at risk" was reporting the number of service types the schema knows.
  The row counts are now `population_at_risk_rows` and
  `facilities_at_risk_types`; the figures an operator wants are
  `population_at_risk_total` and `facilities_at_risk_total`. All four are `null`
  before analytics has run, which is a different state from a run that found
  nothing.
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
- `limit=100` (default 500, clamped to 5000)
- `cursor=<next_cursor>` (see below)

## Pagination

Collection routes return an envelope, not a bare array:

```json
{ "success": true, "data": [], "returned": 0, "limit": 500, "total": 0,
  "has_more": false, "next_cursor": null }
```

`total` counts everything that matched the filters. `data` is one page. Without
the total a caller cannot distinguish an empty collection from a truncated one,
which is the same conflation the district overview counts used to carry.

To page: pass `next_cursor` back as `?cursor=`. A cursor that does not name a
record in the current result set is a `400` — resuming from nothing would replay
the first page while the caller believed it was reading further in. A record
deleted between pages invalidates its cursor, so a cursor is a position in one
result set, not a permanent address.

## Conditional Requests

Successful `200` responses carry an `ETag` and `cache-control: no-cache`. Send
`If-None-Match` to get a bodyless `304` when nothing has changed:

```bash
etag=$(curl -sD - -o /dev/null localhost:4177/api/v1/events | grep -i '^etag' | cut -d' ' -f2 | tr -d '\r')
curl -s -H "If-None-Match: $etag" localhost:4177/api/v1/events -o /dev/null -w '%{http_code}\n'   # 304
```

`201` responses are not tagged: a created resource is not a cacheable
representation of a collection.

Every JSON response also carries `Vary: authorization, x-api-key`. A shared
device — one district phone, several health workers — must not serve one
caller's cached body to the next, and a cache between here and the browser, the
service worker's Cache API included, keys on those headers only when the response
says so.

## Rate Limits

Every request is charged to a per-client budget before it does any work,
including authentication. Over budget is `429` with `Retry-After` in seconds and
the class in the body:

```json
{ "success": false, "error": "Rate limit exceeded for the read budget. Retry in 3s.",
  "class": "read", "retry_after_seconds": 3 }
```

| Class | Budget | Applies to |
| --- | --- | --- |
| `read` | 120/min, 8 concurrent | `GET`s, and everything not listed below |
| `write` | 60/min, 6 concurrent | `POST`/`PUT`/`PATCH`/`DELETE` |
| `heavy` | 6/min, 1 concurrent | `/api/v1/ingest/run`, `/ingest/run-one`, `/ingest/run-due`, `/ingest/schedules/defaults`, `/report-schedules/run-due` |

`/api/v1/health`, `/api/v1/ready` and `/metrics` are never limited: a load
balancer polling health through a spent budget is an outage reported as a slow
response. The write budget is sized for a health worker draining a week of
queued reports when signal returns — that burst is the feature, and a limit that
refused it would re-queue a worker's week.

The client is the socket address. Behind a reverse proxy, set
`LINDELA_LITE_TRUST_PROXY=1` and the last `x-forwarded-for` hop is used instead —
the hop the proxy observed, which a client prepending to the chain cannot forge.
The per-client registry is bounded and evicts least-recently-seen, so a caller
cannot exhaust memory by inventing source addresses.

## Idempotency

Send `Idempotency-Key` on any `POST`, `PUT`, `PATCH` or `DELETE`. A repeat within
the window replays the original response and sets `idempotency-replayed: true`.

- The key is scoped by **caller, method and path** before lookup. Unscoped, two
  partners both using `"1"` would receive each other's writes.
- A key reused with a **different body** is a `409` with `idempotency-conflict`,
  not a replay. Answering with a receipt for work that was never done is worse
  than running the request.
- **Failures are never cached.** A `500` replayed for 24 hours would turn a
  transient fault into a permanent one.
- The window is **24 hours, in-process, capped at 1000 entries**. The store is
  one process, so this bounds the guarantee rather than eliminating it.
  `GET /api/v1/ready` reports the bound; do not assume more than it says.

```bash
curl -X POST localhost:4177/api/v1/ingest/run \
  -H 'content-type: application/json' -H 'Idempotency-Key: run-2026-10-03-a' \
  -d '{"sources":["service_assets"],"service_assets":[...]}'
```

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

## Flood Depth, Road Access, and Routing

These four endpoints answer the logistics question: given a flood, can we still
reach the facility, and how?

### `GET /api/v1/flood-depth`

Auth: none required. Keyless; fetches terrain from AWS Terrarium (SRTM).

Query: `south`, `north`, `west`, `east` (required), `level_m` (water surface
elevation, default 500), `grid_size` (default 64).

Response: `{ success, data: FloodDepthGrid }`

```
curl "http://127.0.0.1:4177/api/v1/flood-depth?south=3.0&north=3.3&west=35.4&east=35.7&level_m=500&grid_size=32"
```

What it computes: `depth = level_m - elevation` on a grid, with `null` where
terrain data is void.

What it is not: a hydraulic simulation or a forecast. The water level is an
input. No flow routing, channel geometry, or storage is modelled, so a surface
at *L* shades ground below *L* that is hydraulically connected, which in
reality is only some of it — a closed basin below *L* does not become a lake.
Every response carries `model` and `vertical_resolution_m` (±15 m, inherited
from SRTM) so a caller can judge whether the question is answerable at their
margin.

Rainfall intensity/duration to flood probability is deliberately **not**
implemented. It needs an agreed hydrological model basis and a long validated
annual-maxima record; coefficients that look authoritative without validation
are worse than no output.

### `GET /api/v1/road-access`

Auth: none required.

Response: `{ success, data: RoadAccess[], summary: RoadAccessSummary }`

One record per road asset whether or not it is obstructed, so "clear" is an
observable state rather than an absence. Each carries `access_status`,
`access_reason`, `access_score`, and `access_level`.

Matching rules: a hazard obstructs a road when the road falls inside a
hazard-scale bbox, or within the block radius of the reported centre (2 km for
flood, 5 km for landslide, since debris travels further). Bounding boxes wider
than ~5° are administrative extents rather than inundation footprints and fall
back to proximity matching, so a country-level GDACS alert cannot restrict
distant roads.

### `GET /api/v1/road-access/summary`

Auth: none required. Returns `{ success, summary: RoadAccessSummary }` with
`total_roads`, `cut_off_rate_pct`, and `blocked_by_hazard_type`.

### `GET /api/v1/food-security`

Auth: none required. Keyless; IPC classifications via HDX (CC0 / public
domain). Default ingestion scope is all Sub-Saharan Africa.

Response: `{ success, data: FoodSecurityRecord[], summary: FoodSecuritySummary }`

One grouped record per area and validity window, phases 1–5 plus the Phase 3+
aggregate. Three honesty constraints ride in the record metadata itself:

- Every classification is **relayed verbatim** from National IPC Technical
  Working Groups. The platform does not re-derive a phase: published thresholds
  carry triggering consequences under famine and anticipatory-action policy.
- The `Percentage` column is a **fraction of the analysed population** —
  `0.2` means 20%, not 0.2% — stated on every record.
- Coordinates are `null`. Geometry is a **bounding box** where the dataset
  GeoJSON matched the area name; a bbox includes neighbouring ground the
  classification does not cover.

Projections carry `validity_period: first_projection` / `second_projection`
and are IPC's projections, not forecasts by this platform. The summary's
`countries` and `worst_areas` roll-ups read only the `current` window, ordered
by window start date.

### `GET /api/v1/food-security/summary`

Auth: none required. Returns `{ success, summary }` with `countries` (latest
current window per country) and `worst_areas` (ten highest Phase 3+ fraction
areas).

### `GET /api/v1/disease-observations`

Auth: none required. Keyless; WHO Global Health Observatory OData.

Response: `{ success, data: DiseaseObservation[], summary }`

National-annual aggregates for cholera (cases, deaths, case fatality rate),
meningitis (cases, epidemic districts), measles, yellow fever, and plague.
Deliberate constraints:

- The source reports COUNTRY/YEAR, so `coordinates` are `null` and the record
  is context for what national surveillance says — **not evidence about any
  district**.
- No trend, incidence rate, or risk score is derived: no denominators or
  reporting-quality metadata are available in the source.
- Every record carries a policy note: outbreak figures can move funding flows
  and stigmatise areas; decision-support context with attribution, not an
  alert trigger.
- The summary marks each indicator series `current` / `aging` / `stale`
  against the calendar. Cholera's published series ends 2016 (verified); a
  stale series is a data fact, not a disease fact.

### `POST /api/v1/flood-probability/train`

Auth: API key. Trains the empirical rainfall–flood model per pilot district
(`src/flood-probability.js`, basis documented in
`docs/flood-probability-model-basis.md`). Pure compute over the store — the
rainfall series from `open_meteo_archive` climate observations and, by
default, flood labels from `gdacs`/`gdacs_archive` hazard events; no network
calls.

Optional body `{ regions: [{name, country, lat, lon}], label_source }`.
`label_source` selects the label: `'gdacs_archive'` (default, reported floods
within 150 km) or `'glofas_discharge'`, which labels months from
`open_meteo_flood` GloFAS river-discharge series instead — usable where
reported-flood records are too sparse, but model-conditioned (see the basis
document).

Response: `{ success, data: FloodProbabilityModel[], refusals: [{region, refusal, months_kept?, events_matched?, flood_months?}] }`

Hard refusals (60-month / 5-flood-month floors, all-one-class samples, missing
archive series) come back per district with the reason — no number without a
sample. Trained models are written to `flood_probability_models` with their
model card, contingency counts, leave-one-year-out scores, and the reporting
condition: **P(flood enters the GDACS archive)**, not P(water at an elevation).

### `GET /api/v1/flood-probability/score`

Query parameters: `max_7_day`, `sum_30_day`, `sum_90_day` (mm; required),
`region` (district name; optional — newest trained model otherwise).

Auth: none. Scores rainfall statistics against the most recent trained model
for `region` (or the newest model overall).

Response (when trained): `{ success, scored: true, data: { region_name, probability, features, trained_at, model, folds, basis, months_kept, events_matched, metadata } }`

The model card is the response, not hidden server state: coefficients,
standardisation, λ, training months, base rate, and the Brier/skill folds all
travel with every score so a reader can check what the number is standing on.
Without a trained model or for non-finite features: `scored: false` with the
refusal text — a refusal is an answer, not a 500.

### `GET /api/v1/flood-probability/models`

Auth: none. The trained models from `flood_probability_models`, including
districts that refused with the refusal text, which the dashboard strip shows.

### `POST /api/v1/routing/plan`

Auth: `write:incidents` or `*`.

Body: `{ from, to, link_radius_km?, max_minutes? }`

`from` and `to` are **road asset ids**, not coordinates. Get them from
`GET /api/v1/service-assets?service_type=road`. Coordinate objects are rejected
with an explicit error rather than reported as an unknown road.

```
curl -X POST http://127.0.0.1:4177/api/v1/routing/plan \
  -H 'content-type: application/json' \
  -d '{"from":"asset_c2f1b7f06baeda8e","to":["asset_87445d3f0f60540e"]}'
```

Response: `{ success, data: RoutingPlan }`

An impassable segment is removed from the graph rather than penalised, because
no finite cost is a barrier. Restricted segments multiply cost by a
class-dependent penalty, so a truck detouring onto an unpaved track is priced
differently from a bicycle on a cycleway, and any leg relying on one is flagged
`degraded`.

`fully_deliverable` is false when any destination is unreachable, with a
plain-language `caveat`. A plan that cannot reach every site is not a plan, so
the response does not quietly return a straight line.

Not modelled: bridges, culverts, ferry crossings, seasonal causeways, load
limits. If the operator has not imported them as assets, the router cannot
reason about them. Each leg reports the `road_classes` it relied on.

## Bulk Upload

`POST /api/v1/upload` is the door for a user's own data. Three content types reach the same validator, because
three clients are real: a browser form posts multipart, `curl --data-binary @file.csv` sends `text/csv`, and an
integrator who already has the rows in memory sends JSON.

```bash
# What columns does this collection want?
curl -s localhost:4177/api/v1/upload | jq '.collections[] | {id, required_columns}'

# Check the file before writing anything.
curl -s -X POST 'localhost:4177/api/v1/upload?collection=service_assets&dry_run=true' \
  -H 'content-type: text/csv' --data-binary @assets.csv | jq '.summary, .errors'

# Import it.
curl -s -X POST 'localhost:4177/api/v1/upload?collection=service_assets' \
  -H 'content-type: text/csv' --data-binary @assets.csv | jq
```

A rejected row is reported as `{row, column, value, message}`, where `row` is a **line number in the file,
counting the header as line 1**, and `value` is what was found, verbatim. Errors are capped at 20 in the body;
`error_count` is the true total and `errors_truncated` says whether the list was cut.

Four things it will not do, each because the alternative is a silent wrong answer:

- **It will not guess a column name.** `lat`, `latitude` and `Latitude` all appear in real exports. An explicit
  alias table handles the ones it knows; an unknown header is carried into the record under its own name rather
  than dropped.
- **It will not clamp an out-of-range coordinate.** A latitude of 91 is not a latitude at ±90. Clamping would put
  the record in the store claiming to be somewhere it is not. A coordinate of exactly `0` *is* accepted — the
  equator and the prime meridian are ordinary places.
- **It will not read a date it does not recognise.** `Date.parse` would take `04/03/2026` and quietly mean
  3 April or 4 March depending on the reader. Only ISO-8601 is accepted; anything else is reported as
  unparseable.
- **It will not import half a file.** See below.

### Why a batch lands whole or not at all

If any row is rejected the response is `422` and **nothing is written**. A partial import is the outcome nobody
wants: the caller has to work out which half landed, and the half that landed is the half they did not look at.
`dry_run` exists so that can be discovered before it matters, and so an import into a system other people depend
on can be rehearsed.

### Duplicates are two different problems

An id appearing twice in the file is a mistake in the file. An id already in the store is an overwrite of a
record somebody else relies on. Both are reported, with different messages — calling them both "duplicate"
would hide the second. This covers *generated* ids too: a file with no `id` column still has its deterministic
id checked against the store, so re-importing the same file is refused rather than merged over the top.

Every attempt writes an `action_logs` entry, including failed and dry-run ones, with the batch fingerprint, the
row counts and the first 25 errors. The log action is `uploaded` or `upload_validated`.

### Collections

| Collection | Required | Optional |
|---|---|---|
| `service_assets` | `name`, `latitude`, `longitude` | `id`, `service_type`, `road_class`, `country`, `admin1`, `capacity`, `population_served` |
| `conflict_events` | `event_date` | `id`, `title`, `event_type`, `latitude`, `longitude`, `fatalities`, `actor1`, `admin1`, `country`, `description` |
| `hazard_events` | `event_type`, `occurred_at` | `id`, `title`, `severity`, `latitude`, `longitude`, `admin1`, `country`, `source` |
| `climate_observations` | `observed_at`, `metric`, `value` | `id`, `latitude`, `longitude`, `station_id`, `unit` |

`id` is optional in every collection — it is generated when absent — but a supplied one is checked, because a
duplicate silently overwrites.

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

Body: none. Takes no parameters.

Response:
```json
{ "success": true,
  "field_reports":           { "kept": 42, "expired": 7 },
  "rapidpro_inbound_messages": { "kept": 3,  "expired": 0 } }
```

Side effect: **deletes** the expired `field_reports`, `rapidpro_inbound_messages` and
`community_feedback` by id. This is the only hard delete in the API; see
[ADR-007](architecture/decisions/ADR-007-soft-delete.md).

Returns `400` when `retentionDays` is not a positive number, and deletes nothing. That refusal is
deliberate — a non-numeric window used to become `NaN`, and `age > NaN` is false for every record, so
the route expired nothing and reported `success: true` on every run.

`community_feedback` has its own window, `communityFeedbackDays` (180 by default, against
`retentionDays`' 365): a hazard report is an operational record and a community comment is a person
exercising the right to be heard. Set them equal if your deployment disagrees.

**This route is not the only thing that applies retention.** The periodic driver runs the same
expiry on its interval, and reports the per-collection counts on the heartbeat that
`GET /api/v1/ready` returns. A window applied only when somebody remembers to POST is a comment in
a JSON file.

---

## OGC Features

### `GET /ogc/collections/:id/items`

Auth: a token, like the rest of the API. An operator that wants an open catalogue adds `/ogc` to
`LINDELA_LITE_PUBLIC_PATHS`. Returns GeoJSON FeatureCollection for the specified collection id.

Each feature's `properties` carry every field of the record except the coordinates (which are the
geometry) and the fields that identify a person or a secret — `reporter_urn_hash`, `message`,
`phone`, `api_key` and their relatives, case-insensitively. The three collections published today
hold no personal data; the rule exists so that adding a fourth cannot publish a fifth by accident.

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

Auth: none required. Returns the quarterly KPI computation.

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

Response: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="lindela-kpi-<year>-<quarter>.pdf"`.

### `GET /api/v1/equity/by-district`

Auth: none required. Returns per-district accuracy metrics grouped from alert_events and rapidpro_dispatches.

Response: `{ success, data: EquityDistrict[] }` where each row includes `district`, `dispatched`, `acknowledged`, `false_positive`, `dispatch_precision_pct` (null when no dispatch in the district has an outcome yet; `accuracy_pct` is a deprecated alias), `determined_dispatched`, `data_gaps`, `alerts_by_severity`, and `data_gaps`.

### `GET /api/v1/equity/breaches`

Returns districts where `dispatch_precision_pct < threshold` AND the determined sample is large enough for the figure to mean something. A district with one resolved dispatch and a precision of 0% is below the threshold and below the sample floor; both conditions must hold, so a small district is not reported as a systematic failure.

Query: `threshold` (float, default 80).

Response: `{ success, data: [{ district, dispatch_precision_pct, accuracy_pct, determined_dispatched, dispatched }] }`

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

Body: `{ focal_point_approved: bool, workflow_instance_id?: string, trigger_value?: number, actor: string }`

The rule's trigger is evaluated against the platform's own state — the same
context alert rules see. `trigger_value` overrides it, for an operator quoting
an observation the store has not yet ingested; the response records
`trigger.source` as `supplied` or `context` so the two cannot be confused.

Returns HTTP 409 when `requires_focal_point_approval` is true and no approval
is presented, and when `workflow_instance_id` names an instance that does not
exist, is not a `parametric_disbursement` workflow, or has not reached
`focal_point_confirmed`.

Response: `{ success, data: { simulated: true, disbursement_id, chain, tx_hash, amount, currency, recipient_group_id, rule_id, status, trigger, focal_point_approval, simulated_at } }`

`status` is one of:

| Status | Meaning |
|---|---|
| `simulated` | the trigger was met; `amount` and `tx_hash` are populated |
| `trigger_not_met` | the trigger was evaluated and did not fire; `amount` and `tx_hash` are `null` |
| `trigger_not_evaluated` | the rule defines no trigger, or the metric did not resolve to a number; `amount` and `tx_hash` are `null` |

An unmet or unevaluable trigger reports `amount: null`, not `0`. Zero would
read as a measured payout of nothing; null says no payout was due. No
`tx_hash` is minted for an unpaid disbursement — a transaction for a payout
that is not owed is a hash of nothing.

`tx_hash` begins with `sim_` when present. No on-chain transaction is made.

`focal_point_approval` records where the approval came from:
`source: 'workflow'` with `verified: true` when a workflow instance backs it,
or `source: 'request_body'` with `verified: false` when it was asserted by the
same request that requested the disbursement. A compliance reader needs to see
which, so an assertion is never upgraded into a verification it did not get.

The disbursement is persisted to the `parametric_disbursements` collection.

### `GET /api/v1/parametric-disbursements`

List all simulated disbursements.

Response: `{ success, data: ParametricDisbursement[], count }`

---

## OpenAPI

The OpenAPI 3.1 contract is available at [openapi.yaml](openapi.yaml).
