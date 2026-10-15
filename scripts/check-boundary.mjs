#!/usr/bin/env node
/**
 * R-78 — the browser bundle never imports the server.
 *
 * The defect entry for R-78 said "`src/` → `public/` and `public/` → `src/` are
 * both 0 edges today, by convention only. A one-line gate would hold it." The
 * second half is right and the first is wrong in a way that matters, because a
 * gate written from it would have failed on a clean tree:
 *
 *   - `public/` → `src/` is 0 edges. That is the invariant.
 *   - `src/` → `public/` is **17 edges across 13 files**, and is deliberate.
 *
 * The server imports `public/shared/units.js`, `public/shared/flood-bands.js`,
 * `public/shared/rank-explain.js` and others so that a computation the browser
 * runs and a computation the server runs are the *same code*. That direction is
 * the mechanism by which the two agree; forbidding it would forbid the thing
 * that keeps them honest, and a gate that forbade it would be switched off the
 * first day it blocked a legitimate import — the shape this repository has
 * already recorded twice, a gate scoped wider than its jurisdiction.
 *
 * So the jurisdiction is exactly one direction: **nothing under `public/` may
 * import anything under `src/`.** A surface that does ships a module the
 * browser cannot resolve — `src/` is not served — and the failure is a 404 at
 * runtime in a surface that passed every test, because no test loads a page
 * with that import in it. The fix is to move the shared code into
 * `public/shared/` and let the server import it from there, which is the
 * arrangement the 17 existing edges already use.
 *
 * A static import is the case that breaks the browser outright. A dynamic
 * `import()` would break it too, so both are findings. A specifier that is
 * mentioned in a comment or a string is not an import and is not a finding —
 * the canaries pin that, because a checker that greps for the substring `src/`
 * reports the doc comment that explains this rule.
 *
 * Usage:
 *   node scripts/check-boundary.mjs            # check, exit 1 on a finding
 *   node scripts/check-boundary.mjs --self-test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every module specifier a source text imports, in any of the spellings this
 * tree uses. Returns the raw specifiers, unresolved — resolution needs the
 * importing file's directory, which is the caller's job.
 *
 * The four patterns are the ones `check-module-coverage.mjs` established, and
 * they are here for the same reason: a check that enumerated only `from '...'`
 * would miss `import('./x.js')`, which is exactly how a lazy panel loader would
 * smuggle a `src/` import past this gate.
 */
export function importSpecifiers(source) {
  const found = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1])
  }
  return found
}

/**
 * The source with comments blanked out, so a prose mention of a path is not
 * read as an import.
 *
 * This exists because the first version of this gate did not have it and the
 * canary caught it: the side-effect pattern `import\s+['"]…['"]` matched the
 * words "may import '../src/utils.js'" inside a doc comment, and the file that
 * *documents this rule* would have been reported as breaking it. A checker that
 * flags the comment explaining it is a checker nobody keeps.
 *
 * A character walk rather than a regex, because `//` inside a string is a URL
 * and `/*` inside a template literal is text — a naive strip corrupts both and
 * can hide a real import that follows one on the same line. Quotes, template
 * literals, line comments and block comments are tracked; comment characters
 * become spaces so offsets and line structure survive.
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

/**
 * The finding list for a set of `{ file, source }` pairs under `public/`.
 *
 * `file` is `public/`-relative and is only used to report and to resolve a
 * relative specifier. Pure, so a canary can fail only for a reason the rule
 * names.
 *
 * A relative specifier resolves against the importing file's directory. A
 * specifier that climbs out of `public/` and lands in `src/` is the finding;
 * one that climbs out and lands anywhere else (a script, a fixture) is not this
 * check's jurisdiction and is ignored. A bare specifier (`node:fs`, `pg`)
 * resolves to nothing here and is dropped — a browser surface importing `pg`
 * is a different defect, one this gate does not own.
 */
