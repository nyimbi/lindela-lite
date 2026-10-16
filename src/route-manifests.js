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
import { BITEMPORAL_COLLECTIONS } from './bitemporal.js'
import { COLLECTIONS } from './store.js'

export const ROUTE_MANIFESTS = Object.freeze({
  'DELETE /api/v1/annotations/:id': Object.freeze(["annotations"]),
  'DELETE /api/v1/federation/peers/:id': Object.freeze(["federation_peers", "action_logs"]),
  'DELETE /api/v1/parametric-rules/:id': Object.freeze(["parametric_rules"]),
  'GET /api/v1/action-logs': Object.freeze(["action_logs"]),
  'GET /api/v1/action-logs/:id': Object.freeze(["action_logs"]),
  'GET /api/v1/alert-events': Object.freeze(["alert_events"]),
  'GET /api/v1/alert-events/:id': Object.freeze(["alert_events"]),
  'GET /api/v1/alert-events/:id.cap': Object.freeze(["alert_events"]),
  // ENH-36. The Atom feed over the same alerts. Listed explicitly although the
  // runtime lookup normalises it onto the `:id` row anyway: the guard in
  // `test/route-manifests.test.js` reads the *spec* path, so an unlisted feed
  // reads as an unmeasured route and the table stops being a measurement.
  'GET /api/v1/alert-events/cap-feed': Object.freeze(["alert_events"]),
  // ENH-69. A ranking over the open alerts, but it also reads hazard_events and
  // service_assets: the expected-loss proxy is severity x exposure, and exposure
  // comes from the impact model's population-at-risk rows.
  'GET /api/v1/alert-events/triage': Object.freeze(["alert_events", "hazard_events", "service_assets"]),
  'GET /api/v1/alert-outcomes': Object.freeze(["alert_outcomes"]),
  // ENH-73. The decision interval, from the alerts and the determinations
  // filed against them.
  'GET /api/v1/alert-outcomes/decision-latency': Object.freeze(["alert_events", "alert_outcomes"]),
  'GET /api/v1/alert-outcomes/tally': Object.freeze(["alert_events", "alert_outcomes"]),
  'GET /api/v1/alert-rules': Object.freeze(["alert_rules"]),
  'GET /api/v1/alert-rules/:id': Object.freeze(["alert_rules"]),
  // ENH-74. Six routes over one collection. Every one of them reads only
  // `annotations`: the writes carry the record and its action log in a single
  // `emit` merge, and `emit`'s own `events_outbox` lookup happens inside
  // `withLock` on a locked read of that one collection, which is not the
  // request's read and cannot be narrowed by a manifest here. `record/:id` and
  // `:id/versions` are declared explicitly rather than left to their `:id`
  // sibling — the lookup is segment-exact, so neither is covered by it.
  'GET /api/v1/annotations': Object.freeze(["annotations"]),
  'GET /api/v1/annotations/:id/versions': Object.freeze(["annotations"]),
  'GET /api/v1/annotations/record/:id': Object.freeze(["annotations"]),
  'GET /api/v1/audit/head': Object.freeze(["action_logs"]),
  'GET /api/v1/audit/verify': Object.freeze(["action_logs"]),
  'GET /api/v1/calibration/by-region': Object.freeze(["region_trust"]),
  'GET /api/v1/climate': Object.freeze(["climate_observations"]),
  'GET /api/v1/community-feedback': Object.freeze(["community_feedback"]),
  'GET /api/v1/community-feedback/summary': Object.freeze(["community_feedback"]),
  // ENH-56. The joint score reads the two event collections and the hazard
  // table the two marginals already read; it writes only `risk_scores`.
  'GET /api/v1/compound-risk': Object.freeze(["risk_scores"]),
  'GET /api/v1/conflict-risk': Object.freeze(["risk_scores"]),
  'GET /api/v1/connectors': Object.freeze(["source_runs"]),
  'GET /api/v1/connectors/status': Object.freeze(["source_runs"]),
  // ENH-54. Two derived reads feed it and nothing else: the refused drift
  // verdicts and the freshness verdicts, which are computed from the source
  // runs. Naming a third collection here would claim a read the handler does
  // not make, and the manifest is what the access check trusts.
  'GET /api/v1/data-gaps': Object.freeze(["model_drift", "source_runs"]),
  'GET /api/v1/data-lineage': Object.freeze(["data_lineage"]),
  'GET /api/v1/data-quality': Object.freeze(["data_quality"]),
  // ENH-34. The index and one handle read only their own collection. The POST
  // is measured `null` and lives in WIDE_ROUTES below: it takes the collections
  // to snapshot from its body, so the set it reads is the caller's, and no
  // manifest can be narrower than the whole store without being wrong for a
  // caller who names one the manifest did not guess.
  'GET /api/v1/dataset-snapshots': Object.freeze(["dataset_snapshots"]),
  'GET /api/v1/dataset-snapshots/:id': Object.freeze(["dataset_snapshots"]),
  'GET /api/v1/disease-observations': Object.freeze(["disease_observations"]),
  'GET /api/v1/disease-observations/summary': Object.freeze(["disease_observations"]),
  // The collector cannot measure this one, so the entry is written from a direct
  // probe and the reason is recorded here. A district id is a *code constant*
  // (`resolveDistrict` looks it up in `KNOWN_DISTRICTS`), not a store record, so
  // the collector's `probe-id` 404s before the handler reads anything and the
  // route lands in the wide list by default. Measured with `?=turkana` it reads
  // 11 collections — `districtOverview` gathers every district-scoped surface —
  // which is under the wide threshold and is what is declared below.
  'GET /api/v1/districts/:id': Object.freeze(["alert_events", "community_feedback", "field_reports", "hazard_events", "incidents", "intervention_tasks", "interventions", "rapidpro_dispatches", "risk_scores", "service_assets", "workflow_instances"]),
  'GET /api/v1/equity/breaches': Object.freeze(["alert_events", "rapidpro_dispatches"]),
  'GET /api/v1/equity/by-district': Object.freeze(["alert_events", "rapidpro_dispatches"]),
  'GET /api/v1/events': Object.freeze(["conflict_events", "hazard_events"]),
  'GET /api/v1/explain/:id': Object.freeze(["data_lineage", "risk_scores", "source_runs"]),
  // ARC-01. The union of what the export family spans, not the nine this route
  // used to carry. `export.csv` had fourteen collections and `export.geojson`
  // nine, so the same store produced two exports of different sizes and neither
  // said which was the whole set. Both now spread `EXPORT_COLLECTIONS`
  // (`src/routes/exports.js`), which is the drift this closes.
  //
  // The five added here carry no coordinates in the demo data, so they
  // contribute no features — but they are read, and a manifest that omits a
  // collection the handler touches is the shape that reads `undefined` on
  // PostgreSQL. Exact, not wide.
  'GET /api/v1/export.geojson': Object.freeze(["alert_events", "conflict_events", "field_reports", "hazard_events", "impact_assessments", "incidents", "intervention_tasks", "interventions", "alert_rules", "rapidpro_dispatches", "rapidpro_inbound_messages", "response_resources", "risk_scores", "service_assets"]),
  // ENH-80. The registry routes and the operator's status read are narrow: the
  // registry, plus the heartbeat the status route reads for the last exchange.
  // The two *peer-facing* routes are not here — they serve every syncable
  // collection, which is a whole-store read by definition, and they are named in
  // WIDE_ROUTES below.
  'GET /api/v1/federation/peers': Object.freeze(["federation_peers"]),
  'GET /api/v1/federation/status': Object.freeze(["federation_peers", "system_heartbeat"]),
  'GET /api/v1/field-outcomes': Object.freeze(["field_outcomes"]),
  'GET /api/v1/field-outcomes/summary': Object.freeze(["field_outcomes", "alert_events"]),
  'GET /api/v1/field-reports': Object.freeze(["field_reports"]),
  'GET /api/v1/field-reports/:id': Object.freeze(["field_reports"]),
  // ENH-44. The quality roll-up reads only the collection whose verdicts it
  // counts — the verdict is stamped at write time, so nothing here joins out.
  'GET /api/v1/field-reports/quality': Object.freeze(["field_reports"]),
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
  'GET /api/v1/iot-observations': Object.freeze(["iot_observations"]),
  'GET /api/v1/kpi/monthly-series': Object.freeze(["alert_events", "field_reports", "interventions", "rapidpro_dispatches", "workflow_instances"]),
  'GET /api/v1/kpi/quarterly': Object.freeze(["alert_events", "field_outcomes", "field_reports", "hazard_events", "interventions", "rapidpro_dispatches", "report_templates", "workflow_instances"]),
  'GET /api/v1/kpi/snapshots': Object.freeze(["kpi_snapshots"]),
  'GET /api/v1/model-drift': Object.freeze(["model_drift"]),
  'GET /api/v1/operations/summary': Object.freeze(["field_reports", "incidents", "intervention_tasks", "interventions", "response_resources"]),
  'GET /api/v1/outbox': Object.freeze(["events_outbox"]),
  'GET /api/v1/parametric-disbursements': Object.freeze(["parametric_disbursements"]),
  'GET /api/v1/parametric-rules': Object.freeze(["parametric_rules"]),
  'GET /api/v1/parametric-rules/:id': Object.freeze(["parametric_rules"]),
  'GET /api/v1/protocol-executions': Object.freeze(["protocol_executions"]),
  'GET /api/v1/protocol-executions/summary': Object.freeze(["protocol_executions"]),
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
  'GET /api/v1/river-discharge': Object.freeze(["climate_observations"]),
  'GET /api/v1/road-access': Object.freeze(["road_access"]),
  'GET /api/v1/road-access/summary': Object.freeze(["road_access"]),
  'GET /api/v1/school-attendance': Object.freeze(["school_attendance_observations"]),
  'GET /api/v1/service-assets': Object.freeze(["service_assets"]),
  'GET /api/v1/service-assets/:id': Object.freeze(["service_assets"]),
  'GET /api/v1/service-impacts': Object.freeze(["impact_assessments"]),
  // ENH-09. The agreement check reads the observations and nothing else: both
  // products' series arrive as `climate_observations` records, told apart by
  // `source`, so there is no join out to a second collection.
  'GET /api/v1/source-agreement': Object.freeze(["climate_observations"]),
  'GET /api/v1/sources': Object.freeze(["connector_circuit", "ingestion_schedules", "source_runs"]),
  'GET /api/v1/tasks': Object.freeze(["intervention_tasks"]),
  'GET /api/v1/tasks/:id': Object.freeze(["intervention_tasks"]),
  'GET /api/v1/trigger-protocols': Object.freeze(["trigger_protocols"]),
  'GET /api/v1/trigger-protocols/:id': Object.freeze(["trigger_protocols"]),
  'GET /api/v1/watermarks': Object.freeze(["watermark_state"]),
  'GET /api/v1/weather': Object.freeze(["weather_forecasts"]),
  'GET /api/v1/webhooks': Object.freeze(["webhook_subscriptions"]),
  'GET /api/v1/webhooks/:id': Object.freeze(["webhook_subscriptions"]),
  'GET /api/v1/workflows': Object.freeze(["workflow_instances"]),
  'GET /api/v1/workflows/:id': Object.freeze(["workflow_instances"]),
  'GET /api/v1/workflows/metrics': Object.freeze(["workflow_instances"]),
  'GET /ogc/collections/:id/items': Object.freeze(["hazard_events", "conflict_events", "service_assets", "risk_scores"]),
  // The STAC and OGC catalogues. `STAC_READ_COLLECTIONS` is the manifest —
  // four collections, declared beside the collections it names in `src/stac.js`,
  // and identical for all four routes because they share one resolver. These
  // were absent from this table and from every other, and the reason is the
  // reason this file exists: `handleStacRoute` matched with an inline
  // `.match()` that `scripts/route-surface.mjs` could not read outside the
  // dispatcher, so the routes were not in the spec, not in this table, and not
  // in any check — while `check-openapi` reported a clean 176 documented, 176
  // served. They read four collections, so they belong here rather than in
  // WIDE_ROUTES.
  'GET /stac/collections/:id': Object.freeze(["hazard_events", "conflict_events", "service_assets", "risk_scores"]),
  'GET /stac/collections/:id/items': Object.freeze(["hazard_events", "conflict_events", "service_assets", "risk_scores"]),
  'GET /stac/collections/:id/items/:id': Object.freeze(["hazard_events", "conflict_events", "service_assets", "risk_scores"]),
  'PATCH /api/v1/annotations/:id': Object.freeze(["annotations"]),
  'POST /api/v1/annotations': Object.freeze(["annotations"]),
  'POST /api/v1/federation/peers': Object.freeze(["federation_peers", "action_logs"]),
  // ENH-57. The briefing narrows the report it was given; it reads the
  // report and nothing else, and the narrowing happens in memory.
  'POST /api/v1/reports/:id/briefings': Object.freeze(["reports"]),
  // The narrator reads the report's own generated sections and nothing else:
  // commentary audited against the record, not re-derived from the store.
  'POST /api/v1/reports/:id/narrate': Object.freeze(["reports"]),
})

