#!/usr/bin/env node
/**
 * ENH-59. A committed table must equal what its generator emits from the
 * declaration.
 *
 * This is the cheap half of the item, and it is the half that stops the drift
 * recurring. Five tables described the route surface and were kept by hand, so
 * the only thing holding them together was a person remembering to edit all
 * five. Two of them are now outputs. A generator whose output no longer tracks
 * its input is the exact failure the item exists to remove, and it is invisible
 * without this: a stale `docs/openapi.yaml` and a fresh declaration both parse,
 * both serve, and disagree about a route that only one of them knows.
 *
 * **The other half is `check-route-reachability.mjs`.** Drift proves the tables
 * came from the declaration; it cannot prove the declaration is *true*, because
 * a generator that emits from a wrong declaration is consistent and wrong at
 * once. Reachability is what closes that.
 *
 * The two scope tables are deliberately **not** here. A scope is policy — which
 * caller may reach a route — and a declaration row says only that the route
 * exists. They stay hand-kept, and `test/route-declaration.test.js` proves they
 * agree with the declaration on every operation rather than generating them.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateOpenApi } from './generate-openapi.mjs'
import { generateRouteManifests } from './generate-route-manifests.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Each generated output: the file it owns, and how to get the fresh string.
 *
 * `read` and `generate` are separated so a canary can drive `judge` with two
 * strings and never touch the tree — a canary that walks the real files fails
 * for reasons the rule does not name.
 */
export const OUTPUTS = [
  {
    file: 'docs/openapi.yaml',
    generator: 'scripts/generate-openapi.mjs',
    read: async () => (await generateOpenApi({ root: ROOT, write: false })).yaml,
  },
  {
    file: 'src/route-manifests.js',
    generator: 'scripts/generate-route-manifests.mjs',
    read: async () => (await generateRouteManifests({ root: ROOT, write: false })).source,
  },
]

/**
 * The finding for one pair, or `null` when the committed file is current.
 *
 * Returns the first differing line rather than a byte offset: the useful part of
 * a drift report is *which route moved*, and an offset sends the reader to
 * `od`. A generated file is written whole, so the first difference is almost
 * always the line the declaration changed.
 */
export function judge({ committed, generated, file }) {
  if (committed === generated) return null
  const a = committed.split('\n')
  const b = generated.split('\n')
  const at = a.findIndex((line, i) => line !== b[i])
  const line = at < 0 ? Math.min(a.length, b.length) : at
  return {
    file,
    line: line + 1,
    committed: a[line] ?? '<end of file>',
    generated: b[line] ?? '<end of file>',
    committedLines: a.length,
    generatedLines: b.length,
  }
}

export const CANARIES = [
  {
    name: 'passes when the committed file is what the generator emits',
    input: { committed: 'a\nb\nc\n', generated: 'a\nb\nc\n', file: 'x' },
    expect: 0,
  },
  {
    name: 'flags a one-line change anywhere in the file',
    input: { committed: 'a\nb\nc\n', generated: 'a\nB\nc\n', file: 'x' },
    expect: 1,
  },
  {
    name: 'flags a file the generator has grown past',
    input: { committed: 'a\n', generated: 'a\nb\n', file: 'x' },
    expect: 1,
  },
  {
    name: 'flags a file the generator has shrunk past',
    input: { committed: 'a\nb\n', generated: 'a\n', file: 'x' },
    expect: 1,
  },
  {
    // The silent-drop class, which is what this whole item is about. A table
    // that lost every row still parses, still imports, and reads as an empty
    // surface rather than as an error — so "committed is empty" must be a
    // finding even when the generator's output is one line.
    name: 'flags a table that has lost its rows',
    input: { committed: '\n', generated: 'a\nb\nc\n', file: 'x' },
    expect: 1,
  },
  {
    name: 'names the line that moved, not a byte offset',
    input: { committed: 'a\nb\nc\n', generated: 'a\nb\nC\n', file: 'x' },
    expect: 1,
  },
]

export function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => c.expect))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const got = judge(canary.input) ? 1 : 0
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  // The line number is the report's whole value, so it is asserted rather than
  // assumed: a judge that always said line 1 would pass every canary above.
  const named = judge({ committed: 'a\nb\nc\n', generated: 'a\nb\nC\n', file: 'x' })
  if (named?.line !== 3) {
    console.log(`FAIL the drift report names line ${named?.line}, expected 3`)
    failed += 1
  } else {
    console.log('ok   names the moved line rather than the first line')
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())
  const fs = await import('node:fs')
  const findings = []
  for (const out of OUTPUTS) {
    const committed = fs.readFileSync(path.join(ROOT, out.file), 'utf8')
    const generated = await out.read()
    const finding = judge({ committed, generated, file: out.file })
    if (finding) findings.push({ ...finding, generator: out.generator })
  }
  if (findings.length === 0) {
    console.log(`route drift: clean — ${OUTPUTS.length} generated file(s) match the declaration`)
    process.exit(0)
  }
  console.log(`route drift: ${findings.length} file(s) differ from a fresh generation`)
  for (const f of findings) {
    console.log(
      `\n  [drifted] ${f.file}:${f.line} (${f.committedLines} lines committed, ${f.generatedLines} generated)`
      + `\n    committed: ${JSON.stringify(f.committed)}`
      + `\n    generated: ${JSON.stringify(f.generated)}`
      + `\n    the file is an output, not a source. Run: node ${f.generator} --write`,
    )
  }
  process.exit(1)
}
