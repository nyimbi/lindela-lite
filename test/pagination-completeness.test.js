#!/usr/bin/env node
/**
 * ENH-14: a capped page and a complete page look identical until you ask.
 *
 * The GDACS archive caps a query at roughly 100 results, so
 * `src/connectors/gdacs-archive.js` walks quarter-by-quarter windows to get
 * around it. That workaround only works if a window which hit the cap is
 * distinguishable from one that did not — and today it is not. A quarter
 * returning exactly 100 events and a quarter returning 100 events because 100
 * is all there was both produce `87`-or-`100` records and no marker. The
 * difference is the whole question the training data depends on.
 *
 * CHIRPS has the same shape one layer down: 730 daily files on the index,
 * `.slice(0, 30)`, and nothing in the return value says 700 files were dropped
 * (ING-08). That is what `recordCap` fixes — `counts_found` recorded whether or
 * not the cap bound, and never a bare `0` standing in for "we never counted".
 *
 * Two guards here are load-bearing beyond the obvious:
 *
 *  - `possibly_incomplete` is a third verdict, not a flavour of `incomplete`. A
 *    full last page means *there may have been another page*; a provider-total
 *    shortfall means *there was*. Collapsing them would either cry wolf on every
 *    GDACS quarter or hide the one that actually lost records.
 *  - `COMPLETENESS_VERDICTS` is asserted by *driving* `assessPagination` over
 *    inputs chosen to produce each verdict, not by reading its source. A
 *    string list checked against a string list in the same file proves nothing
 *    when both can drift together; this way a verdict the function can return
 *    but the vocabulary omits fails.
 *
 * The falsy-zero cases are here because that is where the repo's count bugs
 * live: `recordsSeen: 0` is not the same as `providerTotal: 0`, and a truthiness
 * check on the total turns the first into `incomplete` and the second into a
 * silent pass.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COMPLETENESS_VERDICTS,
  REASONS,
  assessPagination,
  mergeCompleteness,
  recordCap,
} from '../src/completeness.js'

// One GDACS quarter, 2019 Q1: 87 events, all types, of which the flood filter
// keeps some. The point is the shape, not the number.
const GDACS_QUARTER = { pagesFetched: 1, pageSize: 100, cappedAt: 100 }

describe('assessPagination — the last page decides', () => {
  it('a run that ends on a partial page is complete', () => {
    const result = assessPagination({ ...GDACS_QUARTER, recordsSeen: 87, lastPageFull: false })
    assert.equal(result.complete, true)
    assert.equal(result.possibly_incomplete, false)
    assert.equal(result.reason, `${REASONS.PARTIAL_PAGE} (87 of 100 on the last page)`)
    assert.equal(result.counts_found, 87)
  })

  it('a last page that came back exactly full is possibly_incomplete, not complete', () => {
    // No cap in this input, deliberately: the assertion has to rest on the
    // page-shape rule alone, or it survives the day that rule is broken.
    const result = assessPagination({ pagesFetched: 1, pageSize: 100, recordsSeen: 100, lastPageFull: true })
    assert.equal(result.complete, false, 'a full last page is not evidence of a whole result set')
    assert.equal(result.possibly_incomplete, true)
    assert.ok(COMPLETENESS_VERDICTS.includes('possibly_incomplete'))
    assert.ok(result.reason.startsWith(REASONS.FULL_PAGE))
    assert.ok(result.reason.includes('100 of 100 on the last page'))
  })

  it('a full last page and a reached cap together still read as one guess, not two certainties', () => {
    const result = assessPagination({ ...GDACS_QUARTER, recordsSeen: 100, lastPageFull: true })
    assert.equal(result.possibly_incomplete, true)
    assert.ok(result.reason.includes(REASONS.FULL_PAGE), 'the page evidence is named')
    assert.ok(result.reason.includes(REASONS.CAPPED), 'the cap evidence is named, not hidden behind the first')
  })

  it('the full-page reason says the verdict rests on the heuristic alone when no total exists', () => {
    const withTotal = assessPagination({ recordsSeen: 100, pageSize: 100, lastPageFull: true, providerTotal: 100 })
    const withoutTotal = assessPagination({
      recordsSeen: 100,
      pageSize: 100,
      lastPageFull: true,
      providerTotal: null,
    })
    assert.equal(withTotal.complete, true)
    assert.equal(withoutTotal.possibly_incomplete, true)
    assert.notEqual(withTotal.reason, withoutTotal.reason, 'the absence of a total must change the stated evidence')
    assert.ok(withoutTotal.reason.includes('rests on the last-page heuristic alone'))
  })

  it('reaching the source cap is flagged even when the last page was partial', () => {
    // CHIRPS' shape: 30 kept out of a capped source, last page not full, but the
    // cap bound and anything behind it is unknown.
    const result = assessPagination({ recordsSeen: 30, pageSize: 30, lastPageFull: false, cappedAt: 30 })
    assert.equal(result.possibly_incomplete, true)
    assert.ok(result.reason.startsWith(REASONS.CAPPED))
  })
})

describe('assessPagination — a provider total is an answer, not a guess', () => {
  it('a reported total with fewer records seen is incomplete', () => {
    const result = assessPagination({
      ...GDACS_QUARTER,
      recordsSeen: 100,
      lastPageFull: true,
      providerTotal: 412,
    })
    assert.equal(result.complete, false)
    assert.equal(result.possibly_incomplete, false)
    assert.ok(result.reason.startsWith(REASONS.TOTAL_SHORTFALL))
    assert.ok(result.reason.includes('short by 312'))
  })

  it('a met total clears a full last page, because a further page would contradict the provider', () => {
    const result = assessPagination({ recordsSeen: 412, pageSize: 100, lastPageFull: true, providerTotal: 412 })
    assert.equal(result.complete, true)
    assert.ok(result.reason.startsWith(REASONS.TOTAL_SATISFIED))
  })

  it("the caller's own expectedTotal is the fallback, and says so", () => {
    const result = assessPagination({ recordsSeen: 100, pageSize: 100, lastPageFull: true, expectedTotal: 900 })
    assert.equal(result.complete, false)
    assert.equal(result.possibly_incomplete, false)
    assert.ok(result.reason.startsWith(REASONS.EXPECTED_SHORTFALL))
  })
})

describe('falsy zero — zero found is not zero expected', () => {
  it('nothing found against a reported total of zero is complete', () => {
    const result = assessPagination({ recordsSeen: 0, pageSize: 100, lastPageFull: false, providerTotal: 0 })
    assert.equal(result.complete, true)
    assert.ok(result.reason.startsWith(REASONS.TOTAL_SATISFIED))
    assert.equal(result.counts_found, 0)
  })

  it('nothing found against a reported total of 5000 is incomplete', () => {
    const result = assessPagination({ recordsSeen: 0, pageSize: 100, lastPageFull: false, providerTotal: 5000 })
    assert.equal(result.complete, false)
    assert.equal(result.possibly_incomplete, false)
    assert.ok(result.reason.startsWith(REASONS.TOTAL_SHORTFALL))
  })

  it('a truthiness check would have got both of those wrong', () => {
    // The specific regression: `if (!providerTotal)` treats 0 as "no total
    // reported", which turns the first case into a last-page verdict and lets
    // the second fall through to a guess.
    const guardsZero = (v) => !v
    assert.equal(guardsZero(0), true)
    assert.equal(guardsZero(5000), false)
    const zeroCase = assessPagination({ recordsSeen: 0, providerTotal: 0, pageSize: 100 })
    assert.equal(zeroCase.complete, true, 'the zero total must be read as a total of zero')
  })
})

describe('recordCap — counts_found wherever a cap is applied (ING-08)', () => {
  it('records the found count when under the cap', () => {
    const result = recordCap({ found: 12, taken: 12, cap: 30 })
    assert.equal(result.counts_found, 12)
    assert.equal(result.capped, false)
    assert.equal(result.cap_reason, null)
    assert.equal(result.records, 12)
  })

  it('records the found count and flags the cap when it binds', () => {
    const result = recordCap({ found: 730, taken: 30, cap: 30, reason: 'chirps keeps the 30 most recent dates' })
    assert.equal(result.counts_found, 730, 'the 700 dropped files are the entire point of the record')
    assert.equal(result.capped, true)
    assert.equal(result.cap_reason, 'chirps keeps the 30 most recent dates')
    assert.equal(result.records, 30)
  })

  it('treats reaching the cap exactly as capped, because that is the suspicious case', () => {
    const result = recordCap({ found: 30, taken: 30, cap: 30 })
    assert.equal(result.capped, true)
    assert.equal(result.counts_found, 30)
  })

  it('records the found count above the cap without being asked for a reason', () => {
    const result = recordCap({ found: 5000, taken: 100, cap: 100 })
    assert.equal(result.counts_found, 5000)
    assert.equal(result.capped, true)
    assert.ok(result.cap_reason.length > 0)
  })

  it('claims no cap when the source applies none', () => {
    const result = recordCap({ found: 30, taken: 30 })
    assert.equal(result.capped, false)
    assert.equal(result.cap_reason, null, 'a cap_reason without a cap is a claim about nothing')
    assert.equal(result.counts_found, 30)
  })

  it('records nothing rather than a zero when nothing was found and nothing was capped', () => {
    const result = recordCap({ found: 0, taken: 0 })
    assert.equal(result.counts_found, null, 'zero found and zero counted are different claims')
    assert.equal(result.capped, false)
  })
})

describe('mergeCompleteness — one verdict for the whole crawl', () => {
  const page = (recordsSeen, lastPageFull) => assessPagination({ recordsSeen, pageSize: 100, lastPageFull })

  it('merges many pages into a single complete verdict', () => {
    const merged = mergeCompleteness([page(100, false), page(100, false), page(64, false)])
    assert.equal(merged.complete, true)
    assert.equal(merged.pages, 3)
    assert.equal(merged.counts_found, 264)
    assert.ok(merged.reason.includes('worst of 3 pages; 3 at this verdict'))
  })

  it('a run is only as complete as its least complete page', () => {
    const merged = mergeCompleteness([page(100, false), page(40, false), page(100, true)])
    assert.equal(merged.complete, false)
    assert.equal(merged.possibly_incomplete, true)
  })

  it('one short last page flags the whole run, which is the GDACS case', () => {
    const merged = mergeCompleteness([page(100, true), page(100, true), page(100, true), page(100, true)])
    assert.equal(merged.complete, false)
    assert.equal(merged.possibly_incomplete, true)
    assert.ok(merged.reason.includes('worst of 4 pages; 4 at this verdict'))
  })

  it('a provider-total shortfall outranks a full-last-page guess', () => {
    const shortfall = assessPagination({ recordsSeen: 100, pageSize: 100, lastPageFull: true, providerTotal: 400 })
    const merged = mergeCompleteness([page(100, true), page(100, true), shortfall])
    assert.equal(merged.complete, false)
    assert.equal(merged.possibly_incomplete, false, 'a counted shortfall is not a heuristic')
    assert.ok(merged.reason.startsWith(REASONS.TOTAL_SHORTFALL))
  })

  it('counts across pages without inventing a count for an uncounted page', () => {
    const merged = mergeCompleteness([page(100, false), { complete: true, reason: 'hand-built', counts_found: null }])
    assert.equal(merged.counts_found, 100)
  })

  it('an empty crawl says so rather than claiming completeness by default', () => {
    const merged = mergeCompleteness([])
    assert.equal(merged.pages, 0)
    assert.equal(merged.reason, REASONS.NO_PAGES)
    assert.equal(merged.counts_found, null)
  })
})

describe('COMPLETENESS_VERDICTS — a vocabulary, not a comment', () => {
  it('is frozen, three long, and free of duplicates', () => {
    assert.ok(Object.isFrozen(COMPLETENESS_VERDICTS))
    assert.equal(COMPLETENESS_VERDICTS.length, 3)
    assert.equal(new Set(COMPLETENESS_VERDICTS).size, 3)
  })

  it('contains every verdict assessPagination can actually return', () => {
    // Driven, not read: each input is chosen to land on a different branch, and
    // the function's own booleans are mapped back to a verdict name. A verdict
    // the function emits but the list omits fails here.
    const cases = [
      { recordsSeen: 87, pageSize: 100, lastPageFull: false },
      { recordsSeen: 100, pageSize: 100, lastPageFull: true },
      { recordsSeen: 100, pageSize: 100, lastPageFull: true, providerTotal: 412 },
    ]
    const emitted = cases.map((input) => {
      const result = assessPagination(input)
      const name = result.complete ? 'complete' : result.possibly_incomplete ? 'possibly_incomplete' : 'incomplete'
      assert.ok(COMPLETENESS_VERDICTS.includes(name), `assessPagination emitted an unlisted verdict: ${name}`)
      return name
    })
    assert.deepEqual(new Set(emitted), new Set(COMPLETENESS_VERDICTS), 'all three verdicts were exercised')
  })

  it('is iterable, so a consumer can enumerate it instead of retyping the strings', () => {
    assert.deepEqual([...COMPLETENESS_VERDICTS], ['complete', 'possibly_incomplete', 'incomplete'])
  })
})