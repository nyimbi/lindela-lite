/**
 * VER-03, VER-05, VER-06, QUA-07 — four places where a number was published
 * from an input the code could not actually read.
 *
 * The common shape: a field is absent, the code coerces the absence into a
 * value, and the value is indistinguishable from a measurement. Each test here
 * asserts the honest answer (the label, the null, the count, the 400) *and*
 * asserts the thing that made the bug invisible — that the record was admitted
 * by the filter above, or that the empty page looked exactly like no data.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { districtOverview } from '../src/districts.js'
import { buildDistrictSamples } from '../src/flood-probability.js'
import { computeApiUptime } from '../src/kpi.js'
import { DEFAULT_LIMIT, MAX_LIMIT, collectionPage, filterRecords, matchedAndPage, parseLimit } from '../src/utils.js'

// ---------------------------------------------------------------- VER-03

/**
 * A flood event that carries `from` and no `occurred_at` — the GDACS shape.
 *
 * `buildDistrictSamples` admits it in the pre-filter (which reads
 * `occurred_at || from`), so it is counted in `events_matched`. If the month
 * labeller reads only `occurred_at`, that event is counted in the numerator's
 * denominator and never in the numerator, and the contingency table's
 * flood-positive rate is biased low by exactly the events the historical record
 * carries most of.
 */
describe('VER-03 — a month is labelled from the same date field the filter admits on', () => {
  function daily365(startYear = 2005) {
    const out = []
    const start = Date.UTC(startYear, 0, 1)
    const end = Date.UTC(startYear + 1, 0, 1)
    for (let t = start; t < end; t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10)
      out.push({ date, precipitation_mm: 5 })
    }
    return out
  }

  const district = { latitude: 0, longitude: 0, country: 'TL' }

  it('labels a month from an event dated only by `from`', () => {
    const { samples, events_matched } = buildDistrictSamples(
      daily365(),
      [{ event_type: 'flood', country: 'TL', latitude: 0, longitude: 0, from: '2005-08-10T00:00:00.000Z' }],
      district,
    )
    // The filter admitted it. That is what makes the missing label a veracity
    // defect rather than a filtering one: the event is inside the population
    // being labelled and outside the labelled set.
    assert.equal(events_matched, 1)
    const august = samples.find((s) => s.month === '2005-08')
    assert.ok(august, `2005-08 should be a kept month, kept: ${samples.map((s) => s.month).join(',')}`)
    assert.equal(august.label, true, 'an event dated by `from` must label its month')
  })

  it('prefers `occurred_at` when the event carries both', () => {
    const { samples } = buildDistrictSamples(
      daily365(),
      [{
        event_type: 'flood', country: 'TL', latitude: 0, longitude: 0,
        occurred_at: '2005-03-10T00:00:00.000Z',
        from: '2005-08-10T00:00:00.000Z',
      }],
      district,
    )
    assert.equal(samples.find((s) => s.month === '2005-03')?.label, true)
    assert.equal(samples.find((s) => s.month === '2005-08')?.label, false)
  })

  it('does not label a month from an event dated by neither field', () => {
    // No date at all is not a date. Falling back to `''` must produce "no
    // month", not "every month" and not a throw.
    const { samples } = buildDistrictSamples(
      daily365(),
      [{ event_type: 'flood', country: 'TL', latitude: 0, longitude: 0 }],
      district,
    )
    assert.ok(samples.length > 0)
    assert.deepEqual(samples.filter((s) => s.label), [])
  })
})

// ---------------------------------------------------------------- VER-05

describe('VER-05 — uptime is null, not 100, when nothing has been observed', () => {
  it('reports no measurement rather than flawless availability', () => {
    const previous = process.env.LINDELA_LITE_UPTIME_OVERRIDE
    delete process.env.LINDELA_LITE_UPTIME_OVERRIDE
    try {
      // This module's request ring is per-process and this file records nothing
      // into it, so the rate is genuinely unmeasured here. The old code turned
      // that into 100.0 — a perfect-availability claim derived from zero
      // observations, on the dashboard an approver reads.
      assert.equal(computeApiUptime(), null)
    } finally {
      if (previous === undefined) delete process.env.LINDELA_LITE_UPTIME_OVERRIDE
      else process.env.LINDELA_LITE_UPTIME_OVERRIDE = previous
    }
  })

  it('still honours the explicit override', () => {
    const previous = process.env.LINDELA_LITE_UPTIME_OVERRIDE
    process.env.LINDELA_LITE_UPTIME_OVERRIDE = '97.5'
    try {
      assert.equal(computeApiUptime(), 97.5)
    } finally {
      if (previous === undefined) delete process.env.LINDELA_LITE_UPTIME_OVERRIDE
      else process.env.LINDELA_LITE_UPTIME_OVERRIDE = previous
    }
  })
})

