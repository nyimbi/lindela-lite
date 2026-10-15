import http from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticate, isAuthConfigured, isPublicPath, isPublicRequest } from './auth.js'
import { enforceAuthGate } from './routes/auth-gate.js'
import { corsResponseHeaders, isPreflight, preflightResponse } from './cors.js'
import { ERROR_CODES } from './errors.js'
import { logger, metrics, timer, runWithRequestId } from './observability.js'
import { evaluateAlertRules } from './alerts.js'
import {
  runDueIngestionSchedules,
  runIngestion,
} from './ingestion.js'
import { actionLog, counts, operationalSummary } from './operations.js'
import { createStoreFromEnv } from './storage.js'
import { budgetedStore, queryBudgetLimits, runWithQueryBudget, WIDE_QUERY_BUDGET } from './query-budget.js'
import { readReplicaStore } from './read-replica.js'
import { currentRequestAuth, filterRecords, jsonResponse, readRawBody, readRequestJson, runWithRequestContext } from './utils.js'
import { createIdempotencyFor } from './idempotency.js'
import { applyRetention, loadPolicy, retentionWindowFor } from './pii.js'
import { createInboundLimiter } from './inbound-rate-limit.js'
import { executeTriggerProtocols } from './protocols.js'
import { undeliveredDispatches, buildUndeliveredAlert } from './rapidpro.js'
import { collectionsForRequest, needsHistory } from './route-manifests.js'
import { matchStacRoute, matchOgcRoute, handleStacRoute } from './routes/stac.js'
import { ROUTE_FAMILIES, dispatchFamily } from './route-families.js'
import { emit, emitMany, dispatchPending } from './outbox.js'
import { createVintageIndex } from './vintage.js'
import { runFederationSync } from './federation-peers.js'
import { runDueReportSchedules } from './routes/reporting.js'
import { assertSafeWebhookUrl } from './webhooks.js'
import { createRequestRing } from './observability.js'
// The retention set belongs to the route module that owns the operation; the
// driver reads it rather than writing the same names out again. A re-export
// binds nothing locally, so the driver's loop needs its own import.
import { RETENTION_COLLECTIONS } from './routes/maintenance.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(__dirname, '../public')
const docsDir = path.resolve(__dirname, '../docs')

/**
 * QUA-01. The store a bare `createServer()` resolves, memoised per process.
 *
 * A server that was handed a store never reads this. It exists for the entry
 * point and for the tests that construct a server with no store at all, where
 * "the store this process configured" is the honest answer — and it is one
 * promise, so concurrent first requests share one connection rather than
 * racing to open two.
 */
let defaultStorePromise

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

/**
 * How long `POST /api/v1/demo/seed` will wait for live ingestion before giving
 * up on it and seeding the demo data alone.
 *
 * The default source set is nine third-party services. `ipc_hdx` alone fans ~92
 * requests against its declared 20/min budget, which is a floor of ~4.6 minutes
 * and was measured at 188 seconds end to end on a warm network. A request with
 * no ceiling is held open by whichever upstream is slowest, and the demo seed
 * is the one route whose useful half — the labelled demo data — does not depend
 * on any of them.
 *
 * The value lives in `src/routes/maintenance.js` now, beside the route that
 * reads it — ENH-60 moved the seed there. It is re-exported here because
 * `test/` and `scripts/` read it off this module and a constant is not worth a
 * second import site.
 */
export { DEMO_SEED_BUDGET_MS } from './routes/maintenance.js'

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
  { id: 'protocols', label: 'trigger protocol execution', run: (store, data) => executeTriggerProtocols(store, data) },
  // R-12's other half. Retention was reachable only by POSTing to a maintenance
  // route: a control that runs when somebody remembers it has run is a control
  // somebody will not remember. A privacy window that is never applied is a
  // comment in a JSON file, and the thing it was written to protect keeps
  // accumulating.
  { id: 'retention', label: 'retention', run: (store, data) => applyScheduledRetention(store, data) },
  // ENH-06. The escalation path only sees dispatches the gateway accepted, so a
  // failed one was invisible: the workflow instance sat in `chain_dispatched`
  // — a chain the system believes it ran — and nobody was ever told. This is the
  // pass that notices, and it raises one synthetic alert per original, ever.
  { id: 'reconcile', label: 'delivery reconciliation', run: (store, data) => reconcileUndeliveredDispatches(store, data) },
  // ENH-80. The federated exchange, on the same cadence as everything else.
  //
  // `runFederationSync` returns `ran: false` for a node with no peers rather than
  // failing, which is what makes this item safe to run on every deployment: the
  // driver's own contract is that one item failing must not stop the rest, and an
  // item that failed on every single-node installation forever would be an alarm
  // nobody can clear. A peer that is down *is* a failure, isolated to that peer —
  // `federate` catches it per peer, the others still exchange, and the heartbeat
  // names which one did not.
  { id: 'federation', label: 'federated exchange', run: (store, data) => runFederationSync(store, data) },
]

/** Raise an alert for every chain the system believes it dispatched and did not. */
export async function reconcileUndeliveredDispatches(store, data, { now = new Date().toISOString() } = {}) {
  const findings = undeliveredDispatches(data, { now })
  if (findings.length === 0) return { raised: 0, findings: [] }
  const alerts = findings.map((finding) => buildUndeliveredAlert(finding, { now }))
  const logs = alerts.map((alert) => actionLog('alert_events', 'created', alert, 'delivery-reconciliation', 'system'))
  await store.merge({ alert_events: alerts, action_logs: logs })
  for (const finding of findings) {
    logger.error('dispatch_reconciliation_gap', {
      alert_event_id: finding.original_alert_event_id,
      workflow_instance_id: finding.workflow_instance_id,
      message: 'a chain was entered and no notification was delivered',
    })
  }
  return { raised: alerts.length, findings }
}

/**
 * Expire every collection that has a window, on the driver's cadence.
 *
 * A policy with no positive window purges nothing and says so in the heartbeat
 * rather than silently — the DAT-07 failure mode was a retention job that
 * reported success forever.
 *
 * The collection set is `RETENTION_COLLECTIONS`, imported from the route module
 * rather than written out again here. It was a three-key object literal in this
 * function and a three-element array 1,200 lines away in
 * `src/routes/maintenance.js`, and the two disagreed once already (R-12): the
 * route refused on the general window while this expired each collection's own.
 * The test that caught it compared the two lists, which is a check standing in
 * for a derivation — one list is the fix, and the failure mode it removes is the
 * one nothing can detect, where one call site purges a collection and the other
 * keeps it forever.
 */
