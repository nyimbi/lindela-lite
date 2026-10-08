import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  PILOT_FORECAST_REGIONS,
  WEATHER_STALE_AFTER_MINUTES,
  districtWeatherReport,
  openMeteoForecastConnector,
  spec,
} from '../src/connectors/open-meteo-forecast.js'
import { runAssertions } from '../src/assertions.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** An Open-Meteo forecast response with the fields this connector reads. */
function forecastResponse(over = {}) {
  return {
    current: { time: '2026-10-07T08:15', temperature_2m: 31.4, precipitation: 0, weather_code: 2 },
    daily: {
      time: ['2026-10-07', '2026-10-08', '2026-10-09'],
      temperature_2m_max: [33.1, 32.8, 34.0],
      precipitation_sum: [4.2, 0, 11.7],
      precipitation_probability_max: [60, 10, 80],
      weather_code: [61, 1, 63],
    },
    ...over,
  }
}

function mockFetchJson(body) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify(body),
    json: async () => body,
  })
}

describe('open_meteo_forecast connector', () => {
  it('fetches current conditions and the daily forecast per district', async () => {
    mockFetchJson(forecastResponse())
    const result = await openMeteoForecastConnector.ingest({ regions: [PILOT_FORECAST_REGIONS[0]], retries: 0 })
    assert.equal(result.errors.length, 0)
    // One current record plus three daily records.
    assert.equal(result.weather_forecasts.length, 4)
    const [current, ...daily] = result.weather_forecasts
    assert.equal(current.source, 'open_meteo_forecast')
    assert.equal(current.type, 'weather_current')
    assert.equal(current.district, 'turkana')
    assert.equal(current.region_name, 'Turkana')
    assert.equal(current.temperature_c, 31.4)
    assert.equal(current.weather_code, 2)
    assert.ok(current.as_of, 'every record carries the forecast issue stamp')
    assert.equal(daily[0].type, 'weather_forecast_daily')
    assert.equal(daily[0].precipitation_mm, 4.2)
    assert.equal(daily[0].precipitation_probability_pct, 60)
    assert.equal(daily[0].weather_code, 61)
    assert.equal(daily[0].as_of, current.as_of, 'one batch, one issue stamp')
  })

  it('defaults to the five pilot districts and asks for local-time dates', async () => {
    const urls = []
    mockFetchJson(forecastResponse())
    globalThis.fetch = async (url) => {
      urls.push(String(url))
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(forecastResponse()), json: async () => forecastResponse() }
    }
    const result = await openMeteoForecastConnector.ingest({ retries: 0 })
    assert.equal(urls.length, 5, 'one request per pilot district')
    assert.equal(result.weather_forecasts.length, 20)
    for (const url of urls) {
      assert.ok(url.includes('api.open-meteo.com/v1/forecast'), url)
      assert.ok(url.includes('weather_code'), url)
      // Local dates: a UTC date rolls over at 03:00 East African time, so
      // "today's rain" would be wrong for a third of the morning.
      assert.ok(url.includes('timezone=Africa'), url)
    }
    assert.ok(urls.some((url) => url.includes('latitude=6.207')), 'Bor is requested')
  })

  it('preserves a missing day as null rather than reading it as 0 mm', async () => {
    mockFetchJson(forecastResponse({
      daily: {
        time: ['2026-10-07', '2026-10-08'],
        temperature_2m_max: [33.1, null],
        precipitation_sum: [4.2, null],
        precipitation_probability_max: [60, null],
        weather_code: [61, null],
      },
    }))
    const result = await openMeteoForecastConnector.ingest({ regions: [PILOT_FORECAST_REGIONS[0]], retries: 0 })
    const dayTwo = result.weather_forecasts.find((r) => r.observed_at === '2026-10-08')
    assert.equal(dayTwo.precipitation_mm, null)
    assert.equal(dayTwo.temperature_max_c, null)
    assert.equal(dayTwo.weather_code, null)
  })

  it('states the deterministic-forecast limit instead of inventing percentiles', async () => {
    mockFetchJson(forecastResponse())
    const result = await openMeteoForecastConnector.ingest({ regions: [PILOT_FORECAST_REGIONS[0]], retries: 0 })
    for (const record of result.weather_forecasts) {
      assert.match(record.model_limit, /Deterministic point forecast/)
      assert.equal(record.ensemble_p90, undefined, 'no percentile fields, invented or otherwise')
    }
  })

  it('reports an upstream failure per district instead of throwing', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) })
    const result = await openMeteoForecastConnector.ingest({ regions: [PILOT_FORECAST_REGIONS[0]], retries: 0 })
    assert.equal(result.weather_forecasts.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /Turkana/)
  })

  it('passes its own source assertions on a healthy batch', async () => {
    mockFetchJson(forecastResponse())
    const result = await openMeteoForecastConnector.ingest({ regions: [PILOT_FORECAST_REGIONS[0]], retries: 0 })
    const report = runAssertions({ source: 'open_meteo_forecast', records: result.weather_forecasts })
    assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2))
  })
})

