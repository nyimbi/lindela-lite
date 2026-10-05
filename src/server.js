import http from 'node:http'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticate, requireScope, scopeForRoute, isAuthConfigured, isPublicPath, publicPaths } from './auth.js'
import { logger, metrics, timer } from './observability.js'
import { refreshAnalytics, calibrationReport } from './analytics.js'
import { biasCorrectClimate } from './analytics/downscaling.js'
import { evaluateAlertRules, normalizeAlertRule, updateAlertEvent, approveAlertEvent, normalizeTriggerProtocol, backtestTriggerProtocol, evaluateInShadowMode } from './alerts.js'
import {
  defaultIngestionSchedules,
  ingestionStatus,
  normalizeIngestionSchedule,
  runDueIngestionSchedules,
  runIngestion,
} from './ingestion.js'
import { actionLog, buildCreate, buildSoftDelete, buildUpdate, counts, isDeleted, operationalSummary } from './operations.js'
import { parseRapidProFieldReport, rapidProStatus, responseMetrics, sendRapidProAlert, sendRapidProReportSummary, verifyRapidProWebhook, parseRapidProReply, reconcileInbound, deliveryReport, dueEscalations, formatDeliveryReport } from './rapidpro.js'
import { chainEntries, verifyChain, renderAuditProof } from './audit-chain.js'
import { renderExportMarkdown } from './reports.js'
import {
  approveReport,
  buildExportNarrative,
  computeNextRunAt,
  formatReportSmsSummary,
  generateReportSections,
  markReportDistributed,
  normalizeDistributionRun,
  normalizeReport,
  normalizeReportSchedule,
  normalizeReportTemplate,
  normalizeScheduleRun,
  recordsForReportSources,
  renderReportMarkdown,
  scheduleIsDue,
  updateReport,
} from './reports.js'
import { publicSourceCatalog } from './schema.js'
import { createStoreFromEnv } from './storage.js'
import { collectionPage, createIdempotencyStore, filterRecords, jsonResponse, readRawBody, readRequestJson, runWithRequestContext, toCsv, toGeoJson, stableId } from './utils.js'
import { redactPii, applyRetention, loadPolicy, retentionWindowDays } from './pii.js'
import { parseMultipart, validateUpload, UPLOAD_COLLECTIONS } from './upload.js'
import { stacCatalog, stacCollection, stacItem, ogcFeatureCollection, resolveStacCollection } from './stac.js'
import { renderCapXml } from './cap.js'
import { emit, dispatchPending, outboxRollup } from './outbox.js'
import { summarizeRoadAccess } from './road-access.js'
import { summarizeFoodSecurity } from './connectors/ipc-hdx.js'
import { summarizeDiseaseObservations } from './connectors/who-gho.js'
import { planDelivery } from './routing.js'
import { depthGrid, depthProfile, terrainContext } from './flood-depth.js'
import { trainDistrictModels, predict } from './flood-probability.js'
import { normalizeWebhookSubscription } from './webhooks.js'
import { computeQuarterlyKpi, computeMonthlyKpiSeries, refreshKpiSnapshots, quarterlyPdfSections } from './kpi.js'
import { KNOWN_DISTRICTS, districtOverview } from './districts.js'
import { equityByDistrict, detectAccuracyBreaches, createEquityAuditWorkflows } from './equity.js'
import { normalizeCommunityFeedback, feedbackSummaryByAlert } from './community.js'
import { renderQuarterlyReportPdf, quarterlyReportCoverage, DASHBOARD_SECTIONS } from './pdf.js'
import { runScenario, encodeScenarioUrl, decodeScenarioUrl } from './scenarios.js'
import { normalizeParametricRule, simulateDisbursement } from './parametric.js'
import { screenNames } from './sanctions.js'
import { normalizeWorkflowInstance, transitionWorkflow, workflowMetrics } from './workflows.js'
import { recordRequestOutcome } from './observability.js'
import { auditRollup } from './audit-chain.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(__dirname, '../public')
const docsDir = path.resolve(__dirname, '../docs')
const registryPath = path.resolve(__dirname, '../connectors.registry.json')
let defaultStorePromise
let connectorRegistry = null

/** The released version, read once so it cannot drift from package.json. */
export const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return pkg.version
  } catch (error) {
    // A wrong version is worse than a missing one: it invites a field team to
    // file a report against a build that does not exist.
    throw new Error(`cannot read version from package.json: ${error.message}`)
  }
})()

/**
 * The periodic work, in the process that has the store.
 *
 * This replaces a `while true; do curl … || true; done` shell loop in
 * docker-compose.yml that called two of the system's periodic items. Three
 * things were wrong with it, and each is a way for a humanitarian deployment to
 * stop working without anyone noticing:
 *
 *  1. `|| true` makes a 401 from a rotated key, a 500 from a dead store and
 *     "nothing was due" indistinguishable, and nothing collects the loop's
 *     stdout.
 *  2. It called only ingestion and report schedules — not alert evaluation, not
 *     outbox dispatch, not retention. A threshold crossing produced a risk score
 *     and nothing else.
 *  3. A shell loop cannot log with the logger, cannot record per-item outcomes,
 *     and cannot be observed. There was no way to ask whether it had run.
 *
 * Each item now runs here, records its own outcome, and a failure in one cannot
 * stop the others. The heartbeat is what `/health` reads, which is what makes
 * "the pipeline is dead" a red endpoint rather than a silence.
 *
 * ADR-009 moved *scheduling* to a sidecar because in-process timers were
 * rejected. This is not that reversal: the sidecar still decides *when* (it
 * POSTs `/ingest/run-due`); this owns *what else that tick must include*, which
 * the sidecar cannot know about without duplicating this list.
 */
const DRIVER_ITEMS = [
  { id: 'ingestion', label: 'ingestion schedules', run: (store, data) => runDueIngestionSchedules(store, data) },
  { id: 'alerts', label: 'alert evaluation', run: (store, data) => evaluateAndPersistAlerts(store, data) },
  { id: 'outbox', label: 'outbox dispatch', run: (store) => dispatchPending(store) },
  // The sidecar's second job, taken over with it. Report schedules were the one
  // periodic item the driver did not run, which is why the shell loop had a
  // reason to exist; with this in place it does not, and the loop's `|| true`
  // — which made a 401, a 500 and "nothing was due" one indistinguishable line
  // of stdout — goes with it.
  { id: 'reports', label: 'report schedules', run: (store, data) => runDueReportSchedulesAndPersist(store, data) },
]

/** The report-schedule cycle, with its writes persisted. Exported for tests. */
export async function runDueReportSchedulesAndPersist(store, data, { actor = 'periodic-driver' } = {}) {
  const result = await runDueReportSchedules(data, actor)
  await store.merge(result.writes)
  return result
}

let _driverTimer = null
let _driverInFlight = false

/** Run every periodic item once and record the outcome. Exported for tests. */
export async function runPeriodicTick(store, { at = new Date().toISOString() } = {}) {
  const results = []
  for (const item of DRIVER_ITEMS) {
    const started = Date.now()
    try {
      const data = await store.read()
      const value = await item.run(store, data)
      results.push({ id: item.id, label: item.label, ok: true, ms: Date.now() - started, summary: summarise(item.id, value) })
    } catch (error) {
      // One item failing must not stop the rest: a dead webhook registry should
      // not also stop ingestion, and a bad schedule should not stop retention.
      results.push({ id: item.id, label: item.label, ok: false, ms: Date.now() - started, error: String(error?.message || error) })
      console.error(`periodic: ${item.id} failed`, error)
    }
  }
  const succeeded = results.filter((r) => r.ok).length
  const heartbeat = {
    id: 'system_heartbeat',
    type: 'system_heartbeat',
    at,
    interval_seconds: driverIntervalSeconds(),
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    items: results,
  }
  try {
    await store.merge({ system_heartbeat: [heartbeat] })
  } catch (error) {
    // The heartbeat is how a dead pipeline is noticed. Failing to write it is
    // the one failure worth shouting about, because nothing else will say so.
    console.error('periodic: could not record the heartbeat', error)
  }
  return heartbeat
}

/** A short, checkable summary. Not the payload — an operator reads this. */
function summarise(id, value) {
  if (!value) return null
  if (id === 'alerts') return { raised: value.raised?.length ?? 0, updated: value.updated?.length ?? 0 }
  if (id === 'outbox') return { sent: Number(value) || 0 }
  if (id === 'ingestion') return { ran: value?.source_runs?.length ?? 0 }
  if (id === 'reports') return { ran: value?.runs?.length ?? 0, reports: value?.reports?.length ?? 0 }
  return null
}

function driverIntervalSeconds() {
  const raw = Number(process.env.LINDELA_LITE_SCHEDULER_INTERVAL_SECONDS)
  return Number.isFinite(raw) && raw > 0 ? raw : 900
}

/** Is the pipeline inside its own interval? */
export function pipelineIsHealthy(heartbeat, intervalSeconds = driverIntervalSeconds(), now = Date.now()) {
  if (!heartbeat?.at) return { healthy: false, ageSeconds: null, reason: 'no heartbeat has been recorded' }
  const ageSeconds = Math.max(0, Math.round((now - Date.parse(heartbeat.at)) / 1000))
  // Two intervals, so a single slow tick is not a red endpoint. A tick that
  // takes longer than the interval is itself worth knowing about, which is why
  // the threshold is generous rather than exact.
  return {
    healthy: ageSeconds <= intervalSeconds * 2,
    ageSeconds,
    lastFailure: heartbeat.failed > 0 ? heartbeat.items?.find((i) => !i.ok)?.label || 'an item' : null,
  }
}

/** Start the driver. Idempotent — a second call returns the same timer. */
export function startPeriodicDriver(store, { intervalSeconds = driverIntervalSeconds() } = {}) {
  if (_driverTimer) return _driverTimer
  const tick = async () => {
    if (_driverInFlight) return
    _driverInFlight = true
    try {
      await runPeriodicTick(store)
    } finally {
      _driverInFlight = false
    }
  }
  _driverTimer = setInterval(tick, intervalSeconds * 1000)
  // Do not hold the process open for the timer alone; the HTTP server decides.
  _driverTimer.unref?.()
  // One immediately, so a fresh deployment has a heartbeat before the first
  // interval elapses — otherwise a health check in the first 15 minutes sees a
  // process that has never run anything and cannot tell that from a broken one.
  tick()
  return _driverTimer
}

export function stopPeriodicDriver() {
  if (_driverTimer) clearInterval(_driverTimer)
  _driverTimer = null
  _driverInFlight = false
}

export function createServer(options = {}) {
  const storeProvider = options.store ? Promise.resolve(options.store) : getDefaultStore()
  return http.createServer(async (req, res) => {
    const t = timer()
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const route = normalizeRoute(url.pathname)

    try {
      // Set on every response, API and static alike. The pages build markup
      // with innerHTML, so this is the backstop that keeps a missed escape from
      // being a full script injection.
      securityHeaders(res)

      if (hasTraversalSegment(req.url || '')) {
        jsonResponse(res, 404, { success: false, error: 'Not found' })
        return
      }

      if (url.pathname.startsWith('/stac/') || url.pathname.startsWith('/ogc/')) {
        await handleStacRoute(await storeProvider, req, res, url)
        return
      }

      if (url.pathname === '/metrics' || url.pathname === '/api/v1/metrics') {
        // Served through the auth gate rather than in front of it. It was
        // returned above handleApi(), so `/api/v1/metrics` was reachable without
        // a token despite sitting in the authenticated namespace — leaking
        // request rates, error rates, latency percentiles and route labels,
        // the last being an enumeration aid.
        if (isAuthConfigured() && !isPublicPath(url.pathname)) {
          const metricsAuth = authenticate(req)
          if (!metricsAuth) {
            jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
            return
          }
        }
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' })
        res.end(metrics.render())
        return
      }
      if (url.pathname.startsWith('/api/v1/')) {
        await handleApi(await storeProvider, req, res, url)
        return
      }
      await handleStatic(req, res, url.pathname)
    } catch (error) {
      // A thrown value's message used to reach the client verbatim. In this
      // codebase that includes failures from `pg` — which carry the connection
      // string, the failing statement text and constraint names — from
      // JSON.parse, which carries a fragment of the offending payload, and from
      // filesystem calls, which carry absolute paths. A 500 became an
      // information-disclosure primitive.
      //
      // Errors that carry an explicit 4xx statusCode are deliberate client
      // errors (validation, not-found, conflict) and their text is written for
      // the caller. Anything else is an internal fault and gets a correlation id.
      const statusCode = error.statusCode || 500
      const exposeMessage = statusCode < 500
      if (exposeMessage) {
        jsonResponse(res, statusCode, { success: false, error: error.message || 'Request failed' })
      } else {
        const incidentId = randomUUID()
        logger.error({
          incident_id: incidentId,
          route,
          method: req.method,
          // Spreading an Error into a JSON payload yields `{}` — its fields are
          // non-enumerable. Log the parts, or the log says nothing at all.
          err: { message: error.message, stack: error.stack },
        }, 'request_failed')
        jsonResponse(res, statusCode, {
          success: false,
          error: 'Internal server error',
          incident_id: incidentId,
        })
      }
    } finally {
      const elapsed = t.end()
      const statusCode = res.statusCode || 500
      // `normalizeRoute` collapses id-shaped segments and leaves everything
      // else alone, so any path that matches no route — a scanner, a buggy
      // client with a random segment per request — became a permanent metric
      // series. Measured: 2,000 distinct unknown paths produced 2,000 series and
      // a `/metrics` body that grew to 16 MB over 17k requests.
      //
      // `observability.js` now bounds the label set; it cannot know which paths
      // are real, so the decision is made here where the routing lives. A path
      // that matched nothing collapses to one bucket instead of one series each.
      const metricRoute = res.locals?.matchedRoute === null
        ? '/unmatched'
        : (res.locals?.matchedRoute || route)
      metrics.counter('http_requests_total', { method: req.method, route: metricRoute, status: String(statusCode) })
      metrics.histogram('http_request_duration_ms', elapsed, { method: req.method, route: metricRoute, status: String(statusCode) })
      recordRequestOutcome(statusCode < 500)
      logger.info('http_request', { method: req.method, route, status: statusCode, elapsed_ms: elapsed })
    }
  })
}

function normalizeRoute(pathname) {
  return pathname
    .replace(/\/[a-f0-9-]{36}/g, '/:id')
    .replace(/\/[a-f0-9_]{32,}/g, '/:id')
    .replace(/\/\d+/g, '/:id')
}

/**
 * Rejects routing endpoints that are not road asset ids.
 *
 * Returns an error message when the caller clearly passed coordinates or an
 * object instead of an id, else null. Distinguishing "you sent the wrong shape"
 * from "no such road" matters: the latter is indistinguishable from a data
 * problem the operator cannot act on.
 */
function validateRouteEndpoints(endpoints) {
  const looksLikeCoordinate = (value) => value !== null && typeof value === 'object'
  if (endpoints.some(looksLikeCoordinate)) {
    return 'from and to must be road asset ids (see GET /api/v1/service-assets?service_type=road), not latitude/longitude objects'
  }
  const nonStrings = endpoints.filter((value) => typeof value !== 'string' || !value.trim())
  if (nonStrings.length) {
    return 'from and to must be non-empty road asset id strings'
  }
  return null
}

async function handleStacRoute(store, req, res, url) {
  const data = await store.read()
  const baseUrl = `http://${req.headers.host || 'localhost'}`

  if (req.method === 'GET' && url.pathname === '/stac/catalog.json') {
    jsonResponse(res, 200, stacCatalog(baseUrl))
    return
  }

  const collectionMatch = url.pathname.match(/^\/stac\/collections\/([^/]+)(?:\/items(?:\/([^/]+))?)?$/)
  if (collectionMatch && req.method === 'GET') {
    const collectionId = collectionMatch[1]
    const itemId = collectionMatch[2]

    // One resolver, shared with the OGC route below. The same three-way
    // if/else used to be written out in both places, and the catalog's child
    // links and `stacCollection`'s id check were two further copies of the same
    // list. Four copies of a collection list is four chances to add a
    // collection to three of them — see STAC_COLLECTIONS in src/stac.js.
    const records = resolveStacCollection(data, collectionId)
    if (records === null) {
      jsonResponse(res, 404, { success: false, error: 'Collection not found' })
      return
    }

    if (!itemId) {
      if (url.pathname.includes('/items')) {
        const items = records.map((r) => stacItem(r, collectionId, baseUrl))
        jsonResponse(res, 200, { type: 'FeatureCollection', features: items })
        return
      }
      jsonResponse(res, 200, stacCollection(collectionId, records, baseUrl))
      return
    }

    const record = records.find((r) => r.id === itemId)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Item not found' })
      return
    }

    jsonResponse(res, 200, stacItem(record, collectionId, baseUrl), { 'content-type': 'application/geo+json; charset=utf-8' })
    return
  }

  const ogcMatch = url.pathname.match(/^\/ogc\/collections\/([^/]+)\/items$/)
  if (ogcMatch && req.method === 'GET') {
    const collectionId = ogcMatch[1]

    const records = resolveStacCollection(data, collectionId)
    if (records === null) {
      jsonResponse(res, 404, { success: false, error: 'Collection not found' })
      return
    }

    jsonResponse(res, 200, ogcFeatureCollection(records), { 'content-type': 'application/geo+json; charset=utf-8' })
    return
  }

  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

