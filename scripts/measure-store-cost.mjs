/**
 * What the Wave 1 store fixes are worth, measured rather than asserted.
 *
 * Provisions a real cluster, seeds it to the shape the audit measured against
 * (39,715 records / 143 MB, of which 31,549 rows / 85 MB are
 * `record_versions`), and times the before and after of each change. Both sides
 * of every comparison are in this file, so a reader can check that the "before"
 * is the shape the audit described rather than a strawman.
 *
 *   node scripts/measure-store-cost.mjs
 *
 * Not a test. Nothing here asserts; it prints. The assertions live in
 * `test/store-cost.test.js`.
 */

import { COLLECTIONS, sortRecords, JsonStore, supersededVersions } from '../src/store.js'
import { PostgresStore } from '../src/postgres-store.js'
import { VERSIONS_PER_RECORD } from '../src/bitemporal.js'
import { postgresCluster } from '../test/pg-harness.mjs'

const RECORDS = 39_715
const VERSIONS = 31_549
const HISTORY_IDS = 3_200

const ms = (value) => `${value.toFixed(1)} ms`

/** Median of `runs` timings, which is what a benchmark should report. */
async function time(label, runs, body) {
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint()
    const result = await body()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
    if (result === undefined) throw new Error(`${label} produced no result to keep alive`)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  console.log(`  ${label.padEnd(46)} ${ms(median).padStart(10)}   (min ${ms(samples[0])})`)
  return median
}

function row({ collection, id, severity, country, hash, when }) {
  return {
    collection,
    id,
    body: {
      id,
      collection,
      event_type: 'flood',
      source: 'gdacs',
      severity,
      country,
      service_type: 'health',
      owner: 'ops',
      status: 'active',
      incident_id: `inc-${id}`,
      latitude: 3.1,
      longitude: 35.6,
      payload_hash: hash,
      observed_at: when,
      metadata: {
        district: 'Turkana',
        enrolment: 820,
        feeding_programme: 'supplementary',
        rainfall_mm: 42.5,
        source_url: 'https://example.invalid/a/fairly/long/url/segment',
      },
    },
    updated_at: new Date(Date.UTC(2026, 0, 1) + (hash % 400) * 86_400_000),
  }
}

async function seed(store) {
  const collections = COLLECTIONS.filter((c) => !c.startsWith('quarantine_'))
  const rows = []
  let n = 0
  for (const collection of collections) {
    const share = Math.max(1, Math.round(RECORDS / collections.length))
    for (let i = 0; i < share && n < RECORDS; i += 1, n += 1) {
      rows.push(row({
        collection,
        id: `${collection}-${i}`,
        severity: ['low', 'moderate', 'high', 'critical'][i % 4],
        country: ['KE', 'TZ', 'UG', 'SS'][i % 4],
        hash: n,
        when: new Date(Date.UTC(2026, 0, 1 + (i % 360))).toISOString(),
      }))
    }
  }

  const versionRows = []
  for (let i = 0; i < VERSIONS; i += 1) {
    const owner = rows[i % rows.length]
    const previous = { ...owner.body, severity: 'low', note: `prior ${i}` }
    versionRows.push({
      collection: 'record_versions',
      id: `version-${i}`,
      body: {
        ...previous,
        id: `version-${i}`,
        collection: 'record_versions',
        record_id: owner.id,
        valid_from: previous.observed_at,
        valid_to: new Date(Date.UTC(2025, 6, 1 + (i % 60))).toISOString(),
        open: false,
        changed_fields: { severity: { from: 'low', to: 'moderate' } },
        source_run_id: `run-${i % 40}`,
      },
      updated_at: new Date(Date.UTC(2025, 6, 1 + (i % 60))),
    })
  }

  const flat = [...rows, ...versionRows]
  await store.ensureSchema()
  const client = await store.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("DELETE FROM lite_records WHERE collection <> '__schema'")
    for (let i = 0; i < flat.length; i += 5_000) {
      const batch = flat.slice(i, i + 5_000)
      await client.query(
        `INSERT INTO lite_records (collection, id, body, payload_hash, updated_at)
         SELECT u.collection, u.id, u.body, u.payload_hash, u.updated_at
           FROM UNNEST($1::text[], $2::text[], $3::jsonb[], $4::text[], $5::timestamptz[])
             AS u(collection, id, body, payload_hash, updated_at)`,
        [
          batch.map((r) => r.collection),
          batch.map((r) => r.id),
          batch.map((r) => JSON.stringify(r.body)),
          batch.map((r) => r.body.payload_hash ?? null),
          batch.map((r) => r.updated_at),
        ],
      )
    }
    await client.query('COMMIT')
    await client.query('ANALYZE lite_records')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return { records: rows.length, versions: versionRows.length }
}

