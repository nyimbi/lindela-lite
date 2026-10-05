/**
 * R-89/R-90 — `src/agreement.js` compared the wrong two numbers, then read the
 * absence of a correlation as agreement.
 *
 * **R-89, the sign-inverted correlation.** `pearson` and `spearman` filtered
 * the two series *independently* and then zipped the survivors by index:
 *
 *   const xs = pairs.map(p => p.a).filter(Number.isFinite)
 *   const ys = pairs.map(p => p.b).filter(Number.isFinite)
 *   const n = Math.min(xs.length, ys.length)
 *
 * One one-sided non-finite value does not drop one pair — it drops one `x` and
 * one `y` from *different* positions, and every later pair is shifted against
 * its partner. Measured: `pearson` returned −0.621 on a series whose aligned
 * survivors give +1. A sign-inverted correlation is the worst class of error
 * this module can produce, because the verdict vocabulary then reports a
 * *disputed* product that in fact agreed perfectly, and downstream code inherits
 * `disputed` as a reason to distrust a rainfall product.
 *
 * **R-90, the defaults that point at agreement.** `Math.abs(pearsonValue ?? 0)`
 * reads a missing correlation as *uncorrelated*, which trips the `degenerate`
 * branch to `marginal`. `(rankValue ?? 1)` reads a missing rank correlation as
 * *perfectly correlated*, which skips the `lowRank` branch entirely. Both
 * defaults sit on the "agree" side, so a dead sensor is certified `agree` with
 * a live one. And `paired_months` reported key presence rather than
 * measurement: three of six months unmeasured published `coverage: "both"`,
 * `paired_months: 6`, verdict `agree`, from a correlation computed on three
 * points.
 *
 * These tests fail against the pre-fix module.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareMonth, compareSeries, pearson, spearman } from '../src/agreement.js'

/** n paired months, perfectly correlated: A ascends, B ascends. */
const series = (n) => ({
  a: Array.from({ length: n }, (_, i) => (i + 1) * 10),
  b: Array.from({ length: n }, (_, i) => (i + 1) * 10),
})

describe('R-89 — the two series are filtered as pairs, never independently', () => {
  it('drops a one-sided non-finite without misaligning the survivors', () => {
    // a has a hole at index 1; b is complete. The aligned survivors are
    // (10,10), (30,30), (40,40) — still a perfect correlation.
    const pairs = [
      { a: 10, b: 10 },
      { a: null, b: 20 },
      { a: 30, b: 30 },
      { a: 40, b: 40 },
    ]
    assert.equal(pearson(pairs), 1,
      'one absent value must remove one pair, not shift every pair after it against its partner')
  })

  it('the old independent filter could invert the sign of the correlation', () => {
    // A ten-month series where the two products agree closely on the aligned
    // months (+0.904), with a one-sided hole in each at a *different* position.
    // Filtering each side independently and zipping by index pairs month 3 with
    // month 4, month 4 with month 5, and so on — which turns a strong positive
    // correlation into a negative one.
    const xs = [5, 7, 8, 3, 7, 8, 9, 5, 8, 1]
    const ys = [4, 4, 7, 1, 7, 8, 8, 2, 9, 1]
    const k = 9 // the hole in a
    const j = 2 // the hole in b, two positions away
    const pairs = xs.map((a, i) => ({ a: i === k ? null : a, b: i === j ? null : ys[i] }))

    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
    const corr = (a, b) => {
      const ma = mean(a); const mb = mean(b)
      let num = 0; let da = 0; let db = 0
      for (let i = 0; i < a.length; i += 1) {
        num += (a[i] - ma) * (b[i] - mb)
        da += (a[i] - ma) ** 2
        db += (b[i] - mb) ** 2
      }
      return num / Math.sqrt(da * db)
    }

    // What the independent filter computed: the survivors, zipped by index.
    const misaligned = corr(
      pairs.map((p) => p.a).filter(Number.isFinite),
      pairs.map((p) => p.b).filter(Number.isFinite),
    )
    assert.ok(misaligned < 0, 'the misalignment this fixes is a sign inversion, not a rounding difference')

    // What the aligned filter computes over the same input: positive.
    assert.ok(pearson(pairs) > 0.9)
  })

  it('spearman is aligned the same way', () => {
    const pairs = [
      { a: 10, b: 10 },
      { a: null, b: 20 },
      { a: 30, b: 30 },
      { a: 40, b: 40 },
    ]
    assert.equal(spearman(pairs), 1)
  })

  it('still refuses fewer than two usable pairs and a constant series', () => {
    assert.equal(pearson([{ a: 1, b: 1 }]), null)
    assert.equal(pearson([{ a: 5, b: 1 }, { a: 5, b: 2 }]), null,
      'a constant series carries no ordering information; 0 would read as "unrelated"')
  })
})