/**
 * The trained model's contingency rows, keyed by the feature they describe.
 *
 * `contingency()` returns a flat array; a caller asking about max_7_day has no
 * reason to know that, and picking the first row would hand them the interval
 * for a different statistic than the one they supplied.
 */
/**
 * Where a focal point approval came from.
 *
 * The disbursement route previously gated on `Boolean(body.focal_point_approved)`
 * -- a field the same request set. The workflow machinery that could carry a
 * real approval (`parametric_disbursement`, whose states include
 * `focal_point_confirmed`) was never consulted, so a verified path existed and
 * went unused. It is consulted now; an instance that does not exist, is the
 * wrong type, or has not reached a confirmed state is a 409 rather than a
 * silently accepted flag.
 */
function resolveFocalPointApproval(data, rule, body) {
  if (!body.workflow_instance_id) {
    const asserted = Boolean(body.focal_point_approved)
    // No approval is being claimed beyond the flag. A rule that does not
    // require one is approved by nobody, which is the rule's own decision.
    if (!rule.requires_focal_point_approval) {
      return { approved: false, source: null, workflow_instance_id: null, approved_by: null }
    }
    return {
      approved: asserted,
      source: asserted ? 'request_body' : null,
      workflow_instance_id: null,
      approved_by: asserted ? (body.approved_by || body.actor || null) : null,
    }
  }

  const instance = (data.workflow_instances || []).find((w) => w.id === body.workflow_instance_id)
  if (!instance) {
    throw Object.assign(new Error(`Workflow instance ${body.workflow_instance_id} not found`), { statusCode: 409 })
  }
  if (instance.type !== 'parametric_disbursement') {
    throw Object.assign(
      new Error(`Workflow instance ${instance.id} is a ${instance.type} instance and cannot approve a disbursement`),
      { statusCode: 409 }
    )
  }
  if (!['focal_point_confirmed', 'chain_dispatched', 'closed'].includes(instance.state)) {
    throw Object.assign(
      new Error(`Workflow instance ${instance.id} is "${instance.state}"; focal point confirmation is required before a disbursement can be simulated`),
      { statusCode: 409 }
    )
  }
  return {
    approved: true,
    source: 'workflow',
    workflow_instance_id: instance.id,
    approved_by: instance.actor || null,
  }
}

function contingencyByFeature(rows) {
  if (!Array.isArray(rows)) return {}
  const byFeature = {}
  for (const row of rows) {
    if (!row || typeof row.feature !== 'string') continue
    byFeature[row.feature] = {
      threshold_mm: row.threshold_mm,
      months_above_threshold: row.months_above_threshold,
      flood_months_above_threshold: row.flood_months_above_threshold,
      conditional_probability: row.conditional_probability,
      conditional_probability_wilson: row.conditional_probability_wilson,
      lift_over_base_rate: row.lift_over_base_rate,
    }
  }
  return byFeature
}

/**
 * One process, one store: the memory of an in-flight retry is the whole of the
 * problem idempotency keys solve here, so it lives in this process's memory.
 * A retry inside the window replays the original response byte for byte; a
 * retry after it writes again. The bound is reported, never implied.
 */
const idempotency = createIdempotencyStore({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 1000 })

/**
 * Scoped by caller, method and path before use.
 *
 * An unscoped key would let one caller name another's response: two partners
 * both using `key: "1"` would receive each other's incidents, which is a
 * cross-tenant read manufactured entirely from request headers.
 */
function idempotencyKey(req, subject, url) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null
  const raw = req.headers['idempotency-key']
  if (raw === undefined || raw === null || raw === '') return null
  const key = String(raw)
  if (key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) {
    const error = new Error('Idempotency-Key must be 1-255 printable ASCII characters with no spaces')
    error.statusCode = 400
    throw error
  }
  // `anonymous` when auth is not configured: with no identities in play every
  // caller already reads every record, so a shared replay namespace grants
  // nothing that the route was not already granting. Under auth the subject
  // carries the separation, and that is the case the scoping exists for.
  return `${subject || 'anonymous'}\u0000${req.method}\u0000${url.pathname}\u0000${key}`
}

async function handleApi(store, req, res, url) {
  let key
  try {
    // Resolved here as well as inside handleApiRequest: the key must be scoped
    // to the caller, and the caller is only known once the token is read.
    // Cheap, pure, and a failure to authenticate simply yields no subject —
    // the request is then refused a moment later on its own merits.
    const subject = (isAuthConfigured() && !isPublicPath(url.pathname) ? authenticate(req) : null)?.subject
    key = idempotencyKey(req, subject, url)
  } catch (error) {
    jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
    return
  }
  if (!key) return handleApiRequest(store, req, res, url)

  // Buffered before dispatch so a retry can be compared with the attempt it
  // claims to repeat. `readRawBody` memoises, so the handler still reads a
  // body rather than an exhausted stream.
  let fingerprint = null
  try {
    fingerprint = createHash('sha256').update(await readRawBody(req)).digest('hex')
  } catch (error) {
    // Only the size rejection is a client error. Anything else is rethrown: a
    // blanket catch here would silently turn the fingerprint off and leave
    // idempotency working on the key alone, which is exactly the weaker
    // behaviour this code exists to prevent.
    if (!error.statusCode) throw error
    jsonResponse(res, error.statusCode, { success: false, error: error.message })
    return
  }

  // Claim before the work, not after it.
  //
  // The outcome used to be recorded once the handler had *returned*, so two
  // concurrent requests carrying the same key both found the store empty and
  // both executed. The window was the whole handler: a client that timed out on
  // `POST /api/v1/ingest/run-due` and retried re-ran the entire ingestion, and
  // the duplicate was only prevented downstream by the content hash.
  const replay = idempotency.claim(key, fingerprint)
  if (replay.conflict) {
    jsonResponse(res, replay.status, replay.body, { 'idempotency-conflict': 'true' })
    return
  }
  if (replay.inFlight) {
    // Someone else is already doing this exact work. Wait for their answer
    // rather than doing it twice — and answer 409 if they fail, so a caller can
    // tell "not done" from "not done yet".
    const settled = await replay.promise
    if (settled?.error) {
      jsonResponse(res, 409, {
        success: false,
        error: 'A request with this Idempotency-Key is already being processed and has not completed. Retry shortly.',
      }, { 'idempotency-in-flight': 'true' })
      return
    }
    jsonResponse(res, settled.status, settled.body, { 'idempotency-replayed': 'true', 'idempotency-window': 'open' })
    return
  }
  if (replay.proceed === false) {
    jsonResponse(res, replay.status, replay.body, { 'idempotency-replayed': 'true', 'idempotency-window': 'open' })
    return
  }

  let captured = null
  res.__capture = (status, body) => { captured = { status, body } }
  try {
    await handleApiRequest(store, req, res, url)
  } finally {
    delete res.__capture
  }
  // Only a success is worth replaying. Caching a 500 would convert a transient
  // failure into a permanent one for the length of the window — and a failed
  // claim is *released* rather than recorded, so the caller can retry at once
  // instead of waiting out the TTL.
  if (captured && captured.status < 400) {
    idempotency.settle(key, captured.status, captured.body, fingerprint)
  } else {
    idempotency.release(key)
  }
}

/**
 * Every `/api/v1` request, inside its caller's identity.
 *
 * Wrapping the whole dispatcher rather than passing `{ auth }` to each of ~60
 * call sites: scoping was opt-in, three sites did not opt in, and the by-id
 * branch had no scoping expression to miss. `filterRecords` now reads the
 * request's identity by default, so the default is the secure one and a new
 * route cannot forget.
 */
async function handleApiRequest(store, req, res, url) {
  // Resolve the identity once, here, and publish it for the whole dispatch.
  //
  // `authenticate` was already being called on this path for the idempotency
  // key, so this is not a second authentication — it is the same call, hoisted
  // so the answer is available before any handler runs rather than after.
  const auth = (isAuthConfigured() && !isPublicPath(url.pathname) ? authenticate(req) : null) || null
  return runWithRequestContext(auth, () => handleApiRequestInContext(store, req, res, url, auth))
}

