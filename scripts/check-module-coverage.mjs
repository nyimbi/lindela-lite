#!/usr/bin/env node
/**
 * QUA-05 — every module under `src/` is reached by a test, or is named here.
 *
 * The defect entry for QUA-05 listed ten "operationally important modules with
 * no dedicated test file" and got most of them wrong, because it read a file
 * name as evidence of coverage. `src/audit-chain.js` has `test/audit-chain.test.js`;
 * `src/observability.js` is covered by two files named after neither;
 * `public/sw.js` is imported as a module by four test files and its functions
 * are called. The one real finding in the list — `src/lineage.js`, dead code —
 * was invisible to the hand count, because a module nobody imports and a module
 * imported only by a file with a different name look the same from the outside.
 *
 * A census nobody can re-run is a paragraph, and a paragraph drifts. This runs
 * it: every `.js` under `src/`, every test file, and a module must be reachable
 * from a test — by a static `from './x.js'` or a dynamic `import('./x.js')`, at
 * any path depth — unless it is named in `SERVER_SURFACE_MODULES` below with the
 * route that reaches it instead.
 *
 * **Why a reachability check and not a coverage number.** Line coverage says a
 * line ran; it does not say a claim about it was asserted, and QUA-04 already
 * owns that axis with a floor. What this catches is the module that has *no*
 * entry point from the suite at all — the shape that hid `lineage.js` and the
 * shape that hides the next one. Both directions are checked: a module in the
 * allowlist that a test now imports is reported, because an allowlist entry that
 * outlives its reason is how an allowlist becomes a place to hide.
 *
 * The allowlist is a *surface* exemption, not a coverage exemption. `cors.js` is
 * a middleware: it has no exports worth calling directly, and its behaviour is
 * the response headers on a real request, which `test/cors-preflight.test.js`
 * asserts through the server. Importing it would test a function; the test that
 * exists tests the thing.
 *
 * Usage:
 *   node scripts/check-module-coverage.mjs            # check, exit 1 on a finding
 *   node scripts/check-module-coverage.mjs --self-test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Modules reached only through the server surface, with the route that reaches
 * them and the file that drives it. Each entry is a decision a reviewer reads;
 * an entry whose reason is "hard to test" does not belong here.
 */
export const SERVER_SURFACE_MODULES = Object.freeze({
  'cors.js': 'Middleware. Its behaviour is response headers on a real request, asserted by test/cors-preflight.test.js through the server; importing it would test a function and not the thing.',
})

/**
 * Every module specifier a source text mentions, resolved to a bare module name
 * when it points at `src/`.
 *
 * Both spellings matter and only one was in the first draft of this file's
 * logic. `from './x.js'` covers the static form; `import('./x.js')` — used by
 * the console's lazy loader and by `server.js` for the demo seeder — is the same
 * dependency written the other way. A check that enumerated one of the two would
 * report `demo-seed.js` as unreached while `server.js` imports it in the line
 * the ARC-03 test asserts on, which is the failure mode QUA-05's own hand count
 * made.
 *
 * `src/routes/kpi.js` and `./routes/kpi.js` both resolve to `routes/kpi.js`. A
 * bare specifier (`node:fs`, `pg`) resolves to nothing and is dropped.
 *
 * **The path, not the basename.** The first version keyed on `path.basename`,
 * which made two different modules the same module. It was invisible while
 * `src/` was flat and became a false pass the moment ARC-01 created
 * `src/routes/`: `src/routes/kpi.js` had no test of its own, and the check
 * called it reached because `src/kpi.js` — a different file, importing nothing
 * from it — is imported by nine test files. The gate was reporting coverage of
 * a module by reading a different one, which is the same failure as a checker
 * that names a file by path rather than by identity: the answer is right about
 * the wrong object, and it looks clean.
 *
 * So a specifier resolves against the *importing file's* directory to a
 * `src/`-relative path, and that path is the identity. `fromDir` is the
 * directory of the file the source came from; for a test in `test/` importing
 * `../src/routes/kpi.js` it is `<root>/test`.
 */
