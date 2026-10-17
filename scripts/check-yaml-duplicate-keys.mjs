#!/usr/bin/env node
/**
 * A YAML mapping must not declare the same key twice.
 *
 * The one live instance was in `docs/openapi.yaml`: a `description:` at lines
 * 3545 and 3550 of the same operation, the first unreachable. YAML keeps the
 * last, so the first was dead text that read as documentation — and a maintainer
 * editing it would have seen no effect and no error. ENH-59 fixed that instance
 * and left the class open, because the general check is a different unit.
 *
 * **The class is reachable through the generator's own input, which is why it
 * cannot be left to the JS scanner.** `test/duplicate-object-keys.test.js`
 * catches a repeated key in a `src/` object *literal*, and that is the right
 * check for `src/`. But a route's spec body lives in `src/route-declaration.js`
 * as a `body:` template literal — raw YAML in a string, which that scanner
 * blanks by design. Plant a second `summary:` at the same indent inside a
 * `body:` literal, regenerate, and the duplicate lands in `docs/openapi.yaml`
 * with every adjacent gate exiting 0: `check-openapi.mjs` compares paths,
 * `check-route-drift.mjs` compares the file to its regeneration, and both see
 * the same two lines. Measured 2026-10-17.
 *
 * **What this models, and what it refuses.** A duplicate is two keys at one
 * indent inside one mapping. The spec uses block scalars, quoted keys, sequence
 * items and flow collections; it uses no anchors, aliases, tags, merge keys,
 * explicit `? ` keys or document markers. Rather than guess at a construct the
 * file does not carry, the reader **refuses the file** when it meets one it
 * cannot model, because a reader that skips what it cannot parse reports a
 * duplicate-free file that it never finished reading — the failure mode this
 * gate exists to remove, wearing the gate's own clothes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Constructs the reader does not model. Meeting one is a refusal, not a skip.
 *
 * `? ` is YAML's explicit key indicator, `<<` a merge key, `&`/`*` an anchor or
 * alias, `!` a tag, `---`/`...` a document marker. None appear in the spec
 * today; each would change what "the same mapping" means, so each stops the
 * read rather than being read wrongly.
 */
const UNMODELLED = [
  { re: /^\s*\?\s/, what: 'an explicit key indicator (`? `)' },
  { re: /^\s*<<\s*:/, what: 'a merge key (`<<`)' },
  { re: /^\s*&[A-Za-z_]/, what: 'an anchor (`&`)' },
  { re: /^\s*![A-Za-z!]/, what: 'a tag (`!`)' },
  { re: /^(---|\.\.\.)\s*$/, what: 'a document marker' },
]

