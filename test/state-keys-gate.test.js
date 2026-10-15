import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, scanSource, scanTree } from '../scripts/check-state-keys.mjs'

/**
 * R-68 — the state-key gate, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/route-reachability-gate.test.js`.
 *
 * The gate's whole value is that it resolves `state` *lexically* instead of by
 * regex. `public/app.js` has two functions that take their own `state`
 * parameter, and a regex scanner reports nine of their references as undeclared
 * keys. So the tests below are mostly about what the gate must NOT say: the
 * discrimination is the instrument, and a gate that fires on a shadowed local is
 * a gate that gets switched off within a week.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-state-keys.mjs')

function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('R-68 the state-key gate compares each surface to its own state literal', () => {
  it('passes on the tree as it stands', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    // A gate that checked zero surfaces would also be "clean".
    const checked = Number(/clean — (\d+) surface/.exec(output)?.[1] ?? 0)
    assert.ok(checked >= 5, `the gate checked ${checked} surfaces, which is not the shipped set`)
    assert.match(output, /0 out of jurisdiction/, 'a surface left the gate without the gate saying so')
  })

  it('every declared canary passes, and they disagree with each other', () => {
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.ok(
      expectations.size >= 2,
      'the canaries no longer disagree, so a scanner returning a constant would pass them',
    )
    for (const canary of CANARIES) {
      assert.equal(
        scanSource(canary.source).undeclared.length,
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

  it('stays silent on a function that takes its own `state` — the false positive that would kill it', () => {
    // This is the exact shape in public/app.js and the reason the gate parses
    // rather than greps. Nine references belong to these two functions.
    const source = 'const state = { real: 1 }\n'
      + 'function seasonalSummary(state) { return state.anomalyC + state.phase + state.indexUsed }\n'
    assert.deepEqual(scanSource(source).undeclared, [])
  })

  it('stays silent on a function that declares its own `state` — the harder half of the same case', () => {
    // `const state = readSeasonalState(observations)` has no brace on its line,
    // so a shadow span read as "up to the next `{`" ends at the following `if`
    // block and leaves the rest of the function attributed to the console's
    // state. That produced four false positives on the gate's first real run.
    const source = 'const state = { real: 1 }\n'
      + 'function strip(obs) {\n'
      + '  const state = read(obs)\n'
      + '  if (state) { return state.anomalyC + state.thresholdC }\n'
      + '  return state.overlappingSeasons\n'
      + '}\n'
    assert.deepEqual(scanSource(source).undeclared, [])
  })

  it('flags an undeclared key on the module-level object', () => {
    const finding = scanSource('const state = { a: 1 }\nfunction f() { return state.b }\n')
    assert.equal(finding.undeclared.length, 1)
    assert.equal(finding.undeclared[0].key, 'b')
  })

  it('reads the key set off the literal, not off a blocklist', () => {
    // A blocklist assertion enumerates the spellings its author thought of. The
    // literal's key set is the thing that is actually known, so a key added to
    // the literal must be accepted without the gate being told about it.
    const source = 'const state = { addedLater: 1 }\nfunction f() { return state.addedLater }\n'
    assert.deepEqual(scanSource(source).undeclared, [])
  })

  it('reports the surfaces it could not check rather than passing them silently', () => {
    // `public/shared/intent-console.js` builds its state inside a function. The
    // gate must not claim to have checked it, because silence there is
    // indistinguishable from coverage.
    const { skipped } = scanTree(ROOT)
    const declared = new Set(readFileSync(GATE, 'utf8').match(/'(public\/[^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [])
    for (const s of skipped) {
      assert.ok(declared.has(s.file), `${s.file} was skipped without being in SURFACES`)
    }
    assert.ok(skipped.length === 0, `a listed surface is out of jurisdiction: ${JSON.stringify(skipped)}`)
  })

  it('does not count a nested object key as a state key', () => {
    // `filters: { coldChain: false }` declares `filters`. `coldChain` belongs to
    // the nested object, and treating it as a state key would make every read of
    // `state.filters.coldChain` a finding.
    const source = 'const state = { filters: { coldChain: false } }\nfunction f() { return state.filters.coldChain }\n'
    assert.deepEqual(scanSource(source).undeclared, [])
  })
})
