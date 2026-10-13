#!/usr/bin/env node
/**
 * The dispatcher's order is load-bearing, and it was checked by hand.
 *
 * Every extraction note in `enhancements-50.md` ends with some form of "dispatched
 * here, where the block was, so the order the dispatcher tries its routes in is
 * unchanged" — and the events family's note records the only honest way that claim
 * was ever verified: "Verified by grepping the whole dispatcher for both literals,
 * not by reading the blocks." A grep run by a person, once, is not a guard. It is
 * a fact that was true when it was typed.
 *
 * Three things about the order are claims the tree can check:
 *
 *   1. **Which families dispatch, and in what sequence.** A family added, removed,
 *      or moved changes the order another family's path is tried in. When two
 *      families can match one path — and two do, `matchCatalogueRoute` is
 *      dispatched at *two* points for exactly this reason — the sequence decides
 *      the answer.
 *   2. **Which side of the store read each family sits on.** Four families run
 *      before `store.read(readRequest)` and twenty-eight after, and that split is
 *      a correctness property, not a tidiness one: `export.ndjson` streams and
 *      must not materialise the store (SCL-01), `/ready` probes with one scoped
 *      read, and the tile routes read no collection at all. A family that drifts
 *      across the line either materialises a store it does not need or loses the
 *      one read it had. The liveness extraction put a binding in its own temporal
 *      dead zone this way and answered 500, which `check-route-methods` caught.
 *   3. **That no family is orphaned.** A matcher defined in `src/routes/` and not
 *      dispatched is a route family that exists, is tested as a module, and is
 *      unreachable — the shape VER-18 and the inline-shadow defect both took.
 *
 * **The table moved into the source, 2026-10-13.** This file used to carry the
 * order as its own frozen array and read the dispatcher's `const X = matchYRoute(…)`
 * statements out of `src/server.js` to compare against it — the table was kept
 * here "because it must not change behaviour: this records the order, it does not
 * produce it", and the note said the generator would one day read this table and
 * make the dispatcher's statements a loop over it. That landed: `src/route-families.js`
 * now *is* the table, and `handleApiRequestInContext` iterates it. So the order is
 * read at runtime from the module that produces it, which is strictly better than
 * a regex over statements — there is no parser left to drift.
 *
 * The frozen recordings below are kept, and that is the point: they are the
 * expectation the table is checked against. A reorder is a failure naming the
 * diff, not a silent change. The two cross-checks that make this non-circular are
 * the last two in each block — the table's dependency keys are checked against
 * what each handler actually destructures (read from `src/routes/`) and against
 * what the dispatcher's context actually provides (read from `src/server.js`).
 * The table cannot certify itself.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ROUTE_FAMILIES } from '../src/route-families.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'src', 'server.js')
const ROUTES_DIR = path.join(ROOT, 'src', 'routes')

/**
 * The order the dispatcher tries its families in, and the side of the store read
 * each sits on. `pre` is above `const data = await store.read(readRequest)`,
 * `post` is below it.
 *
 * Read off the tree, not designed: this is the state as of the ENH-60 extraction
 * run, recorded so a change to it is deliberate. It is the expectation, not the
 * source — `ROUTE_FAMILIES` is the source.
 */