async function handleApiRequestInContext(store, req, res, url, auth) {
  // An `/api/v1/` path reached dispatch. Cleared again if it matches nothing, so
  // the metric label distinguishes "a route we served" from "a path we did not
  // recognise" — the second is what a scanner produces, one per request.
  res.locals = res.locals || {}
  res.locals.matchedRoute = normalizeRoute(url.pathname)
  if (isAuthConfigured()) {
    if (url.pathname === '/api/v1/rapidpro/field-report' && req.method === 'POST') {
      // Buffer first. A signature covers the exact bytes sent, and the body
      // stream cannot be read twice — verifying first meant every HMAC-signed
      // request failed closed against the real route while passing in tests
      // that buffered the body themselves.
      req.rawBody = await readRawBody(req)
      if (!verifyRapidProWebhook(req, url)) {
        jsonResponse(res, 401, { success: false, error: 'Invalid RapidPro webhook' })
        return
      }
    } else if (!isPublicPath(url.pathname)) {
      // Every route needs a token, GET included. The old guard rejected only
      // non-GET methods, so `GET /api/v1/export.csv` — field reports and
      // RapidPro message bodies — was served to anyone who could reach the
      // port even with API keys correctly configured. A deployment with auth
      // enabled looked secured and was not.
      auth = authenticate(req)
      if (!auth) {
        jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
        return
      }
      try {
        requireScope(auth, scopeForRoute(req.method, url.pathname))
      } catch (error) {
        jsonResponse(res, error.statusCode || 403, { success: false, error: error.message })
        return
      }
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/ready') {
    // Health answers "is this process running". Readiness answers "can it serve
    // a request right now" — which is a different question, because the store
    // is a separate dependency that can be unreachable while the process is
    // perfectly alive and still answering /health with 200. A load balancer
    // polling only /health will keep a broken instance in rotation and hand
    // every user a 500 it could have routed around.
    const started = Date.now()
    const timeoutMs = Number(url.searchParams.get('timeout_ms') || 2000)
    let probe = { ok: true, error: null }
    try {
      await withTimeout(store.read(), timeoutMs)
    } catch (error) {
      probe = { ok: false, error: error?.name === 'TimeoutError' ? `store did not respond within ${timeoutMs}ms` : String(error?.message || error) }
    }
    const latency = Date.now() - started

    // Two rollups that were computed and never read.
    //
    // `verifyChain` was called from exactly one route, so a tampered or
    // truncated `action_logs` table was detected when somebody asked for the
    // proof or not at all — which is not evidence. `outboxRollup` says how many
    // deliveries are dead-lettered, and nothing surfaced it.
    //
    // Guarded, and reading once. A probe that hangs is worse than one that
    // answers "unready": this endpoint exists to be polled, and a probe that
    // never returns holds the caller open — which is how a readiness check stops
    // being a signal and becomes an outage. The store has already been probed
    // above inside a timeout; if that succeeded, this read is the one place it
    // can still fail, so it is bounded the same way.
    let audit = null
    let outbox = null
    try {
      const snapshot = await withTimeout(store.read(), timeoutMs)
      audit = auditRollup(snapshot.action_logs || [])
      outbox = outboxRollup(snapshot)
    } catch (rollupError) {
      audit = { valid: null, error: String(rollupError?.message || rollupError) }
      outbox = { degraded: null, error: String(rollupError?.message || rollupError) }
    }
    const degraded = audit?.valid === false || outbox?.degraded === true

    const ready = probe.ok && !degraded
    jsonResponse(res, ready ? 200 : 503, {
      success: ready,
      ready,
      store: { mode: store.mode || 'custom', reachable: probe.ok, latency_ms: latency, error: probe.error },
      // Reported, not implied: the whole bound on the idempotency guarantee.
      idempotency: { in_process: true, ttl_hours: 24 },
      // Two rollups that were computed and never read. A tampered action log
      // and a dead-lettered webhook were both invisible on the one endpoint a
      // load balancer and an operator already poll.
      audit,
      outbox,
      checked_at: new Date().toISOString(),
    })
    return
  }


  const data = await store.read()
  req.__auth = auth

  if (req.method === 'GET' && url.pathname === '/api/v1/auth-info') {
    // What this token is, as the server understands it. The partner portal
    // rendered its organisation from localStorage — a value the user typed,
    // never checked against anything — so the interface showed an isolation
    // that the server had no opinion about.
    jsonResponse(res, 200, {
      success: true,
      data: {
        subject: auth?.subject || null,
        scopes: auth?.scopes || [],
        partner_org: auth?.partner_org || null,
        auth_configured: isAuthConfigured(),
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/health') {
    // Is the thing this process exists to do actually happening?
    //
    // It asserted exactly one thing — that the store answered — and then
    // returned the literal string `ok`. It did not assert that ingestion is
    // running, that schedules are honoured, that alerts are evaluated, or that
    // the queue is draining. So a process that was up, serving 200s, and whose
    // pipeline had been dead for a week was indistinguishable from a healthy
    // one, and `Dockerfile:23-24` polls exactly this endpoint every 30 seconds.
    //
    // Two intervals before red, so a single slow tick is not an outage.
    const heartbeat = data.system_heartbeat?.[0] || null
    const pipeline = pipelineIsHealthy(heartbeat)
    // Three states, not two.
    //
    // A process that has never completed a cycle is `starting`, not broken: it
    // may have been up for four seconds. Reporting that as red would mean every
    // fresh deployment, and every restart, starts red — and a monitor that
    // starts red is a monitor that gets ignored.
    //
    // Red is reserved for the case that matters: a heartbeat exists and has gone
    // stale. That is a pipeline that ran and stopped.
    const starting = !heartbeat
    jsonResponse(res, pipeline.healthy || starting ? 200 : 503, {
      success: pipeline.healthy || starting,
      status: starting ? 'starting' : pipeline.healthy ? 'ok' : 'degraded',
      pipeline: {
        healthy: pipeline.healthy,
        last_success_age_seconds: pipeline.ageSeconds,
        interval_seconds: heartbeat?.interval_seconds ?? null,
        last_failure: pipeline.lastFailure || null,
        note: pipeline.healthy ? null : 'The pipeline has not completed a cycle recently. Nothing below has been refreshed since the last one that did.',
      },
      // One version, from package.json. The UI used to hardcode it in two HTML
      // files and one translation file and it drifted behind the package, so a
      // panel asking "which build is this?" would have been told the wrong one.
      // Read once at startup and fail loudly if it cannot be read, rather than
      // reporting a version we made up.
      version: APP_VERSION,
      updated_at: data.updated_at,
      counts: counts(data),
      sources: publicSourceCatalog().map((source) => source.id),
      exclusions: ['gdelt'],
      storage: { mode: store.mode || 'custom' },
      // The auth posture, on the one route an operator can reach without a
      // token. It used to live only on `/api/v1/auth-info`, which needs a token
      // to read — so the person asking "is this deployment secured?" was the one
      // person who could not find out. The answer is a boolean, a public-path
      // list, and nothing about who holds what.
      auth: {
        configured: isAuthConfigured(),
        // `false` here means every route except the public list is closed to
        // everyone, which is a working deployment. It does *not* mean the
        // deployment is unsecured — that is `configured: false`.
        enforced: isAuthConfigured(),
        public_paths: publicPaths(),
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/sources') {
    const health = ingestionStatus(data)
    jsonResponse(res, 200, {
      success: true,
      data: publicSourceCatalog().map((source) => ({
        ...source,
        last_run: data.source_runs.find((run) => run.source === source.id) || null,
        health: health.find((item) => item.source === source.id)?.status || 'unknown',
        schedule: health.find((item) => item.source === source.id)?.schedule || null,
      })),
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/connectors') {
    const registry = await getConnectorRegistry()
    const sourceRuns = data.source_runs || []
    const withStatus = registry.map((connector) => {
      const lastRun = sourceRuns
        .filter((run) => run.source === connector.id)
        .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())[0]
      return {
        ...connector,
        last_run: lastRun || null,
        status: lastRun?.status || 'unknown',
      }
    })
    jsonResponse(res, 200, { success: true, data: withStatus })
    return
  }

  const webhookRoute = matchWebhookRoute(url.pathname)
  if (webhookRoute) {
    await handleWebhookRoute(store, data, req, res, url, webhookRoute)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/outbox') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.events_outbox || [], url.searchParams, { auth: req.__auth, data, collection: 'events_outbox' }) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/outbox/dispatch') {
    const body = await readRequestJson(req)
    const webhooks = data.webhook_subscriptions || []
    const result = await dispatchPending(store, { webhooks, maxBatch: 50, timeoutMs: 5000 })
    jsonResponse(res, 201, { success: true, ...result })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/upload') {
    // The upload contract, served. A client that has to guess which columns a
    // collection wants will guess wrong, and a wrong guess is a validation
    // report the operator has to read instead of a column list they could have
    // had up front.
    jsonResponse(res, 200, {
      success: true,
      collections: UPLOAD_COLLECTIONS.map(({ id, label, required, optional }) => ({
        id, label, required_columns: required, optional_columns: optional,
      })),
      accepts: ['multipart/form-data (part named "file")', 'text/csv?collection=…', 'application/json { csv, collection }'],
      dry_run: 'Send dry_run=true to validate and write nothing.',
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/upload') {
    // Three content types, because three clients are real: a browser form posts
    // multipart, `curl --data-binary @file.csv` sends text/csv, and an
    // integrator who already has the rows in memory has them as JSON. All three
    // end up in the same validator, so the report is identical whichever door
    // the data came through.
    const contentType = String(req.headers['content-type'] || '')
    let csvText = ''
    let filename = null
    let body = {}

    if (contentType.startsWith('multipart/form-data')) {
      const raw = await readRawBody(req)
      let parsed
      try {
        parsed = parseMultipart(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)), contentType)
      } catch (error) {
        jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
        return
      }
      const file = parsed.files.find((f) => f.field === 'file') || parsed.files[0]
      if (!file) {
        jsonResponse(res, 400, { success: false, error: 'No file part found. Send the CSV as a part named "file".' })
        return
      }
      csvText = file.content.toString('utf8')
      filename = file.filename
      body = { collection: parsed.fields.collection, dry_run: parsed.fields.dry_run }
    } else if (contentType.startsWith('text/csv')) {
      const raw = await readRawBody(req)
      csvText = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
      body = { collection: url.searchParams.get('collection'), dry_run: url.searchParams.get('dry_run') }
    } else {
      body = await readRequestJson(req)
      csvText = body.csv ?? ''
      filename = body.filename ?? null
    }

    const dryRun = body.dry_run === true || body.dry_run === 'true' || body.dry_run === '1'
    const collection = body.collection || url.searchParams.get('collection') || 'service_assets'
    const existingIds = new Set((data[collection] || []).map((record) => record.id).filter(Boolean))
    const report = validateUpload(csvText, { collection, existingIds })

    // A batch is one thing that happened, so it gets one id — a fingerprint of
    // the bytes. Two posts of the same file produce the same id, which makes the
    // log readable and gives an operator something to quote when asking why
    // their import ran twice.
    const batchId = `upload_${createHash('sha256').update(csvText).digest('hex').slice(0, 12)}`

    await store.merge({
      action_logs: [actionLog(collection, dryRun ? 'upload_validated' : 'uploaded',
        { id: batchId }, body.actor || req.__auth?.subject, req.__auth?.subject, {
          batch_id: batchId,
          collection,
          filename,
          dry_run: dryRun,
          ...report.summary,
          errors: report.errors.slice(0, 25),
          error_count_total: report.errors.length,
        })],
    })

    if (dryRun) {
      // A dry run that writes nothing but still says what would happen. The first
      // twenty errors are enough to recognise a systematic problem — a wrong
      // date format, a transposed latitude column — and a four-thousand-error
      // body would be a denial of service against the reader.
      jsonResponse(res, 200, {
        success: true,
        dry_run: true,
        collection: report.collection,
        filename,
        ...report.summary,
        headers: report.headers,
        errors: report.errors.slice(0, 20),
        errors_truncated: report.errors.length > 20,
      })
      return
    }

    if (!report.ok) {
      // Nothing is written. A partial import is the outcome nobody wants: the
      // caller has to work out which half landed, and the half that landed is
      // the half they did not look at.
      jsonResponse(res, 422, {
        success: false,
        error: report.summary.valid_rows === 0
          ? 'No rows could be imported. Nothing was written; the errors below say why.'
          : `Nothing was written. ${report.summary.invalid_rows} of ${report.summary.total_rows} rows failed validation, and a partial import is refused.`,
        collection: report.collection,
        filename,
        ...report.summary,
        headers: report.headers,
        errors: report.errors.slice(0, 20),
        errors_truncated: report.errors.length > 20,
      })
      return
    }

    await store.merge({ [collection]: report.rows })
    jsonResponse(res, 201, {
      success: true,
      collection: report.collection,
      filename,
      imported: report.rows.length,
      ...report.summary,
    })
    return
  }

  const scenarioRoute = matchScenarioRoute(url.pathname)
  if (scenarioRoute) {
    if (req.method === 'POST' && scenarioRoute.kind === 'create') {
      const body = await readRequestJson(req)
      const perturbation = body.perturbation || body
      const result = runScenario(data, perturbation)
      const token = encodeScenarioUrl(perturbation)
      jsonResponse(res, 201, { success: true, ...result, token })
      return
    }
    if (req.method === 'GET' && scenarioRoute.kind === 'retrieve') {
      try {
        const perturbation = decodeScenarioUrl(scenarioRoute.token)
        const result = runScenario(data, perturbation)
        jsonResponse(res, 200, { success: true, ...result })
        return
      } catch (error) {
        jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
        return
      }
    }
  }

  const ingestionRoute = matchIngestionRoute(url.pathname)
  if (ingestionRoute) {
    await handleIngestionRoute(store, data, req, res, url, ingestionRoute)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/ingest/run') {
    const body = await readRequestJson(req)
    const ingestion = await runIngestion(store, body)
    const analytics = await refreshAnalytics(store)
    const logs = ingestion.source_runs.map((run) => actionLog('source_runs', run.status, run, body.actor, req.__auth?.subject))
    if (logs.length) await store.merge({ action_logs: logs })
    jsonResponse(res, 200, {
      success: true,
      source_runs: ingestion.source_runs,
      counts: ingestion.counts,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
      action_logs: logs,
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/maintenance/apply-retention') {
    const policy = await loadPolicy()
    const windowDays = retentionWindowDays(policy)
    if (windowDays === null) {
      // Refusing is the point. A window that is not a positive finite number
      // used to become NaN, and `age > NaN` is false for every record — so the
      // route expired nothing, reported `success: true`, and the retention job
      // passed silently on every run. An operator who is told the window is not
      // configured can fix it; one who is told `expired: 0` files it under
      // "nothing to do" and keeps every field report the deployment ever took.
      jsonResponse(res, 400, {
        success: false,
        error: `retentionDays is not a positive number (got ${JSON.stringify(policy.retentionDays)}); set it in data/pii-policy.json or LINDELA_LITE_PII_POLICY. Nothing was deleted.`,
      })
      return
    }
    const fieldReportRetention = applyRetention(data.field_reports, windowDays)
    const inboundRetention = applyRetention(data.rapidpro_inbound_messages, windowDays)
    // remove(), not merge(). merge() keyed on id, so re-merging the survivors
    // over the originals left every expired record exactly where it was — the
    // route reported `{success: true, expired: 1}` and deleted nothing (DAT-07).
    await store.remove({
      collection: {
        field_reports: fieldReportRetention.expired.map((record) => record.id),
        rapidpro_inbound_messages: inboundRetention.expired.map((record) => record.id),
      },
    })
    jsonResponse(res, 200, {
      success: true,
      field_reports: {
        kept: fieldReportRetention.kept.length,
        expired: fieldReportRetention.expired.length,
      },
      rapidpro_inbound_messages: {
        kept: inboundRetention.kept.length,
        expired: inboundRetention.expired.length,
      },
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/demo/seed') {
    try {
      const { seedAll, ingestPublicSources, summary } = await import('../scripts/seed-demo.mjs')
      await ingestPublicSources(store)
      await seedAll(store)
      await refreshAnalytics(store)
      const counts = await summary(store)
      jsonResponse(res, 200, { success: true, counts })
    } catch (e) {
      logger.error({ err: e }, 'demo seed failed')
      jsonResponse(res, 500, { success: false, error: e.message })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/service-assets') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.service_assets, url.searchParams, { auth: req.__auth, data, collection: 'service_assets' }) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/service-assets') {
    const body = await readRequestJson(req)
    const ingestion = await runIngestion(store, { ...body, sources: ['service_assets'] })
    const run = ingestion.source_runs[0]
    if (run.errors.length) {
      jsonResponse(res, 400, { success: false, error: 'Invalid service asset input', errors: run.errors, accepted: ingestion.counts.service_assets })
      return
    }
    const analytics = await refreshAnalytics(store)
    jsonResponse(res, 201, {
      success: true,
      imported: ingestion.counts.service_assets,
      source_run: run,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/events') {
    const records = [...data.hazard_events, ...data.conflict_events]
    jsonResponse(res, 200, { success: true, ...collectionPage(records, url.searchParams, { auth: req.__auth, data, collection: 'incidents' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/climate') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.climate_observations, url.searchParams, { auth: req.__auth, data, collection: 'climate_observations' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/flood-risk') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.risk_scores.filter((risk) => risk.type === 'flood_risk'), url.searchParams, { auth: req.__auth, data, collection: 'risk_scores' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/conflict-risk') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.risk_scores.filter((risk) => risk.type === 'climate_conflict_risk'), url.searchParams, { auth: req.__auth, data, collection: 'risk_scores' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/service-impacts') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.impact_assessments, url.searchParams, { auth: req.__auth, data, collection: 'impact_assessments' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/impact/population-at-risk') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.population_at_risk || [], url.searchParams, { auth: req.__auth, data, collection: 'population_at_risk' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/impact/facilities-at-risk') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.facilities_at_risk || [], url.searchParams, { auth: req.__auth, data, collection: 'facilities_at_risk' }) })
    return
  }

  if (url.pathname === '/api/v1/road-access') {
    const includeDeleted = url.searchParams.get('include_deleted') === 'true'
    const records = includeDeleted
      ? (data.road_access || [])
      : (data.road_access || []).filter((item) => !isDeleted(item))
    jsonResponse(res, 200, { success: true, data: records, summary: summarizeRoadAccess(records) })
    return
  }

  if (url.pathname === '/api/v1/road-access/summary') {
    jsonResponse(res, 200, { success: true, data: summarizeRoadAccess(data.road_access || []) })
    return
  }

  if (url.pathname === '/api/v1/food-security') {
    // Summary rides along with the list, like road-access: a caller paging the
    // records gets the roll-up for nothing instead of a second request.
    const records = filterRecords(data.food_security_records || [], url.searchParams, { auth: req.__auth, data, collection: 'food_security_records' })
    jsonResponse(res, 200, { success: true, data: records, summary: summarizeFoodSecurity(records) })
    return
  }

  if (url.pathname === '/api/v1/food-security/summary') {
    jsonResponse(res, 200, { success: true, data: summarizeFoodSecurity(data.food_security_records || []) })
    return
  }

  if (url.pathname === '/api/v1/disease-observations') {
    const records = filterRecords(data.disease_observations || [], url.searchParams, { auth: req.__auth, data, collection: 'disease_observations' })
    jsonResponse(res, 200, { success: true, data: records, summary: summarizeDiseaseObservations(records) })
    return
  }

  if (url.pathname === '/api/v1/disease-observations/summary') {
    // The list endpoint caps at filterRecords' page limit, and the series
    // states must not be computed over an arbitrary page of the collection —
    // the dashboard strip therefore reads the whole store here.
    jsonResponse(res, 200, { success: true, data: summarizeDiseaseObservations(data.disease_observations || []) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/flood-probability/models') {
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(data.flood_probability_models || [], url.searchParams, { auth: req.__auth, data, collection: 'flood_probability_models' }),
    })
    return
  }

  // Route planning requires a POST body (origin plus one or more
  // destinations), so it is handled by the mutating branch below rather than
  // here in the GET-only section.
  if (req.method === 'POST' && url.pathname === '/api/v1/flood-probability/train') {
    // Training is pure compute over the store: open_meteo_archive rainfall
    // series, plus either GDACS flood events (default label) or an
    // open_meteo_flood discharge series (body label_source:
    // 'glofas_discharge') already held. It writes trained models into
    // flood_probability_models and never reaches the network. A district
    // that cannot support a fit lands in refusals with the reason, not as a
    // model with no sample.
    const body = await readRequestJson(req)
    const { trained, refusals } = trainDistrictModels(data, body || {})
    if (trained.length) await store.merge({ flood_probability_models: trained })
    jsonResponse(res, 200, { success: true, data: trained, refusals })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/flood-probability/score') {
    // A query param that is absent must not become Number(null) = 0 mm — one
    // missing statistic would otherwise score against feature zeros that were
    // never given. Absent or empty is unreadable and refused.
    const featureValue = (name) => {
      const raw = url.searchParams.get(name)
      return raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
    }
    const features = {
      max_7_day: featureValue('max_7_day'),
      sum_30_day: featureValue('sum_30_day'),
      sum_90_day: featureValue('sum_90_day'),
    }
    const missing = Object.entries(features).filter(([, v]) => !Number.isFinite(v)).map(([k]) => k)
    if (missing.length) {
      jsonResponse(res, 400, { success: false, error: `missing or non-numeric rainfall features: ${missing.join(', ')}` })
      return
    }
    const region = url.searchParams.get('region')
    const models = (data.flood_probability_models || [])
      .filter((m) => m.model)
      .sort((a, b) => Date.parse(b.trained_at) - Date.parse(a.trained_at))

    // With no region named, a single trained model is unambiguous and safe to
    // use. More than one is not: the old behaviour took models[0], which is
    // whichever district happened to train most recently, so a caller who
    // omitted the parameter got an authoritative-looking number about a
    // district they never asked about. Ask which one instead.
    if (!region && models.length > 1) {
      jsonResponse(res, 400, {
        success: false,
        error: 'region is required: more than one flood-probability model is trained, and scoring against whichever trained most recently would answer a question nobody asked',
        available_regions: models.map((m) => m.region_name),
      })
      return
    }

    const latest = region
      ? models.find((m) => String(m.region_name).toUpperCase() === region.toUpperCase())
      : models[0]
    if (!latest || !latest.model) {
      // An absent model is an answer, not a 500: the refusal says what is
      // missing, exactly as the training endpoint would have reported it.
      jsonResponse(res, 200, {
        success: true,
        scored: false,
        refusal: region
          ? `no trained flood-probability model for ${region}; POST /api/v1/flood-probability/train first`
          : 'no trained flood-probability model in the store; POST /api/v1/flood-probability/train first',
        basis: latest?.basis || null,
      })
      return
    }
    const probability = predict(latest.model, features)
    if (probability === null) {
      jsonResponse(res, 200, { success: true, scored: false, refusal: 'cannot score: non-finite feature after standardization' })
      return
    }
    jsonResponse(res, 200, {
      success: true,
      scored: true,
      data: {
        region_name: latest.region_name,
        probability,
        features,
        trained_at: latest.trained_at,
        model: latest.model,
        folds: latest.folds,
        // The uncertainty behind this number, which used to stay on the server.
        // `probability` is a point estimate from the fitted logistic model; the
        // contingency rows are the empirical rainfall-flood co-occurrence
        // counts it was fit to, each with a Wilson interval and the number of
        // months the count rests on. A caller reading only `probability` sees
        // an authoritative-looking figure with no idea that it may rest on four
        // events.
        uncertainty: {
          note: 'conditional_probability and its Wilson interval are the empirical co-occurrence count at each feature threshold, not a confidence interval on the fitted point estimate. Read months_above_threshold before quoting the probability.',
          by_feature: contingencyByFeature(latest.contingency),
        },
        basis: latest.basis,
        label_source: latest.label_source,
        months_kept: latest.months_kept,
        events_matched: latest.events_matched,
        metadata: latest.metadata,
      },
    })
    return
  }

  // Route planning requires a POST body (origin plus one or more
  // destinations), so it is handled by the mutating branch below rather than
  // here in the GET-only section.
  if (req.method === 'POST' && url.pathname === '/api/v1/routing/plan') {
    const body = await readRequestJson(req)
    const from = body.from || body.origin
    const to = body.to || body.destination || body.destinations
    if (!from) {
      jsonResponse(res, 400, { success: false, error: 'from is required: the id of the distribution origin road' })
      return
    }
    if (!to || (Array.isArray(to) && !to.length)) {
      jsonResponse(res, 400, { success: false, error: 'to is required: one or more destination road ids' })
      return
    }
    // Endpoints are road asset ids. A lat/lon pair here is a plausible mistake
    // that otherwise surfaces as "Unknown origin or destination road", which
    // reads like a broken router rather than a wrong argument.
    const coordinateRejection = validateRouteEndpoints([from, ...(Array.isArray(to) ? to : [to])])
    if (coordinateRejection) {
      jsonResponse(res, 400, { success: false, error: coordinateRejection })
      return
    }
    const plan = planDelivery(data, {
      from,
      to,
      linkRadiusKm: Number.isFinite(body.link_radius_km) ? Number(body.link_radius_km) : undefined,
      maxMinutes: Number.isFinite(body.max_minutes) ? Number(body.max_minutes) : undefined,
    })
    if (plan.feasible === false && plan.reason) {
      jsonResponse(res, 400, plan)
      return
    }
    jsonResponse(res, 200, { success: true, data: plan })
    return
  }

  if (url.pathname === '/api/v1/flood-depth') {
    const result = await handleFloodDepth(url, res)
    if (result !== undefined) return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/data-quality') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.data_quality, url.searchParams, { auth: req.__auth, data, collection: 'data_quality' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/data-lineage') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.data_lineage || [], url.searchParams, { auth: req.__auth, data, collection: 'data_lineage' }) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/operations/summary') {
    jsonResponse(res, 200, { success: true, data: operationalSummary(data) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/analytics/bias-correct') {
    const body = await readRequestJson(req)
    const observations = body.observations || []
    const stations = body.stations || []
    const corrected = biasCorrectClimate(observations, stations)
    jsonResponse(res, 200, { success: true, data: corrected })
    return
  }

  if (url.pathname === '/api/v1/alerts/evaluate') {
    await handleAlertEvaluation(store, data, req, res)
    return
  }

  const rapidProRoute = matchRapidProRoute(url.pathname)
  if (rapidProRoute) {
    await handleRapidProRoute(store, data, req, res, url, rapidProRoute)
    return
  }

  // Calibration and drift are stored on every refresh, so they are read like
  // any other derived collection. Both refuse on thin evidence and say why;
  // the refusal travels with the row rather than becoming an empty list.
  if (req.method === 'GET' && url.pathname === '/api/v1/calibration/by-region') {
    const rows = data.region_trust || []
    const region = url.searchParams.get('region')
    const selected = region ? rows.filter((r) => r.region_name === region) : rows
    jsonResponse(res, 200, {
      success: true,
      regions: rows.length,
      returned: selected.length,
      // A region with too little evidence has `trust` null and a reason. The
      // count of refusals is as much of the answer as the scores.
      refused: selected.filter((r) => r.trust === null || r.trust === undefined).length,
      data: selected,
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/model-drift') {
    const rows = data.model_drift || []
    jsonResponse(res, 200, {
      success: true,
      regions: rows.length,
      verdicts: rows.reduce((acc, r) => {
        acc[r.verdict] = (acc[r.verdict] || 0) + 1
        return acc
      }, {}),
      data: rows,
    })
    return
  }

  // "Where did this number come from."
  //
  // The server's half: resolve the record and hand back everything the store
  // knows about how it arrived — the source run, the lineage row, the record's
  // own declared limits. The chain of reasoning itself is rendered by
  // `explainRecord` in the browser module, so there is one implementation of it
  // rather than a server copy that drifts.
  const explainRoute = matchExplainRoute(url.pathname)
  if (explainRoute && req.method === 'GET') {
    const kind = url.searchParams.get('kind') || 'risk_scores'
    const id = explainRoute.id
    const rows = data[kind] || []
    const record = rows.find((r) => String(r.id) === id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: `No ${kind} record with id ${id}` })
      return
    }
    const run = record._source_run_id
      ? (data.source_runs || []).find((r) => r.id === record._source_run_id) || null
      : null
    const lineage = (data.data_lineage || []).filter((l) => l.source_run_id === record._source_run_id)
    jsonResponse(res, 200, {
      success: true,
      kind,
      record,
      // A record with no source run still gets a 200: it exists, and saying so
      // is the answer. Absence of provenance is a fact about the record, not a
      // reason to withhold it.
      provenance: {
        source_run: run,
        lineage,
        // Stated rather than left as null, because null here reads as "we did
        // not look" rather than "there was nothing to find".
        known: Boolean(run || lineage.length),
        note: run || lineage.length
          ? null
          : 'This record names no source run, so its origin cannot be traced from the store.',
      },
      limits: record.limits || null,
      calibrated_uncertainty: record.calibrated_uncertainty ?? null,
    })
    return
  }

  const auditRoute = matchAuditRoute(url.pathname)
  if (auditRoute && req.method === 'GET') {
    // The published head travels OUT OF BAND. Verifying a chain against a head
    // stored inside the chain it protects proves nothing: a file re-chained
    // end to end is internally consistent and completely rewritten.
    // chainEntries returns the entries AND the head it computed; it is not itself
    // the list, and passing the object where an array was wanted is what made
    // this route 500 on its first call.
    const { entries } = chainEntries(data.action_logs || [])
    const publishedHead = url.searchParams.get('head') || null
    const proof = verifyChain(entries, { expectedHead: publishedHead })
    jsonResponse(res, 200, {
      success: true,
      entries: entries.length,
      head: entries.length ? entries[entries.length - 1].entry_hash : null,
      verified: proof.ok,
      // Present so a reader is not left to infer it from a missing field: a chain
      // nobody anchored is internally consistent and still not proof.
      unanchored: !publishedHead,
      defects: proof.defects || [],
      advisories: proof.advisories || [],
      // renderAuditProof re-verifies from the entries itself and renders the
      // human-readable document a non-engineer reads. Passing it the proof
      // object instead is what made this route 500 on its third attempt.
      proof: renderAuditProof(entries, { expectedHead: publishedHead }),
    })
    return
  }

  const reportingRoute = matchReportingRoute(url.pathname)
  if (reportingRoute) {
    await handleReportingRoute(store, data, req, res, url, reportingRoute)
    return
  }

  const alertRoute = matchAlertRoute(url.pathname)
  if (alertRoute) {
    await handleAlertRoute(store, data, req, res, url, alertRoute)
    return
  }

  const triggerRoute = matchTriggerRoute(url.pathname)
  if (triggerRoute) {
    await handleTriggerRoute(store, data, req, res, url, triggerRoute)
    return
  }

  // Parametric disbursement routes
  const parametricRoute = matchParametricRoute(url.pathname)
  if (parametricRoute) {
    await handleParametricRoute(store, data, req, res, url, parametricRoute)
    return
  }

  const operationalRoute = matchOperationalRoute(url.pathname)
  if (operationalRoute) {
    await handleOperationalRoute(store, data, req, res, url, operationalRoute)
    return
  }

  const chwRoute = matchChwRoute(url.pathname)
  if (chwRoute) {
    await handleChwRoute(store, data, req, res, url, chwRoute)
    return
  }

  const workflowRoute = matchWorkflowRoute(url.pathname)
  if (workflowRoute) {
    await handleWorkflowRoute(store, data, req, res, url, workflowRoute)
    return
  }

  // District routes
  if (req.method === 'GET' && url.pathname === '/api/v1/districts') {
    jsonResponse(res, 200, { success: true, data: KNOWN_DISTRICTS })
    return
  }
  const districtMatch = url.pathname.match(/^\/api\/v1\/districts\/([^/]+)$/)
  if (districtMatch && req.method === 'GET') {
    const overview = districtOverview(data, districtMatch[1])
    if (!overview) {
      jsonResponse(res, 404, { success: false, error: 'District not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: overview })
    return
  }

  // KPI routes
  if (req.method === 'GET' && url.pathname === '/api/v1/kpi/monthly-series') {
    const monthsBack = Number(url.searchParams.get('monthsBack')) || 12
    jsonResponse(res, 200, { success: true, data: computeMonthlyKpiSeries(data, { monthsBack }) })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/kpi/snapshots') {
    jsonResponse(res, 200, { success: true, data: data.kpi_snapshots || [] })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/kpi/refresh-snapshots') {
    const snapshots = await refreshKpiSnapshots(store)
    jsonResponse(res, 200, { success: true, count: snapshots.length })
    return
  }

  // The export that carries the reasoning. `renderExportMarkdown` composes with
  // the report renderer rather than reimplementing it, so the two cannot drift,
  // and every withheld figure prints as "not measured" rather than a dash in a
  // column of numbers.
  if (req.method === 'GET' && url.pathname === '/api/v1/kpi/quarterly.md') {
    const quarter = url.searchParams.get('quarter') || undefined
    const year = url.searchParams.get('year') || undefined
    let kpi
    try {
      kpi = computeQuarterlyKpi(data, { quarter, year })
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      return
    }
    // renderExportMarkdown takes a REPORT, not a KPI snapshot. Handing it the
    // snapshot produced an export headed "# undefined" that said "no generated
    // sections" — refusals rendered correctly while the document described
    // nothing, which is the worst of both.
    let report
    try {
      const templates = data.report_templates || []
      const template = templates[0] || normalizeReportTemplate({ id: 'quarterly-export', name: 'Quarterly export' }, data)
      report = generateReportSections(
        normalizeReport({ template_id: template.id, period: { quarter, year } }, data),
        data,
      )
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      return
    }
    const markdown = renderExportMarkdown(report, data)
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="lindela-kpi-${kpi.period.year}-${kpi.period.quarter}.md"`,
    })
    res.end(markdown)
    return
  }

  // What the PDF carries, before anyone downloads it.
  //
  // The dashboard exported a two-section file from a seven-section page with no
  // note on either side, so a funder receiving the PDF had no way to know that
  // Equity by District — the section they most often ask for by name — was not
  // in it. The list is generated from the same declaration the renderer uses, so
  // the preview cannot drift from the file.
  if (req.method === 'GET' && url.pathname === '/api/v1/kpi/quarterly/coverage') {
    jsonResponse(res, 200, { success: true, data: { sections: DASHBOARD_SECTIONS, ...quarterlyReportCoverage() } })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/kpi/quarterly.pdf') {
    const quarter = url.searchParams.get('quarter') || undefined
    const year = url.searchParams.get('year') || undefined
    let kpi
    try {
      kpi = computeQuarterlyKpi(data, { quarter, year })
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      return
    }
    // The narrative page rides in the same PDF, so the refusals travel with the
    // numbers a donor reads rather than living only in a Markdown export.
    //
    // The dashboard's other four sections ride with it too. They are computed
    // from the same collections and the same helpers the page renders from, so a
    // figure cannot be one thing on screen and another in the file.
    const sections = quarterlyPdfSections(data, { quarter: kpi.period.quarter, year: kpi.period.year })

    // The narrative, built from the report the Markdown export builds, not a
    // literal `true`.
    //
    // It was passed as `narrative: true` behind a comment saying the refusals
    // travelled with the numbers. The renderer tests `narrative.measured?.length`,
    // a boolean has no `measured`, so the page was never emitted and the export
    // went out with every refusal stripped off it. The comment asserted the
    // exact opposite of what the file did.
    let narrative
    try {
      const templates = data.report_templates || []
      const template = templates[0] || normalizeReportTemplate({ id: 'quarterly-export', name: 'Quarterly export' }, data)
      const report = generateReportSections(
        normalizeReport({ template_id: template.id, period: { quarter: kpi.period.quarter, year: kpi.period.year } }, data),
        data,
      )
      narrative = buildExportNarrative({ report, data })
    } catch (err) {
      // A report that cannot be built still yields a PDF. It yields one that
      // says the narrative could not be produced, because a missing page reads
      // as "there was nothing to refuse".
      narrative = {
        measured: [],
        refused: [{
          subject: 'Narrative',
          reason: `the report could not be generated for this period: ${err.message}`,
        }],
        limits: ['This file carries the figures only. Nothing below the KPI page is a claim about what was measured.'],
      }
    }

    const buf = renderQuarterlyReportPdf(kpi, {
      narrative,
      sections,
      coverage: quarterlyReportCoverage,
    })
    const filename = `lindela-kpi-${kpi.period.year}-${kpi.period.quarter}.pdf`
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': buf.length,
    })
    res.end(buf)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/kpi/quarterly') {
    const quarter = url.searchParams.get('quarter') || undefined
    const year = url.searchParams.get('year') || undefined
    try {
      const kpi = computeQuarterlyKpi(data, { quarter, year })
      jsonResponse(res, 200, { success: true, data: kpi })
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
    }
    return
  }

  // Equity routes
  if (req.method === 'GET' && url.pathname === '/api/v1/equity/by-district') {
    jsonResponse(res, 200, { success: true, data: equityByDistrict(data) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/equity/breaches') {
    const threshold = url.searchParams.has('threshold')
      ? Number(url.searchParams.get('threshold'))
      : undefined
    jsonResponse(res, 200, { success: true, data: detectAccuracyBreaches(data, threshold !== undefined ? { threshold } : {}) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/equity/scan') {
    const ids = await createEquityAuditWorkflows(store, data)
    jsonResponse(res, 201, { success: true, created: ids.length, ids })
    return
  }

  // Community feedback routes
  if (req.method === 'GET' && url.pathname === '/api/v1/community-feedback/summary') {
    jsonResponse(res, 200, { success: true, data: feedbackSummaryByAlert(data) })
    return
  }

  if (url.pathname === '/api/v1/community-feedback') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { success: true, ...collectionPage(data.community_feedback || [], url.searchParams, { auth: req.__auth, data, collection: 'community_feedback' }) })
      return
    }
    if (req.method === 'POST') {
      const body = await readRequestJson(req)
      let record
      try {
        record = normalizeCommunityFeedback(body)
      } catch (err) {
        jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
        return
      }
      const outboxRecord = await emit(store, 'community_feedback.created', { feedback_id: record.id })
      await store.merge({ community_feedback: [record] })
      jsonResponse(res, 201, { success: true, data: record, outbox_event: outboxRecord.id })
      return
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/assessments') {
    jsonResponse(res, 200, {
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        counts: counts(data),
        flood_risk: filterRecords(data.risk_scores.filter((risk) => risk.type === 'flood_risk'), url.searchParams, { auth: req.__auth, data, collection: 'risk_scores' }),
        climate_conflict_risk: filterRecords(data.risk_scores.filter((risk) => risk.type === 'climate_conflict_risk'), url.searchParams, { auth: req.__auth, data, collection: 'risk_scores' }),
        service_impacts: filterRecords(data.impact_assessments, url.searchParams, { auth: req.__auth, data, collection: 'impact_assessments' }),
        data_quality: filterRecords(data.data_quality, url.searchParams, { auth: req.__auth, data, collection: 'data_quality' }),
        operations: operationalSummary(data),
        alert_events: filterRecords(data.alert_events, url.searchParams, { auth: req.__auth, data, collection: 'alert_events' }),
        // The only record list on this route that was never scoped. Every
        // sibling above threads `auth`; this one did not, so a partner token
        // asking for /api/v1/assessments received every hazard and conflict
        // event in the platform while the four lists beside it were filtered.
        recent_events: filterRecords([...data.hazard_events, ...data.conflict_events], url.searchParams, { auth: req.__auth, data, collection: 'recent_events' }),
        // `calibrationReport` was exported, documented in the JTBD catalogue as
        // evidence this route "includes calibration metadata", and called from
        // nowhere. A claim in a catalogue is not a feature. It is here now, over
        // the same scoped score list its siblings use — otherwise a partner token
        // would learn mean confidence over scores it cannot see.
        calibration: calibrationReport({
          risk_scores: filterRecords(data.risk_scores, url.searchParams, { auth: req.__auth, data, collection: 'risk_scores' }),
        }),
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/export.geojson') {
    const records = filterRecords([
      ...data.hazard_events,
      ...data.conflict_events,
      ...data.service_assets,
      ...data.risk_scores,
      ...data.impact_assessments,
      ...data.incidents,
      ...data.field_reports,
      ...data.response_resources,
      ...data.alert_events,
    ], url.searchParams)
    jsonResponse(res, 200, toGeoJson(records), { 'content-type': 'application/geo+json; charset=utf-8' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/export.csv') {
    const records = filterRecords([
      ...data.hazard_events,
      ...data.conflict_events,
      ...data.risk_scores,
      ...data.impact_assessments,
      ...data.incidents,
      ...data.interventions,
      ...data.intervention_tasks,
      ...data.field_reports,
      ...data.response_resources,
      ...data.alert_rules,
      ...data.alert_events,
      ...data.rapidpro_dispatches,
      ...data.rapidpro_inbound_messages,
      ...data.service_assets,
    // No context at all, so this route had neither district resolution nor
    // tenant scoping. It is the single widest read in the API and the one
    // SEC-01 found serving field reports and message bodies unauthenticated.
    ], url.searchParams, { auth: req.__auth, data, collection: 'export' })
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="lindela-lite-export.csv"',
    })
    res.end(toCsv(records))
    return
  }

  // Nothing matched. The label becomes one bucket rather than one series
  // per path, which is the whole point: a scanner sending 2,000 unique
  // junk paths used to create 2,000 permanent series.
  res.locals.matchedRoute = null
  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

// A second mutation auth path used to live here — isAuthorizedMutation() —
// authorized by bare LINDELA_LITE_API_KEY comparison with no scope check, and
// was called from nowhere. Every mutation is gated in handleApi() instead. It
// was deleted rather than fixed: dead code that duplicates an authorization
// decision is a bypass waiting to be wired up.

async function handleIngestionRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.kind === 'status') {
    jsonResponse(res, 200, { success: true, data: ingestionStatus(data) })
    return
  }

  if (req.method === 'GET' && route.kind === 'schedules' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.ingestion_schedules, url.searchParams, { auth: req.__auth, data, collection: 'ingestion_schedules' }) })
    return
  }

  if (req.method === 'GET' && route.kind === 'schedules' && route.id) {
    const record = data.ingestion_schedules.find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && route.kind === 'defaults') {
    const body = await readRequestJson(req)
    const schedules = defaultIngestionSchedules(data, body)
    const logs = schedules.map((schedule) => actionLog('ingestion_schedules', 'created', schedule, body.actor, req.__auth?.subject))
    if (schedules.length) await store.merge({ ingestion_schedules: schedules, action_logs: logs })
    jsonResponse(res, 201, { success: true, created: schedules.length, data: schedules, action_logs: logs })
    return
  }

  if (req.method === 'POST' && route.kind === 'schedules' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeIngestionSchedule(body)
    const log = actionLog('ingestion_schedules', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ ingestion_schedules: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.kind === 'schedules' && route.id) {
    const body = await readRequestJson(req)
    const existing = data.ingestion_schedules.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return
    }
    const record = normalizeIngestionSchedule({ ...body, id: route.id }, existing)
    const log = actionLog('ingestion_schedules', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ ingestion_schedules: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'POST' && route.kind === 'run-due') {
    const body = await readRequestJson(req)
    const result = await runDueIngestionSchedules(store, data, body)
    const analytics = await refreshAnalytics(store)
    // The cycle the scheduler drives now ends by asking whether anything crossed
    // a threshold. This is the one line the deployed product was missing: a risk
    // score is a measurement, and an alert is what anyone does about it.
    //
    // `store.read()` rather than the request's `data`, because ingestion and
    // `refreshAnalytics` have both written since it was taken.
    const alerts = await evaluateAndPersistAlerts(store, await store.read(), {
      actor: body.actor || 'scheduled-ingest',
      subject: req.__auth?.subject,
    })
    const logs = [
      ...result.source_runs.map((run) => actionLog('source_runs', run.status, run, body.actor, req.__auth?.subject)),
      ...result.schedules.map((schedule) => actionLog('ingestion_schedules', 'ran', schedule, body.actor, req.__auth?.subject)),
    ]
    if (logs.length) await store.merge({ action_logs: logs })
    jsonResponse(res, 201, {
      success: true,
      data: result.source_runs,
      schedules: result.schedules,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
      alerts: { raised: alerts.raised.length, updated: alerts.updated.length },
      action_logs: logs,
    })
    return
  }

  if (req.method === 'POST' && route.kind === 'run-one' && route.id) {
    const body = await readRequestJson(req)
    const schedule = data.ingestion_schedules.find((item) => item.id === route.id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return
    }
    const ingestion = await runIngestion(store, {
      ...(schedule.default_options || {}),
      sources: [schedule.source],
      timeout_ms: schedule.timeout_ms,
      retries: schedule.retries,
      interval_minutes: schedule.interval_minutes,
      stale_after_minutes: schedule.stale_after_minutes,
      schedule_id: schedule.id,
      run_type: 'scheduled',
      ...body,
    })
    const completedAt = ingestion.source_runs[0]?.completed_at || new Date().toISOString()
    const nextSchedule = {
      ...schedule,
      last_run_at: completedAt,
      next_run_at: schedule.interval_minutes ? new Date(Date.parse(completedAt) + schedule.interval_minutes * 60 * 1000).toISOString() : schedule.next_run_at,
      updated_at: new Date().toISOString(),
    }
    const analytics = await refreshAnalytics(store)
    const logs = [
      ...ingestion.source_runs.map((run) => actionLog('source_runs', run.status, run, body.actor, req.__auth?.subject)),
      actionLog('ingestion_schedules', 'ran', nextSchedule, body.actor, req.__auth?.subject),
    ]
    await store.merge({ ingestion_schedules: [nextSchedule], action_logs: logs })
    jsonResponse(res, 201, {
      success: true,
      data: ingestion.source_runs,
      schedule: nextSchedule,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
      action_logs: logs,
    })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportingRoute(store, data, req, res, url, route) {
  if (route.kind === 'templates') {
    await handleReportTemplateRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'reports') {
    await handleReportRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'distributions') {
    await handleReportDistributionRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'schedules') {
    await handleReportScheduleRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'schedule-runs') {
    await handleReportScheduleRunRoute(store, data, req, res, url, route)
    return
  }
  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

async function handleReportTemplateRoute(store, data, req, res, url, route) {
  if (req.method === 'POST' && route.action === 'copy') {
    const body = await readRequestJson(req)
    const existing = data.report_templates.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report template not found' })
      return
    }
    const record = normalizeReportTemplate({
      ...existing,
      id: body.id,
      name: body.name || `${existing.name} Copy`,
      version: 1,
      created_at: undefined,
      updated_at: undefined,
    })
    const log = actionLog('report_templates', 'copied', record, body.actor, req.__auth?.subject)
    await store.merge({ report_templates: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_templates, url.searchParams, { auth: req.__auth, data, collection: 'report_templates' }) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = data.report_templates.find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Report template not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }
  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeReportTemplate(body)
    const log = actionLog('report_templates', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ report_templates: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    const existing = data.report_templates.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report template not found' })
      return
    }
    const record = normalizeReportTemplate({ ...body, id: route.id }, existing)
    const log = actionLog('report_templates', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ report_templates: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.exportFormat) {
    const report = data.reports.find((item) => item.id === route.id)
    if (!report) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    if (route.exportFormat === 'md') {
      const locale = url.searchParams.get('locale') || 'en'
      const plain = url.searchParams.get('plain') === '1'
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${report.id}.md"`,
      })
      res.end(renderReportMarkdown(report, { locale, plain }))
      return
    }
    if (route.exportFormat === 'csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${report.id}-appendix.csv"`,
      })
      res.end(toCsv(recordsForReportSources(report, data)))
      return
    }
    if (route.exportFormat === 'geojson') {
      jsonResponse(res, 200, toGeoJson(recordsForReportSources(report, data)), { 'content-type': 'application/geo+json; charset=utf-8' })
      return
    }
    jsonResponse(res, 200, { success: true, data: report })
    return
  }

  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.reports, url.searchParams, { auth: req.__auth, data, collection: 'reports' }) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = data.reports.find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }
  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    let record = normalizeReport(body, data)
    if (body.generate) record = generateReportSections(record, data, body)
    const log = actionLog('reports', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    try { await emit(store, 'report.created', record) } catch {}
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'PATCH' && route.id && !route.action) {
    const body = await readRequestJson(req)
    const existing = data.reports.find((item) => item.id === route.id)
    const record = updateReport(existing, body, data)
    const log = actionLog('reports', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'generate') {
    const body = await readRequestJson(req)
    const existing = data.reports.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    if (['approved', 'distributed'].includes(existing.status)) {
      jsonResponse(res, 409, { success: false, error: 'Approved or distributed reports cannot be regenerated' })
      return
    }
    const record = generateReportSections(existing, data, body)
    const log = actionLog('reports', 'generated', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'approve') {
    const body = await readRequestJson(req)
    const existing = data.reports.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    const record = approveReport(existing, body.actor)
    const log = actionLog('reports', 'approved', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'distribute') {
    const body = await readRequestJson(req)
    const existing = data.reports.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    const result = await distributeReport(existing, body, body.actor, data)
    const record = result.report
    const log = actionLog('reports', 'distributed', record, body.actor, req.__auth?.subject)
    await store.merge({
      reports: [record],
      report_distribution_runs: result.runs,
      rapidpro_dispatches: result.rapidproDispatches,
      action_logs: [log, ...result.runs.map((run) => actionLog('report_distribution_runs', run.status, run, body.actor, req.__auth?.subject))],
    })
    try { await emit(store, 'report.distributed', record) } catch {}
    jsonResponse(res, 201, { success: result.runs.every((run) => run.status !== 'failed'), data: result.runs, report: record, action_log: log })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportDistributionRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_distribution_runs, url.searchParams, { auth: req.__auth, data, collection: 'report_distribution_runs' }) })
    return
  }
  const run = data.report_distribution_runs.find((item) => item.id === route.id)
  if (!run) {
    jsonResponse(res, 404, { success: false, error: 'Report distribution not found' })
    return
  }
  if (req.method === 'GET' && !route.action) {
    jsonResponse(res, 200, { success: true, data: run })
    return
  }
  if (req.method === 'POST' && route.action === 'retry') {
    const body = await readRequestJson(req)
    const report = data.reports.find((item) => item.id === run.report_id)
    if (!report) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    const result = await distributeReport(report, { channels: [{ ...(run.options || {}), channel: run.channel, recipients: run.recipients }], retry_of: run.id }, body.actor, data)
    await store.merge({
      reports: [result.report],
      report_distribution_runs: result.runs,
      rapidpro_dispatches: result.rapidproDispatches,
      action_logs: result.runs.map((item) => actionLog('report_distribution_runs', item.status, item, body.actor, req.__auth?.subject)),
    })
    jsonResponse(res, 201, { success: result.runs.every((item) => item.status !== 'failed'), data: result.runs })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportScheduleRoute(store, data, req, res, url, route) {
  if (route.kind === 'schedule-runs') {
    await handleReportScheduleRunRoute(store, data, req, res, url, route)
    return
  }

  if (req.method === 'POST' && route.action === 'run-due') {
    const body = await readRequestJson(req)
    const result = await runDueReportSchedules(data, body.actor)
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.runs, reports: result.reports, distributions: result.distributions })
    return
  }
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_schedules, url.searchParams, { auth: req.__auth, data, collection: 'report_schedules' }) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = data.report_schedules.find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }
  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeReportSchedule(body, data)
    const log = actionLog('report_schedules', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ report_schedules: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    const existing = data.report_schedules.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    const record = normalizeReportSchedule({ ...body, id: route.id }, data, existing)
    const log = actionLog('report_schedules', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ report_schedules: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'run') {
    const body = await readRequestJson(req)
    const schedule = data.report_schedules.find((item) => item.id === route.id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    const result = await runReportSchedule(data, schedule, body.actor)
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.scheduleRun, report: result.report, distributions: result.distributions })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportScheduleRunRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_schedule_runs, url.searchParams, { auth: req.__auth, data, collection: 'report_schedule_runs' }) })
    return
  }
  const run = data.report_schedule_runs.find((item) => item.id === route.id)
  if (!run) {
    jsonResponse(res, 404, { success: false, error: 'Report schedule run not found' })
    return
  }
  if (req.method === 'GET' && !route.action) {
    jsonResponse(res, 200, { success: true, data: run })
    return
  }
  if (req.method === 'POST' && route.action === 'retry') {
    const body = await readRequestJson(req)
    const schedule = data.report_schedules.find((item) => item.id === run.schedule_id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    const result = await runReportSchedule(data, schedule, body.actor)
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.scheduleRun, report: result.report, distributions: result.distributions })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function distributeReport(report, body = {}, actor = 'operator', data = null) {
  if (!['ready', 'approved', 'distributed'].includes(report.status)) {
    throw Object.assign(new Error('Report must be ready or approved before distribution'), { statusCode: 400 })
  }
  const channels = normalizeDistributionChannels(body, report)
  const runs = []
  const rapidproDispatches = []
  for (const channel of channels) {
    const runInput = {
      channel: channel.channel,
      recipients: channel.recipients || recipientFields(channel),
      payload_summary: formatReportSmsSummary(report),
      options: channel,
      retry_of: body.retry_of || null,
    }
    try {
      if (['markdown_download', 'json', 'csv', 'geojson'].includes(channel.channel)) {
        const appendixRecords = data ? recordsForReportSources(report, data) : []
        const responseBody = {
          markdown_download: { bytes: renderReportMarkdown(report).length },
          json: { report_id: report.id },
          csv: { records: appendixRecords.length },
          geojson: { features: toGeoJson(appendixRecords).features.length },
        }[channel.channel]
        runs.push(normalizeDistributionRun({ ...runInput, status: 'prepared', response_body: responseBody }, report))
      } else if (channel.channel === 'webhook') {
        const response = await fetch(required(channel.url, 'url'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(channel.headers || {}) },
          body: JSON.stringify({ report, markdown: renderReportMarkdown(report) }),
        })
        const responseBody = await readExternalResponse(response)
        runs.push(normalizeDistributionRun({
          ...runInput,
          status: response.ok ? 'sent' : 'failed',
          response_status: response.status,
          response_body: responseBody,
          error: response.ok ? null : `Webhook HTTP ${response.status}`,
        }, report))
      } else if (channel.channel === 'rapidpro_sms') {
        const summary = channel.text || formatReportSmsSummary(report)
        const dispatch = await sendRapidProReportSummary(report, summary, channel)
        rapidproDispatches.push(dispatch)
        runs.push(normalizeDistributionRun({
          ...runInput,
          status: dispatch.status === 'sent' ? 'sent' : 'failed',
          response_status: dispatch.response_status,
          response_body: dispatch.response_body,
          error: dispatch.error,
        }, report))
      } else {
        throw Object.assign(new Error('channel must be markdown_download, json, csv, geojson, webhook, or rapidpro_sms'), { statusCode: 400 })
      }
    } catch (error) {
      runs.push(normalizeDistributionRun({ ...runInput, status: 'failed', error: error.message }, report))
    }
  }
  const hasDeliveredArtifact = runs.some((run) => run.status !== 'failed')
  return { report: hasDeliveredArtifact ? markReportDistributed(report) : report, runs, rapidproDispatches, actor }
}

async function runDueReportSchedules(data, actor = 'operator') {
  const due = data.report_schedules.filter((schedule) => scheduleIsDue(schedule))
  const aggregate = emptyScheduleResult()
  for (const schedule of due) {
    const result = await runReportSchedule(data, schedule, actor)
    mergeScheduleResult(aggregate, result)
    data = {
      ...data,
      reports: result.report ? [...data.reports, result.report] : data.reports,
      report_schedules: data.report_schedules.map((item) => (item.id === result.schedule.id ? result.schedule : item)),
      report_schedule_runs: [...data.report_schedule_runs, result.scheduleRun],
      report_distribution_runs: [...data.report_distribution_runs, ...result.distributions],
      rapidpro_dispatches: [...data.rapidpro_dispatches, ...result.rapidproDispatches],
    }
  }
  return aggregate
}

async function runReportSchedule(data, schedule, actor = 'operator') {
  const startedAt = new Date().toISOString()
  const template = data.report_templates.find((item) => item.id === schedule.template_id)
  if (!template) {
    const completedAt = new Date().toISOString()
    const nextSchedule = {
      ...schedule,
      last_run_at: completedAt,
      next_run_at: computeNextRunAt(schedule, completedAt),
      updated_at: completedAt,
    }
    const scheduleRun = normalizeScheduleRun({ status: 'failed', started_at: startedAt, completed_at: completedAt, error: 'Template not found' }, nextSchedule)
    return {
      schedule: nextSchedule,
      scheduleRun,
      report: null,
      distributions: [],
      rapidproDispatches: [],
      writes: {
        report_schedules: [nextSchedule],
        report_schedule_runs: [scheduleRun],
        action_logs: [actionLog('report_schedule_runs', 'failed', scheduleRun, actor)],
      },
    }
  }
  let report = normalizeReport({
    template_id: template.id,
    owner: schedule.owner,
    distribution_defaults: schedule.distribution_defaults,
  }, data)
  report = generateReportSections(report, data)
  const distributions = []
  const rapidproDispatches = []
  if (schedule.auto_distribute) {
    const distribution = await distributeReport({ ...report, status: 'approved' }, { channels: schedule.distribution_defaults }, actor, data)
    report = distribution.report
    distributions.push(...distribution.runs)
    rapidproDispatches.push(...distribution.rapidproDispatches)
  }
  const now = new Date().toISOString()
  const nextSchedule = {
    ...schedule,
    last_run_at: now,
    next_run_at: computeNextRunAt(schedule, now),
    updated_at: now,
  }
  const scheduleRun = normalizeScheduleRun({ status: 'completed', started_at: startedAt, completed_at: now }, schedule, report)
  return {
    schedule: nextSchedule,
    scheduleRun,
    report,
    distributions,
    rapidproDispatches,
    writes: {
      reports: [report],
      report_schedules: [nextSchedule],
      report_schedule_runs: [scheduleRun],
      report_distribution_runs: distributions,
      rapidpro_dispatches: rapidproDispatches,
      action_logs: [
        actionLog('reports', 'generated', report, actor),
        actionLog('report_schedule_runs', 'completed', scheduleRun, actor),
        ...distributions.map((run) => actionLog('report_distribution_runs', run.status, run, actor)),
      ],
    },
  }
}

function normalizeDistributionChannels(body, report) {
  const configured = body.channels || (body.channel ? [body] : report.distribution_defaults)
  const channels = Array.isArray(configured) ? configured : [configured]
  return channels.length ? channels.map((channel) => (typeof channel === 'string' ? { channel } : channel)) : [{ channel: 'markdown_download' }]
}

function recipientFields(channel) {
  return {
    urns: channel.urns || [],
    contacts: channel.contacts || [],
    groups: channel.groups || [],
    url: channel.url || null,
  }
}

function emptyScheduleResult() {
  return {
    runs: [],
    reports: [],
    distributions: [],
    rapidproDispatches: [],
    writes: {
      reports: [],
      report_schedules: [],
      report_schedule_runs: [],
      report_distribution_runs: [],
      rapidpro_dispatches: [],
      action_logs: [],
    },
  }
}

function mergeScheduleResult(target, result) {
  target.runs.push(result.scheduleRun)
  if (result.report) target.reports.push(result.report)
  target.distributions.push(...result.distributions)
  target.rapidproDispatches.push(...result.rapidproDispatches)
  for (const [collection, records] of Object.entries(result.writes)) {
    target.writes[collection].push(...records)
  }
}

async function readExternalResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function handleRapidProRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.kind === 'status') {
    jsonResponse(res, 200, { success: true, data: rapidProStatus() })
    return
  }

  if (req.method === 'GET' && route.kind === 'response-metrics') {
    jsonResponse(res, 200, { success: true, data: responseMetrics(data) })
    return
  }

  if (req.method === 'GET' && route.kind === 'dispatches') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.rapidpro_dispatches, url.searchParams, { auth: req.__auth, data, collection: 'rapidpro_dispatches' }) })
    return
  }

  if (req.method === 'GET' && route.kind === 'inbound') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.rapidpro_inbound_messages, url.searchParams, { auth: req.__auth, data, collection: 'rapidpro_inbound_messages' }) })
    return
  }

  if (req.method === 'POST' && route.kind === 'send-alert') {
    const body = await readRequestJson(req)
    const alert = data.alert_events.find((item) => item.id === route.id)
    if (!alert) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return
    }
    const approvalState = alert.approval?.state || 'proposed'
    if (approvalState !== 'approved' && approvalState !== 'auto_approved') {
      jsonResponse(res, 409, { success: false, error: 'Alert not approved', current_state: approvalState })
      return
    }
    const dispatch = await sendRapidProAlert(alert, body)
    const log = actionLog('rapidpro_dispatches', dispatch.status === 'sent' ? 'sent' : 'failed', dispatch, body.actor, req.__auth?.subject)
    await store.merge({ rapidpro_dispatches: [dispatch], action_logs: [log] })
    jsonResponse(res, dispatch.status === 'sent' ? 201 : 502, { success: dispatch.status === 'sent', data: dispatch, action_log: log })
    return
  }

  if (req.method === 'POST' && route.kind === 'field-report') {
    req.rawBody = await readRawBody(req)
    if (!verifyRapidProWebhook(req, url)) {
      jsonResponse(res, 401, { success: false, error: 'Invalid RapidPro webhook secret' })
      return
    }
    const payload = await readRequestJson(req)
    const parsed = parseRapidProFieldReport(payload, data)
    const policy = await loadPolicy()
    let incident = parsed.report.incident_id ? data.incidents.find((item) => item.id === parsed.report.incident_id) : null
    const writes = { rapidpro_inbound_messages: [redactPii(parsed.inbound, policy)], action_logs: [] }
    if (!incident && !parsed.report.intervention_id) {
      incident = buildCreate('incidents', parsed.fallbackIncident, data)
      parsed.report.incident_id = incident.id
      writes.incidents = [incident]
      writes.action_logs.push(actionLog('incidents', 'created', incident, 'rapidpro'))
    }
    const report = buildCreate('field_reports', redactPii(parsed.report, policy), { ...data, incidents: incident ? [...data.incidents, incident] : data.incidents })
    parsed.inbound.field_report_id = report.id
    parsed.inbound.incident_id = report.incident_id
    parsed.inbound.intervention_id = report.intervention_id
    writes.field_reports = [report]
    writes.rapidpro_inbound_messages = [redactPii(parsed.inbound, policy)]
    writes.action_logs.push(actionLog('field_reports', 'created', report, 'rapidpro'))
    await store.merge(writes)
    jsonResponse(res, 201, { success: true, data: report, inbound: writes.rapidpro_inbound_messages[0], incident_created: Boolean(writes.incidents?.length) })
    return
  }

  // A reply is the acknowledgement half of two-way SMS. It sits behind the same
  // webhook verification as a field report: a reply that can close an SLA is
  // attacker-controlled input, so correlation is by sender address within a
  // bounded window, never by a payload-supplied alert_event_id.
  if (req.method === 'POST' && route.kind === 'rapidpro-reply') {
    if (!verifyRapidProWebhook(req, url)) {
      jsonResponse(res, 401, { success: false, error: 'Invalid webhook signature' })
      return
    }
    const body = await readRequestJson(req)
    const parsed = parseRapidProReply(body, data, {
      correlationWindowMinutes: Number(env.RAPIDPRO_REPLY_WINDOW_MINUTES || 1440),
    })
    if (!parsed.correlated) {
      // Recorded anyway. An unrecognised sender is information — it is what a
      // wrong number looks like — and dropping it makes the gap invisible.
      const orphan = redactPii({
        id: stableId('inbound', ['orphan', body.from, body.text, Date.now()]),
        text: body.text || '',
        contact_urn: body.from || '',
        event_type: 'reply_unmatched',
        created_at: new Date().toISOString(),
      }, policy)
      await store.merge({
        rapidpro_inbound_messages: [orphan],
        action_logs: [actionLog('rapidpro_inbound_messages', 'created', orphan, 'rapidpro', req.__auth?.subject)],
      })
      jsonResponse(res, 202, {
        success: true,
        correlated: false,
        recorded: orphan.id,
        reason: parsed.reason || 'no dispatch from this sender in the correlation window',
      })
      return
    }
    const writes = reconcileInbound(data, parsed)
    await store.merge(writes)
    jsonResponse(res, 200, { success: true, correlated: true, ...parsed })
    return
  }

  if (req.method === 'GET' && route.kind === 'delivery') {
    const report = deliveryReport(data, {
      alertEventId: url.searchParams.get('alert_event_id') || undefined,
    })
    jsonResponse(res, 200, { success: true, ...report, summary: formatDeliveryReport(report) })
    return
  }

  if (req.method === 'GET' && route.kind === 'escalations') {
    const due = dueEscalations(data, {
      now: Date.now(),
      minutes: url.searchParams.get('within_minutes') ? Number(url.searchParams.get('within_minutes')) : undefined,
    })
    jsonResponse(res, 200, {
      success: true,
      due: due.length,
      // What is not computed is as much of the answer as what is.
      escalatable: due.length ? 'escalations whose acknowledgement window has closed' : 'none due',
      data: due,
    })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

/**
 * Evaluate every active rule against the store and persist what moved.
 *
 * Extracted from the HTTP handler so there is exactly one implementation of
 * "evaluate and persist" and the route and the cycle cannot drift.
 *
 * This existed only as an HTTP handler, reachable only by `POST
 * /api/v1/alerts/evaluate`. The deployment's scheduler called
 * `/ingest/run-due` and `/report-schedules/run-due`; `run-due` computed risk
 * scores and returned. Nothing anywhere called this.
 *
 * So the shipped system ingested, scored, and **stopped**. A hazard crossing an
 * alert threshold produced a risk score in the database and nothing else: no
 * alert event, no SMS, no workflow instance, no log line. `|| true` in the
 * scheduler loop then swallowed any error from the cycle that did run.
 *
 * The README does not claim automatic alerting — it says the product "computes
 * transparent baseline risk scores, exposes formatted data through an API, and
 * provides a lightweight dashboard" — so this was a missing capability rather
 * than a false claim. It was still the core function, reachable only by hand.
 */
export async function evaluateAndPersistAlerts(store, data, { actor = null, subject = null } = {}) {
  const context = {
    counts: counts(data),
    operations: operationalSummary(data),
    data_quality: data.data_quality,
  }
  const { raised, updated } = evaluateAlertRules(data, context)
  const logs = [
    ...raised.map((event) => actionLog('alert_events', 'created', event, actor, subject)),
    ...updated.map((event) => actionLog('alert_events', event.status, event, actor, subject)),
  ]
  if (raised.length || updated.length) await store.merge({ alert_events: [...raised, ...updated], action_logs: logs })
  // Only a raised alert is a new fact. An updated one is the same alert with a
  // newer reading, or one that has just been closed, and neither is something
  // a subscriber asked to be told about.
  for (const event of raised) {
    try {
      await emit(store, 'alert_event.created', event)
    } catch (emitError) {
      // A subscriber that cannot be reached is not a reason to abandon the
      // alert, which is already persisted above. Recorded rather than dropped.
      console.error('alert_event.created emit failed', emitError)
    }
  }
  return { raised, updated }
}

async function handleAlertEvaluation(store, data, req, res) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return
  }
  const body = await readRequestJson(req)
  const { raised, updated } = await evaluateAndPersistAlerts(store, data, {
    actor: body.actor,
    subject: req.__auth?.subject,
  })
  jsonResponse(res, 201, {
    success: true,
    evaluated: data.alert_rules.length,
    created: raised.length,
    updated: updated.length,
    data: raised,
  })
}

