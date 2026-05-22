import { emptyStore } from './schema.js'
import { COLLECTIONS, mergeById } from './store.js'
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
    const current = await this.read()
    const next = { ...current }
    for (const collection of COLLECTIONS) {
      const incoming = partial[collection] || []
      if (!incoming.length) continue
      next[collection] = mergeById(current[collection] || [], incoming)
    }
    return this.write(next)
  }

  async replaceAnalytics({ risk_scores = [], impact_assessments = [] }) {
    const current = await this.read()
    return this.write({
      ...current,
      risk_scores,
      impact_assessments,
    })
  }

  async close() {
    if (this.pool?.end) await this.pool.end()
  }
}
