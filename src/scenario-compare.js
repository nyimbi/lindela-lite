import { numericOrNull } from './analytics/numeric.js'
import { refusalSentence } from './model-registry.js'
import { nowIso, stableId } from './utils.js'

/**
 * ENH-55 — scenario comparison workbench.
 *
 * A coordinator choosing between interventions reads one number at a time:
 * stage the convoy here, or there; route through Lodwar, or through Maralal.
 * Each number arrives from its own run, on its own screen, and the comparison
 * between them happens in the coordinator's head — which is exactly where a
 * comparison goes wrong, because the head has no interval and no window.
 *
 * This module puts the two scenarios side by side over the **same region and
 * the same window** and returns a comparison rather than two numbers. It is
 * pure: it re-derives neither scenario, it reads the estimate and the interval
 * each one already reported, and it decides what the pair of them does and does
 * not support.
 *
 * **Three ways a comparison lies, and the rule against each.**
 *
 * 1. *A difference over two windows is not a difference between interventions.*
 *    Two scenarios run over March–May and June–August differ by the season as
 *    much as by the intervention, and subtracting them reports the season as the
 *    effect. So a set whose regions or windows do not match is **refused**, not
 *    differenced — the rule `counterfactual.js` states as
 *    `mismatched_comparison_set`, applied here to the comparison set itself.
 *
 * 2. *Ranking by mean implies an order the data does not carry.* Two scenarios
 *    whose intervals overlap substantially are not distinguishable: the
 *    difference between them could be zero, and reporting the lower mean as
 *    "better" asserts a fact the uncertainty denies. So the module computes the
 *    difference **with its own interval**, tests whether that interval resolves
 *    away from zero, and — when it does not — reports the pair as
 *    indistinguishable and the ranking as unsupported rather than picking the
 *    smaller mean. This is the entry's whole point: a one-at-a-time read cannot
 *    see that two numbers are the same number wearing different point estimates.
 *
 * 3. *A scenario that refused is not a scenario with a worse score.* A model
 *    that returns no estimate because its floor was missed has not produced a
 *    large cost or a small one — it has produced nothing, and sorting it as
 *    zero or as infinity invents the value. A refused scenario **sorts to the
 *    end, is labelled with the model's own refusal sentence**, and is excluded
 *    from the differences rather than scored. This repo has paid for the
 *    alternative repeatedly: an absent value read as zero is the falsy-zero bug,
 *    and a rank over it is that bug with a sort on top.
 *
 * **The difference interval assumes nothing about correlation.** The two
 * scenarios share a region, a window and a road network, so they are correlated
 * and their intervals are not independent draws; a difference interval that
 * assumed independence would be narrower than the truth and would resolve
 * differences the data does not. The bound reported is the interval-arithmetic
 * one — `[from.low − to.high, from.high − to.low]` — which contains the true
 * difference for **any** correlation and therefore does not narrow as
 * independence would. It is the honest width, and the honest width is what
 * keeps the ranking claim from outrunning the data.
 */

/**
 * The refusals this module can return, as codes.
 *
 * A caller that has to match on prose to know why a comparison is absent breaks
 * when the prose is edited, so every refusal prefixes its sentence with one of
 * these. `mismatched_comparison_set` is deliberately the same spelling
 * `counterfactual.js` uses, because it is the same rule.
 */
export const COMPARISON_REFUSALS = Object.freeze([
  'too_few_scenarios',
  'mismatched_comparison_set',
  'unmeasured_uncertainty',
  'unusable_estimate',
  'unusable_direction',
  'unnamed_scenario',
  'duplicate_scenario_name',
])

/** The interval coverage a scenario's own model is assumed to have reported. */
export const DEFAULT_LEVEL = 0.95

/**
 * Which end of the metric is the good one.
 *
 * There is no default that is right for every metric, so the module makes the
 * caller name it rather than guessing from the sign. The primary input —
 * `planPrepositioning`'s `expected_unmet` — is lower-is-better, and that is the
 * default, but a comparison that ranked a "people reached" metric the same way
 * would rank the worst intervention first, so the direction is a stated choice
 * and not an inference.
 */
export const DIRECTIONS = Object.freeze({
  LOWER_IS_BETTER: 'lower_is_better',
  HIGHER_IS_BETTER: 'higher_is_better',
})

/** Float tolerance for "the difference interval touches zero", i.e. the intervals overlap. */
const OVERLAP_EPSILON = 1e-9

function round4(value) {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10000) / 10000
}

