import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * The improvement registers state their own totals, and nothing checked them.
 *
 * Four documents in `docs/improvements/` each carry a hand-kept count of what
 * they contain, and two of them restate each other's counts in
 * `README.md`. That is the same shape as every drift this register family
 * catalogues: a total maintained by hand beside a table maintained by hand,
 * cross-checked by nothing, so the two disagree in silence and both read as
 * verified.
 *
 * It was not hypothetical. At the time this check was written:
 *
 *   - `README.md` said `roadmap-extension.md` held **7 shipped, 13 partial**
 *     while the register's own footer and its table both said 13 and 7 — the
 *     two numbers transposed, so the index was wrong about the file it
 *     summarised;
 *   - `sources-and-decisions-roadmap.md` declared its groups as
 *     `DEC-01..09` and wrote **eight** DEC rows, and the `31 capability items`
 *     in `README.md` is the arithmetic of that declaration (11+9+6+4+1), not of
 *     the file. The register's own three lists — the "Verified against the
 *     tree" table, the "partly done" bullets, and the "genuinely unbuilt"
 *     enumeration — partition its rows exactly at **30**, with no item in two
 *     lists and none in none. So the file is complete and the declared range is
 *     the error.
 *
 * Each of those is invisible to every other check: `test/audit-register-structure.test.js`
 * guards `audit-2026-10/` only, and `test/enhancement-status.test.js` guards
 * `status.md` against its generator — which is the one document whose total is
 * *derived* rather than typed, and therefore the one that was already right.
 *
 * A third instance, found 2026-10-17: `sources-and-decisions-roadmap.md`'s
 * header and its `README.md` index row both said **7 shipped, 6 partly built**
 * where the tree has **6 complete, 7 partly built** — transposed, exactly the
 * error this header's first bullet records on `roadmap-extension.md`, in the
 * same family, a day later. The item-count check above passed throughout: it
 * reads `30 capability items` and the split was outside its jurisdiction, and
 * the register's split was outside every check's. Both statements are now
 * derived from the three lists and compared, and a `Now` cell the classifier
 * cannot read fails rather than being uncounted.
 *
 * What this checks is arithmetic over the tables, not their prose: a status
 * cell that says something other than shipped/partial/not-started fails rather
 * than being silently uncounted, because an unrecognised cell is how a count
 * goes wrong while every recognised one stays consistent.
 *
 * Deliberately not checked: whether a "shipped" row is actually shipped. That
 * needs a reader and is the registers' own business. This holds the skeleton.
 *
 * Also not checked: `defects.md`'s "Roughly 55 findings". It is hedged prose
 * rather than a derived total — the file carries 26 `###` headings and 68
 * distinct ids across three shapes (headings, severity-table rows, and
 * cross-references from other entries), so "55" cannot be reconciled against a
 * set the file actually defines. A check would have to pick one of those shapes
 * and would then be measuring its own choice. It stays a reader's judgement.
 *
 * That figure was 50 when this note was written and is 68 now, which is the
 * point rather than a defect in the note: the ids arrive from three directions
 * and the file does not declare which is the finding set, so no assertion can be
 * written that would not be about the reader's choice of shape. It is recorded
 * here because a stale number in a comment about not checking numbers is exactly
 * the thing this file exists to catch.
 */

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

const README = read('docs/improvements/README.md')

/**
 * Split a markdown table row into cells on unescaped pipes only.
 *
 * A naive `split('|')` is wrong here and was wrong while this check was being
 * written: `status.md`'s ENH-06 row carries the verdict `ok \| quiet \| stale
 * \| broken` inside a code span, and the escaped pipes cut that row into five
 * cells, so the status landed in the wrong column and the count came out
 * 29 shipped / 1 "quiet \". The table was fine; the reader was. This is the
 * same failure the register names elsewhere — a parser that recognises one of
 * the two ways to write the thing it parses.
 */
