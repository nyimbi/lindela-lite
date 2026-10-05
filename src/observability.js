const processStartAt = Date.now()

export function uptimeStats() {
  return {
    started_at: new Date(processStartAt).toISOString(),
    uptime_seconds: Math.floor((Date.now() - processStartAt) / 1000),
  }
}

// Ring buffer of last 100 request outcomes for short-term success rate
const REQUEST_RING_SIZE = 100
const _requestRing = []

export function recordRequestOutcome(ok) {
  _requestRing.push({ ts: Date.now(), ok: Boolean(ok) })
  if (_requestRing.length > REQUEST_RING_SIZE) _requestRing.shift()
}

export function recentRequestOutcomes() {
  return [..._requestRing]
}

export function computeShortTermSuccessRate() {
  if (!_requestRing.length) return null
  const successful = _requestRing.filter((r) => r.ok).length
  return (successful / _requestRing.length) * 100
}

const LOG_LEVEL = process.env.LINDELA_LITE_LOG_LEVEL || 'info'
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

export const logger = {
  // R-55. `LOG_LEVELS` has always declared `debug`, so
  // `LINDELA_LITE_LOG_LEVEL=debug` was a setting that changed nothing: the
  // level existed, the method did not, and an operator who turned it on to see
  // what the pipeline was doing got exactly the same firehose.
  debug: (event, fields = {}) => logEvent('debug', event, fields),
  info: (event, fields = {}) => logEvent('info', event, fields),
  warn: (event, fields = {}) => logEvent('warn', event, fields),
  error: (event, fields = {}) => logEvent('error', event, fields),
}

function logEvent(level, event, fields) {
  if (LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return
  const log = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  }
  console.error(JSON.stringify(log))
}

// -------------------------------------------------------------------
// Metric label cardinality (R-37)
// -------------------------------------------------------------------
//
// `metrics.counter('http_requests_total', { method, route, status })` builds its
// series key from the label values, so every distinct combination is a series
// that never goes away. `normalizeRoute` in `src/server.js` collapses id-shaped
// segments, which handles `/hazards/<uuid>` and nothing else: a scanner
// probing `/wp-admin`, `/a/b/c/d/e` or a random slug a quarter produces a
// permanent series per path. Nothing is watching a dashboard, so the process
// that would have noticed is the process that does not exist.
//
// Three bounds, and the third exists because the second is a heuristic:
//
//   1. An allowlist of label *keys* per metric. A caller cannot invent a label
//      dimension by adding a field to an object literal.
//   2. A per-label-key budget on distinct *values*. A route value outside the
//      budget collapses into one `/unmatched` series, which is the number an
//      operator actually wants ("requests that hit no known route").
//   3. A hard series cap with last-touched eviction. Bounds 1 and 2 are
//      per-key, so a metric with five allowed labels can still reach
//      2^5-ish combinations. The cap is the backstop, and it reports its own
//      evictions rather than discarding them silently.

export const METRIC_LABEL_ALLOWLIST = Object.freeze({
  http_requests_total: Object.freeze(['method', 'route', 'status']),
  http_request_duration_ms: Object.freeze(['method', 'route', 'status']),
  ingestion_runs_total: Object.freeze(['source', 'status']),
  ingestion_duration_ms: Object.freeze(['source']),
})

/** The bucket every label value beyond its budget collapses into. */
export const UNMATCHED_LABEL = '/unmatched'

const LABEL_VALUE_BUDGET = Object.freeze({ route: 48, method: 12, status: 32, source: 32 })

/** Hard cap on series per metric family, across counters and histograms. */
export const MAX_METRIC_SERIES = 512

/** R-38. Trailing samples retained for p50/p95, mirroring CIRCUIT_HISTORY_WINDOW. */
export const HISTOGRAM_WINDOW = 20

const HISTOGRAM_BUCKETS = Object.freeze([5, 25, 100, 500, 2000, 10000])

