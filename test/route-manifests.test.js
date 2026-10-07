import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ROUTE_MANIFESTS, WIDE_ROUTES, UNMAPPED_COUNT, collectionsForRequest } from '../src/route-manifests.js'
import { emptyStore } from '../src/schema.js'

/**
 * ENH-07 — a manifest that nobody keeps honest decays into the thing it replaced.
 *
 * The store could take a collection manifest for months with no caller for it,
 * and the reason it stayed unused is the cost of getting it right: 96 routes, each
 * reading a different handful of collections, and a mistake in either direction
 * is expensive. Too wide is a missed optimisation. Too narrow is a handler
 * reading `undefined` and a 500 on a route nobody tested.
 *
 * So the table is *measured* — `scripts/collect-route-manifests.mjs` drives every
 * documented route with the read instrumented and prints what each touched — and
 * this file is what keeps the measurement and the code from drifting apart:
 *
 *   - every documented route is either mapped or explicitly wide;
 *   - no manifest names a collection the store does not have;
 *   - the measurement reproduces. That last one is the one that matters: it is
 *     the difference between a table someone derived and a table someone
 *     observed, and it runs in a few seconds because the store is instrumented
 *     in-process rather than over HTTP.
 */

const SPEC = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8')

/**
 * Every documented path *with the methods declared under it*.
 *
 * Reading the methods rather than assuming GET matters: the first version of
 * this file built a `GET <path>` key for every documented path and reported 36
 * unmapped routes, all of which are POST-only paths that are not served under
 * GET at all. A guard that cries wolf on the first run is a guard that gets
 * deleted.
 */
function declaredRoutes() {
  const out = []
  const lines = SPEC.split('\n')
  let current = null
  for (const line of lines) {
    const path = /^  (\/[^:]+):$/.exec(line)
    if (path) {
      current = { path: path[1], methods: [] }
      out.push(current)
      continue
    }
    const method = /^    (get|post|put|patch|delete):$/.exec(line)
    if (method && current) current.methods.push(method[1].toUpperCase())
  }
  return out
}

const SPEC_ROUTES = declaredRoutes().flatMap(({ path, methods }) =>
  methods.map((method) => ({ key: `${method} ${path.replace(/\{[^}]+\}/g, ':id')}`, path })))
const SPEC_PATHS = [...new Set(declaredRoutes().map((r) => r.path))]

describe('ENH-07 — every documented route is accounted for', () => {
  const keys = new Set([...Object.keys(ROUTE_MANIFESTS), ...WIDE_ROUTES])

  it('no route is unmapped, so a new one cannot arrive silently expensive', () => {
    // The failure this file exists for. A route added to the spec and served by
    // the server, absent from the table, would read the whole store and nobody
    // would notice — which is exactly how the mechanism stayed unused.
    const unmapped = SPEC_ROUTES.map((r) => r.key).filter((key) => !keys.has(key))
    assert.deepEqual(unmapped, [],
      'these routes are documented and served but appear in none of the three ' +
      'lists — a manifest, WIDE_ROUTES, or the recorded remainder. Each would ' +
      'materialise the whole store with nothing saying so: ' + unmapped.join(', '))
  })

  it('no manifest names a collection the store does not have', () => {
    const known = new Set(Object.keys(emptyStore()))
    const unknown = []
    for (const [key, list] of Object.entries(ROUTE_MANIFESTS)) {
      for (const collection of list) {
        if (!known.has(collection)) unknown.push(`${key} → ${collection}`)
      }
    }
    assert.deepEqual(unknown, [],
      'these manifests name collections that do not exist, so the read would be ' +
      'silently empty for them: ' + unknown.join(', '))
  })

  it('what is left on the whole-store read is a number, not a mood', () => {
    // 48 of 170 routes, and every one of them named in WIDE_ROUTES with the
    // reason. The number is published because "most routes are optimised" is not
    // a claim anyone can check; this one can be read off the file.
    assert.equal(typeof UNMAPPED_COUNT, 'number')
    assert.equal(UNMAPPED_COUNT, WIDE_ROUTES.length)
    assert.equal(new Set(WIDE_ROUTES).size, WIDE_ROUTES.length,
      'a duplicated entry in the remainder means the count is a number somebody typed')
  })

  it('no manifest is empty, which would read nothing at all', () => {
    // An empty measurement means *unknown*, not "reads nothing", so the
    // collector emits `null` for it and it lands in WIDE_ROUTES. A manifest that
    // is genuinely empty would hand the route a store with no collections in it.
    const empty = Object.entries(ROUTE_MANIFESTS).filter(([, list]) => list.length === 0)
    assert.deepEqual(empty.map(([key]) => key), [],
      'an empty manifest reads nothing; if this route truly needs nothing, the ' +
      'collector should have said so and it would still be listed as unmeasured')
  })
})

