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
    // The boundary assertions: version 2 must need 3 and not 1 or 2. A
    // comparison that quietly became >= or <= would still pass the "needs
    // everything" and "needs nothing" cases above.
    assert.deepEqual(pendingMigrations(2).map((m) => m.version), [3])
    assert.deepEqual(pendingMigrations(1).map((m) => m.version), [2, 3])
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

  it('adds the columns the region and time queries need', () => {
    // ENH-29 part 3: the single-table design stays, but the columns the hot
    // queries filter on become indexable instead of being read out of JSONB in
    // application code on every request.
    const all = MIGRATIONS.flatMap((m) => m.up).join('\n')
    assert.match(all, /ADD COLUMN IF NOT EXISTS region TEXT/)
    assert.match(all, /ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ/)
    assert.match(all, /lite_records_region_idx/)
    assert.match(all, /lite_records_observed_idx/)
  })

  it('derives those columns rather than letting a client set them', () => {
    // A region column a caller could populate independently of the body is a
    // query that returns rows the body disagrees with — and the disagreement
    // is invisible from the response, which is drawn from the body.
    const generated = MIGRATIONS.flatMap((m) => m.up).filter((s) => /region TEXT|observed_at TIMESTAMPTZ/.test(s))
    assert.equal(generated.length, 2)
    for (const statement of generated) assert.match(statement, /GENERATED ALWAYS/)
  })
})