/**
 * Routes left on the whole-store read, and why.
 *
 * Three groups, all deliberate:
 *
 *   - **Streaming.** `/api/v1/export.ndjson` does not use the dispatcher's read
 *     at all: it returns above it and walks a store cursor in batches, so it is
 *     not on the whole-store path. It is listed here because `collectionsForRequest`
 *     has to answer *something* for it, and the safe answer is `null` — if the
 *     route ever fell back to the dispatcher read, reading everything is
 *     recoverable and reading nothing is a silent empty export. It is not a
 *     manifest entry because its read is caller-chosen (`?collection=`) and a
 *     fixed list would be wrong for every caller but one.
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
  'GET /api/v1/basemap/tiles/carto/:id/:id/:id.png',
  // ADR-013. The raster basemap tile proxy reads no collection either — it
  // fetches one PNG from the tile upstream the deployment is configured with —
  // so there is no manifest to declare. Wide is the vocabulary's only word for
  // "not measured against a collection set".
  //
  // The difference from every other wide entry is that this one was *not*
  // declared while the route was live: it was written
  // `/<literal>/.exec(url.pathname)`, a spelling `scripts/route-surface.mjs`
  // did not read, so it appeared in no manifest and no document at once. Two
  // paths rather than one because the source is a literal alternation in the
  // route regex, `(osm|carto)`, and the table keys on the path a caller writes.
  'GET /api/v1/basemap/tiles/osm/:id/:id/:id.png',
  // HX-06. Without `view=summary` the list page fetched this and then one
  // `/districts/{id}` per card to fill four numbers and one line — 2,652 KB
  // measured through the live ingress for five districts, ~2.3 MB of it the
  // 30-row `alert_events` sample each overview embeds. `view=summary` returns
  // the same cards' fields and nothing else, and is the page's default. The
  // full overview is unchanged at `/districts/{id}`.
  'GET /api/v1/districts',
  'GET /api/v1/export.csv',
  'GET /api/v1/export.ndjson',
  'GET /api/v1/exports',
  // ENH-80. The peer-facing half of the federation family. All four are wide for
  // the same reason and it is not a fallback: `/exchange` and `/manifest` serve
  // every syncable collection, so their collection set *is* the syncable set —
  // a list of 55 names that goes stale the next time a collection is added.
  // `/merge` writes whatever the payload names, narrowed at the handler by
  // `acceptablePayload` rather than by a manifest. `/sync` drives an exchange in
  // both directions over the same set. The registry routes beside them are
  // narrow and are in `ROUTE_MANIFESTS` above; the two halves really are
  // different routes with different collection sets.
  'GET /api/v1/federation/exchange',
  'GET /api/v1/federation/exchange/manifest',
  'GET /api/v1/flood-depth',
  'GET /api/v1/flood-probability/score',
  // CAP-01. Reading the form catalogue and one version, and publishing a new
  // version. The catalogue reads nothing from the store but the published
  // definitions; publishing writes them, so it is declared with its collection.
  'GET /api/v1/forms',
  'GET /api/v1/forms/:id',
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
  'GET /api/v1/taxonomy',
  // ENH-42. The offline tile-pack pair reads no collection at all — the plan
  // route is arithmetic over a bbox and the pack route fetches from the tile
  // server the deployment is configured with — so there is no manifest to
  // declare and an empty one is what `test/route-manifests.test.js` rejects.
  // Wide is the vocabulary's only word for "not measured against a collection
  // set", the same word `GET /api/v1/health` uses for the same reason, and the
  // dispatcher runs both *above* the store read (`src/server.js`, ENH-42 block),
  // so the whole-store read this declaration would otherwise imply never
  // happens.
  'GET /api/v1/tile-packs',
  'GET /api/v1/tile-packs/plan',
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
  // ENH-52. Wide, and it has to be. The compute family's measured closure is
  // `alert_rules` and `data_quality` — what `handleAlertEvaluation` reads — and
  // the collector reads that closure off the *route module's* source, so a
  // handler that delegates to an imported model (`planPrepositioning`,
  // `evaluateTriggerSet`) contributes nothing to it. A manifest written from
  // that closure would hand this route a store with no `service_assets` and no
  // `hazard_events`, and the allocator would answer every plan from an empty
  // road network — a confident plan over a network it never saw. Wide is the
  // safe direction and it is also the honest one: the set is the model's, not
  // the route's.
  'POST /api/v1/anticipatory/evaluate',
  // ENH-68. The collection is chosen by the question — `runQuery` reads
  // `data[subject.collection]` where the subject comes from the parse, and the
  // subjects span risk scores, flood models, population, alerts, dispatches,
  // region trust and hazard events. A static manifest cannot be narrower than
  // that union without lying about a subject it omits, so this is the honest
  // entry rather than a measured one that would be wrong for six questions in
  // seven.
  'POST /api/v1/ask',
  'POST /api/v1/chw/reply',
  'POST /api/v1/chw/report',
  'POST /api/v1/community-feedback',
  'POST /api/v1/dataset-snapshots',
  'POST /api/v1/demo/seed',
  'POST /api/v1/equity/scan',
  'POST /api/v1/export/dhis2',
  'POST /api/v1/federation/exchange/merge',
  'POST /api/v1/federation/sync',
  'POST /api/v1/field-reports',
  'POST /api/v1/flood-probability/train',
  'POST /api/v1/forms',
  'POST /api/v1/incidents',
  'POST /api/v1/ingest/run',
  'POST /api/v1/ingest/run-due',
  'POST /api/v1/ingest/schedules',
  'POST /api/v1/ingest/schedules/:id/run',
  'POST /api/v1/ingest/schedules/defaults',
  'POST /api/v1/interventions',
  'POST /api/v1/iot-observations',
  'POST /api/v1/kpi/refresh-snapshots',
  'POST /api/v1/maintenance/apply-retention',
  // ENH-76. `capture-run` reads the whole store to snapshot a run, and
  // `replay-run` reads nothing at all — its subject is the document in its body,
  // re-derived through the production engine against a captured store adapter.
  // Both are wide for the reason `scenario-comparisons` is: a manifest cannot say
  // "reads everything" or "reads nothing" without being the shape of a mistake.
  'POST /api/v1/maintenance/capture-run',
  'POST /api/v1/maintenance/replay-run',
  'POST /api/v1/outbox/dispatch',
  'POST /api/v1/parametric-rules',
  'POST /api/v1/parametric-rules/:id/simulate',
  // ENH-53. Reads `service_assets` and `hazard_events` through
  // `computeRoadAccess`, which is three calls deep from this handler. Same
  // reasoning as above.
  'POST /api/v1/prepositioning/plan',
  'POST /api/v1/rapidpro/alert-events/:id/send',
  'POST /api/v1/rapidpro/field-report',
  'POST /api/v1/rapidpro/reply',
  'POST /api/v1/rapidpro/response-metrics',
  'POST /api/v1/report-distributions/:id/retry',
  'POST /api/v1/report-schedule-runs/:id/retry',
  'POST /api/v1/report-schedules',
  'POST /api/v1/report-schedules/:id/run',
  'POST /api/v1/report-schedules/run-due',
  'POST /api/v1/report-templates',
  'POST /api/v1/report-templates/:id/copy',
  'POST /api/v1/reports',
  'POST /api/v1/reports/:id/approve',
  'POST /api/v1/reports/:id/distribute',
  'POST /api/v1/reports/:id/generate',
  'POST /api/v1/response-resources',
  'POST /api/v1/routing/plan',
  // ENH-55. Reads nothing and writes nothing — a pure function of its body — and
  // is wide rather than declared empty, because `ROUTE_MANIFESTS` has no way to
  // say "reads nothing" without also being the shape of a mistake: an empty
  // manifest hands the handler a store with no collections in it, and
  // `test/route-manifests.test.js` refuses one for exactly that reason.
  'POST /api/v1/scenario-comparisons',
  'POST /api/v1/scenarios',
  'POST /api/v1/school-attendance',
  'POST /api/v1/service-assets',
  'POST /api/v1/tasks',
  'POST /api/v1/trigger-protocols/:id/backtest',
  'POST /api/v1/trigger-protocols/:id/shadow-run',
  'POST /api/v1/trigger-protocols/run',
  'POST /api/v1/upload',
  'POST /api/v1/webhooks',
  'POST /api/v1/workflows/:id/transition',
  'POST /api/v1/workflows/metrics',
])
/** How much of the API is still on the whole-store read, as one number. */
export const UNMAPPED_COUNT = WIDE_ROUTES.length

