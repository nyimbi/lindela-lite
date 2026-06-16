# Lindela Lite Data Model

This guide describes the main collections, relationships, common fields, and record lifecycle conventions used by Lindela Lite.

## Store Shape

Lindela Lite stores data as named collections. JSON mode writes the collections to one JSON file. PostgreSQL mode stores each record as JSONB in `lite_records`.

Every collection is an array of records. Records are upserted by `id` through the store merge layer.

## Common Fields

Most records use these fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable record identifier. |
| `source` | Data origin or subsystem. |
| `status` | Lifecycle status where applicable. |
| `created_at` | Record creation timestamp. |
| `updated_at` | Last update timestamp. |
| `metadata` | Extra structured details that do not need first-class fields. |

Spatial records usually include:

| Field | Meaning |
| --- | --- |
| `country` | Country code or country label from source data. |
| `admin1` | First-level administrative area when available. |
| `latitude` | Decimal latitude. |
| `longitude` | Decimal longitude. |

Filtering supports common fields such as `country`, `source`, `status`, `priority`, `severity`, `incident_id`, `intervention_id`, `service_type`, `from`, `to`, `bbox`, and `limit`.

## Collection Reference

### `source_runs`

One record per source ingestion attempt.

Important fields:

- `source`
- `status`: `success`, `degraded`, or `failed`
- `run_type`: `manual` or `scheduled`
- `schedule_id`
- `started_at`
- `completed_at`
- `records_processed`
- `records_by_collection`
- `errors`
- `diagnostics`

Use `source_runs` to answer:

- Which source was last run?
- Did the source fail, degrade, or succeed?
- How many records were produced?
- Were retries used?
- Which schedule triggered the run?

### `ingestion_schedules`

Regular ingestion schedules for public or configured sources.

Important fields:

- `source`
- `status`: `active`, `paused`, or `archived`
- `interval_minutes`
- `timeout_ms`
- `retries`
- `stale_after_minutes`
- `next_run_at`
- `last_run_at`
- `default_options`

Schedulers call `POST /api/v1/ingest/run-due`. The app updates `last_run_at` and `next_run_at` after each due run.

### `climate_observations`

Weather, rainfall, and climate records.

Typical sources:

- `open_meteo`
- `chirps`

Important fields:

- `type`
- `region_name`
- `observed_at`
- `precipitation_mm`
- `precipitation_probability_pct`
- `temperature_c`
- `humidity_pct`

### `hazard_events`

Disaster, flood, fire, and hazard records.

Typical sources:

- `gdacs`
- `glofas`
- `nasa_firms`

Important fields:

- `event_type`
- `severity`
- `title`
- `description`
- `occurred_at`
- `source_id`

### `conflict_events`

User-supplied conflict records from `conflict_csv` or `acled_csv`.

Important fields:

- `event_type`
- `sub_event_type`
- `severity`
- `title`
- `occurred_at`
- `fatalities`
- `actor1`
- `actor2`
- `metadata.license`

`acled_csv` requires `acled_license_accepted=true` and user-supplied licensed data. Lite does not bundle ACLED data.

### `service_assets`

Facilities or infrastructure that may be exposed to climate, conflict, or hazard risk.

Important fields:

- `name`
- `service_type`
- `status`
- `country`
- `admin1`
- `latitude`
- `longitude`
- `capacity`

Accepted service types are defined in `src/schema.js`.

### `risk_scores`

Derived flood and climate-conflict risk signals.

Important fields:

- `type`: `flood_risk` or `climate_conflict_risk`
- `region_name`
- `score`
- `risk_level`
- `confidence`
- `drivers`
- `methodology`
- `generated_at`

Risk scores are decision-support signals. They are not automated determinations.

### `impact_assessments`

Derived service-delivery impact assessments.

Important fields:

- `asset_id`
- `asset_name`
- `service_type`
- `impact_score`
- `impact_level`
- `confidence`
- `drivers`
- `risk_score_ids`

### `data_quality`

Source freshness, confidence, and coverage summaries.

Important fields:

- `source`
- `confidence`
- `freshness`
- `total_records`
- `geocode_coverage_pct`
- `error_count`
- `last_run_at`

Reports include warnings when data quality is stale or low confidence.

### `incidents`

Operational situations that need monitoring or response.

Important fields:

- `incident_type`
- `title`
- `description`
- `status`
- `severity`
- `priority`
- `owner`
- `linked_event_id`
- `risk_score_id`
- `service_asset_ids`

Incidents can be created manually, linked to event/risk context, or created as holding incidents for RapidPro field reports.

### `interventions`

Response plans linked to incidents.

Important fields:

