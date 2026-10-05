/**
 * R-84/R-85/ENH-50 — one declared denominator per named published metric.
 *
 * `false_alert_rate` shipped three definitions under one name across four
 * surfaces, and they disagreed *in direction* on live data. On Mandera — the
 * one district with a confirmed false alert — `src/kpi.js` computed 50% while
 * `src/districts.js` and `src/equity.js` both computed 0%. The district page
 * reported alerting clean for the only district where it was not.
 *
 * The two wrong definitions carry comments arguing for them. `districts.js`
 * explained at length why "the denominator stays every alert the district
 * raised … that is what a false-alert *rate* means", two lines below a
 * numerator scanned over a different population; `equity.js` asserted it "is
 * defined exactly as `districtOverview` defines it" immediately before
 * computing something else. Both were locally reasonable and both were false.
 *
 * These tests assert three things a registry buys over a convention:
 *
 * 1. **The surfaces agree.** Four modules, one fixture, one answer.
 * 2. **The refusal travels.** Where the sample is below the floor, every
 *    surface returns null and names the reason — no surface publishes below
 *    the floor by forgetting to check, because the floor lives inside the only
 *    implementation.
 * 3. **A second definition is unwritable.** A test scans the source of every
 *    module that publishes these names and fails if any of them states a
 *    numerator, a denominator or a keyword regex of its own. That is what
 *    makes this a fix rather than a refactor: without it, the next person to
 *    add a surface writes a fourth definition.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { computeQuarterlyKpi } from '../src/kpi.js'
import { districtOverview } from '../src/districts.js'
import { equityByDistrict } from '../src/equity.js'
import { alertOutcomeCalibration } from '../src/calibration.js'
import {
  METRICS,
  MIN_DETERMINED_ALERTS,
  computeMetric,
  declaredMetrics,
  metric,
} from '../src/analytics/metrics.js'

// -------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------

/**
 * The live shape, not a convenient one: alerts carry the `false_alert` field
 * an operator filled in, and the confirmation is written as a sentence. The
 * Mandera alert's note reads "Reading traced to a faulty sensor" — no
 * "false", no "invalid", no "noop" — which is precisely why the keyword-scan
 * definitions could not see it while the field-based one could.
 */
const manderaAlerts = (count, falseCount) => Array.from({ length: count }, (_, i) => ({
  id: `ae-${i}`,
  scope: { district: 'Mandera' },
  severity: i < falseCount ? 'high' : 'medium',
  status: 'resolved',
  false_alert: i < falseCount ? true : false,
  resolution_note: i < falseCount ? 'Reading traced to a faulty sensor' : 'Situation stabilised',
  // All inside Q1, because the KPI surface snapshots by quarter and the floor
  // is applied to the quarter's alerts, not the store's. Spreading them over
  // nine months would put 12 in Q1 and read as a floor refusal rather than a
  // rate, which is a different test.
  created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
}))

const quarterData = (alerts) => ({
  alert_events: alerts,
  rapidpro_dispatches: alerts.slice(0, 5).map((a, i) => ({
    id: `d-${i}`,
    alert_event_id: a.id,
    status: 'delivered',
    sent_at: '2026-02-01T00:00:00.000Z',
    recipients_count: 100,
    destination: `+25570000${i}`,
  })),
  interventions: [],
  workflow_instances: [],
  field_reports: [],
})

// -------------------------------------------------------------------
// 1. The surfaces agree
// -------------------------------------------------------------------

