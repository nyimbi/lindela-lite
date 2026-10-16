/**
 * ENH-77 — the actor population as a model, not a guess.
 *
 * The capacity question is "how much of our real traffic can this hold", and the
 * only way to ask it wrongly is with a number nobody chose. A load test that
 * fires a flat fifty requests a second measures the tester's imagination, and it
 * answers a question no deployment has: what a *synthetic* client costs. This
 * module describes the clients that actually reach the API, so the ceiling found
 * against it is a ceiling on real access patterns rather than on a benchmark.
 *
 * Three shapes of client, because three shapes stress the server differently:
 *
 *   console  a supervisor's tab. Twelve ambient endpoints plus the three its tab
 *            owns, every `POLL_BASE_MS`, and a boot tick that pays for all
 *            eighteen at once. This is the read pressure, and it is the one
 *            actor whose parameters are **not** invented: the cadence is
 *            `pollDelayMs` and the endpoint set is `endpointsForTab`, both from
 *            `public/app.js`. `test/load-model.test.js` loads the console and
 *            asserts this module agrees with it on both, so a change to the
 *            console's poll rate that the model does not follow fails a test
 *            rather than quietly understating the load. That is the whole
 *            point: an invented rate and a measured one read identically in a
 *            report, and only one of them is evidence.
 *   chw      a community health worker's phone. A queue of reports filed offline
 *            drains as a burst of writes — on load, and again every thirty
 *            seconds — which is the shape the inbound limiter's `write` budget
 *            was written for. Bursty by construction, and the burst is at the
 *            shift handover when the signal comes back.
 *   partner  a partner portal pulling its four collections. It has no timer of
 *            its own, so its cadence is the one parameter here that is a stated
 *            assumption rather than a reading, and it is labelled as one.
 *
 * **Nothing in this module fires a request.** It returns a timeline: a sorted
 * list of `{ at, actor, kind, method, path, endpoint }`. `scripts/load-probe.mjs`
 * drives it against a running server. Keeping the model pure is what makes it
 * testable in milliseconds and what makes a ceiling reproducible: the same seed
 * and the same window give the same timeline, byte for byte.
 *
 * **What is measured and what is assumed.** Every constant below carries its
 * source. Where a source does not exist in the tree the parameter says so in its
 * comment and its default is an assumption the operator is expected to override;
 * a model whose assumptions are invisible is a model whose output cannot be
 * argued with.
 */
import { DEFAULT_SEED, seededRng } from './counterfactual.js'

/* ------------------------------------------------------------- parameters */

/**
 * The console's poll floor, in milliseconds.
 *
 * `public/app.js` exports `POLL_BASE_MS = 30_000`. Restating it here is a
 * duplication, and the test is what keeps it from becoming a divergence: it
 * loads the console module and asserts this equals `POLL_BASE_MS` *and* that it
 * equals what `pollDelayMs({})` returns, because the console schedules from the
 * function and the constant is only its floor.
 */
export const CONSOLE_POLL_BASE_MS = 30_000

/** The console's poll ceiling, for reference. `POLL_MAX_MS` in `public/app.js`. */
export const CONSOLE_POLL_MAX_MS = 300_000

/** The tab a freshly opened console shows. `state.activeTab` in `public/app.js`. */
export const CONSOLE_DEFAULT_TAB = 'alerts'

/**
 * Every endpoint the console can fetch, in the console's own order.
 * `ALL_ENDPOINTS` in `public/app.js`.
 */
export const CONSOLE_ALL_ENDPOINTS = Object.freeze([
  'health', 'sources', 'ingestionHealth', 'flood', 'conflict', 'events',
  'assets', 'alerts', 'reports', 'reportTemplates', 'climate', 'seasonal', 'dispatches', 'workflows',
  'weather', 'riverDischarge', 'diseaseObservations', 'iotObservations',
])

