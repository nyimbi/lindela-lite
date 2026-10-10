import { stableId } from './utils.js'
import { honestyEnvelope, uncertaintyTiers } from './analytics.js'
import { MIN_EVENTS, MIN_MONTHS, wilsonInterval } from './flood-probability.js'

/**
 * Model-drift monitoring (ENH-05).
 *
 * Data age is already watched (`freshnessPenaltyFor` in src/analytics.js). What
 * nothing watched was the model: the archive backfill means these coefficients
 * will move substantially as the GDACS archive and GloFAS discharge labels grow,
 * and when they do, a district's risk changes because the training window
 * changed and no one can say so. That is the failure mode of every deployed
 * statistical model — silent drift.
 *
 * Two independent signals, because either alone misses the interesting case:
 *
 * 1. **Input distribution shift** — the features themselves have moved. PSI
 *    (population stability index) between a reference window and the current
 *    one, per feature. Detects the rainfall regime changing underneath a model
 *    whose coefficients never re-fit.
 * 2. **Score/outcome divergence** — the model's mean predicted probability
 *    against the observed event rate in the current window. Detects the
 *    relationship failing while the inputs look unchanged, which is the case
 *    input monitoring structurally cannot see.
 *
 * The distinction this module is built around: **"drift detected" is not "no
 * data"**, and a third verdict — `not_measurable` — exists for both. A monitor
 * that reported "no drift" from two observations would be asserting a negative
 * about a sample too small to support any statement, and an operator reading
 * that as reassurance is worse off than one reading nothing. Every verdict here
 * carries the window sizes that produced it.
 */

/**
 * PSI interpretation bands, from the standard convention.
 *
 * Below 0.10 the two distributions are not distinguishable by this measure.
 * Above 0.25 the shift is material and the model's coefficients no longer
 * describe the population it is being applied to. Between the two it is
 * `watching` — reported, not alarmed.
 */
export const PSI_WATCH = 0.1
export const PSI_DRIFT = 0.25

/**
 * Minimum months in each window before an input-shift number is reported.
 *
 * The model's own floor is MIN_MONTHS for training. Comparing distributions
 * needs less than fitting does, but the floor here is deliberately not lowered:
 * a PSI computed on a dozen months is a statement about twelve months, and the
 * drift it reports would attach to every score in the region.
 */
export const MIN_DRIFT_WINDOW_MONTHS = 24

/**
 * Minimum observed events in the current window before divergence is reported.
 *
 * The same floor as the model's MIN_EVENTS, inherited deliberately. A divergence
 * computed against one observed event is that event.
 */
export const MIN_DRIFT_EVENTS = MIN_EVENTS

export const DRIFT_BASIS = Object.freeze({
  basis: 'window-over-window comparison of the same series; no refit is performed and no parameter is changed',
  input_shift_measure: `population stability index per feature, reference window against current window; >= ${PSI_WATCH} watching, >= ${PSI_DRIFT} drift`,
  divergence_measure: 'mean predicted probability against observed event rate, with a Wilson interval on the observed rate',
  windows: `both windows need >= ${MIN_DRIFT_WINDOW_MONTHS} months with valid features, and >= ${MIN_DRIFT_EVENTS} observed events in the current window`,
  what_a_drift_verdict_is_not: 'a cause. Detecting that the relationship moved does not say why, and the remedy for input shift is not the remedy for a broken relationship',
})

/**
 * Population stability index between two samples of one feature.
 *
 * `sum((actual% - expected%) * ln(actual% / expected%))` over quantile bins cut
 * from the reference. The correction is Bartlett's: without the `ln` this is a
 * total-variation-shaped statistic that grows with bin count and reads as drift
 * on a stable series. Bins with zero expected mass take a floor of one count so
 * the logarithm stays finite — a bin the reference never populated and the
 * current window fills is itself a shift worth reporting, not a division by
 * zero.
 */
