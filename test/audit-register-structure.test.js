#!/usr/bin/env node
/**
 * The audit register's own structure, guarded.
 *
 * `docs/improvements/audit-2026-10/defects.md` is the record of what was found
 * and what is fixed, and nothing checked its shape. That is how a defect entry
 * can vanish without a single test going red: while inserting the VER-17 entry
 * on 2026-10-12, the `### ARC-02 — …` heading was replaced rather than preceded,
 * so ARC-02's body was silently absorbed into VER-17 and the README went on
 * advertising `ARC-01 .. ARC-12` with eleven headings. The commit that did it
 * was green — 4,323 tests, sixteen gates — because no check reads the register
 * as a document rather than as prose.
 *
 * This is the same failure the register itself catalogues: a table that is
 * hand-kept and cross-checked by nothing drifts, and the drift is invisible
 * precisely because it looks like a clean result. The checks below are the
 * cheapest ones that would have caught it:
 *
 *   - every id range the README declares matches the ids the register holds, in
 *     both directions — a missing entry and an undeclared one are different
 *     bugs and both are caught;
 *   - no id appears twice, so a heading cannot be duplicated by a bad paste;
 *   - every entry has a body, so a heading is not left stranded at the end of a
 *     section or followed by another heading;
 *   - the totals the README states are the totals the file has.
 *
 * Deliberately not checked: prose, ordering, severity, or whether a "Fixed"
 * entry is actually fixed. Those need a reader. This checks the skeleton, which
 * is the part a machine can hold honest.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const README = readFileSync(new URL('../docs/improvements/audit-2026-10/README.md', import.meta.url), 'utf8')
const DEFECTS = readFileSync(new URL('../docs/improvements/audit-2026-10/defects.md', import.meta.url), 'utf8')
const ENHANCEMENTS = readFileSync(new URL('../docs/improvements/audit-2026-10/enhancements-50.md', import.meta.url), 'utf8')

/** Every `### PREFIX-NN — …` heading, in file order. */
function entryIds(text) {
  return [...text.matchAll(/^### ([A-Z]{3})-(\d{2,3})\b/gm)].map((m) => ({ prefix: m[1], id: `${m[1]}-${m[2]}` }))
}

const ENTRIES = entryIds(DEFECTS)

/**
 * The id ranges the README's disjointness table declares, by prefix.
 *
 * `ENH` is skipped: the table lists it beside the defect prefixes because it
 * describes what this audit covers, but the enhancements live in
 * `enhancements-50.md` and checking them against `defects.md` would report
 * every enhancement as deleted. The defect prefixes are the ones with a
 * `### PREFIX-NN` heading in this file.
 */
function declaredRanges(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const row = /^\| [^|]+ \| `([A-Z]{3})-(\d{2}) \.\. \1-(\d{2})`/.exec(line)
    if (row && row[1] !== 'ENH') out.set(row[1], { lo: Number(row[2]), hi: Number(row[3]) })
  }
  return out
}

const DECLARED = declaredRanges(README)

/**
 * The enhancement verdict table's three rows, keyed by verdict.
 *
 * `| IMPLEMENTED | 51 | 31, 32, … |` — the count and the item list, as written.
 * Two readers use it: the partition check below, and the entry-verdict check
 * that compares a row against the note under the item it names.
 */
function verdictRows(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const row = /^\| (IMPLEMENTED|PARTIAL|ABSENT) \| (\d+) \| (.+) \|$/.exec(line)
    if (row) out.set(row[1], { count: Number(row[2]), items: row[3].trim() })
  }
  return out
}

