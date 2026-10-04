import { clamp, stableId } from './utils.js'
import { honestyEnvelope } from './analytics.js'
import { MIN_EVENTS, MIN_MONTHS, MODEL_BASIS, wilsonInterval } from './flood-probability.js'

/**
 * Per-region calibration and a trust score (ENH-03).
 *
 * The platform's largest permanent unknown is `false_alert: null`. `src/alerts.js`
 * refuses to infer an outcome from a resolution note, which is right — but that
 * refusal was permanent: nothing ever joined an alert to what subsequently
 * happened and asked how often the system was wrong. So every district reported
 * "not yet measurable" forever, and a focal point had no way to check the claim
 * in README.md that this is decision support.
 *
 * This module performs that join, on two independent bodies of evidence:
 *
 * 1. **Alert outcomes** (`alert_events.false_alert`) — the system's own alerts,
 *    each resolved by a person into true or false. The false-alert rate per
 *    region with a Wilson interval on it.
 * 2. **Model skill** (`flood_probability_models.folds`) — how far the trained
 *    flood model sat from what it predicted on held-out years, read off the
 *    leave-one-year-out folds the basis document requires anyway.
 *
 * What it deliberately does NOT produce, because each was proposed and is a
 * different quantity wearing the same name:
 *
 * - **Not a calibration flag on the risk score.** The risk score's `confidence`
 *   is input coverage; an alert outcome rate measures dispatch quality. Clearing
 *   `calibrated_uncertainty` on the strength of one would make the score claim
 *   it was validated by a measurement of something else.
 * - **Not a false-alert rate from unjoined data.** An alert nobody resolved is
 *   unknown, not a miss. Unresolved alerts enter the coverage term of the trust
 *   score — where being unresolved *lowers* trust, which is the honest direction
 *   — and never the false-alert numerator.
 *
 * Refusals are the same discipline `flood-probability.js` applies: too few
 * observations, one class only, or a non-finite input all return a reason and
 * `null`, never a low score. A trust score of 12 for a district with four
 * resolved alerts would be a number with no footing, and would be read as a
 * measurement of that district rather than as an absence of one.
 */

/**
 * Minimum resolved alerts before a region's false-alert rate is reportable.
 *
 * Set where the Wilson interval at a plausible-looking rate stops being able to
 * distinguish a good region from a poor one. At 30 resolved alerts a 10% rate
 * carries roughly ±10 points of half-width; at 10 it carries ±20, which spans
 * the difference between "rarely wrong" and "half the time". Below that the
 * interval is honest and useless, and an honest useless interval presented as a
 * trust score is the failure this module exists to avoid.
 */
export const MIN_DETERMINED_ALERTS = 30

export const CALIBRATION_BASIS = Object.freeze({
  basis: 'measured agreement between what this system signalled and what a reviewer recorded afterwards, per region',
  outcome_source: 'alert_events.false_alert, recorded by an operator as true/false/null ("not determined")',
  interval: 'Wilson score interval at 95% on the resolved-alert count (src/flood-probability.js wilsonInterval)',
  model_skill_source: 'leave-one-year-out folds on the trained flood model card',
  what_a_trust_score_is_not: 'a probability that a future alert will be correct, and not a property of the risk score — it measures how often this system has been right where anyone recorded whether it was',
  inherited_rejection_reasons: MODEL_BASIS.rejection_reasons,
  inherited_floors: `model-side samples keep the model's own floors of ${MIN_MONTHS} months and ${MIN_EVENTS} flood months; nothing here lowers them`,
})

/**
 * Trust-score weights. Published here rather than inline so an operator can see
 * what the composite is made of: half of it is the measured rate, a third the
 * sample that rate rests on, a sixth the share of alerts anyone resolved at all.
 *
 * A well-calibrated system that nobody reviews scores badly, and that is the
 * intended reading — an unreviewed system's apparent accuracy is untested.
 */
