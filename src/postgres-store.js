import { emptyStore } from './schema.js'
import { COLLECTIONS, DERIVED_COLLECTIONS, assertDeclaredCollection, assertDeclaredCollections, sortRecords, supersededVersions } from './store.js'
import { BITEMPORAL_COLLECTIONS, VERSIONS_PER_RECORD } from './bitemporal.js'
import { nowIso } from './utils.js'
import { pendingMigrations, targetVersion } from './migrations.js'

/**
 * The declared collections, as a Set.
 *
 * The membership test runs once per returned row on the read path that
 * `server.js` enters before the first route test, so `COLLECTIONS.includes()` —
 * a linear scan of a 46-element array, measured at 53 ms over 39,715 rows — is
 * the wrong shape for it.
 */
const DECLARED_COLLECTIONS = new Set(COLLECTIONS)

/**
 * `record_versions`: 60% of this store by bytes, and no reader in this
 * repository. Named rather than spelled, because the string appears in the
 * read path, the prune and the write of the rows themselves.
 */
const HISTORY_COLLECTION = 'record_versions'

/**
 * CON-02 and CON-03, one mechanism.
 *
 * `write()` deletes every row outside `__schema` and reinserts the whole store
 * inside one transaction; `merge()` upserts rows in that same table. The two
 * take row locks in opposite orders — a full-table DELETE against an upsert —
 * so they can deadlock, and nothing here set an isolation level, took an
 * advisory lock, or retried. A `write()` racing a `merge()` handed the caller a
 * raw `40P01` with no backoff: a 500 on whatever route lost the race, for a
 * condition the database resolves by itself in milliseconds.
 *
 * CON-03 is the same race seen from the other side. `upsertCollection` asks
 * which of a batch's `payload_hash` values are already present and inserts the
 * rest, so two concurrent merges both run the SELECT before either commits,
 * both see the hash absent, and both insert — with different ids and the same
 * content, which `ON CONFLICT (collection, id)` does not catch.
 *
 * Both are fixed by taking one transaction-scoped advisory lock as the first
 * statement of every write transaction (`#lockWrites`). Writers then queue, so
 * no two are ever holding rows in opposite orders — there is no inversion left
 * to deadlock on — and a merge's SELECT cannot run until the merge before it
 * has committed, which is exactly the serialisation the dedupe needs.
 *
 * Serialising *all* writes rather than retrying deadlocks is the deliberate
 * choice, and `JsonStore` is why: it already runs every write through one
 * promise chain (`#serialise`). A lock here gives the two backends the same
 * concurrency contract instead of leaving them to differ, and the recurring
 * defect in this codebase is precisely the two stores disagreeing about
 * semantics an environment variable selects between.
 *
 * The retry below is still here, and is not the primary mechanism. It covers
 * what the lock cannot: a `40001` serialization failure under a stricter
 * isolation level, and contention with a writer outside this process that does
 * not take the lock. Both codes are the ones Postgres names as retryable.
 * Anything else propagates immediately — retrying a syntax error or a
 * constraint violation would only pay the timeout three times before reporting
 * the same thing.
 *
 * The retry is safe because every write in this class is idempotent by
 * construction: an upsert keyed on `(collection, id)`, or a full-table rewrite
 * from a snapshot. Re-running one whose transaction rolled back cannot
 * double-apply.
 */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01'])
const WRITE_RETRY_ATTEMPTS = 3

/**
 * The advisory lock every write transaction takes.
 *
 * A constant, not a hash of anything: the point is that every writer in every
 * process on this database contends on the same key, and advisory locks are
 * already scoped to one database, so two deployments sharing a cluster do not
 * queue behind each other. `pg_advisory_xact_lock` releases at COMMIT or
 * ROLLBACK, so a crashed writer cannot leave it held.
 *
 * Exported because it is a contract rather than an implementation detail: a
 * second process — another replica, a maintenance script, a test — has to take
 * the *same* key to be serialised against this store, and a copy of the number
 * in another file is a copy that can drift into a lock nobody else holds.
 */
export const WRITE_LOCK_KEY = 4_001_001

function isRetryableWriteError(error) {
  return RETRYABLE_SQLSTATES.has(error?.code)
}

/** Full jitter, so three writers that collide do not collide again in lockstep. */
function retryDelayMs(attempt) {
  return Math.floor(Math.random() * (25 * 2 ** attempt))
}