/** Fetched on every tick. `AMBIENT_ENDPOINTS` in `public/app.js`. */
export const CONSOLE_AMBIENT_ENDPOINTS = Object.freeze([
  'health', 'sources', 'ingestionHealth', 'flood', 'conflict', 'events',
  'assets', 'climate', 'weather', 'riverDischarge', 'diseaseObservations', 'iotObservations',
])

/** Endpoints owned by one tab. `TAB_ENDPOINTS` in `public/app.js`. */
export const CONSOLE_TAB_ENDPOINTS = Object.freeze({
  alerts: Object.freeze(['alerts', 'workflows', 'dispatches']),
  reports: Object.freeze(['reports', 'reportTemplates']),
  equity: Object.freeze(['climate', 'seasonal', 'reports']),
  ingestion: Object.freeze(['sources', 'ingestionHealth']),
})

/**
 * The path each console endpoint fetches, copied from the `load(...)` calls in
 * the console's `refresh()`.
 *
 * The query strings are the console's own limits. They matter to the load: the
 * limit decides how many rows the server materialises, so a model that dropped
 * them would measure a cheaper request than the browser actually makes.
 */
export const CONSOLE_ENDPOINT_PATHS = Object.freeze({
  health: '/api/v1/health',
  sources: '/api/v1/sources',
  ingestionHealth: '/api/v1/ingest/status',
  flood: '/api/v1/flood-risk',
  conflict: '/api/v1/conflict-risk',
  events: '/api/v1/events?limit=50',
  assets: '/api/v1/service-assets?limit=100',
  alerts: '/api/v1/alert-events?limit=200',
  reports: '/api/v1/reports?limit=20',
  reportTemplates: '/api/v1/report-templates?limit=20',
  climate: '/api/v1/climate?view=verification',
  seasonal: '/api/v1/climate?source=noaa_enso&limit=500',
  weather: '/api/v1/weather',
  riverDischarge: '/api/v1/river-discharge',
  diseaseObservations: '/api/v1/disease-observations?map=1',
  iotObservations: '/api/v1/iot-observations?map=1',
  dispatches: '/api/v1/rapidpro/dispatches?limit=200',
  workflows: '/api/v1/workflows?limit=200',
})

/**
 * Requests per endpoint per tick.
 *
 * `events` is two calls and the console says why: the region the map is about
 * plus recent global events for context, because asking only for the newest
 * global events let a busy feed page the local flood out of the result. A model
 * that counted `events` once would understate every tick by one request.
 *
 * The `alerts` walk is deliberately *not* multiplied: `fetchAllPages` follows
 * `next_cursor` to the end of the set, so its cost is a property of the data and
 * not of the console, and a model that guessed a page count would be inventing
 * the thing this module exists to stop inventing. The probe reports the observed
 * cost of that route instead.
 */
export const CONSOLE_ENDPOINT_REQUESTS = Object.freeze({ events: 2 })

/**
 * How often a phone's offline queue flushes, in milliseconds.
 * `setInterval(() => { queue.flush() }, 30_000)` in `public/shared/runtime.js`,
 * with an immediate flush on init — so the first drain is at the shift's opening
 * and the rest follow every thirty seconds.
 */
export const CHW_SYNC_INTERVAL_MS = 30_000

/** Records one drain will claim. `claimBatch`'s `limit` in `public/shared/queue-core.js`. */
export const CHW_DRAIN_BATCH_LIMIT = 25

/**
 * The CHW population of the demo store, summed from its own assets.
 *
 * `src/demo-seed.js` declares `chw_count` on five active outposts — 12 at
 * Kakuma, 8 at Bor South, 15 at Aweil, 10 at Moroto, 18 at Mandera — and this is
 * their sum. A pilot catchment's worth of devices, read out of the seed rather
 * than chosen.
 */
export const CHW_POPULATION = 63

/** The path the CHW wizard loads its served form from. `public/chw/app.js`. */
export const CHW_FORM_PATH = '/api/v1/forms/chw_symptom_report'