const TRUST_WEIGHTS = Object.freeze({
  measured_rate: 0.5,
  sample_sufficiency: 0.3,
  outcome_coverage: 0.2,
})

const regionKey = (record) => record.region_name || record.district || record.scope?.district || record.country || 'unknown'

/**
 * Alert outcomes per region: false-alert rate with a Wilson interval, and the
 * recording coverage that says how much of the sample was ever reviewed.
 *
 * `resolved` counts alerts with a recorded determination. `false_alert: null`
 * and absent are the same thing here and are counted as `unresolved`: an
 * unrecorded outcome is an unknown, and folding it into either the numerator or
 * the denominator would state a rate the store cannot support.
 */
export function alertOutcomeCalibration(alerts = []) {
  const byRegion = new Map()
  for (const alert of alerts) {
    const key = regionKey(alert)
    if (!byRegion.has(key)) {
      byRegion.set(key, { region: key, raised: 0, resolved: 0, false_alerts: 0, resolved_true: 0, unresolved: 0 })
    }
    const row = byRegion.get(key)
    row.raised += 1
    const determination = alert.false_alert
    if (determination === true || determination === false) {
      row.resolved += 1
      if (determination) row.false_alerts += 1
      else row.resolved_true += 1
    } else {
      row.unresolved += 1
    }
  }

  const regions = []
  const refusals = []
  for (const row of byRegion.values()) {
    const refusal = alertOutcomeRefusal(row)
    const rate = refusal ? null : row.false_alerts / row.resolved
    regions.push({
      ...row,
      false_alert_rate: refusal ? null : Math.round(rate * 10000) / 10000,
      // Wilson on the resolved count only. Widening it over `raised` would
      // pretend the unresolved alerts were resolved and not-wrong.
      false_alert_rate_wilson: refusal ? null : wilsonInterval(row.false_alerts, row.resolved),
      outcome_coverage: row.raised > 0 ? Math.round((row.resolved / row.raised) * 10000) / 10000 : null,
      refusal: refusal?.reason ?? null,
    })
    if (refusal) refusals.push({ region: row.region, refusal: refusal.reason, resolved: row.resolved, raised: row.raised })
  }
  return { regions, refusals }
}

/**
 * Why this region's false-alert rate is not reportable.
 *
 * Three gates, each of which has produced a real wrong number when skipped:
 * too few resolved alerts (a rate off one alert moves 33 points), one class
 * only (every resolved alert marked false gives a confident 0% that says
 * nothing), and a non-finite determination that slipped past the boolean test.
 */
function alertOutcomeRefusal(row) {
  if (row.resolved < MIN_DETERMINED_ALERTS) {
    return { reason: `only ${row.resolved} resolved alert(s) of the ${MIN_DETERMINED_ALERTS} required; an unresolved alert is not a miss, so the rest cannot enter the rate` }
  }
  if (row.false_alerts === 0 || row.false_alerts === row.resolved) {
    return { reason: `every resolved alert in this region carries the same determination (${row.false_alerts} false, ${row.resolved - row.false_alerts} warranted); there is no contrast to measure a rate against` }
  }
  if (!Number.isFinite(row.false_alerts) || !Number.isFinite(row.resolved)) {
    return { reason: 'the resolved-alert counts are not finite, so no rate is computed' }
  }
  return null
}

/**
 * Model skill per region, read off the trained model card's held-out folds.
 *
 * This does not refit and it does not touch samples. The card already carries
 * the leave-one-year-out numbers the basis document requires on every trained
 * model; recomputing them here would risk a second implementation disagreeing
 * with the first. The card's own refusal — a district short of MIN_MONTHS or
 * MIN_EVENTS never gets a card at all — is inherited by simply having no row
 * to read, so nothing here can lower those floors.
 */