/** Distinct values seen per label key, in insertion order. */
const labelValuesSeen = new Map()
const overflow = { droppedKeys: 0, bucketedValues: 0, evictedSeries: 0 }

function labelValueBudget(key) {
  return LABEL_VALUE_BUDGET[key] ?? 16
}

/**
 * The value to record for one label, or `null` to drop the label entirely.
 *
 * Two different refusals with two different reasons. An unknown *key* is a
 * programming error the caller should see, so it is counted and dropped. A
 * known key with a value past its budget is not an error — it is the normal
 * consequence of a scanner — so it is folded into `/unmatched` and counted
 * separately.
 */
function boundedLabelValue(metricName, key, value) {
  const allow = METRIC_LABEL_ALLOWLIST[metricName]
  if (allow && !allow.includes(key)) {
    overflow.droppedKeys += 1
    return null
  }
  const text = String(value)
  const seenKey = `${metricName}|${key}`
  let seen = labelValuesSeen.get(seenKey)
  if (!seen) {
    seen = new Set()
    labelValuesSeen.set(seenKey, seen)
  }
  if (seen.has(text)) return text
  if (seen.size >= labelValueBudget(key)) {
    overflow.bucketedValues += 1
    return UNMATCHED_LABEL
  }
  seen.add(text)
  return text
}

/** Every allowlisted label, with over-budget values folded into `/unmatched`. */
function boundLabels(name, labels) {
  const bounded = {}
  for (const [key, value] of Object.entries(labels || {})) {
    if (value === null || value === undefined) continue
    const text = boundedLabelValue(name, key, value)
    if (text !== null) bounded[key] = text
  }
  return bounded
}

/**
 * Evict the least-recently-touched series in a family once it is over cap.
 *
 * Insertion order is the recency order: `touch` deletes and re-sets a key, so
 * the first key in the Map is the one nobody has written to longest. Dropping
 * the oldest is the right victim for a counter — a series that stopped being
 * incremented is a series whose route stopped being called.
 */
function enforceSeriesCap(family) {
  while (family.size > MAX_METRIC_SERIES) {
    const oldest = family.keys().next().value
    family.delete(oldest)
    overflow.evictedSeries += 1
  }
}

function touch(family, key, entry) {
  if (family.has(key)) family.delete(key)
  family.set(key, entry)
  enforceSeriesCap(family)
  return entry
}

const metricsStore = {
  counters: new Map(),
  histograms: new Map(),
}

/** Test seam: process-level metric state is process state, not audit state. */
export function resetMetrics() {
  metricsStore.counters.clear()
  metricsStore.histograms.clear()
  labelValuesSeen.clear()
  overflow.droppedKeys = 0
  overflow.bucketedValues = 0
  overflow.evictedSeries = 0
}

/** What the bounds above refused. Reported, never silently absorbed. */
export function metricsOverflow() {
  return { ...overflow, max_series: MAX_METRIC_SERIES, series: metricsStore.counters.size + metricsStore.histograms.size }
}

