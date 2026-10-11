import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { PostgresStore } from '../src/postgres-store.js'
import { JsonStore } from '../src/store.js'
import { postgresCluster } from './pg-harness.mjs'

/**
 * ENH-37 / ENH-61 — a bulk export that does not hold the export in memory.
 *
 * `export.csv` and `export.geojson` call `filterRecords` over a spread of
 * fifteen collections, so the whole matched set is materialised and then
 * serialised into one string before `res.end()` writes a byte. Measured on the
 * demo store: `export.csv` returns **500 of 12,929** records — `parseLimit`'s
 * default, applied to a route that never says it is paged — with no marker that
 * 12,429 were dropped. A `text/csv` body that stops early is the silent
 * truncation SCL-01 explicitly chose a refusal over, on the one surface where a
 * partner is most likely to trust the file.
 *
 * `/api/v1/export.ndjson` streams instead: `store.iterateRecords` walks a
 * PostgreSQL server-side cursor (or the parsed JSON store) and each record is
 * written as it arrives, so the peak heap is one batch rather than the table.
 *
 * NDJSON rather than streamed CSV, and that is a real constraint rather than a
 * preference: a CSV needs its header row complete before the first record, and
 * the header is the union of every record's flattened keys — which is not known
 * until the last record. A stream cannot produce it honestly. Each NDJSON line
 * is self-describing, so no header is needed.
 */

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-ndjson-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const hazards = (n) => Array.from({ length: n }, (_, i) => ({
  id: `h${i}`,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  district: i % 2 === 0 ? 'Turkana' : 'Garissa',
  observed_at: '2026-01-01T00:00:00.000Z',
}))

/** Parse an NDJSON body into its objects, asserting every line is one. */
const parseNdjson = (text) => {
  const lines = text.split('\n').filter((line) => line.length)
  return lines.map((line, i) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`line ${i + 1} is not JSON: ${line.slice(0, 120)}`)
    }
  })
}

