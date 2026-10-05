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
 * Historical daily precipitation from the Open-Meteo ERA5 archive API, for
 * flood-probability training. Keyless, no licence gate.
 *
 * Verified live on 2026-10-02 at:
 *   https://archive-api.open-meteo.com/v1/archive?latitude=3.1167&longitude=35.6
 *     &start_date=1981-01-01&daily=precipitation_sum&timezone=UTC
 * (full 45-year daily series in one request)
 *
 * This is the rainfall half of the agreed empirical model basis. Rainfall
 * intensity and duration become statistics only against long validated
 * records — and the archive series is exactly such a record. The source is
 * ERA5 reanalysis, not an in-country gauge: the model docs say so everywhere,
 * because reanalysis rainfall in data-sparse regions is modelled, not
 * observed, and a gauge-like claim for it would be wrong.
 *
 * One record per region with the whole daily array is deliberate. The
 * alternative — a record per day — puts ~50,000 rows in the store for the
 * pilot regions alone. Rolling accumulation windows need the actual daily
 * sequence; nothing downstream needs those days as separate records.
 *
 * What this deliberately is not: a forecast. The series ends at the archive's
 * last complete day. Scoring future rainfall is the model's job, fed by its
 * own inputs.
 *
 * ── Where the watermark lives ───────────────────────────────────────────────
 * It does not live here, and it must not. `src/watermarks.js` is pure — state
 * in, state out, nothing stored — and this connector is `ingest(options)`, a
 * function with no memory between calls. There is no module-level Map in this
 * file on purpose: a Map that dies with the process is not a watermark, it is
 * a cache that makes the first test after a restart pass and the second
 * production run lie.
 *
 * So the watermark is the caller's, read and written across this boundary:
 *
 *   // in runIngestion (src/ingestion.js — not yet wired, see the report)
 *   const state = await loadWatermarkState(store)        // persists as you like
 *   const output = await connector.ingest({
 *     ...sourceRequest,
 *     watermark_state: state,
 *     on_watermark_state: (next) => saveWatermarkState(store, next),
 *   })
 *   await saveWatermarkState(store, output.watermark_state)
 *
 * `watermark_state` in, `watermark_state` out, and `on_watermark_state`
 * called after *every completed chunk* so a crawl that dies after three of
 * twelve chunks resumes at chunk four rather than at one. Without that
 * callback the in-process crawl still finishes, but only its final state
 * escapes, so an interrupted crawl restarts.
 *
 * Until ingestion.js passes those two options the connector sees an empty
 * state on every run and, correctly, walks the whole series again — the same
 * bytes under a new id. That is the honest cost of an unwired call site, and
 * the fix belongs in the caller, not in a global.
 */

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
const SOURCE = 'open_meteo_archive'

/** Where ERA5 combined with CHIRPS begins. Matches SERIES_FLOOR in watermarks.js. */
const SERIES_FLOOR = '1981-01-01'

/**
 * The lookback handed to `fetchWindow`.
 *
 * Wider than any series the module knows, because `fetchWindow` takes
 * `max(today - lookback, floor)`: a 45-year lookback evaluated in 2026 starts
 * at 1981-10-05 and silently drops the first nine months of the record on the
 * one run that was supposed to fetch all of it. Sixty years always lands on the
 * floor, now and in 2041.
 */
const SERIES_SPAN_DAYS = 60 * 365

/**
 * How much history one backfill chunk requests.
 *
 * Chunking is what makes the first crawl resumable — a 45-year walk is the
 * longest fetch in the system and the one most likely to be killed halfway —
 * but it trades one large request for many small ones. A year is a compromise:
 * small enough that an interrupted crawl loses at most a year, large enough
 * that a full backfill is ~45 requests rather than ~16,000. Operators who want
 * a single request pass `archive_chunk_days: 20000`.
 */
const CHUNK_DAYS = 365

const DAY_MS = 86400000

