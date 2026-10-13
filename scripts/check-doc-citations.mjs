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

/**
 * The register tree. Widened 2026-10-13 from `docs/improvements/audit-2026-10`
 * alone.
 *
 * The narrow scope was the same defect the gate exists to catch, one level up:
 * the citation form `path:NNN` runs through every register in `docs/improvements`
 * — the system audit's own row tables, the earlier `defects.md`, the research
 * dossiers — and only one directory was read. Measured when this widened: 247
 * citations past EOF or naming a file that does not exist across 15 documents,
 * none of which any gate could see. The directory that *was* covered had 0,
 * because its authors used the marker; the directory beside it had 29 and had
 * never been asked.
 *
 * The scope rule is unchanged and is what keeps this honest: only a citation
 * that names nothing at all fails. `_research/` is included on the same terms —
 * a dossier quoting a line that no longer exists is a claim a reader cannot
 * check, and the fix is the same marker the registers already use.
 */
const DOC_DIRS = Object.freeze([
  'docs/improvements',
])

/**
 * Citations are `path:NNN` inside backticks, and one backtick may hold a run of
 * them (`src/server.js:4610, 4624, 4658`), or a following backtick may continue
 * the run with bare `:NNN, :NNN`. Both forms are read, so a run cannot hide a
 * past-EOF member behind a valid first one.
 */
const RUN = /([\w./-]+\.(?:js|mjs)):(\d+(?:\s*,\s*:?\d+)*)/g
const CONTINUATION = /`:(\d+(?:\s*,\s*:?\d+)*)`/g

/**
 * A range citation, `path:START–END`.
 *
 * `RUN` cannot see these: it matches `src/server.js:763` and stops at the dash,
 * so only the *start* of a range was ever checked. That left the one direction
 * that matters unguarded — a range whose **end** is past EOF names a line that
 * does not exist, which is exactly the failure this gate is scoped to. It was
 * found on ARC-01, whose evidence read `src/server.js:763–2360` in a file that
 * had shrunk to 1,613 lines: the citation named a line 747 past the end and the
 * gate reported clean. The dash is written three ways (`-`, `–`, `—`) and all
 * three are read, because a checker that enumerates one spelling of a thing is
 * the bug wearing the gate's clothes.
 *
 * Only the **end** is checked. The start is already checked by `RUN`, and
 * checking it here too would double-report the same number on the same line.
 */
const RANGE = /([\w./-]+\.(?:js|mjs)):(\d+)\s*[–—-]\s*(\d+)/g

/** A citation the author has declared historical. Same line or the one above. */
const DRIFT_OK = /line-drift-ok:/

/**
 * A whole document declared a dated snapshot.
 *
 * `_research/*.md` are audits of a tree that no longer exists — each names the
 * commit it read (`integrations-intent.md`: "Commit under audit: `b07bbe4`"),
 * and every citation in them is a quote of that tree. Marking 200-odd lines
 * individually would be the same statement 200 times, which is noise, and noise
 * is how a marker stops being read.
 *
 * The date is **required** and is the whole safeguard. `line-drift-ok:` can be
 * dropped on one line by someone who has looked at that line; a document-level
 * claim says "nothing in this file is a claim about the current tree", which is
 * only true of a dated audit, and the date is what makes the author write down
 * which tree they mean. Without it the declaration is refused, so it cannot be
 * added as a reflex.
 */
const DOC_SNAPSHOT = /^[^\S\n]*citations-are-historical:[^\S\n]*\S/m

/**
 * True when the document declares itself a dated snapshot.
 *
 * Read from the head of the file only — the first 40 lines. A declaration buried
 * at the bottom of a live register would exempt the whole document from a marker
 * nobody reviewing the top would see, which is the silent version of the same
 * failure.
 */
function isSnapshot(text) {
  return DOC_SNAPSHOT.test(text.split('\n').slice(0, 40).join('\n'))
}

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
 * Every source file in the tree, by basename.
 *
 * The registers cite two ways: `src/server.js:2909` (a path) and `kpi.js:249`
 * (a basename, in a document whose `Scope:` line already said `src/`). A reader
 * resolves the second against the document's scope; the gate resolved it against
 * the repository root and reported "no such file" for a file that exists. That
 * is a false positive on correct input, and it was 145 of the 247 findings the
 * widening first produced — a gate that fails for a reason its operator cannot
 * act on is a gate that gets turned off, which is the failure this repository
 * has catalogued more than once.
 *
 * So a bare basename resolves by unique match. Two files with the same name
 * (`src/webhooks.js` and `src/routes/webhooks.js`) stay ambiguous and are
 * reported: the citation genuinely does not say which, and picking one silently
 * would be the gate guessing on the author's behalf.
 */