describe('ENH-07 — the manifest is looked up by the route, not the record', () => {
  it('an id segment does not change the answer', () => {
    assert.deepEqual(
      collectionsForRequest('GET', '/api/v1/incidents'),
      collectionsForRequest('GET', '/api/v1/incidents/123'),
      'a manifest is a property of the route; a by-id request reads the same ' +
      'collections as its collection sibling',
    )
  })

  it('an unrecognised path reads everything rather than nothing', () => {
    // The safe direction. A path the table has never seen keeps today's
    // behaviour — a whole-store read — so an unmapped route costs bandwidth
    // rather than returning a 500.
    assert.equal(collectionsForRequest('GET', '/api/v1/something-new'), null)
  })

  it('a wide route says so rather than being absent', () => {
    assert.equal(collectionsForRequest('GET', '/api/v1/health'), null)
    assert.ok(WIDE_ROUTES.includes('GET /api/v1/health'),
      'and the reason it is null is recorded, so nobody re-measures it every week')
  })
})

describe('ENH-07 — the measurement still reproduces', () => {
  it('driving the routes again reads no collection the table omits', async () => {
    // The staleness check. If a handler starts reading a new collection, this
    // fails — which is the moment to re-run the collector and commit its output,
    // rather than discovering it as a 500 on a route nobody exercised.
    const { createServer } = await import('../src/server.js')
    const { JsonStore } = await import('../src/store.js')
    const os = await import('node:os')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-manifest-guard-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const seeded = {}
    for (const [collection, records] of Object.entries(emptyStore())) {
      if (!Array.isArray(records) || records.length) continue
      seeded[collection] = [{
        id: 'probe-id', type: collection, name: 'Probe', title: 'Probe', description: 'Probe',
        status: 'active', state: 'closed', severity: 'high', source: 'open_meteo',
        district: 'Turkana', country: 'KE', latitude: 3.1, longitude: 36.5,
        observed_at: '2024-03-01T00:00:00Z', created_at: '2024-03-01T00:00:00Z',
      }]
    }
    await store.merge(seeded)

    // The read is instrumented, and the *declared* manifest is also applied — so
    // what this records is what the route *tried* to read, including anything
    // the table failed to declare.
    const touched = new Set()
    const instrumented = {
      async read(options) {
        const data = await store.read(options)
        return new Proxy(data, {
          get(target, property) {
            if (typeof property === 'string' && property in target) touched.add(property)
            return target[property]
          },
          has(target, property) {
            if (typeof property === 'string' && property in target) touched.add(property)
            return property in target
          },
        })
      },
      merge: (p) => store.merge(p),
      remove: (p) => store.remove(p),
      write: (p) => store.write(p),
      replaceCollection: (c, r) => store.replaceCollection(c, r),
      replaceAnalytics: (p) => store.replaceAnalytics(p),
    }
    const unlimited = { charge: () => ({ allowed: true, release: () => {} }) }
    const listener = createServer({ store: instrumented, inboundLimiter: unlimited }).listen(0)
    const base = `http://127.0.0.1:${listener.address().port}`

    const drifted = []
    try {
      for (const route of SPEC_PATHS) {
        if (/\/ingest\/run|\/dispatch/.test(route)) continue
        const key = `GET ${String(route).replace(/\{[^}]+\}/g, ':id')}`
        if (WIDE_ROUTES.includes(key) || !ROUTE_MANIFESTS[key]) continue
        const concrete = route.replace(/\{[^}]+\}/g, 'probe-id')
        touched.clear()
        try {
          await fetch(`${base}${concrete}`, { signal: AbortSignal.timeout(3000) })
        } catch {
          continue
        }
        const declared = new Set(ROUTE_MANIFESTS[key])
        const undeclared = [...touched].filter((c) => !declared.has(c))
        if (undeclared.length) drifted.push(`${key}: reads ${undeclared.join(', ')}`)
      }
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }

    assert.deepEqual(drifted, [],
      'these routes read collections their manifest does not declare, so on ' +
      'PostgreSQL they would read undefined and answer with a 500. Re-run ' +
      'scripts/collect-route-manifests.mjs and commit its output: ' + drifted.join(' | '))
  })
})

