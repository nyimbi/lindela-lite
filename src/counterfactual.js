/**
 * ENH-58 — counterfactual impact evaluation.
 *
 * A dispatch either happened or it did not, and everything this platform
 * publishes about it is a report on the treated side alone: how many people it
 * reached, how fast, what the field confirmed. None of that answers the only
 * question an accountability surface is asked — *what did the intervention
 * change?* A district that flooded anyway after a dispatch looks identical in
 * every reporting panel to one the dispatch spared, because the panel has no
 * counterfactual: the number is the treated district's number, and a number
 * with nothing to compare it against is a description, not an effect.
 *
 * So this module takes a treated set — units that received a dispatch, each with
 * its outcome before and after — and a set of comparison units that did not, and
 * estimates the difference the dispatch made. It is the difference between a
 * reporting tool and an accountability one, and the whole of the difference is
 * that the second number requires a comparison set it can defend.
 *
 * **The estimator, and why this one.** Two estimators were admissible:
 * difference-in-differences over a pooled comparison arm, or a matched-pair
 * before/after contrast. This module implements **difference-in-differences**:
 *
 *     ATT = (mean_after − mean_before)_treated − (mean_after − mean_before)_comparison
 *
 * The reason is the shape of the data this platform actually has. The
 * administrative registry holds seven units; a matched-pair design would pair
 * each treated unit with one comparison unit and estimate off a single pair,
 * which is the "counterfactual from four records" the house rule forbids. DiD
 * pools every comparison unit that matches, so the same seven units give an
 * estimate whose interval reflects how many of them there are. It also absorbs
 * any shock the two arms share — a season, a national response, a reporting
 * change — because that shock sits in both deltas and cancels in the
 * subtraction. A before/after contrast on the treated arm alone cannot do that,
 * and it is the estimator most likely to be mistaken for this one.
 *
 * **The identifying assumption, stated plainly.** DiD is unbiased only under
 * **parallel trends**: absent the dispatch, the treated and comparison arms
 * would have moved by the same amount. That assumption is *not* testable from a
 * single before/after pair, and this module says so rather than implying
 * otherwise — one pre-period cannot show whether two series were parallel,
 * because two points per series do not describe a trend. What the module *can*
 * check is the weaker, necessary condition: that the matched comparison arm
 * sits at a comparable **baseline** to the treated arm. A comparison set whose
 * pre-period outcome already differs from the treated set's beyond
 * `BASELINE_TOLERANCE` is refused, because a set that is not comparable at the
 * start cannot be assumed to move in parallel afterwards. Baseline balance is
 * necessary for parallel trends and not sufficient for it, and the estimate
 * carries that limitation in its `assumptions` field rather than in a footnote.
 *
 * **Uncertainty, never a bare point.** The estimate travels with a **unit
 * bootstrap** percentile interval: the treated and comparison arms are resampled
 * with replacement, the DiD recomputed, and the 2.5th and 97.5th percentiles of
 * the draws reported. Units are the resampling cluster because units are the
 * independent draw — records within a unit are not. The RNG is seeded, so the
 * interval is reproducible run to run; the default seed is fixed and the seed
 * used is returned on every estimate.
 *
 * **The refusals are the substance.** A counterfactual that quietly reports a
 * number from four records is worse than no counterfactual, so this module
 * refuses — returning `estimate: null` and a `refusal` naming the condition that
 * failed — when the comparison set is too thin, too mismatched, or not on a
 * comparable baseline. A reconciliation that measures nothing must fail, not
 * report success.
 */

import { orgUnitByCode } from './org-units.js'
import { stableId, toNumber } from './utils.js'

/**
 * Fewest units in an arm before a DiD is reported.
 *
 * Three, not two. A two-unit arm has a mean with no spread, so the bootstrap has
 * nothing to resample and the interval collapses to a point — an estimate
 * wearing a confidence interval's clothes. Three is the point at which the arm
 * starts to have a distribution rather than a pair of numbers, and it is a floor
 * on the *unit* count, not a statistical threshold presented as one.
 */
export const MIN_ARM_UNITS = 3

/**
 * How far a comparison unit's radius may differ from a treated unit's before the
 * two are not comparable.
 *
 * The registry gives every unit a centre and a radius and no polygon
 * (`boundary_kind: 'center_radius'`), so "same size" means "radius within this
 * factor". A 150 km unit and a 300 km unit are not like-for-like: the second
 * carries four times the area and a different exposure profile, and matching
 * them would import the difference into the estimate as if it were the effect.
 */
export const RADIUS_RATIO_MAX = 1.5