/** `end_date` minus `days - 1`, clamped to the job's end. ISO dates sort lexically. */
function chunkEnd(from, days, to) {
  const end = new Date(Date.parse(`${from}T00:00:00.000Z`) + (days - 1) * DAY_MS)
    .toISOString().slice(0, 10)
  return end < to ? end : to
}

/**
 * An explicitly configured window is a manual request, not an incremental run.
 *
 * Null-checked rather than coerced: `Number(null)` is 0, so a
 * `Number.isFinite(Number(value))` guard would accept a missing chunk size as
 * "zero days" and every other check would pass while the crawl stood still.
 */
function chunkDaysFrom(value, fallback) {
  if (value === undefined || value === null) return fallback
  const days = Number(value)
  if (!Number.isFinite(days) || days < 1) {
    throw new TypeError(`archive_chunk_days must be a positive number, got ${JSON.stringify(value)}`)
  }
  return Math.floor(days)
}

function watermarkStateFrom(options) {
  const state = options.watermark_state
  return state && typeof state === 'object' ? state : {}
}

/**
 * What this run should request, derived from the stored mark rather than from
 * the clock.
 *
 * Four shapes, and the order matters: an outstanding backfill outranks
 * everything, because a half-finished crawl that quietly restarts at 1981 is
 * the failure this whole arrangement exists to prevent.
 */
