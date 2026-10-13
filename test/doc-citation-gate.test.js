import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, isScannedFile, scanText, scanTree } from '../scripts/check-doc-citations.mjs'

/**
 * The doc-citation gate, driven.
 *
 * The gate carried canaries from the day it was written and **nothing ran
 * them** — `run-gates.mjs` spawns every gate bare, no test imported the module,
 * and `--self-test` was reachable only by hand. A canary nobody runs is the same
 * shape as a gate nobody runs, one level in: the instrument that would tell you
 * the instrument works was itself unplugged.
 *
 * What this file adds over the self-test is what a self-test cannot check — that
 * the exit status is wired to the finding (not to the absence of a crash), that
 * the walk reads the files it claims to, and that the canary expectations
 * disagree with each other, so a scanner returning a constant cannot satisfy
 * them.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-doc-citations.mjs')

/** Run the gate the way CI does, and return its exit code with its output. */
function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('the doc-citation gate is scoped to citations that name nothing', () => {
  it('passes on the tree as it stands', () => {
    // A gate that cannot pass on a clean tree gets an exemption, and an
    // exemption is where the next defect hides.
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
  })

  it('exits non-zero when a live register file carries a past-EOF citation', () => {
    // The exit code is what a pipeline reads, and this is the check that it is
    // wired to the finding. Driven against a real file rather than a fixture:
    // the walk's scope is half the gate, and a fixture exercises `scanText`
    // while leaving the walk untested.
    const target = path.join(ROOT, 'docs/improvements/_status-c.json')
    const original = fs.readFileSync(target, 'utf8')
    const before = '`src/routes/provenance.js:54`'
    assert.ok(original.includes(before), 'canary target not found — the patch would be a no-op')
    try {
      fs.writeFileSync(target, original.replace(before, '`src/routes/provenance.js:99999`'))
      const { code, output } = runGate()
      assert.notEqual(code, 0, 'the gate passed with a planted past-EOF citation in a live register file')
      assert.match(output, /_status-c\.json/, 'the finding does not name the file it read')
    } finally {
      // Revert from the captured bytes, never `git checkout -- <file>`, which
      // would take any uncommitted work in the file with it.
      fs.writeFileSync(target, original)
    }
  })

  it('every declared canary passes, and they disagree with each other', () => {
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.deepEqual([...expectations].sort(), [0, 1],
      'the canaries no longer include both a pass and a fail case, so they cannot detect a constant scanner')
    assert.equal(runGate(['--self-test']).code, 0, 'the gate self-test fails')
  })

  it('reads .md and _status-*.json, and nothing else', () => {
    // The scope half. `_status-*.json` was outside the walk until 2026-10-13,
    // and it is where a shipped item's `detail` lives — prose the builder
    // renders nowhere, so this gate is its only reader.
    for (const name of ['a.md', '_status-a.json', '_status-de.json']) {
      assert.equal(isScannedFile(name), true, `${name} should be read`)
    }
    for (const name of ['a.json', 'package.json', 'status.json', 'notes.txt', '_status-a.js']) {
      assert.equal(isScannedFile(name), false, `${name} should not be read`)
    }
  })

  it('a snapshot declaration cannot exempt a JSON file, which has no head to read', () => {
    // The escape hatch is read from a document's first 40 lines. A JSON file has
    // no head, so a `citations-are-historical:` string sitting in its data must
    // not switch the gate off — reachable by accident otherwise.
    const json = '{"note":"citations-are-historical: 2026-10-03","detail":"see `src/server.js:999999`"}'
    assert.equal(scanText(json, { doc: '_status-x.json', allowSnapshot: false }).length, 1)
    // And the same text as a document header still works, so the refusal is
    // scoped to JSON rather than having disabled the hatch.
    const md = '# Audit\ncitations-are-historical: 2026-10-03\n\nsee `src/server.js:999999`.'
    assert.equal(scanText(md).length, 0)
  })

  it('the tree scan resolves the registers it claims to, not an empty set', () => {
    // A walk that visits nothing returns [] for every input, which is the
    // quietest way for this check to stop working. Prove it read the files.
    const docs = new Set(scanTree(ROOT).map((f) => f.doc))
    assert.deepEqual([...docs], [], 'the register is not clean')
    const status = path.join(ROOT, 'docs/improvements/_status-c.json')
    assert.ok(fs.existsSync(status), 'the status file the walk should read is missing')
    assert.ok(fs.readFileSync(status, 'utf8').includes('src/routes/provenance.js:54'),
      'the status file no longer carries the citation the walk is scoped to read')
  })
})
