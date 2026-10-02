import { fetchWithRetry } from './http.js'
import { DEFAULT_REGIONS } from '../schema.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'

/**
 * This connector reads a deterministic forecast, so it has no ensemble members to
 * report and must not imply that it has.
 *
 * It used to invent them. A spread of `0.25 + (1 - probability/100) * 0.75` was
 * applied to the single point value to manufacture p10/p50/p90, which were
 * published under exactly the field names a probabilistic forecast uses. At a
 * reported probability of 10% that made p90 roughly 1.9x the observed
 * precipitation, and the risk scorer preferred p90 over the point value — so the
 * flood risk score was inflated by an invented coefficient before it was even
 * scaled by precipitation * 1.5.
 *
 * Invented uncertainty is worse than none: it looks calibrated, it is
 * indistinguishable from a real ensemble downstream, and it moves a number
 * someone dispatches resources on. Probabilistic members require Open-Meteo's
 * ensemble endpoint and its real member set. Until that is wired up, the
 * observation states the limit and carries no percentiles.
 */
/**
 * Read a measurement, keeping "no reading" distinct from "a reading of zero".
 *
 * `Number(x || 0)` cannot tell those apart. A missing value became 0 mm of rain,
 * which reads downstream as a measured dry spell and lowers flood risk. A day the
 * API did not report — `?.[i]` past the end of a shorter array — likewise became
 * a confident zero. Absence is preserved so the risk scorer can treat it as
 * unknown, which reduces confidence, rather than as a measurement, which would
 * silently reduce the risk.
 */
// Exported so the archive connector keeps the same absence discipline: a
// missing day is null in both, and the model treats them the same way.
export function readMeasurement(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export const ENSEMBLE_MODEL_LIMIT =
  'Deterministic point forecast only; no ensemble members are produced. ' +
  'Percentile fields are absent because this connector does not fetch a probabilistic forecast.'

function withoutEnsemble() {
  return {
    ensemble_members: [],
    ensemble_p10: null,
    ensemble_p50: null,
    ensemble_p90: null,
    model_limit: ENSEMBLE_MODEL_LIMIT,
  }
}

async function openMeteoIngest(options = {}) {
    const regions = options.regions?.length ? options.regions : DEFAULT_REGIONS
    const climate_observations = []
    const errors = []
    const useEnsemble = options.include_ensemble && process.env.LINDELA_LITE_ENSEMBLE_ENABLED !== 'off'

    for (const region of regions) {
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast')
        url.searchParams.set('latitude', region.lat)
        url.searchParams.set('longitude', region.lon)
        url.searchParams.set('daily', 'precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min')
        url.searchParams.set('current', 'precipitation,temperature_2m,relative_humidity_2m')
        url.searchParams.set('forecast_days', String(options.forecast_days || 7))
        url.searchParams.set('timezone', 'UTC')

        // Note: ensemble endpoint would be different; for now fall back to deterministic
        const data = await fetchWithRetry(url, { timeoutMs: options.timeout_ms || 20000, retries: options.retries ?? 2, parse: 'json' })

        if (data.current) {
          climate_observations.push({
            id: stableId('climate', ['open_meteo_current', region, data.current.time]),
            source: 'open_meteo',
            type: 'current_weather',
            region_name: region.name,
            country: region.country,
            latitude: Number(region.lat),
            longitude: Number(region.lon),
            observed_at: data.current.time,
            precipitation_mm: readMeasurement(data.current.precipitation),
            temperature_c: readMeasurement(data.current.temperature_2m),
            humidity_pct: readMeasurement(data.current.relative_humidity_2m),
            ...withoutEnsemble(),
            metadata: { provider: 'Open-Meteo' },
          })
        }

        const daily = data.daily || {}
        for (let i = 0; i < (daily.time || []).length; i += 1) {
          const precip = readMeasurement(daily.precipitation_sum?.[i])
          climate_observations.push({
            id: stableId('climate', ['open_meteo_daily', region, daily.time[i]]),
            source: 'open_meteo',
            type: 'precipitation_forecast',
            region_name: region.name,
            country: region.country,
            latitude: Number(region.lat),
            longitude: Number(region.lon),
            observed_at: daily.time[i],
            precipitation_mm: precip,
            precipitation_probability_pct: readMeasurement(daily.precipitation_probability_max?.[i]),
            temperature_max_c: readMeasurement(daily.temperature_2m_max?.[i]),
            temperature_min_c: readMeasurement(daily.temperature_2m_min?.[i]),
            ...withoutEnsemble(),
            metadata: { provider: 'Open-Meteo', horizon: 'forecast' },
          })
        }
      } catch (error) {
        errors.push(`${region.name || region.lat}: ${error.message}`)
      }
    }

    return { climate_observations, errors }
}

export const spec = defineConnector({
  id: 'open_meteo',
  description: 'Open-Meteo weather forecasts and observations',
  schema: {
    requestSchema: {
      regions: 'array of {name, country, lat, lon}',
      forecast_days: 'number (default 7)',
      include_ensemble: 'boolean (default false)',
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      climate_observations: 'array of current and forecast weather observations',
    },
  },
  defaults: {
    rateLimit: { perMinute: 60 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: openMeteoIngest,
})

export const openMeteoConnector = {
  id: 'open_meteo',
  ingest: openMeteoIngest,
}
