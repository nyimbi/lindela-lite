/**
 * ENH-10: connector circuit breaking and health scoring.
 *
 * Why this module exists. `failureStreak()` in `src/ingestion.js` counts
 * consecutive failed runs, hands the number to `ingestionStatus()`, and nothing
 * reads it. A provider that has been returning HTTP 502 for six days is
 * therefore retried in full — three attempts, backoff, timeout — on every
 * run-due tick, spending wall clock that the four healthy sources behind it need.
 * The failure is visible in the JSON and invisible in the behaviour, which is the
 * worst place for a signal to live: an operator reading `/api/v1/ingestion`
 * concludes someone should look at it, and then it goes on eating the budget
 * anyway.
 *
 * What this adds. A three-state breaker per source (`closed`, `open`,
 * `half_open`), and a health score computed from success rate, latency percentiles
 * and payload drift over a trailing window.
 *
 * Two orthogonal axes, deliberately. `allowRequest()` returns both a *gate*
 * decision (`allowed`) and a *verdict* (`reason`), because ENH-06 wants one
 * verdict per source (`ok | quiet | stale | broken`) and ENH-10 wants a
 * circuit-open skip to be reportable as neither. Conflating them is how a dead
 * source and a skipped one end up rendering as the same word:
 *
 *   ok                    allowed, breaker closed, last outcome succeeded
 *   broken                allowed, breaker closed, last outcome failed below the
 *                         trip threshold — we are still calling it
 *   skipped_circuit_open   denied, breaker open and still in cooldown
 *   probing_half_open      allowed once, the single post-cooldown probe
 *   skipped_circuit_probe_in_flight
 *                         denied, the probe has not reported back yet
 *
 * A run skipped by the breaker must not report `ok` (nothing was fetched) and
 * must not report `broken` (the source is not broken, we declined to ask it).
 *
 * Wiring contract (for the parallel change that calls this):
 *   - `createCircuitState()` builds the empty store; persist it anywhere.
 *   - `allowRequest(state, source, { now })` gate before `connector.ingest()`.
 *   - `recordOutcome(state, source, { ok, latencyMs, recordCount, now })` after.
 *   - `outcomesFor(state, source)` feeds `scoreConnector({ outcomes })`.
 *   - `circuitStateFor(state, source, { now })` for a status view.
 *   - `CIRCUIT_STATES` is the vocabulary; iterate it rather than re-typing
 *     `'open'` at the call site, the way `OUTPUT_COLLECTIONS` exists in
 *     `src/ingestion.js` for exactly the reason spelled out there.
 *
 * Mutation and the clock. `allowRequest()` and `recordOutcome()` mutate the state
 * object they are given and return it — claiming the half-open probe is part of
 * gating, and a pure return-value gate would need a second call to hold the
 * claim. Every function takes `now` explicitly rather than reading the clock, so
 * the whole state machine is exercisable without sleeping.
 *
 * The anti-vacuous rule, which is the sharp part of this item. Nothing here
 * returns a healthy number for a quantity it did not measure. Zero samples is
 * `null` with a reason, never `100`. Drift with nothing to compare against is
 * `null`, never `0` — a drift of zero asserts "payload size is stable", which is
 * unknowable from an empty baseline and is the exact conflation this repository
 * has already paid for elsewhere. Where a component is unknown the score is
 * `null`; it is not renormalised over the components that happen to be known,
 * because a score computed from two of three signals reads as a score computed
 * from three.
 */

export const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half_open'])

// Three, not two and not five: two trips on a single flaky provider turns every
// transient blip into a source we stop calling, and five means a source is down
// for an hour before anyone stops paying for it.
export const CIRCUIT_FAILURE_THRESHOLD = 3
export const CIRCUIT_COOLDOWN_MINUTES = 30

// Trailing window for scoring and for the retained outcome history. Long enough
// that one bad afternoon does not define a source, short enough to still notice
// that the provider changed shape last week.
export const CIRCUIT_HISTORY_WINDOW = 20

// A connector that cannot answer inside this has already consumed the budget it
// was allowed. Matches the 20s default timeout in `src/ingestion.js`.
export const CIRCUIT_LATENCY_BUDGET_MS = 20000

export const CIRCUIT_SCORE_WEIGHTS = Object.freeze({
  success_rate: 0.6,
  latency: 0.25,
  record_drift: 0.15,
})