async function handleAlertRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.format === 'cap') {
    const record = data[route.collection].find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return
    }
    const xml = renderCapXml(record)
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
    res.end(xml)
    return
  }

  if (req.method === 'GET' && !route.id) {
    // The collection and store are passed so a district filter can attribute
    // records that carry no location of their own — interventions through their
    // incident, tasks through the intervention, dispatches through the alert
    // event — the same way districtOverview does. Without it those collections
    // matched nothing and a district reported no activity it plainly had.
    jsonResponse(res, 200, { success: true, ...collectionPage(data[route.collection], url.searchParams, { data, collection: route.collection }) })
    return
  }

  if (req.method === 'GET' && route.id) {
    const record = data[route.collection].find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id && route.collection === 'alert_rules') {
    const body = await readRequestJson(req)
    const record = normalizeAlertRule(body)
    const log = actionLog(route.collection, 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ alert_rules: [record], action_logs: [log] })
    try {
      await emit(store, 'alert_rule.created', record)
    } catch (emitError) {
      // Swallow emit errors to not break the request
    }
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.id && !route.action) {
    const body = await readRequestJson(req)
    const existing = data[route.collection].find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return
    }
    const record = route.collection === 'alert_rules'
      ? normalizeAlertRule({ ...existing, ...body, id: route.id }, existing)
      : updateAlertEvent(existing, body)
    const log = actionLog(route.collection, 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'POST' && route.id && route.action && route.collection === 'alert_events') {
    const body = await readRequestJson(req)
    const existing = data.alert_events.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return
    }
    const actor = body.actor || (req.__auth?.subject)
    if (!actor) {
      jsonResponse(res, 400, { success: false, error: 'actor is required' })
      return
    }
    const decision = route.action === 'approve' ? 'approved' : route.action === 'reject' ? 'rejected' : null
    if (!decision) {
      jsonResponse(res, 400, { success: false, error: 'Invalid approval action' })
      return
    }
    const record = approveAlertEvent(existing, actor, decision, body.note || '')
    const log = actionLog('alert_events', route.action, record, body.actor, req.__auth?.subject)
    await store.merge({ alert_events: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleTriggerRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.trigger_protocols || [], url.searchParams, { auth: req.__auth, data, collection: 'trigger_protocols' }) })
    return
  }

  if (req.method === 'GET' && route.id) {
    const record = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id && !route.action) {
    const body = await readRequestJson(req)
    const record = normalizeTriggerProtocol(body)
    const log = actionLog('trigger_protocols', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ trigger_protocols: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.id && !route.action) {
    const body = await readRequestJson(req)
    const existing = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    const record = normalizeTriggerProtocol({ ...existing, ...body, id: route.id }, existing)
    const log = actionLog('trigger_protocols', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ trigger_protocols: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'POST' && route.id && route.action === 'backtest') {
    const existing = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    const result = backtestTriggerProtocol(existing, data)
    const updated = { ...existing, backtest: { ...result, last_run_at: new Date().toISOString() } }
    const log = actionLog('trigger_protocols', 'backtest_run', updated, null, req.__auth?.subject)
    await store.merge({ trigger_protocols: [updated], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: updated, backtest_result: result, action_log: log })
    return
  }

  if (req.method === 'POST' && route.id && route.action === 'shadow-run') {
    const existing = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    const context = {
      counts: counts(data),
      data_quality: data.data_quality,
    }
    const result = evaluateInShadowMode(existing, context)
    jsonResponse(res, 200, { success: true, data: result })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleOperationalRoute(store, data, req, res, url, route) {
  const includeDeleted = url.searchParams.get('include_deleted') === 'true'

  if (req.method === 'GET' && !route.id) {
    const records = includeDeleted ? data[route.collection] : data[route.collection].filter((item) => !isDeleted(item))
    jsonResponse(res, 200, { success: true, ...collectionPage(records, url.searchParams, { data, collection: route.collection }) })
    return
  }

  if (req.method === 'GET' && route.id) {
    // Through `filterRecords`, so a by-id read carries the same tenant predicate
    // as the list form.
    //
    // This was `data[route.collection].find((item) => item.id === route.id)` with
    // no scoping expression at all — so given an id from any listing, partner A
    // read partner B's single record directly. There was nothing to bypass
    // because there was nothing there: the list form's missing context was a
    // bug, and this was the same bug with no predicate to remove.
    //
    // Routed through the list helper rather than reimplementing the predicate,
    // so the two forms cannot diverge again. `unlimited` because there is at
    // most one match.
    const [record] = filterRecords(data[route.collection], new URLSearchParams(''), {}, { unlimited: true })
      .filter((item) => item.id === route.id)
    if (!record || (isDeleted(record) && !includeDeleted)) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only' })
      return
    }
    const body = await readRequestJson(req)
    const record = buildCreate(route.collection, body, data)
    const log = actionLog(route.collection, 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    if (route.collection === 'incidents') {
      try {
        await emit(store, 'incident.created', record)
      } catch (emitError) {
        // Swallow emit errors
      }
    }
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.id) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only' })
      return
    }
    const body = await readRequestJson(req)
    const existing = data[route.collection].find((item) => item.id === route.id)
    if (isDeleted(existing)) {
      jsonResponse(res, 409, { success: false, error: 'Record is deleted' })
      return
    }
    const record = buildUpdate(route.collection, existing, { ...body, id: route.id }, data)
    const log = actionLog(route.collection, 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'DELETE' && route.id) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only' })
      return
    }
    const body = await readRequestJson(req)
    const existing = data[route.collection].find((item) => item.id === route.id)
    const record = buildSoftDelete(route.collection, existing, body.actor || req.__auth?.subject, data)
    const log = actionLog(route.collection, 'deleted', record, body.actor || req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

/**
 * GET /api/v1/flood-depth
 *
 * Query:
 *   lat, lon            point probe (returns depth at each requested level)
 *   level_m             repeat or comma-separated water levels, metres
 *   south,west,north,east  box mode, returns a depth grid + GeoJSON extent
 *   grid_size           grid resolution in cells (default 32, max 256)
 *   terrain=1           include local terrain context around the point
 *
 * Returns 400 for malformed input and 200 with data_available=false when no
 * terrain covers the location, rather than guessing.
 */
async function handleFloodDepth(url, res) {
  // Number(null) is 0, so a missing or blank parameter would silently become
  // a valid-looking coordinate. Read raw strings and validate explicitly.
  const rawLat = url.searchParams.get('lat')
  const rawLon = url.searchParams.get('lon')
  const lat = rawLat === null || rawLat.trim() === '' ? NaN : Number(rawLat)
  const lon = rawLon === null || rawLon.trim() === '' ? NaN : Number(rawLon)

  const rawLevels = url.searchParams.getAll('level_m').length
    ? url.searchParams.getAll('level_m')
    : (url.searchParams.get('levels_m') || url.searchParams.get('level_m') || '')
  const levels = parseLevels(rawLevels)
  const rawGridSize = url.searchParams.get('grid_size')
  const gridSize = rawGridSize === null || rawGridSize.trim() === '' ? 32 : Number(rawGridSize)

  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon)
  const boxParams = ['south', 'west', 'north', 'east'].map((key) => {
    const raw = url.searchParams.get(key)
    return raw === null || raw.trim() === '' ? NaN : Number(raw)
  })
  const [south, west, north, east] = boxParams
  const hasBox = boxParams.every(Number.isFinite)
  const wantsTerrain = url.searchParams.get('terrain') === '1'

  if (!hasPoint && !hasBox) {
    jsonResponse(res, 400, {
      success: false,
      error: 'Provide lat and lon for a point probe, or south/west/north/east for an area grid',
    })
    return true
  }
  if (levels === null) {
    jsonResponse(res, 400, { success: false, error: 'level_m must be a number, or a comma-separated list of numbers' })
    return true
  }
  if (!levels.length) {
    jsonResponse(res, 400, { success: false, error: 'Provide at least one level_m (water surface elevation, metres)' })
    return true
  }
  if (levels.some((level) => level < -500 || level > 9000)) {
    jsonResponse(res, 400, {
      success: false,
      error: 'level_m out of range: expected a plausible water surface elevation between -500 and 9000 metres',
    })
    return true
  }

  try {
    if (hasPoint && wantsTerrain) {
      const [context, profile] = await Promise.all([
        terrainContext(lat, lon),
        depthProfile(lat, lon, { levels_m: levels }),
      ])
      jsonResponse(res, 200, { success: true, data: { ...profile, terrain: context } })
      return true
    }

    if (hasPoint) {
      const profile = await depthProfile(lat, lon, { levels_m: levels })
      jsonResponse(res, 200, { success: true, data: profile })
      return true
    }

    const grid = await depthGrid({ south, west, north, east, levelM: levels, gridSize })
    jsonResponse(res, 200, { success: true, data: grid })
  } catch (error) {
    jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
  }
  return true
}

/**
 * Parses a comma-separated list of levels. Returns null when the caller asked
 * for a level list that contains something unparseable, so a typo is reported
 * rather than silently treated as "no levels given" and then defaulted to 0.
 */
function parseLevels(raw) {
  const parts = String(raw || '').split(',').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return []
  const values = []
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value)) return null
    values.push(value)
  }
  return values
}

