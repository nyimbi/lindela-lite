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
 * What this checks is arithmetic over the tables, not their prose: a status
 * cell that says something other than shipped/partial/not-started fails rather
 * than being silently uncounted, because an unrecognised cell is how a count
 * goes wrong while every recognised one stays consistent.
 *
 * Deliberately not checked: whether a "shipped" row is actually shipped. That
 * needs a reader and is the registers' own business. This holds the skeleton.
 *
 * Also not checked: `defects.md`'s "Roughly 55 findings". It is hedged prose
 * rather than a derived total — the file carries 26 `###` headings and 50
 * distinct ids across three shapes (headings, severity-table rows, and
 * cross-references from other entries), so "55" cannot be reconciled against a
 * set the file actually defines. A check would have to pick one of those shapes
 * and would then be measuring its own choice. It stays a reader's judgement.
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
})
