#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The citation-rot guard.
 *
 * The audit register cites code by `path:line`. That is a claim about the tree,
 * and the tree moves — the ENH-60 extraction alone took `src/server.js` from
 * 5,603 lines to 2,133, and every line number below a moved family shifted.
 * ARC-08's citations were rewritten to fresh numbers on 2026-10-11 and **rotted
 * again within a day**; ARC-01's counts were stale by a factor of seven. Nothing
 * checked them, which is why it recurred.
 *
 * **The scope, and why it is this narrow.** A line number can fail in two ways:
 *
 *   1. **past EOF** — the file is now shorter than the cited line, so the
 *      citation names nothing at all. This is unambiguously a defect: the number
 *      cannot be right, whatever the entry says.
 *   2. **in bounds, wrong line** — the number resolves, but to different code.
 *
 * Only (1) is checked. (2) is real — 24 of the register's 25 quoted snippets sit
 * away from their cited line — but most of them are *correctly* stale: an entry
 * documenting a defect fixed on 2026-10-10 quotes the code as it was, and the
 * fix moved it. Flagging those would fire on entries that are right, and a gate
 * that cannot be satisfied for correct input is a gate that gets turned off —
 * the failure mode this repository has catalogued more than once. Detecting (2)
 * needs a judgement about whether a citation is live or historical, and that
 * judgement is the author's to make, so the gate leaves it there.
 *
 * **The escape hatch.** An entry that *means* to quote a stale number — ARC-08
 * does exactly this, printing `src/server.js:234, 490, 839, 861, 2424, 4344`
 * to show what it first read in a file that was then 2,366 lines — says so with
 * `line-drift-ok:` on the line or the one above. The marker is the point: it
 * turns a silent stale citation into a line a reviewer sees and agrees with.
 *
 * Exit 0 when clean, 1 with the citations listed. Canaried in `--self-test`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The register. Scoped to it: prose elsewhere quotes history freely. */
const DOC_DIR = 'docs/improvements/audit-2026-10'

/**
 * Citations are `path:NNN` inside backticks, and one backtick may hold a run of
 * them (`src/server.js:4610, 4624, 4658`), or a following backtick may continue
 * the run with bare `:NNN, :NNN`. Both forms are read, so a run cannot hide a
 * past-EOF member behind a valid first one.
 */
const RUN = /([\w./-]+\.(?:js|mjs)):(\d+(?:\s*,\s*:?\d+)*)/g
const CONTINUATION = /`:(\d+(?:\s*,\s*:?\d+)*)`/g

/** A citation the author has declared historical. Same line or the one above. */
const DRIFT_OK = /line-drift-ok:/

const lineCountCache = new Map()
function lineCount(rel) {
  if (!lineCountCache.has(rel)) {
    const abs = path.join(ROOT, rel)
    let count = null
    try {
      const text = fs.readFileSync(abs, 'utf8')
      // `wc -l` semantics: a trailing newline terminates the last line rather
      // than starting an empty one, so `a\nb\n` is two lines, not three.
      count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    } catch {
      count = null
    }
    lineCountCache.set(rel, count)
  }
  return lineCountCache.get(rel)
}

/**
 * Scan one document's text. Returns findings `{line, file, cited, eof}`.
 *
 * The marker window is the line and the line above it, because a citation run
 * that wraps can put the marker on the preceding line and the numbers on the
 * next.
 */
export function scanText(text, { doc = '<memory>' } = {}) {
  const lines = text.split('\n')
  const findings = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (DRIFT_OK.test(line) || (i > 0 && DRIFT_OK.test(lines[i - 1]))) continue
    const cited = []
    let file = null
    for (const m of line.matchAll(RUN)) {
      file = m[1]
      for (const n of m[2].split(/\s*,\s*:?/)) cited.push([file, Number(n)])
    }
    // A continuation backtick (`:4610, 4624`) belongs to the file named by the
    // run before it, which is how the register writes a multi-line citation.
    if (file) {
      for (const m of line.matchAll(CONTINUATION)) {
        for (const n of m[1].split(/\s*,\s*:?/)) cited.push([file, Number(n)])
      }
    }
    for (const [file, num] of cited) {
      const eof = lineCount(file)
      if (eof === null) {
        findings.push({ line: i + 1, doc, file, cited: num, eof: null })
      } else if (num > eof) {
        findings.push({ line: i + 1, doc, file, cited: num, eof })
      }
    }
  }
  return findings
}

export function scanTree(root = ROOT) {
  const dir = path.join(root, DOC_DIR)
  const findings = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    findings.push(...scanText(text, { doc: `${DOC_DIR}/${name}` }))
  }
  return findings
}

/**
 * Canaries. Each is a document fragment whose expected finding count is fixed,
 * so a scanner that returns a constant fails at least one.
 */
export const CANARIES = [
  {
    name: 'a live citation in bounds is clean',
    source: 'the handler (`src/server.js:100`) reads it.',
    expect: 0,
  },
  {
    name: 'a citation past EOF is a finding',
    source: 'the fetch (`src/server.js:999999`).',
    expect: 1,
  },
  {
    name: 'a sibling run hides a past-EOF member',
    source: 'cited at `src/server.js:100, 200, 999999`.',
    expect: 1,
  },
  {
    name: 'a sibling run of live numbers is clean',
    source: 'cited at `src/server.js:100, 200, 300`.',
    expect: 0,
  },
  {
    name: 'the marker exempts a past-EOF citation on its own line',
    source: '// line-drift-ok: quoted as it was\nfirst read `src/server.js:999999`.',
    expect: 0,
  },
  {
    name: 'the marker exempts a past-EOF citation on the line above',
    source: 'line-drift-ok: historical\n`src/server.js:999999` and `:888888`.',
    expect: 0,
  },
  {
    name: 'a citation to a file that does not exist is a finding',
    source: 'see `src/not-a-real-module.js:12`.',
    expect: 1,
  },
  {
    name: 'a non-source backtick is ignored',
    source: 'the `absent-ok:` marker and `docs/readme.md:9` are not citations.',
    expect: 0,
  },
]

function selfTest() {
  let failed = 0
  for (const canary of CANARIES) {
    const got = scanText(canary.source).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  const real = scanTree(ROOT)
  console.log(`${real.length === 0 ? 'ok  ' : 'FAIL'} the register is clean — ${real.length} finding(s)`)
  if (real.length) failed += 1
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())
  const findings = scanTree(ROOT)
  if (findings.length === 0) {
    console.log('doc-citation check: clean')
    process.exit(0)
  }
  console.error(`doc-citation check: ${findings.length} citation(s) name a line that does not exist\n`)
  for (const f of findings) {
    const why = f.eof === null ? 'no such file' : `past EOF (${f.eof})`
    console.error(`  ${f.doc}:${f.line}  ${f.file}:${f.cited}  ${why}`)
  }
  console.error('\nA line number past EOF names nothing. Re-anchor it to the function that performs')
  console.error('the read (a name survives a refactor a line number does not), or mark the citation')
  console.error('`line-drift-ok: <reason>` when the entry means to quote it as it was.')
  process.exit(1)
}
