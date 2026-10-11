import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rankAlerts } from '../src/triage.js'

const NOW = '2026-10-11T05:00:00Z'

/**
 * Two hazards far enough apart that each captures only its own facility.
 *
 * `computePopulationAtRisk` uses a 25 km radius, so a fixture pair closer than
 * that would have both hazards claiming both clinics — which is a real property
 * of the impact model (see the overlap test below) but makes the attribution
 * assertions unreadable.
 */
function fixtures() {
  return {
    hazard_events: [
      { id: 'h1', event_type: 'flood', severity: 'high', latitude: 6.8, longitude: -1.5 },
      { id: 'h2', event_type: 'flood', severity: 'low', latitude: 8.5, longitude: -3.4 },
    ],
    service_assets: [
      { id: 'a1', name: 'Clinic A', latitude: 6.8, longitude: -1.5, population_served: 5000 },
      { id: 'a2', name: 'Clinic B', latitude: 8.5, longitude: -3.4, population_served: 300 },
    ],
  }
}

const openAlert = (over = {}) => ({
  id: 'e1',
  status: 'open',
  severity: 'high',
  value: 60,
  threshold: 50,
  created_at: '2026-10-11T00:00:00Z',
  location: { latitude: 6.8, longitude: -1.5 },
  derivation: { input_record_ids: ['h1'] },
  ...over,
})

