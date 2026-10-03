#!/usr/bin/env node
/**
 * ENH-09: two independent rainfall products, compared rather than trusted.
 *
 * CHIRPS and ERA5 are both ingested and never compared, and every CHIRPS
 * record currently carries `precipitation_mm: null` — the connector reports
 * which rasters exist, not what fell. So the disagreement between products is
 * information this platform has in hand and throws away, while presenting a
 * single product's number with no indication that a second exists.
 *
 * The dangerous failure here is not a bug but a *confident* number. A
 * correlation of 0 for a flat series, a disputed rate of 0 for a comparison
 * that never ran, an average that hides which months disagreed — each of these
 * reads as a finding and is an artefact. Every figure in `src/agreement.js` is
 * nullable for that reason, and the tests below assert nullness from both
 * sides so that "returns null" is not satisfiable by a function that returns
 * null everywhere.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AGREEMENT_THRESHOLDS,
  AGREEMENT_VERDICTS,
  agreementReport,
  compareMonth,
  compareSeries,
  meanAbsoluteDifference,
  pearson,
  signDisagreementRate,
  spearman,
} from '../src/agreement.js'

/** Twelve months of two products that track each other closely. */
const agreeing = (values) => values

describe('the correlations', () => {
  it('reads +1 for a perfectly co-varying pair', () => {
    const r = pearson([{ a: 1, b: 2 }, { a: 2, b: 4 }, { a: 3, b: 6 }, { a: 4, b: 8 }])
    assert.ok(Math.abs(r - 1) < 1e-9)
  })

  it('reads -1 for an inverted pair', () => {
    const r = pearson([{ a: 1, b: 8 }, { a: 2, b: 6 }, { a: 3, b: 4 }, { a: 4, b: 2 }])
    assert.ok(Math.abs(r + 1) < 1e-9)
  })

  it('is null for a constant series, not zero', () => {
    // The falsy-zero case that matters most here. A flat product carries no
    // ordering information; reporting 0 would raise a `disputed` verdict about
    // a product that is merely uninformative, and `disputed` is the state a
    // downstream score inherits.
    assert.equal(pearson([{ a: 5, b: 1 }, { a: 5, b: 2 }, { a: 5, b: 3 }]), null)
    assert.equal(pearson([{ a: 1, b: 7 }, { a: 2, b: 7 }, { a: 3, b: 7 }]), null)
  })

  it('is null for fewer than two points, not zero', () => {
    assert.equal(pearson([{ a: 1, b: 2 }]), null)
    assert.equal(pearson([]), null)
  })

  it('ranks without being fooled by scale', () => {
    // Spearman is the figure that matters when one product is in tenths of a
    // millimetre and the other is in inches.
    const r = spearman([{ a: 1, b: 10 }, { a: 2, b: 20 }, { a: 3, b: 30 }, { a: 4, b: 40 }])
    assert.ok(Math.abs(r - 1) < 1e-9)
  })

  it('gives tied values the average of the ranks they span', () => {
    // A product reporting the same total for three consecutive dry months has
    // ties. Ranking them arbitrarily would manufacture disagreement out of a
    // product that simply had nothing to say those months.
    //
    // Three of the four `a` values tie at rank 1.5, and the single outlier
    // takes 4. Correlating those against b's plain 1..4 gives ~0.77 — a real
    // figure, and much weaker than the ±1 an arbitrary tie-break inside the
    // tie group would have produced.
    const tied = spearman([{ a: 0, b: 1 }, { a: 0, b: 2 }, { a: 0, b: 3 }, { a: 5, b: 4 }])
    assert.ok(tied > 0.7 && tied < 0.85, `averaged ranks should give ~0.77, got ${tied}`)

    // Both sides tied: the ranking is inverted but the averages keep it from
    // being exactly -1, which is correct — the tie groups do not perfectly
    // mirror each other.
    const bothTied = spearman([{ a: 1, b: 4 }, { a: 1, b: 3 }, { a: 9, b: 2 }, { a: 9, b: 1 }])
    assert.ok(bothTied < -0.85, `an inverted pair should read strongly negative, got ${bothTied}`)
  })

  it('is null when one side is genuinely constant', () => {
    assert.equal(spearman([{ a: 5, b: 1 }, { a: 5, b: 2 }, { a: 5, b: 3 }]), null)
  })
})