/**
 * The routes that read bitemporal history, and so must ask for it.
 *
 * ENH-08 keeps `record_versions` off the default read path — 60% of a real
 * store by bytes, and no request paid for it unless it asked. These routes are
 * the ones that ask: `/history/:collection` and `/history/:collection/record`
 * both hand their snapshot to `series.js`, which reads `snapshot.record_versions`
 * and returns nothing without it.
 *
 * The two are in `WIDE_ROUTES` — they were measured as whole-store readers —
 * and a whole-store read is `includeHistory: false` like every other. That
 * combination is what made the history feature work on a JSON dev box and
 * return empty on Postgres: `JsonStore` ignored the flag (ARC-10) while
 * `PostgresStore` honoured it. With the adapters agreeing, a route that needs
 * history has to say so, and this is where it says it.
 *
 * Keyed on the path with the collection blanked, the same way `ROUTE_MANIFESTS`
 * is, so it is a property of the route and not of the record.
 */
const HISTORY_ROUTES = new Set([
  'GET /api/v1/history/:id',
  'GET /api/v1/history/:id/record',
])

/** True when this request's handler reads `record_versions` and needs it loaded. */
export function needsHistory(method, pathname) {
  const bare = String(pathname || '')
    .replace(/\/api\/v1\/([^/]+)\/[^/]+(?=\/|$)/, '/api/v1/$1/:id')
  return HISTORY_ROUTES.has(`${String(method || 'GET').toUpperCase()} ${bare}`)
}