export function populationStabilityIndex(reference, current, { bins = 5 } = {}) {
  const ref = (reference || []).filter(Number.isFinite).sort((a, b) => a - b)
  const cur = (current || []).filter(Number.isFinite)
  if (ref.length < bins || cur.length < bins) {
    return { psi: null, reason: `need at least ${bins} finite values in each window, have ${ref.length} and ${cur.length}` }
  }
  const edges = []
  for (let i = 1; i < bins; i += 1) edges.push(ref[Math.floor((i * ref.length) / bins)])

  const share = (values) => {
    const counts = new Array(bins).fill(0)
    for (const value of values) {
      let bin = 0
      while (bin < edges.length && value > edges[bin]) bin += 1
      counts[bin] += 1
    }
    return counts.map((c) => c / values.length)
  }
  const expected = share(ref)
  const actual = share(cur)
  let psi = 0
  for (let i = 0; i < bins; i += 1) {
    // Floor both shares at one observation's worth. A bin that emptied is a
    // real shift, and reporting it as an infinite statistic would be a way of
    // refusing to quantify something the measure can quantify.
    const e = Math.max(expected[i], 0.5 / ref.length)
    const a = Math.max(actual[i], 0.5 / cur.length)
    psi += (a - e) * Math.log(a / e)
  }
  return {
    psi: Math.round(psi * 10000) / 10000,
    bins,
    reference_count: ref.length,
    current_count: cur.length,
    reason: null,
  }
}

/**
 * Input distribution shift, per feature, over two windows of monthly samples.
 *
 * `reference` and `current` are arrays of `{ month, features: {name: value} }`,
 * the same grain `buildDistrictSamples` produces. The window gate is on months
 * with a usable feature, not on months present: a window of 40 months where 30
 * carry no discharge figure has 10 months of evidence and is refused on it.
 */
export function detectInputShift(referenceSamples = [], currentSamples = [], { features = ['max_7_day', 'sum_30_day', 'sum_90_day'], monthsFloor = MIN_DRIFT_WINDOW_MONTHS } = {}) {
  const window = (samples) => {
    const usable = samples.filter((s) => s && typeof s === 'object')
    return {
      months: usable.length,
      features: Object.fromEntries(features.map((f) => [f, usable.map((s) => Number(s.features?.[f])).filter(Number.isFinite)])),
    }
  }
  const ref = window(referenceSamples)
  const cur = window(currentSamples)

  if (ref.months < monthsFloor || cur.months < monthsFloor) {
    return {
      verdict: 'not_measurable',
      reason: `input shift needs >= ${monthsFloor} months in each window, have ${ref.months} reference and ${cur.months} current`,
      reference_months: ref.months,
      current_months: cur.months,
      features: {},
    }
  }

  const measured = {}
  let worst = 0
  let measurable = 0
  for (const feature of features) {
    const result = populationStabilityIndex(ref.features[feature], cur.features[feature])
    measured[feature] = {
      ...result,
      verdict: result.psi === null ? 'not_measurable'
        : result.psi >= PSI_DRIFT ? 'drift'
          : result.psi >= PSI_WATCH ? 'watching'
            : 'stable',
    }
    if (Number.isFinite(result.psi)) {
      measurable += 1
      if (result.psi > worst) worst = result.psi
    }
  }
  // "No feature could be measured" is not "the distribution is stable".
  //
  // `worst` starts at 0, so an all-null feature set — every window present but
  // carrying no values — fell through to `worst >= PSI_WATCH` being false and
  // reported `verdict: 'stable'` with `worst_psi: 0`. Each per-feature verdict
  // above already says `not_measurable`; the roll-up contradicted them, and a
  // reader watching the headline would conclude the inputs had not moved at the
  // exact moment the platform had stopped being able to see whether they had.
  if (measurable === 0) {
    return {
      verdict: 'not_measurable',
      reason: `no feature carried a measurable value in both windows; ${features.length} feature(s) checked`,
      worst_psi: null,
      reference_months: ref.months,
      current_months: cur.months,
      features: measured,
    }
  }
  return {
    verdict: worst >= PSI_DRIFT ? 'drift' : worst >= PSI_WATCH ? 'watching' : 'stable',
    reason: null,
    worst_psi: Math.round(worst * 10000) / 10000,
    reference_months: ref.months,
    current_months: cur.months,
    features: measured,
  }
}

