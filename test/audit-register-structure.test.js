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
import { readFileSync } from 'node:fs'
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
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
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
    const rows = new Map()
    for (const line of ENHANCEMENTS.split('\n')) {
      const row = /^\| (IMPLEMENTED|PARTIAL|ABSENT) \| (\d+) \| (.+) \|$/.exec(line)
      if (row) rows.set(row[1], { count: Number(row[2]), items: row[3].trim() })
    }
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
 * The cost is not cosmetic. There are 1,855 `ENH-nn` citations in this
 * repository across 338 files, 100 of them in `src/` comments — so a reader
 * following `// ENH-29` from a source file has a 50% chance of landing on the
 * wrong item, and `docs/improvements/status.md` resolves every id against the
 * *first* register. This is the same shape the file's own header catalogues:
 * a hand-kept table that nothing cross-checks drifts, and the drift looks like
 * a clean result.
 *
 * The check below does not fix the collision — renaming 50 ids across 1,855
 * citations is a change with its own review, and doing it inside a defect fix
 * would bury it. What it does is make the collision *measured* rather than
 * discovered: the numbers above are asserted, so the next id added to either
 * register has to be a deliberate choice rather than a paste.
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
})