/**
 * ENH-12, the read half — the record scope for one request, or `null`.
 *
 * `/history/:collection/record` asks about *one record*, and answered it by
 * reading the whole store: the two history routes resolve to a `null` manifest,
 * so the read was every declared collection with history on — 50,111 rows on the
 * demo store, of which 34,058 are version rows — and `versionsFor` then filtered
 * them in JavaScript. Measured, the route transferred 34,058× the rows it needed
 * to answer about a record with one revision.
 *
 * The scope is resolved here rather than as a `collectionsForRequest` manifest
 * for two reasons, and the second is the one that decided it:
 *
 *   - a manifest names *collections*, and this narrows to a row. `record_versions`
 *     is one physical collection holding every record's history, so no collection
 *     list can express "this record's revisions";
 *   - a non-null manifest would move the route off `WIDE_QUERY_BUDGET` onto the
 *     narrow default of 25,000 rows, and `food_security_records` with its history
 *     is 29,325 rows on the demo store — so a manifest-shaped fix would turn a
 *     working request into a 503. The scope narrows the read without touching
 *     which budget it is metered against.
 *
 * The collection comes from the path and the record from `?id=`, the same way
 * `EXPLAIN_KEY` reads its collection from `?kind=`: the answer is a property of
 * the request, not of the path. A missing `?id=` is left unscoped rather than
 * guessed at, and the handler answers its own 400 — this function's job is the
 * read, not the validation.
 */
