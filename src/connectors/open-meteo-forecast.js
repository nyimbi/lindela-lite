import { fetchWithRetry } from './http.js'
import { KNOWN_DISTRICTS } from '../districts.js'
import { nowIso, stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { ENSEMBLE_MODEL_LIMIT, readMeasurement } from './open-meteo.js'

/**
 * Current conditions and the 7-day daily forecast for the five pilot districts,
 * from the keyless Open-Meteo forecast API. This is the map's weather overlay
 * feed — one current reading and seven daily forecast points per district.
 *
 * Why a second Open-Meteo connector, when `open_meteo` already fetches current
 * weather and a daily forecast:
 *
 *   - `open_meteo` defaults to DEFAULT_REGIONS (Turkana, Mogadishu, Juba), the
 *     regions the risk scorer was built around. The overlay needs the five
 *     pilot districts the map frames on, which are a different list — Bor,
 *     Aweil, Karamoja and Mandera are not in the default set.
 *   - The overlay needs the WMO `weather_code`, which the existing connector
 *     does not request.
 *   - Records land in `weather_forecasts`, not `climate_observations`. The
 *     flood-risk scorer sums `precipitation_mm` over every climate observation
 *     near a region, so the same atmosphere written twice under two source ids
 *     would be summed twice — a wetter Turkana than the one outside. The drift
 *     monitor and the seasonal strip read the same collection. A separate
 *     collection keeps the overlay out of every derivation it was never part
 *     of.
 *
 * The forecast is deterministic: one point value per variable per day, no
 * ensemble members. `src/connectors/open-meteo.js` documents why invented
 * percentiles are worse than none; the same discipline applies here, so the
 * percentile fields are absent and `model_limit` says why.
 *
 * Absence discipline is the one `readMeasurement` enforces everywhere: a day
 * the API did not report is null, never 0 mm — a missing forecast reading as a
 * measured dry spell is the exact conflation that lowers a risk score on no
 * evidence.
 */

const SOURCE = 'open_meteo_forecast'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/**
 * How old a forecast may be before the map stops showing it.
 *
 * Matches the source's ingestion policy (stale_after_minutes: 360). The endpoint
 * repeats the number in its response and the console re-derives staleness from
 * `as_of` against it, because a service-worker cache hit can be hours old and
 * the server-computed flag on it would describe the moment it was cached, not
 * now.
 */
export const WEATHER_STALE_AFTER_MINUTES = 360

/** The pilot districts as forecast request points. Center coordinates, [lat, lon]. */
export const PILOT_FORECAST_REGIONS = Object.freeze(
  KNOWN_DISTRICTS.map((d) => Object.freeze({
    slug: d.slug,
    name: d.name,
    country: d.country,
    lat: d.center.lat,
    lon: d.center.lon,
  })),
)

async function openMeteoForecastIngest(options = {}) {
  const regions = options.regions?.length ? options.regions : PILOT_FORECAST_REGIONS
  const weather_forecasts = []
  const errors = []

  for (const region of regions) {
    // One as-of per district per run: the current block and the seven daily
    // points are one forecast issue, and the report groups a district's latest
    // batch by this stamp. Mixing stamps across days would present two forecast
    // issues as one.
    const asOf = nowIso()
    try {
      const url = new URL(FORECAST_URL)
      url.searchParams.set('latitude', region.lat)
      url.searchParams.set('longitude', region.lon)
      url.searchParams.set('current', 'temperature_2m,precipitation,weather_code')
      url.searchParams.set('daily', 'temperature_2m_max,precipitation_sum,precipitation_probability_max,weather_code')
      url.searchParams.set('forecast_days', String(options.forecast_days || 7))
      // Local dates, not UTC: "today's rain" on the map must be the district's
      // today, and a UTC date rolls over at 03:00 East African time.
      url.searchParams.set('timezone', 'Africa/Nairobi')

      const data = await fetchWithRetry(url, {
        timeoutMs: options.timeout_ms || 20000,
        retries: options.retries ?? 2,
        parse: 'json',
        source: options.source,
      })

      if (data.current) {
        weather_forecasts.push({
          id: stableId('weather', [SOURCE, 'current', region.slug || region.name, data.current.time]),
          source: SOURCE,
          type: 'weather_current',
          region_name: region.name,
          district: region.slug || null,
          country: region.country,
          latitude: Number(region.lat),
          longitude: Number(region.lon),
          observed_at: data.current.time,
          as_of: asOf,
          temperature_c: readMeasurement(data.current.temperature_2m),
          precipitation_mm: readMeasurement(data.current.precipitation),
          weather_code: readMeasurement(data.current.weather_code),
          model_limit: ENSEMBLE_MODEL_LIMIT,
          metadata: { provider: 'Open-Meteo', horizon: 'now' },
        })
      }

      const daily = data.daily || {}
      for (let i = 0; i < (daily.time || []).length; i += 1) {
        weather_forecasts.push({
          // Keyed on the day, not the run: a re-run re-issues the same seven
          // days, and merge-by-id refreshes them in place instead of
          // accumulating every forecast ever issued for the same date.
          id: stableId('weather', [SOURCE, 'daily', region.slug || region.name, daily.time[i]]),
          source: SOURCE,
          type: 'weather_forecast_daily',
          region_name: region.name,
          district: region.slug || null,
          country: region.country,
          latitude: Number(region.lat),
          longitude: Number(region.lon),
          observed_at: daily.time[i],
          as_of: asOf,
          precipitation_mm: readMeasurement(daily.precipitation_sum?.[i]),
          precipitation_probability_pct: readMeasurement(daily.precipitation_probability_max?.[i]),
          temperature_max_c: readMeasurement(daily.temperature_2m_max?.[i]),
          weather_code: readMeasurement(daily.weather_code?.[i]),
          model_limit: ENSEMBLE_MODEL_LIMIT,
          metadata: { provider: 'Open-Meteo', horizon: 'forecast' },
        })
      }
    } catch (error) {
      errors.push(`${region.name || region.lat}: ${error.message}`)
    }
  }

  return { weather_forecasts, errors }
}

/**
 * The per-district view of the store the weather endpoint serves.
 *
 * Grouped by the connector's own `as_of` batch stamp rather than by recency
 * per record: a district's current reading and its seven daily points are one
 * forecast issue, and picking the newest record per field would splice two
 * issues together whenever a run half-overwrites the last.
 *
 * A district with no records comes back with nulls, not with an invented row:
 * the console draws nothing for it and says why, which it cannot do if the
 * endpoint simply omits the district.
 */
export function districtWeatherReport(records, { regions = PILOT_FORECAST_REGIONS, now = new Date(), staleAfterMinutes = WEATHER_STALE_AFTER_MINUTES } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const mine = (records || []).filter((r) => r?.source === SOURCE)

  const districts = regions.map((region) => {
    const rows = mine.filter((r) => (r.district || null) === region.slug
      || (r.district == null && r.region_name === region.name))
    const base = {
      slug: region.slug,
      name: region.name,
      country: region.country,
      latitude: region.lat,
      longitude: region.lon,
    }
    if (!rows.length) {
      return { ...base, as_of: null, stale: null, current: null, forecast: [] }
    }

    const asOf = rows.reduce((latest, r) => (r.as_of && r.as_of > latest ? r.as_of : latest), '')
    const batch = rows.filter((r) => r.as_of === asOf)
    const asOfMs = Date.parse(asOf)
    const stale = Number.isFinite(asOfMs) && Number.isFinite(nowMs)
      ? (nowMs - asOfMs) > staleAfterMinutes * 60 * 1000
      : null

    const currentRow = batch
      .filter((r) => r.type === 'weather_current')
      .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)))[0] || null
    const current = currentRow ? {
      observed_at: currentRow.observed_at,
      temperature_c: currentRow.temperature_c ?? null,
      precipitation_mm: currentRow.precipitation_mm ?? null,
      weather_code: currentRow.weather_code ?? null,
    } : null

    const forecast = batch
      .filter((r) => r.type === 'weather_forecast_daily')
      .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)))
      .slice(0, 7)
      .map((r) => ({
        date: r.observed_at,
        precipitation_mm: r.precipitation_mm ?? null,
        precipitation_probability_pct: r.precipitation_probability_pct ?? null,
        temperature_max_c: r.temperature_max_c ?? null,
        weather_code: r.weather_code ?? null,
      }))

    return { ...base, as_of: asOf || null, stale, current, forecast }
  })

  const covered = districts.filter((d) => d.current || d.forecast.length).length
  return {
    generated_at: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : nowIso(),
    source: SOURCE,
    stale_after_minutes: staleAfterMinutes,
    districts_covered: covered,
    // The absence is stated, not implied by an empty list: "no weather on the
    // map" must be traceable to "the source has never been run" rather than
    // reading as "no weather".
    note: covered === 0
      ? 'No weather observations ingested yet. Run the open_meteo_forecast source; until then nothing is shown.'
      : null,
    districts,
  }
}

export const spec = defineConnector({
  id: SOURCE,
  description: 'Open-Meteo current conditions and 7-day daily forecast per pilot district',
  schema: {
    requestSchema: {
      regions: 'array of {slug, name, country, lat, lon} (default the five pilot districts)',
      forecast_days: 'number (default 7)',
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      weather_forecasts: 'array of weather_current and weather_forecast_daily records, each carrying an as_of batch stamp',
    },
  },
  defaults: {
    rateLimit: { perMinute: 60 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: openMeteoForecastIngest,
})

export const openMeteoForecastConnector = {
  id: SOURCE,
  ingest: openMeteoForecastIngest,
}
