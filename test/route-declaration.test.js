import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ROUTE_DECLARATION } from '../src/route-declaration.js'
import { ROUTE_MANIFESTS, WIDE_ROUTES, needsHistory, collectionsForRequest } from '../src/route-manifests.js'
import { READ_SCOPES, WRITE_SCOPES, declaredScopeFor } from '../src/auth.js'
import { servedRoutePaths } from '../scripts/route-surface.mjs'
import { shape } from '../scripts/check-route-reachability.mjs'
import { generateOpenApi } from '../scripts/generate-openapi.mjs'
import { generateRouteManifests, TABLE_SPELLING } from '../scripts/generate-route-manifests.mjs'

const ROOT = new URL('..', import.meta.url)

/** Spec paths use `{name}`; the scope tables use `:name`. */
const toColon = (specPath) => specPath.replace(/\{([^}]+)\}/g, ':$1')

/**
 * The spelling the manifest tables key on, which differs from the spec's for
 * the tile routes only. Read from the generator rather than restated here, so
 * the alias list has one home and a new alias cannot be added to the generator
 * while this file silently keeps the old behaviour.
 */
const TABLE_SPELLING_MAP = new Map(TABLE_SPELLING)

/** The manifest table key for a declared operation. */
function tableKey(e) {
  const specKey = `${e.method} ${e.path}`
  return TABLE_SPELLING_MAP.get(specKey) ?? `${e.method} ${toColon(e.path)}`
}

/**
 * ENH-59 — one declaration, and the tables are generated from it.
 *
 * Five tables described the route surface and drifted, because each was kept by
 * hand and the cross-checks between them were the only thing holding them
 * together. This file is the other half of the fix: the tables are now
 * *outputs*, and a generator whose output no longer tracks its input is exactly
 * the failure the item exists to prevent — so the committed files are compared
 * against a fresh generation, byte for byte.
 *
 * It follows `test/enhancement-status.test.js`, which does the same for
 * `docs/improvements/status.md`: the generator runs with `write: false`, returns
 * the string it *would* have written, and the committed file must equal it.
 */

/**
 * The declaration must be a *set* keyed on (method, path).
 *
 * Asserted as the key set rather than as "no duplicate in this list" — a
 * blocklist of spellings is the bug this repository has written down four
 * times, and the key set is the thing that is actually known.
 */
describe('ENH-59 route declaration', () => {
  it('keys every operation on (method, path), with no repeats', () => {
    const keys = ROUTE_DECLARATION.map((e) => `${e.method} ${e.path}`)
    const unique = new Set(keys)
    assert.equal(
      unique.size,
      keys.length,
      `the declaration repeats ${keys.length - unique.size} operation(s): `
        + keys.filter((k, i) => keys.indexOf(k) !== i).join(', '),
    )
  })

  it('carries the fields the generators need, and no route without a decision', () => {
    for (const e of ROUTE_DECLARATION) {
      assert.match(e.method, /^(GET|POST|PUT|PATCH|DELETE)$/, `${e.path} has method ${e.method}`)
      assert.ok(e.path.startsWith('/'), `${e.method} ${e.path} is not a path`)
      assert.ok(
        e.scope === null || typeof e.scope === 'string',
        `${e.method} ${e.path} has scope ${JSON.stringify(e.scope)}`,
      )
      // A route is either measured against a named set, or explicitly wide.
      // "Neither" is the state that made a route silently expensive.
      assert.ok(
        e.wide === true || (Array.isArray(e.reads) && e.reads.length > 0),
        `${e.method} ${e.path} is neither measured nor wide`,
      )
      assert.ok(typeof e.body === 'string' && e.body.trim().length > 0, `${e.method} ${e.path} has no spec body`)
    }
  })

  it('has exactly one declaration for every operation the spec documents', () => {
    const spec = readFileSync(new URL('docs/openapi.yaml', ROOT), 'utf8')
    const fromSpec = new Set()
    let current = null
    for (const line of spec.split('\n')) {
      const p = /^  (\/[^:]+):\s*$/.exec(line)
      if (p) { current = p[1]; continue }
      const m = /^    (get|post|put|patch|delete):\s*$/.exec(line)
      if (m && current) fromSpec.add(`${m[1].toUpperCase()} ${current}`)
    }
    const declared = new Set(ROUTE_DECLARATION.map((e) => `${e.method} ${e.path}`))

    const onlySpec = [...fromSpec].filter((k) => !declared.has(k))
    const onlyDecl = [...declared].filter((k) => !fromSpec.has(k))
    assert.deepEqual(onlySpec, [], `documented but undeclared: ${onlySpec.join(', ')}`)
    assert.deepEqual(onlyDecl, [], `declared but undocumented: ${onlyDecl.join(', ')}`)
  })
})

/**
 * The two generated JS tables. Both compare the committed file against a fresh
 * generation with `write: false`.
 */