/**
 * How far the matched comparison arm's baseline may sit from the treated arm's,
 * as a fraction of the pooled pre-period scale, before the match is refused.
 *
 * This is the one testable shadow of parallel trends, and it is deliberately
 * generous: it is not a precision threshold, it is the point past which the two
 * arms are plainly describing different populations. The scale is the pooled
 * pre-period spread, so the tolerance means "within half a standard deviation",
 * which does not tighten as the units grow more alike — a fixed absolute gap
 * would refuse small numbers and wave through large ones.
 */
export const BASELINE_TOLERANCE = 0.5

/** Bootstrap draws. Enough for a stable 2.5th percentile without a cost a route cannot pay. */
export const BOOTSTRAP_ITERATIONS = 2000

/** The default seed. Fixed, so the interval is reproducible without the caller passing one. */
export const DEFAULT_SEED = 0x9e3779b9

/** The interval's nominal coverage. */
export const CONFIDENCE_LEVEL = 0.95

/**
 * A deterministic 32-bit PRNG (mulberry32).
 *
 * `Math.random` is the wrong instrument here: it makes the interval differ
 * between two runs over identical data, so a stored estimate cannot be
 * re-derived and a test cannot assert on it. This generator is seeded, small,
 * and good enough for a percentile bootstrap — the draws are consumed in
 * millions at most and their distribution, not their cryptographic quality, is
 * what the interval depends on.
 */
export function seededRng(seed = DEFAULT_SEED) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The structural attributes a match is drawn on, from the record or the registry. */
function structureOf(unit) {
  const code = unit?.unit_code || unit?.code || null
  const registered = orgUnitByCode(code)
  return {
    key: code || unit?.id || null,
    country: unit?.country ?? registered?.country ?? null,
    level: unit?.level ?? registered?.level ?? null,
    radius_km: toNumber(unit?.radius_km ?? registered?.radius_km),
  }
}

/** A unit's change over the window, or null when either endpoint is not a number. */
function deltaOf(unit) {
  const before = toNumber(unit?.outcome_before)
  const after = toNumber(unit?.outcome_after)
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null
  return { before, after, delta: after - before }
}

/**
 * Whether one candidate comparison unit is like-for-like with a treated unit.
 *
 * Three axes, all structural, none of them the outcome: same country, same
 * administrative level, radius within `RADIUS_RATIO_MAX`. The outcome is
 * deliberately not a matching axis — matching on the pre-period outcome would
 * condition the comparison set on the very quantity the estimate is computed
 * from, which is how a matched design manufactures its own result. A missing
 * country, level or radius is a match *failure*, not a wildcard: an axis that
 * cannot be checked cannot be claimed to hold.
 */
function matches(treated, candidate) {
  const axes = {}
  axes.country = Boolean(treated.country) && treated.country === candidate.country
  axes.level = treated.level !== null && treated.level === candidate.level
  const both = Number.isFinite(treated.radius_km) && Number.isFinite(candidate.radius_km) && candidate.radius_km > 0
  const ratio = both ? Math.max(treated.radius_km, candidate.radius_km) / Math.min(treated.radius_km, candidate.radius_km) : null
  axes.radius = both && ratio <= RADIUS_RATIO_MAX
  return { matched: axes.country && axes.level && axes.radius, axes, radius_ratio: ratio === null ? null : round4(ratio) }
}

/**
 * Choose the comparison set by the matching rule, and say what it chose.
 *
 * The rule is per treated unit: every candidate that matches it on all three
 * axes is admitted, and the union of those admissions is the comparison arm. A
 * treated unit with no match at all refuses the whole evaluation, because the
 * arm it would be measured against does not exist — averaging over the treated
 * units that happened to find a match would silently drop the ones that did not,
 * and the ones that did not are usually the unusual units the reader most needs
 * to see.
 *
 * The `audit` records, per treated unit, which candidates matched and on what,
 * so the comparison set is a decision a reader can check rather than a black
 * box the estimate arrived from.
 */