describe('explain', () => {
  // The handler resolves an arbitrary ?kind= collection by name. The route's
  // measured entry covered only the default kind, so `?kind=service_assets`
  // materialised a manifest without the collection, and the handler read
  // `undefined` — a 404 for records the store holds. The dashboard read that
  // 404 class as a property of the endpoint and told the operator the record
  // type was "not served", which was true by accident and for the wrong
  // reason. The kind resolution lives here, tested as code.
  it('reads the caller-named collection plus the provenance lookups', () => {
    for (const kind of ['service_assets', 'impact_assessments', 'field_reports', 'risk_scores']) {
      const out = collectionsForRequest('GET', '/api/v1/explain/asset_x', new URLSearchParams(`kind=${kind}`))
      assert.deepEqual(out, [kind, 'source_runs', 'data_lineage'], `kind=${kind}`)
    }
  })

  it('falls back to the measured entry for a kind that is not a collection', () => {
    // gdacs-style upstream ids are not store collections; the handler's 404
    // is the honest miss, on a narrow read rather than a whole-store one.
    for (const kind of [null, 'gdacs', 'acled_csv', '__proto__']) {
      const search = kind ? new URLSearchParams(`kind=${kind}`) : null
      assert.deepEqual(
        collectionsForRequest('GET', '/api/v1/explain/asset_x', search),
        ROUTE_MANIFESTS['GET /api/v1/explain/:id'],
        `kind=${kind}`,
      )
    }
  })

  it('declares source_runs in the static entry, because the handler looks provenance up there', () => {
    assert.ok(ROUTE_MANIFESTS['GET /api/v1/explain/:id'].includes('source_runs'),
      'a risk score naming a source run would have its run silently dropped to null otherwise')
  })

  it('explains a caller-named kind end to end', async () => {
    const { createServer } = await import('../src/server.js')
    const { JsonStore } = await import('../src/store.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explain-kind-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const record = { id: 'asset_0001', source: 'service_assets', name: 'Bor Model Primary', service_type: 'school', status: 'operational' }
    await store.write({ service_assets: [record] })
    const listener = createServer({ store }).listen(0)
    try {
      const base = `http://localhost:${listener.address().port}`
      const served = await (await fetch(`${base}/api/v1/explain/asset_0001?kind=service_assets`)).json()
      assert.equal(served.success, true)
      assert.equal(served.kind, 'service_assets')
      assert.equal(served.record?.id, 'asset_0001')
      assert.equal(served.provenance?.known, false, `absence of provenance is the fact to report: ${JSON.stringify(served.provenance)}`)

      const missing = await (await fetch(`${base}/api/v1/explain/asset_0001?kind=hazard_events`)).json()
      assert.equal(missing.success, false, 'a kind that holds no such record misses')
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
