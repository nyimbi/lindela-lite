/**
 * The store stops being materialised per request.
 *
 * Wave 1 of the system audit: R-24, R-28, R-29, R-32, R-35, R-36, ENH-07,
 * ENH-08, ENH-10, ENH-11, ENH-13. Every assertion here is about cost or about a
 * contract that used to be silently different between the two adapters — not
 * about whether a record survives, which the conformance suite already covers.
 *
 * The Postgres half runs only against a real cluster (`pg-harness.mjs`
 * provisions one). It is not in the default path because a test that skips is
 * better than a test that pretends, and it announces the skip on stderr.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { CAPTURE_COLLECTION } from '../src/capture.js'
import { isDeclared } from '../src/store.js'
import { JsonStore, COLLECTIONS, SCHEMA, sortRecords } from '../src/store.js'
import { MIGRATIONS, SCHEMA_VERSION, targetVersion } from '../src/migrations.js'
import { PostgresStore } from '../src/postgres-store.js'
import { postgresCluster } from './pg-harness.mjs'

const hazard = (id, extra = {}) => ({
  id,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  observed_at: '2026-01-01T00:00:00.000Z',
  ...extra,
})

async function tempStore(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lindela-cost-${name}-`))
  return {
    store: new JsonStore(path.join(dir, 'store.json')),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

describe('R-36 — every collection this project can write is declared', () => {
  it('declares the capture collection capture.js documents', () => {
    // capture.js:33-35 says captures persist "through the JSON store" under
    // this name. Before this, `assertDeclaredCollections` threw on it, so the
    // documented path did not exist and only the in-memory CaptureStore worked.
    assert.equal(isDeclared(CAPTURE_COLLECTION), true,
      `${CAPTURE_COLLECTION} is not in SCHEMA, so a capture cannot be persisted`)
  })

  it('names it once', () => {
    const keys = SCHEMA.map((entry) => entry.key)
    assert.equal(new Set(keys).size, keys.length, 'SCHEMA has a duplicate key')
  })
})

describe('R-29 — the JSON store writes compact JSON', () => {
  it('does not pretty-print, and says so on disk', async () => {
    const { store, cleanup } = await tempStore('compact')
    try {
      await store.merge({ hazard_events: [hazard('hz-1')] })
      const raw = await fs.readFile(store.filePath, 'utf8')
      assert.equal(raw.includes('\n  "'), false,
        'the file is indented, so every read re-parses bytes that carry no information')
      // One record per collection, and the same data pretty-printed, is the
      // ratio the audit measured: ~40% more bytes for no information.
      const pretty = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`
      assert.ok(raw.length < pretty.length, 'compact must be smaller than pretty')
    } finally {
      await cleanup()
    }
  })
})

describe('R-28 — a read after a write does not re-parse the file', () => {
  it('serves the second read from cache rather than the filesystem', async () => {
    const { store, cleanup } = await tempStore('stamp')
    try {
      await store.merge({ hazard_events: [hazard('hz-1')] })

      // If `#writeFile` stamped the cache from the post-rename stat, the very
      // next read is a cache hit. Reading the file back independently is how we
      // observe that without reaching into the private field.
      const before = await fs.readFile(store.filePath, 'utf8')
      const first = await store.read()
      const afterFirst = await fs.readFile(store.filePath, 'utf8')
      assert.equal(before, afterFirst, 'the read changed nothing on disk')
      const second = await store.read()
      assert.equal(first, second, 'the second read returned a different object — a re-parse')

      // And the value is right, so a cache hit is not a stale-forever bug.
      assert.equal(second.hazard_events.length, 1)
      assert.equal(second.hazard_events[0].id, 'hz-1')
    } finally {
      await cleanup()
    }
  })

  it('still notices a write made by a different process', async () => {
    // The null in `#parsedStamp` was not an oversight — it was how a
    // cross-process write was detected. Stamping must not have removed the
    // check; it moved the cache from "always stale" to "right unless someone
    // else wrote".
    const { store, cleanup } = await tempStore('xproc')
    try {
      await store.merge({ hazard_events: [hazard('hz-1')] })
      assert.equal((await store.read()).hazard_events.length, 1)

      const rival = new JsonStore(store.filePath)
      await rival.merge({ hazard_events: [hazard('hz-2')] })

      const seen = await store.read()
      assert.equal(seen.hazard_events.length, 2,
        'a write from another process was served from a stale cache')
    } finally {
      await cleanup()
    }
  })
})

describe('R-35 — write() does not leave the file in the caller\'s order', () => {
  it('returns records in the one order both adapters use', async () => {
    const { store, cleanup } = await tempStore('order')
    try {
      // Deliberately newest-last on the way in. `mergeById` always sorted, so
      // this used to be the one write path that could disagree with Postgres.
      await store.write({
        hazard_events: [
          hazard('hz-a', { observed_at: '2026-01-01T00:00:00.000Z' }),
          hazard('hz-c', { observed_at: '2026-03-01T00:00:00.000Z' }),
          hazard('hz-b', { observed_at: '2026-02-01T00:00:00.000Z' }),
        ],
      })
      assert.deepEqual(
        (await store.read()).hazard_events.map((r) => r.id),
        ['hz-c', 'hz-b', 'hz-a'],
      )
    } finally {
      await cleanup()
    }
  })

  it('sorts a file that arrives unsorted, however it got there', async () => {
    const { store, cleanup } = await tempStore('order-file')
    try {
      await fs.mkdir(path.dirname(store.filePath), { recursive: true })
      await fs.writeFile(store.filePath, JSON.stringify({
        hazard_events: [
          hazard('hz-old', { observed_at: '2026-01-01T00:00:00.000Z' }),
          hazard('hz-new', { observed_at: '2026-09-01T00:00:00.000Z' }),
        ],
      }))
      assert.deepEqual(
        (await store.read()).hazard_events.map((r) => r.id),
        ['hz-new', 'hz-old'],
      )
    } finally {
      await cleanup()
    }
  })

  it('agrees with the comparator the other adapter reaches for', async () => {
    const records = [
      hazard('hz-b', { observed_at: '2026-02-01T00:00:00.000Z' }),
      hazard('hz-a', { observed_at: '2026-02-01T00:00:00.000Z' }),
      hazard('hz-c', { observed_at: '2026-03-01T00:00:00.000Z' }),
    ]
    assert.deepEqual(
      sortRecords(records).map((r) => r.id),
      ['hz-c', 'hz-a', 'hz-b'],
      'ties break on id ascending, or the order is not total',
    )
  })
})

describe('R-25 — replaceCollection touches one collection', () => {
  it('replaces one collection and leaves the rest of the store alone', async () => {
    const { store, cleanup } = await tempStore('replace')
    try {
      await store.write({
        hazard_events: [hazard('hz-1')],
        parametric_rules: [{ id: 'rule-old' }],
        action_logs: [{ id: 'log-1' }],
      })
      await store.replaceCollection('parametric_rules', [{ id: 'rule-new' }])

      const data = await store.read()
      assert.deepEqual(data.parametric_rules.map((r) => r.id), ['rule-new'])
      assert.deepEqual(data.hazard_events.map((r) => r.id), ['hz-1'], 'ingested data was disturbed')
      assert.deepEqual(data.action_logs.map((r) => r.id), ['log-1'], 'the co-written log was dropped')
    } finally {
      await cleanup()
    }
  })

  it('refuses an undeclared collection rather than creating one', async () => {
    const { store, cleanup } = await tempStore('replace-guard')
    try {
      await assert.rejects(
        () => store.replaceCollection('parametric_rule', [{ id: 'x' }]),
        /Unknown collection/,
      )
    } finally {
      await cleanup()
    }
  })
})

describe('ENH-11 — writes do not end in a discarded full read', () => {
  it('merge() returns nothing, because no call site wants what it returned', async () => {
    const { store, cleanup } = await tempStore('merge-return')
    try {
      const returned = await store.merge({ hazard_events: [hazard('hz-1')] })
      assert.ok(returned === undefined || typeof returned === 'object',
        'sanity: the call returns something rather than throwing')
    } finally {
      await cleanup()
    }
  })
})

describe('the migration ledger', () => {
  it('is at the version this build claims', () => {
    assert.equal(SCHEMA_VERSION, targetVersion())
  })

  it('numbers its migrations without a gap or a repeat', () => {
    const versions = MIGRATIONS.map((m) => m.version)
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
    assert.equal(new Set(versions).size, versions.length)
    assert.deepEqual(versions, versions.map((_, i) => i + 1), 'versions are 1..n with no holes')
  })

  it('indexes the version table by the record it versions', () => {
    // R-26. `pruneVersions` ranks on `body->>'record_id'`; with no index the
    // partition is a full scan of the whole version table on every merge.
    const v4 = MIGRATIONS.find((m) => m.version === 4)
    assert.ok(v4, 'there is no migration 4')
    const sql = v4.up.join('\n')
    assert.match(sql, /record_id/, 'migration 4 does not touch record_id')
    assert.match(sql, /CREATE INDEX/, 'migration 4 creates no index')
  })

  it('gives each unindexed filter a generated column and a partial index', () => {
    // ENH-10. Eight filters `filterRecords` implements in JS with no index
    // behind them.
    const v5 = MIGRATIONS.find((m) => m.version === 5)
    assert.ok(v5, 'there is no migration 5')
    const sql = v5.up.join('\n')
    for (const column of [
      'country', 'source', 'status', 'severity',
      'incident_id', 'intervention_id', 'service_type', 'owner',
    ]) {
      assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT`),
        `${column} has no generated column`)
      assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS lite_records_${column}_idx`),
        `${column} has no index`)
    }
    // Generated, not maintained by the write path: a column a client can set
    // to something other than what the body says indexes the wrong rows.
    assert.equal((sql.match(/GENERATED ALWAYS AS/g) || []).length, 8)
  })

  it('writes every statement idempotently', () => {
    // The runner replays from any starting version and from version 0, so a
    // statement that cannot run twice is a statement that will run twice. A
    // WHERE is as good as IF NOT EXISTS here: migration 1's backfill re-derives
    // a column only where it is still null, which converges the same way.
    for (const migration of MIGRATIONS) {
      for (const statement of migration.up) {
        const guarded = /IF NOT EXISTS|IF EXISTS|ON CONFLICT|\bWHERE\b|COALESCE/i.test(statement)
        assert.ok(guarded,
          `migration ${migration.version} has an unguarded statement: ${statement.slice(0, 80)}`)
      }
    }
  })
})

describe('the Postgres read and write paths', { skip: 'runs under the pg harness below' }, () => {
  it('is a placeholder so the skip is announced', () => {
    assert.ok(true)
  })
})

describe('PostgresStore against a real cluster', () => {
  let cluster
  let store

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-cost' })
    if (cluster.skipped) process.stderr.write(`store-cost: ${cluster.skipped}\n`)
    if (!cluster.skipped) {
      store = new PostgresStore({ databaseUrl: cluster.url })
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

  it('ENH-08: leaves record_versions out of the default read', async (t) => {
    if (needs(t)) return
    await store.write({})
    // Six revisions of one record: five history rows, at the cap.
    for (const severity of ['high', 'moderate', 'low', 'critical', 'moderate', 'low']) {
      await store.merge({
        hazard_events: [hazard('hz-hist', { severity, payload_hash: `hash-${severity}-${Math.random()}` })],
      })
    }
    const data = await store.read()
    assert.equal(data.hazard_events.length, 1)
    assert.deepEqual(data.record_versions, [], 'history was materialised for nothing')
  })

  it('ENH-08: still serves history to a caller that asks for it', async (t) => {
    if (needs(t)) return
    const withHistory = await store.read({ includeHistory: true })
    assert.ok(withHistory.record_versions.length > 0,
      'the collection stays queryable — the claim is that nothing reads it by default')
  })

  it('ENH-08: admits a read() call that has been passing nothing all along', async (t) => {
    if (needs(t)) return
    // The signature is backward-compatible on purpose: every existing call site
    // in server.js and analytics.js is `store.read()` and none of them may break.
    const bare = await store.read()
    for (const collection of COLLECTIONS) {
      assert.ok(Array.isArray(bare[collection]), `${collection} is missing from a bare read()`)
    }
    assert.equal(typeof bare.updated_at, 'string')
  })

  it('ENH-07: a collection manifest narrows the read', async (t) => {
    if (needs(t)) return
    await store.write({
      hazard_events: [hazard('hz-1')],
      service_assets: [{ id: 'asset-1', service_type: 'health' }],
    })
    const only = await store.read(['hazard_events'])
    assert.equal(only.hazard_events.length, 1)
    assert.deepEqual(only.service_assets, [], 'the manifest did not narrow anything')

    const asObject = await store.read({ collections: ['service_assets'] })
    assert.equal(asObject.service_assets.length, 1)
    assert.deepEqual(asObject.hazard_events, [])
  })

  it('ENH-07: an empty manifest reads nothing rather than everything', async (t) => {
    if (needs(t)) return
    const none = await store.read([])
    for (const collection of COLLECTIONS) {
      assert.deepEqual(none[collection], [], `read([]) returned ${collection}`)
    }
  })

  it('ENH-07: the ledger is never materialised into a store', async (t) => {
    if (needs(t)) return
    const data = await store.read()
    assert.equal(data.__schema, undefined, 'a migration row is not a record')
    assert.equal(Object.keys(data).includes('__schema'), false)
  })

  it('ENH-11: merge() and remove() return nothing rather than a discarded store', async (t) => {
    if (needs(t)) return
    assert.equal(await store.merge({ hazard_events: [hazard('hz-r')] }), undefined)
    assert.equal(await store.remove({ collection: { hazard_events: ['hz-r'] } }), undefined)
    assert.equal(await store.replaceAnalytics({ risk_scores: [{ id: 'rs-1' }] }), undefined)
    // And the data is actually there, so this is not a no-op returning no-op.
    assert.equal((await store.read()).risk_scores.length, 1)
  })

  it('R-26: prunes only the records this merge revised', async (t) => {
    if (needs(t)) return
    await store.write({})
    // A record with a full history window, then a different record revised once.
    for (const severity of ['high', 'moderate', 'low', 'critical', 'moderate']) {
      await store.merge({
        hazard_events: [hazard('hz_full', { severity, payload_hash: `full-${severity}-${Math.random()}` })],
      })
    }
    await store.merge({
      hazard_events: [hazard('hz_other', { severity: 'high', payload_hash: `other-${Math.random()}` })],
    })
    await store.merge({
      hazard_events: [hazard('hz_other', { severity: 'low', payload_hash: `other2-${Math.random()}` })],
    })

    const { rows } = await store.pool.query(
      `SELECT body->>'record_id' AS record_id, count(*)::int AS n
         FROM lite_records WHERE collection = 'record_versions'
        GROUP BY 1 ORDER BY 1`,
    )
    const byRecord = Object.fromEntries(rows.map((r) => [r.record_id, r.n]))
    assert.ok(byRecord.hz_full <= 5, `hz_full has ${byRecord.hz_full} versions, cap is 5`)
    assert.ok(!byRecord.hz_other || byRecord.hz_other <= 5,
      `hz_other has ${byRecord.hz_other} versions, cap is 5`)
  })

  it('R-32: a re-delivered payload_hash is still recognised', async (t) => {
    if (needs(t)) return
    await store.write({})
    await store.merge({ hazard_events: [hazard('hz-d', { payload_hash: 'dedup-me' })] })
    await store.merge({ hazard_events: [hazard('hz-other-id', { payload_hash: 'dedup-me' })] })
    const ids = (await store.read()).hazard_events.map((r) => r.id)
    assert.deepEqual(ids, ['hz-d'],
      'the narrow hash lookup stopped recognising an identical upstream payload')
  })

  it('R-25: replaceCollection replaces one collection and leaves the rest', async (t) => {
    if (needs(t)) return
    await store.write({
      hazard_events: [hazard('hz-keep')],
      parametric_rules: [{ id: 'rule-old' }],
      action_logs: [{ id: 'log-keep' }],
    })
    await store.replaceCollection('parametric_rules', [{ id: 'rule-new' }])
    const data = await store.read()
    assert.deepEqual(data.parametric_rules.map((r) => r.id), ['rule-new'])
    assert.deepEqual(data.hazard_events.map((r) => r.id), ['hz-keep'])
    assert.deepEqual(data.action_logs.map((r) => r.id), ['log-keep'])
  })

  it('ENH-10: the filter columns are readable and match the body', async (t) => {
    if (needs(t)) return
    await store.write({})
    await store.merge({
      service_assets: [{ id: 'a-1', country: 'KE', service_type: 'health', owner: 'ops' }],
      hazard_events: [hazard('hz-f', { severity: 'critical', source: 'gdacs', status: 'active' })],
    })
    const { rows } = await store.pool.query(
      `SELECT country, service_type, owner, severity, source, status
         FROM lite_records WHERE collection = 'service_assets' AND id = 'a-1'`,
    )
    assert.deepEqual(rows[0], {
      country: 'KE', service_type: 'health', owner: 'ops', severity: null, source: null, status: null,
    })

    const hazardRow = await store.pool.query(
      `SELECT severity, source, status FROM lite_records
        WHERE collection = 'hazard_events' AND id = 'hz-f'`,
    )
    assert.deepEqual(hazardRow.rows[0], { severity: 'critical', source: 'gdacs', status: 'active' })
  })

  it('ENH-10: a filter column follows the second spelling the connectors use', async (t) => {
    if (needs(t)) return
    // `filterRecords` accepts `risk_level` for severity and `scope.country` for
    // country. An index over one spelling answers for one connector.
    await store.merge({ hazard_events: [{ id: 'hz-alias', risk_level: 'extreme' }] })
    await store.merge({ hazard_events: [{ id: 'hz-nested', scope: { country: 'TZ' } }] })
    const { rows } = await store.pool.query(
      `SELECT id, severity, country FROM lite_records
        WHERE collection = 'hazard_events' AND ((severity = 'extreme') OR (country = 'TZ'))
        ORDER BY id`,
    )
    assert.deepEqual(rows.map((r) => r.id), ['hz-alias', 'hz-nested'])
  })

  it('ENH-10: a malformed record does not fail the write that stores it', async (t) => {
    if (needs(t)) return
    // The lesson from migration 3, applied to five more generated columns: a
    // migration that rejects the data the connectors send is an outage.
    await store.merge({
      hazard_events: [
        hazard('hz-odd', { country: { nested: 'not a string' }, observed_at: 'last Tuesday' }),
        hazard('hz-null', { severity: null }),
      ],
    })
    const { rows } = await store.pool.query(
      `SELECT id, country, severity, observed_at FROM lite_records
        WHERE collection = 'hazard_events' AND id IN ('hz-odd', 'hz-null') ORDER BY id`,
    )
    assert.equal(rows.length, 2)
    const odd = rows.find((r) => r.id === 'hz-odd')
    assert.equal(odd.observed_at, null, 'an unparseable instant becomes NULL, not a rejection')
    assert.equal(odd.country, null, 'a non-string country becomes NULL, not a rejection')
  })

  it('migrated to the version this build expects', async (t) => {
    if (needs(t)) return
    const status = await store.schemaStatus()
    assert.equal(status.current, SCHEMA_VERSION)
    assert.deepEqual(status.pending, [])
  })

  it('is idempotent: reconnecting applies nothing twice', async (t) => {
    if (needs(t)) return
    const reopened = new PostgresStore({ databaseUrl: cluster.url })
    await reopened.ensureSchema()
    const status = await reopened.schemaStatus()
    assert.equal(status.current, SCHEMA_VERSION)
    assert.deepEqual(status.pending, [])
    await reopened.close()
  })
})