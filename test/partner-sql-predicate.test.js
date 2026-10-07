import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { PostgresStore } from '../src/postgres-store.js'
import { MIGRATIONS } from '../src/migrations.js'
import { postgresCluster } from './pg-harness.mjs'

/**
 * ENH-17's SQL half, against a real PostgreSQL.
 *
 * `filterRecords` has always applied the partner predicate in JavaScript, and
 * `test/partner-isolation.test.js` proves it does. That guard survives anything
 * this file tests — which is exactly why the SQL clause needs its own: it is a
 * performance change that is *also* a narrowing of what crosses the wire, and a
 * clause that silently stopped filtering would still pass every partner-isolation
 * test in the project, because `filterRecords` would clean up after it.
 *
 * So the tests here are the ones that can only fail if the clause itself is
 * wrong. A clause that matched too much is invisible to the existing suite and is
 * the defect that matters: it would put rows from other organisations into a
 * partner token's result set on the way to being filtered again.
 *
 * What `partner_org` separates, for the record, since the audit called it
 * tenancy: one operator, one country programme, one database. It separates
 * organisations working the same response — NGO A's field reports from NGO B's —
 * and those records carry names and affected household counts.
 */

/**
 * Four rows: one per organisation, one untagged, one with an empty string.
 *
 * `updated_at` is not decoration — `versionRow` refuses to open an interval
 * from a record with no timestamp, and declines to write rather than write a
 * history row it cannot justify. Without it the seed produces no version rows at
 * all and the history test below would pass on an empty array.
 */
const SEED = [
  { id: 'p-orgA', partner_org: 'orgA', name: 'Org A clinic', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'p-orgB', partner_org: 'orgB', name: 'Org B clinic', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'p-untagged', name: 'No partner at all', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'p-empty', partner_org: '', name: 'Empty-string partner', updated_at: '2026-01-01T00:00:00.000Z' },
]