// The reasons `scoreConnector` can decline to score, in one iterable place. Same
// reasoning as CIRCUIT_STATES: a list written once and checked nowhere is how the
// vocabulary drifts from the code.
export const CIRCUIT_SCORE_REASONS = Object.freeze({
  NO_OUTCOMES: 'no_outcomes',
  LATENCY_UNKNOWN: 'latency_unknown',
  RECORD_DRIFT_UNKNOWN: 'record_drift_unknown',
  P95_FROM_SINGLE_SAMPLE: 'p95_from_single_sample',
})

const COOLDOWN_MS = CIRCUIT_COOLDOWN_MINUTES * 60000

export function createCircuitState() {
  return { version: 1, sources: {} }
}

function blankEntry() {
  return {
    state: CIRCUIT_STATES[0],
    consecutive_failures: 0,
    opened_at: null,
    probe_in_flight: false,
    history: [],
  }
}

function entryFor(state, source) {
  return state?.sources?.[source] || blankEntry()
}

// `opened_at: null` on an open circuit means the time the trip happened was not
// recorded. Treat the cooldown as unelapsed: a breaker that cannot say how long
// it has been open has no licence to start probing.
function cooldownElapsed(entry, now) {
  if (entry.opened_at === null || entry.opened_at === undefined) return false
  const at = typeof entry.opened_at === 'number' ? entry.opened_at : Date.parse(entry.opened_at)
  if (!Number.isFinite(at)) return false
  return Number(now) - at >= COOLDOWN_MS
}

/**
 * The state a source is in right now, including the open → half_open transition
 * that the cooldown makes due. Pure: an open circuit past its cooldown reports
 * `half_open` here without being written back.
 */
export function circuitStateFor(state, source, { now = Date.now() } = {}) {
  const entry = entryFor(state, source)
  if (entry.state === 'open' && cooldownElapsed(entry, now)) return 'half_open'
  return entry.state
}

/**
 * Gate one provider call. Returns `{ allowed, reason, state, probe }`.
 *
 * Permits exactly one probe per half-open episode: the call that returns
 * `allowed: true, probe: true` sets `probe_in_flight`, and the next caller gets
 * `skipped_circuit_probe_in_flight` until `recordOutcome` clears it.
 */
export function allowRequest(state, source, { now = Date.now() } = {}) {
  const entry = entryFor(state, source)
  const current = circuitStateFor(state, source, { now })

  if (current === 'open') {
    return { allowed: false, reason: 'skipped_circuit_open', state: current, probe: false }
  }

  if (current === 'half_open') {
    if (entry.probe_in_flight) {
      return { allowed: false, reason: 'skipped_circuit_probe_in_flight', state: current, probe: false }
    }
    entry.probe_in_flight = true
    if (state && !state.sources) state.sources = {}
    if (state) state.sources[source] = entry
    const reason = entry.consecutive_failures > 0 ? 'probing_half_open' : 'ok'
    return { allowed: true, reason, state: current, probe: true }
  }

  // Closed. The breaker has not tripped, but a source that failed on the last run
  // is not `ok` — ENH-06's verdict for it is `broken`, and saying otherwise here
  // is the same class of error as the empty score.
  return { allowed: true, reason: entry.consecutive_failures > 0 ? 'broken' : 'ok', state: current, probe: false }
}

/**
 * Advance the breaker and retain the outcome for scoring. Mutates and returns
 * `state`.
 */
export function recordOutcome(state, source, { ok, latencyMs, latency_ms, recordCount, record_count, now = Date.now() } = {}) {
  if (!state) state = createCircuitState()
  if (!state.sources) state.sources = {}

  const entry = entryFor(state, source)
  const succeeded = Boolean(ok)
  const latency = finiteOrNull(latencyMs ?? latency_ms)
  // 0 is a real record count — an upstream that returns a valid empty page has
  // told us something, and truthiness would file it as "no measurement" and then
  // quietly exclude the run from the drift baseline.
  const records = finiteOrNull(recordCount ?? record_count)

  entry.history.push({ ok: succeeded, latency_ms: latency, record_count: records, at: now })
  if (entry.history.length > CIRCUIT_HISTORY_WINDOW) {
    entry.history.splice(0, entry.history.length - CIRCUIT_HISTORY_WINDOW)
  }
  entry.probe_in_flight = false

  const current = circuitStateFor(state, source, { now })

  if (current === 'half_open') {
    if (succeeded) {
      entry.state = 'closed'
      entry.consecutive_failures = 0
      entry.opened_at = null
    } else {
      entry.state = 'open'
      entry.consecutive_failures = Math.max(entry.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD)
      entry.opened_at = now
    }
  } else if (current === 'open') {
    // An open circuit should not be called; if something calls it anyway, take
    // the result at face value rather than silently resetting a trip.
    if (succeeded) {
      entry.state = 'closed'
      entry.consecutive_failures = 0
      entry.opened_at = null
    } else {
      entry.opened_at = now
    }
  } else {
    entry.consecutive_failures = succeeded ? 0 : entry.consecutive_failures + 1
    if (entry.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD) {
      entry.state = 'open'
      entry.opened_at = now
    }
  }

  state.sources[source] = entry
  return state
}

