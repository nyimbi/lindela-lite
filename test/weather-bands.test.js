import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PRECIP_BANDS,
  TEMP_BANDS,
  WMO_WEATHER_CODES,
  precipBand,
  tempBand,
  weatherCodeLabel,
  weatherLayerView,
} from '../public/shared/weather-bands.js'

describe('precipitation bands', () => {
  it('treats 0 mm as a measured dry day, not as absence', () => {
    // The conflation this module exists to prevent: `0 || null` would read a
    // reported dry day as "not reported" and the glyph would go ungraded.
    const band = precipBand(0)
    assert.equal(band.key, 'dry')
    assert.equal(band.severity, 'low')
  })

  it('returns null for an unreported day, never the dry band', () => {
    assert.equal(precipBand(null), null)
    assert.equal(precipBand(undefined), null)
    assert.equal(precipBand(NaN), null)
    assert.equal(precipBand('4.2'), null)
    // A negative total is a parse failure, not weather.
    assert.equal(precipBand(-1), null)
  })

  it('bands totals at the operational cut points', () => {
    assert.equal(precipBand(0.5).key, 'dry')
    assert.equal(precipBand(0.51).key, 'light')
    assert.equal(precipBand(5).key, 'light')
    assert.equal(precipBand(5.01).key, 'moderate')
    assert.equal(precipBand(20).key, 'moderate')
    assert.equal(precipBand(20.01).key, 'heavy')
    assert.equal(precipBand(50).key, 'heavy')
    assert.equal(precipBand(50.01).key, 'extreme')
    assert.equal(precipBand(200).key, 'extreme')
  })

  it('maps each band onto the map severity vocabulary, strictly rising', () => {
    const order = ['low', 'medium', 'high', 'critical']
    const ranks = PRECIP_BANDS.map((band) => order.indexOf(band.severity))
    for (let i = 1; i < ranks.length; i += 1) {
      assert.ok(ranks[i] >= ranks[i - 1], `${PRECIP_BANDS[i].key} must not grade below ${PRECIP_BANDS[i - 1].key}`)
    }
  })

  it('produces strictly increasing, contiguous bands with no gap or overlap', () => {
    for (let i = 1; i < PRECIP_BANDS.length; i += 1) {
      assert.ok(
        PRECIP_BANDS[i].max > PRECIP_BANDS[i - 1].max,
        `band ${PRECIP_BANDS[i].key} must start above where ${PRECIP_BANDS[i - 1].key} stops`,
      )
    }
    assert.equal(PRECIP_BANDS[PRECIP_BANDS.length - 1].max, Number.POSITIVE_INFINITY)
  })
})

describe('temperature bands', () => {
  it('bands temperatures at the declared cut points', () => {
    assert.equal(tempBand(8).key, 'cool')
    assert.equal(tempBand(15).key, 'cool')
    assert.equal(tempBand(25).key, 'mild')
    assert.equal(tempBand(32).key, 'warm')
    assert.equal(tempBand(32.01).key, 'hot')
    assert.equal(tempBand(41).key, 'hot')
  })

  it('returns null for an unreported temperature', () => {
    assert.equal(tempBand(null), null)
    assert.equal(tempBand(undefined), null)
    assert.equal(tempBand(NaN), null)
    assert.equal(tempBand('31'), null)
  })
})

describe('WMO weather codes', () => {
  it('labels the codes the forecast API emits', () => {
    assert.equal(weatherCodeLabel(0), 'Clear sky')
    assert.equal(weatherCodeLabel(3), 'Overcast')
    assert.equal(weatherCodeLabel(61), 'Slight rain')
    assert.equal(weatherCodeLabel(95), 'Thunderstorm')
    assert.equal(weatherCodeLabel(99), 'Thunderstorm with heavy hail')
  })

  it('returns null for absent or unknown codes rather than guessing', () => {
    assert.equal(weatherCodeLabel(null), null)
    assert.equal(weatherCodeLabel(undefined), null)
    assert.equal(weatherCodeLabel(4), null, 'code 4 does not exist in WMO 4677')
    assert.equal(weatherCodeLabel(100), null)
    assert.equal(weatherCodeLabel(1.5), null)
  })

  it('covers exactly the codes WMO 4677 defines for this API', () => {
    const expected = [
      0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
      71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
    ]
    assert.deepEqual(Object.keys(WMO_WEATHER_CODES).map(Number).sort((a, b) => a - b), expected)
  })
})

