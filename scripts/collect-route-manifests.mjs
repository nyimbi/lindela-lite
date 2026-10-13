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
import { fileURLToPath } from 'node:url'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { emptyStore } from '../src/schema.js'
import { routeSources, functionBody } from './route-surface.mjs'

/**
 * The whole surface, not `src/server.js`.
 *
 * This read `src/server.js` alone, and the extraction moved every matcher and
 * every handler out from under it: the source-closure pass below found **zero
 * families** on the tree as of 2026-10-13, so every write route fell to the
 * probe and was recorded wide. That is the fail-safe direction — a wide manifest
 * costs a whole-store read, not a 500 — which is exactly why nobody noticed.
 *
 * The note in `defects.md` under ARC-02 recorded this and named the trigger:
 * "It should read `routeSources()` too the next time it is run." It was run on
 * 2026-10-13, and the pass was dead.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = routeSources(ROOT)
const WIDE = 12
const KNOWN = new Set(Object.keys(emptyStore()))

/* ------------------------------------------------------------ source closure */

/**
 * Every top-level function across the surface, keyed by name.
 *
 * The body comes from `functionBody` in `route-surface.mjs` — the shared parser
 * — rather than from a local brace match, and that is a correctness fix rather
 * than tidiness. The local version took the body to be everything from the first
 * `{`, which for a handler whose signature destructures its dependencies is the
 * **parameter object**: `handleReportingRoute(route, { store, data, … })` matched
 * 110 characters of a 33 KB file and read no collection at all. Every closure was
 * empty for that reason, so the pass below contributed nothing to any route even
 * once it was finding the families.
 *
 * That is the fifth copy of a parser the repository already consolidated, and it
 * had the same defect the consolidation was written to fix. `activeForms` is the
 * one name defined twice — a local adapter in `chw.js` and again in `forms.js` —
 * and first-wins is right for it: both are the same adapter over the same
 * collection, so whichever body is scanned closes over the same reads.
 */
const FUNCTIONS = new Map()
for (const source of SOURCES) {
  for (const m of source.text.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\(/gm)) {
    if (!FUNCTIONS.has(m[1])) FUNCTIONS.set(m[1], source.text)
  }
}
function bodyOf(name) {
  const source = FUNCTIONS.get(name)
  if (!source) return ''
  return functionBody(name, source) || ''
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

/**
 * Path prefix → handler family, from the `matchXRoute` convention.
 *
 * Three things this got wrong, each making the pass a no-op rather than a wrong
 * answer:
 *
 *   - It read `SERVER` — `src/server.js` alone — so after ENH-60 moved the
 *     matchers out it found none. It reads the whole surface now.
 *   - The prefix was scraped with `/api\\\/v1\\\/([a-z-]+)/`, which matches only
 *     the **escaped** spelling inside a regex literal. Every `pathname ===
 *     '/api/v1/kpi/…'` condition is a plain string and matched nothing, so even
 *     before the extraction the map held only the regex-spelled families —
 *     15 of them, missing `kpi`, `districts`, `exposure` and the rest.
 *   - It required the `api/v1/` segment, so `src/routes/stac.js` — whose paths
 *     are `/stac/…` and `/ogc/…` — contributed nothing at all. Its matcher
 *     matched the pattern `function match*Route(` and then scraped zero
 *     prefixes from it, which is indistinguishable from a matcher that names no
 *     path.
 *
 * The prefix is derived the same way the lookup derives it (the first segment
 * after the mount point), so the two cannot disagree again — which is the bug
 * the closure map had in the other direction.
 */
const families = new Map()
const prefixOf = (routePath) => routePath.replace(/^\/(?:api\/v1|stac|ogc)\//, '').split('/')[0] || ''
for (const source of SOURCES) {
  for (const m of source.text.matchAll(/function (match[A-Za-z]+Route)\(/g)) {
    const handler = `handle${m[1].slice('match'.length)}`
    const block = source.text.slice(m.index, m.index + 6000)
    // Every path literal the matcher names, in either spelling: a plain string
    // (`pathname === '/api/v1/x'`) or a regex literal (`pathname.match(/^\/…/)`).
    // The capture keeps its leading slash, because `prefixOf` strips the mount
    // point by matching it — a capture without the slash makes every API path
    // normalise to the single prefix `api`, which is one key for sixty routes.
    for (const r of block.matchAll(/((?:\\?\/)(?:api(?:\\?\/)v1|stac|ogc)(?:\\?\/)[a-z][a-z-]*)/g)) {
      const prefix = prefixOf(r[1].replace(/\\\//g, '/'))
      if (prefix) families.set(prefix, handler)
    }
  }
}

/**
 * The transitive read closure, **keyed by the prefix the lookup uses**.
 *
 * It was keyed by handler name and queried by path prefix — `get('kpi')` against
 * a map holding `handleKpiRoute` — so every lookup missed and the closure
 * contributed nothing to any route. The two passes were each individually
 * plausible, which is why the mismatch survived: the bug is in the join between
 * them, and neither half reads as wrong on its own.
 */
const familyClosures = new Map()
const closuresByHandler = new Map()
for (const [prefix, handler] of families) {
  if (!closuresByHandler.has(handler)) closuresByHandler.set(handler, [...closureOf(handler)].sort())
  familyClosures.set(prefix, closuresByHandler.get(handler))
}

/* ------------------------------------------------------- the self-check first */

/**
 * Refuse to run the probe on a tree where the source pass measured nothing.
 *
 * The summary line reported `0 matcher families closed over the source` and
 * exited **0**, and the table it wrote was consumed by hand. A generator whose
 * measurement found nothing must fail rather than print a number nobody reads:
 * the same rule as a reconciliation script that reports "0 mismatches" because
 * its query matched nothing. It is checked here, before the probe, because the
 * probe takes minutes and a dead pass makes every one of them pointless.
 *
 * Both floors are structural, not tuned. There are 34 matchers under
 * `src/routes/` and every one names at least one path, so `families` cannot be
 * near-empty on a tree where the extraction happened. `kpi` is the canary: it is
 * a plain-string matcher, which is the spelling the old prefix regex could not
 * read, so a regression to escaped-slash-only fails here by name.
 */
const CANARY_PREFIX = 'kpi'
if (families.size < 20) {
  console.error(`collect-route-manifests: parsed only ${families.size} matcher families from the surface. `
    + 'The source-closure pass is dead, and every write route would be recorded wide — '
    + 'which is fail-safe, and therefore silent. Check that routeSources() still finds '
    + 'src/routes/ and that the prefix scrape reads plain-string conditions.')
  process.exit(1)
}
if (!familyClosures.has(CANARY_PREFIX)) {
  console.error(`collect-route-manifests: no closure for prefix '${CANARY_PREFIX}', which is a matcher family. `
    + 'Either the closure map is keyed by something the lookup does not use, or the prefix '
    + 'scrape did not read the spelling this matcher is written in. Both have happened here.')
  process.exit(1)
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
  // The family prefix, derived from the mount point rather than from position.
  //
  // This was `split('/').filter(Boolean)[2]`, which is the third segment — right
  // only for `/api/v1/<family>/…`. STAC and OGC are mounted at `/stac/…` and
  // `/ogc/…`, so position 2 is their *parameter*: `/stac/collections/{id}`
  // derived the prefix `{id}`, which matched no family, and the four STAC/OGC
  // routes silently lost their closure. `stac.js` is exactly the module the
  // matcher map already reads, so the family was there to be found.
  const prefix = routePath.replace(/^\/(?:api\/v1|stac|ogc)\//, '').split('/')[0] || ''
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