/** Where a filed report is posted. `public/chw/app.js`. */
export const CHW_REPORT_PATH = '/api/v1/chw/report'

/**
 * The four collections a partner portal pulls, in its own order.
 * `loadData()` in `public/portal/app.js`.
 */
export const PARTNER_ENDPOINT_PATHS = Object.freeze([
  '/api/v1/flood-risk',
  '/api/v1/events',
  '/api/v1/service-assets',
  '/api/v1/rapidpro/dispatches',
])

/* ---------------------------------------------------------------- defaults */

/**
 * The model's default population and window.
 *
 * Read the comments as claims, because that is what they are. `console.tab`,
 * `chw.count` and every path above are read out of the tree. `chw.backlogMean`,
 * `chw.reportsPerHour` and `partner.*` are **assumptions**: the tree has no
 * figure for how often a health worker files a report or how often a partner
 * opens the portal, so these are the numbers a reviewer should argue with, and
 * every one of them is overridable.
 */
export const LOAD_MODEL_DEFAULTS = Object.freeze({
  seed: DEFAULT_SEED,
  /** One minute of modelled wall clock. Short on purpose: the probe drives it at 1:1. */
  windowMs: 60_000,
  /**
   * A timeline longer than this is refused rather than truncated. A truncated
   * timeline is a measurement of something other than what was asked for, and it
   * would report as a clean run — the one failure mode a load model may not have.
   */
  maxRequests: 500_000,
  console: Object.freeze({
    count: 1,
    tab: CONSOLE_DEFAULT_TAB,
    /**
     * Consoles open together, at the window's opening. Deliberate: the question
     * is a ceiling, and the worst case is the shift handover where every
     * supervisor opens the console at once and each pays for all eighteen
     * endpoints in the same second.
     */
    openStaggerMs: 0,
  }),
  chw: Object.freeze({
    count: CHW_POPULATION,
    /**
     * Reports already queued when the shift opens, drawn per device from the
     * seed in `0 .. 2 * backlogMean`. This is the normal field case, not an edge
     * one: a report filed without signal is queued, and the queue is what
     * arrives when the signal does. Assumption.
     */
    backlogMean: 3,
    /** Reports filed per hour of shift, per device. Assumption. */
    reportsPerHour: 1,
    /** Shifts open together, at the window's opening. The worst case, as above. */
    shiftStaggerMs: 0,
  }),
  partner: Object.freeze({
    /** Partner organisations pulling at once. Assumption: a deployment's token list decides. */
    count: 3,
    /** Revisit cadence. Assumption: the portal has no timer, so this is a revisit and not a poll. */
    pullIntervalMs: 300_000,
    /** Pulls are staggered over this, so three partners are not one thundering herd. Assumption. */
    pullStaggerMs: 60_000,
  }),
})

/* ------------------------------------------------------------------ checks */

