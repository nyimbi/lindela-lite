import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, judge, shape } from '../scripts/check-route-reachability.mjs'
import { servedRoutePaths } from '../scripts/route-surface.mjs'

/**
 * ENH-59 — the reachability gate, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/route-method-gate.test.js`.
 *
 * The gate answers the question the whole item was written for: are the routes
 * the declaration names the routes the matchers actually serve? `/api/v1/districts/{id}`
 * was served, fetched by the console on every page, and in no table — invisible
 * to every check built on the tables, because it was absent from all of them in
 * the same way.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-route-reachability.mjs')

/** Run the gate the way CI does, and return its exit code with its output. */
function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('ENH-59 the reachability gate compares the declaration to the dispatch code', () => {
  it('passes on the tree as it stands', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    // A gate that resolved zero paths and zero declarations would also be
    // "clean". The counts are the only evidence it looked at anything.
    const served = Number(/clean — (\d+) served path/.exec(output)?.[1] ?? 0)
    const parsed = Number(/(\d+) matcher\(s\) parsed/.exec(output)?.[1] ?? 0)
    assert.ok(served > 150, `the gate compared ${served} served paths, which is not the shipped surface`)
    assert.ok(parsed > 20, `the gate parsed ${parsed} matchers, which is not the shipped surface`)
    assert.match(output, /0 unparsed/, 'a matcher the gate could not read is a matcher it cannot compare')
  })

  it('every declared canary passes, and they disagree with each other', () => {
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.deepEqual(
      [...expectations].sort(),
      [0, 1],
      'the canaries no longer include both a pass and a fail case, so they cannot detect a constant checker',
    )
    for (const canary of CANARIES) {
      assert.equal(
        judge(canary.input) ? 1 : 0,
        canary.expect,
        `canary "${canary.name}" expected ${canary.expect}`,
      )
    }
  })

  it('the self-test is reachable as a CLI, which is how the canaries run', () => {
    const { code, output } = runGate(['--self-test'])
    assert.equal(code, 0, `the self-test fails:\n${output}`)
    assert.match(output, /all canaries passed/)
  })

  it('flags a served route nothing declares — the shape ENH-59 was written for', () => {
    // The defect in one line: a matcher serves it, the console fetches it on
    // every page, and no table names it.
    const finding = judge({
      declared: ['/api/v1/health'],
      served: ['/api/v1/health', '/api/v1/districts/{id}'],
    })
    assert.ok(finding, 'a served route absent from the declaration was not flagged')
    assert.deepEqual(finding.onlyServed, ['/api/v1/districts/<param>'])
    assert.deepEqual(finding.onlyDeclared, [])
  })

  it('flags a declared route nothing serves — the documented-404 shape', () => {
    const finding = judge({ declared: ['/api/v1/health', '/api/v1/gone'], served: ['/api/v1/health'] })
    assert.ok(finding, 'a declared route no matcher serves was not flagged')
    assert.deepEqual(finding.onlyDeclared, ['/api/v1/gone'])
  })

  it('reports both directions rather than the first it finds', () => {
    // A gate that returned on the first mismatch would report one finding, get
    // fixed, and report the other on the next run — the loop that teaches people
    // the gate is noise.
    const finding = judge({ declared: ['/api/v1/gone'], served: ['/api/v1/districts/{id}'] })
    assert.deepEqual(finding.onlyDeclared, ['/api/v1/gone'])
    assert.deepEqual(finding.onlyServed, ['/api/v1/districts/<param>'])
  })

  it('normalises parameter names but not literals — the jurisdiction boundary', () => {
    // The one normalisation the comparison needs, and the boundary it must not
    // cross. Dropping parameter names is safe: the spec writes `{z}/{x}/{y}` and
    // the matcher writes `:id/:id/:id` because a regex group cannot say what it
    // means. Dropping literals is not: `/api/v1/a/{id}` and `/api/v1/b/{id}` are
    // different routes, and a normalisation that made them equal would swallow
    // exactly the route that is missing.
    assert.equal(shape('/api/v1/tiles/{z}/{x}/{y}.png'), shape('/api/v1/tiles/:id/:id2/:id3.png'))
    assert.notEqual(shape('/api/v1/a/{id}'), shape('/api/v1/b/{id}'))
    assert.notEqual(shape('/api/v1/reports/{id}'), shape('/api/v1/reports/{id}/approve'))
    assert.notEqual(shape('/api/v1/reports/{id}/export.csv'), shape('/api/v1/reports/{id}/export.json'))
    // And the boundary, exercised through the judge rather than the helper.
    assert.ok(judge({ declared: ['/api/v1/a/{id}'], served: ['/api/v1/b/{id}'] }))
    assert.equal(judge({
      declared: ['/api/v1/tiles/{z}/{x}/{y}.png'],
      served: ['/api/v1/tiles/{id}/{id2}/{id3}.png'],
    }), null)
  })

  it('compares the declaration against the matchers, not against a second table', () => {
    // The gate's whole value is that its right-hand side is derived from the
    // imperative dispatch code by `route-surface.mjs`. If it ever compared the
    // declaration to `docs/openapi.yaml`, it would be drift checking under
    // another name and would miss the exact defect it was written for.
    const { paths, coverage } = servedRoutePaths(ROOT)
    assert.ok(paths.size > 150, 'route-surface resolved too few paths to be the dispatch surface')
    assert.equal(coverage.unparsed.length, 0, 'a matcher route-surface cannot read is one the gate cannot compare')

    // The two sides must be *independent*. A declared path that route-surface
    // never resolved is the finding, so the check is that the gate's own run
    // reported equality between a set read from `src/route-declaration.js` and a
    // set derived from `src/routes/**` — and that the second set is not simply
    // the first one re-shaped. Asserted by size, which is the only way to see
    // that from here: if the declaration were empty and route-surface echoed it,
    // both sides would agree and every assertion above would still pass.
    const { output } = runGate()
    const served = Number(/clean — (\d+) served path/.exec(output)?.[1] ?? 0)
    assert.equal(served, paths.size, 'the gate reported a different served count than route-surface resolves')
  })
})
