#!/usr/bin/env node
/**
 * Measure, do not guess: which collections does each route actually read?
 *
 * ENH-07's manifest has to be exact in both directions. Too wide and the
 * 2,900× is a 200×; too narrow and a handler reads `undefined` and returns a
 * 500. Neither is acceptable to derive by reading 28 route handlers and hoping.
 *
 * Two passes, because one is not enough:
 *
 * 1. **Probe.** Every documented route is driven against a real server with the
 *    read instrumented, and whatever it touched is recorded. This sees the
 *    common path exactly, with a record seeded under the probe id so a by-id
 *    branch is measured rather than its 404.
 *
 * 2. **Source closure.** The probe's blind spot is a handler that validates its
 *    body and rejects the probe's `{}` *before* it reads: it never reaches the
 *    store, so nothing is measured, and a manifest derived only from the probe
 *    leaves it reading `undefined` on the first real request — which is how the
 *    first version of this table failed thirteen tests. So for the matcher
 *    families the handler's whole transitive call closure is scanned for
 *    `data.<collection>` references, and the union with the probe is the answer.
 *
 * The closure is per *handler family*, not per route: `handleReportingRoute` is
 * 800 lines covering 22 routes, and a closure over it would be most of the store
 * for every one of them. For the inline routes — the large dispatch in
 * `handleApiRequestInContext` — the probe is the only source, because a closure
 * over a 3,000-line function is not a manifest.
 *
 * Run it after adding a route or moving a handler's data access, and diff the
 * result against `src/route-manifests.js`.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { emptyStore } from '../src/schema.js'

const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
const WIDE = 12
const KNOWN = new Set(Object.keys(emptyStore()))

/* ------------------------------------------------------------ source closure */

const FUNCTIONS = new Map()
for (const m of SERVER.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\(/gm)) {
  FUNCTIONS.set(m[1], '')
}
function bodyOf(name) {
  if (FUNCTIONS.get(name)) return FUNCTIONS.get(name)
  const start = SERVER.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'))
  if (start < 0) return ''
  let i = SERVER.indexOf('{', start)
  let depth = 0
  for (; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1
    else if (SERVER[i] === '}') { depth -= 1; if (depth === 0) break }
  }
  const body = SERVER.slice(start, i)
  FUNCTIONS.set(name, body)
  return body
}