- `incident_id`
- `title`
- `objective`
- `status`
- `priority`
- `lead_org`
- `partners`
- `service_asset_ids`
- `start_at`
- `target_end_at`
- `completed_at`
- `success_metrics`
- `outcome_summary`

### `intervention_tasks`

Assigned work under interventions.

Important fields:

- `intervention_id`
- `incident_id`
- `title`
- `description`
- `status`
- `priority`
- `owner`
- `due_at`
- `completed_at`
- `action_type`
- `linked_asset_id`

### `field_reports`

Updates from operators or RapidPro inbound messages.

Important fields:

- `incident_id`
- `intervention_id`
- `summary`
- `reported_by`
- `observed_at`
- `needs`
- `impact`
- `latitude`
- `longitude`

### `response_resources`

Deployable teams, supplies, equipment, or capacity.

Important fields:

- `name`
- `resource_type`
- `status`
- `quantity`
- `unit`
- `country`
- `location_name`
- `assigned_intervention_id`

### `action_logs`

Audit records for mutating actions.

Important fields:

- `collection`
- `record_id`
- `action`
- `actor`
- `created_at`
- `summary`
- `metadata`

Action logs are read-only through the API.

### `alert_rules`

Lightweight rule definitions evaluated against current platform context.

Important fields:

- `name`
- `metric`
- `operator`
- `threshold`
- `severity`
- `status`
- `actions`

Supported metrics include values exposed by operations summaries and data-quality context.

### `alert_events`

Alert outputs produced by rule evaluation.

Important fields:

- `rule_id`
- `rule_name`
- `severity`
- `status`
- `message`
- `metric`
- `value`
- `threshold`
- `operator`
- `actions`

Alert events can be sent through RapidPro.

### `rapidpro_dispatches`

Outbound RapidPro attempts for alert events or report summaries.

Important fields:

- `alert_event_id`
- `report_id`
- `mode`
- `message`
- `recipients`
- `request`
- `response_status`
- `response_body`
- `status`
- `error`

Failed requests are retained for follow-up and troubleshooting.

### `rapidpro_inbound_messages`

Raw inbound RapidPro webhook records.

Important fields:

- `provider`
- `source_id`
- `direction`
- `from`
- `contact_uuid`
- `contact_name`
- `text`
- `status`
- `payload`
- `field_report_id`
- `incident_id`
- `intervention_id`

### `report_templates`

Reusable report definitions.

Important fields:

- `name`
- `report_type`
- `status`
- `version`
- `title_pattern`
- `default_filters`
- `sections`
- `distribution_defaults`
- `schedule_defaults`
- `owner`

Templates can be copied into a new version-1 template.

### `reports`

Generated report instances.

Important fields:

- `template_id`
- `report_type`
- `status`
- `title`
- `scope`
- `section_ids`
- `sections`
- `source_refs`
- `warnings`
- `distribution_defaults`
- `generated_at`
- `approved_at`
- `distributed_at`

Approved and distributed reports are immutable except archival.

### `report_distribution_runs`

One record per report distribution attempt.

Important fields:

- `report_id`
- `template_id`
- `channel`
- `recipients`
- `status`
- `payload_summary`
- `response_status`
- `response_body`
- `error`
- `retry_of`
- `options`

### `report_schedules`

Recurring report jobs.

Important fields:

- `template_id`
- `status`
- `timezone`
- `recurrence`
- `auto_distribute`
- `distribution_defaults`
- `next_run_at`
- `last_run_at`
- `owner`

Schedulers call `POST /api/v1/report-schedules/run-due`.

### `report_schedule_runs`

History of report schedule executions.

Important fields:

- `schedule_id`
- `report_id`
- `status`
- `started_at`
- `completed_at`
- `error`

Failed schedule runs are retained and can be retried.

## Relationships

Core relationships:

```text
source_runs -> normalized source collections
normalized source collections -> analytics
risk_scores/service_assets -> impact_assessments
events/risk_scores -> incidents
incidents -> interventions
interventions -> intervention_tasks
incidents/interventions -> field_reports
interventions -> response_resources
alert_rules -> alert_events
alert_events -> rapidpro_dispatches
rapidpro_inbound_messages -> field_reports
report_templates -> reports
reports -> report_distribution_runs
report_schedules -> report_schedule_runs -> reports
```

## ID Behavior

IDs are generated with stable hashes from meaningful record inputs. If the same source record is ingested again with the same identifying fields, it should upsert rather than duplicate.

When creating records through the API, callers may provide explicit `id` values. This is useful for integrations that already have a stable external id.

## Timestamp Ordering

The store sorts merged records by available operational timestamps:

1. `updated_at`
2. `completed_at`
3. `generated_at`
4. `observed_at`
5. `occurred_at`
6. `created_at`
7. `started_at`

This ordering matters for source health, dashboard display, and latest-record selection.

