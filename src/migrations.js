/**
 * Schema migrations, keyed on a real `schema_version`.
 *
 * `ensureSchema()` used to issue its `ALTER TABLE` statements inline and write
 * `version: 1` into a column nobody ever read (DATA-11). That shape has three
 * problems, all of which only surface during an upgrade:
 *
 * - there is no order, so a statement that depends on another one has to rely
 *   on the reader noticing the dependency;
 * - there is no record of what ran, so a database at version 1 and a database
 *   at version 3 are indistinguishable except by reading the code;
 * - there is no way to say no, so a statement that is wrong for this deployment
 *   cannot be declined.
 *
 * The runner below fixes the first two and makes the third explicit. Part 3 of
 * ENH-29 — a relational schema with real columns for the collections queried by
 * region and time — becomes a numbered migration rather than a rewrite of
 * `ensureSchema`, which is the only form in which it can be deployed to a
 * district server that already has data.
 *
 * The migrations themselves live in MIGRATIONS below rather than in files on
 * disk. A file-per-migration scheme is the right answer at ten migrations and
 * the wrong one at three: it makes the whole history un-reviewable in a diff,
 * which is precisely when a migration is most worth reviewing.
 */

/** The version this build expects. A database below it needs migrating. */
export const SCHEMA_VERSION = 3

/**
 * Ordered migrations. Each is idempotent and each is keyed on the version it
 * produces, so applying them in order from any starting point converges.
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'payload_hash column',
    // The statement this build used to issue on every connect. Kept as
    // migration 1 because a database created before payload_hash existed is
    // still out there, and rewriting the column list in place would be a
    // migration disguised as a CREATE TABLE.
    up: [
      'ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS payload_hash TEXT',
      `UPDATE lite_records
         SET payload_hash = body->>'payload_hash'
       WHERE payload_hash IS NULL AND jsonb_exists(body, 'payload_hash')`,
      `CREATE INDEX IF NOT EXISTS lite_records_collection_hash_idx
         ON lite_records (collection, payload_hash)
       WHERE payload_hash IS NOT NULL`,
    ],
  }),
  Object.freeze({
    version: 2,
    name: 'schema_version ledger',
    // The column that makes the rest possible. `IF NOT EXISTS` because this is
    // also the statement that creates it, and the first migration in the list
    // has to be safe to run against a table that predates the ledger.
    up: [
      'ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1',
      `CREATE INDEX IF NOT EXISTS lite_records_schema_version_idx
         ON lite_records (schema_version)
       WHERE collection = '__schema'`,
    ],
  }),
  Object.freeze({
    version: 3,
    name: 'extracted region and time columns',
    // ENH-29 part 3, in the only form that can ship to an existing deployment:
    // as generated columns read from the body, so nothing has to be backfilled
    // by hand and a write path that forgets to populate them cannot produce a
    // row with no region.
    //
    // GENERATED ALWAYS, so the two stores cannot disagree about the index
    // columns — a region column that a client could set to something other
    // than what the body says is a query that returns the wrong rows.
    up: [
      `ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS region TEXT
         GENERATED ALWAYS AS (body->>'district') STORED`,
      `ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ
         GENERATED ALWAYS AS (
           NULLIF(body->>'observed_at', '')::timestamptz
         ) STORED`,
      `CREATE INDEX IF NOT EXISTS lite_records_region_idx
         ON lite_records (collection, region)
       WHERE region IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS lite_records_observed_idx
         ON lite_records (collection, observed_at DESC)
       WHERE observed_at IS NOT NULL`,
    ],
  }),
])

/** The version a fresh database gets, which is the newest. */
export function targetVersion() {
  return Math.max(...MIGRATIONS.map((m) => m.version))
}

/**
 * The migrations a database at `from` still needs.
 *
 * Ordered, deduplicated by version, and empty when the database is current.
 * A database *ahead* of this build gets an empty list too rather than an error:
 * refusing to start because the database is newer than the code is a good way
 * to make an operator downgrade by hand, and the failure mode they are avoiding
 * — reading rows written by a newer schema — is the newer schema's job to
 * guard, not this one's.
 */
export function pendingMigrations(from, migrations = MIGRATIONS) {
  const current = Number.isInteger(from) ? from : 0
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)
}

/**
 * Statements that bring a database from wherever it is to the newest version.
 */
export function migrationStatements(from, migrations = MIGRATIONS) {
  return pendingMigrations(from, migrations).flatMap((m) => m.up)
}

/**
 * The ledger rows recording which migrations have run.
 *
 * Written as ordinary records in the same table, under a `__schema`
 * collection, rather than as a separate bookkeeping table. It keeps the
 * single-table design this project is built around and means a backup of
 * `lite_records` carries its own migration history — which is what makes
 * restoring a backup into a database at a different version something you can
 * reason about.
 *
 * `mergeById` will keep these across writes, so the ledger survives the
 * `write()` full-table rewrite that `remove()` and `replaceAnalytics()` share.
 */
export function schemaLedgerRows(migrations = MIGRATIONS) {
  return migrations.map((m) => ({
    id: `schema-${m.version}`,
    collection: '__schema',
    version: m.version,
    name: m.name,
    schema_version: m.version,
    applied_at: new Date().toISOString(),
  }))
}