export function boundaryFindings({ files, publicDir = 'public', srcDir = 'src' }) {
  const findings = []
  for (const { file, source } of files) {
    const fromDir = path.posix.dirname(`${publicDir}/${file}`)
    for (const specifier of importSpecifiers(stripComments(source))) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue
      const resolved = path.posix.normalize(path.posix.join(fromDir, specifier))
      if (resolved === srcDir || resolved.startsWith(`${srcDir}/`)) {
        findings.push({
          rule: 'browser-imports-server',
          file: `${publicDir}/${file}`,
          specifier,
          detail: `resolves to ${resolved}/ — the browser cannot fetch it. Move the shared code to ${publicDir}/shared/ and import it from there in both places.`,
        })
      }
    }
  }
  return findings
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
  const root = path.join(ROOT, 'public')
  const files = (await walk(root)).map((full) => ({
    file: path.relative(root, full).split(path.sep).join('/'),
    source: null,
    full,
  }))
  const loaded = await Promise.all(files.map(async (f) => ({
    file: f.file,
    source: await fs.readFile(f.full, 'utf8'),
  })))
  return { findings: boundaryFindings({ files: loaded }), checked: loaded.length }
}

/**
 * Canaries. Both directions of the rule and the two false-positive shapes.
 *
 * The expectations are deliberately not uniform: a checker that always returned
 * nothing, or always returned one finding, would satisfy a set of canaries that
 * all expected the same count.
 */
export const CANARIES = [
  {
    name: 'passes a surface that imports only from public/shared',
    input: { files: [{ file: 'districts/app.js', source: "import { x } from '../shared/units.js'" }] },
    expect: 0,
  },
  {
    name: 'flags a surface importing a src module relatively',
    input: { files: [{ file: 'districts/app.js', source: "import { x } from '../../src/utils.js'" }] },
    expect: 1,
  },
  {
    name: 'flags the same import written as a dynamic import()',
    input: { files: [{ file: 'app.js', source: "const m = await import('../src/kpi.js')" }] },
    expect: 1,
  },
  {
    name: 'flags a bare side-effect import of a src module',
    input: { files: [{ file: 'app.js', source: "import '../src/polyfill.js'" }] },
    expect: 1,
  },
  {
    // The false positive that matters most: this file's own doc comment names
    // `src/` repeatedly. A substring check reports every one of them.
    name: 'does not count a src path named in prose or a string',
    input: {
      files: [{ file: 'app.js', source: "// nothing here may import '../src/utils.js'\nconst note = 'see src/utils.js'" }],
    },
    expect: 0,
  },
  {
    name: 'does not claim jurisdiction over a specifier that leaves public/ elsewhere',
    input: { files: [{ file: 'app.js', source: "import { x } from '../../scripts/helper.mjs'" }] },
    expect: 0,
  },
  {
    name: 'ignores a bare specifier, which is not this gate\'s defect',
    input: { files: [{ file: 'app.js', source: "import fs from 'node:fs'" }] },
    expect: 0,
  },
  {
    // Climbing out of `public/` and landing back in `src/`. The importing file
    // is `public/a/b/c.js`, so its directory is `public/a/b` and it takes
    // *three* levels to reach the repo root: `../../../src/…`.
    //
    // This canary was written twice wrong before it was right — first with four
    // levels (which lands above the repo) and then with two (which lands in
    // `public/`, where `src/` does not exist). Both times the gate was correct
    // and the canary was miscalculated, which is the note worth keeping: a
    // canary that fails is a claim about the gate, and the claim has to be
    // checked before it is believed. A canary asserting a path that does not
    // exist tests nothing about the rule.
    name: 'flags a specifier that reaches src/ after normalising',
    input: { files: [{ file: 'a/b/c.js', source: "import { x } from '../../../src/routes/kpi.js'" }] },
    expect: 1,
  },
  {
    name: 'flags two offenders in one file as two findings',
    input: {
      files: [{
        file: 'app.js',
        source: "import { a } from '../src/a.js'\nimport { b } from '../src/b.js'",
      }],
    },
    expect: 2,
  },
]

async function selfTest() {
  let failed = 0
  if (new Set(CANARIES.map((c) => c.expect)).size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const got = boundaryFindings(canary.input).length
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
  const { findings, checked } = await scan()
  if (findings.length === 0) {
    console.log(`boundary: clean — ${checked} module(s) under public/, none imports src/`)
    process.exit(0)
  }
  console.error(`boundary: ${findings.length} finding(s) across ${checked} module(s)\n`)
  for (const f of findings) console.error(`  [${f.rule}] ${f.file}\n    ${f.specifier} ${f.detail}`)
  console.error('\nA browser surface that imports src/ ships a module the browser cannot fetch.')
  process.exit(1)
}