export function referencedModules(source, fromDir = null) {
  const found = new Set()
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // `export ... from './x.js'` is the `from` pattern above, but a re-export
    // written as `export * as ns from` and a bare `import './x.js'` for side
    // effects are neither. The side-effect form is the one that matters: a
    // module imported for what it does at load time has no binding to grep for.
    /\bimport\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue
      if (!specifier.endsWith('.js')) continue
      if (fromDir === null) {
        // No directory to resolve against — a canary's bare string. Fall back to
        // the basename, which is unambiguous for a tree with no subdirectories
        // and is what the canaries drive.
        found.add(specifier.split('/').pop())
        continue
      }
      const resolved = path.resolve(fromDir, specifier)
      const relative = path.relative(path.join(ROOT, 'src'), resolved)
      // `..` means the specifier points outside `src/` — a script, a fixture, a
      // test helper. Not this check's jurisdiction.
      if (relative.startsWith('..')) continue
      found.add(relative)
    }
  }
  return found
}

/**
 * The finding list for a set of module paths against a set of test sources.
 *
 * `modules` are `src/`-relative paths (`kpi.js`, `routes/kpi.js`). `testFiles`
 * are `{ dir, source }` — the directory is what a relative specifier resolves
 * against, and without it two modules of the same basename collapse into one.
 * `testSources` (bare strings) is still accepted for the canaries, which drive
 * strings rather than a tree on disk.
 *
 * Pure, so a canary can fail only for a reason the rule names.
 */
export function moduleFindings({ modules, testSources = [], testFiles = null, allowlist = SERVER_SURFACE_MODULES }) {
  const reached = new Set()
  const sources = testFiles ?? testSources.map((source) => ({ dir: null, source }))
  for (const { dir, source } of sources) {
    for (const name of referencedModules(source, dir)) reached.add(name)
  }

  const findings = []
  for (const name of modules) {
    if (reached.has(name)) {
      // The other direction. An allowlist entry a test now imports is a reason
      // that has expired, and a stale entry is an exemption nobody re-reads.
      if (allowlist[name]) {
        findings.push({
          rule: 'stale-exemption',
          module: name,
          detail: `named in SERVER_SURFACE_MODULES, but a test imports it directly now. Remove the entry.`,
        })
      }
      continue
    }
    if (!allowlist[name]) {
      findings.push({
        rule: 'unreached-module',
        module: name,
        detail: 'no test file imports this module, directly or dynamically.',
      })
    }
  }
  return findings
}

async function walk(dir, suffix) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, suffix))
    else if (entry.name.endsWith(suffix)) out.push(full)
  }
  return out
}

async function scan() {
  const srcFiles = (await walk(path.join(ROOT, 'src'), '.js'))
    .filter((f) => !f.endsWith('.test.js'))
  const testFiles = await walk(path.join(ROOT, 'test'), '.js')

  const testSources = await Promise.all(testFiles.map(async (f) => ({
    dir: path.dirname(f),
    source: await fs.readFile(f, 'utf8'),
  })))
  // `src/`-relative, not the basename. `routes/kpi.js` and `kpi.js` are two
  // modules, and keying on the basename made them one.
  const modules = srcFiles.map((f) => path.relative(path.join(ROOT, 'src'), f).split(path.sep).join('/'))
  const findings = moduleFindings({ modules, testFiles: testSources })
  return { findings, checked: modules.length, testFiles: testFiles.length }
}

/**
 * Canaries. Each drives `moduleFindings` with text. The two directions of the
 * rule are covered — a module reached and not allowlisted passes, a module
 * reached *and* allowlisted is a stale exemption — because a checker that only
 * tested one direction would report a clean tree for a rule it never applied.
 */
