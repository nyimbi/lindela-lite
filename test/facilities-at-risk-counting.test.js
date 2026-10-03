import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeFacilitiesAtRisk } from '../src/analytics/impact.js'

/**
 * DATA-03 — `at_risk_count` is named for facilities, so it has to count
 * facilities.
 *
 * The shape of the bug was the loop, not the arithmetic. Hazards on the outside,
 * assets on the inside: the accumulator was written inside the asset loop, so
 * one clinic contributed once per hazard that reached it. Three floods inside
 * 25 km produced `at_risk_count: 3` and three times the clinic's
 * `population_served`. Nothing crashed and every line was covered — the file
 * reported 100% line coverage the whole time. Coverage measured that the
 * increment ran, not that it ran the right number of times.
 *
 * The rule these tests pin: **an asset is counted once per service type,
 * regardless of how many hazards it sits near.** Everything genuinely
 * per-hazard (how many, how many severe, how far the nearest is, how bad the
 * worst one is) survives as per-asset detail and as `max_hazards_per_asset`,
 * rather than being smuggled back into the headline counts.
 *
 * Population follows the same rule. `total_population_served` sits next to
 * `at_risk_count` on the same row and is read as "people served by the
 * facilities at risk" — a population, which is a property of people and does
 * not multiply because the same people are threatened by more than one event.
 * The per-hazard-exposure reading is not discarded; it is
 * `computePopulationAtRisk`, which is keyed by hazard on purpose and reports
 * each hazard's own exposed population. Two functions, two populations, two
 * names that say which is which.
 */

// Turkana centre. 0.1 degrees of latitude is ~11 km, so these offsets land
// comfortably inside or outside the 25 km radius without depending on a
// fixture's stored precision.
const TURKANA = { lat: 3.1167, lon: 35.6 }

const hazard = (id, latOffset, severity) => ({
  id,
  event_type: 'flood',
  severity,
  latitude: TURKANA.lat + latOffset,
  longitude: TURKANA.lon,
})

const asset = (id, latOffset, extra = {}) => ({
  id,
  name: `Asset ${id}`,
  service_type: 'health',
  population_served: 500,
  latitude: TURKANA.lat + latOffset,
  longitude: TURKANA.lon,
  ...extra,
})

// One clinic, three floods within 25 km. This is the whole defect: the clinic
// is one building serving one population, and it is threatened by three events.
const oneAssetThreeHazards = () => ({
  hazard_events: [
    hazard('h1', 0, 'critical'),
    hazard('h2', 0.01, 'high'),
    hazard('h3', 0.05, 'medium'),
  ],
  service_assets: [asset('a1', 0, { population_served: 500 })],
})

describe('at_risk_count counts facilities, not facility-hazard pairs', () => {
  it('counts one asset once when three hazards reach it', () => {
    const rows = computeFacilitiesAtRisk(oneAssetThreeHazards())

    assert.equal(rows.length, 1)
    const health = rows[0]
    assert.equal(health.service_type, 'health')
    assert.equal(health.at_risk_count, 1, 'one building is one facility at risk, whatever threatens it')
  })

  it('does not multiply total_population_served by the number of nearby hazards', () => {
    // The headline the platform renders as "N facilities at risk, serving M
    // people". Three floods do not create three sets of patients.
    const [health] = computeFacilitiesAtRisk(oneAssetThreeHazards())

    assert.equal(health.total_population_served, 500, '500 people, counted once')
  })

  it('keeps the per-hazard facts that the pair count was standing in for', () => {
    // Without these, deduplicating would throw away the only record that the
    // asset is exposed three times over — which is the part an operator acts
    // on. It belongs on the asset, not in the count.
    const [health] = computeFacilitiesAtRisk(oneAssetThreeHazards())

    assert.equal(health.assets.length, 1, 'the asset appears once in the detail list too')
    assert.equal(health.max_hazards_per_asset, 3, 'the worst exposure in this service type is visible')

    const record = health.assets[0]
    assert.equal(record.id, 'a1')
    assert.equal(record.hazard_count, 3)
    assert.equal(record.high_severity_hazard_count, 2, 'critical and high both count')
    assert.equal(record.worst_hazard_severity, 'critical', 'the worst one, not the last one')
    assert.equal(record.nearest_hazard_km, 0)
  })

  it('counts an asset within range of one high and one low hazard once, as high severity', () => {
    const [health] = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.02, 'low')],
      service_assets: [asset('a1', 0)],
    })

    assert.equal(health.at_risk_count, 1)
    assert.equal(health.high_severity_count, 1, 'within range of at least one severe hazard')
    assert.equal(health.high_severity_population_served, 500)
    assert.equal(health.assets[0].hazard_count, 2)
  })

  it('keeps the two counts independent when assets differ', () => {
    // Hazards at 0 / ±0.1° put a1 (at 0°) inside 25 km of all three and a2 (at
    // 0.15°) inside only two — 27.8 km from the southernmost. Pair counting
    // would report five at-risk facilities; the answer is two.
    const [health] = computeFacilitiesAtRisk({
      hazard_events: [
        hazard('h1', -0.1, 'high'),
        hazard('h2', 0, 'medium'),
        hazard('h3', 0.1, 'low'),
      ],
      service_assets: [
        asset('a1', 0, { population_served: 500 }),
        asset('a2', 0.15, { population_served: 300 }),
      ],
    })

    assert.equal(health.at_risk_count, 2)
    assert.equal(health.total_population_served, 800, '500 + 300, each once')
    assert.equal(health.max_hazards_per_asset, 3)
    assert.deepEqual(
      health.assets.map((a) => a.hazard_count),
      [3, 2],
      'per-asset exposure still differs even though the count does not'
    )
  })

  it('does not let one asset inflate two service types', () => {
    // Guards the accumulation, not just the total: the per-service-type
    // partition has to stay a partition.
    const rows = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.01, 'high'), hazard('h3', 0.02, 'high')],
      service_assets: [asset('a1', 0, { service_type: 'health' }), asset('a2', 0, { service_type: 'water' })],
    })

    assert.deepEqual(
      rows.map((r) => [r.service_type, r.at_risk_count]),
      [
        ['health', 1],
        ['water', 1],
      ]
    )
    assert.equal(
      rows.reduce((n, r) => n + r.at_risk_count, 0),
      2,
      'the rows partition the assets; they do not double them'
    )
  })
})

