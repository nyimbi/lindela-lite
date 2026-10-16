import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CANARIES,
  SURFACE_EXEMPT_EXPORTS,
  deadExportFindings,
  parseModule,
  resolveSpecifier,
  usedInOwnBody,
} from '../scripts/check-dead-exports.mjs'

/**
 * QUA-09 — the dead-export gate, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/state-keys-gate.test.js`.
 *
 * The gate's value is the *instrument*, not the finding list. It reads import
 * statements rather than textual mentions, and every one of its five real bugs
 * was a way of reading prose as code or code as prose: a name in a docstring
 * counted as a call, a spread call excluded by a lookbehind meant to skip member
 * access, `//` inside a regex literal read as a line comment, a `${…}` template
 * hole blanked as prose, and 53 test files' `const { X } = await import(…)`
 * never parsed at all. So most of what follows is about what the gate must NOT
 * say — a false finding is a live export someone deletes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-dead-exports.mjs')

function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('QUA-09 the dead-export gate reads imports, not mentions', () => {
  it('passes on the tree as it stands', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    // A gate that scanned zero exports would also be "clean".
    const checked = Number(/clean — (\d+) export/.exec(output)?.[1] ?? 0)
    assert.ok(checked > 1000, `the gate checked ${checked} exports, which is not the shipped set`)
  })

  it('every declared canary passes, and they disagree with each other', () => {
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.ok(
      expectations.size >= 2,
      'the canaries no longer disagree, so a scanner returning a constant would pass them',
    )
    for (const canary of CANARIES) {
      const { findings, overExported } = deadExportFindings(canary.input)
      assert.equal(findings.length, canary.expect, `canary "${canary.name}" expected ${canary.expect}`)
      assert.equal(
        overExported.length,
        canary.expectOverExported ?? 0,
        `canary "${canary.name}" expected ${canary.expectOverExported ?? 0} over-exported`,
      )
    }
  })

  it('the self-test is reachable as a CLI, which is how the canaries run', () => {
    const { code, output } = runGate(['--self-test'])
    assert.equal(code, 0, `the self-test fails:\n${output}`)
    assert.match(output, /all canaries passed/)
  })

  it('the exemptions are load-bearing, not a place to hide', () => {
    // Every entry must carry a reason a reviewer can read, and the set must be
    // the one the findings would otherwise produce — an exemption added for a
    // name that is actually reached is caught by the gate's `stale-exemption`
    // rule, but an exemption with no reason is caught here.
    const keys = Object.keys(SURFACE_EXEMPT_EXPORTS)
    assert.ok(keys.length > 0, 'the exemption set is empty, which is not the shipped state')
    for (const key of keys) {
      assert.match(key, /^src\/.+\.js::[A-Za-z_$][\w$]*$/, `exemption key is not a src export: ${key}`)
      assert.ok(
        String(SURFACE_EXEMPT_EXPORTS[key]).length >= 20,
        `exemption for ${key} carries no usable reason`,
      )
    }
  })

  it('does not read a docstring mention as a call — the bug that hid resetSdnCache', () => {
    // The exact shape: an export whose only other occurrence is its own name in
    // prose. A scanner that reads comments as code calls this live.
    const { findings } = deadExportFindings({
      sources: [{
        path: 'src/a.js',
        source: '/** `resetSdnCache` is used by tests. */\nexport function resetSdnCache() {}\n',
      }],
    })
    assert.deepEqual(findings.map((f) => f.key), ['src/a.js::resetSdnCache'])
  })

  it('does not read a name in a thrown message as the module using its own export', () => {
    // `beginCapture` throws a TypeError naming itself, so a scanner that reads
    // strings as code calls it live while flagging its sibling `endCapture`.
    assert.equal(usedInOwnBody("export function beginCapture() { throw new TypeError('beginCapture: bad store') }\n", 'beginCapture'), false)
  })

  it('resolves a relative specifier to a repo path, and refuses a bare one', () => {
    // The *path*, never the basename: `routes/kpi.js` and `kpi.js` are two
    // modules, and keying on the basename is the false pass
    // `check-module-coverage.mjs` was rewritten to stop making.
    assert.equal(resolveSpecifier('src/routes/kpi.js', '../utils.js'), 'src/utils.js')
    assert.equal(resolveSpecifier('src/a.js', 'node:fs'), null)
    assert.equal(resolveSpecifier('src/a.js', 'pg'), null)
  })

  it('parses a namespace import as reaching every export of its target', () => {
    const mod = parseModule('src/b.js', "import * as a from './a.js'\n")
    assert.ok(mod.starImported.has('src/a.js'))
  })

  it('parses the dynamic-destructure form 53 test files use', () => {
    const mod = parseModule('test/b.test.js', "const { kpiCacheStats } = await import('../src/kpi.js')\n")
    assert.ok(mod.imported.get('src/kpi.js')?.has('kpiCacheStats'))
  })

  it('records a member read off an unresolvable namespace by name, not by target', () => {
    // `(await import(path.join(ROOT, entry.module))).spec` — the specifier is
    // built from connectors.registry.json, so no regex resolves it. Three live
    // connector specs were reported dead before this rule existed.
    const mod = parseModule('test/b.test.js', "const s = (await import(path.join(ROOT, entry.module))).spec\n")
    assert.ok(mod.namespaceMembers.has('spec'), 'the member read was not recorded')
  })
})
