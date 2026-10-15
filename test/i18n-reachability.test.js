import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, scanReachability } from '../scripts/check-i18n.mjs'

/**
 * R-72 — rule 4 of `check-i18n.mjs`, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/state-keys-gate.test.js`.
 *
 * The rule asks whether any source file can ask for a key in `en.json`. Its
 * whole value is what it must NOT say: three keys are reached only through a
 * template, and a scanner that read literals alone would report them dead and
 * invite their deletion. The canaries below are mostly about that distinction,
 * and about the boundary — `a.beta` sits inside `a.beta_gamma`, and a substring
 * match would call the first reachable on the strength of the second.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-i18n.mjs')

function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('R-72 the i18n gate reports keys no source can ask for', () => {
  it('passes on the tree as it stands, and says the catalogue is fully reachable', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /Key reachability \(\d+ keys in en\.json\)/)
    assert.match(output, /0 unreferenced/)
    assert.match(output, /every key is reachable from a source file/)
    // A rule that checked zero keys would also print "0 unreferenced".
    const reachable = Number(/(\d+) reachable/.exec(output)?.[1] ?? 0)
    assert.ok(reachable > 400, `the rule resolved only ${reachable} keys, which is not the shipped catalogue`)
  })

  it('honours the three template prefixes, and no others', () => {
    // Pinned by name because a fourth prefix is a policy decision: a prefix that
    // covers a namespace excuses every key under it, so one added carelessly
    // would hide exactly the keys this rule exists to find.
    const { output } = runGate()
    assert.match(
      output,
      /dynamic prefixes honoured: map\.field_, workflow\., playbook\.status\./,
      'the honoured prefix set changed — a new prefix excuses every key under it',
    )
  })

  it('every canary passes, and they disagree with each other', () => {
    const shapes = new Set(CANARIES.map((c) => JSON.stringify(c.expect)))
    assert.ok(
      shapes.size >= 2,
      'the canaries no longer disagree, so a scanner returning a constant would pass them',
    )
    for (const canary of CANARIES) {
      const r = scanReachability(canary.sources, canary.keys)
      assert.deepEqual(
        [...r.dead].sort(),
        [...canary.expect].sort(),
        `canary "${canary.name}" expected dead [${canary.expect}]`,
      )
    }
  })

  it('the self-test is reachable as a CLI, which is how the canaries run', () => {
    const { code, output } = runGate(['--self-test'])
    assert.equal(code, 0, `the self-test fails:\n${output}`)
    assert.match(output, /all canaries passed/)
  })

  it('stays silent on a key reached only through a template — the false positive that would kill it', () => {
    // `workflow.${type}`, `playbook.status.${status}` and `map.field_${reason.field}`
    // are the three real cases. A rule that read literals alone reports 13 live
    // keys as dead and the obvious fix is to delete them.
    const sources = [{ file: path.join('shared', 'runtime.js'), text: '' }, { file: 'a.js', text: 'const k = `workflow.${type}`\n' }]
    assert.deepEqual(scanReachability(sources, ['workflow.school_feeding']).dead, [])
  })

  it('treats a template prefix naming no key as no excuse at all', () => {
    // `token_${n}` in src/auth.js builds a token id. A rule that accepted every
    // template prefix would excuse whatever namespace happened to follow it.
    const sources = [{ file: path.join('shared', 'runtime.js'), text: '' }, { file: 'a.js', text: 'const k = `token_${n}`\n' }]
    assert.deepEqual(scanReachability(sources, ['action.export']).dead, ['action.export'])
  })

  it('does not read a key as reachable from the tail of a longer key', () => {
    // The boundary is load-bearing. `co.feedback_title` contains `feedback.title`
    // as a substring, and a substring match would call the dead one reachable
    // because the live one exists.
    const sources = [{ file: path.join('shared', 'runtime.js'), text: '' }, { file: 'a.js', text: "t('co.feedback_title')\n" }]
    assert.deepEqual(scanReachability(sources, ['feedback.title']).dead, ['feedback.title'])
  })

  it('reports a prefix spanning a quarter of the catalogue rather than trusting it', () => {
    const sources = [{ file: path.join('shared', 'runtime.js'), text: '' }, { file: 'a.js', text: 'const k = `a.${x}`\n' }]
    const r = scanReachability(sources, ['a.one', 'a.two', 'b.three', 'c.four'])
    assert.equal(r.suspicious.length, 1, 'a prefix covering half the catalogue was trusted')
    assert.equal(r.suspicious[0].prefix, 'a.')
  })

  it('declares itself out of jurisdiction on a tree with no sources, rather than failing', () => {
    // Three i18n tests run this gate over a fixture tree: the catalogues plus two
    // markup files, no JavaScript. Every key is unreachable there and reporting
    // all of them would be true and useless.
    const r = scanReachability([{ file: 'public/chw/index.html', text: '<p data-i18n="a.b">x</p>' }], ['a.b'])
    assert.equal(r.inJurisdiction, false)
    assert.deepEqual(r.dead, [])
  })

  it('flags a key planted in the catalogue and absent from every source', () => {
    // The gate's own canary, over the real tree: a planted key must be named and
    // the run must exit non-zero. Reverted from a copy, never `git checkout` —
    // the working tree is shared with other agents.
    const en = path.join(ROOT, 'public', 'i18n', 'en.json')
    const backup = fs.readFileSync(en, 'utf8')
    try {
      const obj = JSON.parse(backup)
      obj['zz.canary_dead_key'] = 'Canary'
      fs.writeFileSync(en, `${JSON.stringify(obj, null, 2)}\n`)
      const { code, output } = runGate()
      assert.equal(code, 1, 'the gate passed with an unreachable key in the catalogue')
      assert.match(output, /zz\.canary_dead_key/, 'the gate failed without naming the planted key')
    } finally {
      fs.writeFileSync(en, backup)
    }
    // And the revert took: the gate is green again, so the canary was not left in.
    assert.equal(runGate().code, 0, 'the tree is still failing after the canary was reverted')
  })
})
