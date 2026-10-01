import { emptyStore } from './schema.js'
import { COLLECTIONS } from './store.js'
import { nowIso } from './utils.js'

export class PostgresStore {
  constructor({ databaseUrl, pool } = {}) {
    if (!databaseUrl && !pool) throw new Error('PostgresStore requires a databaseUrl or pool')
    this.databaseUrl = databaseUrl
    this.pool = pool
    this.ready = false
  }

  async connect() {
    if (this.pool) return this.pool
    const pg = await import('pg').catch(() => {
      throw new Error('PostgreSQL storage requires the "pg" package. Run npm install before using pg0/postgres mode.')
    })
    this.pool = new pg.Pool({ connectionString: this.databaseUrl })
    return this.pool
  }

  async ensureSchema() {
    if (this.ready) return
    const pool = await this.connect()

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lite_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        body JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS lite_records_collection_updated_idx
        ON lite_records (collection, updated_at DESC);
    `)

    // payload_hash gets its own column so merge() can dedupe upstream
    // re-ingestion with an indexable lookup instead of loading every body.
    await pool.query('ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS payload_hash TEXT')

    // Backfill rows written before the column existed. jsonb_exists() is used
    // rather than the `?` operator, which is ambiguous with parameter
    // placeholders in the extended query protocol.
    await pool.query(
      `UPDATE lite_records
       SET payload_hash = body->>'payload_hash'
       WHERE payload_hash IS NULL AND jsonb_exists(body, 'payload_hash')`,
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS lite_records_collection_hash_idx
       ON lite_records (collection, payload_hash)
       WHERE payload_hash IS NOT NULL`,
    )
    this.ready = true
  }

  async read() {
    await this.ensureSchema()
    const { rows } = await this.pool.query('SELECT collection, body, updated_at FROM lite_records ORDER BY updated_at DESC')
    const store = emptyStore()
    for (const row of rows) {
      if (COLLECTIONS.includes(row.collection)) store[row.collection].push(row.body)
    }
    store.updated_at = rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : nowIso()
    return store
  }

  async write(data) {
    await this.ensureSchema()
    const next = { ...emptyStore(), ...data, updated_at: nowIso() }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM lite_records')
      for (const collection of COLLECTIONS) {
        for (const item of next[collection] || []) {
          await client.query(
            `INSERT INTO lite_records (collection, id, body, updated_at)
             VALUES ($1, $2, $3::jsonb, now())
             ON CONFLICT (collection, id)
             DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
            [collection, item.id, JSON.stringify(item)],
          )
        }
      }
      await client.query('COMMIT')
      return next
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async merge(partial) {
    await this.ensureSchema()
    const writes = []
    for (const collection of COLLECTIONS) {
      const incoming = (partial[collection] || []).filter((item) => item?.id)
      if (incoming.length) writes.push({ collection, items: incoming })
    }
    if (!writes.length) return this.read()

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const { collection, items } of writes) {
        await this.upsertCollection(client, collection, items)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return this.read()
  }

  /**
   * Upserts a batch of records for one collection without rewriting the table.
   *
   * Mirrors mergeById() semantics from store.js:
   * - records carrying a payload_hash already present in the collection are
   *   skipped, so re-ingesting identical upstream data is a no-op
   * - otherwise the incoming body is shallow-merged over the stored body so
   *   PATCH-style updates preserve fields the caller did not send
   */
  async upsertCollection(client, collection, items) {
    const { rows: existingHashes } = await client.query(
      `SELECT payload_hash FROM lite_records
       WHERE collection = $1 AND payload_hash IS NOT NULL`,
      [collection],
    )
    const seen = new Set(existingHashes.map((row) => row.payload_hash))
    const fresh = []
    for (const item of items) {
      if (item.payload_hash && seen.has(item.payload_hash)) continue
      if (item.payload_hash) seen.add(item.payload_hash)
      fresh.push(item)
    }
    if (!fresh.length) return

    await client.query(
      `INSERT INTO lite_records (collection, id, body, payload_hash, updated_at)
       SELECT u.collection, u.id, u.body, u.payload_hash, now()
       FROM UNNEST($1::text[], $2::text[], $3::jsonb[], $4::text[])
         AS u(collection, id, body, payload_hash)
       ON CONFLICT (collection, id) DO UPDATE
         SET body = lite_records.body || EXCLUDED.body,
             payload_hash = COALESCE(EXCLUDED.payload_hash, lite_records.payload_hash),
             updated_at = now()`,
      [
        fresh.map(() => collection),
        fresh.map((item) => item.id),
        fresh.map((item) => JSON.stringify(item)),
        fresh.map((item) => item.payload_hash ?? null),
      ],
    )
  }

  async replaceAnalytics({ risk_scores = [], impact_assessments = [], data_quality = [], road_access = [] }) {
    return this.merge({ risk_scores, impact_assessments, data_quality, road_access })
  }

  async close() {
    if (this.pool?.end) await this.pool.end()
  }
}
