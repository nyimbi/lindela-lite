import { fetchWithRetry } from './http.js'
import { DEFAULT_REGIONS } from '../schema.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { readMeasurement } from './open-meteo.js'
import {
  advanceBackfill,
  advanceWatermark,
  beginBackfill,
  completeBackfill,
  fetchWindow,
  readWatermark,
  resumeBackfill,
} from '../watermarks.js'

/**
 * Historical daily river discharge from the Open-Meteo flood API, for
 * flood-probability training where the GDACS reported-flood label is too
 * sparse. Keyless, no licence gate.
 *
 * Verified live on 2026-10-02 at:
 *   https://flood-api.open-meteo.com/v1/flood?latitude=3.1167&longitude=35.6
 *     &start_date=1984-01-01&end_date=2026-10-02&daily=river_discharge
 * (one request; non-null daily discharge from 1997-01-01, max 1431.2 m3/s on
 * the Turkana reach — a real river cell)
 *
 * The upstream data is the GloFAS v4 hydrological model (consolidated
 * reanalysis to July 2022, seamlessly continued by the operational run). That
 * matters in two ways, both stated on every record:
 * - discharge is modelled, not gauged;
 * - a grid cell without a river reach returns null throughout — verified live
 *   2026-10-02: the Turkana point (reach non-null from 1997-01-01, max
 *   1431.2 m3/s) and the Juba point (4.8594, 31.5713, White Nile) have
 *   reaches; the Mogadishu point has none. A no-reach region comes back as an
 *   explicit error, not a null-wearing record.
 *
 * One record per region with the whole daily array mirrors the
 * open_meteo_archive connector, for the same reason: the discharge label is
 * defined per calendar month over the whole record, so downstream needs the
 * daily sequence, not per-day rows.
 *
 * ── Where the watermark lives ───────────────────────────────────────────────
 * In the caller, exactly as in `open-meteo-archive.js`, and for the same
 * reason: `src/watermarks.js` is pure, `ingest(options)` has no memory between
 * calls, and a module-level Map would die with the process while looking, in a
 * test that runs twice, exactly like a watermark. The contract is
 * `watermark_state` in, `watermark_state` out, with `on_watermark_state`
 * called after every completed backfill chunk so an interrupted crawl resumes
 * at the chunk it died on rather than at 1984. `src/ingestion.js` passes
 * neither yet, and that is where the wiring belongs.
 */

const FLOOD_URL = 'https://flood-api.open-meteo.com/v1/flood'
const SOURCE = 'open_meteo_flood'

// GloFAS v4 consolidated reanalysis starts 1984; the earliest reach values
// vary by cell, and this just bounds the request — nulls are kept as nulls.
// Matches SERIES_FLOOR in watermarks.js.
const SERIES_FLOOR = '1984-01-01'

/**
 * Wider than any series the module knows, because `fetchWindow` takes
 * `max(today - lookback, floor)` and a 42-year lookback evaluated in 2026
 * would start at 1984-10-05 — dropping three quarters of the first year of the
 * reanalysis on the one run meant to fetch all of it.
 */
const SERIES_SPAN_DAYS = 60 * 365

/** Backfill chunk size; see the note on the same constant in open-meteo-archive.js. */
const CHUNK_DAYS = 365

const DAY_MS = 86400000

/** `end_date` minus `days - 1`, clamped to the job's end. ISO dates sort lexically. */
function chunkEnd(from, days, to) {
  const end = new Date(Date.parse(`${from}T00:00:00.000Z`) + (days - 1) * DAY_MS)
    .toISOString().slice(0, 10)
  return end < to ? end : to
}

/** Null-checked before coercion: `Number(null)` is 0, and 0 is not a chunk size. */
function chunkDaysFrom(value, fallback) {
  if (value === undefined || value === null) return fallback
  const days = Number(value)
  if (!Number.isFinite(days) || days < 1) {
    throw new TypeError(`flood_chunk_days must be a positive number, got ${JSON.stringify(value)}`)
  }
  return Math.floor(days)
}

function watermarkStateFrom(options) {
  const state = options.watermark_state
  return state && typeof state === 'object' ? state : {}
}

/**
 * What this run should request, derived from the stored mark rather than from
 * the clock. An outstanding backfill outranks everything else.
 */
