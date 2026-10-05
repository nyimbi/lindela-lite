/**
 * ENH-07 — which collections each route reads.
 *
 * The store could already take a collection manifest and had no caller for it,
 * so every request materialised the whole store before the first route test: 143
 * MB to serve a page of incidents, measured. The mechanism existed and the
 * benefit did not.
 *
 * These lists are **measured, not derived from reading handlers**.
 * `scripts/collect-route-manifests.mjs` drives every documented route against a
 * real server with the read instrumented, seeds a record under the probe id so
 * the by-id branch is measured rather than its 404, and prints what each route
 * touched. Re-run it after adding a route or moving a handler's data access, and
 * diff the result against this file.
 *
 * Two properties this table has to have, and the second is the dangerous one:
 *
 * 1. A manifest too wide is a missed optimisation: annoying, visible, harmless.
 * 2. A manifest too narrow reads `undefined` in a handler and returns a 500.
 *    So the failures run towards the old cost and not towards an outage: an
 *    unrecognised route resolves to `null` — a whole-store read, which is
 *    today's behaviour — and `WIDE_ROUTES` below is where a route measured as
 *    genuinely wide is recorded rather than quietly omitted.
 *
 * `test/route-manifests.test.js` walks the route table and asserts every kind is
 * either mapped here or explicitly wide, so a new route cannot arrive unmapped
 * and silently expensive.
 */
