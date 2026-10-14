import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The claim gate and the link gate both read the repository root, and both used
 * to do it from a hand-written list.
 *
 * `check-no-flood-probability.mjs` named `README.md` and `CHANGELOG.md` in
 * `SURFACE_FILES`; `check-doc-links.mjs` named them in `ROOTS`. Then
 * `PRODUCT.md` and `DESIGN.md` were written at the root and **neither gate read
 * either file** — while both reported clean. A guard that enumerates its own
 * surface is silent about the file nobody added to it, and the silence is
 * indistinguishable from coverage: the gate exits 0 and the answer to "does the
 * claim guard cover the product record?" is yes, wrongly.
 *
 * Each case runs a **copy of the gate inside a throwaway tree**. The first
 * version of this test planted its canary in the real repository root instead,
 * and `lite.test.js` ran `validate.mjs` over that same root at the same time —
 * so the suite went red on a file that existed for 400ms, in a test that never
 * touched the canary. That is this repository's known shared-file race: green
 * alone, red in the suite. A test that writes into a tracked tree is not
 * testing the gate, it is testing the schedule.
 *
 * Canary this test by re-introducing the enumeration — replace the `readdirSync`
 * walk in either gate with the old literal list and watch the matching case
 * fail.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CANARY = 'zz-gate-surface-canary.md'

/**
 * The forbidden term, assembled at runtime rather than written out.
 *
 * This file lives in `test/`, which the claim gate scans, so spelling the term
 * literally here would make the gate fail on the test written to prove the gate
 * works. That is not hypothetical: the first version did exactly that, and it
 * *masked its own canary* — the gate went non-zero because of this file's own
 * literal, so `result.code !== 0` held whether or not the planted file was ever
 * read. A test that fails for a reason it caused itself cannot detect the defect
 * it exists to detect.
 */
const TERM = ['hazard', 'curve'].join('_')

/**
 * Build a minimal tree, run the gate's own script inside it, tear it down.
 *
 * The gate is copied rather than imported because both scripts run their whole
 * scan on import and throw on a finding — there is no seam to call. Running the
 * copy inside the temp directory also makes `import.meta.url` resolve there, so
 * a gate that derives its root from its own location (as `check-doc-links.mjs`
 * does) reads the throwaway tree too.
 */
function runGateInTempTree(script, canaryContents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lindela-gate-surface-'))
  try {
    mkdirSync(path.join(dir, 'scripts'))
    mkdirSync(path.join(dir, 'docs'))
    copyFileSync(path.join(ROOT, script), path.join(dir, script))
    // The claim gate refuses to run at all without the agreed basis document,
    // which is correct behaviour and must not be worked around.
    writeFileSync(path.join(dir, 'docs', 'flood-probability-model-basis.md'), '# Basis\n')
    writeFileSync(path.join(dir, CANARY), canaryContents)

    try {
      const stdout = execFileSync(process.execPath, [path.join(dir, script)], {
        cwd: dir,
        encoding: 'utf8',
      })
      return { code: 0, output: stdout }
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the gates discover the repository root rather than listing it', () => {
  it('the claim gate scans a root markdown file it was never told about', () => {
    const result = runGateInTempTree('scripts/check-no-flood-probability.mjs',
      `# Canary\n\nThe ${TERM} output is authoritative.\n`)
    assert.notEqual(result.code, 0,
      'the claim gate passed over a forbidden term in a root markdown file — it is enumerating its surface again')
    assert.match(result.output, new RegExp(CANARY),
      `the gate failed, but not on the canary — it never named ${CANARY}`)
  })

  it('the link gate scans a root markdown file it was never told about', () => {
    const result = runGateInTempTree('scripts/check-doc-links.mjs',
      '# Canary\n\nSee [missing](docs/does-not-exist-canary.md).\n')
    assert.notEqual(result.code, 0,
      'the link gate passed over a dangling link in a root markdown file — it is enumerating its surface again')
    assert.match(result.output, new RegExp(CANARY),
      `the gate failed, but not on the canary — it never named ${CANARY}`)
  })

  it('writes nothing into the repository', () => {
    // The canary now lives in a temp tree, so the real one must be untouched.
    // A leaked file here would fail the real gates on every later run and look
    // like a defect in the tree rather than in this test.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    assert.doesNotMatch(status, new RegExp(CANARY), 'the canary file leaked into the repository')
  })
})