export function modelSkillCalibration(models = []) {
  const rows = []
  const refusals = []
  for (const card of models) {
    const training = card?.model?.training ?? {}
    const folds = card?.folds?.folds
    const region = card?.region_name ?? 'unknown'
    if (!folds) {
      refusals.push({ region, refusal: card?.folds?.refusal ?? 'this model card carries no leave-one-year-out folds, so no skill number is measurable' })
      continue
    }
    // The card's training facts are re-checked against the model's own floors.
    // A card whose training months fall below MIN_MONTHS would mean the trainer
    // regressed; treating its folds as evidence would import that regression
    // into a trust score.
    if (!Number.isFinite(training.months) || training.months < MIN_MONTHS) {
      refusals.push({ region, refusal: `model trained on ${training.months ?? 'an unstated number of'} months, below the model's own floor of ${MIN_MONTHS}` })
      continue
    }
    if (!Number.isFinite(training.flood_months) || training.flood_months < MIN_EVENTS) {
      refusals.push({ region, refusal: `model trained on ${training.flood_months ?? 'an unstated number of'} flood months, below the model's own floor of ${MIN_EVENTS}` })
      continue
    }
    if (!Number.isFinite(folds.skill_over_base_rate)) {
      refusals.push({ region, refusal: 'leave-one-year-out folds carry no finite skill number, so none is reported' })
      continue
    }
    rows.push({
      region,
      country: card.country ?? null,
      brier_score: folds.brier_score ?? null,
      brier_of_base_rate: folds.brier_of_base_rate ?? null,
      // Negative skill is the honest reading of "worse than always predicting
      // the base rate" and is preserved rather than clamped. A trust score that
      // consumed a clamped zero would read as "no better than chance" where the
      // model is in fact actively misleading.
      skill_over_base_rate: folds.skill_over_base_rate,
      validated_months: folds.validated_months ?? null,
      training_months: training.months,
      training_flood_months: training.flood_months,
      refusal: null,
    })
  }
  return { regions: rows, refusals }
}

/**
 * The trust score itself: 0-100, or null with a reason.
 *
 * Composed from three separately measurable terms, each reported alongside the
 * composite so a reader can see which one is weak rather than having to trust a
 * single number:
 *
 * - `measured_rate` — 1 minus the region's false-alert rate (or the model's
 *   held-out skill, mapped from [-1, 1] onto [0, 1], when no alert outcomes
 *   exist).
 * - `sample_sufficiency` — resolved alerts against MIN_DETERMINED_ALERTS, or
 *   validated months against MIN_MONTHS. Saturates at 1 rather than growing
 *   without bound, because a district with 300 resolved alerts is not six times
 *   as trustworthy as one with 50; the floor is where the interval stops
 *   discriminating, not where certainty arrives.
 * - `outcome_coverage` — resolved alerts over alerts raised. An unreviewed
 *   system scores badly here, which is the correct direction.
 *
 * Returns null unless every term is measurable. A composite with one missing
 * term would be scored as though the missing term were zero, and zero is a
 * measured value meaning "always wrong".
 */
export function trustScore({ measuredRate = null, sampleAdequacy = null, outcomeCoverage = null } = {}) {
  const terms = { measured_rate: measuredRate, sample_sufficiency: sampleAdequacy, outcome_coverage: outcomeCoverage }
  const missing = Object.entries(terms).filter(([, value]) => value === null || !Number.isFinite(value))
  if (missing.length) {
    return {
      score: null,
      terms: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null])),
      refusal: `no trust score: ${missing.map(([k]) => k).join(', ')} not measurable`,
    }
  }
  const score = clamp(Math.round(
    TRUST_WEIGHTS.measured_rate * measuredRate * 100
    + TRUST_WEIGHTS.sample_sufficiency * sampleAdequacy * 100
    + TRUST_WEIGHTS.outcome_coverage * outcomeCoverage * 100,
  ), 0, 100)
  return {
    score,
    terms: {
      measured_rate: Math.round(measuredRate * 10000) / 10000,
      sample_sufficiency: Math.round(sampleAdequacy * 10000) / 10000,
      outcome_coverage: Math.round(outcomeCoverage * 10000) / 10000,
    },
    weights: TRUST_WEIGHTS,
    refusal: null,
  }
}

