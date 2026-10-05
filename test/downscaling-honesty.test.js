/**
 * R-88 — `analytics/downscaling.js` laundered a null into a 0 mm reading and
 * then attributed the result to a station that contributed neither number.
 *
 * Three defects, all in the same forty lines:
 *
 * 1. `Number(o[field] || 0)` turns an absent observation into a real 0 mm
 *    reading. The module's own header states its limits accurately as written —
 *    only its null handling contradicted them. A month nobody measured then
 *    enters a quantile map as the driest month in the record.
 *
 * 2. `quantileMap` bails only at `length < 2`, so a two-station map is treated
 *    as a usable lookup table. With two stations an observation of 900 mm is
 *    published as 90 mm — a tenfold reduction of the most extreme event in the
 *    record, from a two-value table that cannot say anything about where 900
 *    falls between its two entries. Interpolation between two points is a
 *    linear assumption, not a measurement, and at n=2 it is the only thing the
 *    number is.
 *
 * 3. `bias_correction_source` is `stationGroup[0].source` regardless of which
 *    station the map returned. Rows were attributed to a station that
 *    contributed neither the grid value nor the station value. A provenance
 *    field that does not describe the provenance is worse than an absent one,
 *    because it is believed.
 *
 * These tests fail against the pre-fix module: `population` absent produced
 * `bias_corrected_precipitation_mm: 0` and a 900 mm observation reduced to 90.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { biasCorrectClimate, quantileMap } from '../src/analytics/downscaling.js'

const obs = (country, precipitation_mm) => ({ country, precipitation_mm })

describe('R-88 — an absent observation is not a 0 mm reading', () => {
  it('returns null for a month with no recorded precipitation', () => {
    const out = biasCorrectClimate(
      [obs('KE', null), obs('KE', undefined), obs('KE', '')],
      [{ country: 'KE', precipitation_mm: 40, source: 'CHIRPS' }, { country: 'KE', precipitation_mm: 200, source: 'CHIRPS' }],
    )
    assert.equal(out.length, 3)
    for (const row of out) {
      assert.equal(row.bias_corrected_precipitation_mm, null,
        'no measurement in, no measurement out — a 0 mm reading would enter the record as fact')
      assert.match(row.bias_correction_refusal, /not measured|no finite|absent/i)
    }
  })

  it('still corrects a real zero, because zero millimetres is a measurement', () => {
    const out = biasCorrectClimate(
      [obs('KE', 0), obs('KE', 100), obs('KE', 200)],
      [
        { country: 'KE', precipitation_mm: 5, source: 'CHIRPS' },
        { country: 'KE', precipitation_mm: 40, source: 'CHIRPS' },
        { country: 'KE', precipitation_mm: 200, source: 'CHIRPS' },
      ],
    )
    const zero = out.find((r) => r.precipitation_mm === 0)
    assert.equal(typeof zero.bias_corrected_precipitation_mm, 'number',
      'a measured 0 mm is the bottom of the distribution, not an absence')
    assert.equal(zero.bias_corrected_precipitation_mm, 5)
  })

  it('does not let an absent observation into the grid it is mapped against', () => {
    // A null coerced to 0 sorts to the bottom of the grid and shifts every
    // rank above it, so one unrecorded month mis-corrects all the measured ones.
    const withGap = biasCorrectClimate(
      [obs('KE', null), obs('KE', 100), obs('KE', 200), obs('KE', 300)],
      [{ country: 'KE', precipitation_mm: 10, source: 'S' }, { country: 'KE', precipitation_mm: 150, source: 'S' }, { country: 'KE', precipitation_mm: 250, source: 'S' }],
    )
    const clean = biasCorrectClimate(
      [obs('KE', 100), obs('KE', 200), obs('KE', 300)],
      [{ country: 'KE', precipitation_mm: 10, source: 'S' }, { country: 'KE', precipitation_mm: 150, source: 'S' }, { country: 'KE', precipitation_mm: 250, source: 'S' }],
    )
    const measured = (rows) => rows.find((r) => r.precipitation_mm === 100).bias_corrected_precipitation_mm
    assert.equal(measured(withGap), measured(clean),
      'an absent month must not shift the correction applied to the months that were measured')
  })
})

describe('R-88 — a two-station map is not a lookup table', () => {
  it('refuses to interpolate between fewer than three stations', () => {
    const map = quantileMap([10, 20, 30, 40, 50], [5, 25])
    assert.equal(map(900), null,
      'a two-value table cannot say where 900 falls; 90 mm was a tenfold reduction of the most extreme event in the record')
  })

  it('declares its refusal rather than returning a number', () => {
    const map = quantileMap([10, 20, 30], [5, 25])
    const out = map(900)
    assert.equal(out, null)
  })

  it('does correct when there are enough stations to correct with', () => {
    const map = quantileMap([10, 20, 30, 40, 50], [5, 15, 25, 35, 45])
    assert.equal(typeof map(30), 'number')
  })

  it('ignores a null in the grid rather than sorting it to zero', () => {
    const map = quantileMap([null, 10, 20, 30, 40], [5, 15, 25, 35, 45])
    assert.equal(typeof map(20), 'number')
  })

  it('returns null for a non-finite input even with plenty of stations', () => {
    const map = quantileMap([10, 20, 30, 40, 50], [5, 15, 25, 35, 45])
    assert.equal(map(null), null)
    assert.equal(map(undefined), null)
    assert.equal(map(NaN), null)
  })
})

describe('R-88 — the provenance names the station that contributed', () => {
  it('names the station the map actually returned', () => {
    // Gridded obs ascending, stations ascending. The top of the grid must map
    // to the top station — and the old code named stationGroup[0] regardless,
    // so every row was attributed to a station that contributed neither number.
    const out = biasCorrectClimate(
      [obs('KE', 10), obs('KE', 200), obs('KE', 500)],
      [
        { country: 'KE', precipitation_mm: 5, source: 'station-alpha' },
        { country: 'KE', precipitation_mm: 100, source: 'station-beta' },
        { country: 'KE', precipitation_mm: 600, source: 'station-gamma' },
      ],
    )
    const low = out.find((r) => r.precipitation_mm === 10)
    const high = out.find((r) => r.precipitation_mm === 500)
    assert.notEqual(low.bias_correction_source, high.bias_correction_source,
      'a provenance field that is the same for every row describes nothing')
    assert.equal(low.bias_correction_source, 'station-alpha')
    assert.notEqual(high.bias_correction_source, 'station-alpha',
      'the top of the grid must not be attributed to the bottom station')
    assert.equal(low.bias_correction_refusal, null)
  })

  it('carries no source at all when the correction was refused', () => {
    const out = biasCorrectClimate(
      [obs('KE', 100)],
      [{ country: 'KE', precipitation_mm: 5, source: 'only-station' }],
    )
    assert.equal(out[0].bias_correction_source, null,
      'naming a station for a correction that did not happen is the provenance lie in its purest form')
    assert.ok(out[0].bias_correction_refusal)
  })
})