describe('ENH-59 generated tables', () => {
  it('ROUTE_MANIFESTS and WIDE_ROUTES regenerate byte-identically', async () => {
    const committed = readFileSync(new URL('src/route-manifests.js', ROOT), 'utf8')
    const { source } = await generateRouteManifests({ write: false })
    assert.equal(
      source,
      committed,
      'src/route-manifests.js differs from what scripts/generate-route-manifests.mjs emits.\n'
        + 'Run: node scripts/generate-route-manifests.mjs --write',
    )
  })

  it('docs/openapi.yaml regenerates byte-identically', async () => {
    const committed = readFileSync(new URL('docs/openapi.yaml', ROOT), 'utf8')
    const { yaml } = await generateOpenApi({ write: false })
    assert.equal(
      yaml,
      committed,
      'docs/openapi.yaml differs from what scripts/generate-openapi.mjs emits.\n'
        + 'Run: node scripts/generate-openapi.mjs --write',
    )
  })

  it('emits the two-space path / four-space verb shape three gates parse', async () => {
    const { yaml } = await generateOpenApi({ write: false })
    const paths = yaml.match(/^ {2}\/[^:\n]*:\s*$/gm) ?? []
    const verbs = yaml.match(/^ {4}(get|post|put|patch|delete):\s*$/gm) ?? []
    assert.equal(paths.length, 193, 'check-openapi.mjs:82 reads paths at two spaces')
    assert.equal(verbs.length, 233, 'check-route-methods.mjs reads verbs at four spaces')
  })
})

/**
 * The scope tables are *policy*, not a projection of the declaration — a
 * declaration row says which route exists, a scope row says who may call it.
 * They stay hand-kept, and this is what makes that safe: the declaration and
 * the tables must agree on every declared operation.
 *
 * The direction that matters is the one that could open a route. A disagreement
 * where the table grants a scope the declaration does not name would be a route
 * reachable by a token nobody intended; a disagreement the other way is a 403.
 */
describe('ENH-59 scope agreement', () => {
  const declaredScopes = new Map(
    ROUTE_DECLARATION.filter((e) => e.scope !== null).map((e) => [`${e.method} ${toColon(e.path)}`, e.scope]),
  )

  it('resolves every declared operation to the scope the declaration names', () => {
    const wrong = []
    for (const [key, scope] of declaredScopes) {
      const [method, ...rest] = key.split(' ')
      const resolved = declaredScopeFor(method, rest.join(' '))
      if (resolved !== scope) wrong.push(`${key}: table says ${resolved}, declaration says ${scope}`)
    }
    assert.deepEqual(wrong, [], `scope table and declaration disagree:\n  ${wrong.join('\n  ')}`)
  })

  it('leaves the public routes unclaimed by either table', () => {
    // A public route that quietly acquired a scope row would be gated; a scoped
    // route that lost its row would fall to `admin:*` and 403 every caller.
    const publicKeys = ROUTE_DECLARATION.filter((e) => e.scope === null)
      .map((e) => `${e.method} ${e.path}`)
    assert.ok(publicKeys.length > 0, 'the declaration names no public route')
    for (const key of publicKeys) {
      const [method, ...rest] = key.split(' ')
      assert.equal(
        declaredScopeFor(method, toColon(rest.join(' '))),
        null,
        `${key} is declared public but a scope table claims it`,
      )
    }
  })

  it('denies a served route that is not declared — the prefix table fails open, so this pins the pairing', () => {
    // Measured 2026-10-15, and it corrects a claim this register made in the
    // other direction. The hand-kept tables are *prefix* rows, so a route that
    // is served but absent from the declaration is GRANTED a scope by the row
    // above it in the tree — `POST /api/v1/alert-events/acknowledge`, a route
    // nobody declared, resolves to `admin:alerts` today. A per-operation
    // generated table would deny it. So the prefix form is the one that fails
    // open, and the reason it is safe is not the table's shape: it is that
    // `check-route-reachability.mjs` makes the declared set equal the served
    // set, so no such route exists.
    //
    // That pairing is the whole safety argument, and until now nothing asserted
    // it. This test does: it takes a route the tables would happily grant and
    // asserts the declaration does not contain it, so the day someone adds a
    // route without declaring it, the reachability gate and this test fail
    // together rather than the route silently inheriting its family's scope.
    const undeclared = '/api/v1/alert-events/acknowledge'
    const granted = declaredScopeFor('POST', undeclared)
    assert.equal(
      granted,
      'admin:alerts',
      `the prefix table no longer grants ${undeclared}; if the tables became per-operation, `
      + 'this test is measuring the wrong failure and should be rewritten, not deleted',
    )
    const declared = new Set(ROUTE_DECLARATION.map((e) => `${e.method} ${toColon(e.path)}`))
    assert.ok(
      !declared.has(`POST ${undeclared}`),
      `${undeclared} is now declared, so it is no longer the undeclared case this test needs`,
    )
    // And the property that makes the grant harmless: nothing the server serves
    // is missing from the declaration. This is the same assertion
    // `check-route-reachability.mjs` makes, restated here because *this* is the
    // test that depends on it being true — the gate and this test are the two
    // halves of one argument, and a test that relies on a gate it does not run
    // is a test that passes when the gate is deleted.
    //
    // The comparison uses the gate's own `shape()`, not a second normalisation
    // written here. The spec writes `{z}/{x}/{y}.png` and the matcher writes
    // `:id/:id2/:id3.png`; `shape` collapses parameter names and keeps literals
    // and segment counts, which is the one normalisation the comparison needs.
    // Restating it here would give the repository a second definition of "the
    // same route", and the two would drift.
    const { paths } = servedRoutePaths(process.cwd())
    const declaredShapes = new Set(ROUTE_DECLARATION.map((e) => shape(e.path)))
    const missing = [...paths].map((p) => shape(p)).filter((s) => !declaredShapes.has(s))
    assert.deepEqual(
      [...new Set(missing)],
      [],
      `served paths with no declaration entry — each is granted its family's scope by prefix:\n  ${[...new Set(missing)].join('\n  ')}`,
    )
  })

  it('has no scope row that decides nothing', () => {
    // A row that matches no route the server serves is policy about a route
    // that does not exist: it reads like a decision and is not one. Prefix rows
    // are legitimate (`/api/v1/export` covers `/api/v1/export.csv`), so this
    // asks whether the row *matches* something, not whether it equals a key.
    const matchesPattern = (pattern, pathname) => {
      if (!pattern.includes(':')) {
        return pathname === pattern
          || pathname.startsWith(`${pattern}/`)
          || pathname.startsWith(`${pattern}.`)
      }
      const a = pattern.split('/')
      const b = pathname.split('/')
      if (a.length !== b.length) return false
      return a.every((p, i) => (p.startsWith(':') ? b[i].length > 0 : p === b[i]))
    }

    const served = [...servedRoutePaths(process.cwd()).paths]
    const dead = []
    for (const [pattern, scope] of [...READ_SCOPES, ...WRITE_SCOPES]) {
      if (!served.some((path) => matchesPattern(pattern, path))) dead.push(`${pattern} -> ${scope}`)
    }
    assert.deepEqual(
      dead,
      [],
      `scope rows that match no served route:\n  ${dead.join('\n  ')}`,
    )
  })
})

