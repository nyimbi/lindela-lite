# Lindela Lite Architecture

This guide describes how Lindela Lite is assembled internally: runtime boundaries, modules, data flow, storage, scheduling, API routing, dashboard serving, and integration points.

## System Shape

Lindela Lite is a single Node.js service with no frontend build step. The service exposes:

- A JSON/CSV/GeoJSON API under `/api/v1/*`.
- Static dashboard assets from `public/`.
- Markdown documentation from `docs/`.
- Optional PostgreSQL-backed persistence.
- Optional RapidPro outbound and inbound SMS workflows.

The default runtime keeps the platform simple:

```text
operator/browser
  -> dashboard static assets
  -> /api/v1/*
      -> route handler
      -> domain module
      -> store
      -> JSON file, pg0, or external PostgreSQL
```

The one-click deployment runs the same app container with PostgreSQL and a scheduler sidecar. The scheduler is intentionally outside the app process and calls due-run endpoints over HTTP.

## Runtime Modules

| Module | Responsibility |
| --- | --- |
| `src/server.js` | HTTP server, auth gate, API routing, static/dashboard/docs serving, request orchestration. |
| `src/schema.js` | Source ids, public catalog, enum values, default regions, empty store shape. |
| `src/storage.js` | Chooses JSON, pg0, or external PostgreSQL from environment. |
| `src/store.js` | JSON-file store and collection merge behavior. |
| `src/postgres-store.js` | Generic JSONB store for pg0/external PostgreSQL. |
| `src/ingestion.js` | Source registry, ingestion runs, retries, schedules, source health. |
| `src/connectors/*` | Public and user-supplied data connectors. |
| `src/analytics.js` | Flood risk, climate-conflict risk, service impact, data quality. |
| `src/operations.js` | Incidents, interventions, tasks, field reports, resources, action logs. |
| `src/alerts.js` | Alert rules and alert event evaluation. |
| `src/rapidpro.js` | RapidPro config, outbound messages, inbound field-report parsing. |
| `src/reports.js` | Templates, generated reports, exports, distribution runs, schedules. |
| `src/utils.js` | Shared ID, CSV, GeoJSON, filtering, response helpers. |

## Request Lifecycle

1. `createServer()` receives the HTTP request.
2. Raw path traversal is rejected before URL normalization.
3. `/api/v1/*` requests enter `handleApi()`.
4. If `LINDELA_LITE_API_KEY` is configured, mutating API requests must send `x-api-key`.
5. RapidPro inbound field-report webhooks may authenticate with `RAPIDPRO_WEBHOOK_SECRET` instead of the general API key.
6. The store is read once for the request.
7. The route handler validates and normalizes input through the relevant domain module.
8. Writes are persisted through `store.merge()` or `store.write()`.
9. The response is returned as JSON, CSV, GeoJSON, Markdown, or static content.

## API Routing Boundaries

The server keeps route matching explicit and dependency-free:

- Ingestion routes are matched by `matchIngestionRoute()`.
- Reporting routes are matched by `matchReportingRoute()`.
- RapidPro routes are matched by `matchRapidProRoute()`.
- Alert and operational record routes are matched by collection maps.

This keeps routing readable but means new endpoint families should be added carefully:

1. Add route matching.
2. Add handler branch.
3. Add OpenAPI entry.
4. Add API docs.
5. Add tests.
6. Add validation-script checks if the endpoint is part of the public surface.

## Storage Boundary

Lindela Lite stores records in named collections. The store interface is intentionally small:

- `read()` returns the full store shape.
- `write(data)` replaces the store.
- `merge(partial)` upserts records by `id` into known collections.
- `replaceAnalytics({ risk_scores, impact_assessments, data_quality })` replaces derived analytics.

JSON mode writes one local file. PostgreSQL mode stores records in one generic JSONB table:

```text
lite_records(collection text, id text, body jsonb, updated_at timestamptz)
```

This avoids migrations for every Lite data shape change. The tradeoff is that querying is mostly application-side rather than SQL-native.

## Data Flow

### Ingestion To Analytics

```text
POST /api/v1/ingest/run
  -> runIngestion()
  -> connector.ingest()
  -> source_runs + raw normalized records
  -> refreshAnalytics()
  -> risk_scores + impact_assessments + data_quality
```

Connectors return records grouped by collection:

- `climate_observations`
- `hazard_events`
- `conflict_events`
- `service_assets`

Ingestion runs always write a `source_runs` record with status, attempts, retry configuration, timeout, record counts, errors, and diagnostics.

### Operations To Reports

```text
incidents/interventions/tasks/field_reports/resources
  -> action_logs
  -> operations summary
  -> alert evaluation
  -> report generation
  -> export/distribution
```

Reports are deterministic. They do not call an LLM or hidden service; they summarize records already in the store and attach source references.

### Alert To RapidPro

```text
alert rule
  -> POST /api/v1/alerts/evaluate
  -> alert event
  -> POST /api/v1/rapidpro/alert-events/:id/send
  -> rapidpro_dispatches
```

RapidPro failures are captured as dispatch records rather than disappearing into logs.

### RapidPro To Field Report

```text
RapidPro flow webhook
  -> POST /api/v1/rapidpro/field-report
  -> rapidpro_inbound_messages
  -> field_reports
  -> optional holding incident
```

If a message does not include an incident or intervention id, Lite creates a holding incident so the field report remains actionable.

## Scheduling Model

Lite does not run hidden in-process background jobs. Scheduling is represented as data and executed by explicit HTTP calls:

- `POST /api/v1/ingest/run-due`
- `POST /api/v1/report-schedules/run-due`

The one-click stack runs a scheduler sidecar that calls those endpoints on an interval. Other deployments can use cron, systemd timers, Kubernetes CronJobs, GitHub Actions, or another scheduler.

This design keeps retries, failures, auth, and logs visible through the same API surface used by operators.

## Authentication Model

Authentication is intentionally small:

- Without `LINDELA_LITE_API_KEY`, local/demo mode allows API mutations.
- With `LINDELA_LITE_API_KEY`, non-GET API requests require `x-api-key`.
- RapidPro inbound field-report webhooks can use `RAPIDPRO_WEBHOOK_SECRET`.
- The dashboard stores the API key in browser local storage and sends it as `x-api-key` for mutating actions.

Lite does not provide multi-user identity, RBAC, SSO, or per-record authorization. Put it behind a reverse proxy or platform gateway when those controls are needed.

## Static And Docs Serving

The dashboard is served from `public/`. Documentation is served from `docs/` under `/docs/*`.

Path traversal is rejected before URL normalization and file access is constrained to the expected root. Unknown non-API routes fall back to the dashboard shell for operator convenience.

## Extension Points

Common safe extension points:

- Add a connector under `src/connectors/`.
- Add source metadata in `src/schema.js`.
- Add analytics in `src/analytics.js`.
- Add report sections in `src/reports.js`.
- Add dashboard panels in `public/index.html` and `public/app.js`.
- Add OpenAPI/docs/tests for every new public behavior.

Avoid adding:

- Hidden background timers inside the app process.
- Proprietary or undistributable data dependencies.
- New external services without clear fallback behavior.
- Auth assumptions that bypass `LINDELA_LITE_API_KEY` outside explicitly scoped integrations.

## Reliability Principles

- Every ingestion attempt records `source_runs`.
- Every operational mutation writes `action_logs`.
- Report and RapidPro distribution attempts are persisted even on failure.
- Derived analytics can be regenerated from stored normalized records.
- Scheduler failures should advance or record state rather than spin silently.
- Tests should cover both success and failure paths for any new public endpoint.