async function handleWebhookRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.webhook_subscriptions || [], url.searchParams, { auth: req.__auth, data, collection: 'webhook_subscriptions' }) })
    return
  }

  if (req.method === 'GET' && route.id) {
    const record = (data.webhook_subscriptions || []).find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Webhook subscription not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    try {
      const record = normalizeWebhookSubscription(body)
      const log = actionLog('webhook_subscriptions', 'created', record, body.actor, req.__auth?.subject)
      await store.merge({ webhook_subscriptions: [record], action_logs: [log] })
      jsonResponse(res, 201, { success: true, data: record, action_log: log })
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
    }
    return
  }

  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    const existing = (data.webhook_subscriptions || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Webhook subscription not found' })
      return
    }
    try {
      const record = normalizeWebhookSubscription({ ...body, id: route.id }, existing)
      const log = actionLog('webhook_subscriptions', 'updated', record, body.actor, req.__auth?.subject)
      await store.merge({ webhook_subscriptions: [record], action_logs: [log] })
      jsonResponse(res, 200, { success: true, data: record, action_log: log })
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
    }
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

function matchWebhookRoute(pathname) {
  const match = pathname.match(/^\/api\/v1\/webhooks(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

function matchScenarioRoute(pathname) {
  if (pathname === '/api/v1/scenarios') return { kind: 'create' }
  const match = pathname.match(/^\/api\/v1\/scenarios\/([^/]+)$/)
  if (match) return { kind: 'retrieve', token: decodeURIComponent(match[1]) }
  return null
}

function matchParametricRoute(pathname) {
  if (pathname === '/api/v1/parametric-rules') return { kind: 'rules-list' }
  const ruleMatch = pathname.match(/^\/api\/v1\/parametric-rules\/([^/]+)$/)
  if (ruleMatch) return { kind: 'rule-detail', id: decodeURIComponent(ruleMatch[1]) }
  const simMatch = pathname.match(/^\/api\/v1\/parametric-rules\/([^/]+)\/simulate$/)
  if (simMatch) return { kind: 'simulate', id: decodeURIComponent(simMatch[1]) }
  if (pathname === '/api/v1/parametric-disbursements') return { kind: 'disbursements-list' }
  return null
}

async function handleParametricRoute(store, data, req, res, url, route) {
  const auth = req.__auth || {}
  const isAdmin = auth.scope === 'admin:*' || (Array.isArray(auth.scopes) && auth.scopes.includes('admin:*'))
  const isOperator = isAdmin || auth.scope === 'role:operator' || (Array.isArray(auth.scopes) && auth.scopes.includes('role:operator'))

  if (route.kind === 'rules-list') {
    if (req.method === 'GET') {
      const rules = data.parametric_rules || []
      jsonResponse(res, 200, { success: true, data: rules, count: rules.length })
      return
    }
    if (req.method === 'POST') {
      const body = await readRequestJson(req)
      try {
        const rule = normalizeParametricRule(body)
        // The money path wrote no action log: a rule that defines what gets
        // paid, to whom, on what condition, could be created or edited with
        // nothing recording who did it.
        const log = actionLog('parametric_rules', 'created', rule, body.actor, req.__auth?.subject)
        const updated = {
          ...data,
          parametric_rules: [...(data.parametric_rules || []), rule],
          action_logs: [...(data.action_logs || []), log],
        }
        await store.write(updated)
        jsonResponse(res, 201, { success: true, data: rule, action_log: log })
      } catch (err) {
        jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      }
      return
    }
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return
  }

  if (route.kind === 'rule-detail') {
    const existing = (data.parametric_rules || []).find((r) => r.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Parametric rule not found' })
      return
    }
    if (req.method === 'GET') {
      jsonResponse(res, 200, { success: true, data: existing })
      return
    }
    if (req.method === 'PATCH') {
      const body = await readRequestJson(req)
      try {
        const updated_rule = normalizeParametricRule(body, existing)
        const rules = (data.parametric_rules || []).map((r) => r.id === route.id ? updated_rule : r)
        const log = actionLog('parametric_rules', 'updated', updated_rule, body.actor, req.__auth?.subject)
        await store.write({ ...data, parametric_rules: rules, action_logs: [...(data.action_logs || []), log] })
        jsonResponse(res, 200, { success: true, data: updated_rule, action_log: log })
      } catch (err) {
        jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      }
      return
    }
    // A hard delete, with the removed rule carried whole in the action log
    // rather than a summary of it. The rule defined what gets paid, to whom and
    // on what condition; a delete that left only "a rule was deleted" behind
    // would break the audit chain at exactly the point someone needed to know
    // what had been in force. CE-10 preferred archiving over deleting so the
    // chain survives; this copy is that archive, and an archived rule would stay
    // in the simulator picker as something still selectable.
    if (req.method === 'DELETE') {
      const rules = (data.parametric_rules || []).filter((r) => r.id !== route.id)
      const log = actionLog('parametric_rules', 'deleted', existing, null, req.__auth?.subject, {
        removed_rule: existing,
      })
      await store.write({ ...data, parametric_rules: rules, action_logs: [...(data.action_logs || []), log] })
      jsonResponse(res, 200, { success: true, data: { id: route.id, deleted: true }, action_log: log })
      return
    }
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return
  }

  if (route.kind === 'simulate') {
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
      return
    }
    const rule = (data.parametric_rules || []).find((r) => r.id === route.id)
    if (!rule) {
      jsonResponse(res, 404, { success: false, error: 'Parametric rule not found' })
      return
    }
    const body = await readRequestJson(req)
    try {
      const recipientName = body.recipient_name || body.recipient || null
      let sanctions = null
      if (recipientName) {
        try {
          const screened = await screenNames([recipientName], { retries: 0 })
          sanctions = {
            screened: true,
            matches: screened.matches,
            blocked: screened.matches.length > 0,
            reason: `screened "${recipientName}" against the OFAC SDN list`,
          }
        } catch (screenError) {
          // Screening is advisory: surface the failure but do not silently
          // treat an unreachable list as a clean result.
          sanctions = {
            screened: false,
            matches: [],
            blocked: false,
            error: screenError.message,
            reason: `screening "${recipientName}" failed: ${screenError.message}`,
          }
        }
      } else {
        // No recipient was supplied, so nothing was screened. Recorded rather
        // than left as a bare false, because a compliance reader must be able to
        // see that this disbursement never went near the SDN list.
        sanctions = {
          screened: false,
          matches: [],
          blocked: false,
          reason: 'no recipient name supplied, so no name was screened against the OFAC SDN list',
        }
      }

      // The trigger is evaluated against the platform's own state, the same
      // context alert rules see, so a parametric payout is decided by the data
      // rather than asserted by the caller. An explicit trigger_value overrides
      // it, for an operator quoting an observation the store has not ingested.
      const context = {
        counts: counts(data),
        operations: operationalSummary(data),
        data_quality: data.data_quality,
      }
      // An approval backed by a workflow instance is verified; one asserted in
      // the request body is recorded as asserted. `focal_point_approved` still
      // gates, but the disbursement now carries where the approval came from,
      // and a named instance that is not actually approved is rejected.
      const approval = resolveFocalPointApproval(data, rule, body)
      const result = simulateDisbursement(rule, {
        actor: body.actor || auth.subject || null,
        focal_point_approved: approval.approved,
        approval,
        sanctions,
        context,
        triggerValue: body.trigger_value,
      })
      const log = actionLog('parametric_disbursements', 'simulated', result, body.actor, req.__auth?.subject)
      const disbursements = [...(data.parametric_disbursements || []), result]
      await store.write({ ...data, parametric_disbursements: disbursements, action_logs: [...(data.action_logs || []), log] })
      jsonResponse(res, 201, { success: true, data: result, sanctions })
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, {
        success: false,
        error: err.message,
        ...(err.sanctions ? { sanctions: err.sanctions } : {}),
      })
    }
    return
  }

  if (route.kind === 'disbursements-list') {
    if (req.method === 'GET') {
      const disbursements = data.parametric_disbursements || []
      jsonResponse(res, 200, { success: true, data: disbursements, count: disbursements.length })
      return
    }
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return
  }

  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

function matchChwRoute(pathname) {
  if (pathname === '/api/v1/chw/report') return { kind: 'report' }
  if (pathname === '/api/v1/chw/reply') return { kind: 'reply' }
  return null
}

async function handleChwRoute(store, data, req, res, url, route) {
  const policy = await loadPolicy()

  if (req.method === 'POST' && route.kind === 'report') {
    const body = await readRequestJson(req)
    const now = new Date().toISOString()
    // Location is nullable on purpose. It used to be `|| 0`, which turned a
    // missing fix, an explicit null and a real zero alike into latitude 0,
    // longitude 0 — Null Island, in the ocean off West Africa. A field report
    // is a disease signal, and a signal placed at a fixed ocean coordinate is
    // worse than one with no coordinate at all: it looks located, so cluster
    // detection and any "facilities near this report" join treat it as real.
    //
    // When there is no fix, the record says so via location_source, so a caller
    // can tell "the CHW is standing in it" from "we do not know where".
    const reportedLat = Number(body.location?.latitude)
    const reportedLon = Number(body.location?.longitude)
    const hasFix = Number.isFinite(reportedLat) && Number.isFinite(reportedLon)
      && !(reportedLat === 0 && reportedLon === 0)
    const record = {
      id: stableId('report', [body.description, body.location?.latitude, body.location?.longitude, now]),
      summary: body.description,
      category: body.category || body.kind,
      status: 'new',
      source: 'chw_web',
      latitude: hasFix ? reportedLat : null,
      longitude: hasFix ? reportedLon : null,
      location_source: hasFix
        ? (body.location?.source === 'gps' ? 'gps' : 'reported')
        : (body.location?.source || 'unknown'),
      location_accuracy_m: hasFix && Number.isFinite(Number(body.location?.accuracy_m))
        ? Number(body.location.accuracy_m)
        : null,
      reported_by: req.__auth?.subject,
      created_at: now,
      updated_at: now,
    }

    // One policy for both records written here. `anonymous` is a per-request
    // opt-in from the reporter; absent, it leaves the name to the loaded
    // default. The phone is redacted either way — a CHW who does not ask to be
    // named has not agreed to be called.
    const policy = {
      redactNames: body.anonymous,
      redactPhone: true,
      coarsenGeoToH3Cell: 3,
    }

    const redacted = redactPii(record, policy)

    // The reporter's name and number live on the inbound record, not on the
    // field report. Redacting `record` and then handing `body` straight to the
    // inbound built it with — which is what this used to do — means the redactor
    // saw an object that never had the fields and passed them through untouched,
    // so both survived into `GET /api/v1/rapidpro/inbound` and export.csv. The
    // RapidPro path redacts the object it is about to store; this now does too.
    const inbound = redactPii({
      id: stableId('inbound', [redacted.id, now]),
      text: body.description,
      contact_urn: body.reporter_phone || '',
      contact_name: body.reporter_name || '',
      event_type: 'field_report',
      created_at: now,
    }, policy)
    inbound.field_report_id = redacted.id

    const log = actionLog('field_reports', 'created', redacted, 'chw_web', req.__auth?.subject)
    await store.merge({
      field_reports: [redacted],
      rapidpro_inbound_messages: [inbound],
      action_logs: [log],
    })
    jsonResponse(res, 201, { success: true, data: redacted })
    return
  }

  if (req.method === 'POST' && route.kind === 'reply') {
    const body = await readRequestJson(req)
    const now = new Date().toISOString()
    const inbound = {
      id: stableId('inbound', [body.alert_event_id, body.message, now]),
      text: body.message,
      event_type: 'chw_reply',
      alert_event_id: body.alert_event_id,
      created_at: now,
    }

    const log = actionLog('rapidpro_inbound_messages', 'created', inbound, 'chw_web', req.__auth?.subject)
    await store.merge({
      rapidpro_inbound_messages: [inbound],
      action_logs: [log],
    })
    jsonResponse(res, 201, { success: true, data: inbound })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

function matchOperationalRoute(pathname) {
  const routes = {
    incidents: 'incidents',
    interventions: 'interventions',
    tasks: 'intervention_tasks',
    'field-reports': 'field_reports',
    'response-resources': 'response_resources',
    'action-logs': 'action_logs',
    // Absent here, so `GET /api/v1/service-assets/<id>` matched nothing and 404'd
    // while the collection itself served fine. A caller holding an asset id —
    // the subject panel, the routing endpoint's own error message — had no way
    // to resolve one record.
    'service-assets': 'service_assets',
  }
  const match = pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !routes[match[1]]) return null
  return { collection: routes[match[1]], id: match[2] ? decodeURIComponent(match[2]) : null }
}

function matchIngestionRoute(pathname) {
  if (pathname === '/api/v1/ingest/status') return { kind: 'status' }
  if (pathname === '/api/v1/ingest/run-due') return { kind: 'run-due' }
  if (pathname === '/api/v1/ingest/schedules/defaults') return { kind: 'defaults' }
  const runOne = pathname.match(/^\/api\/v1\/ingest\/schedules\/([^/]+)\/run$/)
  if (runOne) return { kind: 'run-one', id: decodeURIComponent(runOne[1]) }
  const schedule = pathname.match(/^\/api\/v1\/ingest\/schedules(?:\/([^/]+))?$/)
  if (schedule) return { kind: 'schedules', id: schedule[1] ? decodeURIComponent(schedule[1]) : null }
  return null
}

function matchReportingRoute(pathname) {
  if (pathname === '/api/v1/report-schedules/run-due') return { kind: 'schedules', action: 'run-due' }
  const scheduleRunAction = pathname.match(/^\/api\/v1\/report-schedule-runs\/([^/]+)\/(retry)$/)
  if (scheduleRunAction) return { kind: 'schedule-runs', id: decodeURIComponent(scheduleRunAction[1]), action: scheduleRunAction[2] }
  const reportExport = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/export\.(md|json|csv|geojson)$/)
  if (reportExport) return { kind: 'reports', id: decodeURIComponent(reportExport[1]), exportFormat: reportExport[2] }
  const templateAction = pathname.match(/^\/api\/v1\/report-templates\/([^/]+)\/(copy)$/)
  if (templateAction) return { kind: 'templates', id: decodeURIComponent(templateAction[1]), action: templateAction[2] }
  const reportAction = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/(generate|approve|distribute)$/)
  if (reportAction) return { kind: 'reports', id: decodeURIComponent(reportAction[1]), action: reportAction[2] }
  const distributionAction = pathname.match(/^\/api\/v1\/report-distributions\/([^/]+)\/(retry)$/)
  if (distributionAction) return { kind: 'distributions', id: decodeURIComponent(distributionAction[1]), action: distributionAction[2] }
  const scheduleAction = pathname.match(/^\/api\/v1\/report-schedules\/([^/]+)\/(run)$/)
  if (scheduleAction) return { kind: 'schedules', id: decodeURIComponent(scheduleAction[1]), action: scheduleAction[2] }
  const routes = {
    'report-templates': 'templates',
    reports: 'reports',
    'report-distributions': 'distributions',
    'report-schedules': 'schedules',
    'report-schedule-runs': 'schedule-runs',
  }
  const match = pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !routes[match[1]]) return null
  return { kind: routes[match[1]], id: match[2] ? decodeURIComponent(match[2]) : null }
}