const DISPATCH_ORDER = Object.freeze([
  ['matchLivenessRoute', 'pre'],
  ['matchExportRoute', 'pre'],
  ['matchTilePackRoute', 'pre'],
  ['matchTileRoute', 'pre'],
  ['matchKpiRoute', 'post'],
  ['matchFieldSignalRoute', 'post'],
  ['matchExposureRoute', 'post'],
  ['matchDerivedRoute', 'post'],
  ['matchSnapshotRoute', 'post'],
  ['matchAuthInfoRoute', 'post'],
  ['matchCatalogueRoute', 'post'],
  ['matchWebhookRoute', 'post'],
  ['matchFederationRoute', 'post'],
  ['matchOutboxRoute', 'post'],
  ['matchUploadRoute', 'post'],
  ['matchScenarioRoute', 'post'],
  ['matchIngestionRoute', 'post'],
  ['matchFormsRoute', 'post'],
  ['matchMaintenanceRoute', 'post'],
  ['matchEventsRoute', 'post'],
  ['matchAmbientRoute', 'post'],
  ['matchRiskRoute', 'post'],
  ['matchComputeRoute', 'post'],
  ['matchRapidProRoute', 'post'],
  ['matchProvenanceRoute', 'post'],
  ['matchReportingRoute', 'post'],
  ['matchAlertingRoute', 'post'],
  ['matchCatalogueRoute', 'post'],
  ['matchParametricRoute', 'post'],
  ['matchOperationalRoute', 'post'],
  ['matchChwRoute', 'post'],
  ['matchWorkflowRoute', 'post'],
  ['matchDistrictRoute', 'post'],
].map(Object.freeze))

/**
 * Which handler each matcher is bound to, and the dependency keys it is given.
 *
 * The order table above records that `matchKpiRoute` runs sixth. It does not
 * record that `matchKpiRoute` is paired with `handleKpiRoute` — and a matcher
 * wired to the wrong handler, with the same dependency shape, passes every
 * assertion above. The dependency keys are a sorted set rather than a sequence,
 * because their order in the object literal is not observable: the handler
 * destructures by name. `loadData` and `vintageIndex` are the entries that are
 * passed in rather than imported — the thunks and the one binding that lives in
 * `server.js` — so a family that stopped receiving its thunk would answer 500 on
 * a route built not to materialise the store, which is the liveness defect's
 * shape.
 *
 * Two entries for `matchCatalogueRoute`: it is dispatched twice, and the two
 * entries carry the same handler and the same keys.
 */
