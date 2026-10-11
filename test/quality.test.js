import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ACCURACY_BANDS, QUALITY_GRADES, SKEW_VERDICTS,
  assessAccuracy, assessSkew, assessSubmissionQuality, findNearDuplicates, qualityTally, summarySimilarity,
} from '../src/quality.js'

/**
 * ENH-44 — the submission quality verdict.
 *
 * The property this module exists to hold is that a *doubt travels with the
 * record*, and that an unmeasured axis is never silently folded into a good
 * one. Three of the tests below are the load-bearing ones, and each is written
 * so that the naive implementation fails it:
 *
 *   - a report with no accuracy is `unknown`, not `precise`. `toNumber` returns
 *     null and `null <= 50` is false only by luck; an implementation that did
 *     `Number(m) || 0` would band every unlocated report as a 0 m fix.
 *   - a report captured an hour before it arrived is `queued`, not
 *     `clock_ahead`. The obvious `Math.abs(skew) > tolerance` flags every
 *     offline report, which is the entire population this platform serves.
 *   - a grade over nothing measured is `unassessable`, not `high`. A reducer
 *     seeded with `'high'` returns a clean bill of health for an empty store.
 */

const report = (over = {}) => ({
  id: 'r1',
  category: 'fever',
  summary: 'child with fever and rash for two days',
  latitude: 3.2,
  longitude: 35.7,
  observed_at: '2026-10-10T09:00:00.000Z',
  ...over,
})

describe('ENH-44 — accuracy is banded, and a missing fix is not a precise one', () => {
  it('bands a fix by radius', () => {
    assert.equal(assessAccuracy(12).band, 'precise')
    assert.equal(assessAccuracy(120).band, 'usable')
    assert.equal(assessAccuracy(900).band, 'coarse')
    assert.equal(assessAccuracy(9000).band, 'unusable')
  })

  it('bands the edges inclusively', () => {
    assert.equal(assessAccuracy(50).band, 'precise')
    assert.equal(assessAccuracy(50.1).band, 'usable')
    assert.equal(assessAccuracy(250).band, 'usable')
    assert.equal(assessAccuracy(2000).band, 'coarse')
  })

  it('treats a missing accuracy as unknown, never as precise', () => {
    // The falsy-zero case. `Number(null) || 0` bands every unlocated report as a
    // 0 m fix, which is the most precise band there is.
    for (const missing of [null, undefined, '', 'not a number']) {
      const verdict = assessAccuracy(missing)
      assert.equal(verdict.band, 'unknown', `${JSON.stringify(missing)} was banded as a measurement`)
      assert.equal(verdict.metres, null)
    }
  })

  it('treats a negative radius as unreported, not as a very good fix', () => {
    const verdict = assessAccuracy(-5)
    assert.equal(verdict.band, 'unknown')
    assert.match(verdict.note, /not a radius/)
  })

  it('keeps a real zero radius as precise', () => {
    // Zero is a value a receiver can report. It is not the same absence as null.
    assert.equal(assessAccuracy(0).band, 'precise')
  })

  it('exports the band vocabulary it bands into', () => {
    for (const band of ACCURACY_BANDS) {
      assert.ok(typeof band === 'string' && band.length, 'a band in the frozen list is not a name')
    }
    assert.ok(ACCURACY_BANDS.includes('unknown'))
  })
})

