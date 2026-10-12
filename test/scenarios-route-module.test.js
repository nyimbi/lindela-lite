import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleScenarioRoute, matchScenarioRoute } from '../src/routes/scenarios.js'

/**
 * ARC-01 — the scenario family as a module, asserted where it now lives.
 *
 * The property that makes these two routes one module is the token round trip:
 * the token a create mints is the token a retrieve decodes. A change to the
 * encoder a decoder did not match would make every shared scenario URL a 400,
 * which is why the two branches are read together. That is what this asserts.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
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

const makeReq = (method, body) => ({
  method,
  headers: {},
  __auth: { subject: 'tester' },
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

const call = (route, { data = {}, method = 'GET', body } = {}) => {
  const res = fakeResponse()
  return handleScenarioRoute(route, { data, res, jsonResponse, req: makeReq(method, body) })
    .then((handled) => ({ handled, res }))
}

describe('ARC-01 — matchScenarioRoute', () => {
  it('matches the collection and the token form', () => {
    assert.deepEqual(matchScenarioRoute('/api/v1/scenarios'), { kind: 'create' })
    assert.deepEqual(matchScenarioRoute('/api/v1/scenarios/abc123'), { kind: 'retrieve', token: 'abc123' })
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/scenarios/', '/api/v1/scenarios/a/b', '/api/v1/scenario', '']) {
      assert.equal(matchScenarioRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

/** A store the scenario engine can run over: the four collections it reads. */
const scenarioData = () => ({
  climate_observations: [
    { id: 'c1', source: 'open_meteo', type: 'precipitation_forecast', latitude: 3.1, longitude: 35.6, country: 'KE', region_name: 'Turkana', precipitation_mm: 42, precipitation_probability_pct: 80 },
  ],
  hazard_events: [
    { id: 'h1', source: 'gdacs', event_type: 'flood', severity: 'high', latitude: 3.2, longitude: 35.7, country: 'KE' },
  ],
  conflict_events: [
    { id: 'e1', source: 'conflict_csv', event_type: 'communal_tension', latitude: 3.15, longitude: 35.62, country: 'KE', fatalities: 1 },
  ],
  service_assets: [
    { id: 'a1', name: 'Clinic A', service_type: 'health', latitude: 3.13, longitude: 35.63, country: 'KE' },
  ],
})

describe('ARC-01 — the token a create mints is the token a retrieve decodes', () => {
  it('replays the same perturbation through the share token', async () => {
    const data = scenarioData()
    const perturbation = { precipitation_multiplier: 2 }

    const created = await call({ kind: 'create' }, { data, method: 'POST', body: perturbation })
    assert.equal(created.res.status, 201)
    const token = created.res.json().token
    assert.ok(token, 'the create minted no token')

    const retrieved = await call({ kind: 'retrieve', token }, { data })
    assert.equal(retrieved.res.status, 200, 'a token this module minted did not decode')
    assert.equal(retrieved.res.json().success, true)
    // The retrieve replays the perturbation the token carries, so the two runs
    // differ only in the create's extra `token` — the round trip, which is the
    // whole point of the family.
    const createdKeys = Object.keys(created.res.json()).filter((k) => k !== 'token').sort()
    assert.deepEqual(Object.keys(retrieved.res.json()).sort(), createdKeys,
      'the retrieve did not reproduce the create')
    // `runScenario` normalises the perturbation (filling the three empty
    // defaults), so the assertion is on the value that was actually sent rather
    // than on the raw object.
    assert.equal(retrieved.res.json().perturbation.precipitation_multiplier, 2,
      'the perturbation did not survive the token')
  })

  it('accepts a perturbation nested under `perturbation` as well as bare', async () => {
    const data = scenarioData()
    const bare = await call({ kind: 'create' }, { data, method: 'POST', body: { precipitation_multiplier: 2 } })
    const nested = await call({ kind: 'create' }, { data, method: 'POST', body: { perturbation: { precipitation_multiplier: 2 } } })
    assert.equal(bare.res.json().token, nested.res.json().token, 'the two spellings produced different tokens')
  })

  it('answers 400 for a token that is not a scenario', async () => {
    const { res } = await call({ kind: 'retrieve', token: 'not-a-real-token' }, { data: {} })
    assert.equal(res.status, 400, 'a malformed share link was not refused as a client error')
    assert.equal(res.json().success, false)
  })

  it('declines a kind whose verb does not match, so the dispatcher 404s', async () => {
    const { handled, res } = await call({ kind: 'create' }, { method: 'GET' })
    assert.equal(handled, false)
    assert.equal(res.status, null, 'a wrong verb wrote a response')
  })
})