// ---------------------------------------------------------------- VER-06

describe('VER-06 — a record with no id is not a duplicate of the next one', () => {
  // Turkana's centre, so proximity puts every record in the district.
  const AT = { latitude: 3.1167, longitude: 35.6 }

  it('counts every un-keyed record instead of collapsing them to one', () => {
    const data = {
      field_reports: [
        { ...AT, summary: 'first' },
        { ...AT, summary: 'second' },
        { ...AT, summary: 'third' },
      ],
    }
    const overview = districtOverview(data, 'turkana')
    // `seen.add(undefined)` on the first record made every later id-less record
    // look like a repeat, so a district with 40 un-keyed field reports showed 1.
    assert.equal(overview.counts.field_reports, 3)
  })

  it('still de-duplicates records that do carry the same id', () => {
    const data = {
      field_reports: [
        { ...AT, id: 'fr-1', summary: 'once' },
        { ...AT, id: 'fr-1', summary: 'twice' },
        { ...AT, id: 'fr-2', summary: 'other' },
      ],
    }
    const overview = districtOverview(data, 'turkana')
    assert.equal(overview.counts.field_reports, 2)
  })

  it('counts an un-keyed record alongside keyed ones', () => {
    const data = {
      field_reports: [
        { ...AT, id: 'fr-1' },
        { ...AT },
        { ...AT },
        { ...AT, id: 'fr-1' },
      ],
    }
    const overview = districtOverview(data, 'turkana')
    assert.equal(overview.counts.field_reports, 3)
  })
})

// ---------------------------------------------------------------- QUA-07

describe('QUA-07 — a limit that is not a number is refused, not silently empty', () => {
  const RECORDS = Array.from({ length: 12 }, (_, i) => ({ id: `r-${String(i).padStart(2, '0')}` }))

  it('refuses a non-numeric limit with a 400 instead of an empty page', () => {
    // `Number('abc')` is NaN and `slice(0, NaN)` is `[]`, so this used to answer
    // with a page byte-for-byte identical to an empty collection.
    for (const bad of ['abc', '12abc', 'NaN', 'Infinity', '-Infinity', '1,000']) {
      assert.throws(
        () => collectionPage(RECORDS, new URLSearchParams({ limit: bad })),
        (err) => err.statusCode === 400 && /limit must be a number/.test(err.message),
        `limit=${JSON.stringify(bad)} must be refused`,
      )
    }
  })

  it('treats a blank limit as absent, the way toNumber treats a blank number', () => {
    // `Number(' ')` is 0, which read as "one record" — a page of one from a
    // parameter that named no size at all.
    assert.equal(parseLimit(' '), DEFAULT_LIMIT)
    assert.equal(collectionPage(RECORDS, new URLSearchParams({ limit: ' ' })).data.length, 12)
  })

  it('refuses it on every route that pages, not just the first one', () => {
    // Two coercion sites existed — `filterRecords` and `matchedAndPage`. A fix
    // applied to one leaves the other answering with silence.
    assert.throws(
      () => matchedAndPage(RECORDS, new URLSearchParams({ limit: 'abc' })),
      (err) => err.statusCode === 400,
    )
    assert.throws(
      () => filterRecords(RECORDS, new URLSearchParams({ limit: 'abc' })),
      (err) => err.statusCode === 400,
    )
  })

  it('keeps the default when no limit is asked for', () => {
    assert.equal(parseLimit(null), DEFAULT_LIMIT)
    assert.equal(parseLimit(undefined), DEFAULT_LIMIT)
    assert.equal(parseLimit(''), DEFAULT_LIMIT)
    const page = collectionPage(RECORDS, new URLSearchParams({}))
    assert.equal(page.limit, DEFAULT_LIMIT)
    assert.equal(page.total, 12)
  })

  it('clamps a raised limit rather than materialising the table', () => {
    assert.equal(parseLimit('999999'), MAX_LIMIT)
    assert.equal(collectionPage(RECORDS, new URLSearchParams({ limit: '999999' })).limit, MAX_LIMIT)
  })

  it('floors a limit that asks for nothing, and truncates a fraction', () => {
    assert.equal(parseLimit('0'), 1)
    assert.equal(parseLimit('-5'), 1)
    assert.equal(parseLimit('2.9'), 2)
    assert.equal(collectionPage(RECORDS, new URLSearchParams({ limit: '0' })).data.length, 1)
  })

  it('accepts a limit written as a numeric string, because query values are strings', () => {
    assert.equal(parseLimit('7'), 7)
    assert.equal(collectionPage(RECORDS, new URLSearchParams({ limit: '7' })).data.length, 7)
  })
})

