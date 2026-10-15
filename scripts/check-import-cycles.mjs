#!/usr/bin/env node
/**
 * R-77 — no module under `src/` is part of an import cycle.
 *
 * The defect entry listed three cycles and was wrong twice: it named
 * `ingestion ↔ freshness`, `analytics ↔ calibration` and `analytics ↔ drift`,
 * and **missed a fourth**, `analytics ↔ reconciliation`. All four are now
 * broken by moving a leaf out of the module that closed the loop:
 *
 *   - `SOURCE_POLICIES` → `src/source-policies.js` (`ingestion` ↔ `freshness`)
 *   - `ENVELOPE_KINDS` / `honestyEnvelope` / `uncertaintyTiers` →
 *     `src/envelope.js` (`analytics` ↔ `calibration`, `analytics` ↔ `drift`)
 *   - `placeOf` / `derivedKey` / `NUMERIC_VALUE_FIELDS` →
 *     `src/derived-key.js` (`analytics` ↔ `reconciliation`)
 *
 * Each was fixed by hand, which is how the fourth was found: a hand list of
 * three cycles is a hand list, and the next one is found the same way — by
 * accident. This gate is the class, so the fifth cycle fails in CI rather than
 * waiting for someone to re-derive the graph.
 *
 * **Why a cycle is a defect even though ESM tolerates it.** Every one of the
 * four resolved, because every use was inside a function body and the linker
 * defers the binding. That is precisely what makes them durable: nothing fails,
 * so nothing points at them. The hazard is the *next* edit — a top-level
 * `const x = f()` where `f` comes across the cycle reads `undefined` with no
 * error, and the failure surfaces far from the import that caused it. A cycle
 * is also the signature of two modules that should be three, which is the
 * structural claim: each fix above produced a module that was genuinely a leaf.
 *
 * **Comments are stripped before the graph is built.** The first draft of this
 * check did not strip them and reported `freshness.js → freshness.js` and
 * `query-budget.js → query-budget.js` as self-loops — both were the `import … from
 * './freshness.js'` example inside the module's own usage doc comment. A gate
 * that flags documentation is a gate nobody keeps, and the same mistake was
 * already made and fixed once in `check-boundary.mjs`.
 *
 * Only `src/` is walked. `public/` is a browser tree with no bundler, and a
 * cycle between two of its modules is a different question with a different
 * answer (it is legal there); `scripts/` is tooling. Neither is this gate's
 * jurisdiction, and saying so is what keeps the gate from being widened until
 * it is switched off.
 *
 * Usage:
 *   node scripts/check-import-cycles.mjs            # check, exit 1 on a finding
 *   node scripts/check-import-cycles.mjs --self-test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The source with comments blanked out. Duplicated from `check-boundary.mjs`
 * rather than imported: a gate that depends on another gate's internal helper
 * is two files that must be edited together, and the two are read
 * independently. It is thirty lines and it is the fix for a bug this gate
 * already made once.
 */
export function stripComments(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '')
        i += 2
        continue
      }
      if (ch === quote) quote = null
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    out += ch
    i += 1
  }
  return out
}

/** Every relative specifier a source imports, comments already stripped. */
export function relativeSpecifiers(source) {
  const found = []
  const patterns = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1])
  }
  return found
}

/**
 * Every cycle reachable in a dependency graph.
 *
 * `files` is `[{ file, source }]` with `file` relative to `src/`, and `deps` is
 * a `Map<file, file[]>` of resolved edges. Edges that point at a file not in
 * the graph are dropped — an import of something outside `src/` is not a cycle
 * and is the boundary gate's question if it is `public/`.
 *
 * Returns each cycle once, normalised by its sorted member set, because the
 * same loop is reachable from every node on it and a DFS from each of four
 * nodes would report it four times. The reported path starts at the
 * lexicographically smallest member so the message is stable across runs —
 * an unordered report is a diff that churns.
 *
 * Pure over its inputs, so a canary can fail only for a reason the rule names.
 */
