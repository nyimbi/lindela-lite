import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { PostgresStore } from '../src/postgres-store.js'
import { JsonStore, StoreReadBudgetExceeded } from '../src/store.js'
import { postgresCluster } from './pg-harness.mjs'

/**
 * SCL-01 — a store read that would materialise unbounded rows refuses by name.
 *
 * `read()` builds a JS object of every row the query matched, so an unbounded
 * read is an unbounded heap allocation driven by whatever the database holds.
 * 91 routes reach it with no collection manifest at all, which means a request
 * that 404s on its first line still pays for the whole table — the audit
 * measured 39,715 rows and 143 MB.
 *
 * The interesting part is the failure mode, and it is why this is a refusal
 * rather than a `LIMIT`. A silently truncated read is the worst outcome
 * available: every aggregate over it is wrong, every "not found" is
 * indistinguishable from "not fetched", and the response is a 200 that reads as
 * success. So the read either returns everything it matched or it throws.
 *
 * The budget is a constructor option as well as an environment variable,
 * because a ceiling a test can only reach by inserting 200,000 rows is a
 * ceiling no test exercises.
 */

describe('SCL-01 a read over its row budget refuses rather than truncating', () => {
  let cluster
  let store

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-budget' })
    if (cluster.skipped) process.stderr.write(`read-budget: ${cluster.skipped}\n`)
    if (!cluster.skipped) {
      store = new PostgresStore({ databaseUrl: cluster.url, readRowBudget: 5 })
      await store.ensureSchema()
    }
  })

  after(async () => {
    await store?.close()
    await cluster?.stop()
  })

  const needs = (t) => {
    if (cluster.skipped) {
      t.skip(cluster.skipped)
      return true
    }
    return false
  }

  const hazard = (id) => ({
    id,
    event_type: 'flood',
    source: 'test',
    severity: 'moderate',
    observed_at: '2026-01-01T00:00:00.000Z',
  })

  it('serves a read inside the budget, and refuses one over it', async (t) => {
    if (needs(t)) return
    await store.write({})
    await store.merge({ hazard_events: [hazard('h1'), hazard('h2'), hazard('h3')] })

    // Inside: three rows against a budget of five.
    const within = await store.read({ collections: ['hazard_events'] })
    assert.equal(within.hazard_events.length, 3)

    await store.merge({ hazard_events: [hazard('h4'), hazard('h5'), hazard('h6')] })

    // Over: six rows against a budget of five. The refusal names the count, the
    // budget and the way out, because a 503 an operator cannot act on is a
    // 500 with a different number on it.
    await assert.rejects(
      () => store.read({ collections: ['hazard_events'] }),
      (error) => {
        assert.ok(error instanceof StoreReadBudgetExceeded, `expected a budget error, got ${error?.name}`)
        assert.equal(error.statusCode, 503)
        assert.equal(error.expose, true, 'the message must reach the caller rather than becoming "Internal server error"')
        assert.match(error.message, /matched 6 rows/)
        assert.match(error.message, /5-row budget/)
        assert.match(error.message, /narrow the request with a collection manifest/)
        return true
      },
    )
  })

  it('the budget counts rows across every named collection, not per collection', async (t) => {
    if (needs(t)) return
    // A per-collection budget would be a budget that never fires on a wide read
    // — which is exactly the read the audit measured. The manifest below names
    // two collections holding three rows each: under a per-collection reading
    // that is two reads of three, both inside a budget of five.
    await store.write({})
    await store.merge({
      hazard_events: [hazard('a1'), hazard('a2'), hazard('a3')],
      field_reports: [
        { id: 'f1', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'f2', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'f3', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    })
    await assert.rejects(
      () => store.read({ collections: ['hazard_events', 'field_reports'] }),
      StoreReadBudgetExceeded,
    )
  })

  it('a bare read is subject to the same budget', async (t) => {
    if (needs(t)) return
    // The 91 `WIDE_ROUTES` reach `read()` with `collections: null`. That path is
    // the one the audit measured at 143 MB, so it is the one the budget exists
    // for; a budget that only applied to manifest reads would guard the cheap
    // case.
    await store.write({})
    await store.merge({ hazard_events: [hazard('b1'), hazard('b2'), hazard('b3'), hazard('b4'), hazard('b5'), hazard('b6')] })
    await assert.rejects(() => store.read(), StoreReadBudgetExceeded)
  })

  it('a budget of zero is not read as "no limit"', async (t) => {
    if (needs(t)) return
    // The falsy-zero trap this codebase has hit before: `budget > 0` rejects a
    // zero and falls back to the default, which is the safe direction. This
    // asserts that a nonsense setting does not become an unbounded read.
    const zero = new PostgresStore({ databaseUrl: cluster.url, readRowBudget: 0 })
    await zero.ensureSchema()
    try {
      assert.equal(zero.readRowBudget, null, 'a zero budget must fall back, not disable the limit')
    } finally {
      await zero.close()
    }
  })

  it('both adapters refuse the same read', async (t) => {
    if (needs(t)) return
    // The property the whole storage design rests on, and the reason the budget
    // is declared in `store.js` rather than in either adapter: a store that
    // refuses on Postgres and serves on JSON is a route that 503s in production
    // and passes every test, which is exactly the ARC-10 defect class. This
    // drives the identical call against both and asserts they agree.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-budget-json-'))
    const json = new JsonStore(path.join(dir, 'store.json'), { readRowBudget: 5 })
    try {
      const records = Array.from({ length: 6 }, (_, i) => hazard(`j${i}`))
      await json.write({})
      await json.merge({ hazard_events: records })

      await store.write({})
      await store.merge({ hazard_events: records })

      const manifest = { collections: ['hazard_events'] }
      const jsonError = await json.read(manifest).then(() => null, (e) => e)
      const pgError = await store.read(manifest).then(() => null, (e) => e)

      assert.ok(jsonError instanceof StoreReadBudgetExceeded, `JSON store served an over-budget read: ${jsonError}`)
      assert.ok(pgError instanceof StoreReadBudgetExceeded, `Postgres store served an over-budget read: ${pgError}`)
      assert.equal(jsonError.message, pgError.message,
        'the two adapters refuse with different sentences, so a caller cannot branch on either')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
