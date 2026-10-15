#!/usr/bin/env node
/**
 * ENH-01: the route→scope table, made checkable.
 *
 * `src/auth.js` denies an unmapped mutation by returning `DENIED_SCOPE`
 * (`admin:*`), which no scoped token holds. That is the right default and it is
 * also the reason the table could rot unnoticed: a new route with no entry is
 * *closed*, so it behaves correctly from the outside. Nothing failed, nothing
 * looked wrong, and two routes sat in exactly that state — `POST
 * /api/v1/routing/plan` and `POST /api/v1/equity/scan` both 403'd a token
 * carrying every scope the documentation named.
 *
 * So the check cannot be behavioural. It has to enumerate the mutating routes
 * out of `server.js` and require each one to appear in `WRITE_SCOPES`. That is
 * only possible because the table is exported; it was module-private, which made
 * the deny-by-default rule the one rule in the codebase with no way to test it.
 *
 * Reading route literals out of source is normally the wrong move — it is a
 * source-text guard, and it goes stale when a route moves. It is the right move
 * here for a specific reason: the thing being compared is a *list of string
 * literals in the same language*, and the failure this guards is a literal being
 * added to one list and not the other. There is no runtime event to observe. The
 * guard's own staleness is covered below — it asserts it found routes, so a
 * regex that stopped matching reports nothing and passes.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { READ_SCOPES, WRITE_SCOPES, ROUTE_SCOPES, DENIED_SCOPE, declaredScopeFor, scopeForRoute } from '../src/auth.js'
import { routeSources } from '../scripts/route-surface.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The whole route surface as one string: `src/server.js` plus every module under
 * `src/routes/`, from the shared derivation in `scripts/route-surface.mjs`.
 *
 * This was `src/server.js` alone until 2026-10-12. ENH-60 moved the liveness
 * pair into `src/routes/liveness.js` and the posture assertions below — which
 * read source text on purpose, because the thing compared is a list of string
 * literals in the same language — stopped finding `/api/v1/health` and
 * `public_paths: publicPaths()`. The route moved; the route's *answers* did not.
 * Reading the surface rather than one file is what keeps that distinction.
 */
const SURFACE = routeSources(ROOT).map((s) => s.text).join('\n')

const SPEC = fs.readFileSync(path.join(ROOT, 'docs', 'openapi.yaml'), 'utf8')

/**
 * Every `(method, path)` the OpenAPI document declares.
 *
 * The route list comes from the document rather than from `src/server.js`
 * because reconstructing `(method, path)` pairs out of the server is not
 * possible by reading its text. Only 11 of 53 mutating routes write the method
 * and the path in the same `if`; the rest are delegated to eleven
 * `match*Route` helpers whose method check lives somewhere else in the handler,
 * behind a `route.kind` branch. A scan that paired them found 11 routes,
 * reported every one mapped, and was right about nothing — the same result a
 * scanner matching nothing would produce.
 *
 * `docs/openapi.yaml` declares all 122 in `path:` / `method:` pairs and
 * `scripts/check-openapi.mjs` already fails the build when the document and the
 * served routes disagree in either direction. So a route that is in the
 * document but not in the table, or a method nobody documented, is caught
 * there. This file asks the question the document cannot: does every mutating
 * route a client can generate from it have a scope?
 */
const ROUTES = []
for (const pathMatch of SPEC.matchAll(/^ {2}(\/[^:\n]*):\s*$/gm)) {
  const routePath = pathMatch[1]
  // One path's methods are the `get:`/`post:` keys in its block, which runs
  // until the next path at the same indent or the end of `paths:`.
  const rest = SPEC.slice(pathMatch.index)
  const next = rest.slice(1).search(/^ {2}\/[^:\n]*:\s*$/m)
  const block = next === -1 ? rest : rest.slice(0, next + 1)
  for (const methodMatch of block.matchAll(/^ {4}(get|post|put|patch|delete|head):\s*$/gim)) {
    ROUTES.push({ method: methodMatch[1].toUpperCase(), pathname: routePath })
  }
}

const MUTATING = ROUTES.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')

/**
 * Prefixes `src/server.js` answers *before* the auth gate, so no scope applies.
 *
 * A route here authenticates and returns without ever calling `scopeForRoute`,
 * which makes it correct for it to have no scope row — and makes a row for it
 * policy nothing reads. Kept as a list rather than a comment because the read
 * coverage test below excludes these, and an exclusion that cannot be checked is
 * how a failing coverage test gets made to pass.
 */