export async function withWriteRetry(fn, { attempts = WRITE_RETRY_ATTEMPTS } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (!isRetryableWriteError(error)) throw error
      lastError = error
      if (attempt < attempts - 1) {
        // Not unref'd: the caller is awaiting this, and an unref'd timer that
        // nothing else keeps alive lets the process exit mid-retry with the
        // promise unresolved.
        await new Promise((resolve) => { setTimeout(resolve, retryDelayMs(attempt)) })
      }
    }
  }
  throw lastError
}

/**
 * Accepts `read()`, `read({ collections, includeHistory })` and
 * `read(['incidents'])` alike.
 *
 * The array form exists because a collection manifest is a list and reading one
 * is what a caller means by naming it. The object form is where the options go
 * once there is more than one. `null` for "no manifest" is distinct from `[]`
 * for "an empty manifest", because the first is a whole-store read and the
 * second is a read that returns nothing — and conflating them would make
 * `read([])` a way to accidentally read everything.
 */
function normaliseReadOptions(options) {
  if (Array.isArray(options)) return { collections: options, includeHistory: false, partnerOrg: null }
  const { collections = null, includeHistory = false, partnerOrg = null } = options || {}
  return {
    collections: collections === null || collections === undefined ? null : [...collections],
    includeHistory: Boolean(includeHistory),
    // ENH-17. Null means "this token is not scoped to a partner organisation",
    // which is a different statement from "this caller may see everything" and
    // has to stay distinguishable: `partner_org = $2` with a null parameter
    // matches nothing, which would blank every partner's view rather than
    // over-share it.
    partnerOrg: typeof partnerOrg === 'string' && partnerOrg ? partnerOrg : null,
  }
}

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
   * Takes the write lock, and must be the first statement in a transaction.
   *
   * See `WRITE_LOCK_KEY` for why every writer takes one lock rather than
   * retrying deadlocks. This is the whole of CON-02 and the concurrency half of
   * CON-03: once it has returned, no other write transaction in any process is
   * in flight against this database, so a merge's dedupe SELECT cannot run
   * before the merge that would have made it a duplicate has committed.
   *
   * `pg_advisory_xact_lock` rather than the session-scoped form: it is released
   * by COMMIT or ROLLBACK, so there is no path — including a thrown error, a
   * released client, or a killed connection — on which the lock outlives the
   * transaction that took it. A session lock would need an explicit unlock on
   * every exit, and the one that was missed would be a store that accepts no
   * writes until the pool connection is recycled.
   *
   * The wait is unbounded. `pg_advisory_xact_lock` has no timeout, which is
   * correct here: the transactions it guards are a single upsert batch, and a
   * bounded wait would convert a slow write into a failed one for a caller that
   * has no better answer than waiting. A genuinely stuck writer is a
   * `pg_locks` question, not one to paper over with a timeout that returns 500.
   */
  async #lockWrites(client) {
    await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK_KEY])
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

  /**
   * The whole store, or only the collections the caller named.
   *
   * Backward-compatible by construction: `read()`, `read({ ... })` and
   * `read(['incidents'])` are all valid, and the first returns what it always
   * did minus the history. Every existing call site keeps working, which is
   * deliberate — the routes that should pass a manifest live in `server.js`
   * and are being changed for an unrelated reason, so the signature has to
   * accept what they pass today while making the manifest available tomorrow.
   *
   * `includeHistory` is off by default. See the SQL below for why that does not
   * weaken the auditability claim.
   */
  async read(options = {}) {
    await this.ensureSchema()
    const { collections, includeHistory, partnerOrg } = normaliseReadOptions(options)

    const clauses = ["collection <> '__schema'"]
    const params = []
    if (collections !== null) {
      params.push(collections)
      clauses.push(`collection = ANY($${params.length}::text[])`)
    }
    if (!includeHistory) clauses.push(`collection <> '${HISTORY_COLLECTION}'`)
    // ENH-17: the partner-organisation predicate in the WHERE clause, not in a
    // filter over what was already fetched. An index lookup on (collection,
    // partner_org) instead of an O(N) scan over rows the caller may not see.
    //
    // This is one deployment serving one country programme, and this predicate
    // keeps one partner organisation out of another's field reports. It is not a
    // tenancy boundary, and it is not the only thing standing between two NGOs:
    // `filterRecords` still applies the same predicate in JavaScript over what
    // comes back. This clause removes rows the caller may not see from the
    // result rather than replacing that check.
    //
    // Strict equality, deliberately — `filterRecords` uses `===`, so a record
    // with no partner is invisible to a partner token, and
    // `partner_org IS NULL OR partner_org = $2` would hand every partner token
    // every untagged row in the deployment. Verified against PostgreSQL 18: the
    // strict form returns 1 of 4 seeded rows, the nullable form returns 3.
    if (partnerOrg) {
      params.push(partnerOrg)
      clauses.push(`partner_org = $${params.length}`)
    }

    // ENH-07 / ENH-08. This used to be
    //
    //     SELECT collection, body, updated_at FROM lite_records
    //      ORDER BY updated_at DESC, collection, id
    //
    // — no WHERE, no LIMIT, and called at the top of every request in
    // `server.js` before the first route test, so a 404 paid for a full
    // materialisation of 39,715 rows / 143 MB, and so did every write. The
    // ORDER BY could not use `lite_records_collection_updated_idx` at all,
    // because the sort leads with `updated_at` globally rather than within a
    // collection: an explicit sort on top of a scan that returned everything
    // anyway.
    //
    // Three things changed:
    //
    // - `collection = ANY($1)` when the caller names a manifest, so the
    //   transfer becomes proportional to what was asked for rather than to
    //   everything the system has ever stored.
    // - `record_versions` is excluded by default. It is 60% of this store by
    //   bytes — 85 MB of 143 MB, 31,549 rows — and nothing in this repository
    //   reads it: `valueAsOf` and `versionsFor` have zero non-test callers. The
    //   collection stays writable and queryable; `includeHistory` brings it
    //   back. ADR-013's claim is that the history exists, not that every
    //   request pays to transfer it.
    // - `__schema` is excluded in SQL rather than by a linear scan below.
    //
    // The ORDER BY is gone entirely. It was never the return order — that is
    // `sortRecords`, the same comparator `JsonStore` uses, because `updated_at`
    // is stamped `now()` at write time and so sorts by insertion rather than by
    // when the record describes. All the ordering bought was `rows[0]`, which
    // `#newestWrite()` answers without touching the bodies.
    const { rows } = await this.pool.query(
      `SELECT collection, body FROM lite_records WHERE ${clauses.join(' AND ')}`,
      params,
    )

    const store = emptyStore()
    // A Set, not `COLLECTIONS.includes()`. The array form ran a linear scan per
    // returned row — measured at 53 ms across 39,715 of them — and every row it
    // rejected is a row the WHERE above has already removed.
    const wanted = collections === null
      ? DECLARED_COLLECTIONS
      : new Set(collections.filter((collection) => DECLARED_COLLECTIONS.has(collection)))
    // A declared collection with no `emptyStore()` key is a skew between the two
    // declarations, and the loop below is where it would otherwise throw — a
    // read failing on a collection the caller never asked about. Seeding the
    // keys first costs 46 assignments and makes the skew an empty list rather
    // than an exception; `test/store-schema-declaration.test.js` is what keeps
    // the two declarations from drifting in the first place.
    for (const collection of COLLECTIONS) {
      if (!Array.isArray(store[collection])) store[collection] = []
    }
    for (const row of rows) {
      if (wanted.has(row.collection)) store[row.collection].push(row.body)
    }
    // R-35. Sorting here, on every read, is what makes the two adapters agree.
    // `JsonStore` now does the same on its parse; previously it sorted at write
    // time via `mergeById`, which `write()` bypassed, so the same records came
    // back in different orders depending on how they got in.
    for (const collection of COLLECTIONS) {
      if (store[collection].length) store[collection] = sortRecords(store[collection])
    }
    store.updated_at = (await this.#newestWrite()) || nowIso()
    return store
  }

  /**
   * When the store was last written, without ordering the whole table to find it.
   *
   * `max(updated_at)` per collection, grouped, then maxed again. The existing
   * `(collection, updated_at DESC)` index holds exactly the two columns this
   * groups and orders by, so the planner can answer it from the index rather
   * than reading 143 MB of bodies; the outer aggregate then reduces ~46 group
   * rows to one. The flat `SELECT max(updated_at) FROM lite_records` this
   * replaces — as the tail of a 39,715-row sort — had no index to use at all.
   */
  async #newestWrite() {
    const { rows } = await this.pool.query(
      `SELECT max(per_collection.newest) AS newest FROM (
         SELECT max(updated_at) AS newest
           FROM lite_records
          WHERE collection <> '__schema'
          GROUP BY collection
       ) per_collection`,
    )
    return rows[0]?.newest ? new Date(rows[0].newest).toISOString() : null
  }

  async write(data) {
    assertDeclaredCollections(data)
    await this.ensureSchema()
    const next = { ...emptyStore(), ...data, updated_at: nowIso() }
    // CON-02. This is the transaction that takes a row lock across essentially
    // the whole table (`DELETE … WHERE collection <> '__schema'`), so it is the
    // one most likely to be the deadlock victim when it races a merge.
    return withWriteRetry(() => this.#writeOnce(next))
  }

  async #writeOnce(next) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#lockWrites(client)
      // NOT the whole table. `__schema` holds the migration ledger, and a
      // blanket DELETE would drop it — which is survivable only because every
      // migration is idempotent, so the cost of getting it wrong is a full
      // re-run of statements on the next connect rather than a corruption. That
      // is a cost worth not paying, and the ledger is the one thing in this
      // table that write() is not the owner of.
      await client.query("DELETE FROM lite_records WHERE collection <> '__schema'")
      // One statement, not one per collection. 46 sequential round-trips on a
      // path whose whole cost is already `O(N + B)` — the statement count was a
      // constant the audit measured as part of write latency and it was free to
      // remove.
      const flat = []
      for (const collection of COLLECTIONS) {
        for (const item of next[collection] || []) flat.push({ collection, item })
      }
      if (flat.length) await this.#insert(client, flat)
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
    await this.#insert(client, items.map((item) => ({ collection, item })))
  }

  /**
   * The one INSERT both write paths share, for records from any mix of
   * collections.
   *
   * Split out from `insertRecords` so `write()` can put the whole store through
   * a single statement instead of one per collection. The parameter shape is
   * UNNEST rather than a loop of single-row inserts because the primary key is
   * `(collection, id)`: a batch whose members share a collection would collide
   * inside one statement unless `ON CONFLICT` saw them together, and one
   * statement also means one plan and one network round-trip.
   */
  async #insert(client, flat) {
    if (!flat.length) return
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
        flat.map((row) => row.collection),
        flat.map((row) => row.item.id),
        flat.map((row) => JSON.stringify(row.item)),
        flat.map((row) => row.item.payload_hash ?? null),
      ],
    )
  }

  /**
   * Replaces one collection wholesale, leaving every other collection alone.
   *
   * R-25. Four routes in `server.js` (`:2807`, `:2834`, `:2853`, `:2931`) add
   * one parametric rule or one disbursement by reading the whole store,
   * splicing one array, and calling `write()` — which is `O(N + B)`: every row
   * in the table deleted and every row put back, to change one. On a 39,715-row
   * / 143 MB store that is a full rewrite to append a record.
   *
   * This is the primitive those routes want: one DELETE scoped by collection,
   * one INSERT. It is a *replace* rather than a merge because the callers
   * compute the new contents of the collection from what they just read —
   * `merge()` would shallow-merge per record and leave anything they dropped
   * behind, which for a rule that has just been withdrawn is exactly wrong.
   *
   * The four call sites have to change to use it; they are in `server.js` and
   * are not edited here.
   */
  async replaceCollection(collection, records = []) {
    assertDeclaredCollection(collection)
    await this.ensureSchema()
    // CON-02. A full-collection DELETE racing a merge is the same inversion the
    // retry was written for; the lock removes it rather than surviving it.
    return withWriteRetry(() => this.#replaceCollectionOnce(collection, records))
  }

  async #replaceCollectionOnce(collection, records) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#lockWrites(client)
      await client.query('DELETE FROM lite_records WHERE collection = $1', [collection])
      await this.insertRecords(client, collection, records.filter((item) => item?.id))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async merge(partial) {
    assertDeclaredCollections(partial)
    await this.ensureSchema()
    const writes = []
    for (const collection of COLLECTIONS) {
      const incoming = (partial[collection] || []).filter((item) => item?.id)
      if (incoming.length) writes.push({ collection, items: incoming })
    }
    // ENH-11 / R-24. Nothing below reads the store back, and every one of the
    // 44 call sites discards what it used to return. Return early, not
    // expensively.
    if (!writes.length) return

    // CON-02. The whole transaction is retried, not the statement: a deadlock
    // aborts the transaction, so the only correct retry starts a new one.
    await withWriteRetry(() => this.#mergeOnce(writes))
  }

  async #mergeOnce(writes) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#lockWrites(client)
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
            // Bounded on insert. The JSON store prunes in memory because it
            // holds the whole table; Postgres has to ask, and asking only when
            // someone remembers is how the demo store reached 37,735 rows.
            // A collection that is already at the cap contributes no new
            // versions until something prunes it — which would silently stop
            // recording history, so the prune runs first.
            //
            // R-26: for the records this batch actually revised, and no
            // others. See `pruneVersions`.
            await this.pruneVersions(client, superseded.map((row) => row.record_id))
            await this.insertRecords(client, HISTORY_COLLECTION, superseded)
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
    // ENH-11 / R-24. No read-back. Every call site in this repository discards
    // the return value, and the read it used to end on was a full materialisation
    // of every row in the table — so every write cost twice what it wrote.
    // `src/ingestion.js:392` still destructures the result into `data` and hands
    // it on; nothing reads it there either, and it is the one call site that
    // has to be edited before this can be described as having no consumers.
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
  /**
   * Bound the version table.
   *
   * The window is kept per record: a record's own most recent
   * `VERSIONS_PER_RECORD` revisions, decided in SQL so the table is never
   * materialised whole. Rows whose record has dropped below the cap are left
   * alone; rows beyond it are the oldest for their record and go.
   *
   * `valueAsOf` for the recent past is unaffected. History older than the
   * window returns "no version covering that time", which is the honest answer
   * and is better than the alternative this replaces: a table that grows until
   * the process cannot read it twice.
   *
   * R-26. `recordIds` is the set of records this merge produced history for,
   * and the window scan is restricted to exactly those. It used to partition
   * and order the *entire* version table — 31,549 rows / 85 MB — on two
   * unindexed JSONB extractions, on every bitemporal merge, to enforce a cap
   * of five rows on the handful of records that had just changed. Nothing else
   * in the table could have crossed the cap from this merge, because a merge
   * only adds history for the records it revised.
   *
   * Migration 5 indexes `(collection, body->>'record_id')`, so the restriction
   * is an index range rather than a filter over the heap. `O(V)` became
   * `O(k log V)` for the k records in the batch.
   */
  async pruneVersions(client, recordIds = []) {
    const ids = [...new Set((recordIds || []).filter(Boolean))]
    if (!ids.length) return
    await client.query(
      `DELETE FROM lite_records v
        WHERE v.collection = '${HISTORY_COLLECTION}'
          AND v.id IN (
            SELECT id FROM (
              SELECT id, row_number() OVER (
                PARTITION BY body->>'record_id'
                ORDER BY body->>'valid_to' DESC NULLS LAST
              ) AS rank
              FROM lite_records
               WHERE collection = '${HISTORY_COLLECTION}'
                 AND body->>'record_id' = ANY($1::text[])
            ) ranked WHERE ranked.rank > $2
          )`,
      [ids, VERSIONS_PER_RECORD],
    )
  }

  async upsertCollection(client, collection, items) {
    // R-32. Ask only about the hashes in this batch.
    //
    // This used to ship every `payload_hash` in the collection to Node to build
    // a Set — 4,517 rows for `food_security_records`, and more for every
    // collection with a real archive behind it. `lite_records_collection_hash_idx`
    // already exists and already has exactly the shape this needs: a lookup of
    // a handful of values, answered from the index, returning at most `k` rows
    // instead of `C`.
    const hashes = items.map((item) => item.payload_hash).filter(Boolean)
    const seen = new Set()
    if (hashes.length) {
      const { rows: existingHashes } = await client.query(
        `SELECT payload_hash FROM lite_records
         WHERE collection = $1 AND payload_hash = ANY($2::text[])`,
        [collection, hashes],
      )
      for (const row of existingHashes) seen.add(row.payload_hash)
    }
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
    // CON-02. Same inversion as `write()`: a multi-collection DELETE against a
    // merge. Serialised with every other writer rather than retried.
    return withWriteRetry(() => this.#removeOnce(doomedByCollection))
  }

  async #removeOnce(doomedByCollection) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#lockWrites(client)
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
    // ENH-11 / R-24. See `merge()` — no consumer, so no read-back.
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
    // CON-02. Six DELETEs across the derived collections, racing every merge
    // that writes them.
    return withWriteRetry(() => this.#replaceAnalyticsOnce(replacement))
  }

  async #replaceAnalyticsOnce(replacement) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#lockWrites(client)
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
    // ENH-11 / R-24. See `merge()` — no consumer, so no read-back.
  }

  async close() {
    if (this.pool?.end) await this.pool.end()
  }
}