describe('the disagreement measures', () => {
  it('counts a wet/dry contradiction and not a trace', () => {
    // 0.1mm and 0.0mm are the same physical statement — it did not rain. A
    // product reporting trace amounts is not contradicting one reporting none.
    assert.equal(signDisagreementRate([{ a: 0, b: 0 }, { a: 0.05, b: 0 }]), 0)
    assert.equal(signDisagreementRate([{ a: 0, b: 0 }, { a: 20, b: 0 }]), 0.5)
  })

  it('is null with nothing to compare, not zero', () => {
    assert.equal(signDisagreementRate([]), null)
    assert.equal(meanAbsoluteDifference([]), null)
  })

  it('averages the gap in millimetres', () => {
    assert.equal(meanAbsoluteDifference([{ a: 10, b: 8 }, { a: 0, b: 4 }]), 3)
  })

  it('ignores unpaired months rather than treating them as zero', () => {
    // A missing CHIRPS value is not 0mm of rain. Dropping it is the only
    // honest option; coercing it would put a false drought into the average.
    assert.equal(meanAbsoluteDifference([{ a: 10, b: 8 }, { a: 10, b: null }]), 2)
  })
})

describe('the verdict for one period', () => {
  const months = (pairs) => pairs

  it('is unavailable below the floor, and says why', () => {
    const result = compareMonth({
      period: '2019-01',
      seriesA: months([10, 20]),
      seriesB: months([11, 21]),
    })
    assert.equal(result.verdict, 'unavailable')
    assert.match(result.reason, /2 paired month/)
    assert.equal(result.pearson, null, 'and reports no figure at all, not a computed one')
    assert.equal(result.rank_correlation, null)
  })

  it('is unavailable when nothing paired, even with two long series', () => {
    // Two sources with no months in common is a coverage failure upstream, not
    // agreement. Reporting "no disagreement" here would be the single most
    // damaging thing this module could do.
    const result = compareMonth({ period: '2019', seriesA: months([1, 2, 3]), seriesB: months([]) })
    assert.equal(result.verdict, 'unavailable')
    assert.equal(result.paired_months, 0)
  })

  it('is marginal rather than agreement when correlation is trivially exact', () => {
    // Three points correlating at exactly 1.0 is arithmetic. Calling that
    // "agree" is the same class of error as the constant-series zero.
    const result = compareMonth({ period: '2019-01', seriesA: months([1, 2, 3]), seriesB: months([2, 4, 6]) })
    assert.equal(result.verdict, 'marginal')
    assert.match(result.reason, /arithmetic, not evidence/)
  })

  it('is disputed when the products contradict about whether it rained', () => {
    const result = compareMonth({
      period: '2019-03',
      seriesA: months([40, 0, 0, 35, 0, 0]),
      seriesB: months([0, 0, 0, 30, 0, 45]),
    })
    assert.equal(result.verdict, 'disputed')
    assert.match(result.reason, /wet in one product and dry in the other/)
    assert.ok(result.disputed_at, 'and records when it was found')
  })

  it('is agreed when the products track each other', () => {
    const result = compareMonth({
      period: '2019-01',
      seriesA: months([40, 5, 30, 12, 60, 3]),
      seriesB: months([38, 6, 31, 11, 55, 4]),
    })
    assert.equal(result.verdict, 'agree')
    assert.equal(result.disputed_at, null, 'an agreed month has never been disputed')
  })

  it('leaves disputed_at null when nothing was disputed', () => {
    const result = compareMonth({
      period: '2019-01',
      seriesA: months([40, 5, 30, 12, 60, 3]),
      seriesB: months([38, 6, 31, 11, 55, 4]),
    })
    assert.equal(result.disputed_at, null)
    // The comment in the module claims a timestamp on every row would make
    // "was this ever disputed" a question about row count. Pin that.
    assert.ok(!Object.keys(result).some((k) => /checked_at|verified_at/.test(k)))
  })

  it('produces a reason a human can act on for every non-unavailable verdict', () => {
    const cases = [
      [[40, 0, 0, 35, 0, 0], [0, 0, 0, 30, 0, 45]],
      [[1, 2, 3], [2, 4, 6]],
      [[40, 5, 30, 12, 60, 3], [38, 6, 31, 11, 55, 4]],
    ]
    for (const [a, b] of cases) {
      const result = compareMonth({ period: '2019', seriesA: a, seriesB: b })
      assert.ok(result.reason.length > 10, `${result.verdict} has no usable reason`)
      assert.ok(AGREEMENT_VERDICTS.includes(result.verdict))
    }
  })
})

