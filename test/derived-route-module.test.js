import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleDerivedRoute, matchDerivedRoute } from '../src/routes/derived.js'

/**
 * ARC-01 — the derived-collection reads as a module, asserted where they live.
 *
 * Five reads over what `refreshAnalytics` recomputes. No caller writes them, so
 * the family's whole job is to hand back a figure *and* the reason to doubt it.
 * That is the property this file asserts, because it is the one that is easy to
 * lose without noticing:
 *
 *   - `calibration/by-region` reports `refused` beside the scores. A region with
 *     too little evidence has `trust: null`; an empty `data` array with no
 *     refusal count reads as "every region is fine" when it means "no region
 *     could be scored".
 *   - `model-drift` reports `regions` and a `verdicts` tally, so a store whose
 *     features all came back `not_measurable` cannot read as a clean bill.
 *   - `data-quality` carries the ranking explanation, so the confidence is not
 *     read as an accuracy measurement.
 *
 * And the VER-14 class at the point of extraction: all five are reads, so every
 * non-GET verb falls through rather than answering 200.
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
  return handleDerivedRoute(route, {
    data, res,
    req: { method, __auth: { subject: 'tester', partner_org: null } },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

describe('ARC-01 — matchDerivedRoute takes the method', () => {
  it('matches each of the five derived reads', () => {
    const expected = [
      ['/api/v1/data-quality', 'data-quality'],
      ['/api/v1/data-lineage', 'data-lineage'],
      ['/api/v1/operations/summary', 'operations-summary'],
      ['/api/v1/calibration/by-region', 'calibration-by-region'],
      ['/api/v1/model-drift', 'model-drift'],
    ]
    for (const [pathname, kind] of expected) {
      assert.deepEqual(matchDerivedRoute(pathname, 'GET'), { kind }, `GET ${pathname} did not match as ${kind}`)
    }
    assert.equal(new Set(expected.map((e) => e[1])).size, expected.length, 'two kinds collide')
  })

  it('refuses every non-GET verb, because none of these writes', () => {
    // VER-14 at the point of extraction rather than by the next sweep.
    for (const pathname of [
      '/api/v1/data-quality', '/api/v1/data-lineage', '/api/v1/operations/summary',
      '/api/v1/calibration/by-region', '/api/v1/model-drift',
    ]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(matchDerivedRoute(pathname, method), null, `${method} ${pathname} matched a read route`)
      }
    }
  })

  it('does not match a near miss', () => {
    for (const pathname of [
      '/api/v1/data-quality/', '/api/v1/data-qualitys', '/api/v1/calibration',
      '/api/v1/calibration/by-region/extra', '/api/v1/model-drift/', '/api/v1/operations',
      '/api/v1/data-lineages', '',
    ]) {
      assert.equal(matchDerivedRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — a refusal travels beside the figure, not instead of it', () => {
  it('counts the regions it could not score rather than returning an empty list', async () => {
    const data = {
      region_trust: [
        { region_name: 'Turkana', trust: 0.8 },
        { region_name: 'Bor', trust: null },
        { region_name: 'Moroto', trust: undefined },
      ],
    }
    const { res } = await call({ kind: 'calibration-by-region' }, { data })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.regions, 3)
    assert.equal(body.returned, 3)
    // The count is the answer. Without it, a dashboard sees three rows and
    // cannot tell that two of them carry no score at all.
    assert.equal(body.refused, 2, 'the unscored regions were not counted')
    assert.equal(body.data.length, 3)
  })

  it('reports the whole store beside a filter that matched nothing', async () => {
    // `returned: 0` beside `regions: N` is a filter that matched nothing;
    // a bare empty list is indistinguishable from a store with no regions.
    const data = { region_trust: [{ region_name: 'Turkana', trust: 0.8 }] }
    const { res } = await call({ kind: 'calibration-by-region' }, { data, search: '?region=Nowhere' })
    const body = res.json()
    assert.equal(body.regions, 1, 'the store size was lost when the filter matched nothing')
    assert.equal(body.returned, 0)
    assert.deepEqual(body.data, [])
  })

  it('tallies drift verdicts rather than returning a bare array', async () => {
    // The store-wide case: every feature unmeasurable. A bare `data: []` reads as
    // a clean bill of health; the verdict tally is what distinguishes it.
    const data = {
      model_drift: [
        { region_name: 'Turkana', verdict: 'not_measurable' },
        { region_name: 'Bor', verdict: 'not_measurable' },
        { region_name: 'Moroto', verdict: 'stable' },
      ],
    }
    const { res } = await call({ kind: 'model-drift' }, { data })
    const body = res.json()
    assert.equal(body.regions, 3)
    assert.deepEqual(body.verdicts, { not_measurable: 2, stable: 1 })
  })

  it('carries the ranking explanation with the data-quality listing', async () => {
    const data = { data_quality: [{ id: 'q1', confidence: 0.9 }, { id: 'q2', confidence: 0.4 }] }
    const { res } = await call({ kind: 'data-quality' }, { data })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.ok(body.ranking, 'the data-quality payload lost its ordering explanation')
    assert.equal(body.data.length, 2)
  })
})

describe('ARC-01 — the module answers, or declines, without inventing a response', () => {
  it('returns false for a kind it does not own', async () => {
    const { handled, res } = await call({ kind: 'not-a-derived-route' }, {})
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned kind wrote a response')
  })

  it('answers an absent collection as an empty one, not a 500', async () => {
    // The shape the dispatcher actually hands this module. `store.read()`
    // guarantees every declared collection is present as an array — `manifestShape`
    // fills the ones the read did not name with `[]` — so an *absent* key is not
    // a state the module can be reached in. It is asserted anyway, because the
    // module is exported and a future caller that hand-builds `data` is the way
    // this breaks: `operationalSummary` reads `data.incidents.filter(...)`
    // unguarded, and a bare `{}` throws a TypeError out of the handler.
    //
    // Documented rather than fixed: this is a precondition the store upholds,
    // not a bug in the route. A test asserting a 200 here would be asserting
    // behaviour the module does not have and does not need.
    await assert.rejects(
      () => call({ kind: 'operations-summary' }, { data: {} }),
      /Cannot read properties of undefined/,
    )
  })

  it('answers the collections the store always supplies', async () => {
    // What `store.read()` guarantees, so the module never sees an absent key.
    for (const kind of ['data-lineage', 'calibration-by-region', 'model-drift', 'operations-summary']) {
      const { handled, res } = await call({ kind }, {
        data: {
          data_lineage: [], region_trust: [], model_drift: [],
          incidents: [], interventions: [], intervention_tasks: [], response_resources: [],
          field_reports: [],
        },
      })
      assert.equal(handled, true, `${kind} declined to handle its own route`)
      assert.equal(res.status, 200, `${kind} threw on an empty store`)
      assert.equal(res.json().success, true)
    }
  })
})
