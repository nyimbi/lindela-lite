#!/usr/bin/env node
/**
 * ENH-19 — record provenance.
 *
 * The tests are about what the payload is *allowed to claim*. An explanation that
 * reads fluently and quietly substitutes a number it does not have is worse than
 * one that says "I cannot recompute this", because the fluency is what gets the
 * reader's trust. So the assertions here are mostly refusals: refuses to invent a
 * sum from a count, refuses to report a self-check it could not run, refuses to
 * collapse a missing input into a zero, and fails loudly when the transcribed
 * rules drift from `src/analytics.js`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  SCORING_RULES, SEVERITY_WEIGHT, checkRuleDrift, explainRecord, rulesFor,
} from '../public/shared/viz-explain.js'

const analyticsSource = readFileSync(new URL('../src/analytics.js', import.meta.url), 'utf8')

const floodRisk = (over = {}) => ({
  id: 'risk-flood-kisumu',
  type: 'flood_risk',
  region_name: 'Kisumu',
  country: 'Kenya',
  latitude: -0.0917,
  longitude: 34.768,
  score: 75,
  sensitivity_low: 60,
  sensitivity_mid: 75,
  sensitivity_high: 90,
  sensitivity_width: 30,
  calibrated_uncertainty: false,
  confidence: 100,
  generated_at: '2026-03-05T00:00:00.000Z',
  methodology: 'Transparent baseline.',
  drivers: {
    precipitation_mm: 20,
    precipitation_probability_pct: 60,
    climate_observations_in_scope: 12,
    missing_precipitation_records: 0,
    missing_probability_records: 2,
    flood_hazard_events: 3,
  },
  limits: 'Rainfall intensity to flood probability is not modelled.',
  ...over,
})

const conflictRisk = (over = {}) => ({
  id: 'risk-conflict-kisumu',
  type: 'climate_conflict_risk',
  region_name: 'Kisumu',
  score: 62,
  sensitivity_low: 50,
  sensitivity_mid: 62,
  sensitivity_high: 74,
  sensitivity_width: 24,
  calibrated_uncertainty: false,
  confidence: 100,
  drivers: { climate_observations: 10, hazard_events: 4, conflict_events: 6, nearby_service_assets: 3 },
  ...over,
})

describe('the rules have not drifted from the code that computes the score', () => {
  it('finds every scoring expression verbatim in analytics.js', () => {
    // An explanation is a claim about code this module does not run. A weight
    // retuned on one side only is the failure, and nothing else in the suite
    // would catch it.
    assert.deepEqual(checkRuleDrift(analyticsSource), [])
  })

  it('reports drift when an expression moves', () => {
    const drifts = checkRuleDrift(analyticsSource.replace('precipitation * 1.5', 'precipitation * 2.5'))
    assert.equal(drifts.length, 1)
    assert.match(drifts[0], /flood_risk/)
  })

  it('reports drift when a cap is retuned on one side only', () => {
    const drifts = checkRuleDrift(analyticsSource.replace('Math.min(35,', 'Math.min(40,'))
    assert.ok(drifts.some((d) => /Climate pressure: cap 35/.test(d)), drifts.join('\n'))
  })

  it('reports drift when a record type is dropped', () => {
    const drifts = checkRuleDrift(analyticsSource.replace("type: 'flood_risk'", "type: 'flood_risk_v2'"))
    assert.ok(drifts.some((d) => /no longer emits/.test(d)))
  })

  it('has a rule for every risk type analytics.js emits', () => {
    assert.ok(rulesFor(floodRisk()))
    assert.ok(rulesFor(conflictRisk()))
    assert.equal(rulesFor({ type: 'service_impact' }), null)
  })

  it('transcribes the severity weights rather than inventing a scale', () => {
    // `severityWeight` in `src/schema.js`: critical 1, high 0.78, medium 0.52,
    // low 0.25. A different ladder would make every hazard term wrong.
    assert.equal(SEVERITY_WEIGHT.critical, 1)
    assert.equal(SEVERITY_WEIGHT.high, 0.78)
    assert.equal(SEVERITY_WEIGHT.medium, 0.52)
    assert.equal(SEVERITY_WEIGHT.low, 0.25)
    const schema = readFileSync(new URL('../src/schema.js', import.meta.url), 'utf8')
    for (const [severity, weight] of Object.entries(SEVERITY_WEIGHT)) {
      assert.ok(schema.includes(`${severity}: ${weight}`), `${severity}: ${weight} not in schema.js`)
    }
  })
})

describe('the explanation is an equation a reader can check', () => {
  it('recomputes the linear terms and states the sum', () => {
    const e = explainRecord(floodRisk())
    // precipitation_mm 20 x 1.5 = 30; probability 60 x 0.35 = 21. The hazard
    // term is `sum(severityWeight x 30)` over three events and cannot be
    // recovered from a count.
    const precip = e.terms.find((t) => t.name === 'Precipitation')
    assert.equal(precip.contribution, 30)
    assert.equal(precip.recomputable, true)
    assert.match(precip.note, /20 x 1.5/)
    const prob = e.terms.find((t) => t.name === 'Rain probability')
    assert.equal(prob.contribution, 21)
    assert.equal(e.computed, 51)
  })

  it('says which part of the score it could not reproduce, rather than filling the gap', () => {
    const e = explainRecord(floodRisk())
    const hazard = e.terms.find((t) => t.name === 'Hazard pressure')
    assert.equal(hazard.contribution, null)
    assert.equal(hazard.recomputable, false)
    assert.equal(hazard.contributing, true, 'it does contribute; the magnitude is what is unknown')
    // `count x 30` would be a number with no computation behind it, and it would
    // look exactly like a real one.
    assert.match(hazard.note, /needs the severity of each event/)
    assert.match(hazard.note, /cannot be recomputed from this record alone/)
    assert.match(e.equation, /not recomputable from this record/)
  })

  it('does not claim the sum is the score when it cannot check it', () => {
    const e = explainRecord(floodRisk())
    // Three-state: `false` would say "checked and wrong", `true` would say
    // "checked and agreed". Neither is true when two of three terms are unknown.
    assert.equal(e.consistent, null)
    assert.equal(e.score, 75)
    assert.equal(e.computed, 51)
  })

  it('reports the disagreement when the record\'s score does not match its terms', () => {
    // Every term has to be recoverable for the check to mean anything, so the
    // hazard count is zero: a sum over no events is zero, whatever the
    // per-event weight is.
    const drivers = {
      precipitation_mm: 20, precipitation_probability_pct: 60, flood_hazard_events: 0,
      climate_observations_in_scope: 12, missing_precipitation_records: 0, missing_probability_records: 2,
    }
    const agree = explainRecord(floodRisk({ drivers, score: 51 }))
    assert.equal(agree.computed, 51)
    assert.equal(agree.consistent, true)
    const stale = explainRecord(floodRisk({ drivers, score: 90 }))
    assert.equal(stale.consistent, false)
    // Both numbers travel; the payload does not pick the prettier one.
    assert.equal(stale.score, 90)
    assert.equal(stale.computed, 51)
    assert.match(stale.caption, /disagree/)
  })

  it('cites the record\'s own limits alongside the rule\'s', () => {
    const e = explainRecord(floodRisk())
    assert.ok(e.limits.some((l) => l.includes('Rainfall intensity to flood probability is not modelled')))
  })
})

describe('an absent input contributes nothing and is named', () => {
  it('reports a missing driver as missing, not as a zero reading', () => {
    const e = explainRecord(floodRisk({ drivers: { flood_hazard_events: 0 } }))
    // `0` and absent are different answers: the first means "we looked and there
    // were none", the second means "nobody looked".
    assert.equal(e.missing.length, 2)
    assert.deepEqual(e.missing.map((m) => m.key).sort(), ['precipitation_mm', 'precipitation_probability_pct'])
    assert.ok(e.missing.every((m) => /not reported on this record/.test(m.reason)))
    assert.match(e.caption, /may understate the risk rather than describe it/)
  })

  it('distinguishes a reported null from an absent key', () => {
    const e = explainRecord(floodRisk({
      drivers: { precipitation_mm: null, precipitation_probability_pct: 60, flood_hazard_events: 0 },
    }))
    assert.equal(e.missing.length, 1)
    assert.equal(e.missing[0].key, 'precipitation_mm')
    assert.match(e.missing[0].reason, /reported as null/)
  })

  it('keeps a zero that really is a zero', () => {
    const e = explainRecord(floodRisk({ drivers: { precipitation_mm: 0, precipitation_probability_pct: 0, flood_hazard_events: 0 } }))
    // The falsy-zero defect class: 0 must not become null here, or a genuinely
    // dry month reads as an unreadable one.
    assert.equal(e.missing.length, 0)
    assert.equal(e.terms.find((t) => t.name === 'Precipitation').contribution, 0)
    assert.match(e.equation, /No contributing term could be recovered/)
  })

  it('does not count a zero-count term as contributing', () => {
    const e = explainRecord(floodRisk({ drivers: { precipitation_mm: 0, precipitation_probability_pct: 60, flood_hazard_events: 0 } }))
    const hazard = e.terms.find((t) => t.name === 'Hazard pressure')
    assert.equal(hazard.contributing, false)
  })
})

describe('the coverage number is not a sample size', () => {
  it('recomputes confidence from presence, not quantity', () => {
    const e = explainRecord(floodRisk())
    // 45 (observations carrying a rainfall reading) + 40 (hazards) + 15
    // (observations carrying a probability) = 100. Note the third part is
    // awarded on 12 - 2 = 10 *present* forecasts, not on 12 in-scope records.
    assert.equal(e.confidence.parts.length, 3)
    assert.deepEqual(e.confidence.parts.map((p) => p.count), [12, 3, 10])
    assert.equal(e.confidence.consistent, true)
    assert.equal(e.confidence.recomputed, 100)
  })

  it('says in the payload that one record earns the same points as four hundred', () => {
    const e = explainRecord(floodRisk())
    assert.match(e.confidence.statement, /not a sample size/)
    assert.match(e.confidence.statement, /same 45 points as four hundred/)
    assert.match(e.confidence.statement, /sensitivity band width is drawn from/)
  })

  it('credits rainfall only for observations that carried a reading', () => {
    // The bug `src/analytics.js` documents: CHIRPS records carry
    // `precipitation_mm: null` by construction, so counting in-scope records
    // would award full coverage credit for observations that contributed nothing.
    const e = explainRecord(floodRisk({
      drivers: {
        precipitation_mm: 10, precipitation_probability_pct: 60,
        climate_observations_in_scope: 12, missing_precipitation_records: 12,
        missing_probability_records: 0, flood_hazard_events: 1,
      },
      confidence: 55,
    }))
    const rainfall = e.confidence.parts[0]
    assert.equal(rainfall.count, 0, '12 in scope minus 12 missing is zero observations with rainfall')
    assert.equal(rainfall.awarded, false)
    assert.equal(e.confidence.recomputed, 55)
  })

  it('reports the confidence check as not run when a count could not be read', () => {
    // Agreement would be luck, not proof: an unreadable part might have earned
    // its points.
    const e = explainRecord(floodRisk({ drivers: { precipitation_mm: 20 } }))
    assert.equal(e.confidence.consistent, null)
  })
})

describe('the band is described as a sensitivity band wherever it appears', () => {
  it('repeats the ADR-004 statement in the payload', () => {
    const e = explainRecord(floodRisk())
    assert.equal(e.band.basis, 'sensitivity')
    assert.equal(e.band.calibrated, false)
    assert.match(e.band.statement, /Not a confidence interval/)
    assert.match(e.caption, /sensitivity band over input coverage, not a probability/)
  })

  it('reads the retained aliases when the ADR-004 names are absent', () => {
    const e = explainRecord(floodRisk({
      sensitivity_low: undefined, sensitivity_mid: undefined, sensitivity_high: undefined,
      sensitivity_width: undefined,
      score_p10: 60, score_p50: 75, score_p90: 90, interval_width: 30,
    }))
    assert.equal(e.band.low, 60)
    assert.equal(e.band.width, 30)
  })

  it('says a zero-width band means the inputs sufficed', () => {
    const e = explainRecord(floodRisk({
      sensitivity_low: 75, sensitivity_high: 75, sensitivity_width: 0,
      score_p10: 75, score_p90: 75, interval_width: 0,
    }))
    assert.equal(e.band.width, 0)
    assert.match(e.band.statement, /inputs were sufficient/)
  })
})

describe('saturation is stated, not silently applied', () => {
  it('names the cap when a term hits it', () => {
    const e = explainRecord(conflictRisk())
    const assets = e.terms.find((t) => t.name === 'Service exposure')
    assert.equal(assets.cap, 10)
    assert.equal(assets.contribution, 4.5, '3 assets x 1.5')
    assert.equal(assets.saturated, false)
    assert.equal(assets.recomputable, true, 'a capped linear term is still recomputable')
    // The first three are `Math.min(cap, …)` over a sum of source records, so
    // a count is not enough to recompute any of them.
    assert.ok(e.terms.slice(0, 3).every((t) => t.recomputable === false))
    assert.equal(e.consistent, null, 'four of four terms, three unrecoverable')
    assert.match(e.terms[1].note, /capped at 25/)
  })

  it('reports the cap as the source has it', () => {
    assert.equal(SCORING_RULES.climate_conflict_risk.terms[0].cap, 35)
    assert.equal(SCORING_RULES.climate_conflict_risk.terms[1].cap, 25)
    assert.equal(SCORING_RULES.climate_conflict_risk.terms[2].cap, 30)
    assert.equal(SCORING_RULES.climate_conflict_risk.terms[3].cap, 10)
  })
})

describe('an unknown record type gets the honest minimum', () => {
  it('says no rule is registered rather than inventing a breakdown', () => {
    const e = explainRecord({ id: 'x', type: 'service_impact', score: 30, drivers: { nearest_flood_risk_km: 12 } })
    assert.equal(e.known, false)
    assert.deepEqual(e.terms, [])
    assert.match(e.equation, /No scoring rule is registered/)
    assert.match(e.caption, /no registered scoring rule/)
    // The drivers it does carry are still listed.
    assert.equal(e.inputs.length, 1)
    assert.equal(e.inputs[0].key, 'nearest_flood_risk_km')
  })

  it('refuses a non-object outright', () => {
    assert.throws(() => explainRecord(null), /needs a record object/)
    assert.throws(() => explainRecord('risk-flood-abc'), /needs a record object/)
  })
})

describe('the chain reaches the source records when the caller supplies a lookup', () => {
  it('attaches the ids behind a count', () => {
    const hazards = [
      { id: 'hazard-1', severity: 'high', event_time: '2026-02-01T00:00:00Z' },
      { id: 'hazard-2', severity: 'low', event_time: '2026-02-03T00:00:00Z' },
    ]
    const e = explainRecord(floodRisk(), { lookup: (kind) => (kind === 'hazard_events' ? hazards : []) })
    const hazard = e.terms.find((t) => t.name === 'Hazard pressure')
    assert.equal(hazard.sources.length, 2)
    assert.equal(hazard.sources[0].id, 'hazard-1')
    assert.equal(hazard.sources[0].severity, 'high')
  })

  it('still explains the arithmetic with no lookup at all', () => {
    // The arithmetic explanation has to be complete even when the source
    // records are not in hand.
    const e = explainRecord(floodRisk())
    assert.equal(e.terms.find((t) => t.name === 'Precipitation').contribution, 30)
    assert.deepEqual(e.terms.find((t) => t.name === 'Hazard pressure').sources, [])
  })

  it('survives a lookup that throws, rather than failing the explanation', () => {
    const e = explainRecord(floodRisk(), {
      lookup: () => { throw new Error('database down') },
    })
    assert.equal(e.known, true)
    assert.deepEqual(e.terms.find((t) => t.name === 'Hazard pressure').sources, [])
  })
})

describe('the payload is serialisable and says where the record came from', () => {
  it('survives a JSON round trip unchanged', () => {
    const e = explainRecord(floodRisk())
    // This object goes over an HTTP route and into a DOM. A field that cannot be
    // serialised is a field the drill-down silently drops.
    assert.deepEqual(JSON.parse(JSON.stringify(e)), e)
  })

  it('carries provenance without inventing a location', () => {
    assert.equal(explainRecord(floodRisk()).provenance.location.lat, -0.0917)
    assert.equal(explainRecord(floodRisk()).provenance.generated_at, '2026-03-05T00:00:00.000Z')
    assert.equal(explainRecord(floodRisk({ latitude: null })).provenance.location, null)
  })

  it('titles the payload with the region a reader was looking at', () => {
    assert.match(explainRecord(floodRisk()).title, /Kisumu/)
  })
})