describe('ENH-17 — the partner predicate in the store read, against a real PostgreSQL', () => {
  let cluster
  let store
  let sql

  /** Skips loudly; fails outright under CI, where green must have meant something. */
  const needsPostgres = (t) => {
    const reason = cluster?.skipped
    if (!reason) return false
    if (process.env.CI) {
      throw new Error(
        `CI ran the ENH-17 suite without a database: ${reason}. Every test here would have `
        + 'passed without executing a single statement.',
      )
    }
    t.skip(`no PostgreSQL: ${reason}`)
    return true
  }

  const client = async () => {
    if (!sql) {
      const pg = (await import('pg')).default
      sql = new pg.Client({ connectionString: cluster.url })
      await sql.connect()
    }
    return sql
  }

  /** The ids one organisation sees, from a read scoped to that organisation. */
  const idsFor = async (partnerOrg) => {
    const data = await store.read({ partnerOrg })
    return (data.service_assets || []).map((r) => r.id).sort()
  }

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-enh17' })
    if (cluster.skipped) {
      process.stderr.write(`partner-sql-predicate: ${cluster.skipped}\n`)
      return
    }
    const db = await client()
    await db.query('DROP TABLE IF EXISTS lite_records')
    store = new PostgresStore({ databaseUrl: cluster.url })
    await store.ensureSchema()
    await store.write({ service_assets: [] })
    await store.merge({ service_assets: SEED })
  })

  after(async () => {
    await sql?.end()
    await store?.close()
    await cluster?.stop()
  })

  it('migration 6 records itself under a name that names the field', async (t) => {
    // The name goes into the `__schema` ledger on first apply and stays there,
    // so it is permanent the moment any deployment migrates. "tenant index
    // column" would have put this project's wrong word for this feature into
    // every operator's database.
    if (needsPostgres(t)) return
    const migration = MIGRATIONS.find((m) => m.version === 6)
    assert.ok(migration, 'migration 6 is missing')
    assert.equal(migration.name, 'partner_org index column')
    const db = await client()
    const { rows } = await db.query(
      `SELECT body FROM lite_records WHERE collection = '__schema' AND schema_version = 6`,
    )
    assert.equal(rows.length, 1, 'migration 6 did not record itself')
    assert.equal(rows[0].body.name, 'partner_org index column')
  })

  it('migration 6 created the column and the index it promises', async (t) => {
    if (needsPostgres(t)) return
    const db = await client()
    const columns = await db.query(
      `SELECT column_name, is_generated FROM information_schema.columns
       WHERE table_name = 'lite_records' AND column_name = 'partner_org'`,
    )
    assert.equal(columns.rows.length, 1, 'no partner_org column')
    // GENERATED ALWAYS, so a write path cannot produce a row whose column
    // disagrees with the body the predicate is supposed to be reading.
    assert.equal(columns.rows[0].is_generated, 'ALWAYS')

    const indexes = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'lite_records'
       AND indexname = 'lite_records_partner_org_idx'`,
    )
    assert.equal(indexes.rows.length, 1, 'lite_records_partner_org_idx is missing')
  })

  it('scopes the read to one organisation', async (t) => {
    if (needsPostgres(t)) return
    assert.deepEqual(await idsFor('orgA'), ['p-orgA'])
    assert.deepEqual(await idsFor('orgB'), ['p-orgB'])
  })

  it('does not return untagged rows to a partner token', async (t) => {
    // The strict-equality property, and the reason the clause must not become
    // `partner_org IS NULL OR partner_org = $2`. That form returns 3 of the 4
    // seeded rows instead of 1: another organisation's untagged records, on the
    // wire, before `filterRecords` runs. `filterRecords` would still hide them
    // from the response, so no existing test in the project can see this.
    if (needsPostgres(t)) return
    const visible = await idsFor('orgA')
    assert.ok(!visible.includes('p-untagged'), 'an untagged record reached a partner token')
    assert.ok(!visible.includes('p-empty'), 'an empty-string partner_org counted as a match')
    assert.deepEqual(visible, ['p-orgA'], `expected 1 of 4 seeded rows, got ${visible.length}`)
  })

  it('reads an empty string as no partner, matching the JavaScript predicate', async (t) => {
    // `NULLIF(body->>'partner_org', '')` exists so the stored form matches
    // `item?.partner_org === 'orgA'` in JavaScript. Without it, an empty string
    // would be a real, indexable value and `partnerOrg: ''` — which
    // `normaliseReadOptions` turns into null — would have no counterpart here.
    if (needsPostgres(t)) return
    const db = await client()
    const { rows } = await db.query(
      `SELECT id, partner_org FROM lite_records WHERE collection = 'service_assets'
       AND id = 'p-empty'`,
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].partner_org, null, 'the empty string should have become NULL, not stayed a value')
  })

  it('an unscoped token still reads the whole platform', async (t) => {
    // Null has to mean "this token is not scoped to an organisation", not "match
    // nothing". `partner_org = $1` with a null parameter matches no rows at all,
    // which would blank the platform view of every deployment that has partners
    // configured and no unscoped token.
    if (needsPostgres(t)) return
    assert.deepEqual(await idsFor(null), ['p-empty', 'p-orgA', 'p-orgB', 'p-untagged'])
    assert.deepEqual(await idsFor(undefined), ['p-empty', 'p-orgA', 'p-orgB', 'p-untagged'])
    assert.deepEqual(await idsFor(''), ['p-empty', 'p-orgA', 'p-orgB', 'p-untagged'],
      'an empty string normalises to null, not to a predicate matching nothing')
  })

  it('does not surface version history to a partner token', async (t) => {
    // A version row stores the *previous body* nested under `.body`, so it has
    // no top-level `partner_org` and the generated column is NULL for every
    // version row. Under strict equality that excludes all of them from a
    // partner-scoped read — which is what `filterRecords` already did in
    // JavaScript, before this clause existed. So the store and the response
    // layer agree, and no organisation reaches another's version history.
    //
    // The consequence worth stating rather than hiding: a partner token cannot
    // read the history of its *own* records through `includeHistory` either. That
    // is pre-existing behaviour, unchanged here — this test pins it so that a
    // future change making history partner-readable has to decide what a version
    // row's organisation is, instead of it arriving as an accident.
    if (needsPostgres(t)) return
    // A revision of orgB's own record — the only way to produce history here.
    // Both writes carry a timestamp: `versionRow` declines to open an interval
    // from a record without one, and an empty history array would make every
    // assertion below pass for the wrong reason.
    await store.merge({
      service_assets: [{ id: 'p-orgB', partner_org: 'orgB', name: 'Org B renamed', updated_at: '2026-01-02T00:00:00.000Z' }],
    })
    const db = await client()
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM lite_records WHERE collection = 'record_versions'`,
    )
    assert.ok(rows[0].n > 0, 'the revision should have produced a version row')

    const scoped = await store.read({ partnerOrg: 'orgB', includeHistory: true })
    assert.deepEqual(scoped.record_versions || [],
      [], 'a partner token saw version history, including its own')

    const unscoped = await store.read({ includeHistory: true })
    assert.ok((unscoped.record_versions || []).length > 0,
      'an unscoped token should still be able to read history')
  })

  it('applies the predicate to every collection in the manifest', async (t) => {
    // The clause is built once for the whole read, so one collection leaking
    // would mean the clause was scoped to a collection rather than applied to
    // the set. `GET /api/v1/export.csv` is the route that motivated this and it
    // reads several at once.
    if (needsPostgres(t)) return
    await store.merge({
      field_reports: [
        { id: 'fr-orgA', partner_org: 'orgA', summary: 'org A report' },
        { id: 'fr-orgB', partner_org: 'orgB', summary: 'org B report' },
      ],
    })
    const data = await store.read({
      collections: ['service_assets', 'field_reports'],
      partnerOrg: 'orgA',
    })
    assert.deepEqual((data.service_assets || []).map((r) => r.id), ['p-orgA'])
    assert.deepEqual((data.field_reports || []).map((r) => r.id), ['fr-orgA'])
  })

  it('the server reads with the caller\'s organisation, not a parameter', async (t) => {
    // The clause only helps if the request's token reaches it. A handler that
    // omitted `partnerOrg` would fall back to a whole-platform read — correct,
    // because `filterRecords` still scopes the response, but back to 39,715 rows
    // over the wire for every request.
    if (needsPostgres(t)) return
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.match(
      source,
      /store\.read\(\{[^}]*partnerOrg:\s*currentRequestAuth\(\)\?\.partner_org/,
      'the read call must take the organisation from the request context',
    )
  })
})
