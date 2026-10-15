#!/usr/bin/env node
/**
 * ENH-59. Regenerates the `paths:` block of `docs/openapi.yaml` from
 * `src/route-declaration.js`.
 *
 * The header above `paths:` and everything from `components:` down are carried
 * through verbatim — they are prose about the API, not a table of routes, and a
 * generator that owned them would be a generator that rewrites them whenever it
 * runs.
 *
 * The output shape is not free. Three gates parse this file with line-anchored
 * regexes and all three require a path at two spaces and a verb at four:
 *
 *   scripts/check-openapi.mjs:82         /^ {2}(\/[^:\n]*):\s*$/gm
 *   scripts/check-route-methods.mjs      /^ {2}(\/[^:]+):$/ and /^ {4}(get|post|...):$/
 *   scripts/check-route-envelopes.mjs    the same pair
 *
 * `test/route-declaration.test.js` asserts the committed file equals what this
 * emits, so the contract is enforced rather than documented.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SPEC = 'docs/openapi.yaml'

/**
 * The `paths:` block as it stands, split into the three parts a generator
 * needs: the header above it, the entries, and the tail from `components:`.
 */
export function readSpecParts(root = ROOT) {
  const lines = fs.readFileSync(path.join(root, SPEC), 'utf8').split('\n')
  const start = lines.findIndex((l) => l === 'paths:')
  if (start < 0) throw new Error('generate-openapi: no `paths:` block')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z]/.test(lines[i])) { end = i; break }
  }
  return { lines, start, end }
}

/**
 * Which paths are preceded by a blank line. The blanks are presentation, and
 * reproducing them is what makes the output byte-identical on a clean tree —
 * a generator that reformats the whole file on first run produces a diff
 * nobody can review.
 */
export function blankBeforeSet(lines, start, end) {
  const blank = new Set()
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i] !== '') continue
    let n = i + 1
    while (n < end && lines[n] === '') n += 1
    const m = n < end ? lines[n].match(/^  (\/[^:]+):\s*$/) : null
    if (m) blank.add(m[1])
  }
  return blank
}

/**
 * A declaration block is a template literal wrapped in newlines so the file
 * reads as YAML. Unwrap it back to lines — and split, never spread: spreading a
 * string yields its characters.
 */
function toLines(block) {
  return String(block).replace(/^\n/, '').replace(/\n$/, '').split('\n')
}

/**
 * @returns {{ yaml: string, pathCount: number, opCount: number }}
 */
export function generateOpenApi({ root = ROOT, write = true } = {}) {
  const { lines, start, end } = readSpecParts(root)
  const blankBefore = blankBeforeSet(lines, start, end)

  // Imported, not parsed: a declaration that fails to load must fail loudly.
  return import(path.join(root, 'src/route-declaration.js')).then(({ ROUTE_DECLARATION }) => {
    const byPath = new Map()
    for (const e of ROUTE_DECLARATION) {
      if (!byPath.has(e.path)) byPath.set(e.path, { path: e.path, pre: null, ops: [] })
      const entry = byPath.get(e.path)
      if (e.pre && !entry.pre) entry.pre = e.pre
      entry.ops.push(e)
    }

    const out = lines.slice(0, start)
    out.push('paths:')
    for (const entry of byPath.values()) {
      if (blankBefore.has(entry.path)) out.push('')
      out.push(`  ${entry.path}:`)
      if (entry.pre) out.push(...toLines(entry.pre))
      for (const op of entry.ops) {
        out.push(`    ${op.method.toLowerCase()}:`)
        out.push(...toLines(op.body))
      }
    }
    out.push(...lines.slice(end))

    const yaml = out.join('\n')
    if (write) fs.writeFileSync(path.join(root, SPEC), yaml)
    return { yaml, pathCount: byPath.size, opCount: ROUTE_DECLARATION.length }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateOpenApi({ write: process.argv.includes('--write') })
    .then(({ pathCount, opCount }) => {
      process.stderr.write(
        `generate-openapi: ${pathCount} paths, ${opCount} operations`
        + `${process.argv.includes('--write') ? ' -> docs/openapi.yaml' : ' (dry run)'}\n`,
      )
    })
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`)
      process.exit(1)
    })
}
