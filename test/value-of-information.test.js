#!/usr/bin/env node
/**
 * ENH-54 — value of information (the procurement ranking of data gaps).
 *
 * The load-bearing claims these tests defend:
 *
 *  1. The gaps are *derived from the repo's own refusals*, not invented: seven
 *     regions that `driftReport` refuses appear as seven ranked gaps carrying
 *     the refusal that produced them.
 *  2. The ranking is by expected loss reduction, and it moves in the right
 *     direction on both of its operands — a gap further from measurement, and a
 *     gap whose decision costs more per unit, each rank higher.
 *  3. An uncomputable gap is *refused with a reason*, never ranked as a zero.
 *     A zero EVPI and a missing EVPI are opposite claims and a list that shows
 *     them as one number is the defect this module exists to avoid.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { driftReport } from '../src/drift.js'
import { freshnessReport } from '../src/freshness.js'
import {
  DECISION_THRESHOLDS,
  DEFAULT_LOSS_PER_UNIT,
  driftGaps,
  expectedValueOfPerfectInformation,
  freshnessGaps,
  rankDataGaps,
} from '../src/value-of-information.js'

/** `count` monthly samples carrying the three drift features, or none of them. */
const window = (count, offset = 0) => Array.from({ length: count }, (_, i) => ({
  month: `20${String(10 + Math.floor(i / 12)).slice(-2)}-${String((i % 12) + 1).padStart(2, '0')}`,
  features: { max_7_day: 50 + offset + (i % 7), sum_30_day: 200 + offset * 2, sum_90_day: 500 + offset * 3 },
  label: false,
}))

/**
 * Seven regions, each refused by `driftReport` for a short window — the shape
 * the audit describes when it says all seven regions currently refuse drift
 * with a reason. The month counts differ so the gaps differ in how far their
 * evidence sits from the 24-month floor.
 */
const sevenRefused = () => driftReport({
  regions: [
    { region: 'Turkana', referenceSamples: window(0), currentSamples: window(0) },
    { region: 'Aweil', referenceSamples: window(3), currentSamples: window(3) },
    { region: 'Bor', referenceSamples: window(10), currentSamples: window(10) },
    { region: 'Karamoja', referenceSamples: window(15), currentSamples: window(15) },
    { region: 'Mandera', referenceSamples: window(20), currentSamples: window(20) },
    { region: 'Juba', referenceSamples: window(22), currentSamples: window(22) },
    { region: 'Mogadishu', referenceSamples: window(23), currentSamples: window(23) },
  ],
})

describe('the drift gaps are the refusals the repo already issues', () => {
  it('enumerates one gap per region that refused, carrying its reason', () => {
    const report = sevenRefused()
    assert.equal(report.not_measurable, 7, 'the fixture must refuse all seven regions for the test to mean anything')
    const gaps = driftGaps(report)
    assert.equal(gaps.length, 7, 'a region that refused is a gap, and all seven must appear')
    for (const gap of gaps) {
      assert.equal(gap.kind, 'drift')
      assert.ok(gap.reason && gap.reason.length > 0, `${gap.id} must carry the refusal that produced it`)
      assert.equal(gap.signal, 'input_shift')
    }
  })

  it('measures how far each region sits from the measurement floor, not just that it refused', () => {
    const gaps = driftGaps(sevenRefused())
    const turkana = gaps.find((g) => g.region === 'Turkana')
    const mogadishu = gaps.find((g) => g.region === 'Mogadishu')
    assert.equal(turkana.evidence_shortfall, 1, 'a region with no window is maximally far from measurement')
    // 23 of 24 months: (24 - 23) / 24.
    assert.equal(mogadishu.evidence_shortfall, 0.0417, 'a region one month short is barely short')
    assert.ok(turkana.evidence_shortfall > mogadishu.evidence_shortfall, 'the shortfall must order the two')
  })

  it('omits a region that did not refuse', () => {
    const report = driftReport({
      regions: [
        { region: 'Stable', referenceSamples: window(40), currentSamples: window(40) },
        { region: 'Short', referenceSamples: window(3), currentSamples: window(3) },
      ],
    })
    const gaps = driftGaps(report)
    assert.equal(gaps.length, 1)
    assert.equal(gaps[0].region, 'Short')
  })
})

