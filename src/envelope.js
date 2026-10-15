/**
 * R-77 — the honesty-envelope API, in a leaf module.
 *
 * `honestyEnvelope`, `uncertaintyTiers` and `ENVELOPE_KINDS` lived in
 * `src/analytics.js` and were imported back by `src/calibration.js:2` and
 * `src/drift.js:2`, which `analytics.js` imports in turn — two real cycles.
 * They resolved because every use is inside a function body and ESM defers the
 * link, which is what made them durable: nothing failed, so nothing pointed at
 * them.
 *
 * Nothing here imports anything. The envelope is pure structure over a value
 * the caller passes in, so moving it costs nothing. `src/analytics.js`
 * re-exports all three, so the existing importers — including
 * `test/honesty-envelope.test.js` — keep working unchanged.
 *
 * The comments below travel with their code because they are the reasoning for
 * each field, and a caveat with no reasoning behind it is the prose `limits`
 * string this API was built to replace.
 */
/**
 * Honesty envelopes (ENH-02).
 *
 * Every number this module returns used to travel with either nothing or one
 * prose `limits` string, and prose is the one form a machine cannot check: an
 * integrator reading the payload never sees the sentence, and a dashboard can
 * drop it silently. The envelope makes the caveat part of the value — what the
 * number is, what it is not, what it was computed from, and what it refuses to
 * say — so the caveat survives the trip through a consumer that knows nothing
 * about this repository.
 *
 * The prose `limits` strings stay. The envelope is structure, not a replacement
 * for the sentence, and each envelope restates the sentence's claim in a field
 * a test can assert on.
 */

/**
 * The kinds this module emits, with the claim each one is not entitled to make.
 *
 * A kind with no entry here is refused rather than described: an envelope whose
 * `not` is missing states what a number is without stating what it is not,
 * which is the failure the envelope exists to prevent.
 */
export const ENVELOPE_KINDS = Object.freeze({
  flood_risk_score: 'a weighted severity index over forecast rainfall, rain probability and nearby hazard reports — not a probability of flooding',
  climate_conflict_risk_score: 'a weighted sum of input counts and severities — not a probability of conflict or of any climate-driven outcome',
  service_impact_score: 'a blend of the two nearest region risk scores — not a forecast of service interruption and not an estimate of people affected',
  data_quality_confidence: 'a completeness heuristic over geocoding, record count, run status and record age — not an accuracy measurement of the underlying data',
  calibration_summary: 'an average over stored risk-score records — not a validation of the model behind them',
  trust_score: 'a weighted composite of measured alert outcome agreement, outcome sample size and outcome recording coverage — not a statement that alerts will be correct',
  drift_verdict: 'a comparison of two windows of the same series — not a diagnosis of the cause of a change',
  // ENH-56. The one kind whose claim is *stronger* than the others, and the one
  // whose limits are therefore spelled out harder: a joint rate over counted
  // months is a frequency, not a fitted dependence model, and consecutive months
  // share a season rather than being independent draws.
  compound_hazard_risk_score: 'a joint rate of a flood-month and a conflict-month meeting, counted over calendar months in one radius — not a fitted dependence model, not a probability of either hazard, and not independent of the season the window covers',
})

const BASIS_DOC = 'docs/flood-probability-model-basis.md'
const ENVELOPE_RETRIEVED_AT = () => new Date().toISOString()

/**
 * Build the envelope for one number.
 *
 * `basis` is the evidence the number was computed from; `refused` is what this
 * call declined to say and why. Both are structural, never prose: a refusal
 * that cannot be asserted on is a comment.
 *
 * Refuses — returns `value: null` and a reason rather than a number — when the
 * kind is unknown or the value is not finite. A NaN in an envelope is the same
 * defect as a NaN in the score, and JSON turns it into `null` on the way out
 * with nothing to mark it as a refusal.
 */
export function honestyEnvelope(kind, { value, basis = {}, refused = [], notIncluded = [], evidence = {} } = {}) {
  const claim = ENVELOPE_KINDS[kind]
  const reasons = [...refused]
  if (!claim) reasons.push(`unknown envelope kind "${kind}"; the envelope cannot state what a number of this kind is not`)
  if (value !== null && value !== undefined && !Number.isFinite(value)) reasons.push('value is not finite, so it is withheld rather than published as null')

  // Withheld unless the envelope can say both what the number is and what it is
  // not. A value travelling without the second half is the bare number this
  // envelope was added to stop.
  const publishable = Number.isFinite(value) && Boolean(claim)
  return {
    value: publishable ? value : null,
    limits: {
      kind: kind ?? null,
      not: claim ?? null,
      // Uniform on every record, and false: nothing in this module is
      // calibrated against observed outcomes except through src/calibration.js,
      // which says so on its own records.
      calibrated_uncertainty: false,
      sample: basis.sample ?? null,
    },
    evidence: {
      basis_doc: BASIS_DOC,
      basis: basis.description ?? null,
      source_ids: basis.source_ids ?? [],
      retrieved_at: evidence.retrieved_at ?? ENVELOPE_RETRIEVED_AT(),
    },
    not_included: notIncluded,
    refused: reasons,
  }
}

/**
 * Three tiers of uncertainty on one number (ENH-04), each named by what it
 * measures.
 *
 * The names are load-bearing. `confidence interval` is forbidden here because
 * it means something specific — a range over the posterior of the outcome — and
 * none of these three is that. A tier is either a measured spread with its
 * sample attached, or a refusal stating which tier is absent and why.
 *
 * - `model_parameter`: spread of the fitted coefficients across refits. Absent
 *   for any score that was never fitted, which is most of them.
 * - `sampling`: a Wilson interval on the contingency counts, reported with an
 *   effective n. The months are not independent — the trailing 90-day windows
 *   overlap, so consecutive months share most of their rainfall — and a Wilson
 *   interval computed on the raw count is narrower than the evidence supports.
 * - `coverage`: what the number does not represent, which is always present and
 *   never empty.
 */
export function uncertaintyTiers({ modelParameter = null, sampling = null, coverage = [] } = {}) {
  const tier = (measures, value, refusal) => (refusal
    ? { measures, refused: refusal }
    : { measures, ...value })
  return {
    model_parameter: tier(
      'dispersion of the fitted coefficients across refits of this model; absent for a score that is not a fitted model',
      modelParameter,
      modelParameter ? null : 'no fit underlies this number, so there is no parameter to be uncertain about',
    ),
    sampling: tier(
      'spread of the observed rate around its point estimate on the contingency counts, with an effective n corrected for serial correlation between months',
      sampling,
      sampling ? null : 'no contingency counts underlie this number, so there is no sample to put an interval around',
    ),
    coverage: {
      measures: 'the populations and effects this number does not represent',
      not_represented: Array.isArray(coverage) ? [...coverage] : [],
    },
  }
}
