#!/usr/bin/env node
/**
 * QUA-06 — every route's response envelope, checked rather than assumed.
 *
 * `api-substrate.test.js` proves pagination, ETags and idempotency on
 * `service_assets` alone. Nothing walked the surface, so a route returning
 * `data: [...]` unpaged beside a paginated sibling was undetected — the same
 * shape of gap `check-openapi.mjs` closed for *paths*, one layer down. A client
 * generated from the spec can call every route and still not know whether
 * `total` will be there.
 *
 * **What is checked.** The spec names the routes; this drives each one against a
 * real server and asserts the invariants the envelope is supposed to have. Four,
 * and each is a rule the tree states somewhere and no test enforced everywhere:
 *
 *   1. A JSON response is an object with a boolean `success`. Three exemptions
 *      are by media type, not by path: GeoJSON, the STAC catalogue and the OGC
 *      collection are documents in their own published schema, and wrapping them
 *      in `{success, data}` would break the standard they exist to speak. They
 *      are listed by name below with the reason, so the exemption is a decision
 *      a reviewer reads rather than a regex nobody remembers.
 *   2. A 4xx/5xx JSON response carries a `code`. ARC-07 made this a property of
 *      `jsonResponse`, and this is the check that it is one — the seam is
 *      `errorEnvelope`, and a route that hand-writes a failure bypasses it.
 *   3. A response whose `data` is an array is either paginated — all five of
 *      `returned`, `limit`, `total`, `has_more`, `next_cursor` — or a named,
 *      reasoned exception. A *partial* paging envelope is the failure this
 *      catches: `total` without `limit` reads as a count the caller cannot
 *      compare against what they got.
 *   4. A paged response's `total` is at least its `returned`. The one arithmetic
 *      invariant that holds whatever the store contains.
 *
 * **What is not checked, deliberately.** Whether the right routes are paginated
 * is a product question, not an envelope question, and a check that answered it
 * would be a list of 150 judgements. What this asserts is that the answer is
 * *consistent* — the envelope a route chose is complete and says the same thing
 * to every client.
 *
 * The `data`-is-an-array rule needs a record to exist, so the server is seeded
 * with one probe record per collection. Without it every list route returns
 * `data: []`, which is an array with no paging keys and would be reported as a
 * violation on every run — a gate that cries wolf on the first run is a gate
 * that gets an exemption list, and the exemption list is where the next defect
 * hides.
 *
 * Usage:
 *   node scripts/check-route-envelopes.mjs            # check, exit 1 on a finding
 *   node scripts/check-route-envelopes.mjs --self-test
 */

import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = path.join(ROOT, 'docs/openapi.yaml')

/**
 * Responses that are a document in their own published schema rather than this
 * API's envelope. Keyed by path, with the reason, because the reason is the
 * part a reviewer needs.
 */
const NOT_OUR_ENVELOPE = new Map([
  ['/api/v1/export.geojson', 'RFC 7946 GeoJSON: a FeatureCollection is the document, and a `success` key would make it invalid GeoJSON'],
  ['/api/v1/reports/{id}/export.geojson', 'RFC 7946 GeoJSON, same as the collection export'],
  ['/stac/catalog.json', 'STAC 1.0 catalogue: the `type`/`stac_version`/`links` shape is the standard'],
  ['/ogc/collections', 'OGC API Features: the collections document is the standard'],
  ['/ogc/collections/{id}/items', 'OGC API Features: the items FeatureCollection is the standard'],
])

/**
 * Routes whose `data` array is complete by construction, so paging keys would
 * be a claim about a set that has no second page.
 *
 * Every entry names why the array cannot be truncated. A route whose set *can*
 * grow belongs in the paginated set, not here — and if it is neither, the gate
 * is telling the truth and the route should be paginated.
 */
const ARRAY_IS_COMPLETE = new Map([
  ['/api/v1/districts', 'the pilot district registry: a fixed list of five, shipped as data, not queried'],
  ['/api/v1/alert-outcomes/reasons', 'the determination and reason vocabulary: an enum, not a result set'],
  ['/api/v1/equity/by-district', 'one row per district in the registry, bounded by the same fixed list'],
  ['/api/v1/equity/breaches', 'one row per district, computed from the bounded registry'],
  ['/api/v1/community-feedback/summary', 'an aggregate per category, bounded by the category enum'],
  ['/api/v1/rapidpro/escalations', 'the due set for one dispatch pass; `due` and `escalatable` are the counts and the run is the bound'],
  ['/api/v1/kpi/monthly-series', 'one row per month in the quarter window the route names'],
  ['/api/v1/parametric-rules', 'the parametric rule registry: operator-authored, and `count` travels with it'],
  ['/api/v1/parametric-disbursements', 'disbursements for the rules above, with `count`'],
  ['/api/v1/connectors', 'the connector registry: a fixed catalogue from schema.js'],
  ['/api/v1/connectors/status', 'the same registry with its per-connector gate and last run; `count` and `enabled` are counts over it'],
  ['/api/v1/sources', 'the public source catalogue: a fixed list from schema.js'],
  ['/api/v1/ingest/status', 'one row per scheduled source, bounded by the schedule list'],
  ['/api/v1/river-discharge', 'the discharge series for the district window the route names'],
  ['/api/v1/rapidpro/response-metrics', 'one row per response-time bucket, bounded by the bucket list'],
  ['/api/v1/calibration/by-region', 'one row per region in the registry; `returned` and `refused` are the split'],
  ['/api/v1/model-drift', 'one row per region, same bounded registry'],
  ['/api/v1/kpi/snapshots', 'one row per quarter in the window the route names'],
  ['/api/v1/data-lineage', 'lineage edges for the records in the store; the whole graph is the answer'],
])

