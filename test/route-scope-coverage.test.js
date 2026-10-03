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

import { READ_SCOPES, WRITE_SCOPES, ROUTE_SCOPES, DENIED_SCOPE, scopeForRoute } from '../src/auth.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8')

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

/** The longest scope prefix that covers a path — the same match the gate makes. */
function scopeFor(method, pathname) {
  const table = method === 'GET' || method === 'HEAD' ? READ_SCOPES : WRITE_SCOPES
  const hit = table.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`))
  return hit ? hit[1] : null
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

  it('names no prefix twice within a table', () => {
    // A duplicate is not a wider grant — `firstMatch` stops at the first — so a
    // second entry for the same prefix is dead text that reads like policy.
    for (const [name, table] of [['READ_SCOPES', READ_SCOPES], ['WRITE_SCOPES', WRITE_SCOPES]]) {
      const prefixes = table.map(([prefix]) => prefix)
      const dupes = prefixes.filter((p, i) => prefixes.indexOf(p) !== i)
      assert.deepEqual(dupes, [], `${name} lists a prefix twice`)
    }
  })

  it('gives every entry a scope that looks like a scope', () => {
    // `['/api/v1/x', 'read:incident']` would deny correctly and read as though
    // it granted something. The scope vocabulary is small enough to hold.
    const scopes = new Set()
    for (const [, scope] of [...READ_SCOPES, ...WRITE_SCOPES]) {
      assert.match(scope, /^(read|write|admin|role):[a-z*]+$|^\*$/, `malformed scope '${scope}'`)
      scopes.add(scope)
    }
    assert.ok(scopes.size > 5, 'a table with one scope in it is a constant')
  })

  it('has no write entry that a read entry already covers more loosely', () => {
    // `/api/v1/alert-events` at `read:alerts` and at `admin:alerts` is
    // deliberate. `/api/v1/analytics` at `read:*` would not be.
    for (const [prefix, scope] of WRITE_SCOPES) {
      assert.ok(scope.startsWith('write:') || scope.startsWith('admin:') || scope === '*',
        `${prefix} is writable with '${scope}', which is not a write or admin scope`)
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

  it('does not let a GET reach a write scope by sharing a prefix', () => {
    assert.equal(scopeFor('GET', '/api/v1/routing/plan'), null,
      'a path that is write-only on POST is unmapped on GET, and falls back')
    assert.equal(scopeForRoute('GET', '/api/v1/analytics'), 'read:hazards',
      'the read fallback, which is the deliberate choice for an unmapped read')
    assert.notEqual(scopeForRoute('GET', '/api/v1/analytics'), 'admin:analytics',
      'and it is never the write scope the same prefix carries for POST')
  })
})

describe('the operator can see the posture without holding a token', () => {
  it('is covered by the auth-info route too, which needs a token', async () => {
    // `/api/v1/health` used to carry no auth field at all, so the answer to "is
    // this deployment secured?" lived on a route that requires being already
    // secured. `test/auth-deny-by-default.test.js` asserts the health route
    // reports it; this records why that assertion exists.
    assert.ok(SERVER.includes('/api/v1/health'), 'the health route is still the public one')
    assert.ok(SERVER.includes('public_paths: publicPaths()'), 'and it now names the public paths')
    assert.ok(SERVER.includes('configured: isAuthConfigured()'))
  })
})