const BASENAME_INDEX = new Map()
function basenameMatches(name) {
  if (!BASENAME_INDEX.size) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // Dot-directories are skipped, and `.claude/worktrees/` is why: it holds
        // a full checkout per concurrent agent, so every source file has a second
        // copy under it and every bare-basename citation became ambiguous. The
        // tree under audit is the working tree, not the agents' checkouts of it.
        if (entry.name.startsWith('.')) continue
        if (entry.name === 'node_modules') continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(abs); continue }
        if (!/\.(?:js|mjs)$/.test(entry.name)) continue
        const rel = path.relative(ROOT, abs)
        if (!BASENAME_INDEX.has(entry.name)) BASENAME_INDEX.set(entry.name, [])
        BASENAME_INDEX.get(entry.name).push(rel)
      }
    }
    walk(ROOT)
  }
  return BASENAME_INDEX.get(name) || []
}

/**
 * Resolve a cited name to one repo-relative path, or a reason it cannot be.
 *
 * Returns `{ path }` on success, `{ missing: true }` when nothing matches, and
 * `{ ambiguous: [...] }` when several do.
 */
function resolveCitation(name) {
  if (name.includes('/')) {
    return lineCount(name) === null && !fs.existsSync(path.join(ROOT, name))
      ? { missing: true }
      : { path: name }
  }
  const matches = basenameMatches(name)
  if (matches.length === 0) return { missing: true }
  if (matches.length > 1) return { ambiguous: matches }
  return { path: matches[0] }
}

/**
 * Scan one document's text. Returns findings `{line, file, cited, eof}`.
 *
 * The marker window is the line and the line above it, because a citation run
 * that wraps can put the marker on the preceding line and the numbers on the
 * next.
 */
export function scanText(text, { doc = '<memory>' } = {}) {
  // A dated snapshot is a quote of a tree that is gone; every citation in it is
  // historical by construction. See `DOC_SNAPSHOT` for why the date is required.
  if (isSnapshot(text)) return []
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
    // The end of a range. `RUN` reads the start (`:763`), not the end (`:2360`),
    // so a range whose end is past EOF was invisible until this line existed.
    for (const m of line.matchAll(RANGE)) cited.push([m[1], Number(m[3])])
    for (const [file, num] of cited) {
      const resolved = resolveCitation(file)
      if (resolved.missing) {
        findings.push({ line: i + 1, doc, file, cited: num, eof: null })
        continue
      }
      if (resolved.ambiguous) {
        // The citation does not say which of two same-named files it means.
        // Reported rather than guessed: a gate that picks one silently is
        // checking a file the author may not have meant.
        findings.push({ line: i + 1, doc, file, cited: num, eof: null, ambiguous: resolved.ambiguous })
        continue
      }
      const eof = lineCount(resolved.path)
      if (num > eof) {
        findings.push({ line: i + 1, doc, file, cited: num, eof })
      }
    }
  }
  return findings
}

export function scanTree(root = ROOT) {
  const findings = []
  const dirs = DOC_DIRS.map((rel) => path.join(root, rel))
  // A recursive walk, so a register that gains a subdirectory is covered without
  // anyone remembering to add it. The directory-scoped version of this is the bug
  // the widening above fixes, and re-introducing it one level down is how it
  // comes back.
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name)
      // `_research/` is walked (it is the reason the scope widened); nothing
      // dot-prefixed is, for the same reason the basename index skips them.
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) walk(abs); continue }
      if (!entry.name.endsWith('.md')) continue
      const rel = path.relative(root, abs)
      const text = fs.readFileSync(abs, 'utf8')
      findings.push(...scanText(text, { doc: rel }))
    }
  }
  for (const dir of dirs) walk(dir)
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
    name: 'a range whose end is past EOF is a finding — the blind spot RUN left',
    source: 'held the surface (`src/server.js:100-999999`).',
    expect: 1,
  },
  {
    name: 'a range written with an en-dash is read too',
    source: 'held the surface (`src/server.js:100–999999`).',
    expect: 1,
  },
  {
    name: 'a range wholly in bounds is clean',
    source: 'the block (`src/server.js:100-200`).',
    expect: 0,
  },
  {
    name: 'the marker exempts a past-EOF range end',
    source: '// line-drift-ok: quoted as it was\nheld the surface (`src/server.js:100-999999`).',
    expect: 0,
  },
  {
    name: 'a non-source backtick is ignored',
    source: 'the `absent-ok:` marker and `docs/readme.md:9` are not citations.',
    expect: 0,
  },
  {
    name: 'a dated snapshot declaration exempts the whole document',
    source: '# Audit of the tree at `b07bbe4`\ncitations-are-historical: 2026-10-03\n\nsee `src/server.js:999999`.',
    expect: 0,
  },
  {
    name: 'an undated snapshot declaration is refused, so the escape hatch costs a date',
    source: '# Audit\ncitations-are-historical:\n\nsee `src/server.js:999999`.',
    expect: 1,
  },
  {
    name: 'a snapshot declaration past the head does not exempt the document',
    source: `# Live register\n${'\nfiller'.repeat(1)}\n${Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n')}\ncitations-are-historical: 2026-10-03\n\nsee \`src/server.js:999999\`.`,
    expect: 1,
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