function planRun({ options, state, now }) {
  const pinnedEnd = options.flood_end_date
  if (pinnedEnd) {
    // An operator-pinned window is a manual request: fetch exactly it, move no
    // cursor. Advancing the mark off a three-day maintenance fetch would
    // declare a 42-year series complete.
    return {
      kind: 'explicit',
      state,
      reason: 'operator-pinned-window',
      asOf: null,
      window: {
        startDate: options.flood_start_date ? String(options.flood_start_date) : SERIES_FLOOR,
        endDate: String(pinnedEnd),
      },
    }
  }

  const outstanding = resumeBackfill(state, SOURCE)
  if (outstanding) {
    return {
      kind: 'backfill',
      state,
      reason: 'resumable-backfill',
      asOf: outstanding.cursor,
      window: { startDate: outstanding.from, endDate: outstanding.to },
    }
  }

  const win = fetchWindow({
    source: SOURCE,
    watermark: readWatermark(state, SOURCE),
    defaultWindowDays: SERIES_SPAN_DAYS,
    now,
  })

  if (win.skip) return { kind: 'skip', state, reason: win.reason, asOf: win.asOf, window: { startDate: win.startDate, endDate: win.endDate }, win }
  if (win.mode === 'full') {
    return {
      kind: 'backfill',
      state: beginBackfill(state, SOURCE, { from: win.startDate, to: win.endDate, at: now.toISOString() }),
      reason: win.reason,
      asOf: win.asOf,
      window: { startDate: win.startDate, endDate: win.endDate },
    }
  }
  return { kind: 'window', state, reason: win.reason, asOf: win.asOf, window: { startDate: win.startDate, endDate: win.endDate }, win }
}

/**
 * One region, one window.
 *
 * A region with no river reach is an error rather than a record: absence here
 * is a fact about the grid cell, not a transient failure, and a region holding
 * no discharge is not training data.
 */
async function fetchRegion(region, startDate, endDate, { timeoutMs, retries }) {
  const url = new URL(FLOOD_URL)
  url.searchParams.set('latitude', String(region.lat))
  url.searchParams.set('longitude', String(region.lon))
  url.searchParams.set('start_date', startDate)
  url.searchParams.set('end_date', endDate)
  url.searchParams.set('daily', 'river_discharge')
  const text = await fetchWithRetry(url.toString(), { timeoutMs, retries, parse: 'text' })
  const payload = JSON.parse(text)
  const times = payload?.daily?.time
  const values = payload?.daily?.river_discharge
  if (!Array.isArray(times) || !Array.isArray(values) || times.length !== values.length) {
    throw new Error(`Open-Meteo flood API for ${region.name} returned no usable daily arrays`)
  }
  const daily = times.map((date, i) => ({
    date,
    river_discharge_m3s: readMeasurement(values[i]),
  }))
  const valid = daily.filter((d) => d.river_discharge_m3s !== null)
  if (!valid.length) {
    // Absence here is a fact about the grid cell, not a transient failure:
    // no river reach in the GloFAS grid at this point, so there is no
    // discharge label to train on. Recorded as an error, never as a
    // record of zeros.
    throw new Error(`no GloFAS river reach at this grid cell (no non-null daily discharge across ${daily.length} days)`)
  }
  return {
    id: stableId('climate', [SOURCE, region.name, startDate, endDate]),
    source: SOURCE,
    source_id: `${SOURCE}:${region.name}:${startDate}:${endDate}`,
    region_name: region.name,
    country: region.country,
    latitude: Number(region.lat),
    longitude: Number(region.lon),
    observed_at: `${daily[daily.length - 1]?.date || endDate}T00:00:00.000Z`,
    series_start: daily[0]?.date || startDate,
    series_end: daily[daily.length - 1]?.date || endDate,
    series_days: daily.length,
    discharge_first_valid: valid[0].date,
    discharge_last_valid: valid[valid.length - 1].date,
    discharge_days: valid.length,
    days_missing_discharge: daily.length - valid.length,
    daily,
    precipitation_mm: null,
    temperature_c: null,
    metadata: {
      provider: 'Open-Meteo flood API (GloFAS v4)',
      attribution: 'GloFAS v4 river discharge via flood-api.open-meteo.com, keyless',
      granularity: 'point, daily, whole record',
      granularity_note: 'Discharge at the river reach underlying the district reference point. Modelled hydrology, not gauge measurements; values before the first valid day are absent reach coverage, not zero flow.',
      staleness_note: `Series ends ${daily[daily.length - 1]?.date || endDate}.`,
      model_limit: 'Modelled river discharge (GloFAS v4). Reanalysis to July 2022, seamlessly continued by the operational run. Not gauge observations; a cell without a river reach returns null throughout and is refused rather than stored.',
      fetched_at: new Date().toISOString(),
    },
  }
}

async function fetchAllRegions(regions, startDate, endDate, fetchOptions) {
  const records = []
  const errors = []
  for (const region of regions) {
    try {
      records.push(await fetchRegion(region, startDate, endDate, fetchOptions))
    } catch (error) {
      errors.push(`${SOURCE}: ${region.name}: ${error.message}`)
    }
  }
  return { records, errors }
}