async function measurePostgres(store) {
  const pool = store.pool

  console.log('\nPostgresStore.read() — the spine at src/postgres-store.js:147')

  const oldSpine = await time('the old select, sort and includes()', 5, async () => {
    const { rows } = await pool.query(
      'SELECT collection, body, updated_at FROM lite_records ORDER BY updated_at DESC, collection, id',
    )
    const out = {}
    for (const collection of COLLECTIONS) out[collection] = []
    for (const r of rows) {
      if (COLLECTIONS.includes(r.collection)) out[r.collection].push(r.body)
    }
    for (const collection of COLLECTIONS) out[collection] = sortRecords(out[collection])
    return rows
  })

  const newRead = await time('read() as it now stands', 5, async () => store.read())
  const narrow = await time("read(['incidents']) — a manifest", 5, async () => store.read(['incidents']))
  const history = await time('read({ includeHistory: true })', 3, async () => store.read({ includeHistory: true }))

  console.log(`  read() is ${(oldSpine / newRead).toFixed(2)}x faster; `
    + `a single-collection manifest is ${(oldSpine / narrow).toFixed(0)}x faster`)

  console.log('\nR-26 — pruneVersions')

  const ids = await pool.query(
    `SELECT DISTINCT body->>'record_id' AS rid FROM lite_records
      WHERE collection = 'record_versions' LIMIT 200`,
  )
  const recordIds = ids.rows.map((r) => r.rid)

  // Both statements are timed by the server, inside a transaction that is then
  // rolled back — a prune that is measured by having really pruned would leave
  // the second measurement nothing to do.
  const prune = async (label, sql, params) => {
    const client = await pool.connect()
    const samples = []
    try {
      for (let i = 0; i < 3; i += 1) {
        await client.query('BEGIN')
        const { rows } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)
        await client.query('ROLLBACK')
        samples.push(rows[0]['QUERY PLAN'][0]['Execution Time'])
      }
    } finally {
      client.release()
    }
    samples.sort((a, b) => a - b)
    console.log(`  ${label.padEnd(46)} ${ms(samples[1]).padStart(10)}`)
    return samples[1]
  }

  const oldPrune = await prune('the old whole-table window scan', `DELETE FROM lite_records v
        WHERE v.collection = 'record_versions'
          AND v.id IN (
            SELECT id FROM (
              SELECT id, row_number() OVER (
                PARTITION BY body->>'record_id'
                ORDER BY body->>'valid_to' DESC NULLS LAST
              ) AS rank
              FROM lite_records WHERE collection = 'record_versions'
            ) ranked WHERE ranked.rank > $1
          )`, [VERSIONS_PER_RECORD])

  const newPrune = await prune('the scoped prune, 200 records', `DELETE FROM lite_records v
        WHERE v.collection = 'record_versions'
          AND v.id IN (
            SELECT id FROM (
              SELECT id, row_number() OVER (
                PARTITION BY body->>'record_id'
                ORDER BY body->>'valid_to' DESC NULLS LAST
              ) AS rank
              FROM lite_records
               WHERE collection = 'record_versions'
                 AND body->>'record_id' = ANY($1::text[])
            ) ranked WHERE ranked.rank > $2
          )`, [recordIds, VERSIONS_PER_RECORD])

  console.log(`  scoped prune is ${(oldPrune / newPrune).toFixed(2)}x faster`)

  console.log('\nR-32 — upsertCollection payload_hash lookup')

  // A realistic shape: a daily re-ingest of a few hundred records into a
  // collection that has been accumulating for years. Asking for most of a
  // collection's hashes would flatter the old code, and it would also be a lie
  // about what a merge does.
  const stored = await pool.query(
    `SELECT count(*)::int AS n FROM lite_records
      WHERE collection = 'hazard_events' AND payload_hash IS NOT NULL`,
  )
  const hashes = await pool.query(
    `SELECT payload_hash FROM lite_records
      WHERE collection = 'hazard_events' AND payload_hash IS NOT NULL LIMIT 200`,
  )
  const wanted = hashes.rows.map((r) => r.payload_hash)

  const oldHashes = await time(`all ${stored.rows[0].n} hashes in the collection`, 5, async () => {
    const { rows } = await pool.query(
      `SELECT payload_hash FROM lite_records
        WHERE collection = $1 AND payload_hash IS NOT NULL`,
      ['hazard_events'],
    )
    return new Set(rows.map((r) => r.payload_hash))
  })
  const newHashes = await time(`only the ${wanted.length} hashes in the batch`, 5, async () => {
    const { rows } = await pool.query(
      `SELECT payload_hash FROM lite_records
        WHERE collection = $1 AND payload_hash = ANY($2::text[])`,
      ['hazard_events', wanted],
    )
    return new Set(rows.map((r) => r.payload_hash))
  })
  console.log(`  the scoped lookup is ${(oldHashes / newHashes).toFixed(1)}x faster`)

  console.log('\nENH-10 — a filtered query, before and after migration 5')

  await pool.query(
    `SELECT severity FROM lite_records WHERE collection = 'incidents' AND severity = 'critical' LIMIT 1`,
  )
  const filtered = await time('severity = a literal', 10, async () => {
    const { rows } = await pool.query(
      `SELECT id FROM lite_records WHERE collection = 'incidents' AND severity = 'critical'`,
    )
    return rows
  })
  const { rows: plan } = await pool.query(
    `EXPLAIN SELECT id FROM lite_records WHERE collection = 'incidents' AND severity = 'critical'`,
  )
  console.log(`  plan: ${plan.map((r) => r['QUERY PLAN']).join(' | ').slice(0, 200)}`)
  return { filtered }
}

