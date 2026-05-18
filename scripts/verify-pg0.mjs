import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { runIngestion } from '../src/ingestion.js'
import { Pg0Manager } from '../src/pg0.js'
import { createStoreFromEnv } from '../src/storage.js'

const pg0Bin = process.env.PG0_BIN || 'pg0'
const name = process.env.PG0_NAME || `lindela-lite-verify-${process.pid}`
const port = process.env.PG0_PORT || '55432'
const dataDir = process.env.PG0_DATA_DIR || path.join(os.tmpdir(), name, 'data')
const pg0 = new Pg0Manager({ command: pg0Bin, name, port, dataDir })

try {
  await pg0.drop().catch(() => {})
  const store = await createStoreFromEnv({
    LINDELA_LITE_DB_MODE: 'pg0',
    PG0_BIN: pg0Bin,
    PG0_NAME: name,
    PG0_PORT: port,
    PG0_DATA_DIR: dataDir,
  })
  await runIngestion(store, {
    sources: ['service_assets', 'conflict_csv'],
    service_assets: [{ name: 'pg0 verification clinic', service_type: 'health', country: 'KE', latitude: 3.1, longitude: 35.6 }],
    conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-05-18,resource_tension,3.11,35.61,KE,0,pg0 verification event\n',
  })
  const restarted = await createStoreFromEnv({
    LINDELA_LITE_DB_MODE: 'postgres',
    LINDELA_LITE_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
  })
  const data = await restarted.read()
  assert.equal(data.service_assets.some((asset) => asset.name === 'pg0 verification clinic'), true)
  assert.equal(data.conflict_events.some((event) => event.title === 'pg0 verification event'), true)
  await store.close?.()
  await restarted.close?.()
  console.log(`pg0 verification ok (${name} on ${port})`)
} finally {
  await pg0.drop().catch(() => {})
}