/** The five keys a paginated response carries. */
const PAGE_KEYS = ['returned', 'limit', 'total', 'has_more', 'next_cursor']

/** Every documented path, and the methods declared under it. */
function documentedRoutes(spec) {
  const routes = []
  let current = null
  for (const line of spec.split('\n')) {
    const p = /^ {2}(\/[^:]+):$/.exec(line)
    if (p) { current = { path: p[1], methods: [] }; routes.push(current); continue }
    const m = /^ {4}(get|post|put|patch|delete):$/.exec(line)
    if (m && current) current.methods.push(m[1].toUpperCase())
  }
  return routes.filter((r) => r.methods.length)
}

/**
 * A probe record per collection, so a list route returns an array with a member
 * in it. Without this, `data: []` has no paging keys and every list route is a
 * finding.
 */
async function seedProbe(store, emptyStore) {
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
}

/**
 * Line-delimited JSON framings: a stream of documents, not a document.
 *
 * `includes('json')` is true for all three, so a gate that tested only that
 * parsed a whole export as one value — `res.json()` throws on the second line,
 * the body arrives as `null`, and the gate reported "JSON body is object, not an
 * object" against a route whose framing is the point. A stream is exempt by the
 * same rule as GeoJSON: its shape is a published standard, and it is not this
 * API's envelope.
 */
const NDJSON_MEDIA = /^application\/(x-ndjson|ndjson|jsonl|json-seq|jsonlines)\b/i

/** One violation, in the shape the CLI prints and the canaries assert on. */
export function checkEnvelope({ route, method, status, contentType, body }) {
  const findings = []
  const media = String(contentType || '')
  const isJson = media.includes('json') && !NDJSON_MEDIA.test(media)
  if (!isJson) return findings
  // Exempt by media type: a document in its own schema is not this envelope.
  if (NOT_OUR_ENVELOPE.has(route)) return findings
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    findings.push({ rule: 'object', route, method, status, detail: `JSON body is ${Array.isArray(body) ? 'an array' : typeof body}, not an object` })
    return findings
  }
  if (typeof body.success !== 'boolean') {
    findings.push({ rule: 'success', route, method, status, detail: 'no boolean `success` field' })
  }
  if (status >= 400 && body.success === false && !body.code) {
    findings.push({ rule: 'code', route, method, status, detail: 'a failure envelope with no `code` to branch on' })
  }
  if (Array.isArray(body.data) && !ARRAY_IS_COMPLETE.has(route)) {
    const present = PAGE_KEYS.filter((k) => k in body)
    if (present.length !== PAGE_KEYS.length) {
      findings.push({
        rule: 'paging',
        route, method, status,
        detail: present.length === 0
          ? '`data` is an array with no paging keys at all, so a caller cannot tell a complete answer from a truncated one'
          : `a partial paging envelope: has ${present.join(', ')} but not ${PAGE_KEYS.filter((k) => !present.includes(k)).join(', ')}`,
      })
    } else if (Number.isFinite(body.total) && Number.isFinite(body.returned) && body.total < body.returned) {
      findings.push({ rule: 'paging-arithmetic', route, method, status, detail: `total ${body.total} < returned ${body.returned}` })
    }
  }
  return findings
}