const BEFORE_GATE = ['/stac/', '/ogc/']

/**
 * The scope the gate would require.
 *
 * This used to reimplement the match — `table.find(([prefix]) => …)` — with a
 * comment claiming it was "the same match the gate makes". It was not, and the
 * two drifted the moment the gate learned `:name` patterns: a duplicate matcher
 * is a probe that reimplements the thing under test, and it agrees only until
 * the thing changes. `scopeForRoute` is exported, so the test calls it.
 */
function scopeFor(method, pathname) {
  // `scopeForRoute` folds "unmapped" into `admin:*`, which is also a real scope
  // a row may name — `/api/v1/metrics` names it deliberately. Reading its return
  // value alone therefore cannot tell a route somebody classified as
  // administrative from one nobody classified, and this file's whole subject is
  // the second. `declaredScopeFor` is the table's own answer: `null` means no row
  // matched, which is the one that matters, and a declared `admin:*` comes back
  // as the string it is.
  return declaredScopeFor(method, pathname)
}

describe('the route table is a thing a test can read', () => {
  it('exports both halves and their union', () => {
    assert.ok(Array.isArray(READ_SCOPES) && READ_SCOPES.length > 0)
    assert.ok(Array.isArray(WRITE_SCOPES) && WRITE_SCOPES.length > 0)
    assert.equal(ROUTE_SCOPES.length, READ_SCOPES.length + WRITE_SCOPES.length)
    // Frozen, so a caller cannot extend the table at runtime and quietly widen
    // what a module import can reach.
    assert.throws(() => { WRITE_SCOPES.push(['/api/v1/anything', 'admin:*']) }, TypeError)
  })

  it('names no pattern twice within a table', () => {
    // A duplicate is not a wider grant — the matcher takes the longest match and
    // a tie is resolved by table order — so a second identical row is dead text
    // that reads like policy.
    //
    // Note what this no longer forbids: `/api/v1/parametric-rules` and
    // `/api/v1/parametric-rules/:id/simulate` are *not* duplicates. They are
    // different patterns with different lengths, and the longer one wins for the
    // subpath it names. Before the matcher learned `:name`, the table could not
    // express that at all and the specific row had to be dropped or shadowed.
    for (const [name, table] of [['READ_SCOPES', READ_SCOPES], ['WRITE_SCOPES', WRITE_SCOPES]]) {
      const patterns = table.map(([pattern]) => pattern)
      const dupes = patterns.filter((p, i) => patterns.indexOf(p) !== i)
      assert.deepEqual(dupes, [], `${name} lists a pattern twice`)
    }
  })

  it('gives every entry a scope that looks like a scope', () => {
    // `['/api/v1/x', 'read:incident']` would deny correctly and read as though
    // it granted something. The scope vocabulary is small enough to hold.
    //
    // A scope may be a disjunction — `role:chw|write:incidents` — because the
    // API document writes several routes that way and a table that can hold only
    // one alternative refuses the audience it did not name.
    const scopes = new Set()
    for (const [, scope] of [...READ_SCOPES, ...WRITE_SCOPES]) {
      for (const alternative of scope.split('|')) {
        assert.match(alternative, /^(read|write|admin|role):[a-z*]+$|^\*$/, `malformed scope '${alternative}' in '${scope}'`)
        scopes.add(alternative)
      }
    }
    assert.ok(scopes.size > 5, 'a table with one scope in it is a constant')
  })

  it('has no write entry that a read entry already covers more loosely', () => {
    // `/api/v1/alert-events` at `read:alerts` and at `admin:alerts` is
    // deliberate. `/api/v1/analytics` at `read:*` would not be.
    //
    // `role:` is admitted here, and narrowly: it is how the document names the
    // audience for the CHW surface and the parametric simulator, and both are
    // writes. A role is not a data scope, so `requireScope` keeps the widening
    // one-directional — `role:chw` cannot reach `admin:alerts`.
    for (const [pattern, scope] of WRITE_SCOPES) {
      for (const alternative of scope.split('|')) {
        assert.ok(
          alternative.startsWith('write:') || alternative.startsWith('admin:') || alternative.startsWith('role:') || alternative === '*',
          `${pattern} is writable with '${alternative}', which is not a write, admin or role scope`,
        )
      }
    }
  })
})