describe('R-90 — a missing correlation is not agreement', () => {
  it('does not certify a dead sensor as agreeing with a live one', () => {
    // One measured month, three keyed. With the old `rankValue ?? 1` default
    // the missing rank correlation cleared the threshold; with `paired_months`
    // counting key presence this passed the floor of three.
    const out = compareMonth({
      period: '2026-03',
      seriesA: [10, 20, 30],
      seriesB: [10, null, null],
    })
    assert.notEqual(out.verdict, 'agree')
    assert.equal(out.paired_months, 1)
    assert.equal(out.verdict, 'unavailable')
    assert.match(out.reason, /only 1 of 3 shared month\(s\) were measured/)
  })

  it('a flat product is unmeasurable, not maximally uncorrelated', () => {
    // ERA5 reported the same value three months running. `pearsonValue ?? 0`
    // read that as a correlation of exactly 0 and produced a confident
    // `marginal` with a reason about arithmetic — describing a number that was
    // never computed. A flat product has no ordering information, which is not
    // the same finding as a disagreement.
    const out = compareMonth({
      period: '2026-03',
      seriesA: [10, 20, 30],
      seriesB: [5, 5, 5],
    })
    assert.equal(out.pearson, null)
    assert.equal(out.verdict, 'unavailable')
    assert.match(out.reason, /one product is flat/)
    assert.match(out.reason, /agreement is not the default reading of a missing number/)
  })

  it('paired_months counts measurements, not key presence', () => {
    // Three months keyed on both sides, one of them with no measurement in
    // either series. The old count reported 3 — and with minPairedMonths of 3
    // that was enough to publish a verdict computed on two points.
    const out = compareMonth({
      period: '2026-Q1',
      seriesA: [10, 20, null],
      seriesB: [10, 20, null],
    })
    assert.equal(out.paired_months, 2)
    assert.equal(out.verdict, 'unavailable', 'two measured months is below the floor of three')
  })

  it('names how many months were keyed but unmeasured', () => {
    const out = compareMonth({
      period: '2026-Q1',
      seriesA: [10, 20, null],
      seriesB: [10, 20, null],
    })
    assert.ok(out.unmeasured_months >= 1)
  })

  it('still agrees when both series genuinely measure three months', () => {
    const s = series(3)
    const out = compareMonth({ period: '2026-03', seriesA: s.a, seriesB: s.b })
    assert.equal(out.paired_months, 3)
    assert.equal(out.verdict, 'marginal',
      'a correlation of exactly 1 over three points is arithmetic, not evidence — that rule is unchanged')
    assert.match(out.reason, /arithmetic, not evidence/i)
  })
})

describe('R-90 — coverage is a measurement axis too', () => {
  const month = (period, precipitation_mm) => ({ period, precipitation_mm })

  it('a month neither product measured is not "both" coverage', () => {
    const out = compareSeries({
      district: 'Turkana',
      period: '2026-Q1',
      recordsA: [month('2026-01', 10), month('2026-02', null)],
      recordsB: [month('2026-01', 10), month('2026-02', null)],
      productA: 'chirps',
      productB: 'era5',
    })
    assert.equal(out.coverage, 'partial',
      'both keyed the month and neither measured it, so the products did not both cover it')
  })

  it('paired_months does not claim coverage nobody has', () => {
    const out = compareSeries({
      district: 'Turkana',
      period: '2026-Q1',
      recordsA: [month('2026-01', 10), month('2026-02', null)],
      recordsB: [month('2026-01', 10), month('2026-02', null)],
      productA: 'chirps',
      productB: 'era5',
    })
    assert.equal(out.paired_months, 1, 'one month both products measured')
  })

  it('a genuinely shared, measured month is still "both"', () => {
    const out = compareSeries({
      district: 'Turkana',
      period: '2026-01',
      recordsA: [month('2026-01', 10)],
      recordsB: [month('2026-01', 12)],
      productA: 'chirps',
      productB: 'era5',
    })
    assert.equal(out.coverage, 'both')
    assert.equal(out.paired_months, 1)
  })
})