/** The retained outcomes for a source, oldest first, trimmed to the window. */
export function outcomesFor(state, source) {
  return entryFor(state, source).history.slice()
}

/**
 * Health score in [0, 100] from success rate, latency and payload drift over the
 * trailing window. Returns `{ score, success_rate, p50_latency_ms,
 * p95_latency_ms, record_drift_ratio, samples, latency_samples, drift_samples,
 * reasons, reason }`.
 *
 * `score` is `null` whenever a component it needs is unmeasured, and `reason`
 * names the first one. A source with no history scores `null`, not 100 — a
 * perfect score is a claim, and a source nobody has called yet supports none.
 */
export function scoreConnector({ outcomes = [] } = {}) {
  const window = Array.isArray(outcomes) ? outcomes.slice(-CIRCUIT_HISTORY_WINDOW) : []
  const samples = window.length
  const reasons = []

  const successes = window.filter((outcome) => Boolean(outcome?.ok)).length
  const success_rate = samples > 0 ? successes / samples : null

  const latencies = window
    .map((outcome) => finiteOrNull(outcome?.latency_ms ?? outcome?.latencyMs))
    .filter((value) => value !== null)
    .sort((a, b) => a - b)

  const p50_latency_ms = percentile(latencies, 50)
  const p95_latency_ms = percentile(latencies, 95)

  const drift = recordDrift(window)

  if (samples === 0) reasons.push(CIRCUIT_SCORE_REASONS.NO_OUTCOMES)
  if (p95_latency_ms === null) reasons.push(CIRCUIT_SCORE_REASONS.LATENCY_UNKNOWN)
  if (drift.ratio === null) reasons.push(CIRCUIT_SCORE_REASONS.RECORD_DRIFT_UNKNOWN)
  if (latencies.length === 1) reasons.push(CIRCUIT_SCORE_REASONS.P95_FROM_SINGLE_SAMPLE)

  const score = reasons.length > 0
    ? null
    : round(
        CIRCUIT_SCORE_WEIGHTS.success_rate * success_rate * 100
        + CIRCUIT_SCORE_WEIGHTS.latency * latencyScore(p95_latency_ms) * 100
        + CIRCUIT_SCORE_WEIGHTS.record_drift * (1 - Math.min(drift.ratio, 1)) * 100,
      )

  return {
    score,
    success_rate,
    p50_latency_ms,
    p95_latency_ms,
    record_drift_ratio: drift.ratio,
    samples,
    latency_samples: latencies.length,
    drift_samples: drift.samples,
    reasons,
    reason: reasons.length ? reasons[0] : null,
  }
}

// One sample is not a percentile. Returning that sample as the p95 is true of the
// data and false about the distribution, so the value stands but the sample count
// and the reason travel with it.
function percentile(sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}

/**
 * Payload drift: the newest record count against the mean of the counts before
 * it. `null` when there is no baseline to compare against, and `null` when the
 * baseline mean is 0 — dividing by it yields Infinity, not a ratio, and 0 is not
 * the answer either.
 */
function recordDrift(window) {
  const counts = window
    .map((outcome) => finiteOrNull(outcome?.record_count ?? outcome?.recordCount))
    .filter((value) => value !== null)

  if (counts.length < 2) return { ratio: null, samples: counts.length }

  const baseline = counts.slice(0, -1)
  const mean = baseline.reduce((total, value) => total + value, 0) / baseline.length
  if (mean === 0) return { ratio: null, samples: counts.length }

  return { ratio: Math.abs(counts[counts.length - 1] - mean) / mean, samples: counts.length }
}

function latencyScore(p95) {
  if (p95 === null || p95 === 0) return 1
  return Math.max(0, Math.min(1, 1 - p95 / CIRCUIT_LATENCY_BUDGET_MS))
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value) {
  return Math.round(value * 100) / 100
}