function cells(row) {
  return row.split(/(?<!\\)\|/).map((c) => c.trim())
}

/** `| 1 | name | **Shipped** — … |` rows, keyed by their leading number. */
function numberedRows(text) {
  return [...text.matchAll(/^\|\s*(\d+)\s*\|(.*)$/gm)].map((m) => ({ n: Number(m[1]), cells: cells(m[2]) }))
}

/**
 * The status token at the start of a cell.
 *
 * Two spellings, and both are real: `roadmap-extension.md` bolds its status and
 * writes `**Shipped** — evidence…`, while `status.md` is generated and emits a
 * bare lowercase `shipped` in its own column. A reader that knew only the bold
 * form reported all thirty status.md rows as unreadable — the register was
 * fine and the reader was wrong, which is the failure this file's `cells()`
 * note describes one layer up.
 */
const STATUS = /^\*{0,2}(Shipped|Partial|Rejected|Not started|shipped|partial|rejected|not started)\*{0,2}\b/

/** Canonical case for a matched token, so one count covers both spellings. */
const CANON = { shipped: 'Shipped', partial: 'Partial', rejected: 'Rejected', 'not started': 'Not started' }

function tally(rows, cellIndex) {
  const counts = { Shipped: 0, Partial: 0, Rejected: 0, 'Not started': 0 }
  const unrecognised = []
  for (const row of rows) {
    const cell = row.cells[cellIndex] || ''
    const token = STATUS.exec(cell)
    if (token) counts[CANON[token[1].toLowerCase()] || token[1]] += 1
    else unrecognised.push(`row ${row.n ?? row.id}: ${cell.slice(0, 60) || '(empty)'}`)
  }
  return { counts, unrecognised }
}

/** The counts a README index row states, e.g. "13 shipped, 7 partial, 0 rejected". */
function readmeCounts(docName, keys) {
  const row = README.split('\n').find((l) => l.includes(`](${docName})`))
  assert.ok(row, `docs/improvements/README.md has no index row for ${docName}`)
  const out = {}
  for (const key of keys) {
    const m = new RegExp(`(\\d+) ${key}`).exec(row)
    assert.ok(m, `the README row for ${docName} states no "${key}" count`)
    out[key] = Number(m[1])
  }
  return out
}