export function recordScopeForRequest(method, pathname, search = null) {
  if (String(method || 'GET').toUpperCase() !== 'GET') return null
  const match = String(pathname || '').match(/^\/api\/v1\/history\/([^/]+)\/record$/)
  if (!match) return null
  const collection = decodeURIComponent(match[1])
  // Only a collection that can have history is worth scoping to: a nonsense name
  // would otherwise reach the store and be refused by `assertDeclaredCollection`
  // inside the read, turning the handler's honest 404 into a 500.
  if (!PROJECTABLE.has(collection)) return null
  const recordId = typeof search?.get === 'function' ? search.get('id') : null
  return { collection, recordId: recordId || null }
}

/** The collections whose records carry a revision history, per `bitemporal.js`. */
const PROJECTABLE = new Set(BITEMPORAL_COLLECTIONS)

const EXPLAIN_KEY = 'GET /api/v1/explain/:id'

/**
 * The manifest for one request, or `null` for "read everything".
 *
 * Keyed on the path with any id segment blanked, because a manifest is a
 * property of the route and not of the record. The method is part of the key
 * because several write routes read the audit log their GET sibling does not.
 *
 * `search` (the URLSearchParams of the request) is consulted by exactly one
 * key: explain. Its handler resolves whatever collection `?kind=` names, so
 * the read is caller-chosen rather than a property of the route. The measured
 * entry above covers the default kind — and it carries `source_runs`, because
 * the handler looks the record's source run up there, and the measured
 * manifest omitted it: a risk score naming a source run had its run dropped
 * to null by the narrow read, and the provenance panel would have reported
 * provenance as "none found" that the store actually held. A caller-selected
 * kind that names a real collection is read alongside the same two provenance
 * lookups; a kind that does not falls back to the measured entry and the
 * handler's 404, which for a nonsense or misspelled kind is the honest miss.
 *
 * Matching is segment-wise, and it has to be. This used to blank the first two
 * segments after `/api/v1/` with a single regex — `incidents/123` becoming
 * `incidents/:id` — which is right for a collection followed by a record and
 * wrong for everything else in the table. Three ways it was wrong, all of them
 * answering `null`, which is the whole-store read this table exists to replace:
 *
 *   - a *fixed* second segment is not an id. `calibration/by-region`,
 *     `audit/head`, `kpi/quarterly`, `ingest/status`, `rapidpro/escalations` —
 *     27 entries were shadowed by their own `:id` sibling the moment the
 *     rewrite ran first.
 *   - a deeper id is not the second segment. `/api/v1/ingest/schedules/:id`
 *     puts its record one level further down, so `schedules/abc` rewrote to
 *     `schedules/:id/abc`, matched nothing, and read the store.
 *   - a suffix on the id is not a separate segment. `:id.cap` is a wildcard
 *     *within* a segment, and a blanking rewrite cannot express it.
 *
 * So the pattern is matched segment by segment: `:name` matches any one
 * segment, `:name.suffix` matches any segment ending in `.suffix`. Where more
 * than one pattern matches, the one with the fewest wildcards wins, so a
 * literal route always beats a wildcard sibling. This is the same shape the
 * spec's own paths take, which is what makes it checkable: the drift gate
 * drives every documented route through this function and compares the answer
 * against what the handler touched.
 *
 * The shadowing was invisible while a whole-store read cost only bandwidth and
 * became visible the moment ENH-67 metered one — the budget charged
 * `GET /api/v1/calibration/by-region` for every collection it enumerated, and
 * the gate reported 64 undeclared reads on a route that reads `region_trust`.
 */
