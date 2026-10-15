#!/usr/bin/env node
/**
 * ENH-59. The declaration and the dispatch code must describe the same routes.
 *
 * `check-route-drift.mjs` proves the *tables* still come from the declaration.
 * It cannot prove the declaration is true, because a generator that emits from
 * a wrong declaration is consistent and wrong at once. This is the other half:
 * the paths the matchers actually serve are derived from source by
 * `scripts/route-surface.mjs`, and the declared set must equal it.
 *
 * The direction that matters is the one nobody watches. A route in the
 * declaration and not in the dispatch is a documented endpoint that 404s. A
 * route in the dispatch and not in the declaration is the failure ENH-59 was
 * written for: `/api/v1/districts/{id}` was served, fetched by the console on
 * every page, and in no table at all — invisible to every check built on the
 * tables, because it was absent from all of them in the same way.
 *
 * **The one normalisation, and why it is an explicit table rather than a fuzzy
 * match.** A parameterised path has two spellings: the spec writes `{z}/{x}/{y}`
 * and the matcher writes `:id/:id2/:id3`, because a regex group has no way to
 * say what it means. `PARAM_ALIASES` names the three paths where they differ.
 * Normalising by stripping parameter names instead would make any two routes
 * with the same *shape* compare equal, which is precisely the case a genuinely
 * missing route hides in.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { servedRoutePaths } from './route-surface.mjs'
import { PARAM_ALIASES } from './build-route-declaration.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Spec spelling -> matcher spelling, for the paths where they differ.
 *
 * Read from the bootstrap rather than restated: the alias list has one home, and
 * a new alias cannot be added there while this gate silently keeps the old set.
 */
export const SPEC_TO_MATCHER = new Map(PARAM_ALIASES)

/**
 * A path with its parameter *names* removed but its structure kept.
 *
 * `/api/v1/reports/{id}/export.csv` becomes `/api/v1/reports/<param>/export.csv`.
 * This is the one normalisation the comparison needs, and it is deliberately
 * narrow: literals and segment count must still match exactly, so
 * `/api/v1/a/{id}` and `/api/v1/b/{id}` stay different routes. A normalisation
 * that dropped literals too would make any two routes of the same shape
 * compare equal — which is precisely where a genuinely missing route hides.
 */
export function shape(pathname) {
  return pathname.replace(/\{[^}]+\}/g, '<param>').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '<param>')
}

/** The declared paths, as a set of shapes. */
export function declaredPaths(declaration) {
  return new Set(declaration.map((e) => shape(e.path)))
}

/**
 * The finding for one comparison, or `null` when the two agree.
 *
 * Separated from the scan so the canaries can drive it with text — a canary that
 * walks the real tree to test a rule can fail for a reason the rule does not
 * name.
 */
export function judge({ declared, served }) {
  const declaredShapes = new Set(declared.map(shape))
  const servedShapes = new Set(served.map(shape))
  const onlyDeclared = [...declaredShapes].filter((p) => !servedShapes.has(p)).sort()
  const onlyServed = [...servedShapes].filter((p) => !declaredShapes.has(p)).sort()
  if (onlyDeclared.length === 0 && onlyServed.length === 0) return null
  return { onlyDeclared, onlyServed }
}

export const CANARIES = [
  {
    name: 'passes when the two sets are equal',
    input: { declared: ['/api/v1/a', '/api/v1/b'], served: ['/api/v1/a', '/api/v1/b'] },
    expect: 0,
  },
  {
    name: 'flags a declared route nothing serves — the documented-404 shape',
    input: { declared: ['/api/v1/a', '/api/v1/gone'], served: ['/api/v1/a'] },
    expect: 1,
  },
  {
    name: 'flags a served route nothing declares — the ENH-59 shape',
    input: { declared: ['/api/v1/a'], served: ['/api/v1/a', '/api/v1/districts/{id}'] },
    expect: 1,
  },
  {
    name: 'flags both directions at once rather than the first it finds',
    input: { declared: ['/api/v1/gone'], served: ['/api/v1/districts/{id}'] },
    expect: 1,
  },
  {
    name: 'passes a route whose parameter names differ but whose structure matches',
    input: {
      declared: ['/api/v1/basemap/tiles/osm/{z}/{x}/{y}.png'],
      served: ['/api/v1/basemap/tiles/osm/{id}/{id2}/{id3}.png'],
    },
    expect: 0,
  },
  {
    // The boundary the normalisation must not cross: dropping parameter *names*
    // is safe, dropping literals is not.
    name: 'still flags a route that matches a declared one only in shape',
    input: { declared: ['/api/v1/a/{id}'], served: ['/api/v1/b/{id}'] },
    expect: 1,
  },
  {
    name: 'still flags a route whose literal suffix differs',
    input: { declared: ['/api/v1/reports/{id}/export.csv'], served: ['/api/v1/reports/{id}/export.json'] },
    expect: 1,
  },
  {
    name: 'still flags a route with a different segment count',
    input: { declared: ['/api/v1/reports/{id}'], served: ['/api/v1/reports/{id}/approve'] },
    expect: 1,
  },
]

export function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => c.expect))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const got = judge(canary.input) ? 1 : 0
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())
  const { ROUTE_DECLARATION } = await import('../src/route-declaration.js')
  const { paths, coverage } = servedRoutePaths(ROOT)
  const finding = judge({ declared: [...declaredPaths(ROUTE_DECLARATION)], served: [...paths] })
  if (!finding) {
    console.log(
      `route reachability: clean — ${paths.size} served path(s) match the declaration `
      + `(${coverage.parsed.length} matcher(s) parsed, ${coverage.unparsed.length} unparsed)`,
    )
    process.exit(0)
  }
  console.log(`route reachability: ${finding.onlyDeclared.length + finding.onlyServed.length} finding(s)`)
  for (const p of finding.onlyDeclared) console.log(`\n  [declared-but-unserved] ${p}\n    no matcher serves this path; the declaration promises a route that 404s.`)
  for (const p of finding.onlyServed) console.log(`\n  [served-but-undeclared] ${p}\n    a matcher serves this path and no declaration names it; it is in no table, no document and no scope.`)
  process.exit(1)
}
