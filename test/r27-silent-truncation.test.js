import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * R-27 — two routes truncated silently and said nothing about it.
 *
 * `/api/v1/food-security` and `/api/v1/disease-observations` returned
 * `filterRecords(...)` directly rather than through `collectionPage`, so their
 * responses carried a `data` array with no `total`, no `has_more` and no
 * `next_cursor`. `filterRecords` caps at 500 by default, which is correct for a
 * filter and wrong for a list endpoint: against the demo store these two routes
 * returned **500 of 4,517** and **500 of 1,707** records, and a caller had no
 * way to tell that from a collection that genuinely held 500. The only way
 * onward was to raise `limit` by hand — the second full scan that
 * `collectionPage`'s own docstring says this shape exists to end.
 *
 * The second half is the worse one. Both routes computed their roll-up from the
 * capped page, so `summary` described whatever happened to fit rather than what
 * matched. `/disease-observations/summary` carries a comment saying the series
 * states "must not be computed over an arbitrary page of the collection" — and
 * the list route beside it was computing them over one.
 *
 * The tests below assert the shape, not the timing. Keyset pagination in SQL is
 * ENH-09 and is deliberately not started: the audit re-measured it at 6.96 ms,
 * flat in page depth, for the largest collection *any paginated route can
 * actually reach*. This is the correctness half, and it is a different defect.
 */

let store
let listener
let base

/**
 * Records spread across countries and indicators, because that is what makes
 * the roll-up half of this observable.
 *
 * Both summarisers *deduplicate* — `summarizeFoodSecurity` keeps the latest
 * record per country, `summarizeDiseaseObservations` the latest year per
 * indicator — so a roll-up computed over a 50-row page of a 1,200-row
 * collection simply omits most of the countries and indicators. The earlier
 * draft of this file asserted on a record `count` that neither summariser
 * emits; the property worth testing is that no country or indicator goes
 * missing because it fell outside the page.
 */
const COUNTRIES = ['KE', 'SS', 'ET', 'SO', 'UG', 'TZ', 'RW', 'SD']

/**
 * `validity_period: 'current'` and `indicator_code` are load-bearing, not
 * decoration: `summarizeFoodSecurity` drops anything not marked current before
 * it rolls up, so a seed without it produces an empty roll-up and every
 * assertion below would pass for the wrong reason. `valid_from` varies per
 * record so the "latest window wins" comparison has something to choose between.
 */
const foodRecords = (n) => Array.from({ length: n }, (_, i) => ({
  id: `fs-${i}`,
  scope: 'country',
  country: COUNTRIES[i % COUNTRIES.length],
  validity_period: 'current',
  phase3plus_number: 1000 + i,
  phase3plus_fraction: 0.1,
  analysis_date: '2026-01-01',
  valid_from: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
  observed_at: '2026-01-01T00:00:00.000Z',
}))

const diseaseRecords = (n) => Array.from({ length: n }, (_, i) => ({
  id: `do-${i}`,
  indicator_code: `IND-${i % 8}`,
  country: COUNTRIES[i % COUNTRIES.length],
  year: 2020 + (i % 5),
  value: i + 1,
  unit: 'cases',
  observed_at: '2026-01-01T00:00:00.000Z',
}))

const get = async (path, init) => {
  const res = await fetch(`${base}${path}`, init)
  return { status: res.status, body: await res.json() }
}

let dir

before(async () => {
  // A real temp directory, not `':memory:'` — `JsonStore` takes a file path and
  // has no in-memory mode, so that string created a file literally named
  // `:memory:` in the repository root on the first run of this file.
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r27-'))
  store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({
    food_security_records: foodRecords(1200),
    disease_observations: diseaseRecords(900),
  })
  listener = createServer({ store }).listen(0)
  base = `http://localhost:${listener.address().port}`
})

