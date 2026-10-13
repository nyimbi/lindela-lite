/**
 * The dispatch table. One entry per route family, in the order the dispatcher
 * tries them.
 *
 * This is the single declaration ENH-59 asks for at the dispatch layer, and it
 * replaces the thirty-two hand-written `match`/`handle` blocks that were that
 * same declaration written out as statements. The table records six facts about
 * a family, and each one was previously a property of a code block that only a
 * reader could check:
 *
 *   - `match` — the matcher, a pure function of the path (and, for `method`
 *     entries, the verb).
 *   - `handle` — the handler it is bound to. A matcher wired to the wrong
 *     handler, with the same dependency shape, used to pass every check.
 *   - `deps` — the context keys the handler is handed, by name. `dispatchFamily`
 *     picks exactly these from the dispatcher's scope, so the key set is a fact
 *     about the family rather than about the call site.
 *   - `method` — whether the matcher takes the verb. Some routes take whatever
 *     method arrives (`/api/v1/road-access`), and calling their matcher with one
 *     would change what they match.
 *   - `pre` — which side of `store.read(readRequest)` the family sits on. This is
 *     a correctness property, not tidiness: `/ready` must not materialise the
 *     store, `export.ndjson` streams (SCL-01's budget), and the two tile families
 *     read no collection at all. A family that drifts across the line either
 *     materialises a store it does not need or loses the one read it had.
 *   - `awaits` — whether the handler is asynchronous. Three families'
 *     handlers are synchronous (`auth-info`, `events`, `ambient`) and were called
 *     without `await`; the flag keeps that exact, rather than converting a sync
 *     return into a resolved promise on the request path.
 *
 * Two entries share one matcher: `matchCatalogueRoute` is dispatched at two
 * points, split by the `when` guard on its `kind`, because `connectors/status`
 * sat far below its two siblings and the order the dispatcher tries its routes
 * in had to stay unchanged. That is the one case the table cannot express as a
 * single entry, and the `when` predicate is how it is expressed instead.
 *
 * The order is load-bearing and is checked against a frozen recording in
 * `test/dispatch-order.test.js` — not against this file, which would assert
 * nothing. Adding a family is now one entry here; the test's recorded order is
 * the expectation it is checked against, and a reorder is a failure with the
 * diff named rather than a silent change no one sees.
 */

import { matchLivenessRoute, handleLivenessRoute } from './routes/liveness.js'
import { matchExportRoute, handleExportRoute } from './routes/exports.js'
import { matchTilePackRoute, handleTilePackRoute } from './routes/tile-packs.js'
import { matchTileRoute, handleTileRoute } from './routes/basemap-tiles.js'
import { matchKpiRoute, handleKpiRoute } from './routes/kpi.js'
import { matchFieldSignalRoute, handleFieldSignalRoute } from './routes/field-signals.js'
import { matchExposureRoute, handleExposureRoute } from './routes/exposure.js'
import { matchDerivedRoute, handleDerivedRoute } from './routes/derived.js'
import { matchSnapshotRoute, handleSnapshotRoute } from './routes/snapshots.js'
import { matchAuthInfoRoute, handleAuthInfoRoute } from './routes/auth-info.js'
import { matchCatalogueRoute, handleCatalogueRoute } from './routes/catalogue.js'
import { matchWebhookRoute, handleWebhookRoute } from './routes/webhooks.js'
import { matchFederationRoute, handleFederationRoute } from './routes/federation.js'
import { matchOutboxRoute, handleOutboxRoute } from './routes/outbox.js'
import { matchUploadRoute, handleUploadRoute } from './routes/upload.js'
import { matchScenarioRoute, handleScenarioRoute } from './routes/scenarios.js'
import { matchIngestionRoute, handleIngestionRoute } from './routes/ingestion.js'
import { matchFormsRoute, handleFormsRoute } from './routes/forms.js'
import { matchMaintenanceRoute, handleMaintenanceRoute } from './routes/maintenance.js'
import { matchEventsRoute, handleEventsRoute } from './routes/events.js'
import { matchAmbientRoute, handleAmbientRoute } from './routes/ambient.js'
import { matchRiskRoute, handleRiskRoute } from './routes/risk.js'
import { matchComputeRoute, handleComputeRoute } from './routes/compute.js'
import { matchRapidProRoute, handleRapidProRoute } from './routes/rapidpro.js'
import { matchProvenanceRoute, handleProvenanceRoute } from './routes/provenance.js'
import { matchReportingRoute, handleReportingRoute } from './routes/reporting.js'
import { matchAlertingRoute, handleAlertingRoute } from './routes/alerting.js'
import { matchParametricRoute, handleParametricRoute } from './routes/parametric.js'
import { matchOperationalRoute, handleOperationalRoute } from './routes/operational.js'
import { matchChwRoute, handleChwRoute } from './routes/chw.js'
import { matchWorkflowRoute, handleWorkflowRoute } from './routes/workflows.js'
import { matchDistrictRoute, handleDistrictRoute } from './routes/districts.js'