export const ROUTE_MANIFESTS = Object.freeze({
  'DELETE /api/v1/parametric-rules/:id': Object.freeze(["parametric_rules"]),
  'GET /api/v1/action-logs': Object.freeze(["action_logs"]),
  'GET /api/v1/action-logs/:id': Object.freeze(["action_logs"]),
  'GET /api/v1/alert-events': Object.freeze(["alert_events"]),
  'GET /api/v1/alert-events/:id': Object.freeze(["alert_events"]),
  'GET /api/v1/alert-events/:id.cap': Object.freeze(["alert_events"]),
  'GET /api/v1/alert-outcomes': Object.freeze(["alert_outcomes"]),
  'GET /api/v1/alert-outcomes/tally': Object.freeze(["alert_events", "alert_outcomes"]),
  'GET /api/v1/alert-rules': Object.freeze(["alert_rules"]),
  'GET /api/v1/alert-rules/:id': Object.freeze(["alert_rules"]),
  'GET /api/v1/audit/head': Object.freeze(["action_logs"]),
  'GET /api/v1/audit/verify': Object.freeze(["action_logs"]),
  'GET /api/v1/calibration/by-region': Object.freeze(["region_trust"]),
  'GET /api/v1/climate': Object.freeze(["climate_observations"]),
  'GET /api/v1/community-feedback': Object.freeze(["community_feedback"]),
  'GET /api/v1/community-feedback/summary': Object.freeze(["community_feedback"]),
  'GET /api/v1/conflict-risk': Object.freeze(["risk_scores"]),
  'GET /api/v1/connectors': Object.freeze(["source_runs"]),
  'GET /api/v1/data-lineage': Object.freeze(["data_lineage"]),
  'GET /api/v1/data-quality': Object.freeze(["data_quality"]),
  'GET /api/v1/disease-observations': Object.freeze(["disease_observations"]),
  'GET /api/v1/disease-observations/summary': Object.freeze(["disease_observations"]),
  'GET /api/v1/equity/breaches': Object.freeze(["alert_events", "rapidpro_dispatches"]),
  'GET /api/v1/equity/by-district': Object.freeze(["alert_events", "rapidpro_dispatches"]),
  'GET /api/v1/events': Object.freeze(["conflict_events", "hazard_events"]),
  'GET /api/v1/explain/:id': Object.freeze(["data_lineage", "risk_scores"]),
  'GET /api/v1/export.geojson': Object.freeze(["alert_events", "conflict_events", "field_reports", "hazard_events", "impact_assessments", "incidents", "response_resources", "risk_scores", "service_assets"]),
  'GET /api/v1/field-reports': Object.freeze(["field_reports"]),
  'GET /api/v1/field-reports/:id': Object.freeze(["field_reports"]),
  'GET /api/v1/flood-probability/models': Object.freeze(["flood_probability_models"]),
  'GET /api/v1/flood-risk': Object.freeze(["risk_scores"]),
  'GET /api/v1/food-security': Object.freeze(["food_security_records"]),
  'GET /api/v1/food-security/summary': Object.freeze(["food_security_records"]),
  'GET /api/v1/impact/facilities-at-risk': Object.freeze(["facilities_at_risk"]),
  'GET /api/v1/impact/population-at-risk': Object.freeze(["population_at_risk"]),
  'GET /api/v1/incidents': Object.freeze(["incidents"]),
  'GET /api/v1/incidents/:id': Object.freeze(["incidents"]),
  'GET /api/v1/ingest/schedules': Object.freeze(["ingestion_schedules"]),
  'GET /api/v1/ingest/schedules/:id': Object.freeze(["ingestion_schedules"]),
  'GET /api/v1/ingest/status': Object.freeze(["connector_circuit", "ingestion_schedules", "source_runs"]),
  'GET /api/v1/interventions': Object.freeze(["interventions"]),
  'GET /api/v1/interventions/:id': Object.freeze(["interventions"]),
  'GET /api/v1/kpi/monthly-series': Object.freeze(["alert_events", "field_reports", "interventions", "rapidpro_dispatches", "workflow_instances"]),
  'GET /api/v1/kpi/quarterly': Object.freeze(["alert_events", "field_reports", "hazard_events", "interventions", "rapidpro_dispatches", "report_templates", "workflow_instances"]),
  'GET /api/v1/kpi/snapshots': Object.freeze(["kpi_snapshots"]),
  'GET /api/v1/model-drift': Object.freeze(["model_drift"]),
  'GET /api/v1/operations/summary': Object.freeze(["field_reports", "incidents", "intervention_tasks", "interventions", "response_resources"]),
  'GET /api/v1/outbox': Object.freeze(["events_outbox"]),
  'GET /api/v1/parametric-disbursements': Object.freeze(["parametric_disbursements"]),
  'GET /api/v1/parametric-rules': Object.freeze(["parametric_rules"]),
  'GET /api/v1/rapidpro/escalations': Object.freeze(["rapidpro_dispatches", "rapidpro_inbound_messages"]),
  'GET /api/v1/rapidpro/inbound': Object.freeze(["rapidpro_inbound_messages"]),
  'GET /api/v1/rapidpro/response-metrics': Object.freeze(["rapidpro_dispatches", "rapidpro_inbound_messages"]),
  'GET /api/v1/ready': Object.freeze(["action_logs", "events_outbox"]),
  'GET /api/v1/report-distributions': Object.freeze(["report_distribution_runs"]),
  'GET /api/v1/report-distributions/:id': Object.freeze(["report_distribution_runs"]),
  'GET /api/v1/report-schedule-runs': Object.freeze(["report_schedule_runs"]),
  'GET /api/v1/report-schedule-runs/:id': Object.freeze(["report_schedule_runs"]),
  'GET /api/v1/report-schedules': Object.freeze(["report_schedules"]),
  'GET /api/v1/report-schedules/:id': Object.freeze(["report_schedules"]),
  'GET /api/v1/report-templates': Object.freeze(["report_templates"]),
  'GET /api/v1/report-templates/:id': Object.freeze(["report_templates"]),
  'GET /api/v1/reports': Object.freeze(["reports"]),
  'GET /api/v1/reports/:id': Object.freeze(["reports"]),
  'GET /api/v1/reports/:id/export.json': Object.freeze(["reports"]),
  'GET /api/v1/reports/:id/export.md': Object.freeze(["reports"]),
  'GET /api/v1/response-resources': Object.freeze(["response_resources"]),
  'GET /api/v1/response-resources/:id': Object.freeze(["response_resources"]),
  'GET /api/v1/road-access': Object.freeze(["road_access"]),
  'GET /api/v1/road-access/summary': Object.freeze(["road_access"]),
  'GET /api/v1/service-assets': Object.freeze(["service_assets"]),
  'GET /api/v1/service-assets/:id': Object.freeze(["service_assets"]),
  'GET /api/v1/service-impacts': Object.freeze(["impact_assessments"]),
  'GET /api/v1/sources': Object.freeze(["connector_circuit", "ingestion_schedules", "source_runs"]),
  'GET /api/v1/tasks': Object.freeze(["intervention_tasks"]),
  'GET /api/v1/tasks/:id': Object.freeze(["intervention_tasks"]),
  'GET /api/v1/trigger-protocols': Object.freeze(["trigger_protocols"]),
  'GET /api/v1/trigger-protocols/:id': Object.freeze(["trigger_protocols"]),
  'GET /api/v1/watermarks': Object.freeze(["watermark_state"]),
  'GET /api/v1/webhooks': Object.freeze(["webhook_subscriptions"]),
  'GET /api/v1/workflows': Object.freeze(["workflow_instances"]),
  'GET /api/v1/workflows/metrics': Object.freeze(["workflow_instances"]),
  'GET /api/v1/workflows/:id': Object.freeze(["workflow_instances"]),
})

/**
 * Routes left on the whole-store read, and why.
 *
 * Two groups, both deliberate and both measured:
 *
 *   - **Wide.** Reading more than twelve collections: the export, rollup and
 *     health surfaces, which genuinely are that wide. A manifest of most of the
 *     store is not a manifest.
 *   - **Untrusted.** The measurement could not be trusted, which is a different
 *     claim from "not measured". A write route is only trusted when a named
 *     handler family closed over the source: without one, the probe is the only
 *     measurement, and a probe of a body-validating handler is refused before it
 *     reads — so its manifest would describe the *rejection* path. That is how
 *     `POST /api/v1/reports` was once narrowed to the two collections its
 *     validation failure touched, and thirteen tests failed on the first real
 *     request.
 *
 * `test/route-manifests.test.js` asserts every documented route is in one of the
 * two lists, and re-drives the measured ones to check they read nothing outside
 * their manifest.
 */
