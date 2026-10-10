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
export const SCHEMA_VERSION = 6

/**
 * The eight filters `filterRecords` implements in JavaScript with no index
 * behind them, and the generated-column expression each one answers from.
 *
 * ENH-10. Every expression is the *whole* set of names that filter accepts for
 * that field, joined by COALESCE — because an index over one spelling answers
 * for one connector and silently answers nothing for the other, which is worse
 * than no index: the query still returns the right rows, just by scanning.
 *
 * `jsonb_typeof(...) = 'string'` is not decoration. `->>` on a JSON *object*
 * returns the serialised object, so a record with `country: {code: 'KE'}` would
 * put `{"code": "KE"}` into an index that a `?country=KE` filter never matches,
 * and every such row would be an index entry bought to answer nothing. The
 * connectors send objects as often as they send strings, and `filterRecords`
 * would never have matched the object either — so NULL here loses nothing and
 * keeps the index to the values it can actually serve.
 *
 * Kept as one table rather than eight hand-written statements so the count and
 * the spellings are checkable: `test/store-cost.test.js` asserts eight columns,
 * eight indexes and eight `GENERATED ALWAYS` clauses, which is the only way to
 * notice one of them quietly losing its index.
 *
 * Index key is `(collection, <column>)` for the filters that are scoped to a
 * collection page. `incident_id` and `intervention_id` are not: those two are
 * looked up across every collection at once — "everything attached to this
 * incident" spans hazard events, field reports, interventions and tasks — so a
 * leading `collection` would answer only the first of those collections asked.
 */
const FILTER_COLUMNS = Object.freeze([
  ['country', `CASE
      WHEN jsonb_typeof(body->'country') = 'string' THEN body->>'country'
      WHEN jsonb_typeof(body#>'{scope,country}') = 'string' THEN body#>>'{scope,country}'
      ELSE NULL END`],
  ['source', `CASE
      WHEN jsonb_typeof(body->'source') = 'string' THEN body->>'source'
      WHEN jsonb_typeof(body->'source_name') = 'string' THEN body->>'source_name'
      ELSE NULL END`],
  ['status', `CASE
      WHEN jsonb_typeof(body->'status') = 'string' THEN body->>'status'
      ELSE NULL END`],
  ['severity', `CASE
      WHEN jsonb_typeof(body->'severity') = 'string' THEN body->>'severity'
      WHEN jsonb_typeof(body->'risk_level') = 'string' THEN body->>'risk_level'
      ELSE NULL END`],
  ['incident_id', `CASE
      WHEN jsonb_typeof(body->'incident_id') = 'string' THEN body->>'incident_id'
      WHEN jsonb_typeof(body#>'{scope,incident_id}') = 'string' THEN body#>>'{scope,incident_id}'
      ELSE NULL END`],
  ['intervention_id', `CASE
      WHEN jsonb_typeof(body->'intervention_id') = 'string' THEN body->>'intervention_id'
      WHEN jsonb_typeof(body#>'{scope,intervention_id}') = 'string' THEN body#>>'{scope,intervention_id}'
      ELSE NULL END`],
  ['service_type', `CASE
      WHEN jsonb_typeof(body->'service_type') = 'string' THEN body->>'service_type'
      WHEN jsonb_typeof(body#>'{scope,service_type}') = 'string' THEN body#>>'{scope,service_type}'
      ELSE NULL END`],
  ['owner', `CASE
      WHEN jsonb_typeof(body->'owner') = 'string' THEN body->>'owner'
      ELSE NULL END`],
].map(Object.freeze))