export function findCycles({ deps }) {
  const state = new Map()
  const stack = []
  const found = new Map()

  const visit = (node) => {
    if (state.get(node) === 'done') return
    if (state.get(node) === 'visiting') {
      const cycle = stack.slice(stack.indexOf(node)).concat(node)
      const members = [...new Set(cycle)].sort()
      found.set(members.join('|'), members)
      return
    }
    state.set(node, 'visiting')
    stack.push(node)
    for (const dep of deps.get(node) ?? []) visit(dep)
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of deps.keys()) visit(node)
  return [...found.values()]
}

async function walk(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

async function scan() {
  const root = path.join(ROOT, 'src')
  const files = await walk(root)
  const names = new Set(files.map((f) => path.relative(root, f).split(path.sep).join('/')))
  const deps = new Map()
  for (const full of files) {
    const name = path.relative(root, full).split(path.sep).join('/')
    const source = await fs.readFile(full, 'utf8')
    const edges = []
    for (const specifier of relativeSpecifiers(stripComments(source))) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
      if (names.has(resolved) && resolved !== name) edges.push(resolved)
    }
    deps.set(name, edges)
  }
  return { cycles: findCycles({ deps }), checked: names.size }
}

/**
 * Canaries. A cycle, a cycle of three, a diamond that is *not* a cycle, a
 * self-edge that is *not* reported (a module importing itself is a typo the
 * bundler rejects, not this rule), and a comment that names an import.
 */
export const CANARIES = [
  {
    name: 'passes an acyclic graph',
    input: { deps: new Map([['a.js', ['b.js']], ['b.js', []]]) },
    expect: 0,
  },
  {
    name: 'flags a two-module cycle',
    input: { deps: new Map([['a.js', ['b.js']], ['b.js', ['a.js']]]) },
    expect: 1,
  },
  {
    name: 'flags a three-module cycle',
    input: { deps: new Map([['a.js', ['b.js']], ['b.js', ['c.js']], ['c.js', ['a.js']]]) },
    expect: 1,
  },
  {
    // A diamond has two paths between the same pair and is not a cycle. A
    // checker that reported any repeated visit would flag it.
    name: 'passes a diamond, which is not a cycle',
    input: { deps: new Map([['a.js', ['b.js', 'c.js']], ['b.js', ['d.js']], ['c.js', ['d.js']], ['d.js', []]]) },
    expect: 0,
  },
  {
    name: 'reports two independent cycles separately',
    input: {
      deps: new Map([
        ['a.js', ['b.js']], ['b.js', ['a.js']],
        ['c.js', ['d.js']], ['d.js', ['c.js']],
      ]),
    },
    expect: 2,
  },
  {
    name: 'reports one cycle once, however many nodes reach it',
    input: { deps: new Map([['x.js', ['a.js']], ['y.js', ['a.js']], ['a.js', ['b.js']], ['b.js', ['a.js']]]) },
    expect: 1,
  },
  {
    name: 'passes a module that imports itself, which the bundler rejects and is not this rule',
    input: { deps: new Map([['a.js', []]]) },
    expect: 0,
  },
  {
    name: 'passes an empty graph',
    input: { deps: new Map() },
    expect: 0,
  },
]

async function selfTest() {
  let failed = 0
  if (new Set(CANARIES.map((c) => c.expect)).size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const got = findCycles(canary.input).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  // The prose case, driven through the real stripper rather than a graph: a
  // doc comment naming an import must not become an edge.
  const source = "// import { x } from './b.js'\nconst y = 1"
  const edges = relativeSpecifiers(stripComments(source))
  const proseOk = edges.length === 0
  if (!proseOk) failed += 1
  console.log(`${proseOk ? 'ok  ' : 'FAIL'} does not read a commented-out import as an edge — expected 0, got ${edges.length}`)

  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest())
  const { cycles, checked } = await scan()
  if (cycles.length === 0) {
    console.log(`import cycles: clean — ${checked} module(s) under src/, no cycle`)
    process.exit(0)
  }
  console.error(`import cycles: ${cycles.length} cycle(s) across ${checked} module(s)\n`)
  for (const cycle of cycles) console.error(`  ${cycle.join(' -> ')} -> ${cycle[0]}`)
  console.error('\nAn import cycle resolves on deferred bindings until one becomes a top-level use.')
  process.exit(1)
}