function nonNegativeInt(value, name) {
  if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
    throw new TypeError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function positiveMs(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds, got ${JSON.stringify(value)}`)
  }
  return value
}

function resolveModel(options = {}) {
  const merged = {
    ...LOAD_MODEL_DEFAULTS,
    ...options,
    console: { ...LOAD_MODEL_DEFAULTS.console, ...(options.console || {}) },
    chw: { ...LOAD_MODEL_DEFAULTS.chw, ...(options.chw || {}) },
    partner: { ...LOAD_MODEL_DEFAULTS.partner, ...(options.partner || {}) },
  }
  nonNegativeInt(merged.seed, 'seed')
  positiveMs(merged.windowMs, 'windowMs')
  nonNegativeInt(merged.maxRequests, 'maxRequests')
  nonNegativeInt(merged.console.count, 'console.count')
  nonNegativeInt(merged.console.openStaggerMs, 'console.openStaggerMs')
  nonNegativeInt(merged.chw.count, 'chw.count')
  nonNegativeInt(merged.chw.backlogMean, 'chw.backlogMean')
  nonNegativeInt(merged.partner.count, 'partner.count')
  positiveMs(merged.partner.pullIntervalMs, 'partner.pullIntervalMs')
  if (!CONSOLE_TAB_ENDPOINTS[merged.console.tab]) {
    throw new TypeError(`console.tab must be one of ${Object.keys(CONSOLE_TAB_ENDPOINTS).join(', ')}, got ${JSON.stringify(merged.console.tab)}`)
  }
  return merged
}

/* ------------------------------------------------------------------- ticks */

/**
 * What one console tick fetches.
 *
 * The boot tick pays for every endpoint once so no tab opens against an empty
 * store; every later tick fetches the ambient set plus the open tab's own, which
 * is `endpointsForTab`. Deduped in insertion order, because that is what the
 * console's own `Set` does — `equity` lists `climate`, which is already ambient,
 * and a model that double-counted it would report a request the browser never
 * makes.
 *
 * A name with no path is a **refusal**, not a skip. Silently dropping it would
 * understate the load by exactly the endpoint someone added to the console and
 * forgot to model, which is the drift this module is built to prevent.
 */
export function consoleTickEndpoints(tab = CONSOLE_DEFAULT_TAB, { first = false } = {}) {
  const names = first
    ? CONSOLE_ALL_ENDPOINTS
    : [...CONSOLE_AMBIENT_ENDPOINTS, ...(CONSOLE_TAB_ENDPOINTS[tab] || [])]
  const seen = new Set()
  const out = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const path = CONSOLE_ENDPOINT_PATHS[name]
    if (!path) throw new Error(`no path modelled for console endpoint "${name}"; the load model would silently skip it`)
    out.push({ endpoint: name, path, count: CONSOLE_ENDPOINT_REQUESTS[name] || 1 })
  }
  return out
}

/** One console's requests over the window. `pollDelayMs` with no failures, no hidden tab, nothing in flight. */
function consoleRequests({ actor, openMs, windowMs, tab }) {
  const out = []
  let first = true
  for (let at = openMs; at < windowMs; at += CONSOLE_POLL_BASE_MS) {
    for (const tick of consoleTickEndpoints(tab, { first })) {
      for (let i = 0; i < tick.count; i += 1) {
        out.push({ at, actor, kind: 'console', method: 'GET', path: tick.path, endpoint: tick.endpoint })
      }
    }
    first = false
  }
  return out
}

/**
 * One device's requests over the window: the served-form read when the wizard
 * opens, then the queue draining on the flush tick.
 *
 * Reports accumulate at `reportsPerHour` and are sent by the next flush, capped
 * at the batch size with the remainder carried to the next tick — the cap is
 * `claimBatch`'s, and a drain that ignored it would claim more than the queue
 * hands it. A flush with nothing queued issues nothing, which is why a device
 * idle for an hour is one request and not a hundred and twenty.
 */
function chwRequests({ actor, startMs, windowMs, backlog, reportsPerHour, syncIntervalMs, batchLimit }) {
  const out = []
  out.push({ at: startMs, actor, kind: 'chw', method: 'GET', path: CHW_FORM_PATH, endpoint: 'chwForm' })

  const reportIntervalMs = reportsPerHour > 0 ? 3_600_000 / reportsPerHour : Infinity
  let queued = backlog
  let nextReportMs = startMs + reportIntervalMs
  for (let at = startMs; at < windowMs; at += syncIntervalMs) {
    while (nextReportMs <= at) {
      queued += 1
      nextReportMs += reportIntervalMs
    }
    const send = Math.min(queued, batchLimit)
    queued -= send
    for (let i = 0; i < send; i += 1) {
      out.push({ at, actor, kind: 'chw', method: 'POST', path: CHW_REPORT_PATH, endpoint: 'chwReport' })
    }
  }
  return out
}

/** One partner's pulls over the window. Four reads per pull, no timer of its own. */
function partnerRequests({ actor, startMs, windowMs, pullIntervalMs }) {
  const out = []
  for (let at = startMs; at < windowMs; at += pullIntervalMs) {
    for (const path of PARTNER_ENDPOINT_PATHS) {
      out.push({ at, actor, kind: 'partner', method: 'GET', path, endpoint: path })
    }
  }
  return out
}

/* ---------------------------------------------------------------- timeline */

/**
 * The modelled population as a sorted list of requests.
 *
 * Deterministic from the seed: the only randomness is the per-device backlog and
 * the shift and pull staggers, drawn in a fixed order from one generator, so two
 * runs of the same seed produce the same timeline and a ceiling found once can
 * be found again.
 *
 * A population of zero actors is a valid model — an empty deployment — and
 * returns an empty timeline rather than throwing, because "no users, no load" is
 * a true answer and a caller checking the degenerate case should not have to
 * catch.
 */
export function buildTimeline(options = {}) {
  const model = resolveModel(options)
  const rng = seededRng(model.seed)
  const requests = []
  const actors = []
  let seq = 0

  const push = (batch) => {
    for (const request of batch) {
      if (request.at < 0 || request.at >= model.windowMs) continue
      requests.push({ ...request, seq: seq += 1 })
      if (requests.length > model.maxRequests) {
        throw new RangeError(
          `the model would issue more than ${model.maxRequests} requests; refusing rather than measuring a truncated timeline. `
          + 'Narrow windowMs, lower the actor counts, or raise maxRequests deliberately.',
        )
      }
    }
  }

  for (let i = 0; i < model.console.count; i += 1) {
    const actor = `console-${i}`
    const openMs = model.console.openStaggerMs ? Math.floor(rng() * model.console.openStaggerMs) : 0
    actors.push({ actor, kind: 'console', openedAtMs: openMs })
    push(consoleRequests({ actor, openMs, windowMs: model.windowMs, tab: model.console.tab }))
  }

  for (let i = 0; i < model.chw.count; i += 1) {
    const actor = `chw-${i}`
    const startMs = model.chw.shiftStaggerMs ? Math.floor(rng() * model.chw.shiftStaggerMs) : 0
    // Drawn even when it is zero, so the seed consumes the same number of draws
    // per device and a stagger change cannot silently reshuffle every backlog.
    const backlog = Math.floor(rng() * (2 * model.chw.backlogMean + 1))
    actors.push({ actor, kind: 'chw', startedAtMs: startMs, queuedAtStart: backlog })
    push(chwRequests({
      actor,
      startMs,
      windowMs: model.windowMs,
      backlog,
      reportsPerHour: model.chw.reportsPerHour,
      syncIntervalMs: CHW_SYNC_INTERVAL_MS,
      batchLimit: CHW_DRAIN_BATCH_LIMIT,
    }))
  }

  for (let i = 0; i < model.partner.count; i += 1) {
    const actor = `partner-${i}`
    const startMs = model.partner.pullStaggerMs ? Math.floor(rng() * model.partner.pullStaggerMs) : 0
    actors.push({ actor, kind: 'partner', firstPullAtMs: startMs })
    push(partnerRequests({ actor, startMs, windowMs: model.windowMs, pullIntervalMs: model.partner.pullIntervalMs }))
  }

  requests.sort((a, b) => (a.at - b.at) || (a.seq - b.seq))

  const byKind = { console: 0, chw: 0, partner: 0 }
  const byMethod = {}
  const byRoute = {}
  for (const request of requests) {
    byKind[request.kind] = (byKind[request.kind] || 0) + 1
    byMethod[request.method] = (byMethod[request.method] || 0) + 1
    const route = `${request.method} ${request.path.split('?')[0]}`
    byRoute[route] = (byRoute[route] || 0) + 1
  }

  return {
    seed: model.seed,
    windowMs: model.windowMs,
    actors,
    requests,
    totals: {
      requests: requests.length,
      byKind,
      byMethod,
      byRoute,
      requestsPerSecond: requests.length / (model.windowMs / 1000),
    },
  }
}
