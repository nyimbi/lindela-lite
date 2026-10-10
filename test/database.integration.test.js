import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runIngestion } from '../src/ingestion.js'
import { Pg0Manager } from '../src/pg0.js'
import { PostgresStore } from '../src/postgres-store.js'
import { createStoreFromEnv } from '../src/storage.js'
import { postgresCluster } from './pg-harness.mjs'

// Provisioned through the harness rather than read straight off the environment.
//
// This file was the one Postgres test that took `LINDELA_LITE_TEST_DATABASE_URL`
// directly, so it was the one file the harness's isolation could not reach: it
// wrote into the shared database while seven other files were running against
// it, and the two failures that survived the harness fix were both here. The
// harness gives every caller a private database; a caller that skips it is a
// caller that shares one.
let testDatabaseUrl = null
let cluster = null
const pg0Enabled = process.env.LINDELA_LITE_TEST_PG0 === '1'
const pg0Bin = process.env.LINDELA_LITE_TEST_PG0_BIN || process.env.PG0_BIN || 'pg0'
const pg0Name = process.env.LINDELA_LITE_TEST_PG0_NAME || `lindela-lite-test-${process.pid}`
const pg0Port = process.env.LINDELA_LITE_TEST_PG0_PORT || '55432'

describe('external PostgreSQL integration', () => {
  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-integration' })
    if (cluster.skipped) process.stderr.write(`database.integration: ${cluster.skipped}\n`)
    testDatabaseUrl = cluster.skipped ? null : cluster.url
  })

  after(async () => {
    await cluster?.stop()
  })

  it('migrates, writes, and persists across store instances', async (t) => {
    if (!testDatabaseUrl) return t.skip(cluster?.skipped)
    const store = new PostgresStore({ databaseUrl: testDatabaseUrl })
    await store.ensureSchema()
    await store.write({ source_runs: [], climate_observations: [], hazard_events: [], conflict_events: [], service_assets: [], impact_assessments: [], risk_scores: [] })
    await runIngestion(store, {
      sources: ['service_assets', 'conflict_csv'],
      service_assets: [{ name: 'External DB Clinic', service_type: 'health', country: 'KE', latitude: 3.1, longitude: 35.6 }],
      conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-05-18,resource_tension,3.11,35.61,KE,0,External DB event\n',
    })
    const restarted = new PostgresStore({ databaseUrl: testDatabaseUrl })
    const data = await restarted.read()
    assert.equal(data.service_assets.some((asset) => asset.name === 'External DB Clinic'), true)
    assert.equal(data.conflict_events.some((event) => event.title === 'External DB event'), true)
    await store.close()
    await restarted.close()
  })

  it('merge() upserts incrementally instead of rewriting every row', async (t) => {
    if (!testDatabaseUrl) return t.skip(cluster?.skipped)
    const store = new PostgresStore({ databaseUrl: testDatabaseUrl })
    await store.ensureSchema()
    await store.write({})

    // Seed an unrelated collection, then verify a merge leaves it untouched.
    await store.merge({
      service_assets: [{ id: 'seed-asset', name: 'Seed Clinic', service_type: 'health', country: 'KE', latitude: 3.1, longitude: 35.6 }],
    })
    const seeded = await store.read()
    assert.equal(seeded.service_assets.length, 1)

    const marker = new Date('2026-01-01T00:00:00.000Z')
    await store.merge({ service_assets: [{ id: 'seed-asset', note: 'added-by-merge' }] })

    const afterMerge = await store.read()
    const asset = afterMerge.service_assets.find((item) => item.id === 'seed-asset')
    // Shallow merge preserves the original fields...
    assert.equal(asset.name, 'Seed Clinic')
    assert.equal(asset.service_type, 'health')
    // ...and applies the new one.
    assert.equal(asset.note, 'added-by-merge')
    assert.equal(afterMerge.service_assets.length, 1)

    // A merge must not disturb other collections.
    await store.merge({ hazard_events: [{ id: 'hz-1', event_type: 'flood', source: 'test', severity: 'low' }] })
    const withHazard = await store.read()
    assert.equal(withHazard.service_assets.length, 1)
    assert.equal(withHazard.hazard_events.length, 1)

    // Confirm rows were not deleted-and-reinserted: updated_at on the seeded
    // row must be newer than the schema baseline, and the row must survive.
    const { rows } = await store.pool.query(
      `SELECT id, updated_at FROM lite_records WHERE collection = 'service_assets'`,
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'seed-asset')
    assert.ok(new Date(rows[0].updated_at).getTime() >= marker.getTime())
    await store.close()
  })

  it('merge() skips records whose payload_hash already exists', async (t) => {
    if (!testDatabaseUrl) return t.skip(cluster?.skipped)
    const store = new PostgresStore({ databaseUrl: testDatabaseUrl })
    await store.ensureSchema()
    await store.write({})

    const hash = 'hash-dedupe-test-1'
    await store.merge({ hazard_events: [{ id: 'ev-a', payload_hash: hash, event_type: 'flood', severity: 'low', marker: 'first' }] })

    // Same hash, different id: must be skipped rather than inserted.
    await store.merge({ hazard_events: [{ id: 'ev-b', payload_hash: hash, event_type: 'flood', severity: 'high', marker: 'second' }] })

    const data = await store.read()
    assert.equal(data.hazard_events.length, 1)
    assert.equal(data.hazard_events[0].id, 'ev-a')
    assert.equal(data.hazard_events[0].marker, 'first')
    await store.close()
  })

  it('backfills payload_hash from body on upgrade, so old rows still dedupe', async (t) => {
    if (!testDatabaseUrl) return t.skip(cluster?.skipped)

    // The upgrade has to start *before* the migration, which is the part this
    // test used to get wrong: it called `ensureSchema()` first — bringing the
    // database fully up to date — then inserted a "legacy" row and expected a
    // second `ensureSchema()` to backfill it. Migrations run once, by design
    // (that is the version ledger, DATA-11), so the second call was a no-op and
    // the assertion could only ever pass on a database where some *other* run
    // had left the column unbackfilled. It passed locally for years by skipping
    // — no `LINDELA_LITE_TEST_DATABASE_URL`, no Postgres tests — and surfaced
    // the first time CI had `pg` installed and a cluster to reach.
    //
    // So build the pre-migration schema by hand: exactly what an older build
    // left behind, with the hash in the body and no column to hold it.
    const legacy = new PostgresStore({ databaseUrl: testDatabaseUrl })
    await legacy.ensureSchema()
    await legacy.pool.query(`
      DROP TABLE IF EXISTS lite_records;
      CREATE TABLE lite_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        body JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
    `)
    await legacy.pool.query(
      `INSERT INTO lite_records (collection, id, body)
       VALUES ($1, $2, $3::jsonb)`,
      ['conflict_events', 'legacy-1', JSON.stringify({ id: 'legacy-1', event_type: 'resource_tension', payload_hash: 'legacy-hash-1' })],
    )
    await legacy.close()

    // A fresh instance migrates that old schema forward, and migration 1
    // backfills the column from the body.
    const store = new PostgresStore({ databaseUrl: testDatabaseUrl })
    await store.ensureSchema()

    const backfilled = await store.pool.query(
      `SELECT payload_hash FROM lite_records WHERE collection = 'conflict_events' AND id = 'legacy-1'`,
    )
    assert.equal(backfilled.rows[0].payload_hash, 'legacy-hash-1')

    // The backfilled hash now suppresses a duplicate ingest, which it would
    // not have done with a NULL column.
    await store.merge({ conflict_events: [{ id: 'legacy-2', payload_hash: 'legacy-hash-1', event_type: 'resource_tension' }] })
    const data = await store.read()
    assert.equal(data.conflict_events.length, 1)
    assert.equal(data.conflict_events[0].id, 'legacy-1')
    await store.close()
  })
})