describe('pairing two sources', () => {
  const record = (period, mm) => ({ period, precipitation_mm: mm })

  it('pairs on the period, not on array position', () => {
    // Zipping by index would compare March against April and return a real
    // number describing a relationship between the wrong two things.
    const result = compareSeries({
      district: 'Turkana',
      period: '2019',
      productA: 'chirps',
      productB: 'era5',
      recordsA: [record('2019-03', 40), record('2019-01', 5), record('2019-02', 30)],
      recordsB: [record('2019-01', 6), record('2019-02', 31), record('2019-03', 38)],
    })
    assert.equal(result.paired_months, 3)
    assert.equal(result.verdict, 'agree')
  })

  it('reports how many months could not be paired', () => {
    const result = compareSeries({
      district: 'Turkana',
      period: '2019',
      recordsA: [record('2019-01', 5), record('2019-02', 30), record('2019-03', 40)],
      recordsB: [record('2019-01', 6), record('2019-02', 31)],
    })
    assert.equal(result.paired_months, 2)
    assert.equal(result.unmatched_months, 1, 'the dropped month is part of the answer')
  })

  it('keeps a duplicated month from being averaged away', () => {
    // Two records for one month inside a single source is a defect in that
    // source. Silently picking one would hide it behind a plausible number.
    const result = compareSeries({
      district: 'Turkana',
      period: '2019',
      recordsA: [record('2019-01', 5), record('2019-01', 900), record('2019-02', 30), record('2019-03', 40)],
      recordsB: [record('2019-01', 6), record('2019-02', 31), record('2019-03', 38)],
    })
    assert.equal(result.paired_months, 3, 'the duplicate did not become a fourth month')
    assert.equal(result.verdict, 'agree', 'the 900mm outlier is not silently included')
  })
})

describe('the report a score reads', () => {
  const comparison = (period, verdict) => ({
    period,
    verdict,
    reason: `${verdict} in ${period}`,
    disputed_at: verdict === 'disputed' ? '2026-10-03T00:00:00.000Z' : null,
  })

  it('names the disputed months rather than averaging them away', () => {
    // A district that disagrees in March is not the same district as one that
    // disagrees everywhere, and a single blended number destroys the part an
    // analyst needs.
    const report = agreementReport(
      [comparison('2019-01', 'agree'), comparison('2019-03', 'disputed'), comparison('2019-04', 'agree')],
      { district: 'Turkana' },
    )
    assert.equal(report.disputed_count, 1)
    assert.equal(report.disputed_months.length, 1)
    assert.equal(report.disputed_months[0].period, '2019-03')
    assert.equal(report.any_disputed, true)
  })

  it('is null rather than zero when nothing was comparable', () => {
    // The head of the falsy-zero ladder. `any_disputed: false` would read as
    // "checked, found no disagreement" — a claim about data we do not have.
    const report = agreementReport([comparison('2019-01', 'unavailable')], { district: 'Turkana' })
    assert.equal(report.any_disputed, null)
    assert.equal(report.disputed_rate, null)
    assert.equal(report.periods_compared, 0)
    assert.equal(report.periods_unavailable, 1)
  })

  it('excludes unavailable periods from the disputed rate', () => {
    const report = agreementReport(
      [comparison('2019-01', 'agree'), comparison('2019-02', 'disputed'), comparison('2019-03', 'unavailable')],
      { district: 'Mogadishu' },
    )
    assert.equal(report.disputed_rate, 0.5, 'half of the two comparable periods, not of three')
  })

  it('reports no disagreement honestly when the products agreed', () => {
    const report = agreementReport([comparison('2019-01', 'agree'), comparison('2019-02', 'agree')], { district: 'Juba' })
    assert.equal(report.any_disputed, false)
    assert.equal(report.disputed_rate, 0)
    assert.deepEqual(report.disputed_months, [])
  })
})

describe('the vocabulary is checkable', () => {
  it('has four verdicts, no duplicates', () => {
    assert.equal(AGREEMENT_VERDICTS.length, 4)
    assert.equal(new Set(AGREEMENT_VERDICTS).size, 4)
  })

  it('is frozen', () => {
    assert.throws(() => { AGREEMENT_VERDICTS.push('resolved') }, TypeError)
  })

  it('covers every verdict compareMonth can actually return', () => {
    // Driven through the function rather than read from its source, so a
    // renamed verdict fails here instead of in a consumer.
    const seen = new Set()
    seen.add(compareMonth({ period: 'p', seriesA: [1], seriesB: [1] }).verdict)
    seen.add(compareMonth({ period: 'p', seriesA: [1, 2, 3], seriesB: [2, 4, 6] }).verdict)
    seen.add(compareMonth({ period: 'p', seriesA: [40, 0, 0, 35, 0, 0], seriesB: [0, 0, 0, 30, 0, 45] }).verdict)
    seen.add(compareMonth({ period: 'p', seriesA: [40, 5, 30, 12, 60, 3], seriesB: [38, 6, 31, 11, 55, 4] }).verdict)
    for (const verdict of seen) assert.ok(AGREEMENT_VERDICTS.includes(verdict), `${verdict} is not in the vocabulary`)
    assert.equal(seen.size, 4, 'and the four cases between them produce all four verdicts')
  })

  it('exposes thresholds that could be argued with', () => {
    // A threshold nobody can name is one nobody can argue with, and this is
    // the entire output of the module.
    assert.ok(AGREEMENT_THRESHOLDS.minPairedMonths >= 3, 'two points correlate at exactly ±1')
    assert.ok(AGREEMENT_THRESHOLDS.maxSignDisagreementRate < 1)
    assert.ok(Object.isFrozen(AGREEMENT_THRESHOLDS))
  })
})