after(async () => {
  listener?.close()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

describe('a truncated list says so', () => {
  it('reports the whole matched set, not just the page', async () => {
    const { body } = await get('/api/v1/food-security')
    assert.equal(body.success, true)
    assert.equal(body.returned, 500, 'the default page is 500')
    assert.equal(body.total, 1200, 'total must describe what matched, not what fitted')
    assert.equal(body.has_more, true, '4017 records were being dropped without a word')
    assert.ok(body.next_cursor, 'a truncated page must carry a cursor')
  })

  it('the cursor reaches the records the first page could not', async () => {
    // The point of `next_cursor`. Without it the only route onward was raising
    // `limit` by hand, which is the second full scan this shape exists to end.
    const first = await get('/api/v1/food-security')
    const second = await get(`/api/v1/food-security?cursor=${encodeURIComponent(first.body.next_cursor)}`)
    assert.equal(second.status, 200)
    assert.equal(second.body.returned, 500)
    assert.equal(second.body.total, 1200, 'total is a property of the query, not of the page')

    const firstIds = new Set(first.body.data.map((r) => r.id))
    const overlap = second.body.data.filter((r) => firstIds.has(r.id))
    assert.equal(overlap.length, 0, 'the second page replayed records from the first')
    // Sorted by the store, so the first page is `fs-0`..`fs-499` only if the
    // ordering is total. Asserting on the boundary id would be asserting on the
    // sort cascade; asserting that page two starts where page one stopped is
    // the property that matters.
    assert.equal(second.body.returned, 500)
    assert.equal(second.body.data.length, 500)
  })

  it('paging to the end visits every record exactly once', async () => {
    const seen = new Set()
    let cursor = null
    let guard = 0
    do {
      const query = new URLSearchParams({ limit: '250' })
      if (cursor) query.set('cursor', cursor)
      const { status, body } = await get(`/api/v1/food-security?${query}`)
      assert.equal(status, 200)
      for (const r of body.data) {
        assert.ok(!seen.has(r.id), `page overlap on ${r.id}`)
        seen.add(r.id)
      }
      cursor = body.next_cursor
      guard += 1
    } while (cursor && guard < 20)

    assert.equal(seen.size, 1200, `visited ${seen.size} of 1200 records`)
    assert.equal(cursor, null, 'paging ended without exhausting the set')
  })

  it('a collection that fits says has_more false and no cursor', async () => {
    const { body } = await get('/api/v1/disease-observations?limit=5000')
    assert.equal(body.total, 900)
    assert.equal(body.returned, 900)
    assert.equal(body.has_more, false)
    assert.equal(body.next_cursor, null, 'a cursor to the end invites one more empty request')
  })

  it('a genuinely small collection is indistinguishable from a complete one', async () => {
    // The empty-vs-truncated distinction is only worth anything if a complete
    // set still looks complete. Seeding three rows and checking total === 3 is
    // the negative control on the tests above.
    await store.merge({ disease_observations: [{ id: 'do-solo', indicator_code: 'IND-0', country: 'KE', year: 2026, value: 1, unit: 'cases', observed_at: '2026-02-01T00:00:00.000Z' }] })
    try {
      const { body } = await get('/api/v1/disease-observations?limit=5000')
      assert.ok(body.total >= 1)
      assert.equal(body.returned, body.total, 'nothing was dropped, so nothing is withheld')
    } finally {
      await store.write({
        food_security_records: foodRecords(1200),
        disease_observations: diseaseRecords(900),
      })
    }
  })

  it('an empty result is an honest zero', async () => {
    const { body } = await get('/api/v1/food-security?country=ZZ')
    assert.equal(body.total, 0)
    assert.equal(body.returned, 0)
    assert.equal(body.has_more, false)
    assert.deepEqual(body.data, [])
    // And the roll-up over nothing is a roll-up over nothing, not a crash or a
    // leftover from the previous request's matched set. `summarizeFoodSecurity`
    // has no `count` — it reports `countries` and `worst_areas`, which is why
    // the earlier draft of this file's assertion on `summary.count` was wrong
    // in two ways at once.
    assert.deepEqual(body.summary.countries, [])
    assert.deepEqual(body.summary.worst_areas, [])
  })
})

describe('the roll-up describes the whole matched set', () => {
  it('food-security: every country appears, whatever the page size', async () => {
    // 8 countries × 150 records = 1,200. A roll-up computed over a 50-row page
    // covers roughly the first four countries and silently omits the rest — and
    // the caller reading `summary.countries` cannot tell, because the field
    // carries no note about what it was computed from.
    const { body } = await get('/api/v1/food-security?limit=50')
    assert.equal(body.returned, 50, 'the page is deliberately smaller than the roll-up needs')

    const viaList = body.summary.countries.map((c) => c.country).sort()
    assert.equal(viaList.length, COUNTRIES.length,
      `the roll-up covered ${viaList.length} of ${COUNTRIES.length} countries — it was computed over the page`)
    assert.deepEqual(viaList, [...COUNTRIES].sort())
  })

  it('food-security: the roll-up does not change with the page size', async () => {
    // The signature of a page-computed roll-up: the same records, a different
    // `limit`, a different answer.
    const small = await get('/api/v1/food-security?limit=10')
    const large = await get('/api/v1/food-security?limit=5000')
    assert.equal(small.body.summary.countries.length, large.body.summary.countries.length,
      'the roll-up moved with the page size')
    assert.deepEqual(
      small.body.summary.countries.map((c) => c.country).sort(),
      large.body.summary.countries.map((c) => c.country).sort(),
    )
    assert.deepEqual(small.body.summary.worst_areas, large.body.summary.worst_areas)
  })

  it('food-security: the list roll-up agrees with /summary about the same records', async () => {
    // Two routes answering the same question must answer it the same way. The
    // /summary route always reads the whole store, so it is the control.
    const viaList = await get('/api/v1/food-security?limit=50')
    const viaSummary = await get('/api/v1/food-security/summary')
    assert.deepEqual(
      viaList.body.summary.countries.map((c) => c.country).sort(),
      viaSummary.body.data.countries.map((c) => c.country).sort(),
      'the list roll-up and the /summary roll-up disagree about the same records',
    )
    assert.deepEqual(viaList.body.summary.worst_areas, viaSummary.body.data.worst_areas)
  })

  it('disease-observations: every indicator series appears, whatever the page size', async () => {
    // 8 indicators × 900 records. `series_state` carries one entry per indicator
    // code, so a page-computed roll-up drops whichever indicators fell past the
    // page edge — and the remaining ones look complete.
    const { body } = await get('/api/v1/disease-observations?limit=50')
    assert.equal(body.returned, 50)
    const codes = body.summary.series_state.map((s) => s.indicator_code).sort()
    assert.equal(codes.length, 8, `series_state covered ${codes.length} of 8 indicators — computed over the page`)
    assert.equal(new Set(codes).size, 8)
  })

  it('disease-observations: the series roll-up does not change with the page size', async () => {
    const small = await get('/api/v1/disease-observations?limit=10')
    const large = await get('/api/v1/disease-observations?limit=5000')
    assert.deepEqual(
      small.body.summary.series_state.map((s) => `${s.indicator_code}:${s.latest_year}`).sort(),
      large.body.summary.series_state.map((s) => `${s.indicator_code}:${s.latest_year}`).sort(),
      'the series states moved with the page size',
    )
    const viaSummary = await get('/api/v1/disease-observations/summary')
    assert.deepEqual(
      small.body.summary.series_state.map((s) => `${s.indicator_code}:${s.latest_year}`).sort(),
      viaSummary.body.data.series_state.map((s) => `${s.indicator_code}:${s.latest_year}`).sort(),
      'the list series states and the /summary series states disagree',
    )
  })

  it('a filtered roll-up describes the filtered set', async () => {
    // The other half of the property: computing from `matched` rather than the
    // page must not mean computing from the unfiltered store. Filtering to one
    // country has to narrow the roll-up too.
    const { body } = await get('/api/v1/food-security?country=KE&limit=50')
    assert.equal(body.total, 150, 'KE has one of every eight records')
    assert.deepEqual(body.summary.countries.map((c) => c.country), ['KE'])
  })

  it('the console keeps working against the paged route', async () => {
    // `public/app.js` reads `?limit=5000` and expects `data` to be the array.
    // The shape is additive — `total` and friends sit beside `data` — so a
    // client that ignored them before still works. This pins that contract,
    // because making these routes paginated could easily have moved the array.
    const { body } = await get('/api/v1/food-security?limit=5000')
    assert.ok(Array.isArray(body.data), 'data must still be the array clients already read')
    assert.equal(body.data.length, 1200)
    assert.equal(typeof body.summary, 'object')
  })
})
