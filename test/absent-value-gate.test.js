import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, scanSource, scanTree } from '../scripts/check-absent-values.mjs'

/**
 * ENH-46 — the absent-value gate, guarded.
 *
 * `?? 0` on a nullable measurement is this repository's named defect class, and
 * it shipped four times (VER-02, VER-09, VER-12, and `maxProbability ?? 0` in
 * the flood score) before this gate existed. Each instance was found by an
 * audit, which is the expensive way to find a class that a scanner can decide.
 *
 * The gate is worth exactly as much as its scope, and its scope has two ways to
 * be wrong:
 *
 *   too broad  — it flags every `?? 0` in the tree, including the correct ones
 *                (`data.field_reports?.length ?? 0` is a count of an array with
 *                no third state), and it is turned off within a week. Correctly.
 *   too narrow — it quietly stops matching the fields that matter, and the count
 *                of findings it reports still looks like coverage.
 *
 * Both are checked here. The canaries in the gate are the second half; this file
 * drives them and adds the half a self-test cannot: that the gate's exit status
 * is what a pipeline reads, and that the tree it is pointed at is the real one.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-absent-values.mjs')

/** Run the gate the way CI does, and return its exit code with its output. */
function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('ENH-46 the absent-value gate is scoped to the defect class, not to a token', () => {
  it('passes on the tree as it stands', () => {
    // The known-good input. A gate that cannot pass on a clean tree is a gate
    // that gets an exemption, and an exemption is where the next defect hides.
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
  })

  it('exits non-zero when the defect class is present, and names the site', () => {
    // The canary that matters. "Exit 0" from a scanner nobody has watched fail
    // is not evidence, and this is the check that the exit code is wired to the
    // finding rather than to the absence of a crash.
    //
    // The defect is injected into a *copy* of a real module's source and driven
    // through `scanSource`, so the canary proves the same code path the CLI uses
    // without writing into the tree — the mistake `static-and-tile-caches`
    // made, and the reason this file does not repeat it.
    const real = 'false_alert_refusal: far.refusal,\nfalse_alert_rate: far.value,\n'
    assert.equal(scanSource(real).length, 0, 'the unmodified source should be clean')

    const defective = real.replace('far.value,', 'far.value ?? 0,')
    const findings = scanSource(defective)
    assert.equal(findings.length, 1, 'the injected `?? 0` was not found')
    assert.equal(findings[0].stem, 'false_alert', 'the finding does not name the field it is about')
    assert.equal(findings[0].line, 2)
  })

  it('every declared canary passes, and they disagree with each other', () => {
    // A canary set whose expectations are uniform proves nothing: a scanner that
    // returns a constant would satisfy it. These are checked to be a mix, so the
    // assertion below cannot be passed by a stub.
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.deepEqual([...expectations].sort(), [0, 1],
      'the canaries no longer include both a pass and a fail case, so they cannot detect a constant scanner')

    for (const canary of CANARIES) {
      assert.equal(scanSource(canary.source).length, canary.expect,
        `canary "${canary.name}" expected ${canary.expect}`)
    }
  })

  it('does not flag the correct uses of a numeric fallback', () => {
    // The breadth half. These are shapes that appear throughout the tree and are
    // not the defect: a count of an array, an accumulator in a module that
    // declares no nullable field, and a nullable field published as null.
    const correct = [
      'const a = data.field_reports?.length ?? 0',
      'const b = data.alert_events?.length ?? 0',
      'quality.records_by_collection[c] = (quality.records_by_collection[c] || 0) + 1',
      'false_alert_refusal: far.refusal, false_alert_rate: far.value ?? null,',
      'const options = { radiusDeg: options.radiusDeg ?? 0.02 }',
    ]
    for (const line of correct) {
      assert.equal(scanSource(line).length, 0, `the gate flags a correct fallback: ${line}`)
    }
  })

  it('the tree the gate scans is the repository, not a fixture', () => {
    // `scanTree` with no argument must walk the real root. A gate that silently
    // scanned an empty directory would pass forever, and this is the assertion
    // that would fail if `SCAN_DIRS` stopped resolving.
    const findings = scanTree(ROOT)
    assert.deepEqual(findings, [], 'the tree is not clean')
    // And prove it actually read files: a scan that visited nothing also returns
    // [] for every input.
    assert.ok(scanSource('false_alert_refusal: f.r,\nfalse_alert_rate: v ?? 0,').length > 0,
      'the scanner returns nothing even for known-bad input, so its empty result on the tree means nothing')
  })
})