/**
 * Every region's calibration and trust score, in one pass.
 *
 * Both evidence sources are joined on region name and reported side by side.
 * Where a region has no resolved alerts, model skill is used for the measured
 * term instead — a different measurement, which is why the row says which basis
 * produced the score. Where neither exists the region gets `trust_score: null`
 * and the reason, which is the correct output and the one most likely to be
 * wanted.
 */
export function calibrationByRegion(data = {}) {
  const alertRows = alertOutcomeCalibration(data.alert_events || []).regions
  const modelRows = modelSkillCalibration(data.flood_probability_models || []).regions
  const modelsByRegion = new Map(modelRows.map((row) => [row.region, row]))

  return alertRows.map((row) => {
    const model = modelsByRegion.get(row.region) ?? null
    const measuredRate = row.false_alert_rate !== null
      ? 1 - row.false_alert_rate
      : model
        // Held-out skill over the base rate, in [-1, 1], mapped onto [0, 1]. A
        // model worse than the base rate lands below 0.5 rather than being
        // clamped to it.
        ? clamp((model.skill_over_base_rate + 1) / 2, 0, 1)
        : null
    const sampleAdequacy = row.false_alert_rate !== null
      ? clamp(row.resolved / MIN_DETERMINED_ALERTS, 0, 1)
      : model
        ? clamp((model.validated_months ?? 0) / MIN_MONTHS, 0, 1)
        : null
    const outcomeCoverage = row.outcome_coverage
    const trust = trustScore({ measuredRate, sampleAdequacy, outcomeCoverage })

    return {
      id: stableId('trust', [row.region]),
      type: 'region_trust',
      region_name: row.region,
      generated_at: new Date().toISOString(),
      alerts_raised: row.raised,
      alerts_resolved: row.resolved,
      alerts_unresolved: row.unresolved,
      false_alert_rate: row.false_alert_rate,
      false_alert_rate_wilson: row.false_alert_rate_wilson,
      outcome_coverage: outcomeCoverage,
      false_alert_refusal: row.refusal,
      model_skill: model,
      trust_score: trust.score,
      trust_terms: trust.terms,
      trust_weights: trust.weights ?? TRUST_WEIGHTS,
      trust_refusal: trust.refusal,
      basis: measuredRate !== null && row.false_alert_rate !== null
        ? 'measured_rate from resolved alert outcomes'
        : model
          ? 'measured_rate from the model\'s leave-one-year-out skill; no alert outcomes are recorded for this region'
          : 'no measured rate available',
      honesty: honestyEnvelope('trust_score', {
        value: trust.score,
        basis: {
          description: `${TRUST_WEIGHTS.measured_rate} x measured rate + ${TRUST_WEIGHTS.sample_sufficiency} x sample sufficiency + ${TRUST_WEIGHTS.outcome_coverage} x outcome coverage, from ${row.resolved} resolved alert(s) of ${row.raised} raised`,
          sample: {
            alerts_raised: row.raised,
            alerts_resolved: row.resolved,
            alerts_unresolved: row.unresolved,
            model_validated_months: model?.validated_months ?? null,
            minimum_resolved_alerts: MIN_DETERMINED_ALERTS,
          },
        },
        notIncluded: [
          'the probability that a future alert will be correct: this is a backward-looking rate over resolved alerts',
          'anything about the risk score itself, which is an input-coverage number and is not validated by alert outcomes',
          'alerts nobody resolved, which lower the coverage term and never enter the rate',
        ],
        refused: [
          ...(row.refusal ? [row.refusal] : []),
          ...(trust.refusal ? [trust.refusal] : []),
        ],
      }),
    }
  })
}