export function collectionsForRequest(method, pathname, search = null) {
  const key = matchRouteKey(method, pathname)
  if (key === null) return null
  if (WIDE_ROUTES.includes(key)) return null
  if (key === EXPLAIN_KEY) {
    const kind = typeof search?.get === 'function' ? search.get('kind') : null
    if (kind && COLLECTIONS.includes(kind)) {
      return [kind, 'source_runs', 'data_lineage']
    }
  }
  return ROUTE_MANIFESTS[key] || null
}

/**
 * The one key a request names, or `null` when the table has never seen it.
 *
 * A literal key wins outright. Otherwise every pattern for the method is
 * matched and the most specific is taken: fewest wildcards first, then the
 * wildcard that constrains more of its segment. The tiebreak is not decorative
 * — `GET /api/v1/alert-events/probe-id.cap` matches both `:id` and `:id.cap`
 * with one wildcard each, and the two entries name the same collection, so the
 * wrong winner is harmless *today*. It is resolved by specificity rather than
 * left to the iteration order of an object literal, because the next pair of
 * siblings to collide need not agree.
 */
export function matchRouteKey(method, pathname) {
  const verb = String(method || 'GET').toUpperCase()
  const segments = String(pathname || '').split('/').filter(Boolean)
  const literal = `${verb} /${segments.join('/')}`
  if (ROUTE_MANIFESTS[literal] || WIDE_ROUTES.includes(literal)) return literal
  let best = null
  let bestScore = null
  for (const key of patternsFor(verb)) {
    const score = matchesRouteKey(key, segments)
    if (score === null) continue
    if (bestScore === null || score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = key
      bestScore = score
    }
  }
  return best
}

/** `[wildcards, constrainedChars]` when `key` matches `segments`, else `null`. */
function matchesRouteKey(key, segments) {
  const pattern = key.slice(key.indexOf(' ') + 1).split('/').filter(Boolean)
  if (pattern.length !== segments.length) return null
  let wildcards = 0
  let constrained = 0
  for (let i = 0; i < pattern.length; i += 1) {
    const part = pattern[i]
    if (part === segments[i]) continue
    const wild = /^:([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(part)
    // A literal segment that does not match is a miss. A wildcard matches its
    // segment, and a wildcard with a suffix — `:id.cap` — must also end in it.
    if (!wild) return null
    if (wild[2] && !segments[i].endsWith(wild[2])) return null
    wildcards += 1
    constrained += wild[2].length
  }
  return [wildcards, constrained]
}

const PATTERNS_BY_VERB = new Map()
function patternsFor(verb) {
  let patterns = PATTERNS_BY_VERB.get(verb)
  if (!patterns) {
    patterns = [...Object.keys(ROUTE_MANIFESTS), ...WIDE_ROUTES].filter((key) => key.startsWith(`${verb} `))
    PATTERNS_BY_VERB.set(verb, patterns)
  }
  return patterns
}
