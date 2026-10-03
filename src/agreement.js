/**
 * Do two independent rainfall products tell the same story?
 *
 * CHIRPS (blended satellite) and ERA5 (reanalysis) are both ingested and never
 * compared. That is the largest unused fidelity signal in this repository, and
 * it is honest in a way that raising confidence is not: where two independent
 * products disagree, the disagreement *is* the finding. It is evidence about
 * how much to trust the number that feeds a score.
 *
 * The spec is explicit about what this does not license. It does not resolve
 * the disagreement. Picking a winner between a satellite blend and a reanalysis
 * is a separate judgement with its own error modes, and a module that quietly
 * picks one would be making a scientific claim this codebase has no standing to
 * make. So `disputed` is a state a month can carry, and downstream consumers
 * are expected to pass it through rather than average it away.
 */

import { nowIso } from './utils.js'

/** The verdict vocabulary, exported so a route can iterate it. */
export const AGREEMENT_VERDICTS = Object.freeze(['agree', 'marginal', 'disputed', 'unavailable'])

/**
 * The thresholds, exported because a threshold nobody can name is a threshold
 * nobody can argue with, and this one is the entire output of the module.
 *
 * Pearson below 0.5 says the two products do not rank the same months the same
 * way, which is not a small thing when the ranking is what selects which months
 * a model trains on. Sign disagreement above 25% says one of them recorded rain
 * in months the other called dry — a categorical contradiction, not a
 * calibration difference.
 */
export const AGREEMENT_THRESHOLDS = Object.freeze({
  minPearson: 0.5,
  minRankCorrelation: 0.5,
  maxMeanAbsoluteDifference: 5.0,
  maxSignDisagreementRate: 0.25,
  minPairedMonths: 3,
})

/** Products this engine knows how to compare. */
export const COMPARABLE_PRODUCTS = Object.freeze(['chirps', 'era5', 'gauge'])

/**
 * Pearson correlation.
 *
 * Null for fewer than two paired points, and null when either side has no
 * variance. A correlation of 0 for a constant series would be read as "these
 * products are unrelated", which is not what a constant series means — it means
 * the product is flat and carries no ordering information. Confident zero is
 * the falsy-zero conflation this repository exists to avoid, and it lands
 * hardest here: `disputed` is the verdict a downstream score should inherit, and
 * a fabricated 0 would raise a false alarm about a product that is merely
 * uninformative.
 */
export function pearson(pairs) {
  const xs = pairs.map((p) => p.a).filter(Number.isFinite)
  const ys = pairs.map((p) => p.b).filter(Number.isFinite)
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return null
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i += 1) {
    const ddx = xs[i] - meanX
    const ddy = ys[i] - meanY
    num += ddx * ddy
    dx += ddx * ddx
    dy += ddy * ddy
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

/**
 * Spearman rank correlation.
 *
 * Ties get the average of the ranks they span, which is the standard treatment
 * and the one that matters here: a rainfall product that reports the same value
 * for three consecutive dry months has ties, and ranking those arbitrarily
 * would manufacture disagreement out of nothing.
 */
export function spearman(pairs) {
  const xs = pairs.map((p) => p.a).filter(Number.isFinite)
  const ys = pairs.map((p) => p.b).filter(Number.isFinite)
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return null
  const rx = averageRanks(xs)
  const ry = averageRanks(ys)
  return pearson(rx.map((v, i) => ({ a: v, b: ry[i] })))
}

function averageRanks(values) {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value)
  const ranks = new Array(values.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1
    // Average rank across the tied span: (i + j) / 2 is 1-indexed, so add 1.
    const shared = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) ranks[order[k].index] = shared
    i = j + 1
  }
  return ranks
}

/**
 * The sign-agreement rate: how often the two products disagree about whether a
 * month was wet at all.
 *
 * The threshold is zero, and deliberately not "greater than zero". 0.1 mm and
 * 0.0 mm are the same physical statement — it did not rain — and a product
 * reporting trace amounts should not be counted as contradicting one that
 * reports none. Above the threshold it is a categorical contradiction, and
 * those are what a downstream score needs to know about.
 */
export function signDisagreementRate(pairs, { dryThreshold = 0.1 } = {}) {
  const usable = pairs.filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b))
  if (!usable.length) return null
  const wet = (v) => Number(v) > dryThreshold
  const disagree = usable.filter((p) => wet(p.a) !== wet(p.b)).length
  return disagree / usable.length
}

/** Mean absolute difference in the product's own units — millimetres. */
export function meanAbsoluteDifference(pairs) {
  const usable = pairs.filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b))
  if (!usable.length) return null
  return usable.reduce((sum, p) => sum + Math.abs(p.a - p.b), 0) / usable.length
}

/**
 * One month, two products, and whether they agree.
 *
 * Every figure is nullable and the verdict is `unavailable` when there are too
 * few paired months to say anything. Two paired points produce a correlation of
 * exactly ±1 — mathematically true and evidentially worthless — so three is the
 * floor, and the reason is in the reason string rather than left to be
 * inferred from a number.
 */
