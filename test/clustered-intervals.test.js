import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  wilsonInterval, clusterDesignEffect, clusteredWilsonInterval, designEffectForMonths, contingencyCount,
} from '../src/flood-probability.js'

/**
 * ENH-20 — the interval said the months were independent, and they are not.
 *
 * The conditional probability is a rate over months, and consecutive months
 * share a season, a basin and a fortnight of rain. Wilson's interval assumes
 * independent draws, so it is too narrow exactly where the clustering is
 * strongest — the case an operator most wants a number for.
 *
 * The correction is an effective sample size rather than a block bootstrap: a
 * bootstrap needs a seed to be reproducible, and reproducibility is a worse
 * property than a closed form. The design effect is reported beside the
 * interval, which is the part a reader can check — a wider interval with no
 * stated reason is a number nobody trusts twice.
 */

/**
 * A monthly series: a feature ramp so the 0.5-quantile falls on a value nothing
 * sits exactly on, and the flood months named by index.
 *
 * Index 0 is the most recent month, and the ramp is *descending* so the recent
 * months are the wet ones. Both details matter: `quantile` is nearest-rank, so a
 * series of two repeated feature values puts the threshold on the upper group and
 * the conditional population is empty; and a ramp that rises with age would put
 * the floods below the threshold, where the conditional probability does not
 * count them at all.
 */
function series({ total, floodIndices, keys = null }) {
  return Array.from({ length: total }, (_, i) => ({
    month: keys ? keys[i] : `${2020 + Math.floor((total - 1 - i) / 12)}-${String(((total - 1 - i) % 12) + 1).padStart(2, '0')}`,
    feature: (total - 1 - i) * 10,
    label: floodIndices.includes(i),
  }))
}

/**
 * Six years of months.
 *
 * Sized so the months above the threshold span *three* different years, which
 * is the smallest span in which "one flood per year" and "all three floods in
 * one year" are both expressible. At 36 months the above-threshold window sat
 * inside a single year, and the comparison silently became between two
 * different populations.
 */
const MONTHS = 72
/** One flood per year across the wettest (most recent) three years. */
const ONE_PER_YEAR = [0, 12, 24]
/** The same three floods, all in the most recent year. */
const ONE_YEAR = [0, 1, 2]
/** Move two of the floods a year earlier without touching their features. */
const keysWith = (moves) => Array.from({ length: MONTHS }, (_, i) => {
  const override = moves[i]
  if (override) return override
  return `${2023 + Math.floor((MONTHS - 1 - i) / 12)}-${String(((MONTHS - 1 - i) % 12) + 1).padStart(2, '0')}`
})

describe('ENH-20 — the design effect measures what clustering costs', () => {
  it('is 1 when the blocks carry no information beyond their members', () => {
    // Each block has the same rate: between-block variance is zero, so the
    // sample size is worth its face value and the interval does not move.
    const design = clusterDesignEffect([5, 5, 5, 5], [20, 20, 20, 20])
    assert.equal(design.deff, 1)
    assert.equal(design.icc, 0)
  })

  it('rises when the flood months cluster into some blocks and not others', () => {
    const design = clusterDesignEffect([9, 1, 9, 1], [20, 20, 20, 20])
    assert.ok(design.deff > 1.2,
      `design effect ${design.deff}: a block that is 45% flooded next to one at 5% is ` +
      'not four independent samples, and pretending otherwise understates the interval')
    assert.ok(design.effective_n < design.n,
      'the effective sample size is the whole point, and it did not shrink')
  })

  it('never reports less than 1, however anti-correlated the blocks look', () => {
    // A design effect below 1 would claim more information than the observations
    // contain — a free lunch that is always a sign of a wrong estimator.
    const design = clusterDesignEffect([0, 10, 0, 10], [20, 20, 20, 20])
    assert.ok(design.deff >= 1, `design effect ${design.deff} claims a sample larger than the one taken`)
  })

  it('is 1 for a single block, because there is nothing to compare it with', () => {
    const design = clusterDesignEffect([4], [12])
    assert.equal(design.deff, 1)
    assert.equal(design.clusters, 1)
  })
})

