import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleExposureRoute, matchExposureRoute } from '../src/routes/exposure.js'

/**
 * ARC-01 — the exposure family as a module, asserted where it now lives.
 *
 * Nine routes over seven paths, and two properties hold the family together.
 * The end-to-end behaviour is covered through the server by
 * `test/road-access-time.test.js`, `test/lite.test.js` and the isolation suites;
 * what those cannot see is what makes these nine one module:
 *
 *   - **the roll-up describes the matched set, not the page.** `road-access` and
 *     `food-security` publish a summary beside a listing, and each must be
 *     computed over every record that matched — not over the page. This had
 *     already gone wrong once (R-27), which is why it is asserted here.
 *   - **the method is in the matcher.** Four of these paths were written as
 *     `if (url.pathname === …)` with no verb test, so `DELETE /api/v1/road-access`
 *     answered 200 with the full listing while `docs/openapi.yaml` documented
 *     `get:` alone. Verified against a live server before the fix.
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

const call = (route, { data = {}, search = '', method = 'GET' } = {}) => {
  const res = fakeResponse()
  return handleExposureRoute(route, {
    data, res,
    req: { method, __auth: { subject: 'tester', partner_org: null } },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

const road = (id, over = {}) => ({
  id, service_type: 'road', road_class: 'trunk', country: 'KE',
  latitude: 3.1, longitude: 35.6, ...over,
})

describe('ARC-01 — matchExposureRoute reads the method as well as the path', () => {
  it('matches each of the seven exposure routes', () => {
    const expected = [
      ['/api/v1/service-impacts', 'service-impacts'],
      ['/api/v1/impact/population-at-risk', 'population-at-risk'],
      ['/api/v1/impact/facilities-at-risk', 'facilities-at-risk'],
      ['/api/v1/road-access', 'road-access'],
      ['/api/v1/road-access/summary', 'road-access-summary'],
      ['/api/v1/food-security', 'food-security'],
      ['/api/v1/food-security/summary', 'food-security-summary'],
    ]
    for (const [pathname, kind] of expected) {
      assert.deepEqual(matchExposureRoute(pathname, 'GET'), { kind }, `GET ${pathname} did not match as ${kind}`)
    }
    assert.equal(new Set(expected.map((e) => e[1])).size, expected.length, 'two kinds collide')
  })

  it('refuses every non-GET verb on every path, which four of them did not', () => {
    // The defect, in the matcher. These were `if (url.pathname === …)` with no
    // verb test, so a DELETE reached the listing handler and answered 200. A
    // destructive method returning a body that says nothing about destruction is
    // indistinguishable, from the client, from a server that ignored the method
    // — and the OpenAPI document for all four says `get:` and nothing else.
    for (const pathname of [
      '/api/v1/service-impacts',
      '/api/v1/impact/population-at-risk',
      '/api/v1/impact/facilities-at-risk',
      '/api/v1/road-access',
      '/api/v1/road-access/summary',
      '/api/v1/food-security',
      '/api/v1/food-security/summary',
    ]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(matchExposureRoute(pathname, method), null,
          `${method} ${pathname} matched, so a write method answers a read`)
      }
    }
  })

  it('does not match a near miss', () => {
    for (const pathname of [
      '/api/v1/road-access/',
      '/api/v1/road-access/summary/extra',
      '/api/v1/road-accesses',
      '/api/v1/food-security/',
      '/api/v1/impact',
      '/api/v1/impact/population',
      '/api/v1/service-impacts/summary',
      '',
    ]) {
      assert.equal(matchExposureRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — the roll-up describes the matched set, not the page', () => {
  it('summarises every matching road even when the page carries only a few', async () => {
    // 40 roads, one impassable hazard in range of each. With `limit=5` the page
    // holds 5 records; the summary must still count the whole set, or the map's
    // "N of M roads impassable" reports N out of the window rather than the
    // network and silently undercounts as soon as the set outgrows the limit.
    const data = {
      road_access: Array.from({ length: 40 }, (_, i) => road(`r${i + 1}`, { access_status: i < 12 ? 'impassable' : 'clear' })),
    }
    const { res } = await call({ kind: 'road-access' }, { data, search: '?limit=5' })
    const body = res.json()
    assert.equal(body.data.length, 5, 'the page did not honour the limit')
    assert.equal(body.total, 40, 'the response did not report the matched total')
    assert.equal(body.has_more, true)
    assert.equal(body.summary.total_roads, 40,
      'the roll-up was computed over the page, so it describes the window and not the network')
    assert.equal(body.summary.impassable, 12, 'the impassable count is a page count, not a network count')
  })

  it('honours include_deleted before the roll-up, not after it', async () => {
    // A soft-deleted road is not part of the network. Filtering after the match
    // would leave it in `summary.total` while absent from `data`.
    const data = {
      road_access: [
        road('r1', { access_status: 'impassable' }),
        road('r2', { access_status: 'impassable', deleted_at: '2026-01-01T00:00:00Z' }),
      ],
    }
    const without = (await call({ kind: 'road-access' }, { data })).res.json()
    assert.equal(without.summary.total_roads, 1, 'a soft-deleted road was counted in the roll-up')
    const withDeleted = (await call({ kind: 'road-access' }, { data, search: '?include_deleted=true' })).res.json()
    assert.equal(withDeleted.summary.total_roads, 2, 'include_deleted did not widen the set')
  })

  it('summarises every matching food-security record, not the page', async () => {
    const data = {
      food_security_records: Array.from({ length: 30 }, (_, i) => ({
        id: `f${i + 1}`, ipc_phase: i < 7 ? 4 : 2, country: 'KE',
      })),
    }
    const { res } = await call({ kind: 'food-security' }, { data, search: '?limit=4' })
    const body = res.json()
    assert.equal(body.data.length, 4)
    assert.equal(body.total, 30, 'the listing did not report the matched total')
    const summarised = JSON.stringify(body.summary)
    assert.ok(/30|7/.test(summarised), `the roll-up does not describe the matched set: ${summarised}`)
  })
})

describe('ARC-01 — the module answers, or declines, without inventing a response', () => {
  it('returns false for a kind it does not own', async () => {
    const { handled, res } = await call({ kind: 'not-an-exposure-route' }, {})
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned kind wrote a response')
  })

  it('answers an empty store rather than throwing on an absent collection', async () => {
    // `data.population_at_risk` has no `|| []` guard in the caller's shape for
    // some collections; an absent one must be an empty page, not a 500.
    for (const kind of ['population-at-risk', 'facilities-at-risk', 'road-access-summary', 'food-security-summary']) {
      const { handled, res } = await call({ kind }, { data: {} })
      assert.equal(handled, true, `${kind} declined to handle its own route`)
      assert.equal(res.status, 200, `${kind} did not answer an empty store`)
      assert.equal(res.json().success, true)
    }
  })

  it('refuses a cursor that identifies nothing rather than replaying page one', async () => {
    const data = { road_access: [road('r1')] }
    await assert.rejects(
      () => call({ kind: 'road-access' }, { data, search: '?cursor=does-not-exist' }),
      (err) => {
        assert.equal(err.statusCode, 400, 'an unresolvable cursor was not refused as a client error')
        assert.match(err.message, /cursor does not identify/)
        return true
      },
    )
  })
})