function planRun({ options, state, now }) {
  const pinnedEnd = options.archive_end_date
  if (pinnedEnd) {
    // Fetch exactly what was asked and move no cursor. Advancing the mark off a
    // three-day maintenance fetch would declare a 45-year series complete.
    return {
      kind: 'explicit',
      state,
      window: {
        startDate: options.archive_start_date ? String(options.archive_start_date) : SERIES_FLOOR,
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

  if (win.skip) return { kind: 'skip', state, window: { startDate: win.startDate, endDate: win.endDate }, win }
  if (win.mode === 'full') {
    // Never run before: open the crawl rather than request one 45-year window,
    // so the thing most likely to be interrupted is the thing that can resume.
    return {
      kind: 'backfill',
      state: beginBackfill(state, SOURCE, { from: win.startDate, to: win.endDate, at: now.toISOString() }),
      reason: win.reason,
      asOf: win.asOf,
      window: { startDate: win.startDate, endDate: win.endDate },
    }
  }
  return { kind: 'window', state, window: { startDate: win.startDate, endDate: win.endDate }, win }
}

/** One region, one window. Throws rather than reporting; the caller collects. */
async function fetchRegion(region, startDate, endDate, { timeoutMs, retries, source }) {
  const url = new URL(ARCHIVE_URL)
  url.searchParams.set('latitude', String(region.lat))
  url.searchParams.set('longitude', String(region.lon))
  url.searchParams.set('start_date', startDate)
  url.searchParams.set('end_date', endDate)
  url.searchParams.set('daily', 'precipitation_sum')
  url.searchParams.set('timezone', 'UTC')
  const text = await fetchWithRetry(url.toString(), { timeoutMs, retries, parse: 'text', source })
  const payload = JSON.parse(text)
  const times = payload?.daily?.time
  const values = payload?.daily?.precipitation_sum
  if (!Array.isArray(times) || !Array.isArray(values) || times.length !== values.length) {
    throw new Error(`Open-Meteo archive for ${region.name} returned no usable daily arrays`)
  }
  const daily = times.map((date, i) => ({
    date,
    precipitation_mm: readMeasurement(values[i]),
  }))
  const missing = daily.filter((d) => d.precipitation_mm === null).length
  return {
    id: stableId('climate', [SOURCE, region.name, startDate, endDate]),
    source: SOURCE,
    source_id: `${SOURCE}:${region.name}:${startDate}:${endDate}`,
    // One record per region. observed_at anchors the series end so stale
    // checks and ordering behave like other climate observations.
    region_name: region.name,
    country: region.country,
    latitude: Number(region.lat),
    longitude: Number(region.lon),
    observed_at: `${daily[daily.length - 1]?.date || endDate}T00:00:00.000Z`,
    series_start: daily[0]?.date || startDate,
    series_end: daily[daily.length - 1]?.date || endDate,
    series_days: daily.length,
    days_missing_precipitation: missing,
    daily,
    precipitation_mm: null,
    temperature_c: null,
    metadata: {
      provider: 'Open-Meteo archive (ERA5 reanalysis)',
      attribution: 'ERA5 reanalysis precipitation via archive-api.open-meteo.com, keyless',
      granularity: 'point, daily, whole archive',
      granularity_note: 'Reanalysis at the district headquarter point. District-scale flood response depends on local drainage, which a single point cannot resolve.',
      staleness_note: `Series ends ${daily[daily.length - 1]?.date || endDate}; a training series must state where it ends.`,
      model_limit: 'Reanalysis precipitation, not gauge observations. In data-sparse regions the reanalysis is partially model-informed; treat as the rainfall record available, with its limits stated.',
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
  const chunkDays = chunkDaysFrom(options.archive_chunk_days, CHUNK_DAYS)
  const persist = typeof options.on_watermark_state === 'function' ? options.on_watermark_state : null
  const fetchOptions = { timeoutMs, retries, source: options.source }

  const plan = planRun({ options, state: watermarkStateFrom(options), now })
  const climate_observations = []
  const errors = []
  const windows = []
  let state = plan.state

  // Nothing new since the mark. No request goes out, so no id is computed and
  // the store is left exactly as it was — which is the whole point of a
  // watermark derived from the mark rather than from the clock.
  if (plan.kind === 'skip') {
    return {
      climate_observations,
      errors,
      watermark_state: state,
      watermark: {
        source: SOURCE,
        mode: plan.win.mode,
        reason: plan.win.reason,
        as_of: plan.win.asOf,
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
    // Advance only on a clean window. A mark that moves past a fetch which
    // failed is worse than no mark at all: the missing region is never
    // requested again, and nothing anywhere reports the hole.
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
        mode: plan.kind === 'explicit' ? 'explicit' : (plan.win?.mode ?? 'window'),
        reason: plan.kind === 'explicit' ? 'operator-pinned-window' : (plan.win?.reason ?? null),
        as_of: plan.win?.asOf ?? null,
        start_date: startDate,
        end_date: endDate,
        windows: windows.length,
        chunks: 1,
      },
    }
  }

  // The backfill crawl. Each chunk is a window; each completed chunk moves the
  // cursor and is handed to the persist callback before the next one starts.
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
    // A chunk is complete when every region in it came back. One region down
    // means one region's year is missing, and advancing past it would skip
    // that year permanently. `in_progress` is deliberately left untouched on
    // this path: the next run finds it and resumes at this same chunk.
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
  description: 'Open-Meteo ERA5 historical daily precipitation (1981 onward), watermarked and incrementally resumed, backfill source for flood-probability training',
  schema: {
    requestSchema: {
      regions: 'array of {name, country, lat, lon} (default the pilot regions)',
      archive_start_date: "date (default '1981-01-01', or the resume cursor when one is stored)",
      archive_end_date: 'date (default today, or one day past the stored mark; pinning it fetches exactly that window and moves no cursor)',
      watermark_state: 'object: the stored watermarks.js state for this source; absent means "never run" and opens a chunked backfill from the series floor',
      on_watermark_state: 'function: called with the new state after every completed backfill chunk, so an interrupted crawl resumes instead of restarting',
      now: 'date (default the clock; injected so the window is testable)',
      archive_chunk_days: 'number (default 365): backfill chunk size in days',
      timeout_ms: 'number (default 60000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      climate_observations: 'one record per region carrying the whole daily precipitation array',
      watermark_state: 'object: the state to persist and hand back on the next run',
      watermark: 'object: what this run fetched and why — mode, reason, window, chunk count',
    },
  },
  defaults: {
    timeout_ms: 60000,
    retry: { max: 2, backoffMs: 1000 },
  },
  source: 'Open-Meteo (ERA5 reanalysis archive)',
  license: 'Open-Meteo attribution required: CC BY 4.0, per open-meteo.com terms',
  ingest: connectorIngest,
})

export const openMeteoArchiveConnector = spec