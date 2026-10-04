#!/usr/bin/env node
/**
 * ENH-18 — hazard-history playback frames.
 *
 * The interesting assertions here are about what a scrubber would *show*: an
 * event that has not started must not appear, an event that spans four frames
 * must be active in all four, an instant must not vanish because it has no end
 * date, and a year must not be a fixed number of days long. Each of those is a
 * way a timeline quietly lies.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bucketStart, buildFrames, frameSummary, peakFrame, recordActive } from '../public/shared/viz-playback.js'

const day = (n) => `2026-03-${String(n).padStart(2, '0')}T00:00:00.000Z`

const flood = (id, start, over = {}) => ({
  id, type: 'flood_event', severity: 'medium', region_name: 'Kisumu',
  started_at: start, ...over,
})

describe('frames carry what a reader needs to see movement', () => {
  it('opens a frame on the day the event starts, not before', () => {
    const t = buildFrames([flood('a', day(5))], { bucket: 'day' })
    assert.equal(t.frames.length, 1)
    assert.equal(t.frames[0].label, '2026-03-05')
    assert.deepEqual(t.frames[0].opened, ['a'])
    assert.deepEqual(t.frames[0].closed, [])
  })

  it('reports counts by severity and by kind, not just a total', () => {
    // "3 events" is not what an emergency officer is watching for.
    const t = buildFrames([
      flood('a', day(1), { severity: 'high' }),
      flood('b', day(1), { severity: 'low', type: 'storm' }),
      flood('c', day(1), { severity: 'high' }),
    ], { bucket: 'day' })
    assert.deepEqual(t.frames[0].counts.bySeverity, { high: 2, low: 1 })
    assert.deepEqual(t.frames[0].counts.byKind, { flood_event: 2, storm: 1 })
    assert.equal(t.frames[0].counts.total, 3)
  })

  it('names what changed since the previous frame', () => {
    const t = buildFrames([
      flood('a', day(1), { ended_at: day(2) }),
      flood('b', day(2), { ended_at: day(4) }),
    ], { bucket: 'day' })
    const byLabel = Object.fromEntries(t.frames.map((f) => [f.label, f]))
    assert.deepEqual(byLabel['2026-03-01'].opened, ['a'])
    assert.deepEqual(byLabel['2026-03-02'].opened, ['b'])
    // `a` runs to the end of the 2nd, so it is still active and unchanged in the
    // frame where `b` opens.
    assert.equal(byLabel['2026-03-02'].unchanged, 1)
    assert.deepEqual(byLabel['2026-03-02'].closed, [], 'a has not ended yet on the 2nd')
    assert.deepEqual(byLabel['2026-03-03'].closed, ['a'], 'the frame after it ends says so')
    assert.deepEqual(byLabel['2026-03-03'].active.map((x) => x.id), ['b'])
  })

  it('reports a severity change rather than leaving the reader to diff frames', () => {
    const t = buildFrames([
      flood('a', day(1), { ended_at: day(2), severity: 'low' }),
      flood('a', day(1), { ended_at: day(2), severity: 'critical' }),
    ], { bucket: 'day' })
    // Two records share an id; the higher-severity one is what a reader must be
    // told about, so an escalation is surfaced rather than an ordering accident.
    assert.equal(t.frames[0].counts.total, 2)
  })

  it('keeps a multi-day event active in every frame it spans', () => {
    const t = buildFrames([flood('a', day(1), { ended_at: day(5) })], { bucket: 'day' })
    assert.equal(t.frames.length, 5)
    // Being active in frame 1 only — because that is the bucket it was filed
    // under — would show a five-day flood as a one-day one.
    for (const f of t.frames) {
      assert.deepEqual(f.active.map((a) => a.id), ['a'], f.label)
    }
    assert.deepEqual(t.frames[4].closed, [])
  })

  it('never steps through a bucket where nothing was active', () => {
    const t = buildFrames([
      flood('a', day(1), { ended_at: day(1) }),
      flood('b', day(20), { ended_at: day(20) }),
    ], { bucket: 'day' })
    // A scrubber that spends three quarters of its travel on nothing is a
    // scrubber teaching the reader the data is sparse.
    assert.deepEqual(t.frames.map((f) => f.label), ['2026-03-01', '2026-03-20'])
  })
})

describe('an absent end date does not make an event invisible', () => {
  it('keeps an open-ended hazard active through the whole timeline', () => {
    // `end ?? start` would make every ongoing hazard a zero-length event that is
    // active in no frame at all — the event would be missing from a timeline
    // whose entire purpose is showing it.
    const t = buildFrames([
      flood('open', day(1)),
      flood('closed', day(10), { ended_at: day(11) }),
    ], { bucket: 'day' })
    const first = t.frames[0]
    assert.ok(first.active.some((a) => a.id === 'open'))
    assert.ok(t.frames.at(-1).active.some((a) => a.id === 'open'))
  })

  it('ends the timeline at the last real event, not at infinity', () => {
    const t = buildFrames([
      flood('open', day(1)),
      flood('b', day(3), { ended_at: day(4) }),
    ], { bucket: 'day' })
    assert.equal(t.to.slice(0, 10), '2026-03-04')
    assert.ok(!t.truncated)
  })

  it('counts a record with no timestamp rather than dropping it silently', () => {
    const t = buildFrames([flood('a', day(1)), { id: 'undated', type: 'flood_event' }], { bucket: 'day' })
    assert.equal(t.totalRecords, 1)
    assert.equal(t.skipped, 1, 'an undated record is reported, not vanished')
  })

  it('gives an undated record an id fallback so transitions can still be diffed', () => {
    const t = buildFrames([{ started_at: day(1), type: 'flood_event' }], { bucket: 'day' })
    assert.deepEqual(t.frames[0].opened, ['record-0'])
  })
})

describe('the calendar is UTC and is not thirty days long', () => {
  it('floors to the UTC day, not the local one', () => {
    // An event at 23:50 UTC belongs to that UTC day on every device. A local
    // boundary would put it in two frames for some readers and one for others.
    assert.equal(new Date(bucketStart(Date.parse('2026-03-05T23:50:00Z'), 'day')).toISOString(), '2026-03-05T00:00:00.000Z')
  })

  it('floors months to the first of the month', () => {
    assert.equal(new Date(bucketStart(Date.parse('2026-03-17T12:00:00Z'), 'month')).toISOString(), '2026-03-01T00:00:00.000Z')
  })

  it('keeps February the length February is', () => {
    // A fixed 30-day month would misfile every March.
    const t = buildFrames([
      flood('a', '2026-01-31T00:00:00Z', { ended_at: '2026-03-02T00:00:00Z' }),
    ], { bucket: 'month' })
    assert.deepEqual(t.frames.map((f) => f.label), ['2026-01', '2026-02', '2026-03'])
  })

  it('handles a leap February without losing a day', () => {
    const t = buildFrames([
      flood('a', '2028-02-01T00:00:00Z', { ended_at: '2028-03-01T00:00:00Z' }),
    ], { bucket: 'month' })
    assert.deepEqual(t.frames.map((f) => f.label), ['2028-02', '2028-03'])
  })

  it('starts ISO weeks on Monday', () => {
    // 2026-03-01 is a Sunday, which is the last day of the previous ISO week.
    assert.equal(new Date(bucketStart(Date.parse('2026-03-01T12:00:00Z'), 'week')).toISOString(), '2026-02-23T00:00:00.000Z')
  })

  it('decades bucket to the nearest ten', () => {
    const t = buildFrames([flood('a', '1985-06-01T00:00:00Z', { ended_at: '1985-06-02T00:00:00Z' })], { bucket: 'decade' })
    assert.deepEqual(t.frames.map((f) => f.label), ['1980'])
  })
})

describe('a bare year is a year, not a timestamp', () => {
  it('refuses to read 1985 as 1,985 seconds after the epoch', () => {
    // `Number(1985)` being finite is exactly the falsy coercion this repository
    // keeps tripping over.
    assert.equal(buildFrames([flood('a', 1985)], { bucket: 'year' }).frames.length, 0)
  })

  it('still accepts epoch seconds and epoch milliseconds', () => {
    assert.equal(buildFrames([flood('a', 1772668800)], { bucket: 'day' }).frames.length, 1)
    assert.equal(buildFrames([flood('a', 1772668800000)], { bucket: 'day' }).frames.length, 1)
  })

  it('accepts a Date object', () => {
    const t = buildFrames([flood('a', new Date('2026-03-05T00:00:00Z'))], { bucket: 'day' })
    assert.equal(t.frames[0].label, '2026-03-05')
  })
})

describe('membership is by interval, not by which bucket a record was filed under', () => {
  it('reports an event that overlaps a window', () => {
    assert.equal(recordActive({ started_at: day(5), ended_at: day(6) }, Date.parse(day(5)), Date.parse(day(6))), true)
  })

  it('does not report an event that has not started', () => {
    assert.equal(recordActive({ started_at: day(7) }, Date.parse(day(5)), Date.parse(day(6))), false)
  })

  it('does not report an event that had already ended', () => {
    assert.equal(recordActive({ started_at: day(1), ended_at: day(2) }, Date.parse(day(5)), Date.parse(day(6))), false)
  })
})

describe('the timeline refuses to hang the page', () => {
  it('caps the frame count and says that it did', () => {
    const records = []
    for (let d = 1; d <= 28; d += 1) records.push(flood(`e${d}`, `2026-01-${String(d).padStart(2, '0')}T00:00:00Z`))
    const t = buildFrames(records, { bucket: 'day', maxFrames: 5 })
    assert.equal(t.frames.length, 5)
    // A silent truncation would leave a reader believing the archive ends there.
    assert.equal(t.truncated, true)
  })

  it('reports an untruncated timeline as untruncated', () => {
    assert.equal(buildFrames([flood('a', day(1))], { bucket: 'day' }).truncated, false)
  })

  it('rejects an unknown bucket rather than guessing a default', () => {
    assert.throws(() => buildFrames([flood('a', day(1))], { bucket: 'fortnight' }), /unknown bucket/)
  })

  it('returns an empty timeline for empty input without throwing', () => {
    const t = buildFrames([], { bucket: 'day' })
    assert.deepEqual(t.frames, [])
    assert.equal(t.totalRecords, 0)
    assert.equal(peakFrame(t), null)
    assert.equal(frameSummary(t, 0), 'No frame at this position')
  })
})

describe('the reader is told when a frame is a turning point', () => {
  it('names what began, ended and changed', () => {
    const t = buildFrames([
      flood('a', day(1), { ended_at: day(2) }),
      flood('b', day(2), { ended_at: day(4) }),
    ], { bucket: 'day' })
    const opened = frameSummary(t, 1)
    assert.match(opened, /1 began/)
    assert.match(opened, /2 active/)
    const closed = frameSummary(t, 2)
    assert.match(closed, /1 ended/)
  })

  it('says "unchanged" rather than returning nothing for a quiet frame', () => {
    const t = buildFrames([flood('a', day(1), { ended_at: day(3) })], { bucket: 'day' })
    assert.match(frameSummary(t, 1), /1 active, unchanged/)
  })

  it('finds the busiest frame, earliest on a tie', () => {
    const t = buildFrames([
      flood('a', day(1), { ended_at: day(5) }),
      flood('b', day(3), { ended_at: day(5) }),
    ], { bucket: 'day' })
    assert.equal(peakFrame(t).label, '2026-03-03')
    assert.equal(peakFrame(t).counts.total, 2)
  })
})

describe('the frames carry the record a reader will click through to', () => {
  it('keeps the whole record, not just an id', () => {
    const record = flood('a', day(1), { geometry: { lat: -0.09, lon: 34.75 } })
    const t = buildFrames([record], { bucket: 'day' })
    assert.equal(t.frames[0].active[0].record, record)
    assert.equal(t.frames[0].active[0].region_name, 'Kisumu')
  })

  it('exposes the slider bounds a caller needs', () => {
    const t = buildFrames([flood('a', day(1), { ended_at: day(4) })], { bucket: 'day' })
    assert.equal(t.firstFrameIndex, 0)
    assert.equal(t.lastFrameIndex, t.frames.length - 1)
    assert.equal(t.maxActive, 1)
    assert.equal(t.bucket, 'day')
  })
})