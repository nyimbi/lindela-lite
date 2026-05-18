import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { runIngestion } from '../src/ingestion.js'
import { Pg0Manager } from '../src/pg0.js'
import { PostgresStore } from '../src/postgres-store.js'
import { createStoreFromEnv } from '../src/storage.js'

const testDatabaseUrl = process.env.LINDELA_LITE_TEST_DATABASE_URL
const pg0Enabled = process.env.LINDELA_LITE_TEST_PG0 === '1'
const pg0Bin = process.env.LINDELA_LITE_TEST_PG0_BIN || process.env.PG0_BIN || 'pg0'
const pg0Name = process.env.LINDELA_LITE_TEST_PG0_NAME || `lindela-lite-test-${process.pid}`
const pg0Port = process.env.LINDELA_LITE_TEST_PG0_PORT || '55432'

describe('external PostgreSQL integration', { skip: !testDatabaseUrl }, () => {
  it('migrates, writes, and persists across store instances', async () => {
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
