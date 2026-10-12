import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleComputeRoute, matchComputeRoute } from '../src/routes/compute.js'
import { FLOOD_DEPTH_BANDS } from '../public/shared/flood-bands.js'

/**
 * ENH-60 — the compute family as a module, asserted where it now lives.
 *
 * Four routes that run a model over the request's own arguments. They are one
 * family because the failure mode is the same: the *input* is the thing most
 * likely to be wrong, and a wrong input does not throw — it returns a confident
 * answer to a question nobody asked. So the assertions are mostly about
 * refusals, and about the band travelling with the number rather than beside it.
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

const call = (route, {
  data = {}, search = '', body, method, store, evaluateAndPersistAlerts,
} = {}) => {
  const res = fakeResponse()
  const raw = body === undefined ? '' : JSON.stringify(body)
  return handleComputeRoute(route, {
    store: store || { merge: async () => {} },
    data, res,
    req: {
      method: method || (route.kind === 'flood-depth' || route.kind === 'alerts-evaluate' ? 'GET' : 'POST'),
      __auth: { subject: 'tester', partner_org: null },
      __rawBody: raw,
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw) },
    },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
    evaluateAndPersistAlerts: evaluateAndPersistAlerts || (async () => ({ raised: [], updated: [] })),
  }).then((handled) => ({ handled, res }))
}

describe('ENH-60 — matchComputeRoute narrows only the routes whose wrong verb is a 404', () => {
  it('matches the two POST-only routes on POST alone', () => {
    assert.deepEqual(matchComputeRoute('/api/v1/routing/plan', 'POST'), { kind: 'routing-plan' })
    assert.deepEqual(matchComputeRoute('/api/v1/analytics/bias-correct', 'POST'), { kind: 'bias-correct' })
    assert.equal(matchComputeRoute('/api/v1/routing/plan', 'GET'), null)
    assert.equal(matchComputeRoute('/api/v1/analytics/bias-correct', 'GET'), null)
  })

  it('matches the two verb-agnostic routes on any method, so a wrong verb can be a 405', () => {
    // A matcher that narrowed these to GET/POST would turn a documented 405
    // into a 404 — a different statement about a different thing.
    for (const method of ['GET', 'POST', 'DELETE', 'PUT']) {
      assert.deepEqual(matchComputeRoute('/api/v1/flood-depth', method), { kind: 'flood-depth' })
      assert.deepEqual(matchComputeRoute('/api/v1/alerts/evaluate', method), { kind: 'alerts-evaluate' })
    }
  })

  it('matches nothing it does not serve', () => {
    for (const pathname of ['/api/v1/flood-depth/extra', '/api/v1/routing', '/api/v1/compute']) {
      assert.equal(matchComputeRoute(pathname, 'POST'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-60 — routing/plan refuses the wrong argument shape by name', () => {
  it('refuses a missing origin and a missing destination separately', async () => {
    const noFrom = await call({ kind: 'routing-plan' }, { body: { to: 'road-b' } })
    assert.equal(noFrom.res.status, 400)
    assert.match(noFrom.res.json().error, /from is required/)

    const noTo = await call({ kind: 'routing-plan' }, { body: { from: 'road-a' } })
    assert.equal(noTo.res.status, 400)
    assert.match(noTo.res.json().error, /to is required/)
  })

  it('refuses a lat/lon object as an endpoint rather than reporting a severed network', async () => {
    // The mistake this guards: a caller passing coordinates gets "Unknown
    // origin or destination road", which reads like a broken router rather
    // than a wrong argument.
    const { res } = await call({ kind: 'routing-plan' }, {
      body: { from: { lat: 3.1, lon: 35.6 }, to: 'road-b' },
    })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /road asset ids/)
  })

  it('answers an unreachable destination with a caveat rather than a 500', async () => {
    // A network that cannot reach the site is still a *plan*: the route answers
    // 200 and says so per leg. The 400 is reserved for the argument being
    // wrong, not for the world being wrong — a distinction the caller can act
    // on, because one is fixed by resending and the other is not.
    const { res } = await call({ kind: 'routing-plan' }, { body: { from: 'road-a', to: 'road-b' } })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.data.fully_deliverable, false)
    assert.ok(body.data.caveat, 'an undeliverable plan carried no caveat')
    assert.equal(body.data.legs[0].feasible, false)
  })
})

describe('ENH-60 — flood-depth refuses a typo rather than answering 0 m', () => {
  it('refuses a request with neither a point nor a box', async () => {
    const { res } = await call({ kind: 'flood-depth' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /lat and lon/)
  })

  it('does not read a blank lat as zero', async () => {
    // Number('') is 0 and Number(null) is 0; a blank parameter must not become
    // a valid-looking coordinate at the Gulf of Guinea.
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=&lon=&level_m=520' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /lat and lon/)
  })

  it('refuses a level that is not a number rather than treating it as no levels', async () => {
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=3.1&lon=35.6&level_m=abc' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /level_m must be a number/)
  })

  it('refuses an implausible water surface elevation by range', async () => {
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=3.1&lon=35.6&level_m=99999' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /out of range/)
  })

  it('bands every published depth and carries the cut points beside it', async () => {
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=3.1&lon=35.6&level_m=520' })
    // Terrain may or may not cover this point in a test environment; either way
    // the answer is a 200 with a shape, never a throw.
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.success, true)
    const data = body.data
    if (Array.isArray(data.profile)) {
      for (const point of data.profile) {
        assert.ok('depth_band' in point, 'a depth was published without its band')
      }
    }
    assert.ok(Array.isArray(data.flood_bands) && data.flood_bands.length === FLOOD_DEPTH_BANDS.length,
      'the payload did not carry the band table it banded with')
    assert.equal(data.flood_bands.at(-1).max_m, null,
      'the top band must be unbounded, so a huge depth maps to it rather than falling off the table')
  })
})

describe('ENH-60 — analytics/bias-correct names a correction that did not happen', () => {
  it('answers an empty request with an empty set rather than throwing', async () => {
    const { res } = await call({ kind: 'bias-correct' }, { body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json().data, [])
  })

  it('refuses to name a station for a correction that did not happen', async () => {
    // One observation with no station to correct against: the value must stay
    // null and the source must stay null, with the reason stated.
    const { res } = await call({ kind: 'bias-correct' }, {
      body: {
        observations: [{ country: 'KE', precipitation_mm: 12 }],
        stations: [],
      },
    })
    assert.equal(res.status, 200)
    const [row] = res.json().data
    assert.ok(row, 'the observation was dropped rather than corrected-or-refused')
    assert.equal(row.bias_correction_source, null,
      'a station was named for a correction that did not happen')
    assert.ok(row.bias_correction_refusal, 'a refusal was not stated')
  })
})

describe('ENH-60 — alerts/evaluate refuses a wrong verb with a 405, not a 404', () => {
  it('answers a GET with 405', async () => {
    const { res } = await call({ kind: 'alerts-evaluate' }, { method: 'GET' })
    assert.equal(res.status, 405)
  })

  it('runs the engine on POST and reports what it evaluated', async () => {
    let called = false
    const { res } = await call({ kind: 'alerts-evaluate' }, {
      method: 'POST',
      data: { alert_rules: [{ id: 'r1' }, { id: 'r2' }] },
      body: { actor: 'tester' },
      evaluateAndPersistAlerts: async () => { called = true; return { raised: [{ id: 'e1' }], updated: [] } },
    })
    assert.ok(called, 'the engine was never called')
    assert.equal(res.status, 201)
    assert.equal(res.json().evaluated, 2)
    assert.equal(res.json().created, 1)
  })
})
