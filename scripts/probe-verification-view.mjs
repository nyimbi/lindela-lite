/**
 * One measurement, kept because the number it produces is cited in
 * `docs/ux-improvements/AUDIT.md` and a citation that cannot be re-run is a
 * claim nobody can check. Not a gate: it asserts nothing and exits 0 either
 * way. `test/climate-source-paging.test.js` is where the behaviour is pinned.
 *
 * Usage: node scripts/probe-verification-view.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

const FORECASTS = 310
const ARCHIVE_REGIONS = 5

const forecastRecord = (n) => ({
  id: `climate-forecast-${n}`, source: 'open_meteo', type: 'precipitation_forecast',
  region_name: `District ${n}`, latitude: 3 + (n % 5), longitude: 35 + (n % 5),
  observed_at: `2027-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  precipitation_mm: n % 40, precipitation_probability_pct: 40,
})
const archiveRecord = (n) => ({
  id: `climate-archive-${n}`, source: 'open_meteo_archive', region_name: `District ${n}`,
  observed_at: '2026-10-10T00:00:00.000Z',
  daily: Array.from({ length: 7 }, (_, d) => ({ date: `2026-10-${String(4 + d).padStart(2, '0')}`, precipitation_mm: d })),
})

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-probe-verify-'))
const store = new JsonStore(path.join(dir, 'store.json'))
await store.write({
  climate_observations: [
    ...Array.from({ length: ARCHIVE_REGIONS }, (_, i) => archiveRecord(i)),
    ...Array.from({ length: FORECASTS }, (_, i) => forecastRecord(i)),
  ],
})
const listener = createServer({ store }).listen(0)
const base = `http://localhost:${listener.address().port}`
const get = async (p) => (await fetch(`${base}${p}`)).json()

const page = await get('/api/v1/climate?limit=200')
const view = await get('/api/v1/climate?view=verification')

const count = (b, f) => b.data.filter(f).length
const isForecast = (r) => r.type === 'precipitation_forecast'
const isOutcome = (r) => r.source === 'open_meteo_archive'

console.log(`store: ${FORECASTS} forecasts, ${ARCHIVE_REGIONS} archive regions (7 days each), 0 ENSO`)
console.log('')
console.log(`  ?limit=200            forecasts ${count(page, isForecast)}/${FORECASTS}   outcomes ${count(page, isOutcome)}/${ARCHIVE_REGIONS}   total ${page.total}  has_more ${page.has_more}`)
console.log(`  ?view=verification    forecasts ${count(view, isForecast)}/${FORECASTS}   outcomes ${count(view, isOutcome)}/${ARCHIVE_REGIONS}   total ${view.total}  has_more ${view.has_more}`)
console.log(`                        series.forecasts ${JSON.stringify(view.series.forecasts)}  series.outcomes ${JSON.stringify(view.series.outcomes)}`)

listener.close()
await fs.rm(dir, { recursive: true, force: true })
