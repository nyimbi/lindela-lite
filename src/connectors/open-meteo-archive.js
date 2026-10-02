import { fetchWithRetry } from './http.js'
import { DEFAULT_REGIONS } from '../schema.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { readMeasurement } from './open-meteo.js'

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
 */

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'

function seriesStartDate(options) {
  if (options.archive_start_date) return String(options.archive_start_date)
  // CHIRPS/ERA5 archives start 1981/1940 respectively; 1981 is where the
  // combined record is meaningful for flood-climatology questions.
  return '1981-01-01'
}

async function connectorIngest(options = {}) {
  const climate_observations = []
  const errors = []
  const regions = options.regions?.length ? options.regions : DEFAULT_REGIONS
  const startDate = seriesStartDate(options)
  const endDate = options.archive_end_date ||
    new Date().toISOString().slice(0, 10)
  const timeoutMs = options.timeout_ms || 60000

  for (const region of regions) {
    try {
      const url = new URL(ARCHIVE_URL)
      url.searchParams.set('latitude', String(region.lat))
      url.searchParams.set('longitude', String(region.lon))
      url.searchParams.set('start_date', startDate)
      url.searchParams.set('end_date', endDate)
      url.searchParams.set('daily', 'precipitation_sum')
      url.searchParams.set('timezone', 'UTC')
      const text = await fetchWithRetry(url.toString(), { timeoutMs, retries: options.retries ?? 2, parse: 'text' })
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
      climate_observations.push({
        id: stableId('climate', ['open_meteo_archive', region.name, startDate, endDate]),
        source: 'open_meteo_archive',
        source_id: `open_meteo_archive:${region.name}:${startDate}:${endDate}`,
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
      })
    } catch (error) {
      errors.push(`open_meteo_archive: ${region.name}: ${error.message}`)
    }
  }

  return { climate_observations, errors }
}

export const spec = defineConnector({
  id: 'open_meteo_archive',
  description: 'Open-Meteo ERA5 historical daily precipitation (1981 onward), backfill source for flood-probability training',
  schema: {
    requestSchema: {
      regions: 'array of {name, country, lat, lon} (default the pilot regions)',
      archive_start_date: "date (default '1981-01-01')",
      archive_end_date: 'date (default today)',
      timeout_ms: 'number (default 60000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      climate_observations: 'one record per region carrying the whole daily precipitation array',
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