/**
 * Ordered migrations. Each is idempotent and each is keyed on the version it
 * produces, so applying them in order from any starting point converges.
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'payload_hash and ledger columns',
    // The statements this build used to issue on every connect. Kept as
    // migration 1 because a database created before payload_hash existed is
    // still out there, and rewriting the column list in place would be a
    // migration disguised as a CREATE TABLE.
    //
    // The ledger column is here rather than in migration 2 for a reason that
    // only a real database reveals: the runner records each migration's
    // completion by inserting a row that names `schema_version`, so the column
    // has to exist before the *first* ledger row can be written. With the
    // statement in migration 2, applying migration 1 on a fresh database
    // failed with `column "schema_version" of relation "lite_records" does not
    // exist` — and no test noticed, because every Postgres test in the project
    // skipped itself.
    up: [
      'ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS payload_hash TEXT',
      `UPDATE lite_records
         SET payload_hash = body->>'payload_hash'
       WHERE payload_hash IS NULL AND jsonb_exists(body, 'payload_hash')`,
      `CREATE INDEX IF NOT EXISTS lite_records_collection_hash_idx
         ON lite_records (collection, payload_hash)
       WHERE payload_hash IS NOT NULL`,
      'ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1',
    ],
  }),
  Object.freeze({
    version: 2,
    name: 'schema_version ledger index',
    // The ledger is three rows at most and read once per connect, so this index
    // buys little. It is here because it was there, and removing it is a
    // downgrade someone would have to reason about on a deployment where the
    // ledger has grown rows this project has not imagined.
    up: [
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
      // Three spellings of the same idea, because the connectors disagree and
      // an index that only answers for one of them answers for a third of the
      // queries made of it.
      `ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS region TEXT
         GENERATED ALWAYS AS (
           COALESCE(body->>'district', body->>'region', body->>'area')
         ) STORED`,
      // The long hand is the only hand available.
      //
      // A generated column's expression must be IMMUTABLE, and every obvious
      // way of turning `body->>'observed_at'` into a timestamptz is not:
      // `::timestamptz` and `::timestamp` both resolve to STABLE input
      // functions, and so does the two-argument `to_timestamp(text, text)`.
      // Postgres rejects all three with "generation expression is not
      // immutable". `make_timestamp` is immutable, and `timezone(text,
      // timestamp)` is immutable, so together they parse an ISO-8601 instant
      // into a timestamptz that a STORED column may hold.
      //
      // The regex guard is what makes this safe against the field the sixteen
      // connectors actually send: a record with `observed_at: ''` or
      // `observed_at: 'last Tuesday'` becomes NULL rather than failing the
      // INSERT that stores it. A migration that rejects the data this product
      // ingests is not a migration, it is an outage on a district server.
      //
      // The nested CASE is the second half of that promise. The regex admits
      // `2026-02-31T00:00:00Z` — nine digits and a T — and `make_timestamp`
      // answers that with "date field value out of range", so every month, day
      // and hour is range-checked before it is handed over. Without those
      // checks a single malformed row already in the table makes migration 3
      // fail on the machine that has to run it.
      //
      // February is capped at 28, so 29 February yields NULL in a leap year.
      // One day in four, for a column whose whole job is to make a query
      // cheaper, is a trade worth making; rejecting the writes is not.
      `ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ
         GENERATED ALWAYS AS (
           CASE
             WHEN body->>'observed_at'
                  ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
             THEN CASE
               WHEN substring(body->>'observed_at', 6, 2)::int BETWEEN 1 AND 12
                AND substring(body->>'observed_at', 9, 2)::int BETWEEN 1 AND CASE
                      substring(body->>'observed_at', 6, 2)::int
                      WHEN 2 THEN 28 WHEN 4 THEN 30 WHEN 6 THEN 30
                      WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END
                AND substring(body->>'observed_at', 12, 2)::int <= 23
                AND substring(body->>'observed_at', 15, 2)::int <= 59
                AND substring(body->>'observed_at', 18, 2)::int <= 60
               THEN timezone('UTC', make_timestamp(
                 substring(body->>'observed_at', 1, 4)::int,
                 substring(body->>'observed_at', 6, 2)::int,
                 substring(body->>'observed_at', 9, 2)::int,
                 substring(body->>'observed_at', 12, 2)::int,
                 substring(body->>'observed_at', 15, 2)::int,
                 (
                   substring(body->>'observed_at', 18, 2)::int
                   + COALESCE(NULLIF(substring(body->>'observed_at', 21, 3), '')::numeric, 0) / 1000
                 )::double precision
               ))
               ELSE NULL
             END
             ELSE NULL
           END
         ) STORED`,
      `CREATE INDEX IF NOT EXISTS lite_records_region_idx
         ON lite_records (collection, region)
       WHERE region IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS lite_records_observed_idx
         ON lite_records (collection, observed_at DESC)
       WHERE observed_at IS NOT NULL`,
    ],
  }),
  Object.freeze({
    version: 4,
    name: 'index the version table by the record it versions',
    // R-26. `pruneVersions` partitioned and ordered the entire
    // `record_versions` collection on `body->>'record_id'` and
    // `body->>'valid_to'` — two JSONB extractions with no index of any kind —
    // on every bitemporal merge, to enforce a cap of five rows on the handful
    // of records that merge had just revised. The scan was O(V): 31,549 rows,
    // 85 MB, to serve a batch of k.
    //
    // `record_id` is an expression index rather than a real column because the
    // version rows are written by `versionRow()` and read by nothing; promoting
    // it to a first-class column is ENH-12's larger change and this index is
    // the part of it that pays immediately.
    //
    // `valid_to` is in the key so the ranking sort is answered from the index
    // for the handful of rows per record rather than by sorting them. The
    // default ASC on a text column is close enough to chronological for the
    // ISO-8601 instants `versionRow` writes, and the planner cannot use DESC
    // here anyway — the query asks for `DESC NULLS LAST`, and a NULLS LAST
    // scan on a DESC index is still a forward scan over the index.
    //
    // Partial on the collection rather than a leading `collection` column,
    // because `record_versions` is 60% of the table by rows: keeping the other
    // 40% out of the index halves its size for free, and the prune names the
    // collection in a literal.
    up: [
      `CREATE INDEX IF NOT EXISTS lite_records_version_record_idx
         ON lite_records ((body->>'record_id'), (body->>'valid_to'))
       WHERE collection = 'record_versions'`,
    ],
  }),
  Object.freeze({
    version: 5,
    name: 'extracted filter columns',
    // ENH-10. Eight filters that `filterRecords` implements in JavaScript, with
    // no index of any kind behind them, so `?severity=critical` over 39,715
    // rows is a full scan of an already-materialised array — and the array
    // itself is materialised by a query that fetches every row.
    //
    // Same shape as migration 3 and for the same reason: generated columns read
    // from the body, so nothing is backfilled by hand and a write path cannot
    // produce a row whose index columns disagree with its body.
    //
    // The spellings are the risk, and the audit is right to flag it: the
    // connectors disagree with each other about what these are called, so each
    // column is COALESCE over the names `filterRecords` actually accepts for
    // that filter. An index over one spelling answers for one connector and
    // silently fails to answer for the other — which is not a wrong answer, it
    // is no answer, and the filter falls back to the scan it had before.
    // Where `filterRecords` also matches a *third* spelling (`incident_id` and
    // `intervention_id` both fall back to `item.id`), no single generated
    // column can cover it and the predicate still needs the row. The index
    // answers the part that can be answered; it does not make the filter
    // total.
    //
    // Partial on IS NOT NULL because these are sparse: a `district` field on a
    // `service_assets` row and an `owner` on a `hazard_events` row are null,
    // and an index entry per null is storage bought to answer nothing.
    //
    // Honest cost: adding a STORED generated column rewrites the table. On a
    // 39,715-row / 143 MB store that is one full rewrite, once, in its own
    // transaction, and the ledger row recording it is written only if it
    // commits. It is not a migration to run against a live district server at
    // peak; it is a migration to run at the same time you would run one.
    up: [
      ...FILTER_COLUMNS.map(([column, expression]) => [
        `ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS ${column} TEXT
           GENERATED ALWAYS AS (${expression}) STORED`,
        `CREATE INDEX IF NOT EXISTS lite_records_${column}_idx
           ON lite_records (${column === 'incident_id' || column === 'intervention_id' ? '' : 'collection, '}${column})
         WHERE ${column} IS NOT NULL`,
      ]).flat(),
    ],
  }),

  /**
   * ENH-17 — the partner-organisation predicate becomes an index lookup, and
   * moves into the engine's WHERE clause rather than into a filter over a
   * materialised array.
   *
   * Before this, a partner token's isolation was `filterRecords` comparing
   * `item.partner_org` across every record the read had already fetched — an
   * O(N) scan over rows the caller was never entitled to see, on a store the
   * audit measured at 39,715 rows. The rows crossed the wire either way. The
   * isolation was correct and the cost of it was not.
   *
   * Same shape as migrations 3 and 5 for the same reason: a generated column
   * read from the body, so nothing is backfilled by hand and a write path cannot
   * produce a row whose column disagrees with it.
   *
   * **Null is not a match.** The JavaScript predicate is
   * `item?.partner_org === partnerOrg` — strict equality — so a record with no
   * partner is *invisible* to a partner token. An index on (collection,
   * partner_org) answers that exactly. It must not become
   * `partner_org IS NULL OR partner_org = $2`: that would hand every partner
   * token every untagged record in the deployment, which is the leak this item
   * exists to close. The index is partial on IS NOT NULL for the same reason as
   * the others.
   *
   * **What this is protecting, and what it is not.** This is not multi-tenancy.
   * A Lindela Lite deployment is one operator running one country programme
   * against one database, and `partner_org` separates *organisations working the
   * same response* — NGO A's field reports versus NGO B's — not customers sharing
   * infrastructure. The records behind it are the ones carrying names and
   * affected household counts, which is why a partner token reading another
   * organisation's rows is a disclosure and not a cosmetic mismatch. That
   * boundary is worth an index and a WHERE clause. It is not the threat
   * row-level security was designed for, and the audit's RLS proposal — keyed on
   * `current_setting('app.partner_org')`, with a non-superuser role and per-request
   * session plumbing — was aimed at making cross-*tenant* reads inexpressible.
   * That remedy belongs to a deployment model this product does not have, so
   * ENH-17's RLS half is recorded as not applicable rather than as blocked on a
   * superuser. What is left of ENH-17 is the half this migration delivers.
   */
  Object.freeze({
    version: 6,
    name: 'partner_org index column',
    up: [
      `ALTER TABLE lite_records ADD COLUMN IF NOT EXISTS partner_org TEXT
         GENERATED ALWAYS AS (NULLIF(body->>'partner_org', '')) STORED`,
      `CREATE INDEX IF NOT EXISTS lite_records_partner_org_idx
         ON lite_records (collection, partner_org)
       WHERE partner_org IS NOT NULL`,
    ],
  }),
  // CON-03 is *not* a migration, and the reason is worth recording where the
  // obvious migration would have gone.
  //
  // The defect is that `upsertCollection` asks which of a batch's
  // `payload_hash` values are already present and then inserts the rest, so two
  // concurrent merges both run the SELECT before either commits, both see the
  // hash absent, and both insert — with *different ids* and the same content,
  // which `ON CONFLICT (collection, id)` does not catch.
  //
  // The obvious repair is a unique index on `(collection, payload_hash)` and
  // `ON CONFLICT DO NOTHING`. It is the wrong repair for this database:
  // `CREATE UNIQUE INDEX` fails outright on any deployment that already holds
  // the duplicate rows this defect has been producing, and the only way to make
  // it succeed is to delete records inside a migration — silently, on a
  // database whose contents the migration cannot see. A repair that has to
  // destroy data to apply is not a repair.
  //
  // The window is closed instead by serialising the write transactions on a
  // transaction-scoped advisory lock (`#lockWrites` in `postgres-store.js`),
  // which is also what removes CON-02's lock inversion. No schema change, so it
  // applies to every existing database on the next connect.
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