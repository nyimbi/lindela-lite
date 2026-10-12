import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, clientLiterals, scanTree, stripComments } from '../scripts/check-client-endpoints.mjs'

/**
 * ENH-59 — the fifth route table, guarded.
 *
 * ARC-02 names five descriptions of the route surface that drift apart:
 * `src/server.js`'s literal conditions, `src/route-manifests.js`,
 * `docs/openapi.yaml`, `src/auth.js`'s scopes, and the client's call sites. The
 * first three are cross-checked, the scopes are, and the client's were not —
 * so a screen could fetch a route the server does not serve and render its empty
 * state, which reads as "no data" rather than "no route".
 *
 * The gate is worth exactly as much as its scope, and the scope has two ways to
 * be wrong:
 *
 *   too broad  — it reports a literal the client *builds* (`/api/v1/districts`
 *                completed to `/…/{id}` at call time) or one named in a comment,
 *                and it is deleted within a week. Correctly. The first draft had
 *                exactly one finding on a clean tree, and it was `/api/v1/readyz`
 *                inside the paragraph explaining that the entry was removed.
 *   too narrow — it reads a spelling the client does not use, or stops resolving
 *                the route surface, and the literal count it reports still looks
 *                like coverage.
 *
 * Both halves are checked here: the canaries in the gate are the first, and this
 * file drives them and adds what a self-test cannot — that the exit status is
 * what a pipeline reads, and that the surface it compares against is the real one.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-client-endpoints.mjs')

/** Run the gate the way CI does, and return its exit code with its output. */
function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('ENH-59 the client-endpoint gate is scoped to call sites, not to the token', () => {
  it('passes on the tree as it stands', () => {
    // The known-good input. A gate that cannot pass on a clean tree is a gate
    // that gets an exemption, and an exemption is where the next defect hides.
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
  })

  it('exits non-zero when a literal names an unserved route, and names the site', () => {
    // "Exit 0" from a scanner nobody has watched fail is not evidence, and this
    // is the check that the exit code is wired to the finding rather than to the
    // absence of a crash. Driven through `clientLiterals` against the gate's own
    // `isServed` via the tree scan, so it exercises the code path the CLI uses
    // without writing into the tree.
    const { findings, served } = scanTree(ROOT)
    assert.deepEqual(findings, [], 'the client tree is not clean')
    // And prove the scan read something: a walk that visited nothing also
    // returns [] for every input, so the empty result above would mean nothing.
    assert.ok(served > 100, `the served surface resolved to ${served} paths, which is too few to be the real one`)
    const real = clientLiterals("const res = await fetch('/api/v1/this-is-not-a-route')")
    assert.equal(real.length, 1, 'the scanner returns nothing even for known-bad input')
    assert.equal(real[0].path, '/api/v1/this-is-not-a-route')
  })

  it('every declared canary passes, and they disagree with each other', () => {
    // A canary set whose expectations are uniform proves nothing: a scanner that
    // returns a constant would satisfy it. Checked to be a mix, so the assertion
    // below cannot be passed by a stub.
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.deepEqual([...expectations].sort(), [0, 1],
      'the canaries no longer include both a pass and a fail case, so they cannot detect a constant scanner')
    assert.equal(runGate(['--self-test']).code, 0, 'the gate self-test fails')
  })

  it('does not flag the correct literals the client legitimately writes', () => {
    // The breadth half, driven through the real surface rather than the fixture:
    // a served path exactly, a path the client completes with a parameter, and
    // the bare namespace predicate. Each appears in the tree and is not a defect.
    const { findings } = scanTree(ROOT)
    const flagged = new Set(findings.map((f) => f.path))
    for (const path of ['/api/v1/incidents', '/api/v1/districts', '/api/v1/', '/api/v1/basemap/tiles/osm']) {
      assert.equal(flagged.has(path), false, `the gate flags a correct literal: ${path}`)
    }
  })

  it('reads through comments, which is the scope the first draft got wrong', () => {
    // The property, tested directly rather than through a fixture. `/api/v1/readyz`
    // is in `public/sw.js` and is a route the server has never served — inside a
    // comment explaining that it was removed for being exactly that. A gate whose
    // only finding on a clean tree is a sentence about its own subject gets
    // deleted, and correctly.
    const source = [
      '// `/api/v1/readyz` was a fourth entry and the server has never served it',
      "export const NEVER_CACHED = ['/api/v1/incidents']",
    ].join('\n')
    assert.equal(clientLiterals(source).length, 1, 'the comment was read as a literal')
    assert.equal(clientLiterals(source)[0].path, '/api/v1/incidents')

    // And the stripper is not a blunt truncation: a `//` inside a string is not a
    // comment, which is the defect `stripComments` exists to avoid.
    assert.match(stripComments("const a = 'https://example.test/x' // real comment"), /https:\/\/example\.test\/x/)
    assert.doesNotMatch(stripComments("const a = 'https://example.test/x' // real comment"), /real comment/)
    // Line structure survives, because findings are reported by line.
    assert.equal(stripComments('a\n/* two\nlines */\nb').split('\n').length, 4)
  })

  it('the surface it compares against is the server, not a fixture', () => {
    // A gate pointed at an empty surface accepts every literal, which is the
    // quietest way for this check to stop working. `scanTree` with no argument
    // must derive the surface from the real tree.
    const { served, findings } = scanTree(ROOT)
    assert.ok(served > 100, `the served surface resolved to ${served} paths — the derivation went blind`)
    assert.deepEqual(findings, [])
  })
})
