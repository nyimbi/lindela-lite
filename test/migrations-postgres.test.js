/**
 * ENH-29 part 2, against a real PostgreSQL.
 *
 * `test/migrations.test.js` drives `pendingMigrations` and
 * `schemaLedgerRows` as pure functions, which is the right way to catch a list
 * that stops being ordered. It cannot catch a *statement* that Postgres
 * rejects, and that is where this file earns its keep: three defects in the
 * migration list shipped because every Postgres test in this project skipped
 * itself, and all three were only reachable by running them.
 *
 *   1. `ensureSchema()` read `schema_version` before applying anything, so a
 *      database created by that same method had no such column and the first
 *      connect died with `column "schema_version" does not exist`.
 *   2. The ledger row recording a migration names `schema_version`, but the
 *      statement that added it was migration *2* — so applying migration 1 to a
 *      fresh database failed the same way, one step later.
 *   3. The generated `observed_at` column used `::timestamptz`, and
 *      `timestamptz_in` is STABLE, so `GENERATED ALWAYS ... STORED` was
 *      rejected outright: "generation expression is not immutable".
 *
 * A migration suite that runs zero migrations and reports green is the failure
 * mode this project has already hit twice, so this file provisions its own
 * cluster (test/pg-harness.mjs) and only skips if there is genuinely no
 * PostgreSQL on the machine — loudly, and as a failure under CI.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { PostgresStore } from '../src/postgres-store.js'
import { MIGRATIONS, SCHEMA_VERSION, migrationStatements, targetVersion } from '../src/migrations.js'
import { filterRecords } from '../src/utils.js'
import { postgresCluster } from './pg-harness.mjs'

describe('the migration runner, against a real PostgreSQL', () => {
  let cluster
  let store
  let sql
  /** Whether the database had no lite_records when this file started. */
  let startedEmpty = false
  /** Whether the database had no lite_records when this file started. */
  /** Skips loudly; fails outright under CI, where green must have meant something. */
  const needsPostgres = (t) => {
    const reason = cluster?.skipped
    if (!reason) return false
    if (process.env.CI) {
      throw new Error(
        `CI ran the migration suite without a database: ${reason}. Every test here would have `
        + 'passed without executing a single statement.',
      )
    }
    t.skip(`no PostgreSQL: ${reason}`)
    return true
  }

  /** A raw client, for the database surgery the runner cannot do for itself. */
  const client = async () => {
    if (!sql) {
      const pg = (await import('pg')).default
      sql = new pg.Client({ connectionString: cluster.url })
      await sql.connect()
    }
    return sql
  }

  const reset = async () => {
    const db = await client()
    await db.query('DROP TABLE IF EXISTS lite_records')
    await db.query('DROP INDEX IF EXISTS lite_records_region_idx')
    await db.query('DROP INDEX IF EXISTS lite_records_observed_idx')
    await db.query('DROP INDEX IF EXISTS lite_records_collection_hash_idx')
    await db.query('DROP INDEX IF EXISTS lite_records_schema_version_idx')
    // A conflicting object, if the previous test planted one.
    await db.query('DROP TABLE IF EXISTS lite_records_region_idx')
  }

  /** A store that has not yet decided it is ready. */
  const freshStore = () => new PostgresStore({ databaseUrl: cluster.url })

  /** A real pool whose pooled clients refuse any statement naming `needle`. */
  const sabotagedPool = async (connectionString, needle) => {
    const pg = (await import('pg')).default
    const base = new pg.Pool({ connectionString })
    return {
      query: (...args) => base.query(...args),
      end: () => base.end(),
      connect: async () => {
        const leased = await base.connect()
        const run = leased.query.bind(leased)
        leased.query = (...args) => {
          const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
          if (typeof text === 'string' && text.includes(needle)) {
            return Promise.reject(new Error(`statement refused by the test: ${needle}`))
          }
          return run(...args)
        }
        return leased
      },
    }
  }

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-migrations' })
    if (cluster.skipped) {
      process.stderr.write(`migrations-postgres: ${cluster.skipped}\n`)
      return
    }
    await reset()
    const probe = await client()
    startedEmpty = (await probe.query(`SELECT to_regclass('lite_records') AS relation`)).rows[0].relation === null
    store = freshStore()
    await store.ensureSchema()
  })

  after(async () => {
    await sql?.end()
    await store?.close()
    await cluster?.stop()
  })

  it('applied every migration to a database that started with no table at all', async (t) => {
    // The precondition is captured in before(), before anything ran. "Applied
    // three migrations" and "silently did nothing" produce the same ledger
    // read, so a test that has not seen the starting state proves nothing.
    if (needsPostgres(t)) return
    assert.equal(startedEmpty, true, 'this file ran against a database that already had lite_records')
  })

  it('leaves the database at the version this build expects', async (t) => {
    if (needsPostgres(t)) return
    assert.equal(SCHEMA_VERSION, targetVersion())
    assert.equal(await store.readSchemaVersion(), SCHEMA_VERSION)
  })

  it('records one ledger row per migration, each naming its version', async (t) => {
    if (needsPostgres(t)) return
    const db = await client()
    const { rows } = await db.query(
      `SELECT id, body, schema_version FROM lite_records
       WHERE collection = '__schema' ORDER BY schema_version`,
    )
    assert.equal(rows.length, MIGRATIONS.length, 'a migration ran without recording itself')
    for (const migration of MIGRATIONS) {
      const row = rows.find((r) => r.schema_version === migration.version)
      assert.ok(row, `no ledger row for v${migration.version}`)
      assert.equal(row.id, `schema-${migration.version}`)
      assert.equal(row.body.name, migration.name)
    }
  })

  it('created the columns and indexes the migrations keep, and dropped the ones nothing reads', async (t) => {
    if (needsPostgres(t)) return
    const db = await client()
    const { rows } = await db.query(
      `SELECT column_name, is_generated FROM information_schema.columns
       WHERE table_name = 'lite_records'`,
    )
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    for (const column of ['payload_hash', 'schema_version', 'partner_org']) {
      assert.ok(byName[column], `migration promised a ${column} column and it is not there`)
    }

    // R-30 and R-31. Migrations 3 and 5 added ten STORED generated columns for
    // filters that run in JavaScript after the read; `PostgresStore.read` takes
    // no filter, so nothing can reach any of them. Migration 7 drops them, and
    // this is the assertion that they are actually gone from a migrated
    // database — the pure-function test can only check the statement exists.
    //
    // Asserting on the *columns* rather than on the indexes is deliberate:
    // dropping a column drops its index with it, so an index-name check would
    // pass on a database where the drop had silently failed to cascade.
    for (const column of [
      'region', 'observed_at', 'country', 'source', 'status', 'severity',
      'incident_id', 'intervention_id', 'service_type', 'owner',
    ]) {
      assert.ok(
        !byName[column],
        `${column} survived migration 7 — it is recomputed on every INSERT and read by no query`,
      )
    }

    const indexes = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'lite_records'`)
    const names = indexes.rows.map((r) => r.indexname)
    for (const index of ['lite_records_collection_hash_idx', 'lite_records_schema_version_idx']) {
      assert.ok(names.includes(index), `${index} is missing`)
    }
    for (const index of ['lite_records_region_idx', 'lite_records_observed_idx']) {
      assert.ok(!names.includes(index), `${index} outlived the column it indexed`)
    }
  })

  it('is idempotent: a second connect applies nothing and errors on nothing', async (t) => {
    if (needsPostgres(t)) return
    const db = await client()
    const { rows: before } = await db.query(`SELECT count(*)::int AS n FROM lite_records WHERE collection = '__schema'`)
    const reopened = freshStore()
    await reopened.ensureSchema()
    const { rows: after_ } = await db.query(`SELECT count(*)::int AS n FROM lite_records WHERE collection = '__schema'`)
    assert.equal(after_[0].n, before[0].n, 'reconnecting duplicated the ledger')
    assert.equal(await reopened.readSchemaVersion(), SCHEMA_VERSION)
    await reopened.close()
  })

  it('every statement survives being run twice in one transaction', async (t) => {
    if (needsPostgres(t)) return
    // The promise migrations make to a database that predates the ledger: the
    // statements decide for themselves whether they have run, because
    // readSchemaVersion() answers 0 for anything it cannot vouch for. Asserted
    // here against a real server rather than by the regex in migrations.test.js,
    // which cannot tell an `IF EXISTS` from an `IF EXISTS` on the wrong table.
    const db = await client()
    await db.query('BEGIN')
    try {
      for (const statement of [...migrationStatements(0), ...migrationStatements(0)]) {
        await db.query(statement)
      }
      await db.query('COMMIT')
    } catch (error) {
      await db.query('ROLLBACK')
      throw new Error(`a migration statement is not replayable: ${error.message}`)
    }
  })

  it('converges from a database that has lost its ledger, and does not resurrect the dropped columns', async (t) => {
    if (needsPostgres(t)) return
    // The upgrade path that matters: a database at some unknown older state, or
    // one restored from a backup taken before the ledger existed.
    //
    // The three columns are dropped before the repair and asserted *absent*
    // after it. Before migration 7 the assertion was the reverse — that a
    // replay recreates them — and that was correct while they existed. What it
    // tests now is the property the ledger loss actually threatens: a replay
    // runs every migration in order, so migrations 3 and 5 re-add the ten
    // columns and migration 7 must drop them again in the same pass. A
    // database that converged to a state where the drop did not re-run would
    // carry the write amplification this repair exists to remove, and would
    // look repaired.
    const db = await client()
    await db.query(`DELETE FROM lite_records WHERE collection = '__schema'`)
    await db.query('ALTER TABLE lite_records DROP COLUMN IF EXISTS observed_at')
    await db.query('ALTER TABLE lite_records DROP COLUMN IF EXISTS region')
    await db.query('ALTER TABLE lite_records DROP COLUMN IF EXISTS severity')
    assert.equal(await store.readSchemaVersion(), 0)

    const repaired = freshStore()
    await repaired.ensureSchema()
    assert.equal(await repaired.readSchemaVersion(), SCHEMA_VERSION)
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'lite_records'
         AND column_name IN ('region', 'observed_at', 'severity', 'country', 'owner')`,
    )
    assert.deepEqual(
      rows.map((r) => r.column_name),
      [],
      'a replayed migration re-added a column migration 7 is meant to have dropped',
    )
    await repaired.close()
  })

  it('keeps every completed migration recorded when a later one fails', async (t) => {
    if (needsPostgres(t)) return
    // One transaction per migration, not one for the batch. A failure at v3
    // must leave v1 and v2 applied *and recorded*, so the next connect retries
    // one statement rather than re-running statements that already succeeded.
    //
    // The failure is induced through a pool that refuses one statement, rather
    // than by planting an object in the database. Every migration statement is
    // written to be replayable, which means the database has almost nothing
    // left that can make one fail — the very property being relied on. Refusing
    // the statement is the only way to reach the error path from a test without
    // adding a parameter to production code that exists only for the test.
    const db = await client()
    await db.query('DROP TABLE IF EXISTS lite_records')

    const failing = new PostgresStore({ pool: await sabotagedPool(cluster.url, 'lite_records_observed_idx') })
    await assert.rejects(() => failing.ensureSchema(), /refused by the test/)

    assert.equal(await failing.readSchemaVersion(), 2, 'v1 and v2 should have survived the failure')
    const { rows } = await db.query(
      `SELECT schema_version FROM lite_records WHERE collection = '__schema' ORDER BY schema_version`,
    )
    assert.deepEqual(rows.map((r) => r.schema_version), [1, 2])
    // And the rolled-back migration left nothing behind to half-apply.
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'lite_records' AND column_name = 'observed_at'`,
    )
    assert.deepEqual(columns.rows, [], 'the failed migration left a column behind')
    await failing.close()

    // And the retry, against a normal pool, finishes the job.
    const repaired = freshStore()
    await repaired.ensureSchema()
    assert.equal(await repaired.readSchemaVersion(), SCHEMA_VERSION)
    await repaired.close()
  })

  it('does not let write() take the ledger with it', async (t) => {
    // write() is DELETE-then-full-reinsert across every collection. A blanket
    // DELETE would drop the ledger, which is survivable only because every
    // migration is idempotent — so the cost of getting it wrong is a full
    // re-run on the next connect rather than a corruption. A cost worth not
    // paying.
    if (needsPostgres(t)) return
    await store.write({ hazard_events: [{ id: 'hz-1', observed_at: '2026-01-01T00:00:00.000Z' }] })
    assert.equal(await store.readSchemaVersion(), SCHEMA_VERSION)
    const db = await client()
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM lite_records WHERE collection = '__schema'`)
    assert.equal(rows[0].n, MIGRATIONS.length)
    assert.equal((await store.read()).hazard_events.length, 1)
  })

  it('keeps every filter working after the columns that were meant to index them are gone', async (t) => {
    if (needsPostgres(t)) return
    const db = await client()
    await db.query(`DELETE FROM lite_records WHERE collection = '__schema'`)
    await db.query('DELETE FROM lite_records WHERE collection = $1', ['hazard_events'])
    await db.query(
      `INSERT INTO lite_records (collection, id, body) VALUES
        ('hazard_events', 'hz-region', '{"id": "hz-region", "district": "Turkana", "observed_at": "2026-03-01T10:20:30.500Z"}'),
        ('hazard_events', 'hz-area',   '{"id": "hz-area", "area": "Marsabit", "observed_at": "2026-02-01T00:00:00.000Z"}'),
        ('hazard_events', 'hz-junk',   '{"id": "hz-junk", "observed_at": "last Tuesday"}'),
        ('hazard_events', 'hz-blank',  '{"id": "hz-blank", "observed_at": ""}')`,
    )

    // The columns that used to answer these two questions are gone, so this
    // asks the question the API actually asks — through `filterRecords`, which
    // is where every filter has always run. The point of the test is that
    // removing the columns removed no *behaviour*: the read still returns every
    // row and the filter still selects from it.
    const store2 = new PostgresStore({ databaseUrl: cluster.url })
    await store2.ensureSchema()
    const data = await store2.read()
    assert.equal(data.hazard_events.length, 4, 'the read is a whole-collection read and must stay one')

    const byDistrict = filterRecords(data.hazard_events, new URLSearchParams('district=Turkana'), {}, { unlimited: true })
    assert.deepEqual(byDistrict.map((r) => r.id), ['hz-region'])

    // `area` is a spelling the dropped `region` column COALESCE'd
    // (`district`, `region`, `area`) and `recordInDistrict` does not accept —
    // it matches `district`, `region`, `region_name`, `admin1` and
    // `scope.district`. So the column was wrong in both directions: it missed
    // rows the filter reaches (case-insensitive labels, comma-separated
    // multi-values, the haversine fallback, relation traversal) and it held
    // entries the filter never matches. An index built on it would have
    // returned rows this query must not, which is worse than the scan it
    // replaced. Asserted rather than described, because "the index column and
    // the filter disagree" is the claim the whole repair rests on.
    const byArea = filterRecords(data.hazard_events, new URLSearchParams('district=Marsabit'), {}, { unlimited: true })
    assert.deepEqual(byArea.map((r) => r.id), [], 'area is not a district spelling the filter accepts')

    // The time filter parses the first of nine fields that yields a date. Two
    // records here cannot be dated — `last Tuesday` and an empty string — and
    // the filter's contract is to *keep* a record it cannot date rather than
    // drop it, so both come back. That is the second way the dropped
    // `observed_at` column was not equivalent to its filter: the column was
    // NULL for exactly these rows, so a predicate on it would have dropped the
    // two records the filter is specified to return.
    const inMarch = filterRecords(data.hazard_events, new URLSearchParams('from=2026-03-01&to=2026-03-31'), {}, { unlimited: true })
    assert.deepEqual(inMarch.map((r) => r.id).sort(), ['hz-blank', 'hz-junk', 'hz-region'])
    await store2.close()
  })

  it('reports what it has run against what this build expects', async (t) => {
    if (needsPostgres(t)) return
    // A fresh instance, because the test above deleted the ledger to write rows
    // with raw SQL and the shared store has already decided it is ready — which
    // is itself the property that makes schemaStatus() trustworthy in a server
    // that connects once and holds the pool for a week.
    const reporting = freshStore()
    const status = await reporting.schemaStatus()
    assert.equal(status.current, SCHEMA_VERSION)
    assert.equal(status.expected, SCHEMA_VERSION)
    assert.deepEqual(status.pending, [])
    assert.equal(status.current_build_is_ahead, false)
    await reporting.close()
  })

  it('refuses nothing when the database is newer than the build', async (t) => {
    // Refusing to start pushes an operator into a manual downgrade, and the thing
    // they are avoiding — reading rows written by a newer schema — is the newer
    // schema's job to guard.
    if (needsPostgres(t)) return
    const db = await client()
    await db.query(
      `INSERT INTO lite_records (collection, id, body, schema_version)
       VALUES ('__schema', 'schema-999', '{"id":"schema-999"}', 999)
       ON CONFLICT (collection, id) DO UPDATE SET schema_version = 999`,
    )
    const status = await store.schemaStatus()
    assert.equal(status.current_build_is_ahead, true)
    assert.deepEqual(status.pending, [])
    await db.query(`DELETE FROM lite_records WHERE collection = '__schema'`)
    await store.ensureSchema()
  })
})