export const WIDE_ROUTES = Object.freeze([
  'DELETE /api/v1/action-logs/:id',
  'GET /api/v1/alert-outcomes/reasons',
  'GET /api/v1/assessments',
  'GET /api/v1/auth-info',
  'GET /api/v1/districts',
  'GET /api/v1/export.csv',
  'GET /api/v1/flood-depth',
  'GET /api/v1/flood-probability/score',
  'GET /api/v1/health',
  'GET /api/v1/history/:id',
  'GET /api/v1/history/:id/record',
  'GET /api/v1/kpi/quarterly.md',
  'GET /api/v1/kpi/quarterly.pdf',
  'GET /api/v1/kpi/quarterly/coverage',
  'GET /api/v1/metrics',
  'GET /api/v1/rapidpro/delivery',
  'GET /api/v1/rapidpro/dispatches',
  'GET /api/v1/rapidpro/status',
  'GET /api/v1/reports/:id/export.csv',
  'GET /api/v1/reports/:id/export.geojson',
  'GET /api/v1/scenarios/:id',
  'GET /api/v1/upload',
  'GET /stac/catalog.json',
  'PATCH /api/v1/action-logs/:id',
  'PATCH /api/v1/alert-events/:id',
  'PATCH /api/v1/alert-rules/:id',
  'PATCH /api/v1/field-reports/:id',
  'PATCH /api/v1/incidents/:id',
  'PATCH /api/v1/ingest/schedules/:id',
  'PATCH /api/v1/interventions/:id',
  'PATCH /api/v1/parametric-rules/:id',
  'PATCH /api/v1/report-schedules/:id',
  'PATCH /api/v1/report-templates/:id',
  'PATCH /api/v1/reports/:id',
  'PATCH /api/v1/response-resources/:id',
  'PATCH /api/v1/tasks/:id',
  'PATCH /api/v1/webhooks/:id',
  'POST /api/v1/alert-events/:id/approve',
  'POST /api/v1/alert-events/:id/outcome',
  'POST /api/v1/alert-events/:id/reject',
  'POST /api/v1/alert-rules',
  'POST /api/v1/alerts/evaluate',
  'POST /api/v1/analytics/bias-correct',
  'POST /api/v1/chw/reply',
  'POST /api/v1/chw/report',
  'POST /api/v1/community-feedback',
  'POST /api/v1/demo/seed',
  'POST /api/v1/equity/scan',
  'POST /api/v1/field-reports',
  'POST /api/v1/flood-probability/train',
  'POST /api/v1/incidents',
  'POST /api/v1/ingest/run',
  'POST /api/v1/ingest/run-due',
  'POST /api/v1/ingest/schedules',
  'POST /api/v1/ingest/schedules/defaults',
  'POST /api/v1/ingest/schedules/:id/run',
  'POST /api/v1/interventions',
  'POST /api/v1/kpi/refresh-snapshots',
  'POST /api/v1/maintenance/apply-retention',
  'POST /api/v1/outbox/dispatch',
  'POST /api/v1/parametric-rules',
  'POST /api/v1/parametric-rules/:id/simulate',
  'POST /api/v1/rapidpro/alert-events/:id/send',
  'POST /api/v1/rapidpro/field-report',
  'POST /api/v1/rapidpro/reply',
  'POST /api/v1/rapidpro/response-metrics',
  'POST /api/v1/report-distributions/:id/retry',
  'POST /api/v1/report-schedule-runs/:id/retry',
  'POST /api/v1/report-schedules',
  'POST /api/v1/report-schedules/run-due',
  'POST /api/v1/report-schedules/:id/run',
  'POST /api/v1/report-templates',
  'POST /api/v1/report-templates/:id/copy',
  'POST /api/v1/reports',
  'POST /api/v1/reports/:id/approve',
  'POST /api/v1/reports/:id/distribute',
  'POST /api/v1/reports/:id/generate',
  'POST /api/v1/response-resources',
  'POST /api/v1/routing/plan',
  'POST /api/v1/scenarios',
  'POST /api/v1/service-assets',
  'POST /api/v1/tasks',
  'POST /api/v1/trigger-protocols/:id/backtest',
  'POST /api/v1/trigger-protocols/:id/shadow-run',
  'POST /api/v1/upload',
  'POST /api/v1/webhooks',
  'POST /api/v1/workflows/metrics',
  'POST /api/v1/workflows/:id/transition',
])
/** How much of the API is still on the whole-store read, as one number. */
export const UNMAPPED_COUNT = WIDE_ROUTES.length

/**
 * The manifest for one request, or `null` for "read everything".
 *
 * Keyed on the path with any id segment blanked, because a manifest is a
 * property of the route and not of the record. The method is part of the key
 * because several write routes read the audit log their GET sibling does not.
 */
export function collectionsForRequest(method, pathname) {
  const bare = String(pathname || '')
    .replace(/\/api\/v1\/([^/]+)\/[^/]+(?=\/|$)/, '/api/v1/$1/:id')
  const key = `${String(method || 'GET').toUpperCase()} ${bare}`
  if (WIDE_ROUTES.includes(key)) return null
  return ROUTE_MANIFESTS[key] || null
}
