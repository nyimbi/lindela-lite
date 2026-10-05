/**
 * R-92 — `Math.max(comparable, 1)` converted "no information" into a confident
 * classification, twice.
 *
 * **`flood-depth.js:512-513`.** `terrainLabel(higher / Math.max(comparable, 1),
 * max - min)` was given a *fraction* computed against a denominator forced to
 * at least 1. With zero comparable samples — no finite centre value, so nothing
 * to compare against — the fraction is 0, and `terrainLabel(0, relief)` returns
 * `'slope'`. The module was therefore labelling a basin "slope" from nothing,
 * and `'slope'` is not a neutral placeholder in that vocabulary: it means
 * "gradients run one way", which is a claim about hydrology.
 *
 * **`road-access.js:186-211`.** A hazard with a bounding box but no coordinate
 * produced `distanceKm = 0` when the road fell inside it. A `severity: "green"`
 * advisory then closed a trunk road at a distance the module does not know, at
 * `confidence: 90`. There are 91 bbox-only hazards in the live store. The
 * absence of a datum has to stay absent: "the box covers this road" is a real
 * statement about the box, and "the road is 0 km from the centre" is not a
 * statement about anything.
 *
 * These tests fail against the pre-fix modules.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeRoadAccess } from '../src/road-access.js'
import { terrainLabelForSamples } from '../src/flood-depth.js'

describe('R-92 — terrain is not classified from zero comparable samples', () => {
  it('refuses rather than calling a basin a slope', () => {
    const label = terrainLabelForSamples({ higher: 0, comparable: 0, relief: 20 })
    assert.equal(label, null,
      'with nothing to compare against, "slope" is a claim about hydrology made from no data')
  })

  it('refuses when the centre sample was not finite', () => {
    assert.equal(terrainLabelForSamples({ higher: 3, comparable: 8, relief: 20, centreFinite: false }), null)
  })

  it('still classifies when there are comparable samples', () => {
    assert.equal(terrainLabelForSamples({ higher: 8, comparable: 10, relief: 20, centreFinite: true }), 'basin')
    assert.equal(terrainLabelForSamples({ higher: 1, comparable: 10, relief: 20, centreFinite: true }), 'slope')
    assert.equal(terrainLabelForSamples({ higher: 5, comparable: 10, relief: 2, centreFinite: true }), 'flat')
    assert.equal(terrainLabelForSamples({ higher: 4, comparable: 10, relief: 20, centreFinite: true }), 'undulating')
  })

  it('names the refusal so a reader knows it is a gap rather than a label', () => {
    const label = terrainLabelForSamples({ higher: 0, comparable: 0, relief: 20 })
    assert.equal(label, null)
  })
})

describe('R-92 — a missing hazard coordinate does not become a distance of 0', () => {
  const road = {
    id: 'road-1',
    name: 'Northern corridor',
    service_type: 'road',
    road_class: 'trunk',
    country: 'SS',
    latitude: 6.2,
    longitude: 31.5,
  }

  const bboxHazard = (overrides = {}) => ({
    id: 'hz-bbox',
    event_type: 'flood',
    severity: 'green',
    bbox: { south: 6.1, west: 31.4, north: 6.3, east: 31.6 },
    observed_at: new Date().toISOString(),
    ...overrides,
  })

  const NOW = { now: new Date('2026-03-01T00:00:00.000Z') }

  it('reports no distance rather than zero for a bbox-only hazard', () => {
    const [record] = computeRoadAccess({
      service_assets: [road],
      hazard_events: [bboxHazard()],
    }, NOW)

    const obstruction = record.obstructions[0]
    assert.equal(obstruction.distance_km, null,
      'the box covers the road; it does not say the road is 0 km from the centre')
  })

  it('still blocks — a bbox hit is a real statement about the box', () => {
    const [record] = computeRoadAccess({
      service_assets: [road],
      hazard_events: [bboxHazard()],
    }, NOW)
    const obstruction = record.obstructions[0]
    assert.equal(obstruction.matched_by, 'bbox')
    assert.equal(obstruction.blocking, true)
  })

  it('does not claim the same confidence for an unlocated hazard as for a located one', () => {
    const [bboxOnly] = computeRoadAccess({
      service_assets: [road],
      hazard_events: [bboxHazard()],
    }, NOW)
    const [located] = computeRoadAccess({
      service_assets: [road],
      hazard_events: [bboxHazard({ latitude: 6.21, longitude: 31.51 })],
    }, NOW)

    assert.ok(bboxOnly.confidence <= located.confidence,
      'a hazard with no coordinate is weaker evidence than one with a coordinate, and the confidence has to say so')
  })

  it('a real zero distance still reads as zero', () => {
    // A hazard centred exactly on the road is 0 km away, and 0 km is the
    // answer. Distinguishing that from "no coordinate" is the whole point.
    const [record] = computeRoadAccess({
      service_assets: [road],
      hazard_events: [bboxHazard({ latitude: 6.2, longitude: 31.5 })],
    }, NOW)
    assert.equal(record.obstructions[0].distance_km, 0)
  })
})
