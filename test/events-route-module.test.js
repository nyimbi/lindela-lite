import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleEventsRoute, matchEventsRoute, recentEvents } from '../src/routes/events.js'
import { emptyStore } from '../src/schema.js'

/**
 * ENH-60 — the events-and-assessments family as a module, asserted where it now
 * lives.
 *
 * The property that makes the two routes one family: `/api/v1/events` *is* the
 * merged hazard-and-conflict list, and `/api/v1/assessments` publishes that same
 * list as `recent_events`. Before the extraction the union expression was
 * written twice in the dispatcher — two copies of one expression, the VER-18
 * shape — and these tests pin the thing that made it a family: both routes read
 * `recentEvents()`, so "what counts as an event" is answered once.
 *
 * The other three assertions are the assessments roll-up's own history:
 * `recent_events` was the one list on the route that did not thread `auth`, so a
 * partner token read every event in the platform; `calibration` was exported,
 * documented in the JTBD catalogue, and called from nowhere. Both are asserted
 * through the handler now rather than through the catalogue.
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

// `counts()` and `operationalSummary()` walk the whole snapshot, so the fixture
// is a real empty store with the four collections under test filled in — not a
// hand-written subset, which would assert against a shape the server never
// produces.
const DATA = {
  ...emptyStore(),
  hazard_events: [{ id: 'h1', partner_org: 'orgA' }, { id: 'h2', partner_org: 'orgB' }],
  conflict_events: [{ id: 'c1', partner_org: 'orgA' }],
  risk_scores: [
    { id: 'r1', type: 'flood_risk', partner_org: 'orgA' },
    { id: 'r2', type: 'climate_conflict_risk', partner_org: 'orgB' },
  ],
}

const call = (route, { data = DATA, search = '', auth = { subject: 'tester', partner_org: null } } = {}) => {
  const res = fakeResponse()
  const handled = handleEventsRoute(route, {
    data, res,
    req: { method: 'GET', __auth: auth },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  })
  return { handled, res, body: () => res.json() }
}

describe('ENH-60 — matchEventsRoute is a read-only family', () => {
  it('matches both routes on GET', () => {
    assert.deepEqual(matchEventsRoute('/api/v1/events', 'GET'), { kind: 'events' })
    assert.deepEqual(matchEventsRoute('/api/v1/assessments', 'GET'), { kind: 'assessments' })
  })

  it('refuses every write verb', () => {
    // Both are reads. A POST must fall through to the surface's own 404/405
    // rather than being answered here — the VER-14 class.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/v1/events', '/api/v1/assessments']) {
        assert.equal(matchEventsRoute(path, method), null, `${method} ${path} matched`)
      }
    }
  })

  it('does not match a near-miss path', () => {
    for (const path of ['/api/v1/event', '/api/v1/events/1', '/api/v1/assessment', '/api/v1/assessments/']) {
      assert.equal(matchEventsRoute(path, 'GET'), null, `${path} matched`)
    }
  })
})

describe('ENH-60 — the two routes share one definition of an event', () => {
  it('recentEvents is the merged hazard-and-conflict list', () => {
    assert.deepEqual(recentEvents(DATA).map((e) => e.id), ['h1', 'h2', 'c1'])
  })

  it('/api/v1/events returns exactly the union, paged', () => {
    const { handled, body } = call(matchEventsRoute('/api/v1/events', 'GET'))
    assert.equal(handled, true)
    const ids = (body().data || body().rows || []).map((e) => e.id)
    assert.deepEqual(ids, ['h1', 'h2', 'c1'], 'the route must return the union and nothing else')
  })

  it('/api/v1/assessments publishes the same union as recent_events', () => {
    const { handled, body } = call(matchEventsRoute('/api/v1/assessments', 'GET'))
    assert.equal(handled, true)
    const ids = body().data.recent_events.map((e) => e.id)
    assert.deepEqual(ids, ['h1', 'h2', 'c1'],
      'recent_events and /api/v1/events must be the same list — one expression, not two')
  })
})

describe('ENH-60 — the assessments roll-up scopes what it publishes', () => {
  it('recent_events is scoped to the caller’s partner org', () => {
    // The defect this pins: `recent_events` was the one list on the route that
    // did not thread `auth`, so a partner token read every event in the
    // platform while the four lists beside it were filtered.
    const { body } = call(matchEventsRoute('/api/v1/assessments', 'GET'),
      { auth: { subject: 't', partner_org: 'orgA' } })
    const ids = body().data.recent_events.map((e) => e.id)
    assert.deepEqual(ids, ['h1', 'c1'], 'orgA must see only its own events, never orgB’s h2')
  })

  it('the sibling lists are scoped the same way', () => {
    const { body } = call(matchEventsRoute('/api/v1/assessments', 'GET'),
      { auth: { subject: 't', partner_org: 'orgA' } })
    const d = body().data
    assert.deepEqual(d.flood_risk.map((r) => r.id), ['r1'])
    assert.deepEqual(d.climate_conflict_risk.map((r) => r.id), [],
      'orgB’s climate_conflict_risk score must not reach an orgA token')
  })

  it('publishes calibration, over the scoped score list', () => {
    // `calibrationReport` was exported, documented in the JTBD catalogue as
    // evidence this route "includes calibration metadata", and called from
    // nowhere. It is called here now — and over the scoped list, so a partner
    // token learns mean confidence only over scores it can see.
    const { body } = call(matchEventsRoute('/api/v1/assessments', 'GET'),
      { auth: { subject: 't', partner_org: 'orgA' } })
    assert.ok('calibration' in body().data, 'the route must publish calibration, not merely export it')
    assert.notEqual(body().data.calibration, undefined)
  })

  it('publishes counts and an operational summary', () => {
    const { body } = call(matchEventsRoute('/api/v1/assessments', 'GET'))
    assert.ok(body().data.counts, 'counts is the head of the roll-up')
    assert.ok(body().data.operations, 'the operational summary is the route’s other half')
  })

  it('does not answer a route it did not match', () => {
    const res = fakeResponse()
    const handled = handleEventsRoute({ kind: 'not-mine' }, {
      data: DATA, res, req: { method: 'GET', __auth: null },
      url: new URL('http://127.0.0.1/x'), jsonResponse,
    })
    assert.equal(handled, false)
  })
})
