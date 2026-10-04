#!/usr/bin/env node
/**
 * Honesty envelopes (ENH-02) and the three uncertainty tiers (ENH-04).
 *
 * The rule being pinned here: a number that is correct as computed and
 * misleading as read is a defect, and the cure is structural. Prose `limits`
 * strings existed and were good English, but a dashboard can drop a sentence
 * and no test can notice — a missing `limits` was invisible. Every numeric
 * record this module produces now carries an object a test can assert on, and
 * the three tiers are named by what they measure so the sensitivity band
 * (ADR-004: a fixed function of input coverage) cannot be mistaken for one of
 * them.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ENVELOPE_KINDS,
  calibrationReport,
  computeClimateConflictRisk,
  computeDataQuality,
  computeFloodRisk,
  computeServiceImpacts,
  effectiveSampleSize,
  honestyEnvelope,
  uncertaintyTiers,
} from '../src/analytics.js'

const now = () => new Date().toISOString()

const baseData = () => ({
  climate_observations: [{
    id: 'c1',
    source: 'open_meteo',
    region_name: 'Turkana',
    country: 'KE',
    latitude: 3.1167,
    longitude: 35.6,
    precipitation_mm: 20,
    precipitation_probability_pct: 60,
    observed_at: now(),
  }],
  hazard_events: [{
    id: 'h1',
    event_type: 'flood',
    severity: 'high',
    country: 'KE',
    latitude: 3.2,
    longitude: 35.7,
    occurred_at: now(),
  }],
  conflict_events: [],
  service_assets: [{
    id: 'a1',
    name: 'K Clinic',
    service_type: 'health',
    country: 'KE',
    latitude: 3.12,
    longitude: 35.6,
    population_served: 400,
  }],
  food_security_records: [],
  disease_observations: [],
  source_runs: [],
  risk_scores: [],
})

describe('honesty envelope', () => {
  it('states what the number is not, which is the field a consumer can check', () => {
    const envelope = honestyEnvelope('flood_risk_score', { value: 51 })
    assert.equal(envelope.value, 51)
    assert.equal(envelope.limits.kind, 'flood_risk_score')
    assert.match(envelope.limits.not, /not a probability of flooding/)
    assert.equal(envelope.limits.calibrated_uncertainty, false)
    assert.equal(envelope.limits.sample, null)
    assert.equal(envelope.refused.length, 0)
  })

  it('refuses an unknown kind rather than describing a number it cannot qualify', () => {
    // The envelope exists so a number states what it is not. A kind with no
    // registered `not` can only state half of that, and half an envelope reads
    // as a whole one.
    const envelope = honestyEnvelope('made_up_score', { value: 3 })
    assert.equal(envelope.value, null)
    assert.equal(envelope.limits.not, null)
    assert.equal(envelope.refused.length, 1)
    assert.match(envelope.refused[0], /unknown envelope kind/)
  })

  it('withholds a non-finite value instead of publishing it as null', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const envelope = honestyEnvelope('flood_risk_score', { value: bad })
      assert.equal(envelope.value, null, `${bad} is withheld, not published`)
      assert.match(envelope.refused[0], /not finite/)
    }
  })

  it('gives every declared kind a claim to negate, so no kind is decorative', () => {
    for (const [kind, not] of Object.entries(ENVELOPE_KINDS)) {
      assert.equal(typeof not, 'string')
      assert.ok(not.length > 20, `${kind} must say what it is not, in enough words to mean something`)
      assert.equal(honestyEnvelope(kind, { value: 1 }).limits.not, not)
    }
  })

  it('carries the evidence and the refusals beside the value', () => {
    const envelope = honestyEnvelope('trust_score', {
      value: 70,
      basis: { description: 'measured outcomes', sample: { alerts_resolved: 40 }, source_ids: ['a1'] },
      notIncluded: ['the future'],
      refused: ['nothing measurable yet'],
    })
    assert.equal(envelope.evidence.basis, 'measured outcomes')
    assert.deepEqual(envelope.evidence.source_ids, ['a1'])
    assert.deepEqual(envelope.limits.sample, { alerts_resolved: 40 })
    assert.deepEqual(envelope.not_included, ['the future'])
    assert.deepEqual(envelope.refused, ['nothing measurable yet'])
  })
})

describe('every numeric analytics record carries an envelope', () => {
  it('flood risk', () => {
    const [risk] = computeFloodRisk(baseData())
    assert.equal(risk.honesty.value, risk.score)
    assert.equal(risk.honesty.limits.kind, 'flood_risk_score')
    assert.equal(typeof risk.limits, 'string', 'the prose limits string is kept, not replaced')
    assert.ok(risk.limits.length > 0)
  })

  it('climate-conflict risk', () => {
    const [risk] = computeClimateConflictRisk(baseData())
    assert.equal(risk.honesty.value, risk.score)
    assert.equal(risk.honesty.limits.kind, 'climate_conflict_risk_score')
    assert.ok(risk.limits.includes('zero band means inputs were sufficient'))
  })

  it('service impact', () => {
    const scores = [...computeFloodRisk(baseData()), ...computeClimateConflictRisk(baseData())]
    const [impact] = computeServiceImpacts(baseData(), scores)
    assert.equal(impact.honesty.value, impact.impact_score)
    assert.equal(impact.honesty.limits.kind, 'service_impact_score')
  })

  it('data quality', () => {
    const [quality] = computeDataQuality(baseData())
    assert.equal(quality.honesty.value, quality.confidence)
    assert.equal(quality.honesty.limits.kind, 'data_quality_confidence')
  })

  it('calibration summary', () => {
    const [summary] = calibrationReport({
      risk_scores: [{ type: 'flood_risk', score: 40, confidence: 60, interval_width: 8 }],
    })
    assert.equal(summary.honesty.value, summary.mean_score)
    // brier_score stays null and the envelope says why, rather than the null
    // reading as a poor score.
    assert.equal(summary.brier_score, null)
    assert.match(summary.honesty.refused.join(' '), /withheld/)
  })

  it('an impact scored from outside the borrowing radius says so rather than reading as low risk', () => {
    const data = baseData()
    // The asset sits outside the operational area (RISK_SCOPE bounds it away),
    // so no region is scored at its own point and the nearest scored region —
    // Turkana, from the single climate observation — is ~900 km off. It falls
    // outside the 150 km borrowing radius and the hazard term contributes 0.
    // Above the radius that 0 is "no evidence nearby", not "no risk", and the
    // two used to be indistinguishable on the record.
    data.service_assets = [{ ...data.service_assets[0], latitude: 25.0, longitude: 10.0 }]
    const scores = [...computeFloodRisk(data), ...computeClimateConflictRisk(data)]
    const [impact] = computeServiceImpacts(data, scores)
    assert.equal(impact.impact_score, 0)
    assert.equal(impact.drivers.flood_risk_in_radius, false)
    assert.match(impact.honesty.refused.join(' '), /150 km borrowing radius/)
  })
})

describe('three tiers of uncertainty', () => {
  it('names each tier by what it measures, never by a scale word', () => {
    const tiers = uncertaintyTiers({ coverage: ['reporting bias'] })
    assert.deepEqual(Object.keys(tiers), ['model_parameter', 'sampling', 'coverage'])
    for (const [name, tier] of Object.entries(tiers)) {
      assert.ok(tier.measures.length > 20, `${name} must state what it measures`)
      assert.doesNotMatch(JSON.stringify(tier), /confidence interval|predictive interval/i)
    }
  })

  it('refuses the model tier for a number no fit underlies', () => {
    const tiers = uncertaintyTiers({})
    assert.match(tiers.model_parameter.refused, /no fit/)
    assert.equal(tiers.model_parameter.value, undefined)
    assert.match(tiers.sampling.refused, /no contingency counts/)
  })

  it('carries a measured tier through unchanged when one is supplied', () => {
    const tiers = uncertaintyTiers({ sampling: { interval: { low: 0.51, high: 0.72 }, effective_n: 41 } })
    assert.equal(tiers.sampling.interval.high, 0.72)
    assert.equal(tiers.sampling.effective_n, 41)
    assert.equal(tiers.sampling.refused, undefined)
  })

  it('keeps the sensitivity band outside the sampling tier', () => {
    // ADR-004. The band's width is a fixed function of input coverage, so
    // presenting it as the sampling tier would claim it measures the outcome
    // rate when it measures neither.
    const [risk] = computeFloodRisk(baseData())
    assert.equal(typeof risk.sensitivity_width, 'number')
    assert.equal(risk.uncertainty.sampling.interval, undefined)
    assert.ok(risk.uncertainty.coverage.not_represented.some((c) => /not a predictive interval/.test(c)))
  })

  it('always states the coverage tier, which is the one that is never absent', () => {
    const [risk] = computeClimateConflictRisk(baseData())
    assert.ok(risk.uncertainty.coverage.not_represented.length > 0)
    assert.match(risk.uncertainty.coverage.not_represented.join(' '), /causal direction/)
  })
})

describe('effective sample size for serially correlated months', () => {
  it('shrinks the sample when consecutive months share rainfall', () => {
    // Alternating labels have negative autocorrelation, so the corrected n can
    // exceed the raw n; it is clamped there. A run of consecutive positives is
    // the realistic case and must shrink.
    const clustered = [1, 1, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1]
    const effective = effectiveSampleSize(clustered)
    assert.ok(effective < clustered.length, `${effective} must be below the raw count of ${clustered.length}`)
    assert.ok(effective >= 3)
  })

  it('refuses a series too short to estimate a correlation from', () => {
    assert.equal(effectiveSampleSize([1, 0]), null)
    assert.equal(effectiveSampleSize([]), null)
    assert.equal(effectiveSampleSize([1, null, 0, 1]), null, 'non-binary entries are not counted as observations')
    assert.equal(effectiveSampleSize([1, 0.5, 0, 1]), null, 'a non-binary label is dropped, not coerced')
  })

  it('refuses a constant series rather than reporting zero correlation', () => {
    // Zero variance means an undefined correlation, not a correlation of zero.
    // Returning n here would put an uncorrected interval on a series whose
    // labels carry no contrast at all.
    assert.equal(effectiveSampleSize([0, 0, 0, 0, 0, 0]), null)
    assert.equal(effectiveSampleSize([1, 1, 1, 1]), null)
  })
})