// ---------------------------------------------------------------- SCL-03

describe('SCL-03 filterRecords walks the collection once, not once per filter', () => {
  /**
   * An array that counts the passes made over it.
   *
   * The old implementation chained eighteen `.filter()` calls, so a 4,517-row
   * collection was copied into eighteen intermediate arrays and seventeen of
   * them thrown away, even when a selective early filter left three rows. The
   * *result* is identical either way, so a behavioural test cannot see the
   * cost; the instrumentation has to survive the chain, which is what the
   * `Symbol.species` override is for — `Array.prototype.filter` constructs its
   * result from `this.constructor[Symbol.species]`, so every intermediate array
   * is another `Counted` and keeps counting.
   */
  class Counted extends Array {
    static get [Symbol.species]() { return Counted }
    static stats = { passes: 0, visits: 0 }
    static reset() { Counted.stats = { passes: 0, visits: 0 } }
    filter(...args) {
      Counted.stats.passes += 1
      Counted.stats.visits += this.length
      return super.filter(...args)
    }
  }

  const fixture = () => Counted.from(Array.from({ length: 200 }, (_, i) => ({
    id: `r${i}`,
    district: 'Nairobi',
    country: i < 10 ? 'KE' : 'UG',
    source: 'gdacs',
    status: 'open',
    created_at: '2026-08-01T00:00:00.000Z',
  })))

  it('makes one pass over the collection, not one per active filter', () => {
    Counted.reset()
    const query = new URLSearchParams({
      district: 'Nairobi', country: 'KE', source: 'gdacs', status: 'open',
      from: '2026-07-01', to: '2026-09-01', limit: '10',
    })
    const result = filterRecords(fixture(), query, {})
    assert.equal(result.length, 10)
    assert.equal(
      Counted.stats.passes, 0,
      `${Counted.stats.passes} intermediate arrays were allocated for one request`,
    )
    assert.ok(Counted.stats.visits < 200 * 4, `each record was visited ${Counted.stats.visits / 200} times`)
  })

  it('returns the same records the chain of filters did', () => {
    const query = new URLSearchParams({ country: 'KE', status: 'open', limit: '5' })
    const result = filterRecords(fixture(), query, {})
    assert.deepEqual(result.map((r) => r.id), ['r0', 'r1', 'r2', 'r3', 'r4'])

    const none = filterRecords(fixture(), new URLSearchParams({ country: 'UG', status: 'closed' }), {})
    assert.deepEqual(none, [], 'a combination with no rows must return none')
  })

  it('applies every filter, not just the last', () => {
    // The composition could pass a test that only exercises one predicate and
    // still drop one silently; this drives them together and removes them one
    // at a time.
    const mixed = [
      { id: 'a', country: 'KE', status: 'open', severity: 'high' },
      { id: 'b', country: 'KE', status: 'closed', severity: 'high' },
      { id: 'c', country: 'UG', status: 'open', severity: 'high' },
      { id: 'd', country: 'KE', status: 'open', severity: 'low' },
    ]
    const ids = (params) => filterRecords(mixed, new URLSearchParams(params), {}).map((r) => r.id)
    assert.deepEqual(ids({ country: 'KE' }), ['a', 'b', 'd'])
    assert.deepEqual(ids({ country: 'KE', status: 'open' }), ['a', 'd'])
    assert.deepEqual(ids({ country: 'KE', status: 'open', severity: 'high' }), ['a'])
    assert.deepEqual(ids({ severity: 'high' }), ['a', 'b', 'c'])
  })
})