export async function applyScheduledRetention(store, data, { now = Date.now() } = {}) {
  const policy = await loadPolicy()
  const perCollection = {}
  const removals = {}
  for (const collection of RETENTION_COLLECTIONS) {
    const records = data[collection] || []
    const days = retentionWindowFor(policy, collection)
    if (days === null) {
      perCollection[collection] = { window_days: null, expired: 0, kept: records.length }
      continue
    }
    const result = applyRetention(records, days, now)
    perCollection[collection] = {
      window_days: days,
      expired: result.expired.length,
      kept: result.kept.length,
    }
    removals[collection] = result.expired.map((record) => record.id)
  }
  const expiredTotal = Object.values(perCollection).reduce((sum, c) => sum + c.expired, 0)
  if (expiredTotal > 0) {
    await store.remove({ collection: removals })
  }
  return { expired: expiredTotal, collections: perCollection }
}

/** The report-schedule cycle, with its writes persisted. Exported for tests. */
export async function runDueReportSchedulesAndPersist(store, data, { actor = 'periodic-driver' } = {}) {
  // The periodic driver has no `checkWebhookUrl` in scope and passed none before
  // the ARC-01 extraction either (see HEAD:src/server.js), so it is omitted here
  // rather than defaulted silently — the schedule runner treats its absence as
  // "no webhook destination to validate".
  const result = await runDueReportSchedules(data, actor)
  await store.merge(result.writes)
  return result
}

/**
 * SCL-02. A store view that reads the whole store once and keeps up with its own
 * writes.
 *
 * The tick used to call `store.read()` inside the loop, once per item: seven
 * items, seven full materialisations of every row, plus the reads each item does
 * for itself (`runIngestion` reads once at the start of a run, `dispatchPending`
 * once per dispatch). On the Postgres store that is a `SELECT` of every row's
 * body per item — 143 MB by the audit's own measurement — for a tick whose whole
 * job is to look at a handful of schedules.
 *
 * The fix is not "read once and hand the same object to everyone", which would
 * be wrong: `ingestion` writes `source_runs` and the outbox item reads
 * `events_outbox`, and an item that ran after a write must see it. So the
 * snapshot is *refreshed per written collection* — `merge` delegates to the real
 * store and then re-reads exactly the collections it wrote. A tick does one full
 * read plus one bounded read per write, instead of one full read per item.
 *
 * What this deliberately does not fix: a second process writing mid-tick. That
 * race exists with or without this change — the previous code's per-item read
 * was just as stale by the time the item used it — and closing it needs a
 * transaction, which is CON-01/ENH-63, not a read-cache.
 */
function tickStore(store) {
  let snapshot = null
  const refresh = async (collections) => {
    const keys = [...new Set(collections)].filter((key) => key !== 'updated_at')
    if (!keys.length) return
    const fresh = await store.read(keys)
    for (const key of keys) snapshot[key] = fresh[key]
  }
  return {
    async read(options) {
      if (snapshot === null) snapshot = await store.read()
      if (options == null) return snapshot
      // A manifest read is answered from the snapshot rather than going back to
      // the store: the snapshot is what this tick believes, and a caller that
      // reads a stale collection from disk mid-tick is the bug this replaces.
      const manifest = Array.isArray(options) ? options : options?.collections
      if (manifest == null) return snapshot
      const out = {}
      for (const collection of manifest) {
        if (collection in snapshot) out[collection] = snapshot[collection]
      }
      return out
    },
    async merge(partial) {
      const result = await store.merge(partial)
      await refresh(Object.keys(partial || {}))
      return result
    },
    async remove(doomed) {
      const result = await store.remove(doomed)
      await refresh(Object.keys(doomed?.collection || {}))
      return result
    },
    // Delegated rather than emulated. The outbox's dispatch item calls this, and
    // a locked body must read the *store*, not this tick's snapshot: the point of
    // the lock is a fresh read of the rows it is about to claim, and a claim
    // decided from a snapshot taken at the top of the tick would hand the row to
    // a second replica.
    //
    // Only the collections the body wrote are refreshed afterwards, rather than
    // dropping the snapshot whole. Dropping it costs a full-store read on the
    // next item, which is exactly the per-item cost SCL-02 removed — and the
    // outbox writes one collection, so the refresh is a manifest read. The
    // snapshot stays valid for everything the body did not touch.
    async withLock(fn) {
      const touched = new Set()
      const result = await store.withLock((locked) => fn({
        read: (options) => locked.read(options),
        merge: (partial) => {
          for (const key of Object.keys(partial || {})) touched.add(key)
          return locked.merge(partial)
        },
      }))
      if (touched.size) await refresh(touched)
      return result
    },
  }
  // Deliberately no `write` delegate. No driver item uses one — the seven read
  // and merge — and `write()` replaces the world, so the only honest thing a
  // delegate could do is drop the snapshot. A future item that reaches for it
  // gets `not a function` inside the tick's own try/catch, which reports a
  // failed item by name; a delegate that quietly rewrote the store mid-tick
  // would not.
}