export function matchComparisonSet({ treated = [], comparison = [] } = {}) {
  const treatedStructures = treated.map((unit) => ({ unit, structure: structureOf(unit) }))
  const comparisonStructures = comparison.map((unit) => ({ unit, structure: structureOf(unit) }))
  const admitted = new Map()
  const audit = []
  const unmatched = []

  for (const { unit, structure } of treatedStructures) {
    const matchedKeys = []
    for (const candidate of comparisonStructures) {
      const verdict = matches(structure, candidate.structure)
      if (!verdict.matched) continue
      matchedKeys.push({ key: candidate.structure.key, axes: verdict.axes, radius_ratio: verdict.radius_ratio })
      admitted.set(candidate.structure.key, candidate.unit)
    }
    audit.push({ treated: structure.key, matched: matchedKeys })
    if (!matchedKeys.length) unmatched.push(structure.key)
  }

  return {
    matched: [...admitted.values()],
    audit,
    unmatched,
    refusal: unmatched.length
      ? `${unmatched.length} treated unit(s) have no comparison unit matching on country, level and radius within ${RADIUS_RATIO_MAX}x: ${unmatched.join(', ')}`
      : null,
  }
}

/**
 * The pooled difference-in-differences on two arms of deltas.
 *
 * Exported because it is the arithmetic the module rests on and a test should be
 * able to point at it directly. It does not decide anything — the floors and the
 * balance check live in `counterfactualImpact` — so a caller reaching for it
 * gets a number and no honesty envelope, which is why the module's public entry
 * point is the function below and not this one.
 */
export function differenceInDifferences(treatedDeltas = [], comparisonDeltas = []) {
  if (!treatedDeltas.length || !comparisonDeltas.length) return null
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length
  return mean(treatedDeltas) - mean(comparisonDeltas)
}

