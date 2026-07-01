import { fetchWithRetry } from './http.js'
import { DEFAULT_REGIONS } from '../schema.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'

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
            precipitation_mm: Number(data.current.precipitation || 0),
            temperature_c: Number(data.current.temperature_2m || 0),
            humidity_pct: Number(data.current.relative_humidity_2m || 0),
            ensemble_members: [],
            ensemble_p10: 0,
            ensemble_p50: 0,
            ensemble_p90: 0,
            metadata: { provider: 'Open-Meteo' },
          })
        }

        const daily = data.daily || {}
        for (let i = 0; i < (daily.time || []).length; i += 1) {
          const precip = Number(daily.precipitation_sum?.[i] || 0)
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
            precipitation_probability_pct: Number(daily.precipitation_probability_max?.[i] || 0),
            temperature_max_c: Number(daily.temperature_2m_max?.[i] || 0),
            temperature_min_c: Number(daily.temperature_2m_min?.[i] || 0),
            ensemble_members: [],
            ensemble_p10: precip,
            ensemble_p50: precip,
            ensemble_p90: precip,
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
