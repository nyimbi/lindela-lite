import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, duplicateKeys, judge } from '../scripts/check-yaml-duplicate-keys.mjs'

/**
 * ENH-59's residue — the duplicate-key gate, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/route-drift-gate.test.js`.
 *
 * ENH-59 fixed one duplicate `description:` in `docs/openapi.yaml` and left the
 * class open: the general check was a different unit. It matters because the
 * class is reachable through the generator's own input — a route's spec body is
 * a `body:` template literal in `src/route-declaration.js`, which
 * `test/duplicate-object-keys.test.js` blanks by design because it scans JS
 * object literals, not the YAML inside a string.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-yaml-duplicate-keys.mjs')

function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('the YAML duplicate-key gate holds every shipped YAML file', () => {
  it('passes on the tree as it stands', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    const n = Number(/clean — (\d+) file/.exec(output)?.[1] ?? 0)
    assert.ok(n >= 4, `the gate scanned ${n} YAML files, which is not the shipped set`)
  })

  it('every declared canary passes, and they disagree with each other', () => {
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.deepEqual(
      [...expectations].sort(),
      [0, 1],
      'the canaries no longer include both a pass and a fail case, so they cannot detect a constant checker',
    )
    for (const canary of CANARIES) {
      const { duplicates, refused } = judge(canary.input)
      assert.equal(
        refused ? 1 : duplicates.length > 0 ? 1 : 0,
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

  it('names both lines, because the pair is the whole report', () => {
    // A reader that reported only "a duplicate exists" would send the maintainer
    // to grep the file for a key that appears a hundred times. The first line is
    // the one YAML discards, and it is the finding.
    const found = duplicateKeys('a:\n  b: 1\n  b: 2\n')
    assert.equal(found.length, 1)
    assert.equal(found[0].key, 'b')
    assert.equal(found[0].line, 3)
    assert.equal(found[0].first, 2)
  })

  it('refuses a construct it cannot model rather than reading it wrongly', () => {
    // A reader that skipped what it could not parse would report a
    // duplicate-free file it never finished reading — the failure this gate
    // exists to remove, wearing the gate's own clothes. A merge key changes what
    // "the same mapping" means, so it must stop the read.
    const { refused } = judge('a:\n  <<: *base\n  b: 1\n')
    assert.ok(refused, 'a merge key was read rather than refused')
    assert.match(refused, /merge key/)
  })

  it('a block scalar body is text, so a key inside one is not a duplicate', () => {
    // This is the case that made the gate's own subject reachable: a `body:`
    // literal in the declaration is raw YAML, and a `summary:` inside it is
    // prose. The reader must skip the body or it reports every route's own
    // narrative as a duplicate of its own summary.
    assert.deepEqual(duplicateKeys('a:\n  d: |\n    summary: one\n    summary: two\n'), [])
    // And the key after the body ends is a key again.
    assert.equal(duplicateKeys('a:\n  d: |\n    text\n  s: one\n  s: two\n').length, 1)
  })
})