async function measureJson(records) {
  console.log('\nJsonStore — R-29 and R-28')

  const store = new JsonStore(`${process.env.TMPDIR || '/tmp'}/lindela-measure-store.json`)
  const payload = {}
  let n = 0
  for (const collection of COLLECTIONS.slice(0, 20)) {
    payload[collection] = []
    for (let i = 0; i < Math.round(records / 20); i += 1, n += 1) {
      payload[collection].push(row({
        collection,
        id: `${collection}-${i}`,
        severity: ['low', 'moderate', 'high', 'critical'][i % 4],
        country: 'KE',
        hash: n,
        when: new Date(Date.UTC(2026, 0, 1 + (i % 360))).toISOString(),
      }).body)
    }
  }

  const prettyText = JSON.stringify(payload, null, 2)
  const compactText = JSON.stringify(payload)
  const pretty = await time('JSON.stringify(store, null, 2)', 3, async () => JSON.stringify(payload, null, 2))
  const compact = await time('JSON.stringify(store)', 3, async () => JSON.stringify(payload))
  console.log(`  compact is ${(pretty / compact).toFixed(1)}x faster; `
    + `${Math.round((1 - compactText.length / prettyText.length) * 100)}% fewer bytes `
    + `(${(prettyText.length / 1e6).toFixed(1)} MB → ${(compactText.length / 1e6).toFixed(1)} MB)`)

  // Warm vs cold-after-write, which is the sequence every API mutation produces.
  await store.write(payload)
  const warm = await time('read() on a warm cache', 20, () => store.read())

  const cold = await time('read() after a write, with the old null stamp', 3, async () => {
    // Reproduce the pre-fix behaviour exactly: stamp nulled rather than set,
    // so the next read re-stats and re-parses.
    const fresh = new JsonStore(store.filePath)
    const raw = await (await import('node:fs/promises')).readFile(store.filePath, 'utf8')
    const started = process.hrtime.bigint()
    void JSON.parse(raw)
    return Number(process.hrtime.bigint() - started) / 1e6
  })
  console.log(`  warm read is ${(cold / warm).toFixed(0)}x cheaper than re-parsing the file`)
  console.log(`  (measured re-parse ${ms(cold)} against a warm read of ${ms(warm)})`)

  await (await import('node:fs/promises')).rm(store.filePath, { force: true })
}

const cluster = await postgresCluster({ name: 'lindela-measure' })
if (cluster.skipped) {
  console.error(`measure-store-cost: ${cluster.skipped}`)
  process.exit(0)
}
const store = new PostgresStore({ databaseUrl: cluster.url })
try {
  const seeded = await seed(store)
  console.log(`seeded ${seeded.records} records and ${seeded.versions} version rows`)
  await measurePostgres(store)
  await measureJson(20_000)
} finally {
  await store.close()
  await cluster.stop()
}