function matchAlertRoute(pathname) {
  const capMatch = pathname.match(/^\/api\/v1\/alert-events\/([^/]+)\.cap$/)
  if (capMatch) return { collection: 'alert_events', id: decodeURIComponent(capMatch[1]), format: 'cap' }
  const actionMatch = pathname.match(/^\/api\/v1\/alert-events\/([^/]+)\/(approve|reject)$/)
  if (actionMatch) return { collection: 'alert_events', id: decodeURIComponent(actionMatch[1]), action: actionMatch[2] }
  const routes = {
    'alert-rules': 'alert_rules',
    'alert-events': 'alert_events',
  }
  const match = pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !routes[match[1]]) return null
  return { collection: routes[match[1]], id: match[2] ? decodeURIComponent(match[2]) : null }
}

function matchTriggerRoute(pathname) {
  const backtest = pathname.match(/^\/api\/v1\/trigger-protocols\/([^/]+)\/backtest$/)
  if (backtest) return { id: decodeURIComponent(backtest[1]), action: 'backtest' }
  const shadowRun = pathname.match(/^\/api\/v1\/trigger-protocols\/([^/]+)\/shadow-run$/)
  if (shadowRun) return { id: decodeURIComponent(shadowRun[1]), action: 'shadow-run' }
  const match = pathname.match(/^\/api\/v1\/trigger-protocols(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

function matchRapidProRoute(pathname) {
  if (pathname === '/api/v1/rapidpro/status') return { kind: 'status' }
  if (pathname === '/api/v1/rapidpro/response-metrics') return { kind: 'response-metrics' }
  if (pathname === '/api/v1/rapidpro/dispatches') return { kind: 'dispatches' }
  if (pathname === '/api/v1/rapidpro/inbound') return { kind: 'inbound' }
  if (pathname === '/api/v1/rapidpro/field-report') return { kind: 'field-report' }
  // A reply to an alert is the other half of two-way SMS: without it a
  // dispatch is fire-and-forget and nobody knows whether the message landed
  // or was acted on.
  if (pathname === '/api/v1/rapidpro/reply') return { kind: 'rapidpro-reply' }
  if (pathname === '/api/v1/rapidpro/delivery') return { kind: 'delivery' }
  if (pathname === '/api/v1/rapidpro/escalations') return { kind: 'escalations' }
  const sendAlert = pathname.match(/^\/api\/v1\/rapidpro\/alert-events\/([^/]+)\/send$/)
  if (sendAlert) return { kind: 'send-alert', id: decodeURIComponent(sendAlert[1]) }
  return null
}

/**
 * The audit proof is a verification, not a mutation, so it verifies by reading
 * the chain rather than by extending it.
 */
/**
 * `GET /api/v1/explain/{id}?kind=`
 *
 * Named rather than an inline regex so the route-coverage check can parse it
 * and so it sits with every other matcher here rather than inside a handler.
 */
function matchExplainRoute(pathname) {
  const match = pathname.match(/^\/api\/v1\/explain\/([^/]+)$/)
  if (!match) return null
  return { id: decodeURIComponent(match[1]) }
}

function matchAuditRoute(pathname) {
  if (pathname === '/api/v1/audit/verify') return { action: 'verify' }
  const head = pathname.match(/^\/api\/v1\/audit\/head$/)
  if (head) return { action: 'head' }
  return null
}

function matchWorkflowRoute(pathname) {
  const transition = pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/transition$/)
  if (transition) return { id: decodeURIComponent(transition[1]), action: 'transition' }
  if (pathname === '/api/v1/workflows/metrics') return { action: 'metrics' }
  const match = pathname.match(/^\/api\/v1\/workflows(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

async function handleWorkflowRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id && !route.action) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.workflow_instances, url.searchParams, { auth: req.__auth, data, collection: 'workflow_instances' }) })
    return
  }

  if (req.method === 'GET' && route.id && !route.action) {
    const record = data.workflow_instances.find((w) => w.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Workflow not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'GET' && route.action === 'metrics') {
    const metrics = workflowMetrics(data.workflow_instances)
    jsonResponse(res, 200, { success: true, data: metrics })
    return
  }

  if (req.method === 'POST' && !route.id && !route.action) {
    const body = await readRequestJson(req)
    const record = normalizeWorkflowInstance(body)
    const outboxRecord = await emit(store, 'workflow.created', { workflow_id: record.id, type: record.type })
    await store.merge({ workflow_instances: [record] })
    metrics.counter('workflow_created', { type: record.type })
    jsonResponse(res, 201, { success: true, data: record, outbox_event: outboxRecord.id })
    return
  }

  if (req.method === 'POST' && route.id && route.action === 'transition') {
    const existing = data.workflow_instances.find((w) => w.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Workflow not found' })
      return
    }
    const body = await readRequestJson(req)
    try {
      // Attribution follows the convention used by actionLog: the authenticated
      // subject is authoritative when there is one, and the caller's own stated
      // actor is kept separately rather than discarded. This previously read
      // `req.__auth?.subject || 'anonymous'`, so on an unauthenticated
      // deployment every transition — including who approved an anticipatory
      // alert — was recorded as "anonymous", and an actor the caller did supply
      // was thrown away. Preferring the verified subject is still correct: a
      // caller must not be able to claim an identity. The claim is recorded as a
      // claim, not promoted to authenticated.
      const claimedActor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : null
      const updated = transitionWorkflow(existing, {
        to: body.to,
        actor: req.__auth?.subject || claimedActor || 'anonymous',
        actor_source: req.__auth?.subject ? 'authenticated' : (claimedActor ? 'claimed' : 'unattributed'),
        claimed_actor: claimedActor,
        reason: body.reason || '',
        evidence: body.evidence || '',
      })
      const outboxRecord = await emit(store, 'workflow.transitioned', {
        workflow_id: updated.id,
        type: updated.type,
        from: existing.state,
        to: updated.state,
      })
      await store.merge({ workflow_instances: [updated] })
      metrics.counter('workflow_transition_total', { type: updated.type, from: existing.state, to: updated.state })
      jsonResponse(res, 200, { success: true, data: updated, outbox_event: outboxRecord.id })
      return
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
      return
    }
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleStatic(req, res, pathname) {
  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    // The deployment documentation is served from the image, and it was served
    // to anyone who could reach the port: an unauthenticated map of how this
    // deployment is put together — its store, its ports, its schedule
    // structure and its operational surface. Gated the same way `/metrics` is,
    // for the same reason: the two endpoints that answer before the API's auth
    // gate are the two that must not.
    //
    // Unauthenticated mode still reads the docs, because "no tokens configured"
    // is a deliberate local mode rather than an oversight — the same rule
    // `isAuthConfigured` applies everywhere else.
    if (isAuthConfigured()) {
      const docsAuth = authenticate(req)
      if (!docsAuth) {
        jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
        return
      }
    }
    await handleDocs(req, res, pathname)
    return
  }

  // The service worker is served no-cache so a fix reaches a device that
  // already has the app open; see sendFile's cache-control rules.
  const surfaces = ['', '/portal', '/chw', '/co', '/districts', '/focal-point', '/parametric', '/scenarios']
  const surface = surfaces.find((s) => pathname === s || pathname === `${s}/`)

  if (surface !== undefined) {
    const indexFile = path.join(publicDir, surface ? `${surface.replace(/^\//, '')}/index.html` : 'index.html')
    if (await sendFile(req, res, indexFile)) return
  }

  let filePath
  try {
    filePath = safeJoin(publicDir, pathname.replace(/^\/+/, '') || 'index.html')
  } catch {
    jsonResponse(res, 404, { success: false, error: 'Not found' })
    return
  }

  if (await sendFile(req, res, filePath)) return

  // A bare directory request that is not one of the known surfaces falls back
  // to the console rather than 404ing.
  const index = path.join(publicDir, 'index.html')
  if (await sendFile(req, res, index)) return

  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

async function handleDocs(req, res, pathname) {
  const target = pathname === '/docs' ? 'README.md' : pathname.replace(/^\/docs\/?/, '')
  let filePath
  try {
    filePath = safeJoin(docsDir, target)
  } catch {
    jsonResponse(res, 404, { success: false, error: 'Document not found' })
    return
  }
  if (await sendFile(req, res, filePath)) return
  jsonResponse(res, 404, { success: false, error: 'Document not found' })
}

function safeJoin(rootDir, target) {
  const filePath = path.resolve(rootDir, target || '')
  const relative = path.relative(rootDir, filePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Path is outside document root'), { statusCode: 404 })
  }
  return filePath
}

// =============================================================
// Static file serving
// =============================================================

/**
 * The dashboard ships ~64 KB gzipped across 17 files and was being served as
 * 232 KB of raw bytes, because nothing in this file compressed anything. The
 * binding constraint for this product is a field connection, not a data centre,
 * so that 3.6x was paid by exactly the users who can least afford it.
 */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/

function acceptsGzip(req) {
  const header = req?.headers?.['accept-encoding'] || ''
  // "gzip;q=0" is an explicit refusal; a bare substring test would ignore it.
  return /(^|,)\s*gzip\s*(;|,|$)/i.test(header) && !/gzip\s*;\s*q=0(\.0+)?\s*(;|,|$)/i.test(header)
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`timed out after ${ms}ms`)
        error.name = 'TimeoutError'
        reject(error)
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function etagFor(buffer) {
  // Content hash, so the validator changes exactly when the bytes change.
  return `W/"${createHash('sha1').update(buffer).digest('base64url')}"`
}

/**
 * Send a file, compressed and cached.
 *
 * One implementation, replacing fifteen near-identical readFile/writeHead/end
 * blocks that each decided caching independently — and none of which sent a
 * Cache-Control, so a deploy was not cacheable at all and every asset was
 * refetched on every load.
 */
async function sendFile(req, res, filePath, { immutable = false } = {}) {
  let content
  try {
    content = await fs.readFile(filePath)
  } catch {
    return false
  }

  const type = contentType(filePath)
  const etag = etagFor(content)
  const headers = {
    'content-type': type,
    etag,
    'last-modified': new Date().toUTCString(),
  }

  if (immutable) {
    // Asset filenames are not content-hashed, so a long max-age would pin an
    // operator to a stale build after a fix ships. Revalidate instead: cheap
    // with an ETag, and correct.
    headers['cache-control'] = 'public, max-age=0, must-revalidate'
  } else if (/\.(html|webmanifest)$/.test(filePath) || filePath.endsWith('sw.js')) {
    // The service worker must never be served stale, or a fix cannot reach a
    // device that already has the app open.
    headers['cache-control'] = 'no-cache'
  } else {
    headers['cache-control'] = 'public, max-age=3600, must-revalidate'
  }

  if (req?.headers?.['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return true
  }

  if (COMPRESSIBLE.test(type) && acceptsGzip(req) && content.length > 512) {
    const gzipped = gzipSync(content)
    headers['content-encoding'] = 'gzip'
    headers['vary'] = 'accept-encoding'
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : gzipped)
    return true
  }

  headers['content-length'] = content.length
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : content)
  return true
}

/**
 * Security headers for every response.
 *
 * There were none. The pages build markup with innerHTML, so a CSP is the
 * backstop that turns a missed escape from a full injection into a visible
 * failure. `unsafe-inline` is still needed for the per-page <style> blocks that
 * remain, and drops out as those are consolidated.
 */
function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('permissions-policy', 'geolocation=(), camera=(self), microphone=()')
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  )
}