const BINDINGS = Object.freeze([
  ['matchLivenessRoute', 'handleLivenessRoute', ['appVersion', 'driverIntervalSeconds', 'idempotency', 'jsonResponse', 'loadData', 'pipelineIsHealthy', 'req', 'res', 'store', 'url', 'withTimeout']],
  ['matchExportRoute', 'handleExportRoute', ['jsonResponse', 'loadData', 'req', 'res', 'store', 'url', 'vintageIndex']],
  ['matchTilePackRoute', 'handleTilePackRoute', ['jsonResponse', 'req', 'res', 'url']],
  ['matchTileRoute', 'handleTileRoute', ['jsonResponse', 'req', 'res', 'url']],
  ['matchKpiRoute', 'handleKpiRoute', ['data', 'jsonResponse', 'req', 'requestRing', 'res', 'store', 'url']],
  ['matchFieldSignalRoute', 'handleFieldSignalRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchExposureRoute', 'handleExposureRoute', ['data', 'jsonResponse', 'req', 'res', 'url']],
  ['matchDerivedRoute', 'handleDerivedRoute', ['data', 'jsonResponse', 'req', 'res', 'url']],
  ['matchSnapshotRoute', 'handleSnapshotRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchAuthInfoRoute', 'handleAuthInfoRoute', ['auth', 'jsonResponse', 'res']],
  ['matchCatalogueRoute', 'handleCatalogueRoute', ['data', 'jsonResponse', 'req', 'res', 'url']],
  ['matchWebhookRoute', 'handleWebhookRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchFederationRoute', 'handleFederationRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchOutboxRoute', 'handleOutboxRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchUploadRoute', 'handleUploadRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchScenarioRoute', 'handleScenarioRoute', ['data', 'jsonResponse', 'req', 'res']],
  ['matchIngestionRoute', 'handleIngestionRoute', ['data', 'evaluateAndPersistAlerts', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchFormsRoute', 'handleFormsRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchMaintenanceRoute', 'handleMaintenanceRoute', ['data', 'jsonResponse', 'readRequestJson', 'req', 'res', 'store', 'url', 'withTimeout']],
  ['matchEventsRoute', 'handleEventsRoute', ['data', 'jsonResponse', 'req', 'res', 'url']],
  ['matchAmbientRoute', 'handleAmbientRoute', ['data', 'jsonResponse', 'req', 'res', 'url']],
  ['matchRiskRoute', 'handleRiskRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchComputeRoute', 'handleComputeRoute', ['data', 'evaluateAndPersistAlerts', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchRapidProRoute', 'handleRapidProRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchProvenanceRoute', 'handleProvenanceRoute', ['data', 'jsonResponse', 'req', 'res', 'url']],
  ['matchReportingRoute', 'handleReportingRoute', ['checkWebhookUrl', 'data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchAlertingRoute', 'handleAlertingRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchCatalogueRoute', 'handleCatalogueRoute', ['data', 'jsonResponse', 'req', 'res', 'url']],
  ['matchParametricRoute', 'handleParametricRoute', ['data', 'jsonResponse', 'req', 'res', 'store']],
  ['matchOperationalRoute', 'handleOperationalRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchChwRoute', 'handleChwRoute', ['data', 'jsonResponse', 'req', 'res', 'store']],
  ['matchWorkflowRoute', 'handleWorkflowRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
  ['matchDistrictRoute', 'handleDistrictRoute', ['data', 'jsonResponse', 'req', 'res', 'store', 'url']],
].map(Object.freeze))

const serverSource = () => fs.readFileSync(SERVER, 'utf8')

/** The table as the dispatcher reads it: matcher name, side, handler, keys. */
function fromTable() {
  return ROUTE_FAMILIES.map((f) => [
    f.match.name,
    f.pre ? 'pre' : 'post',
    f.handle.name,
    [...f.deps].sort(),
  ])
}

/** Every matcher a module under `src/routes/` exports. */
function declaredMatchers() {
  const out = []
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
    for (const m of text.matchAll(/^export function (match[A-Za-z]+Route)\(/gm)) {
      out.push([file, m[1]])
    }
  }
  return out
}

/**
 * Every key a handler destructures from its second argument, by name.
 *
 * Read from the route module, not from the table, which is what makes this a
 * cross-check rather than a tautology: the table says a family is handed
 * `jsonresponse`, and the handler's own signature is what says whether anything
 * reads it. A key the handler does not destructure is either a misspelling or a
 * binding nobody consumes, and both are silent at runtime — the handler reads
 * `undefined`.
 */
function handlerKeys() {
  const out = new Map()
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
    for (const m of text.matchAll(/^export (?:async )?function (handle[A-Za-z]+Route)\(/gm)) {
      const open = text.indexOf('(', m.index)
      let depth = 0
      let close = open
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '(') depth += 1
        else if (text[i] === ')') { depth -= 1; if (!depth) { close = i; break } }
      }
      const params = text.slice(open + 1, close)
      const brace = params.indexOf('{')
      if (brace < 0) { out.set(m[1], []); continue }
      let bdepth = 0
      let bend = brace
      for (let i = brace; i < params.length; i += 1) {
        if (params[i] === '{') bdepth += 1
        else if (params[i] === '}') { bdepth -= 1; if (!bdepth) { bend = i; break } }
      }
      const keys = params.slice(brace + 1, bend).split(',')
        .map((part) => part.split('=')[0].trim().replace(/:.*/, '').trim())
        .filter(Boolean)
      out.set(m[1], keys)
    }
  }
  return out
}

/**
 * Every key the dispatcher's context provides, read from `src/server.js`.
 *
 * The table names the keys a family wants; this names the keys the dispatcher
 * has. A key in the first and not the second is `undefined` in the handler with
 * nothing to say so — the silent-empty shape, at the dispatch layer.
 */
function contextKeys() {
  const text = serverSource()
  const open = text.indexOf('const familyCtx = {')
  assert.ok(open >= 0, 'the dispatcher must build a family context; if it moved, this check must move with it')
  let depth = 0
  let end = open
  for (let i = text.indexOf('{', open); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (!depth) { end = i; break } }
  }
  const body = text.slice(text.indexOf('{', open) + 1, end)
  // Split on top-level commas: a key like `loadData: () => store.read(readRequest)`
  // carries commas of its own, so a naive `.split(',')` would read `store.read(readRequest)`
  // as a key. Depth-tracked, so only the separators between properties count.
  const parts = []
  let commaDepth = 0
  let current = ''
  for (const ch of body) {
    if ('([{'.includes(ch)) commaDepth += 1
    else if (')]}'.includes(ch)) commaDepth -= 1
    if (ch === ',' && commaDepth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  const keys = new Set()
  for (const part of parts) {
    // Both spellings: `appVersion: APP_VERSION` and the shorthand `store`. The
    // shorthand form is the one a colon-only regex misses, and it is most of the
    // literal — the failure this check exists to catch, wearing its own clothes.
    const m = part.match(/^\s*([A-Za-z_]\w*)\s*(?::|$)/)
    if (m) keys.add(m[1])
  }
  // `postCtx = { ...familyCtx, data }` adds `data`, which the post families take.
  if (/const postCtx = \{ \.\.\.familyCtx, data \}/.test(text)) keys.add('data')
  return keys
}

describe('the dispatcher tries its families in a known order', () => {
  it('finds the families at all', () => {
    // A scan that matches nothing reports no diff and passes. This is the guard
    // on the guard: the table has 33 entries (32 families, the catalogue twice),
    // and a table that lost them must fail here rather than certify an empty
    // dispatcher.
    const found = fromTable()
    assert.ok(found.length >= 30, `expected the extracted families, found ${found.length}`)
  })

  it('dispatches every family in the recorded sequence', () => {
    const found = fromTable()
    assert.deepEqual(
      found.map(([name]) => name),
      DISPATCH_ORDER.map(([name]) => name),
      'the dispatch order changed — if that is deliberate, update DISPATCH_ORDER in this file and say why in the commit',
    )
  })

  it('keeps each family on its recorded side of the store read', () => {
    const found = fromTable().map(([n, p]) => [n, p])
    assert.deepEqual(found, DISPATCH_ORDER.map(([n, p]) => [n, p]))
  })

  it('runs the four streamers and probes above the read, and everything else below', () => {
    // The split by name, so a drift is legible in the failure rather than only
    // in the count: these four are above the read for a reason each.
    const found = fromTable()
    const pre = found.filter(([, p]) => p === 'pre').map(([n]) => n)
    assert.deepEqual(pre, [
      'matchLivenessRoute', // `/ready` must not materialise the store
      'matchExportRoute', // `export.ndjson` streams; SCL-01's budget
      'matchTilePackRoute', // arithmetic over a bbox; reads no collection
      'matchTileRoute', // the raster proxy; reads no collection
    ])
    assert.equal(found.filter(([, p]) => p === 'post').length, 29)
  })

  it('leaves no matcher orphaned — every family module is dispatched', () => {
    // The table is the dispatch, so a matcher defined under `src/routes/` and
    // absent from it is a route family that exists, is tested as a module, and
    // is unreachable. The STAC and OGC matchers are called from `handleApi`,
    // above `handleApiRequestInContext`, and are correctly absent — the order
    // that matters is *within* the dispatcher, and these run before it. So the
    // check reads the whole server source, not the table alone.
    const source = serverSource()
    const dispatchedNames = new Set(ROUTE_FAMILIES.map((f) => f.match.name))
    const orphaned = declaredMatchers()
      .filter(([, matcher]) => !dispatchedNames.has(matcher))
      // A matcher called from somewhere in `server.js` is dispatched there.
      .filter(([, matcher]) => !new RegExp(`\\b${matcher}\\s*\\(`).test(source))
      // `auth-gate.js` is the one module with no matcher: it runs before matching
      // and returns a verdict. It is not a family and is not in the table.
      .map(([file, matcher]) => `${file}: ${matcher}`)
    assert.deepEqual(orphaned, [], 'a matcher defined under src/routes/ is dispatched from nowhere')
  })

  it('names every dispatched family a module actually exports', () => {
    // The other direction: a table entry naming a matcher no module defines is a
    // family that was renamed or deleted — a stale entry a rename leaves behind.
    const declared = new Set(declaredMatchers().map(([, m]) => m))
    const ghosts = DISPATCH_ORDER.map(([n]) => n).filter((n) => !declared.has(n))
    assert.deepEqual(ghosts, [], 'DISPATCH_ORDER names a matcher no module exports')
  })

  it('the dispatcher actually loops over the table — it is not a dead declaration', () => {
    // The one thing that ties the table to the request path. A table that is
    // imported and never iterated would satisfy every assertion above and serve
    // nothing, which is the "mechanism shipped, caller missing" shape the audit
    // catalogues. Both loops are asserted, because dropping the `pre` loop would
    // leave the four above-read families unreachable while the table still
    // listed them.
    const text = serverSource()
    assert.match(text, /for \(const family of ROUTE_FAMILIES\)/, 'the dispatcher must iterate the table')
    const loops = [...text.matchAll(/for \(const family of ROUTE_FAMILIES\) \{([\s\S]*?)\n  \}/g)]
    assert.equal(loops.length, 2, 'the dispatcher must loop the table once per side of the read')
    assert.match(loops[0][1], /if \(!family\.pre\) continue/, 'the first loop runs the pre-read families')
    assert.match(loops[1][1], /if \(family\.pre\) continue/, 'the second loop runs the post-read families')
    assert.match(text, /await dispatchFamily\(family, familyCtx\)/)
    assert.match(text, /await dispatchFamily\(family, postCtx\)/)
  })

  it('the scan can see a family that is present — the canary', () => {
    // `0` is also what a broken read returns, so the scan is pointed at a
    // matcher known to be in the table. If this fails, every assertion above is
    // passing on an empty set.
    const planted = 'matchDistrictRoute'
    assert.ok(declaredMatchers().some(([, m]) => m === planted), 'canary target must exist')
    const found = fromTable().map(([n]) => n)
    assert.ok(found.includes(planted), `the scan must find ${planted}, which is dispatched`)
  })
})

describe('the dispatcher binds each matcher to its own handler', () => {
  it('pairs every matcher with the handler the table records', () => {
    const found = fromTable()
    assert.deepEqual(
      found.map(([m, , h]) => [m, h]),
      BINDINGS.map(([m, h]) => [m, h]),
      'a matcher is wired to a different handler than recorded',
    )
  })

  it('gives every handler the dependency keys the table records', () => {
    const found = fromTable()
    assert.deepEqual(
      found.map(([m, , , k]) => [m, k]),
      BINDINGS.map(([m, , k]) => [m, k]),
      'a handler gained or lost a dependency key',
    )
  })

  it('hands every family a key its handler actually destructures', () => {
    // The cross-check that makes the table non-circular. A key in `deps` the
    // handler does not name is either a misspelling (`jsonresponse`) or a binding
    // nobody consumes — both silent, both read as `undefined` in the handler.
    const signatures = handlerKeys()
    const wrong = []
    for (const f of ROUTE_FAMILIES) {
      const keys = signatures.get(f.handle.name)
      assert.ok(keys, `${f.handle.name} must be a handler a route module exports`)
      for (const dep of f.deps) {
        if (!keys.includes(dep)) wrong.push(`${f.handle.name} is handed '${dep}', which it does not destructure`)
      }
    }
    assert.deepEqual(wrong, [])
  })

  it('hands every family a key the dispatcher context actually provides', () => {
    // The other half: a key in `deps` the context does not build is `undefined`
    // in the handler, with nothing to say so. The table and the context are
    // written in two files, and this is what keeps them one fact.
    const provided = contextKeys()
    const missing = []
    for (const f of ROUTE_FAMILIES) {
      for (const dep of f.deps) {
        if (!provided.has(dep)) missing.push(`${f.match.name} wants '${dep}', which the dispatcher context does not provide`)
      }
    }
    assert.deepEqual(missing, [])
  })
})