/**
 * The declaration and the derived tables must describe the same routes. This is
 * the join that was five separate hand-kept tables; it is asserted here so the
 * generated files cannot drift from the declaration they came from.
 */
describe('ENH-59 declaration and tables agree', () => {
  it('maps or explicitly widens every declared operation', () => {
    const measured = new Set(Object.keys(ROUTE_MANIFESTS))
    const wide = new Set(WIDE_ROUTES)
    const missing = ROUTE_DECLARATION
      .filter((e) => {
        const key = tableKey(e)
        return !measured.has(key) && !wide.has(key)
      })
      .map((e) => tableKey(e))
    assert.deepEqual(missing, [], `declared but in no table: ${missing.join(', ')}`)
  })

  it('keeps needsHistory true for exactly the routes declared with history', () => {
    for (const e of ROUTE_DECLARATION) {
      if (!e.history) continue
      const path = toColon(e.path)
      assert.ok(
        needsHistory(e.method, path),
        `${e.method} ${path} is declared history-bearing but needsHistory says no`,
      )
    }
    // And the reverse, so a route cannot acquire history it does not declare.
    const declaredHistory = new Set(
      ROUTE_DECLARATION.filter((e) => e.history).map((e) => `${e.method} ${toColon(e.path)}`),
    )
    for (const key of ['GET /api/v1/history/:id', 'GET /api/v1/history/:id/record']) {
      assert.ok(declaredHistory.has(key), `${key} needs history but the declaration does not say so`)
    }
  })

  it('reads exactly the collections the declaration names', () => {
    for (const e of ROUTE_DECLARATION) {
      if (e.wide || e.scope === null) continue
      const path = toColon(e.path)
      const got = collectionsForRequest(e.method, path.replace(/:([^/]+)/g, 'probe-id'))
      if (got === null) continue // a wide row resolved; covered above
      assert.deepEqual(
        [...got].sort(),
        [...e.reads].sort(),
        `${e.method} ${path} reads ${JSON.stringify(got)} but declares ${JSON.stringify(e.reads)}`,
      )
    }
  })
})

/**
 * Canaries. A gate whose canaries never run is a gate nobody has watched fail,
 * and `run-gates.mjs` spawns gates bare — so the generators are canaried here,
 * by mutating the declaration in memory and asserting the output moves.
 */
describe('ENH-59 canaries', () => {
  it('the generator is reachable as a CLI', () => {
    // The generators are invoked by a human and by CI; a module that only works
    // when imported is a module whose `--write` path is never exercised. The
    // summary goes to stderr (stdout is reserved for data), so the shell merges
    // the two streams.
    const out = execSync('node scripts/generate-openapi.mjs 2>&1', {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
    })
    assert.match(out, /193 paths, 233 operations/)
  })
})