function hasTraversalSegment(rawUrl) {
  const rawPath = rawUrl.split('?')[0]
  try {
    return decodeURIComponent(rawPath).split(/[\\/]+/).includes('..')
  } catch {
    return true
  }
}

async function getConnectorRegistry() {
  if (connectorRegistry === null) {
    try {
      const content = await fs.readFile(registryPath, 'utf8')
      connectorRegistry = JSON.parse(content)
    } catch {
      connectorRegistry = []
    }
  }
  return connectorRegistry
}

function getDefaultStore() {
  if (!defaultStorePromise) defaultStorePromise = createStoreFromEnv()
  return defaultStorePromise
}


function required(value, field) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 })
  }
  return value
}

function contentType(filePath) {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'text/yaml; charset=utf-8'
  if (filePath.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'text/html; charset=utf-8'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.LINDELA_LITE_PORT || 4177)
  createServer().listen(port, () => {
    // The driver owns what a tick includes; the sidecar still owns when ticks
    // happen. Both may run — the tick is idempotent and the heartbeat records
    // which came last.
    getDefaultStore().then(startPeriodicDriver).catch((error) => {
      console.error('periodic driver did not start; /health will report the pipeline as degraded', error)
    })
    console.log(`Lindela Lite listening on http://127.0.0.1:${port}`)
  })
}
