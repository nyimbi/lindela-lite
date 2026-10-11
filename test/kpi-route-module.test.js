import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { buildQuarterlyExportNarrative, handleKpiRoute, matchKpiRoute } from '../src/routes/kpi.js'

/**
 * ARC-01 — the KPI family as a module, asserted where it now lives.
 *
 * Seven routes left `handleApiRequestInContext` for `src/routes/kpi.js`. Their
 * end-to-end behaviour is covered through the server by `test/lite.test.js` and
 * `test/server-isolation.test.js`, and that is the coverage that matters for
 * what they answer. What those cannot see is the three properties that are the
 * reason the family is a module:
 *
 *   - the matcher is method-aware and complete. Three of these paths differ by
 *     verb and four by suffix, so a matcher that took every method would make
 *     `POST /api/v1/kpi/quarterly` a route, and one that missed a suffix would
 *     drop a format silently.
 *   - the Markdown and the PDF compose from the same three pieces. This is the
 *     defect the family carried: `.md` handed the renderer a generic alert
 *     digest, so the dashboard's download button delivered a report with the
 *     right refusals wrapped around the wrong numbers. Two routes that must
 *     agree are two routes that must be read together, and 1,900 lines apart
 *     they were not.
 *   - the narrative refuses *in content* rather than by status. A quarterly
 *     export whose narrative cannot be built still exports, carrying a page that
 *     says so, because a missing page reads as "there was nothing to refuse".
 */

/** A response double that records what was written and never blocks. */
function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.text = () => res.chunks.join('')
  return res
}

/** The dispatcher's response writer, reduced to what these routes use. */
const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const req = (method = 'GET') => ({ method, __auth: null })

describe('ARC-01 — matchKpiRoute reads the method and the path, and nothing else', () => {
  it('matches each of the seven KPI routes', () => {
    const expected = [
      ['/api/v1/kpi/monthly-series', 'GET', 'monthly-series'],
      ['/api/v1/kpi/snapshots', 'GET', 'snapshots'],
      ['/api/v1/kpi/refresh-snapshots', 'POST', 'refresh-snapshots'],
      ['/api/v1/kpi/quarterly.md', 'GET', 'quarterly-md'],
      ['/api/v1/kpi/quarterly/coverage', 'GET', 'quarterly-coverage'],
      ['/api/v1/kpi/quarterly.pdf', 'GET', 'quarterly-pdf'],
      ['/api/v1/kpi/quarterly', 'GET', 'quarterly'],
    ]
    for (const [pathname, method, kind] of expected) {
      assert.deepEqual(matchKpiRoute(pathname, method), { kind }, `${method} ${pathname} did not match as ${kind}`)
    }
    assert.equal(new Set(expected.map((e) => e[2])).size, expected.length, 'two kinds collide')
  })

  it('refuses the wrong method on a path it serves, rather than serving it anyway', () => {
    // The reason the method is in the matcher: `refresh-snapshots` is a POST
    // beside two GETs, and `quarterly` is a GET. A matcher that ignored the verb
    // would make `POST /api/v1/kpi/quarterly` a route that answers 200 to a
    // request nobody wrote — and would make `GET /api/v1/kpi/refresh-snapshots`
    // one that refreshes on a read.
    assert.equal(matchKpiRoute('/api/v1/kpi/refresh-snapshots', 'GET'), null)
    assert.equal(matchKpiRoute('/api/v1/kpi/quarterly', 'POST'), null)
    assert.equal(matchKpiRoute('/api/v1/kpi/quarterly.md', 'POST'), null)
    assert.equal(matchKpiRoute('/api/v1/kpi/snapshots', 'DELETE'), null)
  })

  it('does not match a near miss', () => {
    for (const pathname of [
      '/api/v1/kpi',
      '/api/v1/kpi/',
      '/api/v1/kpi/quarterly/',
      '/api/v1/kpi/quarterly.md.bak',
      '/api/v1/kpi/quarterly.html',
      '/api/v1/kpi/monthly',
      '/api/v1/kpi/quarterly/coverage/extra',
      '/api/v1/KPI/quarterly',
      '',
    ]) {
      assert.equal(matchKpiRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — the quarterly narrative refuses in content, not by status', () => {
  it('reports a narrative it could not build rather than throwing', () => {
    // The whole point of the catch. This is the only place in the family where a
    // failure is content rather than a status code: the export still happens,
    // and it carries a page that says the narrative could not be produced.
    const narrative = buildQuarterlyExportNarrative({ report_templates: 'not an array' }, { quarter: 'Q3', year: 2026 })
    assert.ok(Array.isArray(narrative.refused), 'a failed narrative carried no refusals')
    assert.ok(narrative.refused.length > 0, 'the failure produced an empty refusal list, which reads as nothing to refuse')
    assert.equal(narrative.measured.length, 0)
    assert.match(narrative.refused[0].reason, /could not be generated/)
    assert.ok(Array.isArray(narrative.limits) && narrative.limits.length > 0,
      'a file carrying figures only must say so in its own limits')
  })
})

describe('ARC-01 — the module handles what the dispatcher hands it', () => {
  it('serves the monthly series and the snapshots, and materialises nothing', async () => {
    const data = { kpi_snapshots: [{ id: 'k1' }] }

    const seriesRes = fakeResponse()
    assert.equal(await handleKpiRoute({ kind: 'monthly-series' }, {
      store: {}, data, req: req(), res: seriesRes,
      url: new URL('http://127.0.0.1/api/v1/kpi/monthly-series?monthsBack=6'),
      jsonResponse, requestRing: null,
    }), true)
    assert.equal(seriesRes.status, 200)
    assert.ok(Array.isArray(JSON.parse(seriesRes.text()).data))

    const snapRes = fakeResponse()
    assert.equal(await handleKpiRoute({ kind: 'snapshots' }, {
      store: {}, data, req: req(), res: snapRes,
      url: new URL('http://127.0.0.1/api/v1/kpi/snapshots'),
      jsonResponse, requestRing: null,
    }), true)
    assert.deepEqual(JSON.parse(snapRes.text()).data, [{ id: 'k1' }])
  })

  it('returns false for a kind it does not own, rather than answering something', async () => {
    // The dispatcher reads `false` as "not mine, keep going". A handler that
    // answered a 200 for an unknown kind would swallow the route table.
    const res = fakeResponse()
    const handled = await handleKpiRoute({ kind: 'not-a-kpi-route' }, {
      store: {}, data: {}, req: req(), res,
      url: new URL('http://127.0.0.1/api/v1/kpi/quarterly'),
      jsonResponse, requestRing: null,
    })
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned kind wrote a response')
  })

  it('reports an invalid period as a 400 rather than a 500', async () => {
    const res = fakeResponse()
    await handleKpiRoute({ kind: 'quarterly' }, {
      store: {}, data: {}, req: req(), res,
      url: new URL('http://127.0.0.1/api/v1/kpi/quarterly?quarter=Q9'),
      jsonResponse, requestRing: null,
    })
    assert.equal(res.status, 400, 'an unparseable quarter was not refused as a client error')
    assert.equal(JSON.parse(res.text()).success, false)
  })
})