describe('R-84 — one named metric, one answer, on every surface', () => {
  it('all four surfaces compute false_alert_rate from the same registry', () => {
    const alerts = manderaAlerts(40, 8)
    const data = quarterData(alerts)

    const declared = computeMetric('false_alert_rate', { alerts }).value
    assert.equal(declared, 20, '8 false of 40 determined')

    const kpi = computeQuarterlyKpi(data, { quarter: 'Q1', year: 2026 })
    const overview = districtOverview(data, 'mandera')
    const equity = equityByDistrict(data).find((r) => r.district === 'Mandera')
    const calibration = alertOutcomeCalibration(alerts).regions[0]

    // Calibration carries the rate as a fraction by design (it feeds a trust
    // score and a Wilson interval), and names the percent form separately so a
    // consumer never has to guess which scale a field is in — the defect R-83
    // was about, one layer down.
    assert.equal(kpi.false_alert_rate, 20)
    assert.equal(overview.kpi_snapshot.false_alert_rate, 20)
    assert.equal(equity.false_alert_rate, 20)
    assert.equal(calibration.false_alert_rate, 0.2)
    assert.equal(calibration.false_alert_rate_pct, 20,
      'the same metric, same denominator, both scales named')
  })

  it('the confirmed false alert is visible on every surface — the Mandera case', () => {
    // One confirmed miss, thirty-nine warranted alerts. The old definitions
    // scanned /false|invalid|noop/i over the resolution note, and this note
    // reads "Reading traced to a faulty sensor", so two of the three surfaces
    // scored Mandera 0% — alerting clean for the one district where it was not.
    const alerts = manderaAlerts(MIN_DETERMINED_ALERTS, 1)
    const data = quarterData(alerts)

    const rate = computeMetric('false_alert_rate', { alerts }).value
    assert.ok(rate > 0, 'a confirmed false alert must move the rate off zero')

    const overview = districtOverview(data, 'mandera')
    assert.equal(overview.kpi_snapshot.false_alert_rate, rate)
    assert.ok(overview.kpi_snapshot.false_alert_rate > 0,
      'the district page reported 0% for the only district with a confirmed false alert')

    const equity = equityByDistrict(data).find((r) => r.district === 'Mandera')
    assert.equal(equity.false_alert_rate, rate)
  })

  it('every published false_alert_rate carries the same declared basis', () => {
    const alerts = manderaAlerts(40, 8)
    const data = quarterData(alerts)
    const overview = districtOverview(data, 'mandera')
    assert.equal(overview.kpi_snapshot.false_alert_method, METRICS.false_alert_rate.basis,
      'a rate cannot be judged without the denominator that produced it')
  })

  it('the four numbers travel with the metric, not just the rate', () => {
    const alerts = manderaAlerts(40, 8)
    const data = quarterData(alerts)
    const declared = computeMetric('false_alert_rate', { alerts })
    const overview = districtOverview(data, 'mandera').kpi_snapshot

    assert.equal(overview.false_alert_determined, declared.denominator)
    assert.equal(overview.false_alert_of_total, alerts.length,
      'and the total the floor was applied against, so a reader can see what was excluded')
  })
})

// -------------------------------------------------------------------
// 2. The refusal travels
// -------------------------------------------------------------------

describe('R-93 — the sample floor is inside the computation, not at the call site', () => {
  it('refuses below MIN_DETERMINED_ALERTS and says why', () => {
    const alerts = manderaAlerts(4, 1)
    const result = computeMetric('false_alert_rate', { alerts })
    assert.equal(result.value, null, 'a rate off four records is not a rate')
    assert.equal(result.denominator, 4)
    assert.match(result.refusal, new RegExp(`of the ${MIN_DETERMINED_ALERTS} required`))
  })

  it('every surface refuses together — none can publish below the floor by forgetting', () => {
    const alerts = manderaAlerts(4, 1)
    const data = quarterData(alerts)

    assert.equal(computeQuarterlyKpi(data, { quarter: 'Q1', year: 2026 }).false_alert_rate, null)
    assert.equal(districtOverview(data, 'mandera').kpi_snapshot.false_alert_rate, null)
    assert.equal(equityByDistrict(data).find((r) => r.district === 'Mandera').false_alert_rate, null)
    assert.equal(alertOutcomeCalibration(alerts).regions[0].false_alert_rate, null)
  })

  it('an alert nobody reviewed is neither sound nor false', () => {
    const reviewed = manderaAlerts(40, 8)
    const unreviewed = [...reviewed, ...Array.from({ length: 100 }, (_, i) => ({
      id: `open-${i}`,
      scope: { district: 'Mandera' },
      status: 'open',
      false_alert: null,
    }))]
    const a = computeMetric('false_alert_rate', { alerts: reviewed })
    const b = computeMetric('false_alert_rate', { alerts: unreviewed })
    assert.equal(b.value, a.value, '100 unreviewed alerts do not dilute the rate — they are not sound alerts')
    assert.equal(b.denominator, 40)
  })

  it('a district with no determinations at all is null on every surface', () => {
    const data = quarterData(Array.from({ length: 12 }, (_, i) => ({
      id: `open-${i}`,
      scope: { district: 'Bor' },
      status: 'open',
      false_alert: null,
    })))
    assert.equal(computeQuarterlyKpi(data, { quarter: 'Q1', year: 2026 }).false_alert_rate, null)
    assert.equal(districtOverview(data, 'bor').kpi_snapshot.false_alert_rate, null)
    assert.equal(equityByDistrict(data).find((r) => r.district === 'Bor').false_alert_rate, null)
  })
})

// -------------------------------------------------------------------
// 3. A second definition is unwritable
// -------------------------------------------------------------------

