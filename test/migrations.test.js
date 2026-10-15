#!/usr/bin/env node
/**
 * ENH-29: a schema_version that is read, not just written.
 *
 * `ensureSchema()` used to write `version: 1` into a column nothing ever read
 * (DATA-11), with its `ALTER TABLE` statements inline in the method body. The
 * statements were idempotent so nothing broke — which is exactly what made the
 * defect durable. A database at version 1 and a database at version 3 were
 * indistinguishable without reading the code, so nobody could tell whether an
 * upgrade had run, and adding a column had nowhere to be recorded.
 *
 * The guard here is deliberately about the *runner*, not about Postgres. These
 * tests drive `pendingMigrations` and `schemaLedgerRows` as pure functions with
 * no database at all, because the failure this guards is a list that stops
 * being ordered or stops being complete — and a database-backed test would only
 * catch that on a machine that happened to have one.
 *
 * The anti-vacuous assertions are the point. `pendingMigrations` returning `[]`
 * is correct for a current database and is *also* what a broken version
 * comparison returns. Every test below therefore pins the boundary from both
 * sides, so a comparison that silently stops comparing fails rather than
 * passing.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrationStatements,
  pendingMigrations,
  schemaLedgerRows,
  targetVersion,
} from '../src/migrations.js'

describe('the migration list is one list', () => {
  it('is non-empty and starts at 1', () => {
    // A list that were empty would make every "the database is current" test
    // pass for the wrong reason.
    assert.ok(MIGRATIONS.length >= 3, `expected real migrations, found ${MIGRATIONS.length}`)
    assert.equal(Math.min(...MIGRATIONS.map((m) => m.version)), 1)
  })

  it('has no gaps and no duplicates in its versions', () => {
    // A gap means a database skips straight over a migration that a later
    // version depends on. A duplicate means the runner applies one twice and
    // the ledger cannot say which.
    const versions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b)
    assert.deepEqual(versions, versions.map((_, i) => i + 1), `versions are ${versions.join(',')}`)
    assert.equal(new Set(versions).size, versions.length, 'a version appears twice')
  })

  it('agrees with the version this build expects', () => {
    // The constant is what a deployment compares against. If it drifts from
    // the list, every database reports "current" while missing a migration.
    assert.equal(SCHEMA_VERSION, targetVersion())
  })

  it('gives every migration a name and at least one statement', () => {
    // A migration with no `up` is a promise nothing keeps. It would read as a
    // completed step in the ledger, which is worse than not being listed.
    for (const migration of MIGRATIONS) {
      assert.ok(migration.name && typeof migration.name === 'string', `v${migration.version} is unnamed`)
      assert.ok(Array.isArray(migration.up) && migration.up.length > 0, `v${migration.version} has no statements`)
    }
  })

  it('is idempotent, since the runner replays from an unknown version', () => {
    // readSchemaVersion() returns 0 for a database with no ledger, and the
    // runner then applies every migration. A non-idempotent statement would
    // fail exactly the deployments this project is built for: ones nobody has
    // inspected.
    //
    // There are two legitimate mechanisms and both must be recognised. DDL
    // guards itself with IF [NOT] EXISTS. A backfill UPDATE cannot — there is
    // no such clause — so it is idempotent by being a projection guarded on
    // the column it fills: setting payload_hash from body->>'payload_hash' where
    // it is still null computes the same value however many times it runs.
    // A third form — a plain INSERT of data rows — would be neither, and is
    // what this assertion exists to catch.
    const isBackfill = (s) => /^\s*UPDATE\b/i.test(s) && /WHERE\s+\w+\s+IS\s+NULL/i.test(s)
    for (const migration of MIGRATIONS) {
      for (const statement of migration.up) {
        const guarded = /IF (NOT )?EXISTS/i.test(statement) || isBackfill(statement)
        assert.ok(
          guarded,
          `migration ${migration.version} has a statement that cannot be replayed: ${statement.slice(0, 70)}`,
        )
      }
    }
  })

  it('is frozen, so a caller cannot widen the migration list at runtime', () => {
    assert.throws(() => { MIGRATIONS.push({ version: 99, name: 'x', up: ['SELECT 1'] }) }, TypeError)
  })
})

describe('what a database at version N still needs', () => {
  it('needs everything from nothing', () => {
    const pending = pendingMigrations(0)
    assert.equal(pending.length, MIGRATIONS.length)
    assert.deepEqual(pending.map((m) => m.version), MIGRATIONS.map((m) => m.version))
  })

  it('needs everything when its version is unknown', () => {
    // A database predating the ledger reports 0. Treating that as "current"
    // would skip three migrations and leave it without the columns they add.
    assert.equal(pendingMigrations(0).length, MIGRATIONS.length)
  })

  it('needs nothing when it is current', () => {
    assert.deepEqual(pendingMigrations(targetVersion()), [])
  })

  it('needs only the tail, from both sides of each boundary', () => {
    // The boundary assertion: a database at version N needs every migration
    // above N and none at or below it. A comparison that quietly became >= or
    // <= would still pass the "needs everything" and "needs nothing" cases
    // above.
    //
    // Driven off MIGRATIONS rather than spelled out. This used to hard-code
    // [3] and [2, 3], which made it a count check wearing a boundary check's
    // clothes: adding a migration broke it without testing anything, and the
    // fix that always satisfied it — editing the literal — would have hidden a
    // real off-by-one. The form below fails for the only reason it should.
    const versions = MIGRATIONS.map((m) => m.version)
    for (const from of versions) {
      assert.deepEqual(
        pendingMigrations(from).map((m) => m.version),
        versions.filter((version) => version > from),
        `a database at version ${from} was given the wrong tail`,
      )
    }
  })

  it('needs nothing when the database is ahead of the build', () => {
    // Not an error. Refusing to start would push an operator into a manual
    // downgrade, and the rows this build cannot understand were written by a
    // newer one that is responsible for guarding them.
    assert.deepEqual(pendingMigrations(targetVersion() + 5), [])
  })

  it('returns them in ascending order regardless of list order', () => {
    // The list is written in order and read in order, which is exactly the
    // assumption that has no check behind it until an edit reorders it.
    const shuffled = [MIGRATIONS[2], MIGRATIONS[0], MIGRATIONS[1]]
    assert.deepEqual(pendingMigrations(0, shuffled).map((m) => m.version), [1, 2, 3])
  })

  it('flattens to statements a client can run', () => {
    const statements = migrationStatements(0)
    assert.equal(statements.length, MIGRATIONS.reduce((n, m) => n + m.up.length, 0))
    assert.ok(statements.every((s) => typeof s === 'string' && s.length > 0))
  })

  it('flattens to nothing for a current database', () => {
    assert.deepEqual(migrationStatements(targetVersion()), [])
  })
})

describe('the ledger', () => {
  it('has a row per migration, each carrying its version', () => {
    const rows = schemaLedgerRows()
    assert.equal(rows.length, MIGRATIONS.length)
    for (const migration of MIGRATIONS) {
      const row = rows.find((r) => r.version === migration.version)
      assert.ok(row, `no ledger row for v${migration.version}`)
      assert.equal(row.schema_version, migration.version, 'the row must record the version it applied')
      assert.equal(row.collection, '__schema', 'the ledger lives in its own collection')
      assert.equal(row.name, migration.name)
    }
  })

  it('keys each row so a re-applied migration overwrites rather than duplicating', () => {
    // mergeById keys on id. Two rows for one migration would make "which
    // migrations have run" a question with two answers.
    const ids = schemaLedgerRows().map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const row of schemaLedgerRows()) assert.equal(row.id, `schema-${row.version}`)
  })

  it('is not itself versioned, so reading the ledger cannot recurse', () => {
    assert.ok(!schemaLedgerRows().some((r) => r.collection !== '__schema'))
  })
})

describe('the statements this build used to write inline', () => {
  it('still exists somewhere in the migration list', () => {
    // The payload_hash column, the backfill and the index were moved, not
    // dropped. A refactor that lost one of them would still produce a database
    // that merges and reads, so only a statement-level assertion catches it.
    const all = MIGRATIONS.flatMap((m) => m.up).join('\n')
    assert.match(all, /ADD COLUMN IF NOT EXISTS payload_hash TEXT/)
    assert.match(all, /jsonb_exists\(body, 'payload_hash'\)/,
      'the backfill must move with the column or existing rows dedupe against null')
    assert.match(all, /lite_records_collection_hash_idx/)
  })

  it('added the columns the region and time queries were meant to need, then dropped them', () => {
    // ENH-29 part 3 and ENH-10 added these to make the hot filters indexable.
    // They never became indexable: `PostgresStore.read` takes no filter, so no
    // query names any of them, and R-30/R-31 remove the write amplification
    // they cost. Migration 7 drops them.
    //
    // The assertion is on the *pair*, add and drop, because either half alone
    // is satisfiable by a tree that does not converge: a database that never
    // reached migration 5 has nothing to drop, and one that reached it needs
    // the drop to exist.
    const all = MIGRATIONS.flatMap((m) => m.up).join('\n')
    assert.match(all, /ADD COLUMN IF NOT EXISTS region TEXT/, 'the add is the record of what was tried')
    assert.match(all, /ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ/)
    assert.match(all, /DROP COLUMN IF EXISTS region/, 'without the drop the columns stay on every write')
    assert.match(all, /DROP COLUMN IF EXISTS observed_at/)
    // And the drop is the newest migration, not an edit to an applied one.
    const newest = MIGRATIONS.reduce((a, b) => (b.version > a.version ? b : a))
    assert.ok(
      newest.up.some((s) => /DROP COLUMN IF EXISTS region/.test(s)),
      'the drop must be in the newest migration; editing migration 3 in place would leave every database that already ran it stamped at the same version with the old DDL',
    )
  })

  it('drops every generated column no query can read, not only the two the audit named', () => {
    // R-31 is R-30's other half: migration 5 added eight more of exactly the
    // same thing. A repair that dropped only `region` and `observed_at` would
    // leave eight columns and eight indexes still maintained on every write.
    const dropped = MIGRATIONS.flatMap((m) => m.up)
      .flatMap((s) => [...s.matchAll(/DROP COLUMN IF EXISTS (\w+)/g)].map((m) => m[1]))
    for (const column of [
      'region', 'observed_at', 'country', 'source', 'status', 'severity',
      'incident_id', 'intervention_id', 'service_type', 'owner',
    ]) {
      assert.ok(dropped.includes(column), `${column} is still written and reindexed on every INSERT`)
    }
    // The three that DO have readers stay: `payload_hash` is the dedupe key,
    // `partner_org` is ENH-17's predicate and is in the read's WHERE clause,
    // and `schema_version` is the ledger's own column.
    for (const kept of ['payload_hash', 'partner_org', 'schema_version']) {
      assert.ok(!dropped.includes(kept), `${kept} has a reader and must not be dropped`)
    }
  })

  it('derives those columns rather than letting a client set them', () => {
    // A region column a caller could populate independently of the body is a
    // query that returns rows the body disagrees with — and the disagreement
    // is invisible from the response, which is drawn from the body.
    //
    // This is the property that made the columns safe to *add*; it is recorded
    // because migration 7 removes them, and the reason they were removed is not
    // that they were wrong about the body but that no query read them.
    const generated = MIGRATIONS.flatMap((m) => m.up).filter((s) => /ADD COLUMN IF NOT EXISTS (region TEXT|observed_at TIMESTAMPTZ)/.test(s))
    assert.equal(generated.length, 2)
    for (const statement of generated) assert.match(statement, /GENERATED ALWAYS/)
  })

  it('carries a deployed v6 database to the drop without touching the migrations it already ran', () => {
    // The upgrade path a deployed database actually takes, pinned by version
    // rather than described. Migration 3 added the two columns and migration 5
    // the eight; both are applied on every live deployment. A database at v6
    // must be given migration 7 and nothing else — replaying 3 and 5 to "fix"
    // them would re-add the columns and then need the drop anyway, and editing
    // either in place would leave the database stamped at its old version with
    // the old DDL (R-73).
    const atSix = pendingMigrations(6)
    assert.deepEqual(atSix.map((m) => m.version), [7])
    const statements = atSix.flatMap((m) => m.up).join('\n')
    assert.match(statements, /DROP COLUMN IF EXISTS region/)
    assert.ok(!/ADD COLUMN/.test(statements), 'the tail re-adds a column, so the drop cannot be the whole repair')
    // And the migrations that added them are still in the list, unedited —
    // the drop depends on them having run, and a database created fresh runs
    // both and then the drop in one pass.
    assert.match(migrationStatements(0).join('\n'), /ADD COLUMN IF NOT EXISTS region TEXT/)
    assert.match(migrationStatements(0).join('\n'), /DROP COLUMN IF EXISTS region/)
  })
})