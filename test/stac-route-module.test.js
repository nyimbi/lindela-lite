import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { matchStacRoute, matchOgcRoute, handleStacRoute } from '../src/routes/stac.js'
import { STAC_COLLECTIONS, STAC_READ_COLLECTIONS } from '../src/stac.js'

/**
 * ARC-08 / ENH-60 — the STAC and OGC families, asserted where they now live.
 *
 * These routes were the last written inline in `src/server.js`, and the reason
 * they stayed there is the reason they were broken: `handleStacRoute` matched
 * with an inline `.match()` inside a plain helper, a spelling
 * `scripts/route-surface.mjs` cannot read — it reads inline matches only in the
 * dispatcher body and in a named `match*Route` function. So three served paths
 * appeared in no manifest, no document and no check, while `check-openapi`
 * reported a clean *176 documented, 176 served*: agreement by mutual blindness,
 * the same shape as the tile proxy that closed ENH-59's parser gap.
 *
 * The properties worth asserting here are the ones the extraction is *for*:
 *
 *   - **every served path is a path the parser can see.** The failure mode is
 *     not a wrong answer, it is an invisible route, and only a test that reads
 *     the parser's own output can hold that.
 *   - **the manifest is the four collections, not the store.** ARC-08 fixed the
 *     whole-store read in place; the fix is worth a test where it lives now.
 *   - **the scope is applied to the read.** A token for one organisation was
 *     served another's service assets, and `authenticate` proving *a* caller
 *     says nothing about *which* partner.
 *   - **a non-GET is refused by the matcher, not by the handler.** The
 *     dispatcher's 405 table stays the one place that answers "wrong verb".
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
  res.body = () => Buffer.concat(res.chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))))
  res.json = () => JSON.parse(res.body().toString('utf8'))
  return res
}

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(Buffer.from(JSON.stringify(body), 'utf8'))
  return res
}

/**
 * A store double that records the read it was asked for.
 *
 * The manifest and the partner scope are the two things ARC-08 got wrong, and
 * neither is visible in the response — a whole-store read answers the same
 * bytes as a scoped one. Recording the argument is the only way to assert them.
 */
function recordingStore(rows = {}) {
  const reads = []
  return {
    reads,
    async read(request) {
      reads.push(request)
      return rows
    },
  }
}

const req = (host = '127.0.0.1:4177') => ({ method: 'GET', headers: { host } })

const dispatch = async (pathname, { store = recordingStore(), method = 'GET' } = {}) => {
  const route = matchStacRoute(pathname, method) || matchOgcRoute(pathname, method)
  const res = fakeResponse()
  if (!route) return { route: null, res, store, handled: false }
  const handled = await handleStacRoute(route, { store, req: req(), res, jsonResponse })
  return { route, res, store, handled }
}

describe('ARC-08 — the STAC and OGC matchers cover exactly the served paths', () => {
  it('matches the catalogue, a collection, its items, and one item', () => {
    assert.deepEqual(matchStacRoute('/stac/catalog.json'), { kind: 'catalog' })
    assert.deepEqual(matchStacRoute('/stac/collections/hazard-events'),
      { kind: 'collection', collectionId: 'hazard-events', itemId: null, items: false })
    assert.deepEqual(matchStacRoute('/stac/collections/hazard-events/items'),
      { kind: 'collection', collectionId: 'hazard-events', itemId: null, items: true })
    assert.deepEqual(matchStacRoute('/stac/collections/hazard-events/items/abc'),
      { kind: 'collection', collectionId: 'hazard-events', itemId: 'abc', items: true })
  })

  it('matches the OGC items route, and only the items route', () => {
    assert.deepEqual(matchOgcRoute('/ogc/collections/hazard-events/items'),
      { kind: 'ogc-items', collectionId: 'hazard-events' })
    // The OGC family has no collection-level route; `/ogc/collections/{id}` is
    // not served, and a matcher that answered it would invent a 404 in the
    // shape of a 200.
    assert.equal(matchOgcRoute('/ogc/collections/hazard-events'), null)
  })

  it('refuses every verb but GET, so the dispatcher keeps the 405 table', () => {
    // The extraction's contract: a matcher that returned a descriptor for POST
    // would move "wrong verb" out of the one place that answers it and into the
    // handler, where it would be answered 404 by the collection resolver.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(matchStacRoute('/stac/collections/hazard-events', method), null, method)
      assert.equal(matchStacRoute('/stac/catalog.json', method), null, method)
      assert.equal(matchOgcRoute('/ogc/collections/hazard-events/items', method), null, method)
    }
  })

  it('does not match a path that is not a STAC or OGC route', () => {
    // The negative jurisdiction boundary. `/stac/` and `/ogc/` prefixes reach
    // this family through a `startsWith` guard in the dispatcher that is
    // deliberately wider than the matchers — it is what puts the request
    // through the auth gate — so the matcher must refuse everything the guard
    // admits and no route serves.
    for (const path of ['/stac', '/stac/', '/stac/nope', '/ogc/nope', '/api/v1/stac',
      '/stac/collections/a/items/b/c', '/stac/catalog.json/x']) {
      assert.equal(matchStacRoute(path), null, path)
      assert.equal(matchOgcRoute(path), null, path)
    }
  })

  it('every path the matchers claim is a path the route-surface parser can see', async () => {
    // The defect, asserted at the level it lived at. The routes were served and
    // invisible: the parser read a family's paths out of its matcher body, and
    // the matcher was an inline `.match()` in a helper it never looked at. This
    // asks the parser directly, so a future edit that hoists the regex into a
    // constant or aliases `pathname` fails here rather than in production.
    const { servedRoutePaths } = await import('../scripts/route-surface.mjs')
    const { paths, coverage } = servedRoutePaths(process.cwd())
    for (const path of ['/stac/catalog.json', '/stac/collections/{id}',
      '/stac/collections/{id}/items', '/stac/collections/{id}/items/{id2}',
      '/ogc/collections/{id}/items']) {
      assert.ok(paths.has(path), `the parser cannot see ${path}, so no check built on it can`)
    }
    assert.deepEqual(coverage.unparsed.filter((u) => /Stac|Ogc/.test(u)), [],
      'a matcher the parser cannot read contributes nothing while reporting success')
  })
})

