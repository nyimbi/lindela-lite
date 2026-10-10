#!/usr/bin/env node
/**
 * The second veracity batch: four numbers that described something other than
 * what they were named.
 *
 * VER-04  the quarterly signal-to-dispatch median was computed over the whole
 *         store, so a good current quarter was masked by years of slower
 *         history and a bad one was diluted by it.
 * VER-08  input shift reported `stable` with `worst_psi: 0` when no feature
 *         could be measured at all — an absence of measurement published as a
 *         clean bill of health.
 * VER-09  `recipient_count` (a head count) was folded into the distinct
 *         destination set, so one broadcast to 500 people counted as one
 *         destination named "500".
 * VER-12  an asset outside every risk radius reported confidence 0, which reads
 *         as "certain the risk is zero" rather than "no risk reading".
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { computeQuarterlyKpi } from '../src/kpi.js'
import { detectInputShift } from '../src/drift.js'
import { computeMetric } from '../src/analytics/metrics.js'
import { computeServiceImpacts } from '../src/analytics.js'
import { MIN_ENSEMBLES_FOR_SPREAD_SKILL, spreadSkillIndex } from '../src/analytics/ensemble.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('VER-04 quarterly signal-to-dispatch median is scoped to its period', () => {
  const dispatch = (id, sentAt, matchedAt) => ({ id, sent_at: sentAt, matched_signal_at: matchedAt })
  const base = {
    field_reports: [], alert_events: [], hazard_events: [],
    interventions: [], workflow_instances: [], report_templates: [],
  }

  it('ignores dispatches outside the quarter', () => {
    // One sub-hour dispatch this quarter, one ten-hour dispatch two years
    // earlier. Over the whole store the median is 5.5 hours and the quarter's
    // own performance is invisible; over the quarter it is the 1 hour it was.
    const data = {
      ...base,
      rapidpro_dispatches: [
        dispatch('in', '2026-08-01T01:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        dispatch('out', '2024-01-01T10:00:00.000Z', '2024-01-01T00:00:00.000Z'),
      ],
    }
    const kpi = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.warning_to_action_median_hours, 1)
  })

  it('reports null when the quarter has no measurable dispatch, rather than borrowing history', () => {
    const data = {
      ...base,
      rapidpro_dispatches: [dispatch('out', '2024-01-01T10:00:00.000Z', '2024-01-01T00:00:00.000Z')],
    }
    const kpi = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.warning_to_action_median_hours, null)
  })
})

describe('VER-08 input shift refuses rather than reporting stable with nothing measured', () => {
  const emptyFeatures = (count) => Array.from({ length: count }, (_, i) => ({
    month: `20${String(10 + Math.floor(i / 12)).slice(-2)}-${String((i % 12) + 1).padStart(2, '0')}`,
    features: {},
  }))

  it('is not_measurable with a null worst_psi when no feature carried a value', () => {
    const result = detectInputShift(emptyFeatures(40), emptyFeatures(40))
    assert.equal(result.verdict, 'not_measurable')
    assert.equal(result.worst_psi, null)
    assert.match(result.reason, /no feature carried a measurable value/)
    // Each feature says the same thing; the roll-up must not contradict them.
    assert.equal(result.features.max_7_day.verdict, 'not_measurable')
  })

  it('still reports stable when the features were measured and did not move', () => {
    const flat = (count) => Array.from({ length: count }, (_, i) => ({
      month: `20${String(10 + Math.floor(i / 12)).slice(-2)}-${String((i % 12) + 1).padStart(2, '0')}`,
      features: { max_7_day: 50 + (i % 7), sum_30_day: 200 + (i % 11), sum_90_day: 500 },
    }))
    const result = detectInputShift(flat(40), flat(40))
    assert.equal(result.verdict, 'stable')
    assert.equal(typeof result.worst_psi, 'number')
  })
})

describe('VER-09 a head count is not a destination', () => {
  const sent = { id: 'd1', sent_at: '2026-08-01T00:00:00.000Z', status: 'sent' }

  it('does not count recipient_count as a destination', () => {
    const metric = computeMetric('people_reached', { dispatches: [{ ...sent, recipient_count: 500 }] })
    assert.equal(metric.distinct_destinations, null, 'no address in the payload is null, not the number 500')
    assert.equal(metric.sends, 1)
  })

  it('still counts a real address', () => {
    const metric = computeMetric('people_reached', {
      dispatches: [{ ...sent, id: 'd1', phone: '+254700000001' }, { ...sent, id: 'd2', phone: '+254700000002' }],
    })
    assert.equal(metric.distinct_destinations, 2)
  })
})

describe('VER-12 service-impact confidence is absent, not zero, without a reading', () => {
  const asset = { id: 'a1', name: 'Clinic A', service_type: 'health', country: 'KE', latitude: 3.13, longitude: 35.63 }
  const risk = (type, confidence, latitude = 3.13, longitude = 35.63) => ({
    id: `r-${type}`, type, latitude, longitude, score: 60, confidence, region_name: 'Turkana',
  })

  it('renormalises over the regions that actually contributed', () => {
    // Flood in radius at confidence 80, no conflict region at all. The old
    // expression returned round(80 * 0.55 + 0 * 0.45) = 44, halving a
    // confidence that had one input, not two.
    const [impact] = computeServiceImpacts({ service_assets: [asset] }, [risk('flood_risk', 80)])
    assert.equal(impact.confidence, 80)
  })

  it('is null when no scored region is in borrowing radius', () => {
    // 3 degrees of latitude is ~330 km, well beyond the 150 km radius.
    const [impact] = computeServiceImpacts({ service_assets: [asset] }, [risk('flood_risk', 90, 6.13, 35.63)])
    assert.equal(impact.confidence, null)
  })

  it('is null with no risk scores at all', () => {
    const [impact] = computeServiceImpacts({ service_assets: [asset] }, [])
    assert.equal(impact.confidence, null)
  })

  it('weights two contributing regions by their own weights', () => {
    const [impact] = computeServiceImpacts({ service_assets: [asset] }, [
      risk('flood_risk', 100), risk('climate_conflict_risk', 0),
    ])
    assert.equal(impact.confidence, 55)
  })
})

describe('VER-10 the spread-skill floor matches the sentence describing it', () => {
  const ensemble = (id, p50, members) => ({
    id, ensemble_p50: p50, ensemble_p90: p50, ensemble_members: members.map((value) => ({ value })),
  })

  it('refuses two ensembles, which the doc comment called the floor', () => {
    const records = [ensemble('e1', 100, [90, 110]), ensemble('e2', 120, [100, 140])]
    assert.equal(spreadSkillIndex(records), null)
  })

  it('reports once the count reaches the constant', () => {
    const records = [
      ensemble('e1', 100, [90, 110]),
      ensemble('e2', 120, [100, 140]),
      ensemble('e3', 110, [105, 115]),
    ]
    assert.ok(spreadSkillIndex(records) !== null)
  })

  it('states the same number in the source comment as in the constant', () => {
    // The comment said "two" and the constant said 3. Nothing executes a
    // comment, so the only thing that can hold them together is reading both.
    const source = fs.readFileSync(path.join(ROOT, 'src/analytics/ensemble.js'), 'utf8')
    const doc = /Ensembles needed before a spread-skill index is reportable\.([\s\S]*?)\*\//.exec(source)
    assert.ok(doc, 'the doc comment above the constant moved; this check is looking in the wrong place')
    // The opening claim only: `Two is the smallest count at which ...`. Later
    // sentences discuss both numbers on purpose.
    const words = { two: 2, three: 3, four: 4, five: 5 }
    const opening = /^\s*\*\s*(\w+) is the smallest count/m.exec(doc[1])
    assert.ok(opening, 'the doc comment no longer opens with a count in words')
    const stated = words[opening[1].toLowerCase()]
    assert.ok(stated, `the opening word "${opening[1]}" is not a count this check knows`)
    assert.equal(stated, MIN_ENSEMBLES_FOR_SPREAD_SKILL,
      `the comment says ${opening[1]}, the constant is ${MIN_ENSEMBLES_FOR_SPREAD_SKILL}`)
  })
})