async function connectorIngest(options = {}) {
  const regions = options.regions?.length ? options.regions : DEFAULT_REGIONS
  const timeoutMs = options.timeout_ms || 60000
  const retries = options.retries ?? 2
  const now = options.now ? new Date(options.now) : new Date()
  const chunkDays = chunkDaysFrom(options.flood_chunk_days, CHUNK_DAYS)
  const persist = typeof options.on_watermark_state === 'function' ? options.on_watermark_state : null
  const fetchOptions = { timeoutMs, retries }

  const plan = planRun({ options, state: watermarkStateFrom(options), now })
  const climate_observations = []
  const errors = []
  const windows = []
  let state = plan.state

  // Caught up with the mark: no request goes out, so no id is computed and the
  // store is left exactly as it was.
  if (plan.kind === 'skip') {
    return {
      climate_observations,
      errors,
      watermark_state: state,
      watermark: {
        source: SOURCE,
        mode: 'empty',
        reason: plan.reason,
        as_of: plan.asOf,
        start_date: null,
        end_date: null,
        windows: 0,
        chunks: 0,
      },
    }
  }

  if (plan.kind === 'window' || plan.kind === 'explicit') {
    const { startDate, endDate } = plan.window
    const outcome = await fetchAllRegions(regions, startDate, endDate, fetchOptions)
    climate_observations.push(...outcome.records)
    errors.push(...outcome.errors)
    windows.push({ startDate, endDate })
    // The mark moves only on a clean window. A mark that advances past a failed
    // fetch is worse than no mark: the region it missed is never requested
    // again, and nothing reports the hole.
    if (plan.kind === 'window' && !outcome.errors.length) {
      state = advanceWatermark(state, SOURCE, {
        cursor: endDate,
        recordDate: endDate,
        at: now.toISOString(),
      })
    }
    return {
      climate_observations,
      errors,
      watermark_state: state,
      watermark: {
        source: SOURCE,
        mode: plan.kind,
        reason: plan.reason,
        as_of: plan.asOf,
        start_date: startDate,
        end_date: endDate,
        windows: windows.length,
        chunks: 1,
      },
    }
  }

  let chunks = 0
  for (;;) {
    const outstanding = resumeBackfill(state, SOURCE)
    if (!outstanding) break
    const startDate = outstanding.from
    const endDate = chunkEnd(startDate, chunkDays, outstanding.to)
    const outcome = await fetchAllRegions(regions, startDate, endDate, fetchOptions)
    climate_observations.push(...outcome.records)
    errors.push(...outcome.errors)
    windows.push({ startDate, endDate })
    chunks += 1
    // A chunk completes only when every region in it came back. One region down
    // means that region's window is missing, and advancing past it would skip
    // it permanently. `in_progress` is left untouched on this path so the next
    // run resumes at this same chunk.
    if (outcome.errors.length) break
    state = advanceBackfill(state, SOURCE, { cursor: endDate, at: now.toISOString() })
    if (persist) persist(state)
  }

  if (readWatermark(state, SOURCE)?.in_progress && !resumeBackfill(state, SOURCE)) {
    state = completeBackfill(state, SOURCE, { at: now.toISOString() })
  }
  const entry = readWatermark(state, SOURCE)
  return {
    climate_observations,
    errors,
    watermark_state: state,
    watermark: {
      source: SOURCE,
      mode: 'backfill',
      reason: plan.reason,
      as_of: plan.asOf,
      start_date: windows[0]?.startDate ?? null,
      end_date: windows[windows.length - 1]?.endDate ?? null,
      windows: windows.length,
      chunks,
      in_progress: entry?.in_progress ?? null,
    },
  }
}

export const spec = defineConnector({
  id: SOURCE,
  description: 'Open-Meteo flood API daily GloFAS v4 river discharge (modelled reanalysis, 1984 onward), watermarked and incrementally resumed, backfill source for discharge-labelled flood-probability training',
  schema: {
    requestSchema: {
      regions: 'array of {name, country, lat, lon} (default the pilot regions)',
      flood_start_date: "date (default '1984-01-01', or the resume cursor when one is stored)",
      flood_end_date: 'date (default today, or one day past the stored mark; pinning it fetches exactly that window and moves no cursor)',
      watermark_state: 'object: the stored watermarks.js state for this source; absent means "never run" and opens a chunked backfill from the series floor',
      on_watermark_state: 'function: called with the new state after every completed backfill chunk, so an interrupted crawl resumes instead of restarting',
      now: 'date (default the clock; injected so the window is testable)',
      flood_chunk_days: 'number (default 365): backfill chunk size in days',
      timeout_ms: 'number (default 60000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      climate_observations: 'one record per region with a river reach, carrying the whole daily discharge array; regions without a reach are refused as errors',
      watermark_state: 'object: the state to persist and hand back on the next run',
      watermark: 'object: what this run fetched and why — mode, reason, window, chunk count',
    },
  },
  defaults: {
    timeout_ms: 60000,
    retry: { max: 2, backoffMs: 1000 },
  },
  source: 'Open-Meteo (GloFAS v4 river discharge)',
  license: 'Open-Meteo attribution required: CC BY 4.0, per open-meteo.com terms',
  ingest: connectorIngest,
})

export const openMeteoFloodConnector = spec