/**
 * Score/outcome divergence in the current window.
 *
 * Compares the mean predicted probability the model would assign to the current
 * window's months against the rate those months actually showed. A large gap in
 * either direction is the signal: over-prediction is an alerting system that
 * cries wolf, under-prediction is one that misses.
 *
 * The observed rate carries a Wilson interval, and the divergence is refused
 * entirely unless that interval excludes the predicted mean. Without that test a
 * 12% observed rate against an 8% prediction on 8 events reads as drift; with
 * it, the same comparison reads as "cannot tell", which is what 8 events can
 * actually support.
 */
export function detectOutcomeDivergence(samples = [], model = null, { monthsFloor = MIN_DRIFT_WINDOW_MONTHS, eventsFloor = MIN_DRIFT_EVENTS } = {}) {
  const usable = (samples || []).filter((s) => s && typeof s === 'object')
  if (usable.length < monthsFloor) {
    return {
      verdict: 'not_measurable',
      reason: `divergence needs >= ${monthsFloor} months in the current window, have ${usable.length}`,
      months: usable.length,
    }
  }
  const events = usable.filter((s) => s.label).length
  if (events < eventsFloor) {
    return {
      verdict: 'not_measurable',
      reason: `divergence needs >= ${eventsFloor} observed events in the current window, have ${events}`,
      months: usable.length,
      events,
    }
  }
  const predicted = model
    ? usable.map((s) => predictWith(model, s.features)).filter((p) => Number.isFinite(p))
    : []
  if (model && predicted.length !== usable.length) {
    return {
      verdict: 'not_measurable',
      reason: `${usable.length - predicted.length} of ${usable.length} months carry a non-finite feature, so the model will not score them and no divergence is computed over the remainder`,
      months: usable.length,
      events,
    }
  }
  const observed = events / usable.length
  const interval = wilsonInterval(events, usable.length)
  const meanPredicted = predicted.length ? predicted.reduce((a, b) => a + b, 0) / predicted.length : null

  // Without a model there is no predicted mean, and a comparison between the
  // observed rate and itself is not divergence. Report the observed rate, which
  // is a real measurement, and refuse the verdict.
  if (meanPredicted === null) {
    return {
      verdict: 'not_measurable',
      reason: 'no model was supplied, so there is no predicted mean to diverge from the observed rate',
      months: usable.length,
      events,
      observed_rate: Math.round(observed * 10000) / 10000,
      observed_rate_wilson: interval,
    }
  }
  const outside = meanPredicted < interval.low || meanPredicted > interval.high
  return {
    verdict: outside ? 'drift' : 'stable',
    reason: null,
    months: usable.length,
    events,
    mean_predicted: Math.round(meanPredicted * 10000) / 10000,
    observed_rate: Math.round(observed * 10000) / 10000,
    observed_rate_wilson: interval,
    gap: Math.round((observed - meanPredicted) * 10000) / 10000,
    direction: outside ? (observed > meanPredicted ? 'under_predicted' : 'over_predicted') : 'aligned',
  }
}

/** Logistic prediction, kept local so this module does not import the trainer. */
function predictWith(model, features = {}) {
  if (!model?.standardization) return null
  let z = Number(model.intercept)
  if (!Number.isFinite(z)) return null
  for (const st of model.standardization) {
    const value = Number(features?.[st.feature])
    if (!Number.isFinite(value)) return null
    const coefficient = model.coefficients?.find((c) => c.feature === st.feature)?.value
    if (!Number.isFinite(coefficient)) return null
    z += coefficient * ((value - st.mean) / st.sd)
  }
  const p = 1 / (1 + Math.exp(-z))
  return Number.isFinite(p) ? Math.round(p * 10000) / 10000 : null
}

