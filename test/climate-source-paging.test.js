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
import { installModuleResolution } from './browser-env.mjs'

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
  precipitation_probability_pct: 40,
})

/**
 * One archive outcome record, shaped as `src/connectors/open-meteo-archive.js`
 * writes it: a region *window* carrying a `daily` array, not one row per day.
 *
 * Dated before the forecasts, which is the real shape — an outcome exists only
 * for a day that has happened. That ordering is what makes it the series a
 * newest-first page drops first.
 */
const archiveRecord = (n) => ({
  id: `climate-archive-${n}`,
  source: 'open_meteo_archive',
  region_name: `District ${n}`,
  observed_at: '2026-10-10T00:00:00.000Z',
  daily: Array.from({ length: 7 }, (_, d) => ({
    date: `2026-10-${String(4 + d).padStart(2, '0')}`,
    precipitation_mm: d,
  })),
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

/**
 * The same page limit, on the panel that verifies forecasts against outcomes.
 *
 * ENH-21's verification panel joins the weather connector's forecasts to the
 * archive connector's outcomes, and the console fed it one `?limit=200` page of
 * the ambient collection. On the demo store that page carried 71 of the store's
 * 117 forecasts and none of its 19 ENSO rows, measured through the live ingress
 * rather than inferred, because the forecast rows are newer and unbounded — and
 * the panel printed "71 forecasts in the store" over a store holding 117.
 *
 * The archive half cannot be measured on the demo store, which holds no archive
 * rows at all: an outcome exists only for a day that has happened, so it is
 * *structurally* always older than the forecasts it is checked against and is
 * the first thing a newest-first page drops. That is why the store below is
 * planted with both series.
 *
 * Both halves are asserted here as *failures of the single page* rather than as
 * facts about the store, so the fix cannot be reverted by a change to demo data.
 */
describe('one page cannot carry both series the verification panel joins', () => {
  const FORECASTS = 310
  const ARCHIVE_REGIONS = 5
  // Local names, deliberately. The suite above owns `store`/`listener`/`dir` and
  // closes them in the file's `after`; a second `before` writing those names
  // would orphan the first listener and hold the process open after every test
  // had passed — a green run that never exits.
  let verifyStore
  let verifyListener
  let verifyBase
  let verifyDir

  const getAt = async (path_) => {
    const res = await fetch(`${verifyBase}${path_}`)
    return { status: res.status, body: await res.json() }
  }

  before(async () => {
    verifyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-climate-verify-'))
    verifyStore = new JsonStore(path.join(verifyDir, 'store.json'))
    // The archive rows are dated *older* than the forecasts, which is the real
    // shape: an outcome exists only for a day that has already happened, and a
    // forecast is by definition for a day that has not. Newest-first ordering
    // therefore puts every forecast ahead of every outcome.
    await verifyStore.write({
      climate_observations: [
        ...Array.from({ length: 19 }, (_, i) => ensoRecord(2025 + Math.floor(i / 12), (i % 12) + 1)),
        ...Array.from({ length: ARCHIVE_REGIONS }, (_, i) => archiveRecord(i)),
        ...Array.from({ length: FORECASTS }, (_, i) => forecastRecord(i)),
      ],
    })
    verifyListener = createServer({ store: verifyStore }).listen(0)
    verifyBase = `http://localhost:${verifyListener.address().port}`
  })

  after(async () => {
    verifyListener?.close()
    if (verifyDir) await fs.rm(verifyDir, { recursive: true, force: true })
  })

  it('a newest-first page of 200 loses the archive outcomes entirely and most of the forecasts', async () => {
    const { body } = await getAt('/api/v1/climate?limit=200')
    assert.equal(body.total, 19 + ARCHIVE_REGIONS + FORECASTS, 'the collection holds every row')
    assert.equal(body.has_more, true, 'the page is truncated, so a caller reading it as the store is wrong')
    assert.ok(body.data.filter((r) => r.type === 'precipitation_forecast').length < FORECASTS,
      'the page cannot carry every forecast — that is the defect, not a store with too few')
    assert.equal(body.data.filter((r) => r.source === 'open_meteo_archive').length, 0,
      'no archive outcome survives in the first page by recency, so the join can verify nothing')
  })

  it('one request returns both series in full, and states each one\'s size', async () => {
    // What the console sends. `view=verification` selects by what a row *is*
    // rather than by recency, so it is not bounded by a page — which is the
    // whole reason it exists.
    const { body } = await getAt('/api/v1/climate?view=verification')
    assert.equal(body.returned, FORECASTS + ARCHIVE_REGIONS)
    assert.equal(body.total, FORECASTS + ARCHIVE_REGIONS)
    assert.equal(body.has_more, false)
    assert.equal(body.next_cursor, null)

    // The coverage block is the point of the view, not decoration: a caller
    // that got the rows without it would be back to inferring the store's size
    // from a page length, which is the defect one layer down.
    assert.deepEqual(body.series.forecasts, { total: FORECASTS, returned: FORECASTS })
    assert.deepEqual(body.series.outcomes, { total: ARCHIVE_REGIONS, returned: ARCHIVE_REGIONS })
    assert.ok(body.series.limit >= FORECASTS + ARCHIVE_REGIONS, 'the cap must not be the reason this fits')

    // Neither discriminator may leak the other's rows: an archive record
    // carries no `type`, and a forecast is not an archive outcome. A view that
    // selected by one of them and called it both would double-count.
    const forecasts = body.data.filter((r) => r.type === 'precipitation_forecast')
    const outcomes = body.data.filter((r) => r.source === 'open_meteo_archive')
    assert.equal(forecasts.length, FORECASTS)
    assert.equal(outcomes.length, ARCHIVE_REGIONS)
    // And the ENSO rows the collection also holds are in neither series.
    assert.equal(body.data.filter((r) => r.source === 'noaa_enso').length, 0)
  })

  it('the view lets the panel name the outcomes the page dropped', async () => {
    // The claim the panel makes is a sentence about the store. This drives the
    // real renderer over the real response, so the sentence is checked against
    // what the console now hands it rather than against a fixture.
    installModuleResolution()
    const { renderVerification } = await import('../public/workflow/wire-verify.js')

    const view = await getAt('/api/v1/climate?view=verification')
    const page = await getAt('/api/v1/climate?limit=200')

    const full = { innerHTML: '' }
    const fullPairs = renderVerification(full, { observations: view.body.data })
    const truncated = { innerHTML: '' }
    const truncatedPairs = renderVerification(truncated, { observations: page.body.data })

    assert.equal(fullPairs.total, FORECASTS, 'the panel counts the store, not the page')
    assert.equal(truncatedPairs.total, page.body.data.filter((r) => r.type === 'precipitation_forecast').length)
    assert.match(full.innerHTML, new RegExp(`${ARCHIVE_REGIONS * 7} archived region-day outcome`),
      'the outcomes the page dropped are named on the panel')
    // And the truncated page cannot produce that sentence — which is what makes
    // the view load-bearing rather than tidy.
    assert.doesNotMatch(truncated.innerHTML, /archived region-day outcome/)
  })
})
