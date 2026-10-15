import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, findCycles, relativeSpecifiers, stripComments } from '../scripts/check-import-cycles.mjs'

/**
 * R-77 — the import-cycle gate, guarded.
 *
 * `run-gates.mjs` spawns every gate bare, so a gate's `--self-test` is never
 * driven by `npm run gates` and its canaries are dead unless a test runs them.
 * This is that test, and it follows `test/boundary-gate.test.js`.
 *
 * The gate earned its place before this test existed: run against the tree on
 * the day it was written it found a **fifth** cycle — `needle.js ↔ nl-query.js`
 * — that no hand list had, because it is reachable only through a dynamic
 * `import()` and a static-only graph cannot see it. So the tests below are
 * mostly about that reach: the four import spellings, and the comment case that
 * made the first draft report two self-loops.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-import-cycles.mjs')

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

/** The real graph, built the way the gate builds it, for the tree-level cases. */
function treeDeps() {
  const root = path.join(ROOT, 'src')
  const files = walk(root)
  const names = new Set(files.map((f) => path.relative(root, f).split(path.sep).join('/')))
  const deps = new Map()
  for (const full of files) {
    const name = path.relative(root, full).split(path.sep).join('/')
    const source = fs.readFileSync(full, 'utf8')
    const edges = []
    for (const specifier of relativeSpecifiers(stripComments(source))) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
      if (names.has(resolved) && resolved !== name) edges.push(resolved)
    }
    deps.set(name, edges)
  }
  return deps
}

describe('R-77 the import-cycle gate keeps src/ acyclic', () => {
  it('passes on the tree as it stands', () => {
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    // A gate that checked zero modules would also be "clean".
    const checked = Number(/clean — (\d+) module/.exec(output)?.[1] ?? 0)
    assert.ok(checked >= 100, `the gate checked ${checked} modules under src/, which is not the shipped set`)
  })

  it('drives --self-test, which npm run gates never does', () => {
    const { code, output } = runGate(['--self-test'])
    assert.equal(code, 0, `--self-test exited ${code}:\n${output}`)
    assert.match(output, /all canaries passed/)
  })

  it('has canaries that disagree with each other', () => {
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.ok(
      expectations.size >= 2,
      'the canaries no longer disagree, so a checker returning a constant would pass them',
    )
    for (const canary of CANARIES) {
      assert.equal(
        findCycles(canary.input).length,
        canary.expect,
        `canary "${canary.name}" expected ${canary.expect}`,
      )
    }
  })

  it('the real tree is acyclic — the five cycles R-77 broke stay broken', () => {
    // The load-bearing case. Each of the five was a real cycle with a specific
    // pair; this asserts the tree, not a description of it.
    const cycles = findCycles({ deps: treeDeps() })
    assert.deepEqual(cycles, [], `src/ has cycles: ${cycles.map((c) => c.join(' -> ')).join('; ')}`)
  })

  it('the moved leaves are leaves: nothing in them imports their former host', () => {
    // A "fix" that moved the code but left a back-import would close the cycle
    // again with the same shape, and the cycle detector above would catch it —
    // but only as a cycle, without saying which move regressed. This names them.
    for (const [leaf, formerHost] of [
      ['src/source-policies.js', 'src/ingestion.js'],
      ['src/envelope.js', 'src/analytics.js'],
      ['src/derived-key.js', 'src/analytics.js'],
      ['src/nl-vocabulary.js', 'src/nl-query.js'],
    ]) {
      const source = fs.readFileSync(path.join(ROOT, leaf), 'utf8')
      const specifiers = relativeSpecifiers(stripComments(source))
      const host = path.posix.basename(formerHost)
      assert.ok(
        !specifiers.includes(`./${host}`),
        `${leaf} imports ./${host} again, which re-closes the cycle it was created to break`,
      )
    }
  })

  it('counts a dynamic import as an edge, which is how the fifth cycle was missed by hand', () => {
    // `nl-query.js` reaches `needle.js` only through `await import('./needle.js')`.
    // A graph built from `from '...'` alone reports the tree acyclic while the
    // cycle is live — the exact false negative the gate exists to prevent.
    const source = fs.readFileSync(path.join(ROOT, 'src/nl-query.js'), 'utf8')
    assert.ok(
      relativeSpecifiers(stripComments(source)).includes('./needle.js'),
      'nl-query.js no longer dynamically imports needle.js, so this case is testing nothing',
    )
  })
})

describe('R-77 the scanner reads imports, not mentions', () => {
  it('does not read a commented-out import as an edge', () => {
    // The first draft's bug: `src/freshness.js` documents its own usage with
    // `import { … } from '../src/freshness.js'` inside a doc comment, and the
    // gate reported a self-loop on the module that was documenting itself.
    const source = "// import { x } from './b.js'\nconst y = 1"
    assert.deepEqual(relativeSpecifiers(stripComments(source)), [])
  })

  it('keeps an import that shares a line with a trailing comment', () => {
    const source = "import { a } from './a.js' // see a.js for the reason"
    assert.deepEqual(relativeSpecifiers(stripComments(source)), ['./a.js'])
  })

  it('does not mistake a URL in a string for a line comment', () => {
    const source = "const u = 'https://example.test/x'\nimport { a } from './a.js'"
    assert.deepEqual(relativeSpecifiers(stripComments(source)), ['./a.js'])
  })

  it('finds all four import spellings, so none is a way past the gate', () => {
    const source = [
      "import { a } from './a.js'",
      "const b = await import('./b.js')",
      "import './c.js'",
    ].join('\n')
    assert.deepEqual(relativeSpecifiers(stripComments(source)).sort(), ['./a.js', './b.js', './c.js'])
  })
})