describe('ARC-08 — the read is scoped and narrow', () => {
  it('reads the four STAC collections, not the store', async () => {
    // The whole-store read materialised all 63 collections to answer a request
    // that touches four, on the surface many deployments deliberately leave
    // open. Asserted against the exported constant rather than a literal, so a
    // fifth collection added to `STAC_COLLECTIONS` cannot leave this behind.
    const { store } = await dispatch('/stac/collections/hazard-events')
    assert.equal(store.reads.length, 1)
    assert.deepEqual(store.reads[0].collections, STAC_READ_COLLECTIONS)
    assert.equal(store.reads[0].collections.length, 4)
  })

  it('applies the partner scope to the read, not merely to the gate', async () => {
    // `authenticate` proves *a* caller; it says nothing about *which* partner.
    // The route returns before `handleApi` publishes the identity, so without
    // an explicit context the read had no partner filter and one organisation's
    // token was served another's service assets — a map of where care is.
    const { runWithRequestContext } = await import('../src/utils.js')
    const { store } = await runWithRequestContext(
      { subject: 'token_x', partner_org: 'partner-a' },
      () => dispatch('/stac/collections/hazard-events'),
    )
    assert.equal(store.reads[0].partnerOrg, 'partner-a')
  })

  it('reads with no partner when no identity is in play', async () => {
    // Not the same state as `partner-a`, and the difference matters: auth
    // unconfigured means every caller already reads everything, so the read is
    // unscoped by construction rather than by an omitted filter.
    const { store } = await dispatch('/stac/collections/hazard-events')
    assert.equal(store.reads[0].partnerOrg, null)
  })
})

describe('ARC-08 — the responses name their refusal', () => {
  it('404s an unknown collection by name', async () => {
    const { res, handled } = await dispatch('/stac/collections/not-a-collection')
    assert.equal(handled, true)
    assert.equal(res.status, 404)
    assert.equal(res.json().error, 'Collection not found')
  })

  it('404s an unknown item inside a known collection', async () => {
    const rows = Object.fromEntries(STAC_READ_COLLECTIONS.map((c) => [c, []]))
    const { res } = await dispatch('/stac/collections/hazard-events/items/missing', {
      store: recordingStore(rows),
    })
    assert.equal(res.status, 404)
    assert.equal(res.json().error, 'Item not found')
  })

  it('serves the catalogue without reading a collection', async () => {
    // The catalogue is links, not records — but it still goes through the
    // scoped read, because `resolveStacCollection` is not the only consumer and
    // a route that skipped the read would be the ARC-08 omission in reverse.
    const { res, store } = await dispatch('/stac/catalog.json')
    assert.equal(res.status, 200)
    assert.equal(res.json().stac_version, '1.0.0')
    assert.equal(store.reads.length, 1, 'the catalogue read is what applies the scope')
  })

  it('names every published collection in the catalogue', async () => {
    const { res } = await dispatch('/stac/catalog.json')
    const ids = res.json().links.filter((l) => l.rel === 'child').map((l) => l.title)
    assert.equal(ids.length, STAC_COLLECTIONS.length,
      'a collection missing from the catalogue is a collection no client can find')
  })
})

describe('ARC-08 — the OGC handler is the STAC handler, by name', () => {
  it('exports the handler the parser derives from the matcher', async () => {
    // `scripts/route-surface.mjs` derives `handle${matcher.slice('match'.length)}`
    // and prints it as the coverage line. The two families share one
    // implementation, so without this alias the report names a function that
    // does not exist — a small lie in a report whose whole purpose is to be
    // checkable.
    const module = await import('../src/routes/stac.js')
    assert.equal(typeof module.handleOgcRoute, 'function')
    assert.equal(module.handleOgcRoute, module.handleStacRoute)
  })
})