describe('expected value of perfect information', () => {
  it('prices a decision as the loss of acting blind over the candidate range', () => {
    // Uniform on [0, 0.5] against a threshold of 0.25: the blind default is
    // wrong on the upper half, and the expectation of `q − 0.25` there is
    // `(0.5 − 0.25)² / (2 · 0.5) = 0.0625` at a dollar a unit.
    const result = expectedValueOfPerfectInformation({ range: { low: 0, high: 0.5 }, threshold: 0.25, lossPerUnit: 1 })
    assert.equal(result.evpi, 0.0625)
    assert.equal(result.reason, null)
  })

  it('scales linearly with the loss a decision error carries', () => {
    const one = expectedValueOfPerfectInformation({ range: { low: 0, high: 0.5 }, threshold: 0.25, lossPerUnit: 1 })
    const ten = expectedValueOfPerfectInformation({ range: { low: 0, high: 0.5 }, threshold: 0.25, lossPerUnit: 10 })
    assert.equal(ten.evpi, one.evpi * 10)
  })

  it('is zero when the candidate range sits wholly on the side the blind action chose', () => {
    // A range of [0, 0.2] against a threshold of 0.25: the blind default is
    // right everywhere, so perfect information buys nothing. The uncertainty is
    // real; its value is not. This is the correct procurement signal, not a
    // refusal, and it is a zero rather than a null.
    const result = expectedValueOfPerfectInformation({ range: { low: 0, high: 0.2 }, threshold: 0.25, lossPerUnit: 1 })
    assert.equal(result.evpi, 0)
    assert.equal(result.reason, null)
  })

  it('refuses an absent range rather than pricing it at zero', () => {
    const result = expectedValueOfPerfectInformation({ range: null, threshold: 0.25 })
    assert.equal(result.evpi, null)
    assert.match(result.reason, /no finite range/)
  })

  it('refuses an absent loss weight rather than assuming one', () => {
    const result = expectedValueOfPerfectInformation({ range: { low: 0, high: 1 }, threshold: 0.5, lossPerUnit: 0 })
    assert.equal(result.evpi, null)
    assert.match(result.reason, /no positive loss/)
  })
})

describe('ranking the gaps by expected loss reduction', () => {
  it('orders a gap whose evidence is further from the floor above one nearer it', () => {
    const gaps = driftGaps(sevenRefused(), { lossByRegion: {} })
    const ranked = rankDataGaps(gaps)
    assert.equal(ranked.gaps.length, 7)
    for (let i = 1; i < ranked.gaps.length; i += 1) {
      assert.ok(ranked.gaps[i - 1].evpi >= ranked.gaps[i].evpi, 'the list must be sorted by EVPI, descending')
    }
    // Turkana has no window at all; Mogadishu is one month short.
    assert.equal(ranked.gaps[0].region, 'Turkana', 'the region with no evidence is the one worth measuring first')
    assert.equal(ranked.gaps[ranked.gaps.length - 1].region, 'Mogadishu')
  })

  it('lets a district that costs more per unit of error outrank a cheaper one with the same shortfall', () => {
    const report = driftReport({
      regions: [
        { region: 'Cheap', referenceSamples: window(10), currentSamples: window(10) },
        { region: 'Dear', referenceSamples: window(10), currentSamples: window(10) },
      ],
    })
    const ranked = rankDataGaps(driftGaps(report, { lossByRegion: { Cheap: 1, Dear: 100 } }))
    assert.equal(ranked.gaps[0].region, 'Dear', 'the same uncertainty over a costlier decision is worth more to close')
    // Linear in the loss weight, to within the 4-decimal rounding each row
    // carries: the dear row is a hundred times the cheap one, not merely larger.
    assert.ok(Math.abs(ranked.gaps[0].evpi - ranked.gaps[1].evpi * 100) < 0.01)
  })

  it('sums the ranked EVPIs as the value of closing every gap at once', () => {
    const ranked = rankDataGaps(driftGaps(sevenRefused()))
    const sum = ranked.gaps.reduce((acc, row) => acc + row.evpi, 0)
    assert.equal(ranked.total_evpi, Math.round(sum * 10000) / 10000)
  })

  it('refuses a gap with no grounded threshold rather than ranking it at zero', () => {
    const ranked = rankDataGaps([{ id: 'mystery', thresholdKey: 'nobody_declared_this', evidence_shortfall: 0.5, loss_per_unit: 1 }])
    assert.equal(ranked.gaps.length, 0, 'an unpriceable gap must not appear in the ranking')
    assert.equal(ranked.refused.length, 1)
    assert.match(ranked.refused[0].reason, /no decision threshold is grounded/)
  })

  it('refuses a gap whose evidence shortfall was never recorded', () => {
    const ranked = rankDataGaps([{ id: 'half', thresholdKey: 'input_shift', evidence_shortfall: null, loss_per_unit: 1 }])
    assert.equal(ranked.gaps.length, 0)
    assert.match(ranked.refused[0].reason, /no evidence shortfall recorded/)
  })
})