/** A mapping key at the start of `text`, or `null`. Quoted and bare both count. */
function keyOf(text) {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:]*?)\s*:(?:\s|$)/.exec(text)
  if (!m) return null
  return m[1].replace(/^["']|["']$/g, '')
}

/**
 * Every duplicate key, as `{ key, line, first }` for the second occurrence.
 *
 * The reader is a one-pass indent stack. Each frame is one mapping: the indent
 * its keys sit at and the keys seen there. A key's mapping is the top frame when
 * the indent matches; a line more indented than the top frame opens a child, and
 * a line less indented closes frames until one matches. A `- ` item opens a
 * mapping of its own, so the *next* `- ` at the same indent closes the previous
 * item's — two items reusing a key are two mappings, not a duplicate.
 *
 * Block-scalar bodies are skipped: their content is text, and a `summary:`
 * inside one is not a key of anything.
 */
export function duplicateKeys(text) {
  const lines = text.split('\n')
  const found = []
  const stack = []
  let blockIndent = -1

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNo = i + 1

    if (/^\t/.test(line)) throw new Error(`line ${lineNo}: a tab indent`)

    // Inside a block scalar, everything more indented than its header is text.
    if (blockIndent >= 0) {
      if (line.trim() === '' || line.match(/^ */)[0].length > blockIndent) continue
      blockIndent = -1
    }

    if (line.trim() === '' || /^\s*#/.test(line)) continue

    for (const rule of UNMODELLED) {
      if (rule.re.test(line)) throw new Error(`line ${lineNo}: ${rule.what}`)
    }

    const indent = line.match(/^ */)[0].length
    let rest = line.slice(indent)
    const seq = rest === '-' || rest.startsWith('- ')
    if (seq) rest = rest.slice(1).replace(/^ +/, '')
    // A sequence item's mapping begins after the dash, so its keys sit further
    // right than the dash does.
    const contentIndent = indent + (line.slice(indent).length - rest.length)

    // A line that *starts* with a flow collection is a value, not a key at this
    // indent — `{ type: string }` has no key here, and reading `{ type` as one
    // invents a key that can then collide with itself.
    if (/^[{[]/.test(rest)) continue

    // Close frames deeper than this key's own mapping. A frame at the *same*
    // indent is this key's mapping and must survive, or a repeated key closes
    // the frame holding its first occurrence before the second can be compared.
    while (stack.length && stack[stack.length - 1].indent > contentIndent) stack.pop()
    if (seq && stack.length && stack[stack.length - 1].itemAt === indent) stack.pop()

    const scalar = /:\s*[|>][-+0-9]*\s*$/.test(rest)
    const key = keyOf(rest)
    if (key !== null) {
      let frame = stack[stack.length - 1]
      if (!frame || frame.indent !== contentIndent) {
        frame = { indent: contentIndent, itemAt: seq ? indent : undefined, keys: new Map() }
        stack.push(frame)
      }
      if (frame.keys.has(key)) found.push({ key, line: lineNo, first: frame.keys.get(key) })
      else frame.keys.set(key, lineNo)
    }

    if (scalar) blockIndent = indent
  }

  return found
}

export const CANARIES = [
  {
    name: 'a mapping that repeats a key',
    input: 'a:\n  b: 1\n  b: 2\n',
    expect: 1,
  },
  {
    name: 'a mapping whose keys are distinct',
    input: 'a:\n  b: 1\n  c: 2\n',
    expect: 0,
  },
  {
    name: 'two sequence items reusing a key — different mappings, not a duplicate',
    input: 'a:\n  - b: 1\n  - b: 2\n',
    expect: 0,
  },
  {
    name: 'a key repeated at two different indents — a child shadowing its parent',
    input: 'a:\n  b:\n    b: 1\n',
    expect: 0,
  },
  {
    name: 'a repeated key inside a block scalar is text, not a key',
    input: 'a:\n  description: |\n    summary: one\n    summary: two\n',
    expect: 0,
  },
  {
    name: 'a repeated key after a block scalar ends',
    input: 'a:\n  d: |\n    text\n  summary: one\n  summary: two\n',
    expect: 1,
  },
  {
    name: 'the same key in two sibling mappings under one parent',
    input: 'paths:\n  /a:\n    get:\n      s: 1\n  /b:\n    get:\n      s: 2\n',
    expect: 0,
  },
  {
    name: 'quoted and bare spellings of one key in one mapping',
    input: 'a:\n  "b": 1\n  b: 2\n',
    expect: 1,
  },
]

/** What `judge` returns for a file: the findings, or a refusal. */
export function judge(text) {
  try {
    return { duplicates: duplicateKeys(text), refused: null }
  } catch (error) {
    return { duplicates: [], refused: error.message }
  }
}

export function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => c.expect))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const { duplicates, refused } = judge(canary.input)
    const got = refused ? 1 : duplicates.length > 0 ? 1 : 0
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}${refused ? ` (refused: ${refused})` : ''}`)
  }
  // A refusal is a *finding* in the run below but must not be read as a
  // duplicate here, or a reader that refuses everything would pass every
  // canary whose expectation is 1. The refusal path is exercised directly.
  const refused = judge('a:\n  &anchor b: 1\n')
  if (refused.refused === null) {
    console.log('FAIL an unmodelled construct was not refused')
    failed += 1
  } else {
    console.log('ok   refuses an unmodelled construct rather than reading it wrongly')
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())

  // Every YAML file the repository ships, walked rather than listed: a gate
  // scoped to the one file whose defect was found is a gate for that defect.
  const SKIP = new Set(['node_modules', '.git', '.claude', 'coverage'])
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.ya?ml$/.test(entry.name)) files.push(full)
    }
  }
  walk(ROOT)

  let failures = 0
  let scanned = 0
  for (const file of files.sort()) {
    const rel = path.relative(ROOT, file)
    const { duplicates, refused } = judge(fs.readFileSync(file, 'utf8'))
    scanned += 1
    if (refused) {
      failures += 1
      console.log(`\n  [refused] ${rel}: ${refused}`)
      console.log('    the reader does not model this construct. Extend it rather than skipping the file —')
      console.log('    a file it cannot finish reading is a file it cannot clear.')
      continue
    }
    for (const d of duplicates) {
      failures += 1
      console.log(`\n  [duplicate] ${rel}:${d.line} key "${d.key}" is declared again (first at line ${d.first})`)
      console.log('    YAML keeps the last, so the earlier one is dead text that reads as documentation.')
    }
  }

  if (failures === 0) {
    console.log(`yaml duplicate keys: clean — ${scanned} file(s), none declaring a key twice`)
    process.exit(0)
  }
  console.log(`\nyaml duplicate keys: ${failures} finding(s) across ${scanned} file(s)`)
  process.exit(1)
}
