import { fetchWithRetry } from './http.js'
import { DEFAULT_REGIONS } from '../schema.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { readMeasurement } from './open-meteo.js'

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
 *   reaches; the Mogadishu point has none. A no-reach region comes back as
 *   an explicit error, not a null-wearing record.
 *
 * One record per region with the whole daily array mirrors the
 * open_meteo_archive connector, for the same reason: the discharge label is
 * defined per calendar month over the whole record, so downstream needs the
 * daily sequence, not per-day rows.
 */

const FLOOD_URL = 'https://flood-api.open-meteo.com/v1/flood'

// GloFAS v4 consolidated reanalysis starts 1984; the earliest reach values
// vary by cell, and this just bounds the request — nulls are kept as nulls.
function seriesStartDate(options) {
  if (options.flood_start_date) return String(options.flood_start_date)
  return '1984-01-01'
}

async function connectorIngest(options = {}) {
  const climate_observations = []
  const errors = []
  const regions = options.regions?.length ? options.regions : DEFAULT_REGIONS
  const startDate = seriesStartDate(options)
  const endDate = options.flood_end_date ||
    new Date().toISOString().slice(0, 10)
  const timeoutMs = options.timeout_ms || 60000

  for (const region of regions) {
    try {
      const url = new URL(FLOOD_URL)
      url.searchParams.set('latitude', String(region.lat))
      url.searchParams.set('longitude', String(region.lon))
      url.searchParams.set('start_date', startDate)
      url.searchParams.set('end_date', endDate)
      url.searchParams.set('daily', 'river_discharge')
      const text = await fetchWithRetry(url.toString(), { timeoutMs, retries: options.retries ?? 2, parse: 'text' })
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
        errors.push(`open_meteo_flood: ${region.name}: no GloFAS river reach at this grid cell (no non-null daily discharge across ${daily.length} days)`)
        continue
      }
      climate_observations.push({
        id: stableId('climate', ['open_meteo_flood', region.name, startDate, endDate]),
        source: 'open_meteo_flood',
        source_id: `open_meteo_flood:${region.name}:${startDate}:${endDate}`,
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
      })
    } catch (error) {
      errors.push(`open_meteo_flood: ${region.name}: ${error.message}`)
    }
  }

  return { climate_observations, errors }
}

export const spec = defineConnector({
  id: 'open_meteo_flood',
  description: 'Open-Meteo flood API daily GloFAS v4 river discharge (modelled reanalysis, 1984 onward), backfill source for discharge-labelled flood-probability training',
  schema: {
    requestSchema: {
      regions: 'array of {name, country, lat, lon} (default the pilot regions)',
      flood_start_date: "date (default '1984-01-01')",
      flood_end_date: 'date (default today)',
      timeout_ms: 'number (default 60000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      climate_observations: 'one record per region with a river reach, carrying the whole daily discharge array; regions without a reach are refused as errors',
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