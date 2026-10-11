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
  'demo-seed.js': 'Driven through POST /api/v1/demo/seed by test/lite.test.js, and named by test/layering.test.js for the ARC-03 boundary it defines (the route must import ./demo-seed.js, not ../scripts/seed-demo.mjs).',
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
 * `src/x.js` and `./x.js` both resolve to `x.js`. A bare specifier (`node:fs`,
 * `pg`) resolves to nothing and is dropped.
 */
export function referencedModules(source) {
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
      const name = specifier.split('/').pop()
      if (name.endsWith('.js')) found.add(name)
    }
  }
  return found
}

/**
 * The finding list for a set of module names against a set of test sources.
 *
 * Pure, so the canaries below drive it with strings rather than a tree on disk —
 * a canary that has to write files can fail for a reason the rule does not name.
 */
export function moduleFindings({ modules, testSources, allowlist = SERVER_SURFACE_MODULES }) {
  const reached = new Set()
  for (const source of testSources) {
    for (const name of referencedModules(source)) reached.add(name)
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

  const testSources = await Promise.all(testFiles.map((f) => fs.readFile(f, 'utf8')))
  const modules = srcFiles.map((f) => path.basename(f))
  const findings = moduleFindings({ modules, testSources })
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
    name: 'resolves a deeper path to the same module name',
    input: { modules: ['utils.js'], testSources: ["import { x } from '../src/lib/utils.js'"] },
    expect: 0,
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