export const metrics = {
  counter: (name, labels = {}) => {
    const bounded = boundLabels(name, labels)
    const key = buildMetricKey(name, bounded)
    const existing = metricsStore.counters.get(key)
    if (existing) {
      touch(metricsStore.counters, key, existing)
      existing.value += 1
      return existing.value
    }
    const entry = { name, labels: bounded, value: 1 }
    return touch(metricsStore.counters, key, entry).value
  },

  /**
   * R-38. Buckets accumulate at observation time; `render()` reads them.
   *
   * It used to push every sample into an array and re-walk the whole array on
   * every scrape, so scrape cost grew with every request since boot and the
   * `buckets` field sat there declared and unused. Now a sample costs one pass
   * over seven bucket edges at write time, and a scrape costs one pass over the
   * series.
   *
   * A bounded trailing window is still kept, because the histogram exposition
   * has nowhere to put a percentile and an operator debugging a slow source
   * wants one. It is `HISTOGRAM_WINDOW` samples long and `quantiles()` reads
   * it — mirroring `CIRCUIT_HISTORY_WINDOW` in `src/circuit.js`, for the same
   * reason: a percentile over an unbounded window is a percentile over the
   * uptime of the process, not over the source.
   */
  histogram: (name, valueMs, labels = {}) => {
    const bounded = boundLabels(name, labels)
    const key = buildMetricKey(name, bounded)
    const value = Number(valueMs)
    let entry = metricsStore.histograms.get(key)
    if (!entry) {
      // Cumulative by construction: `counts[i]` is the number of samples at or
      // below `buckets[i]`, which is what a Prometheus histogram is, so there is
      // no fold step in render() that could disagree with what was recorded.
      entry = {
        name,
        labels: bounded,
        buckets: [...HISTOGRAM_BUCKETS],
        counts: HISTOGRAM_BUCKETS.map(() => 0),
        inf: 0,
        sum: 0,
        count: 0,
        window: [],
      }
    }
    entry.sum += value
    entry.count += 1
    entry.inf += 1
    for (let i = 0; i < entry.buckets.length; i += 1) {
      if (value <= entry.buckets[i]) entry.counts[i] += 1
    }
    entry.window.push(value)
    if (entry.window.length > HISTOGRAM_WINDOW) {
      entry.window.splice(0, entry.window.length - HISTOGRAM_WINDOW)
    }
    touch(metricsStore.histograms, key, entry)
  },

  /**
   * `{ p50, p95, samples }` over the retained trailing window, or nulls when
   * nothing has been observed. Null rather than 0 for an empty window, for the
   * reason `scoreConnector` declines to score an empty one.
   */
  quantiles: (name, labels = {}) => {
    const key = buildMetricKey(name, boundLabels(name, labels))
    const entry = metricsStore.histograms.get(key)
    if (!entry || !entry.window.length) return { p50: null, p95: null, samples: 0 }
    const sorted = [...entry.window].sort((a, b) => a - b)
    return {
      p50: quantile(sorted, 50),
      p95: quantile(sorted, 95),
      samples: sorted.length,
    }
  },

  render: () => {
    let output = '# HELP process_up Server is running\n# TYPE process_up gauge\nprocess_up 1\n\n'

    for (const [, entry] of metricsStore.counters) {
      const labels = formatLabels(entry.labels)
      output += `# HELP ${entry.name} Counter metric\n`
      output += `# TYPE ${entry.name} counter\n`
      output += `${entry.name}${labels} ${entry.value}\n\n`
    }

    for (const [, entry] of metricsStore.histograms) {
      const labels = formatLabels(entry.labels)
      output += `# HELP ${entry.name} Histogram metric\n`
      output += `# TYPE ${entry.name} histogram\n`

      // R-39. The old line sliced the trailing `}` off the label string and
      // appended `le="…"`. With no labels that slice is `''`, the separator is
      // absent, and the emitted sample reads `metric_bucket le="5" 3` — no
      // brace, so a Prometheus scraper drops the series and nothing reports the
      // drop. Both histograms in this repo carry labels today, which is why it
      // is latent and why it will be found by the first label-less metric
      // anyone adds. Built, not sliced.
      for (let i = 0; i < entry.buckets.length; i += 1) {
        output += `${entry.name}_bucket${formatLabels({ ...entry.labels, le: String(entry.buckets[i]) })} ${entry.counts[i]}\n`
      }
      output += `${entry.name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.inf}\n`

      output += `${entry.name}_sum${labels} ${entry.sum}\n`
      output += `${entry.name}_count${labels} ${entry.count}\n\n`
    }

    return output
  },
}

export function timer() {
  const start = Date.now()
  return {
    end: () => Date.now() - start,
  }
}

function buildMetricKey(name, labels) {
  return `${name}:${JSON.stringify(labels)}`
}

function formatLabels(labels) {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  const pairs = keys.map((k) => `${k}="${labels[k]}"`)
  return `{${pairs.join(',')}}`
}

function quantile(sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}
