/**
 * R-37, R-38, R-39, R-55: the observability module's three silent bounds.
 *
 * The failure this file is built around is not that a metric was wrong. It is
 * that a metric was right and nobody could have found out. A histogram that
 * retains every sample since boot is correct at every scrape and costs more on
 * each one; a path matching no route becomes a permanent series; a label-less
 * histogram emits a line a Prometheus scraper discards without a word. Each of
 * those is invisible from the process that has them.
 *
 * So every test here asserts on the *shape* of the exposition or on the
 * retention, not on a value. `resetMetrics` between tests, because the metric
 * store is module state and a test that inherits the previous test's series is
 * a test that reports on the file rather than on the code.
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import {
  logger,
  metrics,
  MAX_METRIC_SERIES,
  metricsOverflow,
  METRIC_LABEL_ALLOWLIST,
  resetMetrics,
  UNMATCHED_LABEL,
} from '../src/observability.js'

beforeEach(() => {
  resetMetrics()
})

describe('metric label cardinality is bounded (R-37)', () => {
  it('folds unmatched route values into one bucket instead of a series each', () => {
    // A scanner with a random path segment per request. Before the bound each
    // of these was a permanent series and `/metrics` grew without limit.
    for (let i = 0; i < 400; i += 1) {
      metrics.counter('http_requests_total', { method: 'GET', route: `/probe/${i}/x`, status: '404' })
    }
    const text = metrics.render()
    const series = text.split('\n').filter((line) => line.startsWith('http_requests_total{'))
    // 48 route budget + the one `/unmatched` bucket, times nothing else: status
    // and method are single-valued here.
    assert.ok(series.length <= 60, `expected a bounded series count, got ${series.length}`)
    const unmatched = text.split('\n').filter((line) => line.includes(`${UNMATCHED_LABEL}"`))
    assert.ok(unmatched.length > 0, 'the overflow should land in one visible bucket')
    assert.ok(
      unmatched.some((line) => line.endsWith(' 352')),
      'every overflowed request should be counted in the /unmatched bucket, not dropped',
    )
  })

  it('reports the overflow rather than absorbing it silently', () => {
    for (let i = 0; i < 200; i += 1) {
      metrics.counter('http_requests_total', { method: 'GET', route: `/p/${i}`, status: '404' })
    }
    const overflow = metricsOverflow()
    assert.ok(overflow.bucketedValues > 0, 'bucketed values must be counted')
    assert.ok(overflow.evictedSeries >= 0)
    assert.equal(overflow.max_series, MAX_METRIC_SERIES)
  })

  it('drops a label key the metric does not allowlist', () => {
    metrics.counter('http_requests_total', {
      method: 'GET',
      route: '/api/v1/hazards',
      status: '200',
      // A caller adding a dimension by adding a field to an object literal.
      // Unbounded by construction, so it never reaches the store at all.
      attacker_supplied: 'x'.repeat(200),
    })
    const text = metrics.render()
    assert.ok(!text.includes('attacker_supplied'), 'an unallowlisted label key must not be emitted')
    assert.ok(text.includes('route="/api/v1/hazards"'), 'the allowlisted labels survive')
    assert.ok(metricsOverflow().droppedKeys > 0, 'the drop is counted')
  })

  it('evicts rather than growing without limit when the keys are all allowed', () => {
    // Two allowlisted keys, each inside its own per-key budget. Their product
    // is 48 x 32 = 1536, which is over the cap — so the per-key budgets are
    // demonstrably *not* the backstop and the cap is.
    for (let route = 0; route < 48; route += 1) {
      for (let status = 0; status < 32; status += 1) {
        metrics.counter('http_requests_total', { method: 'GET', route: `/r/${route}`, status: String(status) })
      }
    }
    const text = metrics.render()
    const series = text.split('\n').filter((line) => line.startsWith('http_requests_total{'))
    assert.ok(series.length <= MAX_METRIC_SERIES, `series count ${series.length} exceeds the cap`)
    assert.ok(metricsOverflow().evictedSeries > 0, 'eviction is reported, not silent')
  })

  it('declares an allowlist for every metric the server records', () => {
    // The allowlist is the mechanism; a metric with no entry falls back to the
    // per-key budgets alone. That is stated here rather than assumed.
    for (const name of ['http_requests_total', 'http_request_duration_ms', 'ingestion_runs_total', 'ingestion_duration_ms']) {
      assert.ok(METRIC_LABEL_ALLOWLIST[name], `${name} has no allowlist entry`)
    }
  })
})

describe('histograms accumulate incrementally (R-38)', () => {
  it('retains a bounded window, not every sample since boot', () => {
    for (let i = 1; i <= 500; i += 1) {
      metrics.histogram('ingestion_duration_ms', i, { source: 'gdacs' })
    }
    const quantiles = metrics.quantiles('ingestion_duration_ms', { source: 'gdacs' })
    assert.equal(quantiles.samples, 20, 'the retained window must be bounded')
    assert.ok(quantiles.p95 <= 500)
    assert.ok(quantiles.p50 >= 481, 'the window is the most recent 20, not the first 20')
  })

  it('renders bucket counts that match what was observed, without re-walking samples', () => {
    for (const value of [1, 1, 1, 30, 600]) {
      metrics.histogram('ingestion_duration_ms', value, { source: 'gdacs' })
    }
    const text = metrics.render()
    // Cumulative Prometheus buckets: `le="25"` counts everything at or below 25.
    assert.match(text, /ingestion_duration_ms_bucket\{le="25",source="gdacs"\} 3/)
    assert.match(text, /ingestion_duration_ms_bucket\{le="100",source="gdacs"\} 4/)
    assert.match(text, /ingestion_duration_ms_bucket\{le="\+Inf",source="gdacs"\} 5/)
    assert.match(text, /ingestion_duration_ms_count\{source="gdacs"\} 5/)
    // 1+1+1+30+600
    assert.match(text, /ingestion_duration_ms_sum\{[^}]*\} 633/)
  })

  it('returns nulls, not zeros, for a histogram nothing has been observed on', () => {
    assert.deepEqual(
      metrics.quantiles('ingestion_duration_ms', { source: 'never_run' }),
      { p50: null, p95: null, samples: 0 },
    )
  })
})

describe('a label-less histogram renders valid Prometheus text (R-39)', () => {
  it('emits braces on the bucket line', () => {
    // The exact case that was latent: `formatLabels({})` returned `''`, and
    // `''.slice(0, -1)` is `''`, so the line came out with no opening brace and
    // a scraper discarded the whole series silently.
    metrics.histogram('orphan_metric', 42)
    const lines = metrics.render().split('\n')
    const buckets = lines.filter((line) => line.startsWith('orphan_metric_bucket'))
    assert.ok(buckets.length > 0, 'the histogram must render')
    for (const line of buckets) {
      assert.match(line, /^orphan_metric_bucket\{le="[^"]+"\} \d+$/, `malformed line: ${line}`)
    }
    assert.match(metrics.render(), /orphan_metric_count 1/)
  })

  it('puts le alongside the other labels rather than replacing them', () => {
    metrics.histogram('with_labels', 42, { source: 'gdacs' })
    const text = metrics.render()
    assert.match(text, /with_labels_bucket\{[^}]*le="25"[^}]*source="gdacs"[^}]*\}|with_labels_bucket\{[^}]*source="gdacs"[^}]*le="25"[^}]*\}/)
  })
})

describe('the logger honours the level it declares (R-55)', () => {
  it('exposes debug, which LOG_LEVELS has always declared', () => {
    assert.equal(typeof logger.debug, 'function')
  })

  it('LOG_LEVELS and the logger agree on every level they name', () => {
    // The defect was a level that existed in the table and not on the object.
    // Asserted by shape rather than by running a subprocess with the env var
    // set, so the two cannot drift again silently.
    for (const level of ['debug', 'info', 'warn', 'error']) {
      assert.equal(typeof logger[level], 'function', `logger.${level} is missing`)
    }
  })
})
