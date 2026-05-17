import { DEFAULT_REGIONS } from '../schema.js'
import { stableId } from '../utils.js'

export const openMeteoConnector = {
  id: 'open_meteo',
  async ingest(options = {}) {
    const regions = options.regions?.length ? options.regions : DEFAULT_REGIONS
    const climate_observations = []
    const errors = []

    for (const region of regions) {
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast')
        url.searchParams.set('latitude', region.lat)
        url.searchParams.set('longitude', region.lon)
        url.searchParams.set('daily', 'precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min')
        url.searchParams.set('current', 'precipitation,temperature_2m,relative_humidity_2m')
        url.searchParams.set('forecast_days', String(options.forecast_days || 7))
        url.searchParams.set('timezone', 'UTC')

        const response = await fetch(url, { signal: AbortSignal.timeout(options.timeout_ms || 20000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()

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
            metadata: { provider: 'Open-Meteo' },
          })
        }

        const daily = data.daily || {}
        for (let i = 0; i < (daily.time || []).length; i += 1) {
          climate_observations.push({
            id: stableId('climate', ['open_meteo_daily', region, daily.time[i]]),
            source: 'open_meteo',
            type: 'precipitation_forecast',
            region_name: region.name,
            country: region.country,
            latitude: Number(region.lat),
            longitude: Number(region.lon),
            observed_at: daily.time[i],
            precipitation_mm: Number(daily.precipitation_sum?.[i] || 0),
            precipitation_probability_pct: Number(daily.precipitation_probability_max?.[i] || 0),
            temperature_max_c: Number(daily.temperature_2m_max?.[i] || 0),
            temperature_min_c: Number(daily.temperature_2m_min?.[i] || 0),
            metadata: { provider: 'Open-Meteo', horizon: 'forecast' },
          })
        }
      } catch (error) {
        errors.push(`${region.name || region.lat}: ${error.message}`)
      }
    }

    return { climate_observations, errors }
  },
}