describe('ENH-44 — skew is signed, and a queued report is not a broken clock', () => {
  it('reads a report captured well before receipt as queued, not as drift', () => {
    const verdict = assessSkew({ captured_at: '2026-10-10T08:00:00.000Z', received_at: '2026-10-10T09:00:00.000Z' })
    assert.equal(verdict.verdict, 'queued')
    assert.equal(verdict.seconds, -3600, 'the sign must survive: a queue delays, it does not advance')
  })

  it('reads a capture time after receipt as a clock ahead', () => {
    const verdict = assessSkew({ captured_at: '2026-10-10T10:00:00.000Z', received_at: '2026-10-10T09:00:00.000Z' })
    assert.equal(verdict.verdict, 'clock_ahead')
    assert.equal(verdict.seconds, 3600)
  })

  it('tolerates a network round trip either way', () => {
    assert.equal(assessSkew({ captured_at: '2026-10-10T08:59:00.000Z', received_at: '2026-10-10T09:00:00.000Z' }).verdict, 'ok')
    assert.equal(assessSkew({ captured_at: '2026-10-10T09:01:00.000Z', received_at: '2026-10-10T09:00:00.000Z' }).verdict, 'ok')
  })

  it('treats an unparseable capture time as unmeasured, not as no skew', () => {
    // A client that sends `observed_at: ''` — which the connectors do — must not
    // read as a report that arrived on time.
    for (const captured of [null, undefined, '', 'yesterday']) {
      const verdict = assessSkew({ captured_at: captured, received_at: '2026-10-10T09:00:00.000Z' })
      assert.equal(verdict.verdict, 'unknown', `${JSON.stringify(captured)} was read as a measured skew`)
      assert.equal(verdict.seconds, null)
    }
  })

  it('exports the skew vocabulary it returns', () => {
    assert.ok(SKEW_VERDICTS.includes('queued'))
    assert.ok(SKEW_VERDICTS.includes('clock_ahead'))
  })
})

describe('ENH-44 — near-duplicate detection names its evidence', () => {
  it('matches a re-worded report of the same category, place and hour', () => {
    const matches = findNearDuplicates(report(), [report({ id: 'r2', summary: 'child has fever and rash for two days' })])
    assert.equal(matches.length, 1)
    assert.equal(matches[0].id, 'r2')
    assert.ok(matches[0].evidence.some((e) => /km apart/.test(e)), 'the distance did not travel as evidence')
  })

  it('does not match across categories even when the wording is identical', () => {
    const matches = findNearDuplicates(report(), [report({ id: 'r2', category: 'cholera' })])
    assert.deepEqual(matches, [])
  })

  it('does not match a report far outside the time window', () => {
    const matches = findNearDuplicates(report(), [report({ id: 'r2', observed_at: '2026-10-01T09:00:00.000Z' })])
    assert.deepEqual(matches, [])
  })

  it('does not match a report far away when both carry a fix', () => {
    const matches = findNearDuplicates(report(), [report({ id: 'r2', latitude: 9.5, longitude: 30.1 })])
    assert.deepEqual(matches, [])
  })

  it('keeps a match when one of the two has no fix, and says distance was not the evidence', () => {
    // A phone that cannot place itself is the phone most likely to submit twice.
    // Treating a missing distance as a large one would let exactly those through.
    const matches = findNearDuplicates(report(), [report({ id: 'r2', latitude: null, longitude: null })])
    assert.equal(matches.length, 1)
    assert.equal(matches[0].distance_km, null)
    assert.ok(matches[0].evidence.some((e) => /no fix/.test(e)))
  })

  it('ignores a withdrawn report and itself', () => {
    assert.deepEqual(findNearDuplicates(report(), [report({ id: 'r2', deleted_at: '2026-10-10T10:00:00.000Z' })]), [])
    assert.deepEqual(findNearDuplicates(report(), [report({ id: 'r1' })]), [])
  })

  it('scores wording by overlap, and two empty summaries are not similar', () => {
    assert.equal(summarySimilarity('', ''), 0, 'two absent summaries are not a duplicate pair')
    assert.equal(summarySimilarity('flood in Bor', null), 0)
    assert.equal(summarySimilarity('flood in Bor', 'flood in Bor'), 1)
    assert.ok(summarySimilarity('child with fever and rash', 'child has fever and rash') > 0.6)
  })

  it('does not let a stopword-only overlap read as similarity', () => {
    assert.equal(summarySimilarity('the and for', 'the and for'), 0)
  })
})