describe('every mutating route is on the list', () => {
  it('found the routes to check', () => {
    // Without this, a regex that stopped matching the document would report an
    // empty list, find nothing unmapped, and pass — the exact shape of the
    // responsive gate that measured zero controls and called it a pass.
    assert.ok(ROUTES.length > 100, `expected the documented route table, parsed ${ROUTES.length}`)
    assert.ok(MUTATING.length > 40, `expected many mutating routes, parsed ${MUTATING.length}`)
    assert.ok(ROUTES.some((r) => r.pathname === '/api/v1/health' && r.method === 'GET'), 'and they are the real ones')
    assert.ok(ROUTES.some((r) => r.method === 'DELETE'), 'including the methods that are not POST')
    assert.ok(ROUTES.some((r) => r.pathname.includes('{')), 'and the parameterised ones')
  })

  it('maps every one of them to a scope', () => {
    const unmapped = MUTATING.filter((r) => scopeFor(r.method, r.pathname) === null)
    assert.deepEqual(
      unmapped.map((r) => `${r.method} ${r.pathname}`),
      [],
      'these fail closed to admin:* — correct by default, and invisible to every caller',
    )
    for (const r of unmapped) console.error(`  unmapped: ${r.method} ${r.pathname}  (${r.file})`)
  })

  it('keeps the two routes that were missing on their own scope', () => {
    // They 403'd, not leaked. The test names them so that a future removal from
    // the table is a deliberate act rather than a silent narrowing.
    assert.equal(scopeFor('POST', '/api/v1/routing/plan'), 'admin:workflows')
    assert.equal(scopeFor('POST', '/api/v1/equity/scan'), 'admin:analytics')
  })

  it('refuses an unmapped mutation, so a regression here is loud', () => {
    // If someone deletes an entry, the next assertion fails — but this proves the
    // default is what the whole design rests on, in the present tense.
    assert.equal(scopeForRoute('POST', '/api/v1/nonexistent'), DENIED_SCOPE)
    assert.equal(scopeForRoute('DELETE', '/api/v1/nonexistent/deep'), DENIED_SCOPE)
  })

  it('refuses an unmapped read as well as an unmapped write', () => {
    // This test used to assert the opposite. It called `read:hazards` "the
    // deliberate choice for an unmapped read" and pinned it, which meant the
    // defect could not be fixed without rewriting the test that described it.
    //
    // `read:hazards` is a real, routinely-issued scope — the narrowest one the
    // platform hands out — so a catch-all on it is not a conservative default.
    // It is the widest one in practice: about twenty routes (the institutional
    // KPI report, equity, model drift, data lineage, parametric disbursements,
    // trigger protocol configuration, the audit chain) were readable by it and
    // had never been classified.
    assert.equal(scopeForRoute('GET', '/api/v1/nonexistent'), DENIED_SCOPE,
      'an unclassified read route is closed, exactly as an unclassified write is')
    assert.equal(scopeForRoute('GET', '/api/v1/nonexistent/deep'), DENIED_SCOPE)
  })

  it('maps every documented read that the gate checks', () => {
    // The half that was missing. The suite above enumerates *mutating* routes,
    // so when ENH-15 turned the read fallback from `read:hazards` into a denial
    // nothing failed — the routes the fallback had been quietly serving were
    // never enumerated. They 403'd instead, and the first caller to notice was
    // the console's own map overlay: `/api/v1/weather` and every basemap tile
    // return 403 to a `read:hazards` token, verified against a running server.
    //
    // The document is the enumeration source for the same reason the mutating
    // test uses it: reconstructing `(method, path)` pairs from the dispatcher's
    // text is not possible, and `check-openapi` already fails the build when the
    // document and the served surface disagree in either direction. So "every
    // documented GET the gate would check has a scope" is a real statement about
    // the served surface.
    //
    // Excluded, and each for a reason rather than to make the list pass:
    //   * the two shipped public paths, which never reach `scopeForRoute`;
    //   * STAC and OGC, which `src/server.js` answers in front of the gate —
    //     they call `authenticate` and then return, so a scope row for them
    //     would be policy nothing consults, which is the failure mode this
    //     whole file exists to catch.
    //
    // `/metrics` used to be on that second list and is not any more. It was
    // answered above the gate doing its own `authenticate`, which enforced
    // *authentication* and never *authorization*: any valid token read the
    // request rates and route labels. It now answers through `enforceAuthGate`
    // like every other route, so it is a scope-checked read and it belongs in
    // `checked` — where the row added to `READ_SCOPES` for it is what keeps it
    // from failing closed to `admin:*`. Removing it from this list is the whole
    // point: an exclusion that outlives the code path it names is a route the
    // coverage test has been told not to look at.
    //
    // The second exclusion is checked rather than asserted. `BEFORE_GATE` names
    // the paths the dispatcher answers early, and the test below proves each is
    // really written above the `enforceAuthGate` call — so the list cannot grow
    // to hide a route that is genuinely scope-checked, which is exactly how an
    // exclusion list becomes a way to make a failing check pass.
    const PUBLIC = new Set(['/api/v1/health', '/api/v1/ready'])
    const checked = ROUTES.filter((r) => (r.method === 'GET' || r.method === 'HEAD')
      && !PUBLIC.has(r.pathname)
      && !BEFORE_GATE.some((p) => r.pathname.startsWith(p)))
    assert.ok(checked.length > 100, `expected the documented read surface, parsed ${checked.length}`)
    const unmapped = checked.filter((r) => scopeFor(r.method, r.pathname) === null)
    assert.deepEqual(
      unmapped.map((r) => `${r.method} ${r.pathname}`),
      [],
      'these reads fail closed to admin:* — a 403 for every scoped token, not a leak',
    )
  })

  it('answers every before-gate exclusion in front of the scope check', () => {
    // The exclusion above is a claim about dispatch order, and dispatch order is
    // not readable at runtime. So it is read from the source, once, and the
    // claim is narrow: every mention of an excluded prefix in `src/server.js`
    // sits above the line that calls `enforceAuthGate`. A path moved below the
    // gate stops being an exclusion and starts being an unmapped read the test
    // above must catch.
    //
    // *Every* mention, not the first. `findIndex` reads the first occurrence,
    // and a prefix answered above the gate and again below it would pass while
    // the second copy served an unchecked read — the "path served twice" shape
    // this codebase has been bitten by before. So the assertion is on the last
    // occurrence: if any mention is below the gate, the last one is too.
    const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8').split('\n')
    // The *last* gate call, not the first. `findIndex` read the first occurrence
    // and the comment above fixed that for the prefix side only — so when
    // `/metrics` began calling `enforceAuthGate` itself, this line started
    // pointing at the metrics branch instead of the dispatcher and the whole
    // assertion went vacuous: 685 < 700 passed while `/metrics` was no longer
    // answered in front of the gate at all. Same bug the paragraph above
    // describes, one variable over. The exclusion is a claim about the
    // dispatcher, so it is the dispatcher's gate call it must be measured
    // against.
    const gateLine = server.reduce(
      (last, line, i) => (line.includes('enforceAuthGate(req, res, url') ? i : last), -1)
    assert.ok(gateLine > 0, 'the gate call is still in src/server.js')
    for (const prefix of BEFORE_GATE) {
      const at = server.reduce((last, line, i) => (line.includes(`'${prefix}`) ? i : last), -1)
      assert.ok(at >= 0, `${prefix} is still answered somewhere in src/server.js`)
      assert.ok(at < gateLine, `${prefix} must be answered above the auth gate (last mention line ${at + 1} vs gate ${gateLine + 1})`)
    }
  })

  it('does not let a GET reach a write scope by sharing a prefix', () => {
    assert.notEqual(scopeForRoute('GET', '/api/v1/analytics'), 'admin:analytics',
      'a read is never the write scope the same prefix carries for POST')
    assert.equal(scopeForRoute('GET', '/api/v1/analytics'), 'read:analytics',
      'and model governance is not readable by a hazard token')
    assert.equal(scopeForRoute('GET', '/api/v1/routing/plan'), 'read:hazards',
      'while a hazard route is readable by exactly the hazard scope')
  })
})

describe('the operator can see the posture without holding a token', () => {
  it('is covered by the auth-info route too, which needs a token', async () => {
    // `/api/v1/health` used to carry no auth field at all, so the answer to "is
    // this deployment secured?" lived on a route that requires being already
    // secured. `test/auth-deny-by-default.test.js` asserts the health route
    // reports it; this records why that assertion exists.
    assert.ok(SURFACE.includes('/api/v1/health'), 'the health route is still the public one')
    assert.ok(SURFACE.includes('public_paths: publicPaths()'), 'and it now names the public paths')
    assert.ok(SURFACE.includes('configured: isAuthConfigured()'))
  })
})