describe('districtWeatherReport', () => {
  const NOW = new Date('2026-10-07T09:00:00.000Z')

  function rowsFor(slug, name, asOf, dailyDates = ['2026-10-07']) {
    const rows = [{
      id: `${slug}-current`, source: 'open_meteo_forecast', type: 'weather_current',
      region_name: name, district: slug, country: 'KE', latitude: 3.1, longitude: 35.6,
      observed_at: '2026-10-07T08:15', as_of: asOf,
      temperature_c: 31.4, precipitation_mm: 0, weather_code: 2,
    }]
    for (const date of dailyDates) {
      rows.push({
        id: `${slug}-${date}`, source: 'open_meteo_forecast', type: 'weather_forecast_daily',
        region_name: name, district: slug, country: 'KE', latitude: 3.1, longitude: 35.6,
        observed_at: date, as_of: asOf,
        precipitation_mm: 4.2, precipitation_probability_pct: 60, temperature_max_c: 33.1, weather_code: 61,
      })
    }
    return rows
  }

  it('rolls up one current reading and the daily forecast per district', () => {
    const report = districtWeatherReport(rowsFor('turkana', 'Turkana', '2026-10-07T06:00:00.000Z'), { now: NOW })
    assert.equal(report.districts.length, 5)
    const turkana = report.districts.find((d) => d.slug === 'turkana')
    assert.equal(turkana.as_of, '2026-10-07T06:00:00.000Z')
    assert.equal(turkana.stale, false)
    assert.equal(turkana.current.temperature_c, 31.4)
    assert.equal(turkana.forecast.length, 1)
    assert.equal(turkana.forecast[0].precipitation_mm, 4.2)
    assert.equal(report.districts_covered, 1)
    assert.equal(report.note, null)
  })

  it('keeps a district with no records present and null, with the absence stated', () => {
    const report = districtWeatherReport([], { now: NOW })
    assert.equal(report.districts.length, 5)
    assert.equal(report.districts_covered, 0)
    assert.match(report.note, /No weather observations ingested yet/)
    for (const d of report.districts) {
      assert.equal(d.current, null)
      assert.equal(d.as_of, null)
      assert.deepEqual(d.forecast, [])
    }
  })

  it('marks a district stale against the stale_after window', () => {
    const report = districtWeatherReport(
      rowsFor('turkana', 'Turkana', '2026-10-06T01:00:00.000Z'),
      { now: NOW },
    )
    const turkana = report.districts.find((d) => d.slug === 'turkana')
    assert.equal(turkana.stale, true)
    assert.equal(report.stale_after_minutes, WEATHER_STALE_AFTER_MINUTES)
  })

  it('groups a district by its latest issue stamp rather than splicing two runs', () => {
    // Two runs, the newer one having overwritten only the current record's
    // day — the shape a half-finished merge leaves. The report must pick one
    // issue, not the newest record per field.
    const rows = [
      ...rowsFor('turkana', 'Turkana', '2026-10-07T06:00:00.000Z', ['2026-10-08']),
      ...rowsFor('turkana', 'Turkana', '2026-10-05T06:00:00.000Z', ['2026-10-06']),
    ]
    const report = districtWeatherReport(rows, { now: NOW })
    const turkana = report.districts.find((d) => d.slug === 'turkana')
    assert.equal(turkana.as_of, '2026-10-07T06:00:00.000Z')
    assert.deepEqual(turkana.forecast.map((f) => f.date), ['2026-10-08'])
  })

  it('ignores records from other sources in the same collection', () => {
    const rows = [
      ...rowsFor('turkana', 'Turkana', '2026-10-07T06:00:00.000Z'),
      { id: 'other', source: 'open_meteo', type: 'current_weather', region_name: 'Turkana', district: 'turkana', observed_at: '2026-10-07T09:00', as_of: '2026-10-07T09:00:00.000Z', temperature_c: 99 },
    ]
    const report = districtWeatherReport(rows, { now: NOW })
    const turkana = report.districts.find((d) => d.slug === 'turkana')
    assert.equal(turkana.current.temperature_c, 31.4, 'the other source’s record must not win')
  })
})

describe('registration', () => {
  it('validates the spec and registers everywhere a source must be', async () => {
    const { validateConnector } = await import('../src/connectors/spec.js')
    assert.deepEqual(validateConnector(spec), [])
    assert.equal(spec.id, 'open_meteo_forecast')

    const schema = await import('../src/schema.js')
    assert.ok(schema.SOURCE_IDS.includes('open_meteo_forecast'))
    assert.ok(schema.publicSourceCatalog().find((s) => s.id === 'open_meteo_forecast').outputs.includes('weather_forecasts'))
    assert.ok(Array.isArray(schema.emptyStore().weather_forecasts), 'emptyStore must declare weather_forecasts')
    assert.ok(Array.isArray(schema.emptyStore().quarantine_weather_forecasts), 'and its quarantine home')

    const ingestion = await import('../src/ingestion.js')
    assert.equal(typeof ingestion.getConnector('open_meteo_forecast').ingest, 'function')
    assert.ok(ingestion.SOURCE_POLICIES.open_meteo_forecast.regular === true)
    assert.ok(ingestion.PUBLIC_INGESTION_SOURCES.includes('open_meteo_forecast'),
      'a short-lived forecast belongs on the regular schedule, not with the backfills')
    assert.ok(ingestion.OUTPUT_COLLECTIONS.includes('weather_forecasts'))

    const { RATE_LIMIT_POLICIES } = await import('../src/rate-limit.js')
    assert.ok(RATE_LIMIT_POLICIES.open_meteo_forecast, 'the registry declares a rate limit, so the policy table must hold one')

    const { COLLECTIONS } = await import('../src/store.js')
    assert.ok(COLLECTIONS.includes('weather_forecasts'))
    assert.ok(COLLECTIONS.includes('quarantine_weather_forecasts'))
  })

  it('keeps weather records out of the collections the flood-risk scorer sums', async () => {
    // The storage decision in one assertion: computeFloodRisk reads
    // climate_observations; this connector must not write there.
    assert.deepEqual(spec.schema.outputSchema.weather_forecasts ? [] : ['missing'], [])
    assert.equal(spec.schema.outputSchema.climate_observations, undefined)
  })
})
