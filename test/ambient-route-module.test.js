import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleAmbientRoute, matchAmbientRoute } from '../src/routes/ambient.js'

/**
 * ENH-60 — the ambient-layer family as a module, asserted where it now lives.
 *
 * Three reads that feed the map overlay and the climate page, and the property
 * that makes them one family: they are the routes a *partner* reads, and the
 * overlay bands what it draws itself while a JSON consumer sees a bare number.
 * So the band travels with the figure, and the cut points are published once:
 *
 *   - `weather` carries a band per forecast day and a temperature band on the
 *     current block, with `precip_bands` / `temp_bands` as the audit surface;
 *   - `river-discharge` carries the band, its label and its severity, plus the
 *     `model_note` that says the series is modelled, not gauged;
 *   - a reported reading that matches no band is `band: 'unknown'` with a null
 *     maximum — a different state from "no reading", and the route says so.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.text = () => res.chunks.join('')
  res.json = () => JSON.parse(res.text())
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const call = (route, { data = {}, search = '' } = {}) => {
  const res = fakeResponse()
  const handled = handleAmbientRoute(route, {
    data, res,
    req: { method: 'GET', __auth: { subject: 'tester', partner_org: null } },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  })
  return Promise.resolve(handled).then((h) => ({ handled: h, res }))
}

describe('ENH-60 — matchAmbientRoute is a read-only family', () => {
  it('matches the three reads on GET', () => {
    assert.deepEqual(matchAmbientRoute('/api/v1/climate'), { kind: 'climate' })
    assert.deepEqual(matchAmbientRoute('/api/v1/weather'), { kind: 'weather' })
    assert.deepEqual(matchAmbientRoute('/api/v1/river-discharge'), { kind: 'river-discharge' })
  })

  it('refuses every write verb rather than serving a read on POST', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(matchAmbientRoute('/api/v1/climate', method), null,
        `a ${method} reached a read-only route`)
    }
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/climates', '/api/v1/weather/forecast', '/api/v1/discharge']) {
      assert.equal(matchAmbientRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-60 — the band travels with the number, and the cut points are published', () => {
  // The shape `districtWeatherReport` actually reads: one row per reading, keyed
  // by `type`, with the batch `as_of` on each. A `{ current, daily }` object
  // would test a record nothing ingests.
  const weather = (type, over = {}) => ({
    id: `${type}-1`, source: 'open_meteo_forecast', district: 'turkana',
    as_of: '2026-10-01T00:00:00Z', observed_at: '2026-10-01', type, ...over,
  })

  it('bands each forecast day and publishes the table once', async () => {
    const data = {
      weather_forecasts: [
        weather('weather_current', { temperature_c: 31, weather_code: 0 }),
        weather('weather_forecast_daily', { precipitation_mm: 40 }),
      ],
    }
    const { res } = await call({ kind: 'weather' }, { data })
    const body = res.json()
    const district = body.districts.find((d) => d.slug === 'turkana')
    assert.ok(district.forecast.length, 'the forecast row did not reach the roll-up')
    assert.ok(district.forecast[0].band, 'a forecast day published a rainfall total with no band')
    assert.ok(Array.isArray(body.precip_bands) && body.precip_bands.length > 0,
      'the cut points are not published, so a partner cannot audit the band without reading the repository')
    assert.ok(body.temp_bands.length > 0)
    assert.ok(district.current.temperature_band, 'the current block carries a temperature with no band')
  })

  it('states the absence of weather rather than answering an empty page', async () => {
    const { res } = await call({ kind: 'weather' }, { data: { weather_forecasts: [] } })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.districts_covered, 0)
    assert.match(body.note, /no weather observations/i,
      'an empty store answered with an empty page that reads as "no weather" rather than saying nothing was ingested')
  })
})

describe('ENH-60 — river-discharge rolls the series to one point per region', () => {
  const floodRecord = (region, days, over = {}) => ({
    region_name: region, latitude: 3, longitude: 35, source: 'open_meteo_flood',
    daily: days, metadata: { model_limit: 'modelled' }, ...over,
  })

  it('takes the latest day per region, not the last record ingested', async () => {
    const data = {
      climate_observations: [
        floodRecord('Turkana', [{ date: '2026-10-01', river_discharge_m3s: 10 }, { date: '2026-10-03', river_discharge_m3s: 30 }]),
        // The later record holds the *older* day, so insertion order would pick it.
        floodRecord('Turkana', [{ date: '2026-10-02', river_discharge_m3s: 99 }]),
      ],
    }
    const { res } = await call({ kind: 'river-discharge' }, { data })
    const row = res.json().data.find((d) => d.region_name === 'Turkana')
    assert.equal(row.as_of, '2026-10-03', 'the latest day was not taken, so a stale reading is drawn as current')
    assert.equal(row.river_discharge_m3s, 30)
  })

  it('breaks a same-day tie on the discharge rather than on insertion order', async () => {
    const data = {
      climate_observations: [
        floodRecord('Turkana', [{ date: '2026-10-03', river_discharge_m3s: 30 }]),
        floodRecord('Turkana', [{ date: '2026-10-03', river_discharge_m3s: 80 }]),
      ],
    }
    const { res } = await call({ kind: 'river-discharge' }, { data })
    assert.equal(res.json().data[0].river_discharge_m3s, 80)
  })

  it('carries the band, its severity and the modelled note with each reading', async () => {
    const data = { climate_observations: [floodRecord('Turkana', [{ date: '2026-10-03', river_discharge_m3s: 80 }])] }
    const { res } = await call({ kind: 'river-discharge' }, { data })
    const body = res.json()
    const row = body.data[0]
    assert.ok(row.band, 'a discharge reading travelled with no band')
    assert.ok(row.severity, 'the band travelled with no severity')
    assert.match(body.model_note, /modelled/i,
      'the reading is modelled and the payload does not say so')
    assert.ok(Array.isArray(body.bands) && body.bands.length > 0)
  })

  it('distinguishes a reading that matched no band from a region with no reading', async () => {
    const data = {
      climate_observations: [
        // The top band is unbounded (`max: null`), so a reading that matches no
        // band cannot be produced by a large number — it takes a negative one,
        // which `dischargeBand` refuses. A reported negative discharge is a
        // sensor fault, and it must read as ungraded rather than as a real band.
        floodRecord('Turkana', [{ date: '2026-10-03', river_discharge_m3s: -5 }]),
        floodRecord('Marsabit', [{ date: '2026-10-03', river_discharge_m3s: null }]),
      ],
    }
    const { res } = await call({ kind: 'river-discharge' }, { data })
    const body = res.json()
    const turkana = body.data.find((d) => d.region_name === 'Turkana')
    assert.equal(turkana.band, 'unknown', 'a reported reading that matched no band was banded anyway')
    assert.equal(turkana.band_max_m3s, null)
    assert.equal(body.data.find((d) => d.region_name === 'Marsabit'), undefined,
      'a region whose only reading was null appeared as a row')
  })

  it('answers an empty array with a note on a fresh deployment, not a 404', async () => {
    const { res } = await call({ kind: 'river-discharge' }, { data: { climate_observations: [] } })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(body.data, [])
    assert.match(body.note, /not gauged/i)
  })

  it('ignores a non-flood source, which is a different series', async () => {
    const data = {
      climate_observations: [floodRecord('Turkana', [{ date: '2026-10-03', river_discharge_m3s: 80 }], { source: 'open_meteo_archive' })],
    }
    const { res } = await call({ kind: 'river-discharge' }, { data })
    assert.deepEqual(res.json().data, [],
      'a rainfall series was rolled into the discharge view')
  })
})

describe('ENH-60 — climate is the raw series and pages', () => {
  it('pages, so a truncated series is distinguishable from a complete one', async () => {
    const data = {
      climate_observations: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, region_name: 'Turkana' })),
    }
    const { res } = await call({ kind: 'climate' }, { data, search: '?limit=2' })
    const body = res.json()
    assert.equal(body.returned, 2)
    assert.equal(body.total, 5)
    assert.equal(body.has_more, true)
  })
})