describe('an unexposed asset is absent, not a zero', () => {
  it('leaves out an asset beyond the radius of every hazard', () => {
    // 0.5 degrees is ~55 km. A row reading "water: 0 facilities at risk" would
    // be a measurement of nothing, sitting in the same list as real ones.
    const rows = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.01, 'medium')],
      service_assets: [asset('far', 0.5, { service_type: 'water' })],
    })

    assert.deepEqual(rows, [], 'no service type row is created for a service type with nothing at risk')
  })

  it('does not manufacture a row for a service type that has no exposure', () => {
    const rows = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high')],
      service_assets: [asset('a1', 0, { service_type: 'health' }), asset('far', 0.5, { service_type: 'water' })],
    })

    assert.deepEqual(
      rows.map((r) => r.service_type),
      ['health']
    )
  })

  it('treats population_served 0 as an answer, not as a missing value', () => {
    // The falsy-zero trap: `population_served || beneficiaries` reads a clinic
    // that serves nobody today as though the figure were absent, and reports
    // the beneficiaries count instead.
    const [health] = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high')],
      service_assets: [asset('a1', 0, { population_served: 0, beneficiaries: 900 })],
    })

    assert.equal(health.at_risk_count, 1)
    assert.equal(health.total_population_served, 0)
  })

  it('falls back to beneficiaries only when population_served is absent', () => {
    const [health] = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high')],
      service_assets: [asset('a1', 0, { population_served: undefined, beneficiaries: 900 })],
    })

    assert.equal(health.total_population_served, 900)
  })

  it('counts a duplicate store record once', () => {
    // A re-ingested connector payload holds the same asset id twice. Left alone
    // it doubles the count with nothing visible to show for it.
    const [health] = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high')],
      service_assets: [asset('a1', 0, { population_served: 500 }), asset('a1', 0, { population_served: 500 })],
    })

    assert.equal(health.at_risk_count, 1)
    assert.equal(health.total_population_served, 500)
  })

  it('skips hazards and assets with no usable coordinates rather than counting them as exposed', () => {
    const [health] = computeFacilitiesAtRisk({
      hazard_events: [
        { id: 'h1', event_type: 'flood', severity: 'high' },
        hazard('h2', 0, 'high'),
      ],
      service_assets: [
        { id: 'a1', service_type: 'health', population_served: 100 },
        asset('a2', 0),
      ],
    })

    assert.equal(health.at_risk_count, 1)
    assert.equal(health.assets[0].id, 'a2')
  })
})

describe('the result is deterministic', () => {
  it('returns the same bytes for the same store, on every call', () => {
    // No timestamp, no Set iteration order, no reliance on object key order:
    // this payload is persisted and diffed, so a run-to-run wobble is a
    // changed file with no change in the world.
    const data = oneAssetThreeHazards()
    assert.deepEqual(computeFacilitiesAtRisk(data), computeFacilitiesAtRisk(data))
  })

  it('keeps rows and asset detail in store order, not in a count-derived order', () => {
    // `at_risk_count` is now a partition of the assets, so sorting by it can
    // only tie. Sorting by it would make row order an artefact of how many
    // assets a service type happens to have; store order is the stable one.
    const rows = computeFacilitiesAtRisk({
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.01, 'high'), hazard('h3', 0.02, 'high')],
      service_assets: [
        asset('a1', 0, { service_type: 'water' }),
        asset('a2', 0.01, { service_type: 'health' }),
        asset('a3', 0.02, { service_type: 'water' }),
      ],
    })

    assert.deepEqual(
      rows.map((r) => r.service_type),
      ['water', 'health'],
      'first appearance wins the position, and health sorts nowhere'
    )
    assert.deepEqual(rows[0].assets.map((a) => a.id), ['a1', 'a3'], 'both water assets, in store order')
    assert.deepEqual(rows[1].assets.map((a) => a.id), ['a2'])
  })
})