const day = (date, over = {}) => ({
  date,
  precipitation_mm: 0,
  precipitation_probability_pct: 10,
  temperature_max_c: 33,
  weather_code: 1,
  ...over,
})

const districtPayload = (over = {}) => ({
  slug: 'turkana',
  name: 'Turkana',
  country: 'KE',
  latitude: 3.1167,
  longitude: 35.6,
  as_of: '2026-10-07T06:00:00.000Z',
  stale: false,
  current: { observed_at: '2026-10-07T08:15', temperature_c: 31.4, precipitation_mm: 0, weather_code: 2 },
  forecast: [day('2026-10-07', { precipitation_mm: 4.2, precipitation_probability_pct: 60 }), day('2026-10-08')],
  ...over,
})

describe('the weather layer render plan', () => {
  const NOW = Date.parse('2026-10-07T09:00:00.000Z')

  it('draws a district with fresh data, banded on today’s forecast total', () => {
    const view = weatherLayerView(
      { stale_after_minutes: 360, districts: [districtPayload()] },
      { now: NOW },
    )
    assert.equal(view.glyphs.length, 1)
    const glyph = view.glyphs[0]
    assert.equal(glyph.slug, 'turkana')
    assert.equal(glyph.precipBand.key, 'light')
    assert.equal(glyph.severity, 'low')
    assert.equal(glyph.temperatureC, 31.4)
    assert.equal(glyph.temperatureBand.key, 'warm')
    assert.equal(glyph.conditionLabel, 'Partly cloudy')
    assert.equal(glyph.todayPrecipitationMm, 4.2)
    assert.equal(glyph.todayProbabilityPct, 60)
  })

  it('withholds a stale district instead of presenting an old forecast as current', () => {
    const view = weatherLayerView(
      {
        stale_after_minutes: 360,
        districts: [districtPayload({ as_of: '2026-10-06T06:00:00.000Z', stale: true })],
      },
      { now: NOW },
    )
    assert.equal(view.glyphs.length, 0)
    assert.deepEqual(view.staleSlugs, ['turkana'])
  })

  it('re-derives staleness from as_of, ignoring the payload’s cached stale flag', () => {
    // A service-worker cache hit can carry `stale: false` computed hours ago.
    // The layer's honesty depends on recomputing against now.
    const view = weatherLayerView(
      {
        stale_after_minutes: 360,
        districts: [districtPayload({ as_of: '2026-10-06T01:00:00.000Z', stale: false })],
      },
      { now: NOW },
    )
    assert.equal(view.glyphs.length, 0)
    assert.deepEqual(view.staleSlugs, ['turkana'])
  })

  it('grades an unreported total as ungraded, not as dry', () => {
    const view = weatherLayerView(
      {
        stale_after_minutes: 360,
        districts: [districtPayload({
          forecast: [day('2026-10-07', { precipitation_mm: null, precipitation_probability_pct: null })],
        })],
      },
      { now: NOW },
    )
    assert.equal(view.glyphs.length, 1, 'current conditions still justify a glyph')
    assert.equal(view.glyphs[0].precipBand, null)
    assert.equal(view.glyphs[0].severity, 'ungraded')
  })

  it('counts a district with no records as missing rather than drawing nothing silently', () => {
    const view = weatherLayerView(
      {
        stale_after_minutes: 360,
        districts: [districtPayload(), districtPayload({ slug: 'bor', name: 'Bor', as_of: null, current: null, forecast: [] })],
      },
      { now: NOW },
    )
    assert.equal(view.glyphs.length, 1)
    assert.deepEqual(view.missingSlugs, ['bor'])
  })

  it('reports unavailable when the payload is not a weather report at all', () => {
    assert.equal(weatherLayerView(null).available, false)
    assert.equal(weatherLayerView({}).available, false)
    assert.equal(weatherLayerView({ districts: 'nonsense' }).available, false)
  })

  it('tracks the newest issue time across districts', () => {
    const view = weatherLayerView(
      {
        stale_after_minutes: 360,
        districts: [
          districtPayload(),
          districtPayload({ slug: 'aweil', name: 'Aweil', as_of: '2026-10-07T07:30:00.000Z' }),
        ],
      },
      { now: NOW },
    )
    assert.equal(view.asOf, '2026-10-07T07:30:00.000Z')
  })
})