/** Drive every documented route and collect the findings. */
export async function scanRoutes() {
  // One `http_request` line per route is 113 lines of firehose around a result
  // that is usually one line. The logger reads its level at module load, so this
  // has to be set before the import below, not after. Errors still print: a
  // 500 the probe provokes is signal, and the two the tree has are deliberate
  // refusals (the CAP renderer rejecting an unrecognised alert status, and the
  // road-access roll-up assuming a producer-shaped record).
  process.env.LINDELA_LITE_LOG_LEVEL ||= 'warn'
  const { createServer } = await import('../src/server.js')
  const { JsonStore } = await import('../src/store.js')
  const { emptyStore } = await import('../src/schema.js')
  const spec = readFileSync(SPEC, 'utf8')
  const routes = documentedRoutes(spec)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-envelope-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await seedProbe(store, emptyStore)
  const unlimited = { charge: () => ({ allowed: true, release: () => {} }) }
  const listener = createServer({ store, inboundLimiter: unlimited }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`

  const findings = []
  let checked = 0
  try {
    for (const route of routes) {
      for (const method of route.methods) {
        // A mutating route is not driven: POSTing a probe body to 150 handlers
        // would be a second test suite, and the envelope of a 405/400 is the
        // same code path a GET failure takes. GET and DELETE are read-only
        // enough to be safe, and DELETE of a probe id is the by-id branch.
        if (method !== 'GET') continue
        const concrete = route.path.replace(/\{[^}]+\}/g, 'probe-id')
        let res
        try {
          res = await fetch(`${base}${concrete}`, { signal: AbortSignal.timeout(4000) })
        } catch { continue }
        const contentType = res.headers.get('content-type') || ''
        let body = null
        try { body = await res.json() } catch { body = null }
        checked += 1
        findings.push(...checkEnvelope({ route: route.path, method, status: res.status, contentType, body }))
      }
    }
  } finally {
    listener.close()
    // Same teardown race `check-route-methods.mjs` documents: a probe that
    // mutated the store can leave `#writeFile`'s temp file landing while this
    // walks the directory, and `ENOTEMPTY` out of a `finally` replaces a
    // clean result with a thrown one. Retry the burst, then let the verdict
    // stand on the findings.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  }
  return { findings, checked }
}

/**
 * Canaries. Each is a case the checker must get right, driven through
 * `checkEnvelope` with text rather than through the server — the same reason
 * `check-absent-values` drives `scanSource`: a canary that boots a server to
 * test a rule is a canary that can fail for a reason the rule does not name.
 */
export const CANARIES = [
  { name: 'passes a well-formed success envelope', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: { success: true, data: { ok: 1 } } }, expect: 0 },
  { name: 'flags a JSON body with no success field', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: { data: {} } }, expect: 1 },
  { name: 'flags an empty array with no paging keys, because emptiness is not completeness', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: { success: true, data: [] } }, expect: 1 },
  { name: 'flags a bare array body', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: [1, 2] }, expect: 1 },
  { name: 'passes a failure envelope that carries a code', input: { route: '/api/v1/x', method: 'GET', status: 404, contentType: 'application/json', body: { success: false, error: 'gone', code: 'NOT_FOUND' } }, expect: 0 },
  { name: 'flags a failure envelope with no code', input: { route: '/api/v1/x', method: 'GET', status: 500, contentType: 'application/json', body: { success: false, error: 'boom' } }, expect: 1 },
  { name: 'passes a complete paging envelope', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: { success: true, data: [1], returned: 1, limit: 500, total: 1, has_more: false, next_cursor: null } }, expect: 0 },
  { name: 'flags an unpaged array', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: { success: true, data: [1, 2, 3] } }, expect: 1 },
  { name: 'flags a partial paging envelope — the shape the audit found', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: { success: true, data: [1], total: 1 } }, expect: 1 },
  { name: 'flags total below returned', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json', body: { success: true, data: [1, 2], returned: 2, limit: 500, total: 1, has_more: false, next_cursor: null } }, expect: 1 },
  { name: 'exempts GeoJSON by media type, not by shape', input: { route: '/api/v1/export.geojson', method: 'GET', status: 200, contentType: 'application/geo+json', body: { type: 'FeatureCollection', features: [] } }, expect: 0 },
  { name: 'does not flag a non-JSON body', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'text/csv', body: null }, expect: 0 },
  // ENH-37. `includes('json')` matches `application/x-ndjson`, so a stream of
  // documents was being read as one and reported as a malformed envelope. The
  // canary is the exact shape the gate saw: `res.json()` threw on the second
  // line, so `body` arrived `null`.
  { name: 'exempts a line-delimited JSON stream, which is many documents not one', input: { route: '/api/v1/export.ndjson', method: 'GET', status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: null }, expect: 0 },
  { name: 'exempts every ndjson spelling a server might use', input: { route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/jsonl', body: null }, expect: 0 },
  // The other direction: the exemption must be the framing, not the route. A
  // route serving an ordinary JSON envelope is still checked.
  { name: 'still flags an object body on an unrelated JSON route', input: { route: '/api/v1/y', method: 'GET', status: 200, contentType: 'application/json', body: { data: {} } }, expect: 1 },
  { name: 'exempts a named complete array', input: { route: '/api/v1/districts', method: 'GET', status: 200, contentType: 'application/json', body: { success: true, data: [1, 2] } }, expect: 0 },
]

async function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => c.expect))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const got = checkEnvelope(canary.input).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest())
  const { findings, checked } = await scanRoutes()
  if (findings.length === 0) {
    console.log(`route envelope check: clean — ${checked} route(s) driven`)
    process.exit(0)
  }
  console.error(`route envelope check: ${findings.length} finding(s) across ${checked} route(s)\n`)
  for (const f of findings) console.error(`  [${f.rule}] ${f.method} ${f.route} → ${f.status}\n    ${f.detail}`)
  console.error('\nA response envelope is a contract every client reads. A route that carries')
  console.error('`data: []` with no paging keys cannot say whether it is complete, and a failure')
  console.error('with no `code` cannot be branched on. Either conform, or name the route in')
  console.error('`ARRAY_IS_COMPLETE` with the reason its array cannot be truncated.')
  process.exit(1)
}