describe('ENH-50 — a second definition is unwritable, not merely discouraged', () => {
  const SURFACES = [
    '../src/kpi.js',
    '../src/districts.js',
    '../src/equity.js',
    '../src/calibration.js',
  ]

  /**
   * The code with comments and string literals removed.
   *
   * Comments are stripped deliberately, and it matters which way. The comments
   * in these modules *name the old defect* — "scanned /false|invalid|noop/i",
   * "a keyword scan could not see the confirmed Mandera alert" — because a
   * rationale that does not say what it replaced is a rationale that gets
   * deleted by the next person who finds it confusing. A guard that matched
   * prose would therefore fail on a correct file, and the first person to hit
   * that would delete the comment rather than the guard.
   *
   * So the guard reads code, and the prose is left free to be honest about what
   * it replaced.
   */
  const codeOf = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')

  /** The single matching line, for an assertion message that can be read. */
  const offendingLine = (path, pattern) => {
    const line = codeOf(path).split('\n').findIndex((l) => pattern.test(l))
    return line === -1 ? null : `${path}:${line + 1}`
  }

  it('no surface states a false-alert regex of its own', () => {
    for (const path of SURFACES) {
      const source = codeOf(path)
      // The keyword scan is the specific thing that made two surfaces blind to
      // the confirmed alert. A module that declares one is reimplementing the
      // metric rather than computing it.
      assert.doesNotMatch(
        source,
        /false\s*\|\s*invalid\s*\|\s*noop/i,
        `${path} declares a false-alert keyword scan; the determination lives in alert_events.false_alert and the metric lives in the registry`,
      )
    }
  })

  it('no surface multiplies its own numerator by 100 over its own denominator', () => {
    // The shape of every hand-rolled rate in the four modules: `100 * x / y`.
    // `computeMetric` is the only sanctioned route, so an inline rate is a
    // second definition even when it happens to agree.
    const pattern = /100\s*\*\s*\w+\.length\s*\)\s*\/\s*\w+\.length/
    for (const path of SURFACES) {
      assert.equal(offendingLine(path, pattern), null,
        `${path} computes a rate inline instead of through the registry`)
    }
  })

  it('no surface filters alerts for a false-alert population of its own', () => {
    for (const path of SURFACES) {
      const source = codeOf(path)
      assert.doesNotMatch(
        source,
        /resolvedAlerts|determinedAlerts|flaggedFalsePositive|FALSE_POSITIVE_NOTE/,
        `${path} builds a false-alert population itself; the registry declares which alerts count`,
      )
    }
  })

  it('an undeclared metric name throws rather than returning undefined', () => {
    assert.throws(() => metric('alert_quality_index'), /no declared metric/)
    assert.throws(() => computeMetric('nope', { alerts: [] }), /no declared metric/)
  })

  it('the registry is frozen — a surface cannot extend it at runtime', () => {
    assert.throws(() => { METRICS.alert_quality_index = { compute: () => 1 } }, TypeError)
    assert.deepEqual(declaredMetrics(), [
      'cold_chain_protection_rate',
      'dispatch_precision_pct',
      'false_alert_rate',
      'feeding_repositioning_rate',
      'people_reached',
    ])
  })

  it('every declared metric states a basis, a floor and a refusal rule', () => {
    for (const [name, def] of Object.entries(METRICS)) {
      assert.ok(def.basis && def.basis.length > 20, `${name} must state what it measures`)
      assert.equal(typeof def.sample_floor, 'number', `${name} must declare a sample floor`)
      assert.equal(typeof def.compute, 'function', `${name} must have exactly one implementation`)
    }
  })
})

// -------------------------------------------------------------------
// dispatch_precision_pct — the second registry metric with a named old name
// -------------------------------------------------------------------

describe('R-84 — dispatch_precision_pct is also one definition', () => {
  it('divides by dispatched-and-determined alerts, not by every dispatch', () => {
    const alerts = [
      ...manderaAlerts(10, 2).map((a) => ({ ...a, id: `d-${a.id}` })),
      { id: 'never-sent', scope: { district: 'Mandera' }, false_alert: true, status: 'resolved' },
    ]
    const dispatched = new Set(alerts.slice(0, 10).map((a) => a.id))
    const result = computeMetric('dispatch_precision_pct', { alerts, dispatchedAlertIds: dispatched })
    // 8 of 10 dispatched-and-determined are warranted. The never-sent alert is
    // not in the denominator: it is not evidence the dispatch decision was
    // right, and subtracting it is what could produce a negative precision.
    assert.equal(result.denominator, 10)
    assert.equal(result.value, 80)
  })

  it('refuses below its own floor', () => {
    const alerts = manderaAlerts(2, 1).map((a) => ({ ...a, id: `d-${a.id}` }))
    const dispatched = new Set(alerts.map((a) => a.id))
    const result = computeMetric('dispatch_precision_pct', { alerts, dispatchedAlertIds: dispatched })
    assert.equal(result.value, null)
    assert.match(result.refusal, /not a precision/)
  })

  it('equity and the breach detector read the same number', () => {
    const alerts = manderaAlerts(20, 4)
    const data = {
      ...quarterData(alerts),
      // 20 determined dispatches, 4 of them false: 16 of 20 warranted.
      rapidpro_dispatches: alerts.map((a, i) => ({
        id: `d-${i}`,
        alert_event_id: a.id,
        status: 'delivered',
        sent_at: '2026-02-01T00:00:00.000Z',
        recipients_count: 100,
        destination: `+2557000${i}`,
      })),
    }
    const row = equityByDistrict(data).find((r) => r.district === 'Mandera')
    assert.equal(row.dispatch_precision_pct, 80)
    assert.equal(row.accuracy_pct, row.dispatch_precision_pct, 'the legacy key aliases the named metric')
  })
})