describe('freshness gaps', () => {
  it('enumerates the sources that failed to deliver, not the ones that are fine', () => {
    const report = freshnessReport({
      sourceRuns: [
        { source: 'gdacs', status: 'success', completed_at: '2026-10-11T00:00:00Z', records_processed: 40, errors: [] },
        { source: 'chirps', status: 'failed', completed_at: '2026-10-11T00:00:00Z', records_processed: 0, errors: ['timeout'] },
      ],
      now: Date.parse('2026-10-12T00:00:00Z'),
    })
    const gaps = freshnessGaps(report)
    const sources = gaps.map((g) => g.source)
    assert.ok(sources.includes('chirps'), 'a failed feed is a gap')
    assert.ok(!sources.includes('gdacs'), 'a source delivering on schedule is not a gap')
    // Every source with no run at all is `never_run` and is a gap: a feed that
    // has never been asked is the one you are looking for.
    assert.ok(sources.includes('glofas'))
    const neverRun = gaps.find((g) => g.source === 'glofas')
    assert.equal(neverRun.evidence_shortfall, 1, 'a source that never ran has no evidence at all')
    assert.match(neverRun.reason, /nothing has ever been measured/)
  })

  it('ranks a never-run feed above a broken one and a broken one above a repeated empty body', () => {
    const gaps = [
      { id: 'freshness:a', kind: 'freshness', source: 'a', thresholdKey: 'freshness', evidence_shortfall: 1, loss_per_unit: 1, reason: 'x' },
      { id: 'freshness:b', kind: 'freshness', source: 'b', thresholdKey: 'freshness', evidence_shortfall: 0.75, loss_per_unit: 1, reason: 'x' },
      { id: 'freshness:c', kind: 'freshness', source: 'c', thresholdKey: 'freshness', evidence_shortfall: 0.5, loss_per_unit: 1, reason: 'x' },
    ]
    const ranked = rankDataGaps(gaps)
    assert.deepEqual(ranked.gaps.map((g) => g.source), ['a', 'b', 'c'])
  })
})

describe('the decision thresholds are grounded in constants the repo already states', () => {
  it('names the module each threshold came from', () => {
    assert.equal(DECISION_THRESHOLDS.input_shift.threshold, 0.25)
    assert.match(DECISION_THRESHOLDS.input_shift.source, /drift\.js/)
    assert.match(DECISION_THRESHOLDS.freshness.source, /freshness\.js/)
  })

  it('states its uniform prior on the record rather than hiding it', () => {
    const ranked = rankDataGaps(driftGaps(sevenRefused()))
    assert.match(ranked.basis.prior, /uniform/)
    assert.equal(ranked.gaps[0].loss_per_unit, DEFAULT_LOSS_PER_UNIT, 'with no caller weight, every gap costs the same per unit')
  })
})
