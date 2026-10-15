import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, boundaryFindings, importSpecifiers, stripComments } from '../scripts/check-boundary.mjs'

/**
 * R-78 — the frontend/backend boundary gate, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/state-keys-gate.test.js`.
 *
 * The defect entry said both directions were 0 edges and the invariant was
 * one-line. Both halves were wrong about the tree: `src/` → `public/` is 17
 * edges and deliberate, so the tests below pin the *asymmetry* rather than an
 * equality. A test that asserted "no edges either way" would pass today only if
 * it were not looking at the 17.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-boundary.mjs')

function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

describe('R-78 the boundary gate holds the one direction that can break the browser', () => {
  it('passes on the tree as it stands', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    // A gate that checked zero modules would also be "clean".
    const checked = Number(/clean — (\d+) module/.exec(output)?.[1] ?? 0)
    assert.ok(checked >= 40, `the gate checked ${checked} modules under public/, which is not the shipped set`)
  })

  it('drives --self-test, which npm run gates never does', () => {
    // The canaries are dead unless something spawns the flag. This is the
    // something, and it asserts the exit code rather than the text, because a
    // gate that prints failures and exits 0 is the failure mode this whole
    // convention exists to prevent.
    const { code, output } = runGate(['--self-test'])
    assert.equal(code, 0, `--self-test exited ${code}:\n${output}`)
    assert.match(output, /all canaries passed/)
  })

  it('has canaries that disagree with each other', () => {
    // Uniform expectations are satisfiable by a checker returning a constant.
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.ok(
      expectations.size >= 2,
      'the canaries no longer disagree, so a scanner returning a constant would pass them',
    )
    for (const canary of CANARIES) {
      assert.equal(
        boundaryFindings(canary.input).length,
        canary.expect,
        `canary "${canary.name}" expected ${canary.expect}`,
      )
    }
  })

  it('the real tree is the load-bearing case: the direction is asymmetric, not zero both ways', () => {
    // The entry claimed 0 edges in both directions. Measure both, from the
    // files, so the claim cannot be restated into the register again.
    const publicFiles = walk(path.join(ROOT, 'public')).map((full) => ({
      file: path.relative(path.join(ROOT, 'public'), full).split(path.sep).join('/'),
      source: fs.readFileSync(full, 'utf8'),
    }))
    assert.deepEqual(
      boundaryFindings({ files: publicFiles }),
      [],
      'public/ imports src/ — the browser cannot fetch it',
    )

    // And the other direction is live, which is why the gate may not assert it.
    const srcFiles = walk(path.join(ROOT, 'src'))
    const srcToPublic = srcFiles.filter((full) => {
      const source = fs.readFileSync(full, 'utf8')
      return importSpecifiers(stripComments(source)).some((s) => /\/public\/|\/\.\.\/public\//.test(s))
    })
    assert.ok(
      srcToPublic.length >= 10,
      `expected the server to import public/shared/ (the sharing mechanism), found ${srcToPublic.length} files`,
    )
  })

  it('a browser surface importing src/ is a finding the gate actually reports', () => {
    // The planted-defect case, driven through the real scanner rather than the
    // synthetic canary input, so the tree path and the pure function agree.
    const planted = [{
      file: 'app.js',
      source: fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8') + "\nimport { x } from '../src/kpi.js'\n",
    }]
    const findings = boundaryFindings({ files: planted })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'browser-imports-server')
    assert.match(findings[0].detail, /src\/kpi\.js/)
  })
})

describe('R-78 the scanner reads imports, not mentions', () => {
  it('strips a line comment without disturbing the code after it', () => {
    // The false positive the canary caught: `import` inside a doc comment
    // matched the side-effect pattern. Blanking the comment must not blank the
    // statement that follows it on the next line.
    const source = "// nothing may import '../src/utils.js'\nimport { a } from '../shared/a.js'"
    assert.deepEqual(importSpecifiers(stripComments(source)), ['../shared/a.js'])
  })

  it('strips a block comment and keeps the newline structure', () => {
    const source = "/* see src/kpi.js */\nimport { a } from './a.js'"
    assert.deepEqual(importSpecifiers(stripComments(source)), ['./a.js'])
    assert.equal(stripComments(source).split('\n').length, source.split('\n').length)
  })

  it('does not mistake a URL in a string for a line comment', () => {
    // A naive `//`-strip corrupts `'https://…'` and can then hide a real import
    // that shares the line. This pins the string-aware walk.
    const source = "const u = 'https://example.test/x'\nimport { a } from './a.js'"
    assert.deepEqual(importSpecifiers(stripComments(source)), ['./a.js'])
  })

  it('finds all four import spellings, so none is a way past the gate', () => {
    const source = [
      "import { a } from './a.js'",
      "const b = await import('./b.js')",
      "import './c.js'",
    ].join('\n')
    assert.deepEqual(importSpecifiers(stripComments(source)).sort(), ['./a.js', './b.js', './c.js'])
  })
})