/** Every `data.<collection>` a function, and everything it calls, reads. */
function closureOf(name, seen = new Set()) {
  if (seen.has(name)) return new Set()
  seen.add(name)
  const body = bodyOf(name)
  const out = new Set()
  for (const m of body.matchAll(/data\.([a-z_]+)/g)) {
    if (KNOWN.has(m[1])) out.add(m[1])
  }
  for (const m of body.matchAll(/(?:^|[^\w.$])([a-z][A-Za-z0-9_]*)\s*\(/g)) {
    const callee = m[1]
    if (FUNCTIONS.has(callee)) {
      for (const c of closureOf(callee, seen)) out.add(c)
    }
  }
  return out
}

/** Path prefix → handler family, from the `matchXRoute` convention. */
const families = new Map()
for (const m of SERVER.matchAll(/function (match[A-Za-z]+Route)\(/g)) {
  const handler = `handle${m[1].slice('match'.length)}`
  const block = SERVER.slice(m.index, m.index + 6000)
  for (const r of block.matchAll(/api\\\/v1\\\/([a-z-]+)/g)) families.set(r[1], handler)
}
const familyClosures = new Map()
for (const [prefix, handler] of families) {
  if (!familyClosures.has(handler)) familyClosures.set(handler, [...closureOf(handler)].sort())
}

/* ------------------------------------------------------------------ the probe */

const spec = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8')
const routes = []
let current = null
for (const line of spec.split('\n')) {
  const p = /^  (\/[^:]+):$/.exec(line)
  if (p) { current = { path: p[1], methods: [] }; routes.push(current); continue }
  const m = /^    (get|post|put|patch|delete):$/.exec(line)
  if (m && current) current.methods.push(m[1].toUpperCase())
}

// The fan-outs are excluded: they are genuinely wide, and a probe that waits on
// 46 upstream requests to learn that is a bad trade.
const SKIP = [/\/ingest\/run/, /\/dispatch/]

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-manifest-'))
const store = new JsonStore(path.join(dir, 'store.json'))
const seeded = {}
for (const [collection, records] of Object.entries(emptyStore())) {
  if (!Array.isArray(records) || records.length) continue
  seeded[collection] = [{
    id: 'probe-id', type: collection, name: 'Probe', title: 'Probe', description: 'Seeded so a by-id branch is measured, not its 404',
    status: 'active', state: 'closed', severity: 'high', source: 'open_meteo', district: 'Turkana', country: 'KE',
    latitude: 3.1, longitude: 35.6, observed_at: '2024-03-01T00:00:00Z', created_at: '2024-03-01T00:00:00Z',
  }]
}
await store.merge(seeded)

const touched = new Set()
const instrumented = {
  async read(options) {
    const data = await store.read(options)
    return new Proxy(data, {
      get(t, p) { if (typeof p === 'string' && p in t) touched.add(p); return t[p] },
      has(t, p) { if (typeof p === 'string' && p in t) touched.add(p); return p in t },
    })
  },
  merge: (p) => store.merge(p),
  remove: (p) => store.remove(p),
  write: (p) => store.write(p),
  replaceCollection: (c, r) => store.replaceCollection(c, r),
  replaceAnalytics: (p) => store.replaceAnalytics(p),
}
// A permissive limiter: this fires every route in the spec in a burst, which the
// inbound limiter correctly refuses. A measurement half of whose routes see a
// 429 is not a measurement.
const unlimited = { charge: () => ({ allowed: true, release: () => {} }) }
const listener = createServer({ store: instrumented, inboundLimiter: unlimited }).listen(0)
const base = `http://127.0.0.1:${listener.address().port}`

const probed = {}
for (const route of routes) {
  if (SKIP.some((re) => re.test(route.path))) continue
  const concrete = route.path.replace(/\{[^}]+\}/g, 'probe-id')
  for (const method of route.methods) {
    touched.clear()
    try {
      await fetch(`${base}${concrete}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
        signal: AbortSignal.timeout(3000),
      })
    } catch { /* a 500 or a timeout still tells us what it read on the way there */ }
    if (touched.size) probed[`${method} ${route.path}`] = [...touched].sort()
  }
}
listener.close()
await fs.rm(dir, { recursive: true, force: true })

/* ----------------------------------------------------------------- the union */

const out = {}
for (const { path: routePath, methods } of routes) {
  const prefix = routePath.split('/').filter(Boolean)[2] || ''
  const closure = familyClosures.get(prefix) || []
  for (const method of methods) {
    const key = `${method} ${routePath}`
    const set = new Set([...(probed[key] || []), ...closure])
    const isWrite = method !== 'GET' && method !== 'DELETE'
    // Trust rules, in order of what each pass can actually see.
    //
    // A **write** route is only trusted when a named handler family closed over
    // the source. Without one, the probe is the only measurement, and a probe of
    // a body-validating handler is refused at the door — so a write whose
    // manifest is probe-only is a manifest that saw the rejection path and calls
    // it the whole handler. That is how `POST /api/v1/reports` ended up narrowed
    // to the two collections its *validation failure* touched, and thirteen
    // tests failed on the first real request.
    //
    // A **GET** has no body to reject, so a probe-only measurement of a GET is
    // the common path and is trusted.
    //
    // An empty result is *unknown* rather than "reads nothing" either way, and
    // falls back to `null`: today's whole-store read.
    const trusted = set.size > 0 && set.size <= WIDE && (!isWrite || closure.length > 0)
    out[key] = trusted ? [...set].sort() : null
  }
}

console.log(JSON.stringify(out, null, 1))
const wide = Object.values(out).filter((v) => v === null).length
console.error(`\n${Object.keys(out).length} routes; ${wide} deliberately wide (over ${WIDE} collections); `
  + `${families.size} matcher families closed over the source`)