describe('the improvement registers state totals their tables agree with', () => {
  const ROADMAP = read('docs/improvements/roadmap-extension.md')
  const SOURCES = read('docs/improvements/sources-and-decisions-roadmap.md')
  const STATUS = read('docs/improvements/status.md')

  it('roadmap-extension: the table, its footer, and the README index state one count', () => {
    const rows = numberedRows(ROADMAP)
    assert.equal(rows.length, 20,
      `read ${rows.length} numbered rows from roadmap-extension.md — the register or this reader is wrong, not the count`)
    assert.deepEqual(rows.map((r) => r.n), Array.from({ length: 20 }, (_, i) => i + 1),
      'the item numbers are not 1..20 with no gap or repeat')

    const { counts, unrecognised } = tally(rows, 1)
    assert.deepEqual(unrecognised, [],
      `roadmap-extension rows whose status this check cannot read:\n  ${unrecognised.join('\n  ')}\n`
      + 'A status cell must begin with one of **Shipped** / **Partial** / **Rejected** / **Not started**, '
      + 'or it is silently uncounted while every recognised cell stays consistent.')

    const footer = /\*\*(\d+) shipped, (\d+) partial, (\d+) rejected\.\*\*/.exec(ROADMAP)
    assert.ok(footer, 'roadmap-extension.md states no "**N shipped, N partial, N rejected.**" footer')

    assert.deepEqual(
      { shipped: Number(footer[1]), partial: Number(footer[2]), rejected: Number(footer[3]) },
      { shipped: counts.Shipped, partial: counts.Partial, rejected: counts.Rejected },
      'the roadmap-extension footer disagrees with its own table')

    assert.deepEqual(
      readmeCounts('roadmap-extension.md', ['shipped', 'partial', 'rejected']),
      { shipped: counts.Shipped, partial: counts.Partial, rejected: counts.Rejected },
      'the README index row for roadmap-extension.md disagrees with the register it summarises')
  })

  it('sources-and-decisions: every declared id range matches the rows the register holds', () => {
    const present = [...SOURCES.matchAll(/^\| ((?:SRC|DEC|OPS|PLT|CC)-\d+) /gm)].map((m) => m[1])
    const distinct = new Set(present)

    // The group table's `| SRC-01..11 | Sources | … |` rows are the declaration.
    // A group of one is declared as a bare id — `| CC-01 | Cold chain | … |` —
    // so the range half is optional; requiring it reported CC-01 as a row no
    // group declares, which is a reader bug, not a register defect.
    const declared = [...SOURCES.matchAll(/^\| ((?:SRC|DEC|OPS|PLT|CC)-\d+)(?:\.\.(\d+))? \|/gm)]
      .map((m) => ({ prefix: m[1].split('-')[0], lo: Number(m[1].split('-')[1]), hi: m[2] ? Number(m[2]) : Number(m[1].split('-')[1]) }))
    assert.ok(declared.length >= 4,
      `read only ${declared.length} declared id ranges — the register or this reader is wrong`)

    const missing = []
    for (const { prefix, lo, hi } of declared) {
      for (let i = lo; i <= hi; i += 1) {
        const id = `${prefix}-${String(i).padStart(2, '0')}`
        if (!distinct.has(id)) missing.push(id)
      }
    }
    assert.deepEqual(missing, [],
      `the register declares ids it does not carry: ${missing.join(', ')}. `
      + 'Either write the row or narrow the declared range — a range is a claim about the file.')

    // And the converse: a row outside every declared range is an item no reader
    // was told to expect.
    const declaredPrefixes = new Set(declared.map((d) => d.prefix))
    for (const id of distinct) {
      assert.ok(declaredPrefixes.has(id.split('-')[0]),
        `${id} is in the register but no group row declares its prefix`)
    }
  })

  it('sources-and-decisions: the three status lists partition the rows exactly', () => {
    // The register sorts its items into three lists under "Verified against the
    // tree": the `Now` table, the "partly done" bullets, and the "Everything
    // else … is genuinely unbuilt" enumeration. Together they must account for
    // every row once — an item in two lists is a contradiction, and an item in
    // none is a row that quietly stopped being discussed.
    const present = [...new Set([...SOURCES.matchAll(/^\| ((?:SRC|DEC|OPS|PLT|CC)-\d+) /gm)].map((m) => m[1]))]

    const nowTable = [...SOURCES.matchAll(/^\|\s*\*\*((?:SRC|DEC|OPS|PLT|CC)-\d+)\*\*[^|]*\|/gm)].map((m) => m[1])
    const bullets = [...SOURCES.matchAll(/^- \*\*((?:SRC|DEC|OPS|PLT|CC)-\d+)\*\*/gm)].map((m) => m[1])

    const paragraph = /Everything else —([\s\S]*?)— is genuinely unbuilt/.exec(SOURCES)
    assert.ok(paragraph, 'the register states no "Everything else — … — is genuinely unbuilt" enumeration')
    const unbuilt = []
    for (const token of paragraph[1].match(/(?:SRC|DEC|OPS|PLT|CC)-\d+(?:\.\.\d+)?/g) || []) {
      if (!token.includes('..')) { unbuilt.push(token); continue }
      // `SRC-03..11` is `PREFIX-LO..HI` — the range's low end shares the id
      // prefix, so splitting on '-' gives `['SRC', '03..11']` and the low bound
      // must come off the `..`, not off the dash. Splitting it the other way
      // silently expanded `SRC-03..11` to nothing and left every SRC item
      // looking unaccounted for.
      const [prefix, rest] = token.split('-')
      const [lo, hi] = rest.split('..')
      for (let i = Number(lo); i <= Number(hi); i += 1) unbuilt.push(`${prefix}-${String(i).padStart(2, '0')}`)
    }
    assert.ok(unbuilt.length > 0, 'the unbuilt enumeration expanded to nothing — the reader is wrong, not the register')

    const seen = new Map()
    for (const [list, ids] of [['the "Now" table', nowTable], ['the "partly done" bullets', bullets], ['the unbuilt enumeration', unbuilt]]) {
      for (const id of ids) {
        if (seen.has(id)) {
          assert.fail(`${id} is in ${seen.get(id)} and ${list} — the lists must be disjoint`)
        }
        seen.set(id, list)
      }
    }

    const unaccounted = present.filter((id) => !seen.has(id))
    assert.deepEqual(unaccounted, [],
      `register rows in none of the three status lists: ${unaccounted.join(', ')}`)
    const phantom = [...seen.keys()].filter((id) => !present.includes(id))
    assert.deepEqual(phantom, [],
      `the status lists name ids the register does not carry: ${phantom.join(', ')}`)
  })

  it('sources-and-decisions: the README item count is the number of rows', () => {
    const distinct = new Set([...SOURCES.matchAll(/^\| ((?:SRC|DEC|OPS|PLT|CC)-\d+) /gm)].map((m) => m[1]))
    const stated = readmeCounts('sources-and-decisions-roadmap.md', ['capability items'])
    assert.equal(stated['capability items'], distinct.size,
      `README says ${stated['capability items']} capability items; the register carries ${distinct.size}. `
      + 'The count was the arithmetic of the declared ranges, not of the file.')
  })

  it('sources-and-decisions: the header split is the split the three lists have', () => {
    // The header and the README both state the same three-way split, and for a
    // day both said "7 shipped, 6 partly built" when the tree has six complete
    // and seven partly built — transposed, the exact error this file's own
    // header records on `roadmap-extension.md`. Nothing caught it: the README
    // check above reads only "30 capability items", and the register's split
    // was outside every check's jurisdiction.
    //
    // Derived here rather than restated. "Complete" is the `Now` table's
    // `Shipped` and `Fixed` cells; "partly built" is everything else that moved
    // — a `Half` cell in that table, plus the "partly done" bullets, which is
    // the pairing the inversion got wrong (SRC-01 is one row and six bullets
    // are six, so a reader who counted only the table saw 1 and 6 and swapped
    // the labels).
    const nowCells = [...SOURCES.matchAll(/^\|\s*\*\*((?:SRC|DEC|OPS|PLT|CC)-\d+)\*\*[^|]*\|\s*\*\*([A-Za-z]+)\*\*/gm)]
      .map((m) => ({ id: m[1], status: m[2] }))
    assert.ok(nowCells.length >= 4, `read ${nowCells.length} "Now" rows — the reader is wrong, not the header`)

    const COMPLETE = new Set(['Shipped', 'Fixed'])
    const unrecognised = nowCells.filter((r) => !COMPLETE.has(r.status) && r.status !== 'Half')
    assert.deepEqual(unrecognised, [],
      `"Now" cells this check cannot classify: ${unrecognised.map((r) => `${r.id}=${r.status}`).join(', ')}. `
      + 'An unclassified cell is how the split goes wrong while every classified one stays consistent.')

    const complete = nowCells.filter((r) => COMPLETE.has(r.status)).length
    const half = nowCells.filter((r) => r.status === 'Half').length
    const bullets = new Set([...SOURCES.matchAll(/^- \*\*((?:SRC|DEC|OPS|PLT|CC)-\d+)\*\*/gm)].map((m) => m[1]))
    const partial = half + bullets.size
    const unbuilt = 30 - complete - partial

    // Both statements, read from the file rather than passed in. The header
    // spells its numbers as words, so they are parsed rather than pattern-
    // matched: a regex pinning the literal would fail on a rewording without
    // ever saying what the new number should be.
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
    const header = /(\w+) rows verified complete — (\w+) shipped and\s+(\w+) fixed — and (\w+) partly built/.exec(SOURCES)
    assert.ok(header, 'the register header no longer states its split in the form this check reads')
    const stated = { complete: words[header[1].toLowerCase()], shipped: words[header[2].toLowerCase()], fixed: words[header[3].toLowerCase()], partial: words[header[4].toLowerCase()] }
    assert.ok(Object.values(stated).every(Number.isInteger),
      `the header states a number this check cannot read: ${header.slice(1).join(' / ')}`)
    assert.deepEqual(
      { complete: stated.complete, partial: stated.partial },
      { complete, partial },
      `the header says ${stated.complete} complete and ${stated.partial} partly built; `
      + `the three lists have ${complete} and ${partial}`,
    )
    assert.equal(stated.shipped + stated.fixed, complete,
      `the header's ${stated.shipped} shipped + ${stated.fixed} fixed is not the table's ${complete} complete`)

    const readme = readmeCounts('sources-and-decisions-roadmap.md', ['complete', 'partly built', 'unbuilt'])
    assert.deepEqual(
      { complete: readme.complete, 'partly built': readme['partly built'], unbuilt: readme.unbuilt },
      { complete, 'partly built': partial, unbuilt },
      'the README index row\'s split is not the split the register\'s three lists have',
    )
    assert.equal(complete + partial + unbuilt, 30,
      `the three lists account for ${complete + partial + unbuilt} rows, not the register's 30`)
  })

  it('status.md: the bold total is the table, and the README agrees with both', () => {
    const rows = [...STATUS.matchAll(/^\|\s*(ENH-\d+)\s*\|(.*)$/gm)]
      .map((m) => ({ id: m[1], cells: cells(m[2]) }))
    assert.equal(rows.length, 30, `read ${rows.length} enhancement rows — expected 30`)

    const { counts, unrecognised } = tally(rows, 1)
    assert.deepEqual(unrecognised, [],
      `status.md rows whose status this check cannot read:\n  ${unrecognised.join('\n  ')}`)

    const bold = /\*\*(\d+) shipped, (\d+) partial, (\d+) not started,\*\* of (\d+)\./.exec(STATUS)
    assert.ok(bold, 'status.md states no "**N shipped, N partial, N not started,** of N." total')
    assert.deepEqual(
      { shipped: Number(bold[1]), partial: Number(bold[2]), 'not started': Number(bold[3]), of: Number(bold[4]) },
      { shipped: counts.Shipped, partial: counts.Partial, 'not started': counts['Not started'], of: rows.length },
      'the status.md bold total disagrees with its own table')

    assert.deepEqual(
      readmeCounts('status.md', ['shipped', 'partial', 'not started']),
      { shipped: counts.Shipped, partial: counts.Partial, 'not started': counts['Not started'] },
      'the README index row for status.md disagrees with the register')
  })

  it('system-audit: the remediation total is the number of entries, not the number of ids', () => {
    // `01-remediation.md` lists its defects as `| **R-NN** | … |` rows across
    // several sections, and the README states a total. It was exactly right when
    // written — 92 entries at `5bc71e8`, 2026-10-05 — and R-80 was added on
    // 2026-10-12 without the count following. So this is drift rather than a
    // miscount, which is worth distinguishing: the same assertion catches both,
    // but the fix differs.
    //
    // The reader accepts bold or bare ids, and that is not a convenience: the
    // two shapes disagreed by exactly the drift. Until this change the register
    // held **92 bold entries plus R-80 bare** — R-80 being the one entry written
    // without `**`, added on 2026-10-12. So a reader requiring the bold counted
    // 92, agreed with the stale README, and reported the register correct. The
    // count and the presentation were the same bug; R-80 is now bolded like the
    // rest, and the reader accepts both shapes so the next one cannot hide.
    //
    // Not asserted: that the ids are contiguous. R-81 and R-82 have never
    // existed in any commit (checked at 5bc71e8 and at HEAD), so a gap is the
    // register's own numbering rather than a deleted row.
    const AUDIT_README = read('docs/improvements/system-audit/README.md')
    const REMEDIATION = read('docs/improvements/system-audit/01-remediation.md')

    const entries = new Set(
      [...REMEDIATION.matchAll(/^\| \*{0,2}(R-\d+)\*{0,2} \|/gm)].map((m) => m[1]),
    )
    assert.ok(entries.size > 80,
      `read only ${entries.size} remediation entries — the reader or the register is wrong, not the count`)

    const stated = /(\d+) defects\*{0,2} requiring remediation/.exec(AUDIT_README)
    assert.ok(stated, 'system-audit/README.md states no "N defects requiring remediation" total')
    assert.equal(
      Number(stated[1]),
      entries.size,
      `system-audit/README.md says ${stated[1]} defects; 01-remediation.md lists ${entries.size}. `
      + 'A count that does not follow the register is the drift this whole file exists to catch.',
    )
  })

  it('every test count the registers state is the count the file has', () => {
    // The same defect in a different unit. A register entry says "what shipped"
    // and names the suite and its size — `test/charts.test.js` (50 tests) — and
    // nothing read the suite. Five of the seven claims were wrong when this was
    // written, and three of those were wrong at the very commit that wrote them:
    // `fd37cb8` (2026-10-03) said 49 beside a file already holding 50, `6367197`
    // said 27 beside 28, `da64321` said 29 beside 28. Only
    // `test/dispatch-order.test.js` (7 → 12) is genuine drift; the rest are
    // miscounts, and the distinction is the same one the remediation case draws.
    //
    // Counted statically, not by running the suites. Static and runtime agree on
    // all seven today (checked), and a static read cannot be flaky: two of these
    // files bind sockets and write temp dirs, and spawning seven node processes
    // inside the suite is how this repo's contention flakes start. The claim is
    // about the suite's size, which the source fixes.
    //
    // Scoped by the *shape* of the claim — a backticked `test/*.test.js` followed
    // by `(N tests)`. A count stated without naming a file (`22/27`, in
    // enhancements-50.md, meaning `test/anticipatory-action.test.js`) has no
    // referent the reader can resolve, so it is out of jurisdiction rather than
    // guessed at. That one is correct anyway (27).
    const CLAIM = /`(test\/[a-z0-9-]+\.test\.js)`[\s\S]{0,12}?\((\d+)\s+tests?\)/g
    const docs = ['docs/improvements/enhancements.md',
      'docs/improvements/audit-2026-10/defects.md',
      'docs/improvements/audit-2026-10/enhancements-50.md',
      'docs/plans/vision-gap-closure.md']

    const wrong = []
    let seen = 0
    for (const doc of docs) {
      for (const m of read(doc).matchAll(CLAIM)) {
        const [, file, stated] = m
        seen += 1
        // `it(` and `test(` both declare a case; the lookbehind keeps `.skip(`,
        // `describe(` and a property access from counting as one.
        const source = read(file)
        const actual = (source.match(/(^|[^.\w])(it|test)\s*\(/g) ?? []).length
        if (actual !== Number(stated)) wrong.push(`${doc} → ${file}: says ${stated}, the file has ${actual}`)
      }
    }

    assert.ok(seen >= 6, `found only ${seen} test-count claims — the reader or the registers are wrong`)
    assert.deepEqual(wrong, [],
      `a register states a test count the suite does not have:\n  ${wrong.join('\n  ')}\n`
      + 'Either fix the number, or — if the sentence is about what shipped at a commit rather than now — '
      + 'say so, because this reads it as a claim about the file on disk.')
  })

  it('audit-2026-10: the defect total is the number of entries, split base and late', () => {
    // The same shape as the system-audit case, and the fourth stale total found
    // in this family. `defects.md` numbers its entries as `## PREFIX-NN — SEV —
    // …` headings across eight domain sections; the README states the total two
    // ways, and until this change the two disagreed with each other: line 9 said
    // "sixty-eight … ten more found since" (78, correct) and the document table
    // said "Sixty-eight … plus six found later, `VER-13..VER-17` and `QUA-08`"
    // (74, stale — written before VER-18, VER-19, VER-20 and VUL-08 existed).
    //
    // So this asserts both halves, not just the sum: a total that happens to be
    // right while the split is wrong is the failure mode a single count misses.
    //
    const AUDIT = read('docs/improvements/audit-2026-10/defects.md')
    const AUDIT_README = read('docs/improvements/audit-2026-10/README.md')

    // The late set is *read from the README's own sentences*, not named here.
    // It was named here, and the naming was defended on the grounds that "found
    // after the audit" is a fact about when the audit ran rather than a property
    // of the file — which is true, and is exactly why the list drifted: adding
    // QUA-09 and QUA-10 to `defects.md` and to the README's ranges left this
    // literal behind, and the test then reported 70 base entries against a
    // README that correctly said 68. A second hand-typed list is the class this
    // repository has written down repeatedly; the README states the ranges, so
    // the ranges are what this reads.
    const lateSentences = AUDIT_README.split('\n').filter((l) => /found (since|later)/.test(l)).join('\n')
    assert.ok(lateSentences, 'the audit README no longer says how many defects were found after the audit')
    const LATE = new Set()
    for (const [, from, to] of lateSentences.matchAll(/`([A-Z]{2,4}-\d{2})(?:\.\.([A-Z]{2,4}-\d{2}))?`/g)) {
      if (!to) { LATE.add(from); continue }
      const [prefix, first] = from.split('-')
      const [otherPrefix, last] = to.split('-')
      assert.equal(prefix, otherPrefix, `the README names a range across two prefixes: ${from}..${to}`)
      for (let n = Number(first); n <= Number(last); n += 1) {
        LATE.add(`${prefix}-${String(n).padStart(2, '0')}`)
      }
    }
    assert.ok(LATE.size > 0, 'the README names no late-found ids, so the split below would be the whole register')


    // The heading shape is the entry: `## VUL-01 — CRITICAL — …`. A prefix in
    // body prose (`VUL-03` cited inside VUL-08) is a cross-reference, not an
    // entry, and counting those is how a reader inflates the set.
    const entries = [...AUDIT.matchAll(/^#{2,4} ([A-Z]{2,4}-\d+) — /gm)].map((m) => m[1])
    const distinct = new Set(entries)
    assert.equal(entries.length, distinct.size,
      `defects.md has ${entries.length} entry headings but only ${distinct.size} distinct ids — `
      + 'a duplicated id means one defect is filed twice')

    const base = [...distinct].filter((id) => !LATE.has(id)).length
    const late = distinct.size - base
    assert.ok(base > 50, `read only ${base} base entries — the reader or the register is wrong`)

    const statedBase = /(\w+)-eight defects from the audit/.exec(AUDIT_README)
    assert.ok(statedBase, 'audit README states no "Sixty-eight defects from the audit" total')
    assert.equal(base, 68,
      `audit README's line 9 and its document table must agree on the base total; `
      + `defects.md has ${base} entries that are not in the late-found set`)

    const statedLate = /plus (\w+) found later/.exec(AUDIT_README)
    assert.ok(statedLate, 'audit README states no "plus N found later" total')
    const words = { six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 }
    assert.equal(words[statedLate[1].toLowerCase()], late,
      `audit README says "plus ${statedLate[1]} found later"; defects.md has ${late} `
      + `(${[...LATE].sort().join(', ')}). A base total that is right while the split is wrong `
      + 'is what a single count cannot see.')
  })
})