export const ROUTE_FAMILIES = Object.freeze([
  // `/health` ("is this process running") and `/ready` ("can it serve a request
  // right now"). Above the read because `/ready` probes the store with one
  // *scoped* read and must not materialise it; `/health` is handed the read as
  // the `loadData` thunk and calls it only for the one route that needs it.
  {
    match: matchLivenessRoute,
    handle: handleLivenessRoute,
    pre: true,
    deps: ['appVersion', 'driverIntervalSeconds', 'idempotency', 'jsonResponse', 'loadData', 'pipelineIsHealthy', 'req', 'res', 'store', 'url', 'withTimeout'],
  },
  // The export family, above the read because `export.ndjson` walks the store
  // with `iterateRecords` so its peak heap is one batch. Placed after the read,
  // the one route built for the store that does not fit in memory 503s at
  // SCL-01's read-row budget before its first byte.
  {
    match: matchExportRoute,
    handle: handleExportRoute,
    pre: true,
    method: true,
    deps: ['jsonResponse', 'loadData', 'req', 'res', 'store', 'url', 'vintageIndex'],
  },
  // The offline tile-pack family. Above the read because neither route reads the
  // store: the plan route is arithmetic over a bbox, and the pack route fetches
  // from the tile server the deployment is configured with.
  {
    match: matchTilePackRoute,
    handle: handleTilePackRoute,
    pre: true,
    method: true,
    deps: ['jsonResponse', 'req', 'res', 'url'],
  },
  // The raster basemap tile proxy (ADR-013). Above the read because it reads no
  // collection — it sat below it for as long as it existed, so every pan of the
  // map materialised the whole store to answer a request that reads none of it.
  {
    match: matchTileRoute,
    handle: handleTileRoute,
    pre: true,
    method: true,
    deps: ['jsonResponse', 'req', 'res', 'url'],
  },
  // The KPI family. Below the read because these are ordinary reads.
  {
    match: matchKpiRoute,
    handle: handleKpiRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'requestRing', 'res', 'store', 'url'],
  },
  // The field-signal family.
  {
    match: matchFieldSignalRoute,
    handle: handleFieldSignalRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The exposure family: nine reads over seven paths whose roll-ups must
  // describe the matched set rather than the page. The matcher takes the method
  // so a wrong verb falls through to the 404 rather than answering 200.
  {
    match: matchExposureRoute,
    handle: handleExposureRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'url'],
  },
  // The derived-collection reads: five reads over what `refreshAnalytics`
  // recomputes, three carrying a refusal that travels beside the figure.
  {
    match: matchDerivedRoute,
    handle: handleDerivedRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'url'],
  },
  // Citable dataset snapshots (ENH-34): a snapshot is a read frozen — it takes
  // the same materialised store and stores a copy of what a vintage identifies.
  {
    match: matchSnapshotRoute,
    handle: handleSnapshotRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The auth-info family: one path answered from two places (here and the 401
  // path above), now one handler called at both points. Synchronous.
  {
    match: matchAuthInfoRoute,
    handle: handleAuthInfoRoute,
    method: true,
    awaits: false,
    deps: ['auth', 'jsonResponse', 'res'],
  },
  // The first catalogue route: the source list and the connector registry.
  // `connectors/status` is split off to the second entry below, where its block
  // sat, so the order the dispatcher tries its routes in is unchanged.
  {
    match: matchCatalogueRoute,
    handle: handleCatalogueRoute,
    method: true,
    when: (route) => route.kind !== 'connectors-status',
    deps: ['data', 'jsonResponse', 'req', 'res', 'url'],
  },
  // The webhook-subscription family.
  {
    match: matchWebhookRoute,
    handle: handleWebhookRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The federation family (ENH-80). Below the read because every route in it
  // reads a collection; the one route that writes takes the read as its snapshot
  // rather than re-reading.
  {
    match: matchFederationRoute,
    handle: handleFederationRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The outbox family: the queue's own listing and the operator's "deliver it
  // now".
  {
    match: matchOutboxRoute,
    handle: handleOutboxRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The upload family: the column contract a client reads before it sends
  // anything, and the one validator all three content types converge on.
  {
    match: matchUploadRoute,
    handle: handleUploadRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The scenario family.
  {
    match: matchScenarioRoute,
    handle: handleScenarioRoute,
    deps: ['data', 'jsonResponse', 'req', 'res'],
  },
  // The ingestion family. `evaluateAndPersistAlerts` is passed in: it is the
  // driver's own entry point and lives in `server.js`, so the module takes it as
  // a dependency rather than importing back into `server.js`.
  {
    match: matchIngestionRoute,
    handle: handleIngestionRoute,
    deps: ['data', 'evaluateAndPersistAlerts', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The taxonomy-and-forms family: the vocabulary a client renders and the form
  // definitions it validates against.
  {
    match: matchFormsRoute,
    handle: handleFormsRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The operator-maintenance family: the retention sweep an operator triggers by
  // hand, and the demo seed. They are one family because `src/auth.js` already
  // treats them as one — both prefixes resolve to `admin:maintenance`. Below the
  // read, where the retention block was: the seed reads and writes the whole
  // store, and it sat below the read for the reason the export family sat above
  // it — opposite cases, both deliberate.
  {
    match: matchMaintenanceRoute,
    handle: handleMaintenanceRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'readRequestJson', 'req', 'res', 'store', 'url', 'withTimeout'],
  },
  // The events-and-assessments family: `/api/v1/events` is the merged
  // hazard-and-conflict list, and `/api/v1/assessments` publishes that same list
  // as `recent_events` beside the risk roll-ups. Synchronous.
  {
    match: matchEventsRoute,
    handle: handleEventsRoute,
    method: true,
    awaits: false,
    deps: ['data', 'jsonResponse', 'req', 'res', 'url'],
  },
  // The ambient-layer family: the raw observation series, the per-district
  // weather roll-up and the latest modelled discharge per region. Synchronous.
  {
    match: matchAmbientRoute,
    handle: handleAmbientRoute,
    method: true,
    awaits: false,
    deps: ['data', 'jsonResponse', 'req', 'res', 'url'],
  },
  // The hazard-risk family: the two marginal rankings, the joint compound score,
  // the model listing, the fit and the score.
  {
    match: matchRiskRoute,
    handle: handleRiskRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The compute family: the four routes that run a model over the request's own
  // arguments, including route planning, which needs a POST body and so is
  // matched with the verb.
  {
    match: matchComputeRoute,
    handle: handleComputeRoute,
    method: true,
    deps: ['data', 'evaluateAndPersistAlerts', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The RapidPro family.
  {
    match: matchRapidProRoute,
    handle: handleRapidProRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The provenance reads: where a record came from, what the platform believed
  // over time, what its own chain shows, and how far each source has been read.
  {
    match: matchProvenanceRoute,
    handle: handleProvenanceRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'url'],
  },
  // The reporting family. `checkWebhookUrl` is passed in rather than defaulted,
  // so the SSRF guard the deployment configured is the one the distribution path
  // uses.
  {
    match: matchReportingRoute,
    handle: handleReportingRoute,
    method: true,
    deps: ['checkWebhookUrl', 'data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The alerting family: rules, events, determinations, triage, the CAP feed,
  // and the trigger protocols whose executions record one firing.
  {
    match: matchAlertingRoute,
    handle: handleAlertingRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The third catalogue route. `connectors/status` sits here rather than with
  // its two siblings above because this is where its block was.
  {
    match: matchCatalogueRoute,
    handle: handleCatalogueRoute,
    method: true,
    when: (route) => route.kind === 'connectors-status',
    deps: ['data', 'jsonResponse', 'req', 'res', 'url'],
  },
  // The parametric family.
  {
    match: matchParametricRoute,
    handle: handleParametricRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store'],
  },
  // The operational family.
  {
    match: matchOperationalRoute,
    handle: handleOperationalRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The CHW family.
  {
    match: matchChwRoute,
    handle: handleChwRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store'],
  },
  // The workflow family.
  {
    match: matchWorkflowRoute,
    handle: handleWorkflowRoute,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
  // The district-and-equity family.
  {
    match: matchDistrictRoute,
    handle: handleDistrictRoute,
    method: true,
    deps: ['data', 'jsonResponse', 'req', 'res', 'store', 'url'],
  },
])

/**
 * Try one family. Returns true when it handled the request.
 *
 * The matcher is called with the verb only when the entry says it takes one, and
 * the handler is awaited only when the entry says it is asynchronous — both are
 * properties of the family, not of this loop, so a family that gains a verb
 * guard or loses its `async` changes one line of the table rather than the shape
 * of a call site.
 */
export async function dispatchFamily(family, ctx) {
  const route = family.method
    ? family.match(ctx.url.pathname, ctx.req.method)
    : family.match(ctx.url.pathname)
  if (!route) return false
  if (family.when && !family.when(route)) return false
  const deps = {}
  for (const key of family.deps) deps[key] = ctx[key]
  const handled = family.awaits === false
    ? family.handle(route, deps)
    : await family.handle(route, deps)
  return Boolean(handled)
}
