#!/usr/bin/env node
/**
 * Confidence must be earned by data that contributed, not by data that existed.
 *
 * `computeClimateConflictRisk` drew its confidence vector from `climate.length`
 * — every climate observation within 125 km. But a CHIRPS record carries
 * `precipitation_mm: null` by construction (the connector reports which
 * rasters exist, not what fell), and `open-meteo-flood` does the same. A region
 * whose entire climate coverage was a directory listing scored full climate
 * confidence, and `confidence` is what the p10/p90 band is drawn from. The
 * number was not wrong about the score, which is unaffected; it was wrong about
 * how much to trust the score.
 *
 * This is the same defect class ENH-09 documents on the ingestion side — two
 * products, one of them carrying no values — arriving from the other direction.
 * The guard belongs next to the aggregation rather than in the connector,
 * because the property is about the aggregate and only the aggregate can know it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeClimateConflictRisk } from '../src/analytics.js'

/** A CHIRPS-shaped observation: present, dated, and carrying no rainfall. */
const chirpsRecord = (district, date) => ({
  id: `chirps-${district}-${date}`,
  source: 'chirps',
  district,
  type: 'rainfall_dataset_available',
  observed_at: `${date}T00:00:00.000Z`,
  precipitation_mm: null,
  latitude: 3.1167,
  longitude: 35.6,
  country: 'KE',
})

/** An Open-Meteo-shaped observation that actually measured something. */
const measuredRecord = (district, date, mm) => ({
  id: `om-${district}-${date}`,
  source: 'open_meteo',
  district,
  type: 'rainfall',
  observed_at: `${date}T00:00:00.000Z`,
  precipitation_mm: mm,
  latitude: 3.1167,
  longitude: 35.6,
  country: 'KE',
})

function riskFor(climate) {
  // collectRegions() derives its regions from the data's own coordinates
  // rather than accepting a list, so a region only exists if a record placed
  // it there. It also walks four collections without defaulting them, so a
  // partial data object throws before reaching the aggregation under test.
  const risks = computeClimateConflictRisk({
    climate_observations: climate,
    hazard_events: [],
    conflict_events: [],
    service_assets: [],
  })
  assert.equal(risks.length, 1, 'expected exactly the one region the fixtures place')
  return risks[0]
}

describe('climate confidence counts observations that carried a number', () => {
  it('gives no climate credit to a region covered only by raster listings', () => {
    // The defect. Six CHIRPS records, every one of them `precipitation_mm: null`,
    // and the region was being credited with full climate confidence off the
    // back of a directory listing.
    const risk = riskFor([
      chirpsRecord('Turkana', '2026-01-01'),
      chirpsRecord('Turkana', '2026-01-02'),
      chirpsRecord('Turkana', '2026-01-03'),
      chirpsRecord('Turkana', '2026-01-04'),
      chirpsRecord('Turkana', '2026-01-05'),
      chirpsRecord('Turkana', '2026-01-06'),
    ])
    assert.equal(risk.confidence, 0, 'nothing measured, so nothing to be confident about')
  })

  it('does credit the same region once the measurements exist', () => {
    const risk = riskFor([
      chirpsRecord('Turkana', '2026-01-01'),
      measuredRecord('Turkana', '2026-01-02', 12),
      measuredRecord('Turkana', '2026-01-03', 18),
      measuredRecord('Turkana', '2026-01-04', 4),
    ])
    assert.ok(risk.confidence > 0, 'three real measurements are evidence')
  })

  it('ranks a measured region above a listed one holding the same record count', () => {
    // Same shape of input, same count, and the confidence must differ — because
    // the whole claim is that the count alone was never the right measure.
    const listed = riskFor([
      chirpsRecord('Turkana', '2026-01-01'),
      chirpsRecord('Turkana', '2026-01-02'),
      chirpsRecord('Turkana', '2026-01-03'),
    ])
    const measured = riskFor([
      measuredRecord('Turkana', '2026-01-01', 5),
      measuredRecord('Turkana', '2026-01-02', 9),
      measuredRecord('Turkana', '2026-01-03', 2),
    ])
    assert.ok(measured.confidence > listed.confidence,
      `measured ${measured.confidence} should exceed listed ${listed.confidence}`)
  })

  it('leaves the score itself alone, because the pressure sum is unaffected', () => {
    // A null rainfall adds nothing to the pressure sum, exactly as a measured
    // zero millimetres would. So the score is identical either way and only the
    // confidence differs — which is what makes this a confidence defect and not
    // a scoring one. Asserting it prevents a future "fix" that starts skipping
    // null records entirely and thereby changes a score it had no business
    // changing.
    const listed = riskFor([chirpsRecord('Turkana', '2026-01-01')])
    const measuredZero = riskFor([measuredRecord('Turkana', '2026-01-01', 0)])
    assert.equal(listed.score, measuredZero.score,
      'a null rainfall and a measured zero both add nothing to the pressure sum')
    assert.notEqual(listed.confidence, measuredZero.confidence,
      'and they are not the same evidence, which is the whole point')
  })

  it('does not treat null as a measurement, which takes a deliberate check to avoid', () => {
    // The first version of the fix was `Number.isFinite(Number(item.precipitation_mm))`.
    // That is true for null, because `Number(null)` is 0 and `Number.isFinite(0)`
    // is true — so every null-rainfall record passed the filter and the guard
    // looked like it worked. A boolean truthiness check would have been equally
    // wrong in the other direction, rejecting a measured zero.
    //
    // This is the falsy-zero defect one level deeper than the usual: not a `||`
    // in a sum, but a numeric coercion quietly manufacturing a value out of an
    // absence. The explicit three-way presence check is the only thing standing
    // between null and "it measured zero millimetres", which is why it is
    // spelled out here rather than left as an inline predicate.
    assert.equal(Number.isFinite(Number(null)), true, 'the coercion that made the first fix useless')
    assert.equal(Number(null), 0)

    const listed = riskFor([chirpsRecord('Turkana', '2026-01-01')])
    assert.equal(listed.confidence, 0, 'null is present-but-unmeasured, not a measured zero')
  })

  it('counts a genuine zero as a measurement', () => {
    // 0mm is a value. It is the same falsy-zero trap the connectors are full
    // of: `precipitation_mm || 0` reads 0 as absent, and a region where it
    // genuinely did not rain would be recorded as having no data.
    const dryButMeasured = riskFor([
      measuredRecord('Turkana', '2026-01-01', 0),
      measuredRecord('Turkana', '2026-01-02', 0),
      measuredRecord('Turkana', '2026-01-03', 0),
    ])
    const unmeasured = riskFor([
      chirpsRecord('Turkana', '2026-01-01'),
      chirpsRecord('Turkana', '2026-01-02'),
      chirpsRecord('Turkana', '2026-01-03'),
    ])
    assert.ok(dryButMeasured.confidence > unmeasured.confidence,
      'a measured zero millimetres is evidence; an absent value is not')
  })
})