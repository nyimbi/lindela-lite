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
 *      families can match one path — and two can, `catalogue.js` is dispatched at
 *      *two* points for exactly this reason — the sequence decides the answer.
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
 * The table below is the single declaration the dispatcher lacks (ENH-59), kept
 * here rather than in the source because it must not change behaviour: this
 * records the order, it does not produce it. When ENH-59's generator lands, the
 * generator reads this table and the dispatcher's statements become a loop over
 * it; until then the two are checked against each other, so a reorder is a test
 * failure with the diff named rather than a silent change no one sees.
 *
 * This is a source-text assertion, which is normally the wrong instrument — but
 * the thing compared is *the order of function calls in one file*, and there is
 * no runtime event that observes "the dispatcher would have tried B before A".
 * The failure it guards is a statement moved in a file. `route-scope-coverage`'s
 * note makes the same trade for the same reason, and it carries the same
 * protection: the scan asserts it found the families, so a regex that stopped
 * matching reports nothing and fails rather than passing on an empty set.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'src', 'server.js')
const ROUTES_DIR = path.join(ROOT, 'src', 'routes')

/**
 * The order the dispatcher tries its families in, and the side of the store read
 * each sits on. `pre` is above `const data = await store.read(readRequest)`,
 * `post` is below it.
 *
 * Read off the tree, not designed: this is the state as of the ENH-60 extraction
 * run, recorded so a change to it is deliberate.
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
  ['matchParametricRoute', 'post'],
  ['matchOperationalRoute', 'post'],
  ['matchChwRoute', 'post'],
  ['matchWorkflowRoute', 'post'],
  ['matchDistrictRoute', 'post'],
].map(Object.freeze))

const serverSource = () => fs.readFileSync(SERVER, 'utf8')

/** The body of `handleApiRequestInContext`, by the parser that already owns it. */
function dispatcherLines(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => /function handleApiRequestInContext\(/.test(l))
  assert.ok(start >= 0, 'handleApiRequestInContext must exist')
  let depth = 0
  let started = false
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; started = true } else if (ch === '}') depth -= 1
    }
    if (started && depth === 0) return lines.slice(start, i + 1)
  }
  throw new Error('handleApiRequestInContext has unbalanced braces')
}

/** Where the store read is, relative to the dispatcher body. */
function readIndex(body) {
  const at = body.findIndex((l) => /const data = await store\.read\(readRequest\)/.test(l))
  assert.ok(at >= 0, 'the dispatcher must read the store; if the read moved, this check must move with it')
  return at
}

/** Every `const X = matchYRoute(…)` in the body, in order, with its side. */
function dispatched(body) {
  const readAt = readIndex(body)
  const found = []
  for (let i = 0; i < body.length; i += 1) {
    const m = body[i].match(/^\s*const \w+ = (match\w+)\(/)
    if (m) found.push([m[1], i < readAt ? 'pre' : 'post'])
  }
  return found
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

describe('the dispatcher tries its families in a known order', () => {
  it('finds the families at all', () => {
    // A scan that matches nothing reports no diff and passes. This is the guard
    // on the guard: the extraction has 32 families, and a regex that stopped
    // reading them must fail here rather than certify an empty dispatcher.
    const found = dispatched(dispatcherLines(serverSource()))
    assert.ok(found.length >= 30, `expected the extracted families, found ${found.length}`)
  })

  it('dispatches every family in the recorded sequence', () => {
    const found = dispatched(dispatcherLines(serverSource()))
    assert.deepEqual(
      found.map(([name]) => name),
      DISPATCH_ORDER.map(([name]) => name),
      'the dispatch order changed — if that is deliberate, update DISPATCH_ORDER in this file and say why in the commit',
    )
  })

  it('keeps each family on its recorded side of the store read', () => {
    const found = dispatched(dispatcherLines(serverSource()))
    assert.deepEqual(found, DISPATCH_ORDER.map(([n, p]) => [n, p]))
  })

  it('runs the four streamers and probes above the read, and everything else below', () => {
    // The split by name, so a drift is legible in the failure rather than only
    // in the count: these four are above the read for a reason each.
    const found = dispatched(dispatcherLines(serverSource()))
    const pre = found.filter(([, p]) => p === 'pre').map(([n]) => n)
    assert.deepEqual(pre, [
      'matchLivenessRoute', // `/ready` must not materialise the store
      'matchExportRoute', // `export.ndjson` streams; SCL-01's budget
      'matchTilePackRoute', // arithmetic over a bbox; reads no collection
      'matchTileRoute', // the raster proxy; reads no collection
    ])
    assert.equal(found.filter(([, p]) => p === 'post').length, 28)
  })

  it('leaves no matcher orphaned — every family module is dispatched', () => {
    // The whole server source, not only the dispatcher body: the STAC and OGC
    // matchers are called from `handleApi`, above `handleApiRequestInContext`.
    // They are dispatched and correctly absent from DISPATCH_ORDER — the order
    // that matters is *within* the dispatcher, and these run before it. Scoping
    // this check to the dispatcher body alone reported two correct families as
    // orphans, which is the failure a check that names the wrong jurisdiction
    // always has.
    const source = serverSource()
    const orphaned = declaredMatchers()
      .filter(([, matcher]) => !new RegExp(`\\b${matcher}\\s*\\(`).test(source))
      // `auth-gate.js` is the one module with no matcher: it runs before matching
      // and returns a verdict. It is not a family and is not in the table.
      .map(([file, matcher]) => `${file}: ${matcher}`)
    assert.deepEqual(orphaned, [], 'a matcher defined under src/routes/ is dispatched from nowhere')
  })

  it('names every dispatched family a module actually exports', () => {
    // The other direction: a table entry naming a matcher no module defines is a
    // family that was renamed or deleted, and the dispatcher would not compile —
    // but a *stale* entry is what a rename leaves behind in this file.
    const declared = new Set(declaredMatchers().map(([, m]) => m))
    const ghosts = DISPATCH_ORDER.map(([n]) => n).filter((n) => !declared.has(n))
    assert.deepEqual(ghosts, [], 'DISPATCH_ORDER names a matcher no module exports')
  })

  it('the scan can see a family that is present — the canary', () => {
    // `0` is also what a broken regex returns, so the scan is pointed at a
    // matcher known to be in the dispatcher. If this fails, every assertion
    // above is passing on an empty set.
    const body = dispatcherLines(serverSource())
    const planted = 'matchDistrictRoute'
    assert.ok(declaredMatchers().some(([, m]) => m === planted), 'canary target must exist')
    const found = dispatched(body).map(([n]) => n)
    assert.ok(found.includes(planted), `the scan must find ${planted}, which is dispatched`)
  })
})
