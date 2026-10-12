import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseTotals } from '../scripts/check-coverage.mjs'

/**
 * QUA-04 — a coverage gate that measures the tests that exist.
 *
 * The gate this replaces ran `src/**` against six test files out of 162. The
 * thresholds were real and enforced, and the number described those six files:
 * a module with no test at all still passed, because nothing imported it.
 *
 * The defect was in *which files were run*, and that is not something a unit
 * test can assert from inside the run — so the check below reads the wiring
 * (the glob, the CI step) and `scripts/check-coverage.mjs` derives the file
 * list from the same glob `npm test` uses. What this file can test directly is
 * the parser, because a parser that returns `null` for a real report turns the
 * gate into a crash, and one that returns a plausible number for a table it
 * did not read turns it into a lie.
 */
describe('QUA-04 — the coverage parser reads the totals row and nothing else', () => {
  it('reads a report row in every spelling Node emits', () => {
    // The prefix is a reporter-version detail and there are three of them:
    // `ℹ ` on Node 26, `# ` on Node 22 (which CI pins), and bare when the
    // reporter is not decorating. This test previously enumerated two, and the
    // comment above it said a parser that knew only one spelling "would work on
    // a developer's machine and fail in CI, or the reverse" — which is exactly
    // what the missing third did: the gate failed every CI run it ever had with
    // "could not find the `all files` row" against a log containing the row.
    // A check for "every spelling" that enumerates some of them is the bug in
    // the check, so all three are here.
    const expected = { lines: 95.68, branches: 81.65, functions: 93.55 }
    assert.deepEqual(parseTotals('ℹ all files                |  95.68 |    81.65 |   93.55 |'), expected)
    assert.deepEqual(parseTotals('# all files                |  95.68 |    81.65 |   93.55 |'), expected)
    assert.deepEqual(parseTotals('all files | 95.68 | 81.65 | 93.55 |'), expected)
  })

  it('does not mistake a per-file row for the totals', () => {
    // The failure that would make this gate useless in the other direction: a
    // per-file row carries three numbers too, so a parser keyed on "a row with
    // three percentages" reads `src/server.js`'s coverage as the project's.
    // The first row of the table is the highest-coverage file, which would
    // make the gate pass on a codebase where nothing else is tested.
    assert.equal(parseTotals('ℹ src/server.js            |  92.10 |    70.00 |   88.00 |'), null)
    assert.equal(parseTotals('ℹ public/app.js            | 100.00 |   100.00 |  100.00 |'), null)
  })

  it('returns null rather than a number when there is no totals row', () => {
    // A gate that cannot read its own measurement must fail. `null` is what
    // makes `check-coverage.mjs` exit non-zero; a zero would make it exit on
    // the threshold comparison instead, with a message about coverage rather
    // than about the report it could not read.
    assert.equal(parseTotals(''), null)
    assert.equal(parseTotals('no coverage table in this output'), null)
    assert.equal(parseTotals('all files | n/a | n/a | n/a |'), null)
  })

  it('parses the totals out of a real report', () => {
    // Not a fixture: the parser is exercised against a captured full-suite
    // report, so a change to Node's table format shows up here rather than as
    // a red CI job with an unreadable message.
    const report = readFileSync(new URL('./fixtures/coverage-report.txt', import.meta.url), 'utf8')
    const totals = parseTotals(report)
    assert.ok(totals, 'the captured report must yield totals')
    assert.equal(typeof totals.lines, 'number')
    assert.equal(typeof totals.branches, 'number')
    assert.equal(typeof totals.functions, 'number')
  })
})

describe('QUA-04 — the gate is wired to the whole suite', () => {
  it('runs every test file, not a hand-picked list', () => {
    // The defect, asserted at the level it lived at. The old script named six
    // files inline in `package.json`; the new one globs. This reads the script
    // and requires it to enumerate the directory, which is the property that
    // keeps the gate honest when someone adds the 163rd test file.
    const source = readFileSync(new URL('../scripts/check-coverage.mjs', import.meta.url), 'utf8')
    assert.match(source, /readdirSync\(.*test/,
      'the coverage gate must enumerate test/ rather than name files')
    assert.ok(!/test\/lite\.test\.js/.test(source),
      'a named test file in the gate is the defect restated: the list drifts from the suite')
  })

  it('fails rather than passes when it cannot read its measurement', () => {
    const source = readFileSync(new URL('../scripts/check-coverage.mjs', import.meta.url), 'utf8')
    assert.match(source, /could not find the `all files` row[\s\S]*?process\.exit\(1\)/,
      'a gate that reports success while measuring nothing is the defect class this repo has paid for before')
  })
})