describe('expected-value alert triage (ENH-69)', () => {
  it('ranks by severity x exposure, not by recency', () => {
    // The old ordering was `created_at`, which is the one ordering that carries
    // no information about what acting is worth. The newest alert here is the
    // least valuable to act on, and it must rank last.
    const data = {
      ...fixtures(),
      alert_events: [
        openAlert({ id: 'old-critical', severity: 'critical', created_at: '2026-10-11T00:00:00Z' }),
        openAlert({ id: 'new-low', severity: 'low', created_at: '2026-10-11T04:59:00Z', derivation: { input_record_ids: ['h1'] } }),
      ],
    }
    const { ranked } = rankAlerts(data, null, { now: NOW })
    assert.equal(ranked[0].id, 'old-critical', 'the critical alert over 5,000 people outranks a low one raised a minute ago')
    assert.equal(ranked[1].id, 'new-low')
    assert.ok(ranked[0].expected_loss > ranked[1].expected_loss)
  })

  it('takes exposure from the hazard the alert names, not from proximity', () => {
    const data = { ...fixtures(), alert_events: [openAlert({ derivation: { input_record_ids: ['h2'] } })] }
    const [entry] = rankAlerts(data, null, { now: NOW }).ranked
    assert.equal(entry.hazard_event_id, 'h2')
    assert.equal(entry.population_exposed, 300, 'the named hazard, not the nearer one')
    assert.equal(entry.exposure_basis, 'named_input_hazard')
  })

  it('falls back to the nearest scored hazard and says that it did', () => {
    const data = { ...fixtures(), alert_events: [openAlert({ derivation: {} })] }
    const [entry] = rankAlerts(data, null, { now: NOW }).ranked
    assert.equal(entry.hazard_event_id, 'h1')
    assert.equal(entry.exposure_basis, 'nearest_hazard', 'an attribution must be labelled as one')
  })

  it('ranks an unmeasured alert after the measured set rather than scoring it zero', () => {
    // Zero would place an unmeasured alert *below* a measured trivial one,
    // which is the wrong direction for missing data — the same rule the
    // absent-value class states everywhere else in this tree.
    const data = {
      ...fixtures(),
      alert_events: [
        openAlert({ id: 'unmeasured', severity: 'high', location: null, derivation: {} }),
        openAlert({ id: 'measured-trivial', severity: 'low', derivation: { input_record_ids: ['h2'] } }),
      ],
    }
    const result = rankAlerts(data, null, { now: NOW })
    assert.equal(result.unmeasured_exposure, 1)
    assert.equal(result.measured_exposure, 1)
    const unmeasured = result.ranked.find((e) => e.id === 'unmeasured')
    assert.equal(unmeasured.expected_loss, null, 'not zero')
    assert.equal(result.ranked[result.ranked.length - 1].id, 'unmeasured')
  })

  it('does not treat a hazard whose facilities recorded no population as a zero', () => {
    const data = {
      hazard_events: [{ id: 'h1', event_type: 'flood', latitude: 6.8, longitude: -1.5 }],
      // A facility with no `population_served`: it is still a facility somebody
      // must reach, and `computePopulationAtRisk` returns null rather than 0.
      service_assets: [{ id: 'a1', name: 'Clinic A', latitude: 6.8, longitude: -1.5 }],
      // Named, so the resolution is by identity and the basis reflects the
      // hazard being unmeasured rather than the attribution being a guess.
      alert_events: [openAlert()],
    }
    const [entry] = rankAlerts(data, null, { now: NOW }).ranked
    assert.equal(entry.population_exposed, null, 'nobody said is not zero people')
    assert.equal(entry.expected_loss, null, 'and no loss is computed from it')
  })

  it('labels a proximity attribution that landed on an unmeasured hazard', () => {
    const data = {
      hazard_events: [{ id: 'h1', event_type: 'flood', latitude: 6.8, longitude: -1.5 }],
      service_assets: [{ id: 'a1', name: 'Clinic A', latitude: 6.8, longitude: -1.5 }],
      alert_events: [openAlert({ derivation: {} })],
    }
    const [entry] = rankAlerts(data, null, { now: NOW }).ranked
    assert.equal(entry.exposure_basis, 'nearest_hazard_unmeasured')
  })

  it('states that the populations overlap and must not be summed', () => {
    // Two alerts about two hazards 2 km apart report the same facilities. The
    // ranks are unaffected; a total would be a population counted twice.
    const data = {
      ...fixtures(),
      alert_events: [
        openAlert({ id: 'e1', derivation: { input_record_ids: ['h1'] } }),
        openAlert({ id: 'e2', derivation: { input_record_ids: ['h1'] } }),
      ],
    }
    const result = rankAlerts(data, null, { now: NOW })
    assert.equal(result.ranked[0].population_exposed, result.ranked[1].population_exposed)
    assert.match(result.exposure_overlap, /not be summed/)
    assert.equal(result.population_total, undefined, 'no total is offered, deliberately')
  })

  it('says what the number is not', () => {
    const result = rankAlerts({ ...fixtures(), alert_events: [] }, null, { now: NOW })
    assert.match(result.method, /NOT an expected value/)
    assert.match(result.method, /no hazard probability and no cost per person/)
  })

  it('carries the arithmetic on every entry, including the gap', () => {
    const data = {
      ...fixtures(),
      alert_events: [
        openAlert({ id: 'measured' }),
        openAlert({ id: 'gap', location: null, derivation: {} }),
      ],
    }
    const { ranked } = rankAlerts(data, null, { now: NOW })
    assert.match(ranked.find((e) => e.id === 'measured').rationale, /× 5000 people exposed/)
    assert.match(ranked.find((e) => e.id === 'gap').rationale, /no measured exposure/)
  })

  it('ranks only open alerts by default and honours an explicit list', () => {
    const data = {
      ...fixtures(),
      alert_events: [openAlert({ id: 'open' }), openAlert({ id: 'resolved', status: 'resolved' })],
    }
    assert.deepEqual(rankAlerts(data, null, { now: NOW }).ranked.map((e) => e.id), ['open'])
    assert.equal(rankAlerts(data, data.alert_events, { now: NOW }).total, 2)
  })

  it('reads the same severity weights the alert engine stamps on the event', () => {
    // ARC-04: three implementations of the weight exist. This must be the one
    // the engine used, or the ranking and the event disagree about "high".
    const { ranked } = rankAlerts({ ...fixtures(), alert_events: [openAlert({ severity: 'critical' })] }, null, { now: NOW })
    assert.equal(ranked[0].severity_weight, 1)
    assert.equal(ranked[0].severity, 'critical')
  })
})