describe('the audit register’s skeleton, guarded', () => {
  it('parsed both documents, so a passing run is not a run over nothing', () => {
    // The canary-in-reverse: a guard that reads zero entries passes every
    // assertion below it. `defects.md` holds 74 headings today; a regex that
    // stopped matching would make this file green forever.
    assert.ok(ENTRIES.length > 60, `parsed ${ENTRIES.length} entries, which is not the register`)
    assert.ok(DECLARED.size >= 8, `parsed ${DECLARED.size} declared ranges, which is not the README table`)
  })

  it('every id range the README declares is the range the register holds', () => {
    // Both directions. A missing entry is the ARC-02 bug; an entry beyond the
    // declared maximum is the QUA-08 drift. One assertion, two defects.
    const problems = []
    for (const [prefix, { lo, hi }] of DECLARED) {
      const ids = ENTRIES.filter((entry) => entry.prefix === prefix).map((entry) => Number(entry.id.split('-')[1]))
      if (!ids.length) { problems.push(`${prefix}: declared \`${prefix}-${lo} .. ${prefix}-${hi}\` but the register has no ${prefix} entry`); continue }
      const have = new Set(ids)
      for (let n = lo; n <= hi; n += 1) {
        if (!have.has(n)) problems.push(`${prefix}-${String(n).padStart(2, '0')} is declared in the README and absent from defects.md — the heading was deleted or replaced`)
      }
      const beyond = ids.filter((n) => n > hi).sort((a, b) => a - b)
      if (beyond.length) problems.push(`${prefix}: the register holds ${beyond.map((n) => `${prefix}-${String(n).padStart(2, '0')}`).join(', ')} and the README declares only up to ${prefix}-${String(hi).padStart(2, '0')}`)
    }
    assert.deepEqual(problems, [], problems.join('\n'))
  })

  it('no id appears twice, so a bad paste cannot duplicate a heading', () => {
    const seen = new Map()
    const dupes = []
    for (const { id } of ENTRIES) {
      if (seen.has(id)) dupes.push(id)
      seen.set(id, true)
    }
    assert.deepEqual(dupes, [], `these ids appear more than once: ${dupes.join(', ')}`)
  })

  it('every entry has a body, so no heading is stranded', () => {
    // A heading with nothing under it — or followed immediately by another
    // heading — is what a bad edit leaves behind. The ARC-02 deletion did not
    // produce this shape (its body survived under the wrong heading), but a
    // heading-only paste does, and it is the same class.
    const stranded = []
    const lines = DEFECTS.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^### [A-Z]{3}-\d{2,3}\b/.test(lines[i])) continue
      const next = lines.slice(i + 1).find((line) => line.trim().length)
      if (!next || /^### /.test(next)) stranded.push(lines[i].replace(/^### /, '').slice(0, 60))
    }
    assert.deepEqual(stranded, [], `these entries have no body: ${stranded.join(' | ')}`)
  })

  it('every entry heading carries a severity, so it can be ranked', () => {
    // `### VER-17 — MEDIUM — …`. A heading without one is an entry the
    // severity-sorted reader silently drops.
    const bad = [...DEFECTS.matchAll(/^### ([A-Z]{3}-\d{2,3})(.*)$/gm)]
      .filter(([, , rest]) => !/—\s*(CRITICAL|HIGH|MEDIUM|LOW)\b/.test(rest))
      .map(([, id]) => id)
    assert.deepEqual(bad, [], `these entries state no severity: ${bad.join(', ')}`)
  })

  it('the totals the README states are the totals the register has', () => {
    // The audit commit (`4de61ed`) holds **68** entries, and that is the number
    // the README states, so the invariant is `total = 68 + (late finds the README
    // claims)`. Anchoring on the audit's own count rather than on a provenance
    // phrase is deliberate: the register's prose is inconsistent about which
    // entries are late — `VER-16` landed after the audit but carries no "not by
    // the audit" marker, while the README groups `VER-13..VER-17` as late — so a
    // phrase-based split is an instrument that reports the prose, not the fact.
    // The total is the fact, and it is the one a deleted heading moves.
    const AUDIT_ENTRIES = 68
    // The line wraps in the source, so the match spans whitespace on both sides
    // of the number.
    const stated = /sixty-eight defects across eight domains,\s+(\w+)\s+more found since/i.exec(README)
    assert.ok(stated, 'the README no longer states a total, so this check has nothing to compare against')
    // Spelled out rather than parsed, because the README states the count in
    // words. It stopped at `ten` and the register reached twelve, at which point
    // this check could no longer read its own README and failed on a correct
    // total — a jurisdiction limit in the instrument, not a defect in the
    // register. Twenty is the ceiling a reader would still accept as prose; past
    // that the README should state a numeral and this map should be deleted
    // rather than grown.
    const words = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
      eighteen: 18, nineteen: 19, twenty: 20,
    }
    const claimedLate = words[stated[1].toLowerCase()]
    assert.ok(claimedLate, `the README states "${stated[1]}" late finds, which is not a number this check can read`)
    assert.equal(ENTRIES.length, AUDIT_ENTRIES + claimedLate,
      `the register holds ${ENTRIES.length} entries; the README's 68 from the audit plus ${claimedLate} late find(s) is ${AUDIT_ENTRIES + claimedLate}. A heading was deleted, duplicated, or added without the total being updated.`)
  })

  it('the enhancements verdict table partitions ENH-31..ENH-81 exactly once each', () => {
    // The sibling skeleton, in the other document. `enhancements-50.md` keeps
    // its verdicts in a three-row table — IMPLEMENTED / PARTIAL / ABSENT, each
    // naming its item numbers — and nothing checked it. It is hand-kept in
    // exactly the way the defects register was, so it drifts in exactly the same
    // way: an item moved from PARTIAL to IMPLEMENTED without leaving the PARTIAL
    // row appears in two rows, and one added without a row appears in none.
    //
    // The scope is `ENH-31..ENH-81`, which is 51 items. The document's own title
    // says "fifty" and its ranges say `ENH-31..ENH-80`; the extra one is ENH-81,
    // which the file lists. The count is taken from the table rather than from
    // the prose for that reason — the prose is what drifted.
    const rows = verdictRows(ENHANCEMENTS)
    assert.equal(rows.size, 3, `parsed ${rows.size} verdict rows; the table has three`)

    // `none` is the ABSENT row's spelling of an empty set. It is asserted
    // rather than tolerated, because "none" with a non-zero count is a row that
    // contradicts itself.
    const listed = new Map()
    const problems = []
    for (const [verdict, { count, items }] of rows) {
      const ids = items === 'none'
        ? []
        : items.split(',').map((part) => part.trim()).filter(Boolean).map(Number)
      if (ids.some((n) => !Number.isInteger(n))) problems.push(`${verdict}: the item list is not all numbers — ${items}`)
      if (ids.length !== count) problems.push(`${verdict}: the row states ${count} and lists ${ids.length} (${items})`)
      for (const n of ids) {
        if (listed.has(n)) problems.push(`ENH-${n} is listed under both ${listed.get(n)} and ${verdict}`)
        listed.set(n, verdict)
      }
    }

    // Every id in the document's scope appears exactly once. The scope is read
    // from the IMPLEMENTED row's own maximum and minimum, which is circular for
    // a missing id at either end — so the floor is pinned to the audit's stated
    // range and only the ceiling is read from the table.
    const numbers = [...listed.keys()].sort((a, b) => a - b)
    const lo = 31
    const hi = Math.max(...numbers)
    for (let n = lo; n <= hi; n += 1) {
      if (!listed.has(n)) problems.push(`ENH-${n} is in no verdict row — the range is ${lo}..${hi} and it is missing`)
    }
    assert.deepEqual(problems, [], problems.join('\n'))

    // And the header sentence must agree with the rows it summarises, because
    // that sentence is what a reader quotes without scrolling to the table.
    const header = /of 51\.|(\d+) shipped, (\d+) partial, (\d+) not started/i.exec(ENHANCEMENTS)
    if (header && header[1]) {
      const [, shipped, partial, notStarted] = header
      assert.equal(Number(shipped), rows.get('IMPLEMENTED').count, 'the header’s shipped count is not the IMPLEMENTED row’s')
      assert.equal(Number(partial), rows.get('PARTIAL').count, 'the header’s partial count is not the PARTIAL row’s')
      assert.equal(Number(notStarted), rows.get('ABSENT').count, 'the header’s not-started count is not the ABSENT row’s')
    }
  })

  it('an entry’s own last verdict agrees with the row the table puts it in', () => {
    // The table above is guarded against itself — partitions, counts, header —
    // and the per-item note beneath it was guarded against nothing. ENH-60 is
    // the case: `be2f4d3` moved it to IMPLEMENTED in the table and closed the
    // entry in prose, but the last bold span in the entry still opens "PARTIAL
    // — 2026-10-12", so a reader who scrolled to the item read the opposite of
    // the row summarising it, for four days. ENH-59 had the same shape and was
    // caught by hand on 2026-10-15; nothing caught ENH-60.
    //
    // The reading rule, which is what makes this checkable at all: the verdict
    // is the *last* bold span in the entry that names one, because the notes are
    // append-only and each supersedes the one above it. A closure word wins over
    // `PARTIAL` inside the same span, because the register's own idiom for a
    // corrected entry is "IMPLEMENTED, mis-marked PARTIAL until <date>" — the
    // span names both and only one is the current state. A span with neither is
    // a paragraph heading and is skipped.
    const CLOSED = /\b(IMPLEMENTED|Shipped|shipped|Fixed|closed|Closed|complete|Complete|done|Done|Wired|Served)\b/
    const OPEN = /\b(PARTIAL|ABSENT)\b/

    const starts = []
    ENHANCEMENTS.split('\n').forEach((line, i) => {
      const m = /^\*\*ENH-(\d+) — /.exec(line)
      if (m) starts.push({ n: Number(m[1]), i })
    })
    starts.push({ n: null, i: Infinity })
    assert.ok(starts.length > 45, `parsed ${starts.length - 1} entries; the heading regex stopped matching`)

    const verdictOf = new Map()
    for (const [verdict, { items }] of verdictRows(ENHANCEMENTS)) {
      if (items === 'none') continue
      for (const part of items.split(',')) verdictOf.set(Number(part.trim()), verdict)
    }

    const lines = ENHANCEMENTS.split('\n')
    const disagreements = []
    const silent = []
    for (let k = 0; k < starts.length - 1; k += 1) {
      const { n } = starts[k]
      const body = lines.slice(starts[k].i, starts[k + 1].i).join('\n')
      let last = null
      for (const span of body.matchAll(/\*\*([\s\S]{0,400}?)\*\*/g)) {
        if (CLOSED.test(span[1])) last = 'CLOSED'
        else if (OPEN.test(span[1])) last = 'OPEN'
      }
      // An entry this check cannot read a verdict out of is *reported*, not
      // skipped. Skipping is how the check fails open: narrowing `CLOSED` — drop
      // one word and every entry closed with it becomes invisible — leaves the
      // assertion with nothing to compare and a green run. Every entry states a
      // verdict today (51 of 51), so "I read none" is a fact about the reader.
      // Canaried by deleting `Fixed` from `CLOSED`: this list is what fails.
      if (!last) { silent.push(`ENH-${n}`); continue }
      const row = verdictOf.get(n)
      if (row === 'IMPLEMENTED' && last === 'OPEN') {
        disagreements.push(`ENH-${n}: the table says IMPLEMENTED, the entry’s last verdict still reads open`)
      }
    }
    assert.deepEqual(silent, [],
      `no verdict could be read from ${silent.length} entr${silent.length === 1 ? 'y' : 'ies'}: ${silent.join(', ')}. `
      + 'Each entry states one; a blank here means this check’s vocabulary missed it, and a check '
      + 'that reads nothing agrees with everything.')
    assert.deepEqual(disagreements, [],
      `${disagreements.join('\n')}\n`
      + 'Append the closure to the entry in the word the table uses — the notes are append-only, '
      + 'so a later note supersedes the "PARTIAL" heading rather than editing it.')
  })
})

/**
 * The two enhancement registers, read as documents.
 *
 * `docs/improvements/enhancements.md` numbers `ENH-01..ENH-30` and
 * `docs/improvements/system-audit/02-enhancements.md` numbers
 * `ENH-01..ENH-50`. They are separate registers that both use the id space
 * `ENH-nn`, so **every one of the 30 shared ids means two different things**:
 * `ENH-01` is "Deny-by-default authorization" in one and "The field app works
 * for a week offline" in the other, and so on for all thirty.
 *
 * The cost is not cosmetic, and the size of it is measured below rather than
 * stated here — see `citationSpread()`. At the last measurement there were
 * **1,928** `ENH-nn` citations across **350** files, **343** of them in `src/`
 * comment lines — so a reader following `// ENH-29` from a source file has a 50%
 * chance of landing on the wrong item, and `docs/improvements/status.md`
 * resolves every id against the *first* register. This is the same shape the
 * file's own header catalogues: a hand-kept table that nothing cross-checks
 * drifts, and the drift looks like a clean result.
 *
 * That paragraph used to say "1,855 citations across 338 files, 100 of them in
 * `src/` comments", and it closed by claiming "the numbers above are asserted".
 * They were not — only the collision counts were — and they had already rotted
 * when they were written. Measured at the commit that added them (`41ff308`,
 * 2026-10-15, in a temp worktree): 1,872 citations, 338 files, **336** in `src/`
 * comments. So the file count was right, the total was low by 17, and the
 * `src/` figure was wrong by a factor of 3.4 — it named a tenth of the real
 * cost in the sentence arguing that the cost was large. `citationSpread()` now
 * derives all three, so they cannot be typed wrong again.
 *
 * The figures moved by 7 citations, 3 files and 4 `src/` comments when the
 * rate-limit budget landed, which is the mechanism working: the number is held
 * to the tree by a test, so a change that adds citations to the register's own
 * subject updates it in the same commit rather than leaving a stale count
 * behind.
 *
 * The check below does not fix the collision — renaming 50 ids across ~1,900
 * citations is a change with its own review, and doing it inside a defect fix
 * would bury it. What it does is make the collision *measured* rather than
 * discovered, and hold the scale of it to the tree rather than to a memory.
 */
describe('the two enhancement registers do not share an id space', () => {
  const FIRST = readFileSync(new URL('../docs/improvements/enhancements.md', import.meta.url), 'utf8')
  const SECOND = readFileSync(new URL('../docs/improvements/system-audit/02-enhancements.md', import.meta.url), 'utf8')

  /** id -> title, for `### ENH-NN — Title`. */
  function titled(text) {
    return new Map([...text.matchAll(/^### (ENH-\d+) — (.+)$/gm)].map((m) => [m[1], m[2].trim()]))
  }

  it('parsed both registers, so a passing run is not a run over nothing', () => {
    const a = titled(FIRST)
    const b = titled(SECOND)
    assert.ok(a.size >= 25, `parsed ${a.size} ids from enhancements.md, which is not the register`)
    assert.ok(b.size >= 45, `parsed ${b.size} ids from 02-enhancements.md, which is not the register`)
  })

  it('records how many ids the two registers share, and that each means two things', () => {
    const a = titled(FIRST)
    const b = titled(SECOND)
    const shared = [...a.keys()].filter((id) => b.has(id))
    const ambiguous = shared.filter((id) => a.get(id) !== b.get(id))

    // The collision itself. Asserted as a floor rather than an equality: if a
    // future change renames one register's ids the number drops, and this test
    // failing then is correct — it means the collision was addressed and this
    // note is stale. What it must not do is pass while the number is zero for
    // the wrong reason (a regex that stopped matching), which the parse check
    // above covers.
    assert.ok(
      shared.length >= 25,
      `the registers share only ${shared.length} ids — if the collision was fixed, update this note rather than the count`,
    )
    assert.equal(
      ambiguous.length,
      shared.length,
      `${shared.length - ambiguous.length} shared id(s) now agree on meaning; the collision is partial rather than total`,
    )
  })

  it('names the collision where a reader following an id will look', () => {
    // The note is the deliverable: a reader who hits `ENH-29` in a source
    // comment has to be able to find out it is ambiguous. A silent test that
    // only fails on a change does not help them.
    for (const [file, text] of [['enhancements.md', FIRST], ['system-audit/02-enhancements.md', SECOND]]) {
      assert.match(
        text,
        /ENH-nn|id space|collide|collision/i,
        `${file} does not warn that ENH ids are shared with the other register`,
      )
    }
  })

  it('the scale the note states is the scale the tree has', () => {
    // The header's paragraph quotes three numbers, and the version of it before
    // this case claimed they were asserted while asserting none of them — so
    // they rotted the moment the tree grew, which is the failure this whole file
    // exists to catch, reproduced inside the file itself.
    //
    // The assertion is deliberately loose on the total and exact on the shape.
    // The repository grows: a new file with one citation is normal and must not
    // fail a test. What must not pass silently is the note naming a *scale* the
    // tree has left behind — the `src/` figure was off by 3.4x, which is not
    // drift, it is a different number.
    const { total, files, srcComments } = citationSpread()
    assert.ok(total > 500, `counted ${total} ENH-nn citations — the walk or the regex is wrong, not the note`)
    assert.ok(files > 100, `counted citations in ${files} files — the walk is wrong`)

    // Read from this file's own source. The note is wrapped across lines with a
    // ` * ` prefix, so the pattern allows the comment's own asterisks between
    // the phrases — `\s+` alone does not cross them, and the first version of
    // this pattern failed on a note that was right there.
    const note = /At the last measurement there were[\s*]+\*\*([\d,]+)\*\* `ENH-nn` citations across[\s*]+\*\*([\d,]+)\*\* files,[\s*]+\*\*([\d,]+)\*\* of them in `src\/`/.exec(
      readFileSync(new URL(import.meta.url), 'utf8'),
    )
    assert.ok(note, 'the header note no longer states its counts in the form this check reads')

    const stated = { total: Number(note[1].replace(/,/g, '')), files: Number(note[2].replace(/,/g, '')), srcComments: Number(note[3].replace(/,/g, '')) }
    // Tight, and deliberately so. The first version allowed 10% slack and passed
    // a note that said 349 where the tree has 338 — the slack swallowed a wrong
    // number, which is the failure this case exists to prevent. `citationSpread()`
    // is deterministic (measured three times: 1,917 / 348 / 338 on each run), so
    // the note can be held to the exact figure. If the tree moves, the note moves
    // with it in the same commit; that is the point.
    for (const key of ['total', 'files', 'srcComments']) {
      const actual = { total, files, srcComments }[key]
      assert.equal(
        stated[key],
        actual,
        `the header note says ${key} = ${stated[key]}, the tree has ${actual}. `
        + 'Update the note — it is the sentence that tells a reader how much the collision costs.',
      )
    }
  })
})

/**
 * How far `ENH-nn` citations reach, measured rather than remembered.
 *
 * Counts every `ENH-nn` token in the repository, the files holding one, and the
 * ones that are in a `src/` comment — which is the figure that decides whether a
 * reader following an id from source code can be misled.
 *
 * `srcComments` is comment *lines* carrying at least one citation, not tokens:
 * a line is what a reader's eye lands on, and a block comment restating three
 * ids on one line is one place to be misled, not three. That definition is why
 * the number is 349 rather than the 376 raw tokens in `src/`.
 */
function citationSpread() {
  const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
  const SKIP = new Set(['.git', 'node_modules', '.claude', 'coverage'])
  const RE = /\bENH-\d+\b/g

  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p, out)
      else out.push(p)
    }
    return out
  }

  let total = 0
  let srcComments = 0
  const files = new Set()
  for (const file of walk(ROOT)) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    if (text.includes('\0')) continue
    const hits = text.match(RE)
    if (!hits) continue
    total += hits.length
    files.add(file)
    if (path.relative(ROOT, file).startsWith(`src${path.sep}`)) {
      for (const line of text.split('\n')) {
        if (RE.test(line) && /^\s*(\/\/|\*|\/\*)/.test(line)) srcComments += 1
        RE.lastIndex = 0
      }
    }
  }
  return { total, files: files.size, srcComments }
}
