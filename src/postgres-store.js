import { emptyStore } from './schema.js'
import { COLLECTIONS, DERIVED_COLLECTIONS, assertDeclaredCollection, assertDeclaredCollections, sortRecords, supersededVersions } from './store.js'
import { BITEMPORAL_COLLECTIONS } from './bitemporal.js'
import { nowIso } from './utils.js'
import { pendingMigrations, targetVersion } from './migrations.js'

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

    // ENH-29. The statements below used to be written out here, inline, on
    // every connect: an ALTER, a backfill UPDATE and an index, with nothing
    // recording that any of it had run (DATA-11). They are now ordered
    // migrations keyed on a real schema_version, so a database at version 1 and
    // one at version 3 are distinguishable without reading this file, and
    // adding a column is a numbered entry rather than an edit to a method three
    // other things depend on.
    //
    // The order is enforced by the runner rather than by the reader noticing a
    // dependency: migration 2 creates the schema_version column, and the ledger
    // row recording migration 2's completion writes into it.
    //
    // One transaction per migration, not one for the batch. A failure halfway
    // through leaves every completed migration applied *and recorded*, which is
    // recoverable; a single batch transaction would roll all of it back and
    // re-run statements that already succeeded.
    const current = await this.readSchemaVersion(pool)
    for (const migration of pendingMigrations(current)) {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        for (const statement of migration.up) await client.query(statement)
        await client.query(
          `INSERT INTO lite_records (collection, id, body, schema_version, updated_at)
           VALUES ('__schema', $1, $2::jsonb, $3, now())
           ON CONFLICT (collection, id) DO UPDATE
             SET body = EXCLUDED.body,
                 schema_version = EXCLUDED.schema_version,
                 updated_at = now()`,
          [
            `schema-${migration.version}`,
            JSON.stringify({
              id: `schema-${migration.version}`,
              version: migration.version,
              name: migration.name,
              schema_version: migration.version,
              applied_at: new Date().toISOString(),
            }),
            migration.version,
          ],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    this.ready = true
  }

  /**
   * The version the database is actually at.
   *
   * Zero for a database that predates the ledger — and zero for a database
   * where the ledger column does not exist yet at all. That second case is not
   * hypothetical: `ensureSchema()` reads the version *before* applying
   * anything, so on a database created by this very method the column arrives
   * with migration 2. Querying it unconditionally throws
   * `column "schema_version" does not exist`, and because every Postgres test
   * in the project skipped itself, nothing had ever run this path against a
   * fresh database to notice.
   *
   * Zero is the right answer rather than null because every migration is
   * written to be idempotent — the statements themselves decide whether they
   * have already run, so replaying them against a partially-migrated database
   * is safe. That is the property that lets this ship to a district server
   * nobody has ever inspected.
   */
  async readSchemaVersion(pool = this.pool) {
    let rows
    try {
      ;({ rows } = await pool.query(
        `SELECT schema_version FROM lite_records
         WHERE collection = '__schema'
         ORDER BY schema_version DESC
         LIMIT 1`,
      ))
    } catch (error) {
      // 42P01 undefined_table, 42703 undefined_column. Anything else is a real
      // fault — a connection refused, a permission denied — and is rethrown,
      // because "the database is at version 0" would send the runner to replay
      // every migration against a server it cannot reach.
      if (error.code !== '42P01' && error.code !== '42703') throw error
      return 0
    }
    const version = rows[0]?.schema_version
    return Number.isInteger(version) ? version : 0
  }

  /** What the database is at versus what this build expects. */
  async schemaStatus() {
    await this.ensureSchema()
    const current = await this.readSchemaVersion()
    return {
      current,
      expected: targetVersion(),
      pending: pendingMigrations(current).map((m) => ({ version: m.version, name: m.name })),
      // A database newer than the code is not an error. Refusing to start
      // would push an operator into a manual downgrade, and the thing they are
      // avoiding — reading rows written by a newer schema — is the newer
      // schema's job to guard, not this build's.
      current_build_is_ahead: current > targetVersion(),
    }
  }

  async read() {
    await this.ensureSchema()
    const { rows } = await this.pool.query(
      'SELECT collection, body, updated_at FROM lite_records ORDER BY updated_at DESC, collection, id',
    )
    const store = emptyStore()
    for (const row of rows) {
      if (COLLECTIONS.includes(row.collection)) store[row.collection].push(row.body)
    }
    // The same comparator JsonStore uses. The ORDER BY above is kept only so
    // rows[0] is the most recently written row for the store's own updated_at;
    // ordering the collections themselves in SQL used to disagree with the JSON
    // backend, because this column is stamped with now() at write time and so
    // sorts by insertion rather than by when the record describes.
    for (const collection of COLLECTIONS) {
      store[collection] = sortRecords(store[collection])
    }
    store.updated_at = rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : nowIso()
    return store
  }

  async write(data) {
    assertDeclaredCollections(data)
    await this.ensureSchema()
    const next = { ...emptyStore(), ...data, updated_at: nowIso() }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // NOT the whole table. `__schema` holds the migration ledger, and a
      // blanket DELETE would drop it — which is survivable only because every
      // migration is idempotent, so the cost of getting it wrong is a full
      // re-run of statements on the next connect rather than a corruption. That
      // is a cost worth not paying, and the ledger is the one thing in this
      // table that write() is not the owner of.
      await client.query("DELETE FROM lite_records WHERE collection <> '__schema'")
      for (const collection of COLLECTIONS) {
        await this.insertRecords(client, collection, next[collection] || [])
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

  /**
   * Insert-only helper for the full-table rewrite in write().
   *
   * payload_hash is a first-class column, not a field of body: merge() reads it
   * back to dedupe re-ingestion of identical upstream data. Omitting it here
   * meant a single write() call silently disabled content-addressed dedup for
   * the life of the table (DAT-01).
   */
  async insertRecords(client, collection, items) {
    if (!items.length) return
    await client.query(
      `INSERT INTO lite_records (collection, id, body, payload_hash, updated_at)
       SELECT u.collection, u.id, u.body, u.payload_hash, now()
       FROM UNNEST($1::text[], $2::text[], $3::jsonb[], $4::text[])
         AS u(collection, id, body, payload_hash)
       ON CONFLICT (collection, id) DO UPDATE
         SET body = EXCLUDED.body,
             payload_hash = EXCLUDED.payload_hash,
             updated_at = now()`,
      [
        items.map(() => collection),
        items.map((item) => item.id),
        items.map((item) => JSON.stringify(item)),
        items.map((item) => item.payload_hash ?? null),
      ],
    )
  }

  async merge(partial) {
    assertDeclaredCollections(partial)
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
        // ENH-13. Read the predecessors before the upsert overwrites them.
        // Doing this inside the same transaction as the write is the whole
        // point: two concurrent merges of the same record must not both read
        // the same predecessor and each write a history row claiming to be
        // the sole prior value.
        //
        // Deliberately the same helper the JsonStore path uses. Two
        // implementations of "was this a revision" would disagree on exactly
        // the boundary cases, and the disagreement would be invisible until
        // somebody diffed the two stores.
        if (BITEMPORAL_COLLECTIONS.includes(collection)) {
          const { rows: predecessors } = await client.query(
            'SELECT body FROM lite_records WHERE collection = $1 AND id = ANY($2::text[])',
            [collection, items.map((item) => item.id)],
          )
          const superseded = supersededVersions(
            collection,
            predecessors.map((row) => row.body),
            items,
          )
          if (superseded.length) {
            await this.insertRecords(client, 'record_versions', superseded)
          }
        }
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

  /**
   * Deletes records by id — the counterpart to merge(), and the reason
   * apply-retention can now actually expire anything (DAT-07).
   */
  async remove({ collection: doomedByCollection = {} } = {}) {
    await this.ensureSchema()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const [collection, ids] of Object.entries(doomedByCollection)) {
        assertDeclaredCollection(collection)
        if (!ids?.length) continue
        await client.query(
          'DELETE FROM lite_records WHERE collection = $1 AND id = ANY($2::text[])',
          [collection, ids],
        )
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
   * Replaces the derived collections wholesale.
   *
   * This previously took four parameters where the caller passes six and then
   * delegated to merge(), so on Postgres `population_at_risk` and
   * `facilities_at_risk` were computed and silently dropped, and stale rows for
   * regions that no longer qualify survived forever (DAT-05). JsonStore got
   * this right; the two backends disagreed on impact figures depending on which
   * one an environment variable selected.
   *
   * The set now comes from DERIVED_COLLECTIONS, the same declaration JsonStore
   * reads, so neither adapter can name four where the other names six.
   */
  async replaceAnalytics(payload = {}) {
    assertDeclaredCollections(payload)
    await this.ensureSchema()
    const replacement = Object.fromEntries(
      DERIVED_COLLECTIONS.map((collection) => [collection, payload[collection] || []]),
    )
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const [collection, items] of Object.entries(replacement)) {
        await client.query('DELETE FROM lite_records WHERE collection = $1', [collection])
        await this.insertRecords(client, collection, items.filter((item) => item?.id))
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

  async close() {
    if (this.pool?.end) await this.pool.end()
  }
}