/**
 * Both signals for one region, plus the record an operator would store.
 *
 * The two signals are combined conservatively: `drift` if either reports drift,
 * `watching` if either is watching, and `not_measurable` only when neither can
 * say. A region where input shift is measurable and divergence is not is
 * `drift` if the input moved — the absence of the second measurement is not
 * evidence of its absence of a finding, and is reported alongside.
 */
export function detectDrift({ region = null, referenceSamples = [], currentSamples = [], model = null } = {}) {
  const input = detectInputShift(referenceSamples, currentSamples)
  const divergence = detectOutcomeDivergence(currentSamples, model)
  const verdicts = [input.verdict, divergence.verdict]
  const verdict = verdicts.includes('drift') ? 'drift'
    : verdicts.includes('watching') ? 'watching'
      : verdicts.every((v) => v === 'not_measurable') ? 'not_measurable'
        : 'stable'
  const generated_at = new Date().toISOString()

  return {
    id: stableId('drift', [region ?? 'unknown', generated_at.slice(0, 10)]),
    type: 'model_drift',
    region_name: region,
    verdict,
    // Stated separately from `verdict` because "stable" and "not_measurable"
    // are different findings, and a reader who collapses them reads a refusal
    // as a clean bill of health.
    measurable: verdict !== 'not_measurable',
    generated_at,
    input_shift: input,
    outcome_divergence: divergence,
    basis: DRIFT_BASIS,
    uncertainty: uncertaintyTiers({
      coverage: [
        'cause: this detects that a relationship moved, not why, and the two signals call for different responses',
        'regions outside the windows compared, and regions with no window at all',
        'the future: nothing here forecasts whether drift will continue',
        'the drift thresholds themselves, which are conventions from the PSI literature rather than properties of this model',
      ],
    }),
    honesty: honestyEnvelope('drift_verdict', {
      value: verdict,
      basis: {
        description: `input PSI per feature (reference vs current) and mean predicted probability vs observed rate; floors of ${MIN_DRIFT_WINDOW_MONTHS} months per window and ${MIN_DRIFT_EVENTS} events in the current window`,
        sample: {
          reference_months: input.reference_months ?? null,
          current_months: input.current_months ?? input.months ?? null,
          observed_events: divergence.events ?? null,
        },
      },
      notIncluded: [
        'the cause of any change detected',
        'any refit: nothing here changes a coefficient, and a drifted model still returns its original predictions until retrained',
        'regions and windows not passed to this call',
      ],
      refused: [
        ...(input.verdict === 'not_measurable' && input.reason ? [input.reason] : []),
        ...(divergence.verdict === 'not_measurable' && divergence.reason ? [divergence.reason] : []),
        ...(verdict === 'not_measurable' ? ['no drift verdict is issued: this is an absence of measurement, and it is not a finding that the model has not drifted'] : []),
      ],
      evidence: { retrieved_at: generated_at },
    }),
  }
}

/**
 * Drift across every region that has both windows.
 *
 * A region with only one window appears in `not_measurable` with its reason
 * rather than being omitted: the list of regions whose drift state is unknown
 * is itself the operational finding, and dropping it makes a monitoring surface
 * look complete when it is empty because it could not be computed.
 */
export function driftReport({ regions = [] } = {}) {
  const records = regions.map((entry) => detectDrift(entry))
  return {
    generated_at: new Date().toISOString(),
    regions: records.length,
    drift: records.filter((r) => r.verdict === 'drift').length,
    watching: records.filter((r) => r.verdict === 'watching').length,
    stable: records.filter((r) => r.verdict === 'stable').length,
    not_measurable: records.filter((r) => r.verdict === 'not_measurable').length,
    records,
  }
}