export const CANARIES = [
  {
    name: 'passes a module a test imports statically',
    input: { modules: ['a.js'], testSources: ["import { x } from '../src/a.js'"] },
    expect: 0,
  },
  {
    name: 'passes a module a test imports dynamically, which is the other spelling',
    input: { modules: ['lazy-panel.js'], testSources: ["const m = await import('./lazy-panel.js')"] },
    expect: 0,
  },
  {
    name: 'passes a module a test imports for its side effects, with no binding',
    input: { modules: ['polyfill.js'], testSources: ["import './polyfill.js'"] },
    expect: 0,
  },
  {
    name: 'flags a module no test reaches — the shape that hid src/lineage.js',
    input: { modules: ['lineage.js'], testSources: ["import { x } from '../src/other.js'"] },
    expect: 1,
  },
  {
    name: 'flags a stale exemption: allowlisted and now imported',
    input: { modules: ['cors.js'], testSources: ["import { x } from '../src/cors.js'"], allowlist: { 'cors.js': 'middleware' } },
    expect: 1,
  },
  {
    name: 'passes an allowlisted module no test imports',
    input: { modules: ['cors.js'], testSources: ["import { x } from '../src/other.js'"], allowlist: { 'cors.js': 'middleware' } },
    expect: 0,
  },
  {
    name: 'does not count a bare specifier as reaching a src module',
    input: { modules: ['fs.js'], testSources: ["import fs from 'node:fs'"] },
    expect: 1,
  },
  {
    name: 'does not count a mention in prose as an import',
    input: { modules: ['lineage.js'], testSources: ['// lineage.js was deleted; see the entry'] },
    expect: 1,
  },
  {
    name: 'resolves a specifier against the importing file, to a src-relative path',
    input: {
      modules: ['lib/utils.js'],
      testFiles: [{ dir: path.join(ROOT, 'test'), source: "import { x } from '../src/lib/utils.js'" }],
    },
    expect: 0,
  },
  {
    // The false pass ARC-01 walked into. Two modules share a basename; a test
    // imports one of them. Keyed on the basename the check calls both reached,
    // and reports coverage of a module by reading a different one.
    name: 'does not let a module of the same basename cover another — routes/kpi.js vs kpi.js',
    input: {
      modules: ['kpi.js', 'routes/kpi.js'],
      testFiles: [{ dir: path.join(ROOT, 'test'), source: "import { x } from '../src/kpi.js'" }],
    },
    expect: 1,
  },
  {
    // The same collision, both imported. Neither may be reported.
    name: 'passes two modules of the same basename when a test imports each',
    input: {
      modules: ['kpi.js', 'routes/kpi.js'],
      testFiles: [{ dir: path.join(ROOT, 'test'), source: "import { x } from '../src/kpi.js'\nimport { y } from '../src/routes/kpi.js'" }],
    },
    expect: 0,
  },
  {
    name: 'ignores a specifier that points outside src/, which is not its jurisdiction',
    input: {
      modules: ['helper.js'],
      testFiles: [{ dir: path.join(ROOT, 'test'), source: "import { h } from './helpers/helper.js'" }],
    },
    expect: 1,
  },
]

async function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => c.expect))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const got = moduleFindings(canary.input).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest())
  const { findings, checked, testFiles } = await scan()
  if (findings.length === 0) {
    console.log(`module coverage: clean — ${checked} module(s) under src/, ${testFiles} test file(s) searched`)
    process.exit(0)
  }
  console.error(`module coverage: ${findings.length} finding(s) across ${checked} module(s)\n`)
  for (const f of findings) console.error(`  [${f.rule}] src/${f.module}\n    ${f.detail}`)
  console.error('\nA module no test reaches is a module whose behaviour is asserted nowhere.')
  console.error('Either write the test, or name it in SERVER_SURFACE_MODULES with the route')
  console.error('that reaches it and the file that drives that route.')
  process.exit(1)
}