/** Run every periodic item once and record the outcome. Exported for tests. */
export async function runPeriodicTick(store, { at = new Date().toISOString() } = {}) {
  const results = []
  // SCL-02. One read for the tick, refreshed per written collection, rather than
  // one full read per item. The heartbeat merge below goes through the raw store
  // — it is the tick's own record, not an item's, and nothing reads it back.
  const scoped = tickStore(store)
  for (const item of DRIVER_ITEMS) {
    const started = Date.now()
    try {
      const data = await scoped.read()
      const value = await item.run(scoped, data)
      results.push({ id: item.id, label: item.label, ok: true, ms: Date.now() - started, summary: summarise(item.id, value) })
    } catch (error) {
      // One item failing must not stop the rest: a dead webhook registry should
      // not also stop ingestion, and a bad schedule should not stop retention.
      results.push({ id: item.id, label: item.label, ok: false, ms: Date.now() - started, error: String(error?.message || error) })
      // OBS-06. Plain text on stderr bypassed `LINDELA_LITE_LOG_LEVEL` and every
      // JSON pipeline: a failing tick was exactly the message an operator most
      // needed and the one message the aggregator could not read.
      logger.error('periodic_item_failed', {
        item: item.id,
        label: item.label,
        message: 'a periodic item failed; the tick continues with the rest',
        err: { message: error?.message, stack: error?.stack },
      })
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
    logger.error('periodic_heartbeat_write_failed', {
      message: 'the heartbeat could not be recorded; /health will report the pipeline as stale',
      err: { message: error?.message, stack: error?.stack },
    })
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
  if (id === 'retention') return { expired: Number(value?.expired) || 0 }
  if (id === 'reconcile') return { raised: Number(value?.raised) || 0 }
  // ENH-80. `ran: false` is the no-peers case and is reported as such rather than
  // as a run that moved nothing — a heartbeat that said `peers: 0, ok: true`
  // would be the measurement-of-nothing shape the summary rule refuses.
  if (id === 'federation') {
    if (!value?.ran) return { ran: false, configured: Number(value?.configured) || 0 }
    return {
      ran: true,
      peers: Number(value?.peers) || 0,
      reached: Number(value?.reached) || 0,
      sent: Number(value?.sent) || 0,
      applied: Number(value?.applied) || 0,
    }
  }
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

/**
 * QUA-01. A periodic driver, owned by whoever creates it.
 *
 * The timer and the in-flight flag were module globals, so `startPeriodicDriver`
 * called twice in one process returned the first caller's timer and the second
 * caller's store was never ticked — a silent no-op, because "the driver is
 * already running" and "your driver is running" are the same return value. Two
 * servers in one test process therefore shared one heartbeat over one store, and
 * which store that was depended on test order.
 *
 * A factory because the state is a timer plus a boolean, and because a caller
 * that wants its own driver should get one rather than coordinate over a global.
 * The process-level exports below keep a default instance for the entry point,
 * where one driver over one store is the honest scope.
 */
export function createPeriodicDriver() {
  let timer = null
  let inFlight = false
  const driver = {
    /** Idempotent — a second call returns the same timer without restarting it. */
    start(store, { intervalSeconds = driverIntervalSeconds() } = {}) {
      if (timer) return timer
      const tick = async () => {
        if (inFlight) return
        inFlight = true
        try {
          await runPeriodicTick(store)
        } finally {
          inFlight = false
        }
      }
      timer = setInterval(tick, intervalSeconds * 1000)
      // Do not hold the process open for the timer alone; the HTTP server decides.
      timer.unref?.()
      // One immediately, so a fresh deployment has a heartbeat before the first
      // interval elapses — otherwise a health check in the first 15 minutes sees a
      // process that has never run anything and cannot tell that from a broken one.
      tick()
      return timer
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      inFlight = false
    },
    /** True while this driver's interval is armed. */
    get running() {
      return timer !== null
    },
  }
  return driver
}

const processDriver = createPeriodicDriver()

/**
 * CAP-04. The vintages this process has served, so a partner can be told what
 * the exports they hold actually were. In-process, like the idempotency store,
 * because the question is about this process's responses.
 */
const processVintageIndex = createVintageIndex()

export function startPeriodicDriver(store, options) {
  return processDriver.start(store, options)
}

export function stopPeriodicDriver() {
  processDriver.stop()
}

export function createServer(options = {}) {
  const storeProvider = options.store ? Promise.resolve(options.store) : getDefaultStore()
  // ENH-67. The store the API handlers read through: reads reach the replica if
  // this deployment configured one, and every operation is charged to the
  // request's own budget.
  //
  // Applied here rather than to the store itself, because the budget refuses an
  // operation with no request to charge — deliberately, so wiring is a
  // deliberate act. The periodic driver, `/ready` and the static path use the
  // raw store and are not metered; they are not requests, and a budget that
  // counted them would be counting a tick's own heartbeat against a caller.
  //
  // Both wrappers are constructed per server, from the store this server
  // resolved, so two servers in one test process do not share a budget ledger
  // or a replica fallback count. `readReplicaStore` returns the primary
  // *itself* when no replica is configured, so a deployment without one has no
  // wrapper in its path.
  const apiStore = (store) => budgetedStore(readReplicaStore(store, { replica: options.replica ?? null }))
  // One limiter per server, not per request: the budget is per client across
  // the process, and a limiter rebuilt per request would have no memory of the
  // last request at all. Injectable so a test can drive it with a fake clock.
  const inboundLimiter = options.inboundLimiter || createInboundLimiter(options.inboundLimiterOptions || {})
  // The SSRF guard the distribution path applies to a webhook URL. Injectable
  // for the same reason `dispatchPending` takes one: a test that has to prove
  // what the delivery path does needs a listener it can reach, and every such
  // listener is on loopback, which the guard exists to refuse. Nothing in the
  // request path overrides it.
  const checkWebhookUrl = options.checkWebhookUrl || assertSafeWebhookUrl
  // When this server began serving. OBS-04 measures the pipeline's start grace
  // from here rather than from process start, so two servers in one test process
  // do not share an uptime and a test can place the clock where it needs it.
  const serverStartedAt = options.startedAt ?? Date.now()
  // Resolved once per server. See `handleStatic`: this is the seam that lets a
  // test exercise a file changing on disk without writing into `public/`.
  const staticRoot = options.publicDir || publicDir
  // CON-06 / ENH-65. Per server, built from the store this server resolved, and
  // not a module global. Two servers in one test process used to share one
  // idempotency Map, which made the tests order-dependent — and a module global
  // is a claim that there is one store, which stopped being true the moment the
  // outbox needed a lock across replicas.
  //
  // Cached per store instance rather than rebuilt per request, because the
  // in-process half holds promises that concurrent requests await: a store
  // rebuilt per request would have no memory of the attempt in flight and would
  // run the work twice, which is the defect this file exists to prevent.
  let idempotencyOf = null
  let idempotencyFor = null
  const idempotency = (store) => {
    if (idempotencyOf !== store) {
      idempotencyFor = createIdempotencyFor(store, options.idempotencyOptions || {})
      idempotencyOf = store
    }
    return idempotencyFor
  }
  // QUA-01. This server's own request-outcome ring, not the process-wide one.
  //
  // It feeds `api_uptime_pct` on the KPI routes, and it used to be a module
  // global: `createServer()` is called many times in one test process, so every
  // one of those servers answered its uptime from the same ring and a test that
  // drove 500s through its own server read another test's 200s back. Injectable
  // so a test can seed the window it means to measure instead of issuing a
  // hundred requests to fill it.
  const requestRing = options.requestRing || createRequestRing()
  const handleRequest = async (req, res) => {
    // CAP-06. A HEAD is answered by the same code path as its GET sibling, with
    // the body suppressed at the one place a body is written. `http` strips the
    // body for HEAD anyway, so a fall-through "worked" while doing all the work
    // and then discarding it — and a HEAD to a path no GET route serves 404'd,
    // which is the opposite of what a client probing a documented endpoint
    // expects. The method is rewritten rather than threaded through, so every
    // existing `req.method === 'GET'` condition in the router keeps its meaning
    // and there is no second table to keep in step.
    const isHead = req.method === 'HEAD'
    if (isHead) req.method = 'GET'
    res.locals = res.locals || {}
    res.locals.suppressBody = isHead

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const route = normalizeRoute(url.pathname)

    // ENH-64/OBS-03. One id per request, minted here and visible for the whole
    // dispatch. A caller that already carries one — a gateway, an upstream
    // service, another Lindela instance — keeps it, because the whole point of a
    // correlation id is to join two systems' logs and minting a fresh one here
    // breaks exactly that join. Sanitised and length-bounded first: an
    // attacker-controlled header written verbatim into a log line is a
    // log-injection primitive, and one that reaches a response header is a
    // response-splitting primitive.
    const requestId = sanitizeRequestId(req.headers['x-request-id']) || randomUUID()
    res.setHeader('x-request-id', requestId)
    res.locals.requestId = requestId
    // OBS-04 reads the pipeline's start grace from here. On the response rather
    // than in a module variable so two servers in one test process keep their
    // own uptimes, which is what makes the grace period testable at all.
    res.locals.serverStartedAt = serverStartedAt

    await runWithRequestId(requestId, () => dispatch(req, res, url, route))
  }

  const dispatch = async (req, res, url, route) => {
    const t = timer()

    try {
      // Set on every response, API and static alike. The pages build markup
      // with innerHTML, so this is the backstop that keeps a missed escape from
      // being a full script injection.
      securityHeaders(res)

      // CAP-06. CORS, before the traversal check and before the rate limiter.
      //
      // A preflight is the browser asking permission to make a request it has
      // not made yet; it carries no credentials, and refusing it for that reason
      // is what makes a browser client unusable — the browser never sends the
      // credentialed request whose token would have passed. So the preflight is
      // answered here, and the *actual* request still goes through the auth gate
      // below. Answering the preflight is not a grant of access; it is a grant
      // to ask.
      //
      // It runs before the limiter because a preflight is one round trip the
      // browser makes on the caller's behalf, and charging it against the same
      // budget as the request it precedes halves every cross-origin caller's
      // allowance for no security benefit.
      if (isPreflight(req)) {
        const preflight = preflightResponse(req.headers.origin)
        res.writeHead(preflight.status, {
          ...preflight.headers,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }

      // The grant itself, on every response. `jsonResponse` carries the rest of
      // the headers; this one has to be set on the response object because the
      // static and streaming paths write their own heads.
      for (const [name, value] of Object.entries(corsResponseHeaders(req.headers.origin))) {
        if (name.toLowerCase() === 'vary') {
          // Merged, not overwritten: `jsonResponse` sets `vary` to the credential
          // headers, and replacing it would drop the protection that keeps a
          // shared cache from serving one caller's body to another.
          const existing = res.getHeader('vary')
          res.setHeader('vary', existing ? `${existing}, ${value}` : value)
        } else {
          res.setHeader(name, value)
        }
      }

      if (hasTraversalSegment(req.url || '')) {
        jsonResponse(res, 404, { success: false, error: 'Not found' })
        return
      }

      // R-09. Charged before anything expensive happens, including
      // authentication — a token-guessing flood should cost the server one map
      // lookup, not a full auth path per guess. The slot is released when the
      // response finishes rather than when the handler returns, so a slow
      // request holds its slot for as long as it is actually in flight.
      const budget = inboundLimiter.charge(req, url)
      if (!budget.allowed) {
        const retryAfterSec = budget.retryAfterMs === null
          ? 1
          : Math.max(1, Math.ceil(budget.retryAfterMs / 1000))
        jsonResponse(res, 429, {
          success: false,
          error: `Rate limit exceeded for the ${budget.className} budget. Retry in ${retryAfterSec}s.`,
          class: budget.className,
          retry_after_seconds: retryAfterSec,
        }, { 'retry-after': String(retryAfterSec) })
        return
      }
      res.once('close', budget.release)

      if (url.pathname.startsWith('/stac/') || url.pathname.startsWith('/ogc/')) {
        // These dispatched ahead of every gate, so clinic, water-point and road
        // locations were readable by anyone who could reach the port. They are
        // interoperability surfaces, which is a reason to be careful rather than
        // to be open: the client did not ask us which fields it may have.
        //
        // Closed by default, opt-in by configuration — an operator who wants an
        // open catalogue adds `/stac` to LINDELA_LITE_PUBLIC_PATHS, which is the
        // same switch `/ready` and `/health` go through, so the decision is
        // recorded in one place rather than inferred from a code path.
        const stacAuth = isAuthConfigured() && !isPublicPath(url.pathname) ? authenticate(req) : null
        if (isAuthConfigured() && !isPublicPath(url.pathname) && !stacAuth) {
          jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
          return
        }
        // ARC-08. The context, not just the gate. `authenticate` proves *a*
        // caller; it says nothing about *which* partner, and this route returns
        // before `handleApi` publishes the identity. So `handleStacRoute` read
        // the whole store with no partner filter and served every organisation's
        // clinic and water-point locations to a token scoped to one — the auth
        // gate answered 401 correctly and the isolation was still absent.
        // Publishing the context is what lets the read below apply it, and it is
        // also what `filterRecords` reads if a future handler forgets to pass it.
        const stacStore = await storeProvider
        const stacRoute = matchStacRoute(url.pathname, req.method) || matchOgcRoute(url.pathname, req.method)
        // A `/stac/` or `/ogc/` path that matches neither matcher — an unknown
        // collection shape, or a verb the two GET-only matchers refuse — is the
        // 404 this branch has always answered. The prefix guard is wider than
        // the matchers on purpose: it is what puts these requests through the
        // auth gate, and narrowing it here would move the 404 in front of the
        // 401 and tell an unauthenticated caller which paths exist.
        if (!stacRoute) {
          jsonResponse(res, 404, { success: false, error: 'Not found' })
          return
        }
        await runWithRequestContext(stacAuth, () => handleStacRoute(stacRoute, { store: stacStore, req, res, jsonResponse }))
        return
      }

      if (url.pathname === '/metrics' || url.pathname === '/api/v1/metrics') {
        // Through the gate, which is what this comment claimed and the code did
        // not do. It did its own `authenticate` and returned, so it enforced
        // *authentication* and never *authorization*: `/metrics` fails closed to
        // `admin:*` in `auth.js` — right for it, and its actor in
        // `docs/platform-jtbd-catalogue.md` is the Administrator scraping on a
        // polling interval — but nothing consulted that scope. Any valid token
        // read request rates, error rates, latency percentiles and route labels,
        // the last being an enumeration aid, which is the reason the endpoint is
        // not public in the first place. A scope declared and never read is the
        // gate-at-19-of-27-paths shape: correct policy, no caller.
        //
        // `enforceAuthGate` is the same function the `/api/v1/` dispatch calls,
        // so the two cannot drift, and it answers the unauthenticated case 401
        // rather than falling open.
        const metricsGate = await enforceAuthGate(req, res, url, { jsonResponse })
        if (metricsGate.outcome === 'handled') return
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' })
        res.end(metrics.render())
        return
      }
      if (url.pathname.startsWith('/api/v1/')) {
        const resolved = await storeProvider
        // ENH-67. The allowance is chosen per route: a route whose manifest is
        // `null` — `WIDE_ROUTES`, the exports, the seed — reads the whole store
        // on purpose and gets the store's own ceiling, so the budget never
        // refuses a read the store would have served. A route with a manifest
        // gets the narrow default, which is the one that catches a handler
        // reaching for collections its declaration does not name.
        //
        // `collectionsForRequest` is asked rather than the key compared, because
        // the explain route resolves its collection from `?kind=` and the answer
        // is a property of the request, not of the path.
        const wide = collectionsForRequest(req.method, url.pathname, url.searchParams) === null
        const metered = apiStore(resolved)
        await runWithQueryBudget(wide ? WIDE_QUERY_BUDGET : queryBudgetLimits(), () =>
          handleApi(metered, req, res, url, { checkWebhookUrl, idempotency: idempotency(resolved), requestRing }))
        return
      }
      await handleStatic(req, res, url.pathname, staticRoot)
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
      // A 5xx whose message was written *for the caller* says so, rather than
      // being flattened to "Internal server error". The rule below is right for
      // a fault — `pg` errors carry the connection string and the failing
      // statement — but wrong for a deliberate refusal that happens to carry a
      // 5xx status, which is what a capacity limit is: the caller can act on
      // "narrow the request", and hiding that turns an actionable 503 into a
      // mystery. Opt-in, so no message is exposed by accident; `auth.js`'s
      // fail-closed config error is the existing case.
      const exposeMessage = statusCode < 500 || error.expose === true
      if (exposeMessage) {
        // ARC-07. A thrown error may name its own code, and the envelope keeps
        // it only when it is in the vocabulary. That validation is what makes
        // this safe to pass through: `error.code` is `ENOENT` on a filesystem
        // error and `ERR_…` on a Node internal, neither of which is a code this
        // API publishes, and both of which would otherwise reach a client as
        // this endpoint's own vocabulary.
        jsonResponse(res, statusCode, {
          success: false,
          error: error.message || 'Request failed',
          code: error.code,
        })
      } else {
        // The id the client is handed is the request's own id, not a second one
        // minted here. They used to be different: the response carried an
        // `incident_id` that appeared on no log line, and the log line for that
        // request carried a `request_id`-less entry naming nothing. "Here is the
        // id we showed the user, find the request" was unanswerable, which is
        // the one question a correlation id exists to answer.
        const incidentId = res.locals?.requestId || randomUUID()
        logger.error('request_failed', {
          incident_id: incidentId,
          route,
          method: req.method,
          // Spreading an Error into a JSON payload yields `{}` — its fields are
          // non-enumerable. Log the parts, or the log says nothing at all.
          err: { message: error.message, stack: error.stack },
        })
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
      requestRing.record(statusCode < 500)
      logger.info('http_request', { method: req.method, route, status: statusCode, elapsed_ms: elapsed })
    }
  }
  return http.createServer(handleRequest)
}

function normalizeRoute(pathname) {
  return pathname
    .replace(/\/[a-f0-9-]{36}/g, '/:id')
    .replace(/\/[a-f0-9_]{32,}/g, '/:id')
    .replace(/\/\d+/g, '/:id')
}

/**
 * ENH-64. An inbound correlation id, or null to mint one.
 *
 * Accepts only the characters a request id is made of and caps the length. The
 * header arrives from the network: written verbatim into a log line it can carry
 * a newline and forge a second record; written verbatim into a response header
 * it can carry CRLF and split the response. Neither is theoretical for a header
 * that exists precisely to be echoed. Anything that does not match is dropped
 * and the caller gets a fresh id — a wrong id is worse than a new one, because
 * it joins two unrelated requests.
 */
export function sanitizeRequestId(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 128) return null
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null
}

// ENH-60. The STAC and OGC families, extracted to `src/routes/stac.js`. They
// were the last routes still written inline in this file, and moving them is
// what made three served paths visible to `scripts/route-surface.mjs` at all —
// a parser that reads a family's paths out of its matcher body could not see a
// `.match()` written in a helper, so `/stac/collections/{id}` and its two
// siblings were in no manifest, no document and no check while `check-openapi`
// reported a clean 176/176.

/**
 * Scoped by caller, method and path before use.
 *
 * An unscoped key would let one caller name another's response: two partners
 * both using `key: "1"` would receive each other's incidents, which is a
 * cross-partner read manufactured entirely from request headers.
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

async function handleApi(store, req, res, url, { checkWebhookUrl, idempotency, requestRing } = {}) {
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
  if (!key) return handleApiRequest(store, req, res, url, { checkWebhookUrl, idempotency, requestRing })

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
  const replay = await idempotency.claim(key, fingerprint)
  if (replay.conflict) {
    jsonResponse(res, replay.status, replay.body, { 'idempotency-conflict': 'true' })
    return
  }
  if (replay.inFlight) {
    // Someone else is already doing this exact work. Wait for their answer
    // rather than doing it twice — and answer 409 if they fail, so a caller can
    // tell "not done" from "not done yet".
    //
    // A claim with no promise is one another *replica* holds: the durable store
    // records that the key is claimed, and a promise cannot cross a process
    // boundary. There is nothing here to await, so the caller is told to retry
    // rather than being answered from an attempt this process cannot see.
    if (!replay.promise) {
      jsonResponse(res, 409, {
        success: false,
        error: 'A request with this Idempotency-Key is already being processed and has not completed. Retry shortly.',
        code: ERROR_CODES.IDEMPOTENCY_IN_FLIGHT,
      }, { 'idempotency-in-flight': 'true' })
      return
    }
    const settled = await replay.promise
    if (settled?.error) {
      jsonResponse(res, 409, {
        success: false,
        error: 'A request with this Idempotency-Key is already being processed and has not completed. Retry shortly.',
        code: ERROR_CODES.IDEMPOTENCY_IN_FLIGHT,
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

  // The claim is resolved from inside the response, not after it.
  //
  // Both branches return a commit that `jsonResponse` holds the response for:
  // the receipt on success, the release on failure. Settling after the handler
  // returned was the race CON-06 describes — the client already had its status
  // line, so a crash in the gap left either a write no retry would recognise, or
  // a key wedged in a claim that no later request could clear.
  //
  // The `finally` below is the backstop, not the mechanism. A handler that
  // throws before writing any JSON leaves the claim unresolved, and a claim
  // nothing ever clears is a key that can never be retried — so it is released
  // there. `resolved` is what keeps that from releasing a key the hook already
  // settled: a release after a settle would delete the receipt it just wrote.
  let resolved = false
  res.__capture = (status, body) => {
    resolved = true
    // Only a success is worth replaying. Caching a 500 would convert a
    // transient failure into a permanent one for the length of the window.
    if (status < 400) return idempotency.settle(key, status, body, fingerprint)
    return idempotency.release(key)
  }
  try {
    await handleApiRequest(store, req, res, url, { checkWebhookUrl, idempotency, requestRing })
  } finally {
    delete res.__capture
    // Nothing wrote a JSON response, so the hook never ran. Released so the key
    // is retryable at once rather than standing as a claim for its whole TTL.
    if (!resolved) await idempotency.release(key)
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
async function handleApiRequest(store, req, res, url, { checkWebhookUrl, idempotency, requestRing } = {}) {
  // Resolve the identity once, here, and publish it for the whole dispatch.
  //
  // `authenticate` was already being called on this path for the idempotency
  // key, so this is not a second authentication — it is the same call, hoisted
  // so the answer is available before any handler runs rather than after.
  const auth = (isAuthConfigured() && !isPublicRequest(req.method, url.pathname) ? authenticate(req) : null) || null
  return runWithRequestContext(auth, () => handleApiRequestInContext(store, req, res, url, auth, { checkWebhookUrl, idempotency, requestRing }))
}

async function handleApiRequestInContext(store, req, res, url, auth, { checkWebhookUrl, idempotency, requestRing } = {}) {
  // An `/api/v1/` path reached dispatch. Cleared again if it matches nothing, so
  // the metric label distinguishes "a route we served" from "a path we did not
  // recognise" — the second is what a scanner produces, one per request.
  res.locals = res.locals || {}
  res.locals.matchedRoute = normalizeRoute(url.pathname)
  // ENH-60. The authentication gate, extracted to `src/routes/auth-gate.js`.
  // Every request passes through it before any route is matched — it has no
  // matcher of its own, which is why it is the one module under `src/routes/`
  // that exports a verdict rather than a `match`/`handle` pair. Dispatched here,
  // above the store read, where the block it replaces sat.
  const gate = await enforceAuthGate(req, res, url, { auth, jsonResponse })
  if (gate.outcome === 'handled') return
  auth = gate.auth

  // ENH-07. The manifest is what the route reads, measured rather than guessed
  // (`src/route-manifests.js`). `null` — a whole-store read — is the answer for
  // an unrecognised path and for the surfaces measured as genuinely wide, so
  // this fails towards the old cost and never towards a 500.
  // ENH-07 and ENH-17 in one call: which collections this route reads, and which
  // partner organisation's rows it may see. The organisation comes from the
  // request context rather than from a parameter, for the same reason the scope
  // does — a caller that forgets to pass it must not see another organisation's
  // data, and one that does pass it wrong must not either. `filterRecords`
  // applies the same predicate in JavaScript to what comes back; this keeps the
  // rows the caller may not see off the query in the first place.
  // ENH-49 and ENH-08 together. The history routes are the only ones that read
  // `record_versions`, and ENH-08 keeps it off every other read — so a route
  // whose handler calls `series.js` has to ask for it. Without this the two
  // `/history` routes returned an empty series on Postgres while working on a
  // JSON box, because `JsonStore` ignored the flag and `PostgresStore` honoured
  // it (ARC-10). The adapters agree now, so the request has to be explicit.
  const readRequest = {
    collections: collectionsForRequest(req.method, url.pathname, url.searchParams),
    includeHistory: needsHistory(req.method, url.pathname),
    partnerOrg: currentRequestAuth()?.partner_org || null,
  }
  req.__auth = auth

  // ENH-60 / ENH-59. The dispatch table. `src/route-families.js` declares every
  // family — its matcher, its handler, the context keys it is handed, whether its
  // matcher takes the verb, whether its handler is async, and which side of the
  // store read it sits on. The thirty-two `match`/`handle` blocks that used to be
  // written out here were that same declaration written as statements; the table
  // is now the one place they are kept, and `test/dispatch-order.test.js` checks
  // the order against a frozen recording rather than against this file.
  //
  // The families above the read run first. The split is a correctness property,
  // not tidiness: `/ready` must not materialise the store, `export.ndjson`
  // streams within SCL-01's read-row budget, and the two tile families read no
  // collection. Each entry's note in `route-families.js` says why it is where it
  // is. `loadData` is the read as a thunk, so the two families that need the
  // whole set call it and the ones that do not never pay for it.
  const familyCtx = {
    store, req, res, url, auth, jsonResponse, checkWebhookUrl, idempotency,
    requestRing, withTimeout, readRequestJson, evaluateAndPersistAlerts,
    appVersion: APP_VERSION, pipelineIsHealthy, driverIntervalSeconds,
    vintageIndex: processVintageIndex,
    loadData: () => store.read(readRequest),
  }
  for (const family of ROUTE_FAMILIES) {
    if (!family.pre) continue
    if (await dispatchFamily(family, familyCtx)) return
  }

  const data = await store.read(readRequest)
  // The families below the read. `data` is the one read every one of them shares,
  // so it is spread onto the same context rather than passed again per family.
  const postCtx = { ...familyCtx, data }
  for (const family of ROUTE_FAMILIES) {
    if (family.pre) continue
    if (await dispatchFamily(family, postCtx)) return
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
  // CON-04. One emit for the batch, not one per raised alert.
  //
  // Only a raised alert is a new fact. An updated one is the same alert with a
  // newer reading, or one that has just been closed, and neither is something
  // a subscriber asked to be told about.
  //
  // The loop this replaces called `emit` per alert, and `emit` reads the whole
  // store before it merges — so an alert storm raising 200 alerts was 200
  // sequential full reads of every row in the store, plus 200 merges, on the
  // request path and on the periodic tick. `emitMany` does the same per-event
  // work over one snapshot and one merge.
  if (raised.length) {
    try {
      await emitMany(store, raised.map((event) => ({ event: 'alert_event.created', payload: event })))
    } catch (emitError) {
      // A subscriber that cannot be reached is not a reason to abandon the
      // alerts, which are already persisted above. Recorded rather than dropped,
      // and per alert, so a scrape can still see how many were lost.
      for (const event of raised) {
        metrics.counter('outbox_emit_failed_total', { event: 'alert_event.created' })
        logger.error('outbox_emit_failed', {
          outbox_event: 'alert_event.created',
          alert_event_id: event.id,
          message: 'outbox emit failed; the alert is stored and no subscriber was told',
          err: { message: emitError.message, stack: emitError.stack },
        })
      }
    }
  }
  return { raised, updated }
}

/**
 * The static root is a parameter, not the module constant, so a test can serve
 * a fixture tree.
 *
 * It was read from the closure, which meant the only way to test a file that
 * changes on disk was to change a file in `public/` — and `test/static-and-tile-caches.test.js`
 * did exactly that, writing a `// cache-buster` line into the tracked
 * `public/shared/app-version.js` and restoring it in a `finally`. Under
 * `node --test`'s file-level parallelism two workers overlap there: one reads
 * the file mid-write and sees an mtime/size the other is about to change, so
 * the "compressed once" counter reads 2 or 3 and an ETag comparison that should
 * differ compares equal. The test was 10/10 green run alone and failed 9/10 run
 * ten ways at once, which is the signature of a shared file, not a shared cache.
 *
 * A suite whose result depends on how many workers overlap cannot be evidence
 * for anything, so the seam is worth more than the test it fixes.
 */
async function handleStatic(req, res, pathname, publicDir) {
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
    // Re-set with the surface known, so `/chw` is offered geolocation and the
    // other surfaces are not. `securityHeaders` ran for every response before
    // the path was matched; this is the narrow version of the same call.
    securityHeaders(res, { surface })
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
/**
 * Replace the version placeholder in served markup.
 *
 * The marker is the attribute, not the literal: `<span data-app-version>` with
 * any content inside it. A regex over the literal version would have to be
 * rewritten on every release, and the one that was missed is the one an operator
 * sees.
 */
const VERSION_MARKER = /(<span[^>]*\bdata-app-version\b[^>]*>)([\s\S]*?)(<\/span>)/g

/**
 * VUL-07. The inline scripts the CSP allows, by hash.
 *
 * Generated by `scripts/check-csp.mjs` from the shipped markup — do not edit by
 * hand. `node scripts/check-csp.mjs --write` regenerates it, and
 * `node scripts/check-csp.mjs --check` (wired into the gate tier and
 * `validate.mjs`) fails when the two disagree.
 *
 * The reason it is generated rather than written: a stale hash does not throw.
 * The browser blocks the script silently and the page stops working with no
 * error anyone will see, which is a worse failure than the `'unsafe-inline'`
 * this replaces. A list a human maintains is a list that goes stale.
 *
 * Bare values, without the surrounding quotes a CSP source needs. The header
 * adds those. Writing them quoted here is the bug this shape prevents: the
 * quotes would be JavaScript string delimiters and vanish from the value, and a
 * CSP hash-source without quotes is not a hash-source — the browser ignores it
 * and blocks the script, which is the silent failure above.
 */
export const INLINE_SCRIPT_HASHES = [
  'sha256-+4LFUeSO1MBnlwct1BnfRHc94zKdjCUCyRMv6CveTFQ=',
  'sha256-/UldbqIeQh3hZTU0LmHJHKvEx+s/ZRJvjZ8/zn09e2E=',
  'sha256-IZyrV+WJdGUDipEOh2/e6VbdjfStpxs4zqld5f+yNE0=',
  'sha256-PlA6MpB9RZkobqkwcV5/CxqX57gdBz2GixNyu49x+b8=',
  'sha256-TuKfKtlZdzWUJh9m75sTZt2T0UkddjkHtuWfel79s1g=',
  'sha256-WXFdIKUrcyGpZcMmNFqeFT/+hNBTiT821h96rDD0Y1g=',
  'sha256-qYfJ4UelX9RhUrZP3oymCTn+WY+BBCm5KQT6W7p4xsQ=',
  'sha256-wSFDu11kl3+D2m9pIPx6SoenvW8aFbwk7Uoq/lYYry4=',
  'sha256-wrkJ5SwfxOgQourjosrccjaA9zwdEbyMorAFI3yh6xM=',
]

export function fillAppVersionMarker(html, version = APP_VERSION) {
  return html.replace(VERSION_MARKER, (_m, open, _body, close) => `${open}v${version}${close}`)
}

/**
 * R-66. The service worker's cache name, filled from the release.
 *
 * `CACHE_NAME` has to change with every release or a fix never reaches a device
 * that has the app open — and it was a hand-maintained literal nothing checked
 * against `package.json`. Same mechanism as the version marker above, same
 * reason: a value that must track the release should be *derived* from it, not
 * typed beside it, because the literal drifts and the drift is silent.
 *
 * A plain string replace, not a regex: the placeholder is a fixed token and a
 * regex would invite it to match something it does not own.
 */
export function fillCacheVersionMarker(source, version = APP_VERSION) {
  return source.split('__CACHE_VERSION__').join(version)
}

/**
 * SCL-04. Static assets, prepared once per (path, mtime, size).
 *
 * `sendFile` read the file, sha1-hashed the whole body for its ETag and
 * `gzipSync`-compressed it — synchronously, on the request path — for every
 * request, including every conditional revalidation that was going to answer
 * 304 and send none of it. `gzipSync` blocks the event loop, so a page pulling
 * twenty modules serialised twenty compressions of bytes that had not changed
 * since the last release.
 *
 * Keyed on mtime and size rather than the path alone: the process runs for
 * weeks and a deploy rewrites these files underneath it, so a path-keyed cache
 * would serve the previous build forever. A `stat` per request is the cheap
 * thing that keeps the expensive things correct.
 */
const staticCache = new Map()
const STATIC_CACHE_MAX = 256
// How much compression work the process has done. The cache makes `gzipSync`
// run once per file per build rather than once per request, and nothing a client
// can see distinguishes the two — a gzip body is a gzip body. The counter is the
// seam that lets a test watch it, for the same reason `kpiCacheStats` exists.
const staticCompressions = { gzip: 0, files: 0 }

/** Test seam: how the static cache is doing. Not read on the request path. */
export function staticCacheStats() {
  return {
    entries: staticCache.size,
    max: STATIC_CACHE_MAX,
    gzip_compressions: staticCompressions.gzip,
    files_prepared: staticCompressions.files,
  }
}

/** Test seam: process-level file state must not leak between tests. */
export function resetStaticCache() {
  staticCache.clear()
  staticCompressions.gzip = 0
  staticCompressions.files = 0
}

async function preparedStatic(filePath) {
  let stat
  try {
    stat = await fs.stat(filePath)
  } catch {
    return null
  }
  const cached = staticCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached

  let content
  try {
    content = await fs.readFile(filePath)
  } catch {
    return null
  }
  // The build version, filled in on the way out.
  //
  // Every surface carried a hand-written fallback — `v0.1.0` in three files while
  // the package was at 0.2.0 — and `/shared/app-version.js` only replaced it
  // once `/api/v1/health` answered. So an offline operator, which is the case
  // this product is built for, was told the build they were running was a release
  // behind. The browser gate caught it: "shown v0.1.0, released v0.2.0".
  //
  // Injected rather than rewritten in the source files, because a literal in
  // three HTML files drifts at the next release — which is the drift the shared
  // module was written to end, reintroduced one layer down. The ETag is computed
  // from the injected bytes, so a revalidated client gets the new ETag too.
  if (/\.html$/.test(filePath)) content = Buffer.from(fillAppVersionMarker(content.toString('utf8')))
  // R-66. The worker carries the release in its cache name, so the name moves
  // with the version rather than with a hand-edited literal. Filled on the way
  // out for the same reason the version marker is: the ETag is computed from
  // the injected bytes, so a revalidating client gets the new one.
  if (filePath.endsWith('sw.js')) content = Buffer.from(fillCacheVersionMarker(content.toString('utf8')))
  const entry = {
    content,
    type: contentType(filePath),
    etag: etagFor(content),
    // SCL-04. The real modification time. This was `new Date().toUTCString()` —
    // *now* on every response — so `If-Modified-Since` could never match and
    // every revalidating client got the full body back. Only the ETag path could
    // ever 304, and a client that sends only `If-Modified-Since` (a proxy, a
    // plain `curl -z`) never did.
    lastModified: new Date(stat.mtimeMs).toUTCString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    // Filled on the first request that accepts gzip. A file nobody requests
    // compressed is never compressed.
    gzip: null,
  }
  staticCompressions.files += 1
  if (staticCache.size >= STATIC_CACHE_MAX) {
    staticCache.delete(staticCache.keys().next().value)
  }
  staticCache.set(filePath, entry)
  return entry
}

async function sendFile(req, res, filePath) {
  const entry = await preparedStatic(filePath)
  if (!entry) return false

  const headers = {
    'content-type': entry.type,
    etag: entry.etag,
    'last-modified': entry.lastModified,
  }

  if (/\.(html|webmanifest)$/.test(filePath) || filePath.endsWith('sw.js')) {
    // The service worker must never be served stale, or a fix cannot reach a
    // device that already has the app open.
    headers['cache-control'] = 'no-cache'
  } else if (/\.(js|mjs|css)$/.test(filePath)) {
    // Asset filenames are not content-hashed, so a long max-age would pin an
    // operator to a stale build after a fix ships. Code revalidates instead:
    // cheap with an ETag, and correct. This branch existed only as an
    // `immutable` flag no caller ever passed — so every module, and every
    // script the console lazily imports, answered `max-age=3600` and an hour
    // of deploy latency; the flag is gone and the rule applies by extension.
    headers['cache-control'] = 'public, max-age=0, must-revalidate'
  } else {
    headers['cache-control'] = 'public, max-age=3600, must-revalidate'
  }

  if (req?.headers?.['if-none-match'] === entry.etag || ifModifiedSinceMatches(req, entry.mtimeMs)) {
    res.writeHead(304, headers)
    res.end()
    return true
  }

  const content = entry.content
  if (COMPRESSIBLE.test(entry.type) && acceptsGzip(req) && content.length > 512) {
    if (!entry.gzip) {
      entry.gzip = gzipSync(content)
      staticCompressions.gzip += 1
    }
    headers['content-encoding'] = 'gzip'
    headers['vary'] = 'accept-encoding'
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : entry.gzip)
    return true
  }

  headers['content-length'] = content.length
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : content)
  return true
}

/**
 * Whether `If-Modified-Since` covers this file.
 *
 * Second granularity on both sides, because HTTP dates carry no milliseconds: a
 * file written 400 ms after the client's stored date is "not modified" by the
 * header's own resolution, and comparing raw epoch milliseconds would answer 200
 * for every file written in the same second as the request that cached it.
 */
function ifModifiedSinceMatches(req, mtimeMs) {
  const raw = req?.headers?.['if-modified-since']
  if (!raw) return false
  const since = Date.parse(raw)
  if (!Number.isFinite(since)) return false
  return Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000)
}

/**
 * Security headers for every response.
 *
 * There were none. The pages build markup with innerHTML, so a CSP is the
 * backstop that turns a missed escape from a full injection into a visible
 * failure.
 *
 * VUL-07. `script-src` named `'unsafe-inline'`, which is precisely the
 * mitigation it was there to provide: with it, an injected `<script>` runs. It
 * is replaced by the sha256 hashes of the nine inline scripts the surfaces
 * actually ship. The one inline event handler that made a hash list impossible —
 * `onclick` on the portal's sign-in button — is now wired in `portal/app.js`,
 * and `scripts/check-csp.mjs` fails the build if another appears, because a hash
 * cannot cover one.
 *
 * A nonce was the other candidate and is wrong here: the service worker caches
 * HTML for offline use, so a per-request nonce would be stale in every cached
 * page and every script would be blocked offline — on the surface whose entire
 * purpose is working without a connection.
 *
 * `style-src` keeps `'unsafe-inline'`. The per-page `<style>` blocks are not yet
 * consolidated, and a style injection is a far weaker primitive than a script
 * one; this narrows the policy where the harm is, not everywhere it could be
 * narrowed.
 */
function securityHeaders(res, { surface = null } = {}) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')
  // Geolocation is offered on the one surface that ships a feature needing it,
  // and denied everywhere else.
  //
  // The browser gate found this by reporting a console error on every CHW page
  // load — "Geolocation access has been blocked because of a permissions policy"
  // — and the cause was this header. `public/chw/app.js` calls
  // `getCurrentPosition` to place a symptom report, and `geolocation=()` meant
  // the call could never succeed: every field report fell back to typing a
  // location, on the surface whose whole purpose is reporting from the field.
  // Denying it on the other seven surfaces is unchanged and deliberate — none of
  // them asks, and the policy is what keeps an embedded frame from asking.
  //
  // `(self)` still requires the browser's own permission prompt, so this
  // enables a feature rather than granting a capability.
  const geolocation = surface === '/chw' ? '(self)' : '()'
  res.setHeader('permissions-policy', `geolocation=${geolocation}, camera=(self), microphone=()`)
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      `script-src 'self' ${INLINE_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(' ')}`,
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

function getDefaultStore() {
  if (!defaultStorePromise) defaultStorePromise = createStoreFromEnv()
  return defaultStorePromise
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
  // `LINDELA_LITE_HOST` defaults to 0.0.0.0 because that is what the container
  // needs: binding 127.0.0.1 inside a container makes the published port
  // unreachable, so the default cannot move without breaking every deployment.
  //
  // The startup line used to say `http://127.0.0.1:${port}` unconditionally,
  // which was the wrong thing to tell an operator. With no host argument,
  // `listen(port)` binds every interface, so a bare-metal run was reachable on
  // every interface the machine had — and with no tokens configured, auth is
  // off entirely. This platform holds field reports with names and household
  // counts, so "it said 127.0.0.1" was a claim the process was not making.
  //
  // The default is unchanged. What changes is that the line tells the truth,
  // and `scripts/run.sh` binds loopback on purpose rather than by accident.
  const host = process.env.LINDELA_LITE_HOST || '0.0.0.0'
  createServer().listen(port, host, () => {
    // The driver owns what a tick includes; the sidecar still owns when ticks
    // happen. Both may run — the tick is idempotent and the heartbeat records
    // which came last.
    getDefaultStore().then(startPeriodicDriver).catch((error) => {
      logger.error('periodic_driver_start_failed', {
        message: 'the periodic driver did not start; /health will report the pipeline as degraded',
        err: { message: error?.message, stack: error?.stack },
      })
    })
    const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1 (bound to every interface)' : host
    console.log(`Lindela Lite listening on http://${shown}:${port}`)
    if (host === '0.0.0.0' || host === '::') {
      console.log('  This is reachable from other machines on your network.')
      console.log('  Set LINDELA_LITE_HOST=127.0.0.1 to bind loopback only.')
    }
  })
}