/** Linear-interpolated percentile of an already-sorted array. Same estimator as `counterfactual.js`. */
function percentile(sorted, p) {
  if (!sorted.length) return null
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

/**
 * The interval of a distribution of outcomes, as a percentile range.
 *
 * This is the bridge that makes `planPrepositioning` a first-class input. A
 * prepositioning plan reports `expected_unmet` as a single number computed over
 * a scenario set; the *spread* of unmet demand across that set is the
 * uncertainty behind the number, and this turns it into the interval the
 * comparison needs. It is the range of the futures the set enumerates — "unmet
 * demand ranges from X to Y across the scenarios" — and not a sampling interval
 * for the mean, which is a different and narrower claim.
 *
 * Fewer than two outcomes returns null: a single outcome has no spread, and a
 * point interval built from one draw is an interval wearing a point's clothes.
 */
export function intervalFromOutcomes(outcomes = [], { level = DEFAULT_LEVEL, method = null } = {}) {
  const values = (Array.isArray(outcomes) ? outcomes : [])
    .map((value) => numericOrNull(value))
    .filter((value) => value !== null)
    .sort((a, b) => a - b)
  if (values.length < 2) return null
  const alpha = (1 - level) / 2
  return {
    low: round4(percentile(values, alpha)),
    high: round4(percentile(values, 1 - alpha)),
    level,
    method: method ?? `percentile of ${values.length} supplied outcomes`,
  }
}

/** A scenario's interval, normalised and vouched for, or null when it is not usable as one. */
function normaliseInterval(interval, level) {
  const low = numericOrNull(interval?.low)
  const high = numericOrNull(interval?.high)
  if (low === null || high === null || high < low) return null
  const reported = numericOrNull(interval?.level)
  return {
    low: round4(low),
    high: round4(high),
    level: reported === null ? level : reported,
    method: typeof interval?.method === 'string' ? interval.method : 'supplied',
  }
}

/**
 * How much two intervals overlap, as a fraction of the narrower one.
 *
 * `0` when they are disjoint. When the narrower interval has zero width, any
 * overlap is total — a point inside an interval is entirely inside it — so the
 * fraction is `1` rather than a division by zero.
 */
function overlapFraction(a, b) {
  const overlap = Math.min(a.high, b.high) - Math.max(a.low, b.low)
  if (overlap <= 0) return 0
  const narrower = Math.min(a.high - a.low, b.high - b.low)
  if (narrower <= 0) return 1
  return Math.min(1, overlap / narrower)
}

/** A window as `{start, end}` strings, or null when either endpoint is absent. */
function windowBounds(win) {
  const start = win?.start ?? win?.from ?? null
  const end = win?.end ?? win?.to ?? null
  if (start === null || end === null) return null
  return { start: String(start), end: String(end) }
}

/** The label a refused scenario carries: the model's own sentence, or a plain statement that it refused. */
function refusalLabel(scenario, name) {
  if (typeof scenario?.refusal === 'string' && scenario.refusal.trim()) return scenario.refusal.trim()
  if (scenario?.model) {
    const sentence = refusalSentence(scenario.model, scenario.refusal_code ?? null)
    if (sentence) return sentence
  }
  return `scenario '${name}' refused and returned no estimate; a refusal is not a score, and it is carried as a sentence rather than a number`
}

/** The refusal shape. Null-valued fields, so a caller cannot read a refused comparison as an empty one. */
function refuse(reason, message, extra = {}) {
  return {
    type: 'scenario_comparison',
    metric: null,
    direction: null,
    region: null,
    window: null,
    scenarios: null,
    differences: null,
    refused: null,
    not_compared: null,
    decision: null,
    refusal: reason,
    reason: message,
    ...extra,
  }
}

/**
 * Compare two or more named scenarios over the same region and window.
 *
 * Each scenario is shaped
 * `{ name, region, window: { start, end }, estimate, interval, refusal?, outcomes?, detail? }`.
 * `estimate` may also be supplied as `expected_unmet`, so a `planPrepositioning`
 * result drops straight in; an interval may be supplied directly (a
 * `counterfactualImpact` result carries one) or derived from an `outcomes` array
 * of the futures the estimate was computed over.
 *
 * Returns the scenarios ranked best-first with the refused ones appended and
 * labelled, every pairwise difference with its interval, and a `decision`
 * separate from the differences — the ranking the data *does* support, or the
 * statement that it supports none. Returns a refusal when the set cannot be
 * compared at all: fewer than two scenarios, a region or window that does not
 * match, an estimate with no uncertainty, or a scenario that is neither scored
 * nor explained.
 */
export function compareScenarios({
  scenarios = [],
  region = null,
  window = null,
  metric = null,
  direction = DIRECTIONS.LOWER_IS_BETTER,
  level = DEFAULT_LEVEL,
} = {}) {
  const list = Array.isArray(scenarios) ? scenarios : []
  if (list.length < 2) {
    return refuse(
      'too_few_scenarios',
      `a comparison needs two scenarios to compare; ${list.length} was supplied, and one scenario has nothing to be compared against`,
      { metric },
    )
  }
  if (direction !== DIRECTIONS.LOWER_IS_BETTER && direction !== DIRECTIONS.HIGHER_IS_BETTER) {
    return refuse(
      'unusable_direction',
      `direction must be one of ${Object.values(DIRECTIONS).join(', ')}; '${direction}' would rank the scenarios by an order nobody chose`,
      { metric },
    )
  }

  // Names first: a comparison is keyed by the names of the interventions, and a
  // collision would collapse two interventions into one row.
  const names = []
  for (let i = 0; i < list.length; i += 1) {
    const name = typeof list[i]?.name === 'string' ? list[i].name.trim() : ''
    if (!name) {
      return refuse(
        'unnamed_scenario',
        `scenario ${i + 1} carries no name; a coordinator reads this comparison by the names of the interventions, and an unnamed one cannot be reported`,
        { metric },
      )
    }
    names.push(name)
  }
  const duplicate = names.find((name, i) => names.indexOf(name) !== i)
  if (duplicate) {
    return refuse(
      'duplicate_scenario_name',
      `two scenarios are both named '${duplicate}'; a comparison keyed by name would collapse them into a single row`,
      { metric },
    )
  }

  // The same-region, same-window rule. The comparison is valid only over one
  // region and one window, so a mismatch is refused rather than differenced.
  const regionValues = list.map((scenario) => (
    typeof scenario?.region === 'string' && scenario.region.trim() ? scenario.region.trim() : null
  ))
  const requiredRegion = region === null ? regionValues[0] : String(region)
  for (let i = 0; i < list.length; i += 1) {
    if (regionValues[i] === null) {
      return refuse(
        'mismatched_comparison_set',
        `scenario '${names[i]}' names no region; a comparison over an unstated region cannot be shown to be over the same one, so it is refused rather than assumed`,
        { metric },
      )
    }
    if (regionValues[i] !== requiredRegion) {
      return refuse(
        'mismatched_comparison_set',
        `scenario '${names[i]}' is over region '${regionValues[i]}' and '${names[0]}' is over '${requiredRegion}'; differencing two regions includes the difference in regions — the rule counterfactual.js states as mismatched_comparison_set — so the comparison is refused rather than differenced`,
        { metric },
      )
    }
  }

  const windowValues = list.map((scenario) => windowBounds(scenario?.window))
  const requiredWindow = window === null ? windowValues[0] : windowBounds(window)
  if (requiredWindow === null) {
    return refuse(
      'mismatched_comparison_set',
      `the comparison names no window; two scenarios over unstated windows could differ by the window rather than the intervention, so the comparison is refused`,
      { metric },
    )
  }
  for (let i = 0; i < list.length; i += 1) {
    if (windowValues[i] === null) {
      return refuse(
        'mismatched_comparison_set',
        `scenario '${names[i]}' names no window; a comparison over an unstated window cannot be shown to be over the same one`,
        { metric },
      )
    }
    if (windowValues[i].start !== requiredWindow.start || windowValues[i].end !== requiredWindow.end) {
      return refuse(
        'mismatched_comparison_set',
        `scenario '${names[i]}' covers ${windowValues[i].start}..${windowValues[i].end} and '${names[0]}' covers ${requiredWindow.start}..${requiredWindow.end}; a difference over two windows includes the difference in windows — the rule counterfactual.js states as mismatched_comparison_set — so the comparison is refused rather than differenced`,
        { metric },
      )
    }
  }

  const scored = []
  const refusedScenarios = []
  for (let i = 0; i < list.length; i += 1) {
    const scenario = list[i]
    const name = names[i]
    const markedRefused = (typeof scenario?.refusal === 'string' && scenario.refusal.trim() !== '')
      || scenario?.refused === true
    if (markedRefused) {
      refusedScenarios.push({
        name,
        refused: true,
        refusal: refusalLabel(scenario, name),
        estimate: null,
        interval: null,
        width: null,
        rank: null,
        detail: scenario?.detail ?? null,
      })
      continue
    }

    // `expected_unmet` as well as `estimate`, so a prepositioning plan is a
    // scenario without the caller renaming its field.
    const estimate = numericOrNull(scenario?.estimate ?? scenario?.expected_unmet)
    if (estimate === null) {
      return refuse(
        'unusable_estimate',
        `scenario '${name}' carries neither a refusal nor a finite estimate; it is neither scored nor explained, and reporting it as either would invent the value`,
        { metric },
      )
    }

    let interval = scenario?.interval ? normaliseInterval(scenario.interval, level) : null
    if (!interval && Array.isArray(scenario?.outcomes)) interval = intervalFromOutcomes(scenario.outcomes, { level })
    if (!interval) {
      return refuse(
        'unmeasured_uncertainty',
        `scenario '${name}' carries an estimate with no interval; a comparison that ranked it against the others would imply an order the uncertainty was never measured for, which is the single number a one-at-a-time read already gives`,
        { metric },
      )
    }

    scored.push({
      name,
      refused: false,
      estimate,
      interval,
      width: round4(interval.high - interval.low),
      detail: scenario?.detail ?? null,
    })
  }

  // Best first, per the stated direction. JS sort is stable, so equal estimates
  // keep the order the caller gave them.
  const ordered = scored.slice().sort((a, b) => (
    direction === DIRECTIONS.LOWER_IS_BETTER ? a.estimate - b.estimate : b.estimate - a.estimate
  ))

  const differences = []
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const from = ordered[i]
      const to = ordered[j]
      const difference = from.estimate - to.estimate
      // Interval arithmetic: the widest difference consistent with both
      // intervals, which holds for any correlation and does not narrow the way
      // an independence assumption would.
      const interval = {
        low: round4(from.interval.low - to.interval.high),
        high: round4(from.interval.high - to.interval.low),
        level: Math.min(from.interval.level, to.interval.level),
        method: 'interval arithmetic: [from.low - to.high, from.high - to.low]',
        assumes: 'nothing about the correlation between the two scenarios; the bound contains the difference for any correlation and does not narrow as independence would',
      }
      // The difference resolves away from zero exactly when the two intervals
      // are disjoint, which is when the ranking between this pair is supported.
      const distinguishable = interval.low > OVERLAP_EPSILON || interval.high < -OVERLAP_EPSILON
      differences.push({
        from: from.name,
        to: to.name,
        difference: round4(difference),
        interval,
        distinguishable,
        overlap_fraction: round4(overlapFraction(from.interval, to.interval)),
        favours: distinguishable ? from.name : null,
      })
    }
  }

  const indistinguishable = differences.filter((pair) => !pair.distinguishable)
  const supported = ordered.length >= 2 && indistinguishable.length === 0
  const decision = {
    supported,
    better: supported ? ordered[0].name : null,
    statement: decisionStatement({ ordered, indistinguishable, supported, level }),
    not_supported: indistinguishable.map((pair) => (
      `'${pair.from}' and '${pair.to}' overlap by ${Math.round(pair.overlap_fraction * 100)}% of the narrower interval, so a difference between them is not resolved at the ${level} level`
    )),
  }

  const notCompared = refusedScenarios.map((scenario) => (
    `'${scenario.name}' refused, so it is not differenced against the scored scenarios and carries no rank`
  ))

  const generatedAt = nowIso()
  return {
    id: stableId('comparison', [names.join('|'), requiredRegion, `${requiredWindow.start}..${requiredWindow.end}`, generatedAt.slice(0, 10)]),
    type: 'scenario_comparison',
    metric: metric ?? null,
    direction,
    region: requiredRegion,
    window: requiredWindow,
    level,
    scenarios: [
      ...ordered.map((scenario, i) => ({ ...scenario, rank: i + 1 })),
      ...refusedScenarios,
    ],
    differences,
    refused: refusedScenarios.map((scenario) => scenario.name),
    not_compared: notCompared,
    decision,
    basis: 'a comparison of the estimates and intervals the scenarios reported over one region and window; it re-derives neither, and an overlap is reported as an unresolved order rather than resolved by the means',
    refusal: null,
    reason: null,
    generated_at: generatedAt,
  }
}

/** The one sentence the decision renders: what the ranking is, or why there is none. */
function decisionStatement({ ordered, indistinguishable, supported, level }) {
  if (ordered.length === 0) {
    return 'no scenario carried an estimate, so there is nothing to rank'
  }
  if (ordered.length === 1) {
    return `only one scenario carried an estimate ('${ordered[0].name}'), and a comparison needs two before a ranking exists`
  }
  if (supported) {
    return `'${ordered[0].name}' is distinguishable from every other scenario at the ${level} level; its interval does not overlap any other's`
  }
  return `the data does not support ranking these scenarios: ${indistinguishable.length} pair(s) have overlapping intervals, so the order among them is not resolved`
}
