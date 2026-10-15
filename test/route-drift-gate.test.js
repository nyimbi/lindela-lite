import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, OUTPUTS, judge } from '../scripts/check-route-drift.mjs'

/**
 * ENH-59 — the drift gate, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/route-method-gate.test.js`.
 *
 * Drift is the cheap half of ENH-59 and the half that stops it recurring: two
 * tables are now outputs, and an output that no longer tracks its input is the
 * failure the item exists to remove.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-route-drift.mjs')

function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('ENH-59 the drift gate holds every generated file to its generator', () => {
  it('passes on the tree as it stands', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    const n = Number(/clean — (\d+) generated file/.exec(output)?.[1] ?? 0)
    assert.ok(n >= 2, `the gate checked ${n} generated files, which is not the generated set`)
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

  it('names the line that moved, because the line is the whole report', () => {
    // A judge that always said line 1 would satisfy every count-only canary.
    const finding = judge({ committed: 'a\nb\nc\n', generated: 'a\nb\nC\n', file: 'x' })
    assert.equal(finding.line, 3)
    assert.equal(finding.committed, 'c')
    assert.equal(finding.generated, 'C')
  })

  it('holds exactly the generated outputs, and the scope tables are not among them', () => {
    // The jurisdiction, asserted so it cannot drift silently. A scope is
    // *policy* — which caller may reach a route — and the declaration says only
    // that the route exists. Generating the scope tables would move a security
    // decision into a projection of the path, which is the wrong direction for
    // the one table where a mistake opens a route rather than closing one. They
    // stay hand-kept; `test/route-declaration.test.js` proves the agreement.
    const files = OUTPUTS.map((o) => o.file).sort()
    assert.deepEqual(files, ['docs/openapi.yaml', 'src/route-manifests.js'])
    assert.ok(
      !files.some((f) => f.includes('auth')),
      'a scope table became a generated output without this test being told why',
    )
  })

  it('every generated file exists, and the declaration is not one of them', () => {
    // The declaration is the input. A gate that also regenerated it would make
    // the bootstrap the source of truth, which is backwards: the bootstrap reads
    // the hand-kept tables, and after it runs the declaration is edited by hand.
    for (const out of OUTPUTS) {
      assert.ok(readFileSync(path.join(ROOT, out.file), 'utf8').length > 0, `${out.file} is empty`)
      assert.ok(!out.file.includes('route-declaration'), `${out.file} is the input, not an output`)
    }
    assert.ok(readFileSync(path.join(ROOT, 'src/route-declaration.js'), 'utf8').includes('ROUTE_DECLARATION'))
  })

  it('the two gates cover different questions, and neither stands alone', () => {
    // Drift proves the tables came from the declaration. It cannot prove the
    // declaration is true, because a generator that emits from a wrong
    // declaration is consistent and wrong at once. Reachability is what closes
    // that, and the pair is the point — so a tree missing either one is not
    // covered by the other.
    const drift = readFileSync(path.join(ROOT, 'scripts/check-route-drift.mjs'), 'utf8')
    assert.match(drift, /check-route-reachability\.mjs/, 'the drift gate no longer names its other half')
  })
})