describe('ENH-44 — the grade is the weakest assessed axis, and unassessed is not a grade', () => {
  const received_at = '2026-10-10T09:05:00.000Z'

  it('grades a clean, well-located, on-time, unique report high', () => {
    const verdict = assessSubmissionQuality({
      record: report({ location_accuracy_m: 12, captured_at: '2026-10-10T09:00:00.000Z' }),
      received_at,
    })
    assert.equal(verdict.grade, 'high')
    assert.deepEqual(verdict.unassessed, [])
    assert.deepEqual(verdict.reasons, [])
  })

  it('drops to low on a near-duplicate alone', () => {
    const verdict = assessSubmissionQuality({
      record: report({ location_accuracy_m: 12, captured_at: '2026-10-10T09:00:00.000Z' }),
      candidates: [report({ id: 'r2', summary: 'child with fever and rash for two days' })],
      received_at,
    })
    assert.equal(verdict.grade, 'low')
    assert.equal(verdict.duplicates.length, 1)
  })

  it('drops to low on a clock that is ahead', () => {
    const verdict = assessSubmissionQuality({
      record: report({ location_accuracy_m: 12, captured_at: '2026-10-10T12:00:00.000Z' }),
      received_at,
    })
    assert.equal(verdict.grade, 'low')
  })

  it('holds at medium for a queued report with a good fix', () => {
    // The common case, and it must not read as a defect.
    const verdict = assessSubmissionQuality({
      record: report({ location_accuracy_m: 12, captured_at: '2026-10-09T09:00:00.000Z' }),
      received_at,
    })
    assert.equal(verdict.grade, 'medium')
    assert.equal(verdict.skew.verdict, 'queued')
  })

  it('grades a report with nothing measurable as unassessable, not high', () => {
    // A reducer seeded with 'high' hands an empty store a clean bill of health.
    const verdict = assessSubmissionQuality({
      record: { id: 'r1', category: null, summary: null },
      received_at,
    })
    assert.equal(verdict.grade, 'unassessable')
    assert.deepEqual(verdict.assessed, ['duplicates'])
    assert.deepEqual(verdict.unassessed.sort(), ['accuracy', 'skew'])
    assert.equal(verdict.reasons.length, 2, 'each unassessed axis must say so')
  })

  it('excludes an unassessed axis from the minimum rather than inventing a value for it', () => {
    // A coarse fix and no capture time: the grade is the coarse fix's `medium`,
    // not `low` for the missing skew and not `high` for an assumed one.
    const verdict = assessSubmissionQuality({ record: report({ location_accuracy_m: 900 }), received_at })
    assert.equal(verdict.grade, 'medium')
    assert.deepEqual(verdict.unassessed, ['skew'])
  })

  it('exports the grade vocabulary it grades into', () => {
    assert.ok(QUALITY_GRADES.includes('unassessable'))
    assert.ok(QUALITY_GRADES.includes('high'))
  })
})

describe('ENH-44 — the tally over a queue', () => {
  it('reports the weakest grade and counts each band', () => {
    const tally = qualityTally([{ grade: 'high' }, { grade: 'low' }, { grade: 'medium', duplicates: [] }])
    assert.equal(tally.total, 3)
    assert.equal(tally.grade, 'low')
    assert.equal(tally.by_grade.high, 1)
    assert.equal(tally.by_grade.medium, 1)
    assert.equal(tally.by_grade.low, 1)
  })

  it('counts the rows that carry a duplicate', () => {
    const tally = qualityTally([{ grade: 'low', duplicates: [{ id: 'x' }] }, { grade: 'high', duplicates: [] }])
    assert.equal(tally.duplicates_flagged, 1)
  })

  it('reports an empty queue as unassessable rather than as a clean one', () => {
    const tally = qualityTally([])
    assert.equal(tally.total, 0)
    assert.equal(tally.grade, 'unassessable')
  })

  it('folds an unknown grade into unassessable rather than dropping the row', () => {
    const tally = qualityTally([{ grade: 'excellent' }])
    assert.equal(tally.total, 1, 'a row with an unrecognised grade must still be counted')
    assert.equal(tally.by_grade.unassessable, 1)
  })
})