describe('ENH-20 — the interval widens by exactly what the clustering justifies', () => {
  it('leaves the plain interval alone when deff is 1', () => {
    const plain = wilsonInterval(4, 40)
    const clustered = clusteredWilsonInterval(4, 40, 1)
    assert.deepEqual({ low: clustered.low, high: clustered.high }, { low: plain.low, high: plain.high },
      'a series with no measurable clustering must publish the numbers it always did')
  })

  it('widens without moving the point estimate', () => {
    const plain = wilsonInterval(4, 40)
    const clustered = clusteredWilsonInterval(4, 40, 2.5)
    assert.ok(clustered.low < plain.low, 'the low end did not widen')
    assert.ok(clustered.high > plain.high, 'the high end did not widen')
    // The rate is untouched: clustering does not move the estimate, it moves
    // what the estimate is worth.
    assert.equal(clustered.effective_n, 16)
    assert.equal(clustered.design_effect, 2.5)
  })

  it('the reported design effect is the one that produced the interval', () => {
    // Checkable arithmetic: a reader who disagrees with the design effect can
    // recompute the interval from the numbers printed beside it.
    for (const deff of [1, 1.4, 3]) {
      const interval = clusteredWilsonInterval(6, 60, deff)
      const recomputed = wilsonInterval(6 / deff, 60 / deff)
      assert.equal(interval.low, recomputed.low)
      assert.equal(interval.high, recomputed.high)
      assert.equal(interval.design_effect, deff)
    }
  })
})

describe('ENH-20 — the interval a district actually publishes', () => {
  it('carries the clustering that produced it', () => {
    // A series where every flood month falls in a different year: no
    // clustering, so the ordinary interval.
    const flat = series({ total: MONTHS, floodIndices: ONE_PER_YEAR })
    const result = contingencyCount(flat, 'feature', 0.5)
    assert.ok(result.counts.conditional_probability_wilson)
    assert.equal(result.counts.clustering.design_effect, 1)
    assert.equal(result.counts.clustering.block, 'calendar_year')
  })

  it('widens for a series whose floods come in runs, and says by how much', () => {
    // Identical features, identical labels, identical count above the
    // threshold. The only difference is which year each flood month fell in —
    // so any difference in the interval is the clustering and nothing else,
    // which is exactly what an i.i.d. interval cannot see.
    // 0.45 puts the threshold high enough that the wettest months still reach
    // back three years. A percentile that clips the window to one year would
    // make "one flood per year" inexpressible, and the comparison would be
    // between two different populations rather than two arrangements.
    const clustered = series({ total: MONTHS, floodIndices: ONE_YEAR })
    const flat = series({ total: MONTHS, floodIndices: ONE_PER_YEAR })
    const a = contingencyCount(clustered, 'feature', 0.45)
    const b = contingencyCount(flat, 'feature', 0.45)

    assert.equal(a.counts.flood_months_above_threshold, b.counts.flood_months_above_threshold,
      'the two series must have the same counts, or this test is comparing two different things')
    const clusteredWidth = a.counts.conditional_probability_wilson.high - a.counts.conditional_probability_wilson.low
    const flatWidth = b.counts.conditional_probability_wilson.high - b.counts.conditional_probability_wilson.low
    assert.ok(clusteredWidth > flatWidth,
      `the clustered series produced the same width (${clusteredWidth}) as the unclustered one ` +
      `(${flatWidth}); ENH-20 exists because it did not`)
    assert.ok(a.counts.clustering.design_effect >= 1)
  })

  it('a sample with no month key is not silently treated as unclustered', () => {
    // No block to measure means no correction, which is a weaker interval — so
    // the absence is reported rather than inferred.
    const design = designEffectForMonths([{ label: true }, { label: false }])
    assert.equal(design.clusters, 0)
    assert.equal(design.deff, 1)
  })
})
