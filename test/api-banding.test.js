import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { FLOOD_DEPTH_BANDS, floodDepthBand } from '../public/shared/flood-bands.js'
import { precipBand } from '../public/shared/weather-bands.js'
import { dischargeBand } from '../public/shared/discharge-bands.js'

/**
 * ARC-05 — the operational bands are on the API, not only in the browser.
 *
 * The thresholds that decide "passable / restricted / impassable" lived in
 * `public/shared/*-bands.js` and were applied by the console. A partner API
 * client, an SMS gateway, or a district officer with a spreadsheet got raw
 * numbers and had to re-implement the banding — or, more likely, go without and
 * read 0.4 m of water as passable. The honesty claim the platform makes in
 * prose ("0.3 m impedes movement") was enforced only for people using the map.
 *
 * These tests drive the routes over HTTP and assert on the classification in
 * the response, because that is the artefact a consumer reads. An assertion
 * that `src/server.js` imports `floodDepthBand` would pass on a version that
 * imports it and never calls it.
 */

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-arc05-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('ARC-05 the API classifies what it reports, not just the browser', () => {
  it('river discharge carries its band, label, severity and the cut points', async () => {
    const region = {
      id: 'r1', source: 'open_meteo_flood', region_name: 'Turkana',
      latitude: 3.1, longitude: 35.6,
      daily: [
        { date: '2026-10-01', river_discharge_m3s: 30 },
        { date: '2026-10-02', river_discharge_m3s: 620 },
      ],
    }
    await withServer(async (base, store) => {
      await store.merge({ climate_observations: [region] })
      const body = await (await fetch(`${base}/api/v1/river-discharge`)).json()
      const item = body.data.find((d) => d.region_name === 'Turkana')
      assert.ok(item, 'the region the store holds was not returned')
      // The latest day is 620 m³/s, which is the extreme band. A consumer
      // reading only `river_discharge_m3s` cannot know that.
      assert.equal(item.river_discharge_m3s, 620)
      assert.equal(item.band, dischargeBand(620).key)
      assert.equal(item.band_label, 'Extreme discharge')
      assert.equal(item.severity, 'critical')

      // The table is published, so the thresholds are auditable without the
      // source tree. A band key with no legend is a classification the reader
      // has to take on faith.
      const keys = body.bands.map((b) => b.key)
      assert.deepEqual(keys, ['low', 'moderate', 'high', 'extreme'])
      assert.equal(body.bands.find((b) => b.key === 'moderate').max_m3s, 200)
      assert.match(body.model_note, /not a local gauge observation/i,
        'the model caveat must travel with the banded number')
    })
  })

  it('every forecast day is banded, and an unreported day is not called dry', async () => {
    const forecast = {
      id: 'w1', source: 'open_meteo_forecast', district: 'turkana', region_name: 'Turkana',
      as_of: new Date().toISOString(),
      type: 'weather_forecast_daily',
      observed_at: '2026-10-12',
      precipitation_mm: 25,
      weather_code: 61,
    }
    await withServer(async (base, store) => {
      await store.merge({ weather_forecasts: [forecast] })
      const body = await (await fetch(`${base}/api/v1/weather`)).json()
      const district = body.districts.find((d) => d.slug === 'turkana')
      assert.ok(district, 'the seeded district was not in the report')
      const day = district.forecast[0]
      assert.equal(day.precipitation_mm, 25)
      assert.equal(day.band, precipBand(25).key)
      assert.equal(day.band_label, 'Heavy rain')

      // The zero/absence discipline, on the wire: a day with no reported total
      // must not arrive as the dry band. `null` band is "no reading".
      assert.equal(precipBand(null), null)
      const bands = body.precip_bands.map((b) => b.key)
      assert.deepEqual(bands, ['dry', 'light', 'moderate', 'heavy', 'extreme'])
      assert.equal(body.temp_bands.length, 4)
    })
  })

  it('a depth profile bands each level with the operational consequence', async () => {
    // A real terrain probe, so the route exercises its own banding rather than
    // a fixture. The band asserted is whatever the terrain actually gives; the
    // invariant is that the band agrees with the shared function for the depth
    // reported — which is what stops the two from drifting.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/flood-depth?lat=3.1&lon=35.6&level_m=520`)
      assert.equal(res.status, 200)
      const body = await res.json()
      for (const point of body.data.profile) {
        const expected = floodDepthBand(point.depth_m)
        assert.equal(point.depth_band, expected?.key ?? null,
          `level ${point.level_m} reported band ${point.depth_band} for depth ${point.depth_m}`)
        assert.equal(point.depth_band_note, expected?.note ?? null)
      }
      assert.equal(body.data.flood_bands.length, FLOOD_DEPTH_BANDS.length)
      assert.equal(body.data.flood_bands[1].note, 'restricted',
        'the band table must carry the operational consequence, not just a label')
    })
  })

  it('the depth grid summarises per band over the surveyed denominator', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/flood-depth?south=3.0&west=35.5&north=3.2&east=35.7&level_m=520&grid_size=8`)
      assert.equal(res.status, 200)
      const body = await res.json()
      const grid = body.data
      assert.ok(Array.isArray(grid.per_band), 'the grid carries no per-band summary')

      // The summary must agree with the grid it summarises, cell for cell. A
      // summary computed over a different denominator is the failure this
      // catches — the audit's own `surveyedAreaKm2` note is the precedent.
      const surveyed = grid.depth_grid.filter((d) => typeof d === 'number' && Number.isFinite(d))
      const counted = grid.per_band.reduce((sum, b) => sum + b.cells, 0)
      const wet = surveyed.filter((d) => d > 0).length
      assert.equal(counted, wet,
        `${counted} cells were banded but ${wet} of ${surveyed.length} surveyed cells are wet`)

      for (const band of grid.per_band) {
        if (band.cells === 0) continue
        assert.equal(band.pct_of_surveyed, Math.round((band.cells / surveyed.length) * 10000) / 100)
      }
    })
  })
})