/** Linear-interpolated percentile of an already-sorted array. */
function percentile(sorted, p) {
  if (!sorted.length) return null
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

/** Standard deviation of a sample, or 0 when it has no spread. */
function sampleSd(values) {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/**
 * The effect of a dispatch, with its interval, or a refusal naming what failed.
 *
 * Input: `treated` and `comparison`, arrays of units shaped
 * `{ unit_code, country?, level?, radius_km?, outcome_before, outcome_after }`.
 * Country, level and radius fall back to the org-units registry when the record
 * omits them and carries a resolvable `unit_code`.
 *
 * Returns an object carrying `estimate`, `interval`, `arms`, `matched` and
 * `assumptions` on success, and `estimate: null` plus a `refusal` when the
 * comparison set cannot support an estimate. Every refusal names the condition
 * that failed and the counts that produced it.
 */
export function counterfactualImpact({
  treated = [],
  comparison = [],
  metric = null,
  seed = DEFAULT_SEED,
  iterations = BOOTSTRAP_ITERATIONS,
  baselineTolerance = BASELINE_TOLERANCE,
  minArmUnits = MIN_ARM_UNITS,
} = {}) {
  // A unit with no readable before/after cannot contribute a delta. Incomplete
  // *comparison* units are dropped and counted; an incomplete *treated* unit
  // refuses, because the treated set is the intervention and quietly shrinking
  // it changes what the estimate is about.
  const treatedIncomplete = treated.filter((unit) => deltaOf(unit) === null)
  if (treatedIncomplete.length) {
    const keys = treatedIncomplete.map((unit) => structureOf(unit).key).join(', ')
    return refusal(
      `thin_treated_arm: ${treatedIncomplete.length} treated unit(s) carry no finite before/after outcome (${keys}); the treated set is the intervention and it is not shrunk silently`,
      { treated_incomplete: treatedIncomplete.length },
    )
  }

  const matching = matchComparisonSet({ treated, comparison })
  if (matching.refusal) return refusal(`mismatched_comparison_set: ${matching.refusal}`, { unmatched: matching.unmatched })

  const treatedDeltas = treated.map((unit) => deltaOf(unit))
  const comparisonDeltas = matching.matched.map((unit) => deltaOf(unit)).filter(Boolean)
  const droppedComparison = matching.matched.length - comparisonDeltas.length

  if (treatedDeltas.length < minArmUnits) {
    return refusal(
      `thin_treated_arm: ${treatedDeltas.length} treated unit(s) with a usable outcome; ${minArmUnits} are needed before a mean has a distribution rather than a pair of numbers`,
      { treated_units: treatedDeltas.length },
    )
  }
  if (comparisonDeltas.length < minArmUnits) {
    return refusal(
      `thin_comparison_arm: ${comparisonDeltas.length} matched comparison unit(s) with a usable outcome; ${minArmUnits} are needed, and a counterfactual from fewer is worse than none`,
      { comparison_units: comparisonDeltas.length, matched: matching.matched.length, dropped: droppedComparison },
    )
  }

  // Baseline balance: the necessary shadow of parallel trends. Scale is the
  // pooled pre-period spread, so the tolerance does not tighten as the numbers
  // shrink — an absolute gap would refuse small figures and pass large ones.
  const treatedBefore = treatedDeltas.map((d) => d.before)
  const comparisonBefore = comparisonDeltas.map((d) => d.before)
  const baselineGap = mean(treatedBefore) - mean(comparisonBefore)
  const scale = Math.max(sampleSd([...treatedBefore, ...comparisonBefore]), 1e-9)
  const imbalance = Math.abs(baselineGap) / scale
  if (imbalance > baselineTolerance) {
    return refusal(
      `baseline_imbalance: the matched comparison arm's pre-period mean differs from the treated arm's by ${round4(baselineGap)} (${round4(imbalance)}x the pooled pre-period spread, tolerance ${baselineTolerance}x); a set that is not comparable at the start cannot be assumed to move in parallel afterwards`,
      { baseline_gap: round4(baselineGap), imbalance: round4(imbalance), scale: round4(scale) },
    )
  }

  const treatedDeltasOnly = treatedDeltas.map((d) => d.delta)
  const comparisonDeltasOnly = comparisonDeltas.map((d) => d.delta)
  const pooled = [...treatedDeltasOnly, ...comparisonDeltasOnly]
  // With no variation anywhere, every bootstrap draw is the same number and the
  // interval is a point. A zero-width interval is not a tight estimate, it is
  // the absence of one, and it must be refused rather than printed.
  if (sampleSd(pooled) === 0) {
    return refusal(
      `no_variation: every unit moved by the same amount, so the bootstrap has nothing to resample and the interval would be a point carrying a confidence interval's authority`,
      { units: pooled.length },
    )
  }

  const estimate = differenceInDifferences(treatedDeltasOnly, comparisonDeltasOnly)
  const rng = seededRng(seed)
  const draws = []
  for (let i = 0; i < iterations; i += 1) {
    draws.push(differenceInDifferences(
      resample(treatedDeltasOnly, rng),
      resample(comparisonDeltasOnly, rng),
    ))
  }
  draws.sort((a, b) => a - b)
  const alpha = (1 - CONFIDENCE_LEVEL) / 2
  const interval = {
    low: round4(percentile(draws, alpha)),
    high: round4(percentile(draws, 1 - alpha)),
    level: CONFIDENCE_LEVEL,
    method: `unit bootstrap, ${iterations} draws, percentile`,
    seed,
  }

  const generatedAt = new Date().toISOString()
  return {
    id: stableId('counterfactual', [metric ?? 'effect', matching.audit.map((a) => a.treated).join(','), generatedAt.slice(0, 10)]),
    type: 'counterfactual_impact',
    metric,
    estimator: 'difference-in-differences',
    estimate: round4(estimate),
    interval,
    arms: {
      treated_units: treatedDeltasOnly.length,
      comparison_units: comparisonDeltasOnly.length,
      matched_candidates: matching.matched.length,
      dropped_comparison_units: droppedComparison,
      treated_delta: round4(mean(treatedDeltasOnly)),
      comparison_delta: round4(mean(comparisonDeltasOnly)),
    },
    match_audit: matching.audit,
    // The assumption, carried on the record. `testable: false` is the honest
    // value: a single before/after pair cannot show whether two series were
    // parallel, and the baseline check below it is necessary and not sufficient.
    assumptions: {
      identifying_assumption: 'parallel trends: absent the dispatch, the treated and comparison arms would have moved by the same amount',
      testable: false,
      baseline_balance: {
        gap: round4(baselineGap),
        scale: round4(scale),
        imbalance: round4(imbalance),
        tolerance: baselineTolerance,
        check: 'the matched comparison arm sits at a comparable pre-period baseline; necessary for parallel trends, not sufficient for it',
      },
      basis: 'pooled difference-in-differences over the treated arm against the union of comparison units matching on country, level and radius — not a matched-pair contrast, and not an estimate of the mechanism',
    },
    uncertainty: {
      measures: 'resampling spread of the estimate across units, and the populations and effects it does not represent',
      interval,
      not_represented: [
        'any shock that hit the two arms unequally, which parallel trends assumes away and one pre-period cannot reveal',
        'units outside the registry that no treated unit matched',
        'the mechanism: this measures that the arms diverged by this much, not why',
      ],
    },
    generated_at: generatedAt,
    refusal: null,
  }
}

/** Resample `values` with replacement, `values.length` draws. */
function resample(values, rng) {
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i += 1) out[i] = values[Math.floor(rng() * values.length)]
  return out
}

function refusal(reason, detail = {}) {
  return {
    type: 'counterfactual_impact',
    estimate: null,
    interval: null,
    refusal: reason,
    detail,
  }
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function round4(value) {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10000) / 10000
}