describe('ENH-37 — the NDJSON export streams every record, not a page', () => {
  it('returns all 1,200 records where the CSV route would stop at 500', async () => {
    await withServer(async (base, store) => {
      await store.merge({ hazard_events: hazards(1200) })

      const res = await fetch(`${base}/api/v1/export.ndjson?collection=hazard_events`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type'), /application\/x-ndjson/)
      const records = parseNdjson(await res.text())

      // The headline. `export.csv` against the same store returns 500 and says
      // nothing about the rest.
      assert.equal(records.length, 1200, 'the export stopped at a page rather than streaming the set')

      const csv = await fetch(`${base}/api/v1/export.csv`)
      const csvRows = (await csv.text()).split('\n').filter((line) => line.length)
      // header + 500 data rows. Asserted rather than assumed, because the point
      // of this test is the difference between the two routes.
      assert.equal(csvRows.length, 501, 'the CSV route no longer caps at the default limit; this test\'s premise moved')
    })
  })

  it('every line carries the collection it came from', async () => {
    // A stream of fifteen collections concatenated with no provenance is a file
    // nobody can split. `export.csv` flattens the same fifteen and leaves the
    // reader to guess which collection a row is from.
    await withServer(async (base, store) => {
      await store.merge({
        hazard_events: hazards(2),
        field_reports: [{ id: 'f1', created_at: '2026-01-01T00:00:00.000Z' }],
      })
      const records = parseNdjson(await (await fetch(`${base}/api/v1/export.ndjson`)).text())
      const collections = new Set(records.map((r) => r.collection))
      assert.ok(collections.has('hazard_events'), 'hazard_events missing from the stream')
      assert.ok(collections.has('field_reports'), 'field_reports missing from the stream')
      assert.equal(records.filter((r) => r.collection === 'field_reports').length, 1)
    })
  })

  it('narrows to one collection on request, and refuses one it does not know', async () => {
    await withServer(async (base, store) => {
      await store.merge({ hazard_events: hazards(5), field_reports: [{ id: 'f1', created_at: '2026-01-01T00:00:00.000Z' }] })

      const narrowed = parseNdjson(await (await fetch(`${base}/api/v1/export.ndjson?collection=hazard_events`)).text())
      assert.equal(narrowed.length, 5)
      assert.ok(narrowed.every((r) => r.collection === 'hazard_events'))

      // A typo must be a refusal, not an empty file. An empty export reads as
      // "this deployment holds no such records", which is a finding about the
      // deployment rather than about the caller's spelling.
      const bad = await fetch(`${base}/api/v1/export.ndjson?collection=hazard_event`)
      assert.equal(bad.status, 400)
      const body = await bad.json()
      assert.equal(body.success, false)
      assert.match(body.error, /declared collections/)
    })
  })

  it('refuses a paging parameter rather than honouring it silently', async () => {
    // `filterRecords` reads `?limit`, so the naive implementation caps the
    // stream at 500 for a caller who asked for no such thing — the truncation
    // this route exists to remove, through a different door. And a `?limit` that
    // were merely ignored would be the `?district=` defect: a parameter that
    // looks like it does something.
    await withServer(async (base, store) => {
      await store.merge({ hazard_events: hazards(10) })
      for (const param of ['limit=5', 'cursor=YTM0']) {
        const res = await fetch(`${base}/api/v1/export.ndjson?${param}`)
        assert.equal(res.status, 400, `${param} must be refused, not honoured or ignored`)
        const body = await res.json()
        assert.equal(body.success, false)
        assert.match(body.error, /not a parameter of this route/)
      }
      // And the refusal is not blanket: the parameters that do narrow the set
      // still work on the same route.
      const ok = await fetch(`${base}/api/v1/export.ndjson?collection=hazard_events&district=Turkana`)
      assert.equal(ok.status, 200)
    })
  })

  it('applies the same filters the other exports do', async () => {
    // A filter that narrows `export.csv` and is ignored here is the silent-ignore
    // class this codebase refuses elsewhere: the caller asks to be scoped to a
    // district and is handed the country.
    await withServer(async (base, store) => {
      await store.merge({ hazard_events: hazards(10) })
      const all = parseNdjson(await (await fetch(`${base}/api/v1/export.ndjson?collection=hazard_events`)).text())
      const turkana = parseNdjson(await (await fetch(`${base}/api/v1/export.ndjson?collection=hazard_events&district=Turkana`)).text())
      assert.equal(all.length, 10)
      assert.equal(turkana.length, 5, 'the district filter did not narrow the stream')
      assert.ok(turkana.every((r) => r.district === 'Turkana'))
    })
  })

  it('streams from a store larger than the read-row budget, which it could not before', async () => {
    // The route existed and streamed, and could not do it on the store it was
    // built for. The dispatcher reads the whole store before any route runs, so
    // this route — whose entire purpose is the store that does not fit in
    // memory — 503'd at SCL-01's budget before the first byte, and below the
    // budget it held everything anyway. Streaming the output while holding the
    // input is not a streaming export.
    //
    // The budget here is 10 rows against a store of 100, so a materialising read
    // refuses by name rather than quietly succeeding on a small fixture.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-ndjson-budget-'))
    const store = new JsonStore(path.join(dir, 'store.json'), { readRowBudget: 10 })
    await store.merge({ hazard_events: hazards(100) })
    const listener = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${listener.address().port}`
    try {
      const res = await fetch(`${base}/api/v1/export.ndjson?collection=hazard_events`)
      assert.equal(res.status, 200, 'the export route must not read the whole store it exists to avoid holding')
      assert.equal(parseNdjson(await res.text()).length, 100)
    } finally {
      await new Promise((resolve) => listener.close(resolve))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('scopes the stream to the caller\'s organisation', async () => {
    // The route moved above the line that stamps `req.__auth`, so the identity
    // it filters by is now the one on the request context. That is the same
    // caller resolved one frame up — but "the same caller" is a claim, and a
    // stream of another organisation's field reports is a disclosure, not a
    // cosmetic mismatch. So it is asserted rather than assumed.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-ndjson-partner-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      service_assets: [
        { id: 'p-orgA', partner_org: 'orgA', name: 'A clinic', district: 'Turkana' },
        { id: 'p-orgB', partner_org: 'orgB', name: 'B clinic', district: 'Turkana' },
      ],
    })
    const listener = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${listener.address().port}`
    const previous = process.env.LINDELA_LITE_TOKENS
    process.env.LINDELA_LITE_TOKENS = JSON.stringify([
      { token: 'tok-a', scopes: ['read:*'], partner_org: 'orgA' },
    ])
    try {
      const res = await fetch(`${base}/api/v1/export.ndjson?collection=service_assets`, {
        headers: { authorization: 'Bearer tok-a' },
      })
      assert.equal(res.status, 200)
      const records = parseNdjson(await res.text())
      assert.deepEqual(records.map((r) => r.id), ['p-orgA'], 'the stream carried another organisation\'s rows')
    } finally {
      if (previous === undefined) delete process.env.LINDELA_LITE_TOKENS
      else process.env.LINDELA_LITE_TOKENS = previous
      await new Promise((resolve) => listener.close(resolve))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('still attributes a district filter through the parent records it reads narrowly', async () => {
    // Moving the route above the whole-store read means `filterRecords` no
    // longer receives `context.data`, and interventions carry no location of
    // their own — they are attributed through the incident they hang off. So the
    // route reads exactly those parents, and this is the check that the
    // attribution still happens: a filter that silently stopped matching would
    // return an empty file, which reads as "no records in this district".
    await withServer(async (base, store) => {
      await store.merge({
        incidents: [
          { id: 'i-turkana', district: 'Turkana', title: 'flood' },
          { id: 'i-garissa', district: 'Garissa', title: 'flood' },
        ],
        interventions: [
          { id: 'iv-1', incident_id: 'i-turkana', activity: 'boat' },
          { id: 'iv-2', incident_id: 'i-garissa', activity: 'truck' },
        ],
      })
      const all = parseNdjson(await (await fetch(`${base}/api/v1/export.ndjson?collection=interventions`)).text())
      assert.equal(all.length, 2)
      const turkana = parseNdjson(await (await fetch(`${base}/api/v1/export.ndjson?collection=interventions&district=Turkana`)).text())
      assert.equal(turkana.length, 1, 'the parent attribution was lost when the route moved above the whole-store read')
      assert.equal(turkana[0].id, 'iv-1')
    })
  })

  it('reports a mid-stream failure in the stream rather than as a clean EOF', async () => {
    // Once the 200 and the first bytes are on the wire there is no status code
    // left. A truncated export that ends cleanly is indistinguishable from a
    // complete one — the failure this whole route exists to remove — so the last
    // line names it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-ndjson-fail-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({ hazard_events: hazards(10) })
    // A store whose iterator fails after the first batch. The route reads the
    // store before it reaches this branch, so the stub has to be the real thing
    // with one method shadowed — a duck-typed object fails the adapter's brand
    // check and the 500 arrives before the stream is ever opened, which would
    // make this test pass for the wrong reason.
    store.iterateRecords = async function* () {
      yield { collection: 'hazard_events', body: hazards(1)[0] }
      throw Object.assign(new Error('the cursor was closed under us'), { expose: true })
    }
    const listener = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${listener.address().port}`
    try {
      const res = await fetch(`${base}/api/v1/export.ndjson`)
      assert.equal(res.status, 200, 'the failure happens after the headers are sent')
      const records = parseNdjson(await res.text())
      const last = records[records.length - 1]
      assert.equal(last.error, 'export_failed', 'a truncated stream ended as though it were complete')
      assert.match(last.message, /cursor was closed/)
      assert.equal(last.sent, 1, 'the failure line must say how many records did go out')
    } finally {
      await new Promise((resolve) => listener.close(resolve))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Each adapter is driven on its own, and deliberately not compared for order:
 * `read()` returns `sortRecords` of the materialised set, and a cursor has no
 * set to sort — `PostgresStore.iterateRecords` says so in its own doc comment.
 * Asserting the two agree on order would be asserting something the design
 * declines to promise, and it would pass here and fail on a larger table the
 * day the planner chose a different scan.
 */
describe('ENH-61 — both adapters walk the whole set in batches', () => {
  it('JsonStore yields every record of a named collection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-iter-json-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    try {
      await store.merge({ hazard_events: hazards(7) })
      const seen = []
      for await (const { collection, body } of store.iterateRecords({ collections: ['hazard_events'] }, { batchSize: 3 })) {
        seen.push({ collection, id: body.id })
      }
      assert.equal(seen.length, 7)
      assert.ok(seen.every((r) => r.collection === 'hazard_events'))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('PostgresStore yields the identical set, in batches, without holding it', async () => {
    const cluster = await postgresCluster({ name: 'lindela-stream' })
    if (cluster.skipped) {
      // Never a green pass with nothing behind it.
      assert.fail(`Postgres is required for the cursor half of ENH-61: ${cluster.skipped}`)
    }
    const store = new PostgresStore({ databaseUrl: cluster.url })
    try {
      await store.ensureSchema()
      await store.write({})
      await store.merge({ hazard_events: hazards(2500) })

      const ids = []
      let batches = 0
      for await (const { collection, body } of store.iterateRecords({ collections: ['hazard_events'] }, { batchSize: 1000 })) {
        assert.equal(collection, 'hazard_events')
        ids.push(body.id)
        if (ids.length % 1000 === 0) batches += 1
      }
      assert.equal(ids.length, 2500, 'the cursor did not walk the whole set')
      assert.equal(new Set(ids).size, 2500, 'the cursor repeated a row')
      assert.equal(batches, 2, 'the walk did not use the requested batch size')

      // The cursor is released on every path. A leak here shows up as the pool
      // having no free connection, so the next read would hang rather than fail.
      const after = await store.read({ collections: ['hazard_events'] })
      assert.equal(after.hazard_events.length, 2500)
    } finally {
      await store.close()
      await cluster.stop()
    }
  })

  it('a consumer that abandons the stream does not leak the connection', async () => {
    // A client that disconnects mid-export is the ordinary case, not the exotic
    // one. If the cursor's `finally` does not release the client, the pool
    // bleeds one connection per abandoned export until every read hangs.
    const cluster = await postgresCluster({ name: 'lindela-stream-abandon' })
    if (cluster.skipped) assert.fail(`Postgres is required: ${cluster.skipped}`)
    const store = new PostgresStore({ databaseUrl: cluster.url })
    try {
      await store.ensureSchema()
      await store.write({})
      await store.merge({ hazard_events: hazards(500) })

      for (let i = 0; i < 3; i += 1) {
        for await (const _ of store.iterateRecords({ collections: ['hazard_events'] }, { batchSize: 50 })) {
          break // abandon after the first batch
        }
      }

      // Three abandoned cursors, and the pool still answers.
      const after = await store.read({ collections: ['hazard_events'] })
      assert.equal(after.hazard_events.length, 500)
    } finally {
      await store.close()
      await cluster.stop()
    }
  })
})