export function compareMonth({ period, seriesA, seriesB, thresholds = AGREEMENT_THRESHOLDS }) {
  const pairs = (seriesA || [])
    .map((a, i) => ({ a, b: (seriesB || [])[i] }))
    .filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b))

  const base = {
    period,
    paired_months: pairs.length,
    pearson: null,
    rank_correlation: null,
    mean_absolute_difference: null,
    sign_disagreement_rate: null,
    verdict: 'unavailable',
    reason: '',
    disputed_at: null,
    computed_at: nowIso(),
  }

  if (pairs.length < thresholds.minPairedMonths) {
    return {
      ...base,
      reason: `only ${pairs.length} paired month(s); ${thresholds.minPairedMonths} is the floor for a correlation to mean anything`,
    }
  }

  const pearsonValue = pearson(pairs)
  const rankValue = spearman(pairs)
  const mad = meanAbsoluteDifference(pairs)
  const signRate = signDisagreementRate(pairs)

  // A correlation of exactly ±1 from three points is arithmetic, not evidence.
  // The verdict says so rather than reporting "perfect agreement".
  const degenerate = Math.abs(pearsonValue ?? 0) >= 1
  const lowRank = (rankValue ?? 1) < thresholds.minRankCorrelation
  const bigGap = mad !== null && mad > thresholds.maxMeanAbsoluteDifference
  const contradictory = signRate !== null && signRate > thresholds.maxSignDisagreementRate

  let verdict
  let reason
  if (degenerate) {
    verdict = 'marginal'
    reason = `correlation is exactly ${pearsonValue.toFixed(2)} over ${pairs.length} points — arithmetic, not evidence of agreement`
  } else if (contradictory) {
    verdict = 'disputed'
    reason = `${(signRate * 100).toFixed(0)}% of months are wet in one product and dry in the other`
  } else if (lowRank || bigGap) {
    verdict = 'marginal'
    const which = lowRank ? `rank correlation ${rankValue?.toFixed(2)}` : `mean absolute difference ${mad.toFixed(1)}mm`
    reason = `${which} is outside the threshold; the products rank months differently`
  } else {
    verdict = 'agree'
    reason = `rank correlation ${rankValue?.toFixed(2)}, mean absolute difference ${mad?.toFixed(1)}mm`
  }

  return {
    ...base,
    pearson: pearsonValue,
    rank_correlation: rankValue,
    mean_absolute_difference: mad,
    sign_disagreement_rate: signRate,
    verdict,
    reason,
    // Recorded only when there is something to record. A month that agrees has
    // not been disputed at any time, and writing the timestamp of a
    // disagreement check into every row would make "was this ever disputed" a
    // question about row count rather than about the data.
    disputed_at: verdict === 'disputed' ? base.computed_at : null,
  }
}

/**
 * Pair two products' monthly series for one district and compare them.
 *
 * Pairs on `period`, not on array position. Two sources that arrive out of
 * order, or where one is missing a month, would silently compare March against
 * April if zipped by index — and the resulting correlation would be a real
 * number describing a relationship between the wrong two things. Only months
 * present in both series are compared, and the count of what was dropped is
 * part of the answer.
 */
export function compareSeries({ district, period, recordsA, recordsB, productA, productB, thresholds }) {
  const indexA = indexByPeriod(recordsA)
  const indexB = indexByPeriod(recordsB)
  const common = [...indexA.keys()].filter((key) => indexB.has(key)).sort()

  const seriesA = common.map((key) => indexA.get(key))
  const seriesB = common.map((key) => indexB.get(key))

  const comparison = compareMonth({ period, seriesA, seriesB, thresholds })

  return {
    ...comparison,
    district,
    period,
    product_a: productA,
    product_b: productB,
    series_a_length: seriesA.length,
    series_b_length: indexA.size,
    unmatched_months: Math.abs(indexA.size - indexB.size),
  }
}

function indexByPeriod(records = []) {
  const index = new Map()
  for (const record of records) {
    const period = record?.period || record?.month || record?.observed_at?.slice(0, 7)
    if (!period) continue
    // First writer wins. A duplicate month inside one source is a defect in
    // that source, and silently averaging it here would hide the defect behind
    // a plausible-looking number.
    if (index.has(period)) continue
    index.set(period, Number(record.precipitation_mm ?? record.value))
  }
  return index
}

/**
 * The report a score should read.
 *
 * `disputed_months` is the thing downstream code needs, and it is a count of
 * names rather than a single blended verdict — a district that disagrees in
 * March is not the same district as one that disagrees everywhere, and
 * averaging the two into one score destroys the part an analyst needs.
 */
export function agreementReport(comparisons = [], { district = null } = {}) {
  const usable = comparisons.filter((c) => c.verdict !== 'unavailable')
  const disputed = usable.filter((c) => c.verdict === 'disputed')
  return {
    district,
    computed_at: nowIso(),
    periods_compared: usable.length,
    periods_unavailable: comparisons.length - usable.length,
    disputed_months: disputed.map((c) => ({ period: c.period, reason: c.reason, disputed_at: c.disputed_at })),
    disputed_count: disputed.length,
    disputed_rate: usable.length ? disputed.length / usable.length : null,
    // Null when nothing was comparable. Zero would read as "checked and found
    // no disagreement", which is a claim about data we do not have.
    any_disputed: usable.length ? disputed.length > 0 : null,
    comparisons: usable,
  }
}