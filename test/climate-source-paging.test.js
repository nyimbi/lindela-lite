#!/usr/bin/env node
/**
 * The seasonal advisory was blanked by a page limit, not by missing data.
 *
 * `/api/v1/climate` is one collection holding several connectors' rows —
 * weather forecasts, CHIRPS raster listings, and the monthly Niño 3.4 series.
 * The console fetched the newest 200 and handed them to the seasonal strip,
 * which reads `source === 'noaa_enso'`. The weather connector files a forecast
 * row per district-day, so those rows grow without bound and are always newer
 * than the monthly series; in the demo store 232 forecast rows sat ahead of 19
 * ENSO rows, and the strip's page carried none of them. The panel then read
 * "Niño 3.4 has not been ingested" over a series that was sitting in the store —
 * a claim about the connector's coverage that was false.
 *
 * The fix is not a bigger `limit`: the forecast rows are unbounded, so any fixed
 * page eventually loses the series again. It is to fetch the series by source,
 * which the endpoint already supports. These tests pin both halves — that the
 * ambient page really does exclude the series, and that the source filter
 * returns it in full — so the fetch cannot be "simplified" back to one request
 * without a failure that names this.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/** A monthly Niño 3.4 row, shaped as `src/connectors/noaa-enso.js` writes it. */
const ensoRecord = (year, month) => {
  const period = `${year}-${String(month).padStart(2, '0')}`
  return {
    id: `climate-enso-${period}`,
    source: 'noaa_enso',
    source_id: period,
    latitude: null,
    longitude: null,
    region: 'Niño 3.4 region (5°N-5°S, 120°-170°W)',
    observed_at: `${period}-15T00:00:00.000Z`,
    metric: 'nino34_sst_anomaly_c',
    value: 0.5 + (month / 12),
    unit: 'degC',
  }
}

/**
 * A district-day forecast row, dated strictly after every ENSO row.
 *
 * Dated later on purpose: the endpoint orders newest-first, so this is what
 * pushes the monthly series off the first page. `n` is what makes the crowd
 * outgrow any fixed limit.
 */
const forecastRecord = (n) => ({
  id: `climate-forecast-${n}`,
  source: 'open_meteo',
  type: 'precipitation_forecast',
  region_name: `District ${n}`,
  latitude: 3 + (n % 5),
  longitude: 35 + (n % 5),
  observed_at: `2027-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  precipitation_mm: n % 40,
})

const get = async (path_) => {
  const res = await fetch(`${base}${path_}`)
  return { status: res.status, body: await res.json() }
}

let store
let listener
let base
let dir

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-climate-page-'))
  store = new JsonStore(path.join(dir, 'store.json'))
  // 19 monthly ENSO rows (a plausible recent window), and 240 forecast rows
  // dated after them — more than the console's page of 200, which is the whole
  // point: the series cannot fit.
  await store.write({
    climate_observations: [
      ...Array.from({ length: 19 }, (_, i) => ensoRecord(2025 + Math.floor(i / 12), (i % 12) + 1)),
      ...Array.from({ length: 240 }, (_, i) => forecastRecord(i)),
    ],
  })
  listener = createServer({ store }).listen(0)
  base = `http://localhost:${listener.address().port}`
})

after(async () => {
  listener?.close()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

describe('the ambient climate page cannot be trusted to carry the ENSO series', () => {
  it('a newest-first page of 200 excludes the monthly series entirely', async () => {
    // This is the defect, stated as a property of the API: not that the series
    // is missing from the store, but that the page the console asked for cannot
    // contain it. If this ever stops being true the fix below is still correct —
    // the test would then be describing a store where the crowd is smaller.
    const { body } = await get('/api/v1/climate?limit=200')
    assert.equal(body.returned, 200)
    assert.equal(body.total, 259, 'the collection holds all 259 rows')
    const enso = body.data.filter((r) => r.source === 'noaa_enso')
    assert.equal(enso.length, 0, 'no ENSO row survives in the first 200 by recency')
  })

  it('the source filter returns the whole series', async () => {
    const { body } = await get('/api/v1/climate?source=noaa_enso&limit=500')
    assert.equal(body.total, 19)
    assert.equal(body.returned, 19)
    assert.ok(body.data.every((r) => r.source === 'noaa_enso'))
    // Ordered newest-first, so the strip reads the latest month as "current".
    assert.match(body.data[0].source_id, /^\d{4}-\d{2}$/)
  })

  it('the source filter does not leak other connectors', async () => {
    // A filter that looked like a filter but was not would answer the strip with
    // forecast rows and, worse, would read as though it had been scoped.
    const { body } = await get('/api/v1/climate?source=noaa_enso&limit=500')
    assert.equal(body.data.filter((r) => r.source !== 'noaa_enso').length, 0)
  })
})
