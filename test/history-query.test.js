import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { observationSeries, recordHistory, projectableCollections, HISTORY_PRUNE_KEEP } from '../src/series.js'

/**
 * ENH-49 — the bitemporal history existed and nothing could reach it.
 *
 * The store keeps every superseded value with the interval it was believed for,
 * and two functions to read it: `valueAsOf` ("what did the platform hold on this
 * date") and `versionsFor` ("what has this been edited through"). Both had zero
 * production callers. So "the 2019 cholera count disagrees with the report" was
 * a question the repository could hold the answer to and not give out.
 *
 * The projection is over the bitemporal collections only, and that exclusion is
 * the test's first assertion: a field report is an event, not a state the
 * platform held and later changed, and projecting it as though it were would
 * invent a history of edits nobody made.
 *
 * The second assertion is the one that matters operationally. `pruneVersions`
 * keeps five revisions per record, so this answers the recent past — and a
 * series that quietly stops in 2019 reads as "the platform believed nothing
 * then", which is the one claim this must never make.
 */

async function withSeededStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-enh49-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  // Three states of one hazard: first filed with no fatalities, then corrected
  // twice. Three distinct believed-for intervals, which is what a history is.
  await store.merge({
    hazard_events: [{
      id: 'h1', district: 'Turkana', event_type: 'flood', observed_at: '2024-03-01',
      first_seen_at: '2024-03-02T00:00:00Z',
    }],
  })
  await store.merge({
    hazard_events: [{
      id: 'h1', district: 'Turkana', event_type: 'flood', observed_at: '2024-03-01',
      fatalities: 4, first_seen_at: '2024-03-05T00:00:00Z',
    }],
  })
  await store.merge({
    hazard_events: [{
      id: 'h1', district: 'Turkana', event_type: 'flood', observed_at: '2024-03-01',
      fatalities: 7, first_seen_at: '2024-03-09T00:00:00Z',
    }],
  })
  try {
    return await fn(store, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-enh49-http-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.merge({
    hazard_events: [{ id: 'h1', district: 'Turkana', event_type: 'flood', observed_at: '2024-03-01', first_seen_at: '2024-03-02T00:00:00Z' }],
    field_reports: [{ id: 'f1', district: 'Turkana', type: 'field_report', created_at: '2024-03-02T00:00:00Z' }],
  })
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('ENH-49 — the series is over states, not events', () => {
  it('a collection with no observation history is refused, with the reason', () => {
    const series = observationSeries({ field_reports: [{ id: 'f1' }] }, { collection: 'field_reports' })
    assert.equal(series.projectable, false)
    assert.match(series.reason, /events, not states/,
      'a refusal that does not say why is a refusal the next caller will re-litigate')
    assert.deepEqual(series.points, [])
    assert.ok(Array.isArray(series.projectable_collections) && series.projectable_collections.length > 0,
      'and the list of what *is* projectable, so a client is not left guessing')
  })

  it('the bitemporal collections are projectable', () => {
    assert.ok(projectableCollections().includes('hazard_events'))
    assert.ok(projectableCollections().includes('climate_observations'))
    assert.ok(!projectableCollections().includes('field_reports'))
  })
})

describe('ENH-49 — what the platform believed, and when it stopped believing it', () => {
  it('assembles superseded values and the live one into one series', async () => {
    await withSeededStore(async (store) => {
      const series = observationSeries(await store.read(), { collection: 'hazard_events', district: 'Turkana' })
      assert.equal(series.points.length, 3, 'two superseded values and the current one')
      assert.deepEqual(series.points.map((p) => p.source), ['history', 'history', 'current'])
      assert.equal(series.points[series.points.length - 1].body.fatalities, 7, 'the current value is the last one')
      assert.equal(series.points[0].body.fatalities, undefined, 'and the first is the value the platform started with')
    })
  })

  it('the interval a value was believed for is stated, not implied', async () => {
    await withSeededStore(async (store) => {
      const series = observationSeries(await store.read(), { collection: 'hazard_events' })
      for (const point of series.points) {
        assert.ok(point.believed_from, 'a point with no start reads as timeless, which is the misreading this avoids')
      }
      const first = series.points[0]
      assert.ok(first.believed_to, 'a superseded value must say when it stopped being believed')
      assert.equal(series.points[series.points.length - 1].believed_to, null, 'and the live one has not stopped')
    })
  })

  it('says what history it does not have', async () => {
    await withSeededStore(async (store) => {
      const series = observationSeries(await store.read(), { collection: 'hazard_events' })
      assert.equal(series.coverage.revisions_kept_per_record, HISTORY_PRUNE_KEEP)
      assert.equal(series.coverage.history_points, 2)
      assert.equal(series.coverage.current_points, 1)
      assert.match(series.coverage.note, /pruned/,
        'the cap is a property of the store and a series that stops without saying so reads ' +
        'as a period when the platform knew nothing')
    })
  })

  it('a record with no history says that too', () => {
    const history = recordHistory({ record_versions: [] }, { collection: 'hazard_events', recordId: 'h9' })
    assert.equal(history.revisions, 0)
    assert.match(history.coverage.note, /never been revised/)
    assert.equal(history.current, null, 'and does not invent a current value it does not have')
  })
})

describe('ENH-49 — the query, over HTTP', () => {
  it('answers "what did this district look like, and when"', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/history/hazard_events?district=Turkana`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.data.projectable, true)
      assert.equal(body.data.points.length, 1)
      assert.equal(body.data.points[0].source, 'current')
    })
  })

  it('answers "what did it hold on this date" for one record', async () => {
    await withServer(async (base, store) => {
      // Revise, then ask for the value as it stood before the correction.
      await store.merge({
        hazard_events: [{
          id: 'h1', district: 'Turkana', event_type: 'flood', observed_at: '2024-03-01',
          fatalities: 9, first_seen_at: '2024-03-20T00:00:00Z',
        }],
      })
      const res = await fetch(`${base}/api/v1/history/hazard_events?at=2024-03-05`)
      const body = await res.json()
      assert.ok(body.data.as_of, 'the platform held something on that date and said nothing')
      assert.equal(body.data.as_of.body.fatalities, undefined,
        'and it held the *earlier* value — the correction came later')
    })
  })

  it('a date the platform held nothing for is absent, not zero', async () => {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/v1/history/hazard_events?at=2019-01-01`)).json()
      assert.equal(body.data.as_of, null,
        'an absent answer is the honest one; zero would be a claim about a period it never saw')
    })
  })

  it('a district with no records is an empty series, not an error', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/history/hazard_events?district=Nowhere`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body.data.points, [])
      assert.equal(body.data.earliest_believed ?? body.data.coverage.earliest_believed, null)
    })
  })
})
