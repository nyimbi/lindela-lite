import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { EXPORT_COLLECTIONS, handleExportRoute, matchExportRoute } from '../src/routes/exports.js'

/**
 * ARC-01 — the export family as a module, asserted where it now lives.
 *
 * The extraction moved five routes out of `handleApiRequestInContext` and into
 * `src/routes/exports.js`, and every one of them is still covered end-to-end by
 * `test/streaming-export.test.js`, `test/csv-injection.test.js` and the rest —
 * through the server. What those cannot see is the two properties that are the
 * *reason* the family is a module rather than five blocks:
 *
 *   - `matchExportRoute` is a pure function of the pathname. That is what makes
 *     the family extractable at all, and it is what `check-openapi.mjs` reads to
 *     build its inventory of the served surface. A matcher that consulted the
 *     method or the auth would still pass every HTTP test and quietly stop being
 *     the thing the gate parses.
 *   - the whole-store read is a thunk, and `export.ndjson` never calls it. This
 *     is the defect the extraction reintroduced and the property that fixes it:
 *     dispatched above the dispatcher's read, the streaming route must not
 *     materialise the store it exists to avoid holding.
 *
 * Both are asserted here directly, because a claim about *when* a read happens
 * is not observable from a response body.
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

const url = (query = '') => new URL(`http://127.0.0.1/api/v1/export.ndjson${query}`)

describe('ARC-01 — matchExportRoute is a function of the pathname alone', () => {
  it('matches each of the five export paths and nothing else', () => {
    const expected = {
      '/api/v1/exports': 'manifest',
      '/api/v1/export.ndjson': 'ndjson',
      '/api/v1/export.geojson': 'geojson',
      '/api/v1/export.csv': 'csv',
      '/api/v1/export/dhis2': 'dhis2',
    }
    for (const [pathname, kind] of Object.entries(expected)) {
      assert.deepEqual(matchExportRoute(pathname), { kind }, `${pathname} did not match as ${kind}`)
    }
    // The near-misses. A matcher that fell back to a prefix test would take
    // `/api/v1/export.csv.bak` and serve it as the export — and would take
    // `/api/v1/exportsomething`, which is a route nobody wrote.
    for (const pathname of [
      '/api/v1/export',
      '/api/v1/export.csv.bak',
      '/api/v1/exportsomething',
      '/api/v1/export/ndjson',
      '/api/v1/export/dhis2/',
      '/api/v1/exports/',
      '/api/v1/export.CSV',
      '/api/v1/export.geojson?district=Bor',
      '',
      '/',
    ]) {
      assert.equal(matchExportRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })

  it('does not read the request, so it cannot disagree with the gate that parses it', () => {
    // The gate reads `pathname === '…'` inside a named `match*Route`. A matcher
    // that took a request object and consulted the method would parse the same
    // and mean something different, so the arity is asserted rather than
    // assumed.
    assert.equal(matchExportRoute.length, 1, 'matchExportRoute takes the pathname and nothing else')
  })
})

describe('ARC-01 — the store read is deferred to the routes that need it', () => {
  it('the streaming route never materialises the store', async () => {
    let reads = 0
    const store = {
      async *iterateRecords() {
        yield { collection: 'hazard_events', body: { id: 'h1', event_type: 'flood' } }
      },
    }
    const res = fakeResponse()
    const handled = await handleExportRoute({ kind: 'ndjson' }, {
      store,
      req: { method: 'GET', __auth: null },
      res,
      url: url('?collection=hazard_events'),
      jsonResponse: (r, status, body) => { r.writeHead(status); r.end(JSON.stringify(body)) },
      vintageIndex: { record() {}, list: () => ({}) },
      loadData: async () => { reads += 1; return {} },
    })

    assert.equal(handled, true)
    assert.equal(res.status, 200)
    assert.equal(reads, 0, 'the streaming export read the whole store it exists to avoid holding')
    assert.match(res.text(), /"id":"h1"/)
  })

  it('the manifest route never materialises the store either', async () => {
    let reads = 0
    const res = fakeResponse()
    await handleExportRoute({ kind: 'manifest' }, {
      store: {},
      req: { method: 'GET', __auth: null },
      res,
      url: new URL('http://127.0.0.1/api/v1/exports'),
      jsonResponse: (r, status, body) => { r.writeHead(status); r.end(JSON.stringify(body)) },
      vintageIndex: { record() {}, list: () => ({ vintages: [] }) },
      loadData: async () => { reads += 1; return {} },
    })
    assert.equal(reads, 0, 'the vintage manifest read the store it does not describe')
  })

  it('materialises once, for the routes that hash the whole set', async () => {
    let reads = 0
    const res = fakeResponse()
    await handleExportRoute({ kind: 'geojson' }, {
      store: {},
      req: { method: 'GET', __auth: null },
      res,
      url: new URL('http://127.0.0.1/api/v1/export.geojson'),
      jsonResponse: (r, status, body) => { r.writeHead(status); r.end(JSON.stringify(body)) },
      vintageIndex: { record() {}, list: () => ({}) },
      loadData: async () => {
        reads += 1
        return { hazard_events: [{ id: 'h1', event_type: 'flood', latitude: 3, longitude: 36 }] }
      },
    })
    assert.equal(reads, 1, 'the GeoJSON export did not read the store exactly once')
    assert.equal(res.status, 200)
  })
})

describe('ARC-01 — one list of collections, so the exports cannot drift', () => {
  it('names every collection the three materialising exports span', async () => {
    // The defect this list closes: `export.csv` carried fourteen collections and
    // `export.geojson` nine, so the same store produced two exports of different
    // sizes and neither said which was the whole set. Both now spread this one
    // array, and the way to assert that from outside is to put a record in every
    // named collection and require every export to carry it.
    assert.ok(EXPORT_COLLECTIONS.length >= 14, 'the export list lost collections')
    assert.equal(new Set(EXPORT_COLLECTIONS).size, EXPORT_COLLECTIONS.length, 'the export list repeats a collection')

    const data = Object.fromEntries(EXPORT_COLLECTIONS.map((name, i) => [
      name,
      [{ id: `${name}-${i}`, event_type: 'flood', latitude: 3 + i / 1000, longitude: 36 }],
    ]))

    const res = fakeResponse()
    await handleExportRoute({ kind: 'geojson' }, {
      store: {},
      req: { method: 'GET', __auth: null },
      res,
      url: new URL('http://127.0.0.1/api/v1/export.geojson'),
      jsonResponse: (r, status, body) => { r.writeHead(status); r.end(JSON.stringify(body)) },
      vintageIndex: { record() {}, list: () => ({}) },
      loadData: async () => data,
    })

    const body = JSON.parse(res.text())
    assert.equal(
      body.features.length,
      EXPORT_COLLECTIONS.length,
      'the GeoJSON export did not carry one record per named collection — it has drifted from the CSV again',
    )
  })
})