describe('pg0 integration', { skip: !pg0Enabled }, () => {
  const pg0 = new Pg0Manager({ command: pg0Bin, name: pg0Name, port: pg0Port, dataDir: path.join(os.tmpdir(), pg0Name) })

  after(async () => {
    await pg0.drop().catch(() => {})
  })

  it('starts pg0, writes records, and persists after store restart', async () => {
    await pg0.drop().catch(() => {})
    const store = await createStoreFromEnv({
      LINDELA_LITE_DB_MODE: 'pg0',
      PG0_BIN: pg0Bin,
      PG0_NAME: pg0Name,
      PG0_PORT: pg0Port,
      PG0_DATA_DIR: path.join(os.tmpdir(), pg0Name),
    })
    assert.equal(store.mode, 'pg0')
    await runIngestion(store, {
      sources: ['service_assets', 'conflict_csv'],
      service_assets: [{ name: 'pg0 Clinic', service_type: 'health', country: 'KE', latitude: 3.1, longitude: 35.6 }],
      conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-05-18,resource_tension,3.11,35.61,KE,0,pg0 event\n',
    })
    const restarted = await createStoreFromEnv({
      LINDELA_LITE_DB_MODE: 'postgres',
      LINDELA_LITE_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${pg0Port}/postgres`,
    })
    const data = await restarted.read()
    assert.equal(data.source_runs.length >= 2, true)
    assert.equal(data.service_assets.some((asset) => asset.name === 'pg0 Clinic'), true)
    assert.equal(data.conflict_events.some((event) => event.title === 'pg0 event'), true)
    await store.close?.()
    await restarted.close?.()
  })
})
