import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleFieldSignalRoute, matchFieldSignalRoute } from '../src/routes/field-signals.js'

/**
 * ARC-01 — the field-signal family as a module, asserted where it now lives.
 *
 * Four collections that arrive from outside the console, each with a list route,
 * a write route, and a summary computed over the whole set rather than the page.
 * The end-to-end behaviour is covered through the server by
 * `test/field-outcomes.test.js` and the field-signal suites; what those cannot
 * see is the two properties that make the family a module:
 *
 *   - the matcher is method-aware. Three of these paths serve a GET and a POST
 *     that are different handlers, so a matcher that ignored the verb would route
 *     a POST to the list handler and answer a read for a write.
 *   - the map layer's coordinate test is `Number.isFinite(record.latitude)`,
 *     never `Number.isFinite(Number(record.latitude))`. `Number(null) === 0` is
 *     finite, and that coercion once planted every alert of a CAP feed on Null
 *     Island. This is the same shape, and it is asserted here rather than trusted
 *     to stay correct through the next edit.
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

const call = (route, { data = {}, store = {}, search = '', method = 'GET' } = {}) => {
  const res = fakeResponse()
  return handleFieldSignalRoute(route, {
    store, data, res,
    req: { method, __auth: { subject: 'tester', partner_org: null } },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

describe('ARC-01 — matchFieldSignalRoute is method-aware', () => {
  it('matches every list and write route the family owns', () => {
    const expected = [
      ['/api/v1/disease-observations', 'GET', 'disease-observations'],
      ['/api/v1/disease-observations/summary', 'GET', 'disease-summary'],
      ['/api/v1/field-outcomes', 'GET', 'field-outcomes'],
      ['/api/v1/field-outcomes/summary', 'GET', 'field-outcomes-summary'],
      ['/api/v1/community-feedback/summary', 'GET', 'feedback-summary'],
      ['/api/v1/community-feedback', 'GET', 'feedback-list'],
      ['/api/v1/community-feedback', 'POST', 'feedback-create'],
      ['/api/v1/school-attendance', 'GET', 'school-list'],
      ['/api/v1/school-attendance', 'POST', 'school-create'],
      ['/api/v1/iot-observations', 'GET', 'iot-list'],
      ['/api/v1/iot-observations', 'POST', 'iot-create'],
    ]
    for (const [pathname, method, kind] of expected) {
      assert.deepEqual(matchFieldSignalRoute(pathname, method), { kind }, `${method} ${pathname} did not match as ${kind}`)
    }
    assert.equal(new Set(expected.map((e) => e[2])).size, expected.length, 'two kinds collide')
  })

  it('routes a shared path by verb, not by path alone', () => {
    // Three paths serve a GET and a POST that are different handlers. A matcher
    // that ignored the verb would send a POST to the list handler, which answers
    // a 200 for a write that never happened — the silent-ignore class in its
    // worst form, because the caller believes the record was stored.
    for (const pathname of ['/api/v1/community-feedback', '/api/v1/school-attendance', '/api/v1/iot-observations']) {
      const get = matchFieldSignalRoute(pathname, 'GET')
      const post = matchFieldSignalRoute(pathname, 'POST')
      assert.ok(get && post, `${pathname} lost one of its two verbs`)
      assert.notEqual(get.kind, post.kind, `${pathname} routed GET and POST to the same handler`)
    }
  })

  it('does not match a near miss or an unsupported verb', () => {
    for (const pathname of [
      '/api/v1/disease-observations/',
      '/api/v1/community-feedbacks',
      '/api/v1/iot-observations/map',
      '/api/v1/school-attendance/summary',
      '',
    ]) {
      assert.equal(matchFieldSignalRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
    assert.equal(matchFieldSignalRoute('/api/v1/field-outcomes', 'POST'), null, 'a read-only route accepted a write')
    assert.equal(matchFieldSignalRoute('/api/v1/disease-observations/summary', 'POST'), null)
  })
})

describe('ARC-01 — the map layer refuses a coordinate it cannot trust', () => {
  it('drops a record whose latitude is null rather than placing it at zero', async () => {
    // `Number(null) === 0`, and 0/0 is Null Island. The coercion is the whole
    // defect: a record with no location is not a record at the equator, and a
    // map that draws it there is lying about where the outbreak is.
    const data = {
      disease_observations: [
        { id: 'd1', disease: 'cholera', latitude: 3.1, longitude: 35.6, observed_at: '2026-01-02T00:00:00Z' },
        { id: 'd2', disease: 'cholera', latitude: null, longitude: null, observed_at: '2026-01-01T00:00:00Z' },
        { id: 'd3', disease: 'measles', latitude: 0, longitude: 0, observed_at: '2026-01-03T00:00:00Z' },
        { id: 'd4', disease: 'measles', latitude: '', longitude: '  ', observed_at: '2026-01-03T00:00:00Z' },
        { id: 'd5', disease: 'measles', latitude: '3.12', longitude: '35.60', observed_at: '2026-01-04T00:00:00Z' },
      ],
    }
    const { res } = await call({ kind: 'disease-observations' }, { data, search: '?map=1' })
    const body = res.json()
    assert.equal(res.status, 200)
    // d2 (null) and d4 (empty/whitespace) are absent — `Number('')` and
    // `Number('  ')` are 0 too, the same trap by a different spelling. d3 is a
    // genuine 0/0 reading and d5 arrived as text from a connector and is a real
    // coordinate; both stay. A filter that dropped every falsy coordinate would
    // pass on d2/d4 and wrongly lose d3, and one written as raw
    // `Number.isFinite` would wrongly lose d5.
    assert.deepEqual(body.data.map((r) => r.id), ['d1', 'd3', 'd5'],
      'the map placed a record with no coordinates, or dropped a real one')
    const zero = body.data.find((r) => r.id === 'd3')
    assert.deepEqual([zero.latitude, zero.longitude], [0, 0], 'a genuine 0/0 reading was coerced away')
    const textual = body.data.find((r) => r.id === 'd5')
    assert.deepEqual([textual.latitude, textual.longitude], [3.12, 35.6],
      'a coordinate that arrived as a numeric string was dropped')
  })

  it('folds the latest timestamp from undefined, not from a null seed', async () => {
    // `'2026…' > 'null'` is alphabetically false, so folding against a null seed
    // loses every record and the header reports no time at all.
    const data = {
      disease_observations: [
        { id: 'd1', latitude: 3, longitude: 35, observed_at: '2026-01-01T00:00:00Z' },
        { id: 'd2', latitude: 4, longitude: 36, observed_at: '2026-03-01T00:00:00Z' },
      ],
    }
    const { res } = await call({ kind: 'disease-observations' }, { data, search: '?map=1' })
    assert.equal(res.json().as_of, '2026-03-01T00:00:00Z')
  })

  it('draws the latest reading per sensor, not every reading', async () => {
    const data = {
      iot_observations: [
        { id: 'i1', sensor_id: 's1', sensor_type: 'fridge', lat: 3.1, lon: 35.6, value: 4, observed_at: '2026-01-01T00:00:00Z' },
        { id: 'i2', sensor_id: 's1', sensor_type: 'fridge', lat: 3.1, lon: 35.6, value: 9, observed_at: '2026-02-01T00:00:00Z' },
        { id: 'i3', sensor_id: 's2', sensor_type: 'fridge', lat: null, lon: null, value: 5, observed_at: '2026-02-01T00:00:00Z' },
        // A gateway that omits `lat` entirely, which is the shape every fixture
        // in this repo has and the reason the Null Island bug was invisible.
        { id: 'i4', sensor_id: 's3', sensor_type: 'fridge', value: 6, observed_at: '2026-02-01T00:00:00Z' },
      ],
    }
    const { res } = await call({ kind: 'iot-list' }, { data, search: '?map=1' })
    const body = res.json()
    assert.equal(body.data.length, 1, 'the map drew more than the latest reading per sensor, or placed an unplaced one')
    assert.equal(body.data[0].id, 'i2', 'the map drew an older reading over a newer one')
    assert.deepEqual([body.data[0].lat, body.data[0].lon], [3.1, 35.6])
    assert.ok(body.data.every((r) => r.lat !== 0 && r.lon !== 0), 'an unplaced sensor was drawn at Null Island')
  })
})

describe('the iot summary refuses an unreadable breach threshold instead of answering zero', () => {
  // `Number('abc')` is NaN and `Number(row.value) > NaN` is false for every
  // row, so `?above=abc` reported 0 breaches — the parameter a cold-chain rule
  // narrows on answered "nothing breached" for a typo, and 0 is the reassuring
  // answer. `?above=` was the other half: `Number('')` is 0, so every reading
  // breached.
  const data = {
    iot_observations: [
      { id: 'i1', sensor_id: 's1', sensor_type: 'cold_chain', value: 3, observed_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', sensor_id: 's2', sensor_type: 'cold_chain', value: 12, observed_at: '2026-01-01T00:00:00Z' },
    ],
  }

  it('counts breaches above a readable threshold', async () => {
    const { res } = await call({ kind: 'iot-list' }, { data, search: '?sensor_type=cold_chain&above=8' })
    assert.equal(res.json().summary.breaches, 1)
  })

  it('throws a 400 for a threshold that is not a number', async () => {
    for (const bad of ['abc', 'eight', '8C', 'NaN']) {
      await assert.rejects(
        () => call({ kind: 'iot-list' }, { data, search: `?sensor_type=cold_chain&above=${bad}` }),
        (error) => error.statusCode === 400 && /above must be a number/.test(error.message),
        `above=${bad} was read as a threshold`,
      )
    }
  })

  it('treats a blank threshold as absent rather than as zero', async () => {
    const { res } = await call({ kind: 'iot-list' }, { data, search: '?sensor_type=cold_chain&above=' })
    assert.equal(res.json().summary.breaches, null, 'a blank threshold counted every reading as a breach')
  })

  it('leaves the threshold absent when it is not supplied', async () => {
    const { res } = await call({ kind: 'iot-list' }, { data, search: '?sensor_type=cold_chain' })
    assert.equal(res.json().summary.breaches, null)
  })
})

describe('ARC-01 — the module answers, or declines, without inventing a response', () => {
  it('returns false for a kind it does not own', async () => {
    const { handled, res } = await call({ kind: 'not-a-field-signal' }, {})
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned kind wrote a response')
  })

  it('serves the outcome summary with a refusal rather than a bare null', async () => {
    const { res } = await call({ kind: 'field-outcomes-summary' }, { data: { field_outcomes: [] } })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.total, 0)
    // A dashboard that receives `null` renders a dash, and a dash reads as "the
    // response time is zero" or "we have no data". The refusal has to be a
    // sentence, which is why `fieldActionLatency` returns one.
    assert.ok(body.refusal || body.reason || body.note || body.median_hours === null,
      'the summary answered a bare null where a refusal is owed')
  })

  it('lets a malformed body throw a 400 that the dispatcher answers, rather than swallowing it', async () => {
    const res = fakeResponse()
    // `readRawBody` consumes `for await (const chunk of req)`, so the double has
    // to be async-iterable.
    const req = {
      method: 'POST',
      __auth: { subject: 'tester' },
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('not json at all') },
    }
    // The module does NOT catch this. `readRequestJson` throws an error carrying
    // `statusCode: 400`, and the dispatcher's catch (server.js) maps that to the
    // client envelope. A module that wrapped the body read in a local try and
    // answered `err.statusCode || 400` itself would look the same from the
    // outside — which is why this asserts on the thrown status rather than on a
    // response the module never writes. The failure it rules out is a catch that
    // answered 500 for a body the caller can fix.
    await assert.rejects(
      () => handleFieldSignalRoute({ kind: 'iot-create' }, {
        store: {}, data: {}, res, req,
        url: new URL('http://127.0.0.1/api/v1/iot-observations'),
        jsonResponse,
      }),
      (err) => {
        assert.equal(err.statusCode, 400, 'a malformed body did not carry a client status')
        assert.match(err.message, /valid JSON/)
        return true
      },
    )
    assert.equal(res.status, null, 'the module wrote a response it should have let the dispatcher write')
  })

  it('refuses an empty batch rather than writing nothing and reporting success', async () => {
    const res = fakeResponse()
    const request = {
      method: 'POST',
      __auth: { subject: 'tester' },
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"readings":[]}') },
    }
    const handled = await handleFieldSignalRoute({ kind: 'iot-create' }, {
      store: {}, data: {}, res, req: request,
      url: new URL('http://127.0.0.1/api/v1/iot-observations'),
      jsonResponse,
    })
    assert.equal(handled, true)
    assert.equal(res.status, 400)
    assert.equal(res.json().success, false)
  })
})
