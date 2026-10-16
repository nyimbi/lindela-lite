#!/usr/bin/env node
/**
 * ENH-12 probe: does the shipped expression index serve the version prune, or
 * does the window scan still materialise the collection?
 *
 * Migration 4 added `lite_records_version_record_idx` on
 * `((body->>'record_id'), (body->>'valid_to')) WHERE collection = 'record_versions'`.
 * ENH-12's remaining half claims the table needs a *real* `record_id` column
 * instead. This measures what the expression index actually buys at scale, so
 * the decision is made on a plan rather than on the shape of the DDL.
 *
 * Seeds a throwaway cluster with 30k version rows over 6k records (five
 * versions each, the `VERSIONS_PER_RECORD` cap) and runs the prune under
 * `EXPLAIN ANALYZE` with and without the index.
 */
import pg from 'pg'

import { postgresCluster } from '../test/pg-harness.mjs'

const RECORDS = 6000
const VERSIONS = 5
const TOUCHED = Array.from({ length: 10 }, (_, i) => `rec-${i}`)

// `rank` is a reserved word in a window-function alias position on PG 18; `rk`
// is not. Same query the store runs (`src/postgres-store.js` `pruneVersions`).
//
// The key expression is a parameter because the third variant's whole question is
// whether a *real* `record_id` column plans better than the expression index. A
// query that still spells `body->>'record_id'` cannot use a column index, so the
// earlier version of this probe dropped the expression index and then measured a
// scan with no usable index at all — it reported the cost of the removal, not the
// cost of the column.
const pruneFor = (key) => `
  DELETE FROM probe WHERE collection = $1 AND id IN (
    SELECT id FROM (
      SELECT id, row_number() OVER (
        PARTITION BY ${key}
        ORDER BY body->>'valid_to' DESC NULLS LAST
      ) AS rk
      FROM probe
      WHERE collection = $1 AND ${key} = ANY($2::text[])
    ) ranked WHERE ranked.rk > $3
  )`
const PRUNE = pruneFor(`body->>'record_id'`)
const PRUNE_COLUMN = pruneFor('record_id')

const cluster = await postgresCluster()
if (cluster.skipped) {
  console.error(`no postgres: ${cluster.skipped}`)
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: cluster.url })

async function timePrune(label, sql = PRUNE) {
  await pool.query('ANALYZE probe')
  const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    ['record_versions', TOUCHED, VERSIONS])
  const plan = rows[0]['QUERY PLAN'][0]
  const nodes = []
  const walk = (n) => { nodes.push(n['Node Type']); (n.Plans || []).forEach(walk) }
  walk(plan.Plan)
  const scans = nodes.filter((n) => /Scan/.test(n))
  console.log(`${label.padEnd(14)} ${plan['Execution Time'].toFixed(2).padStart(8)} ms   ${nodes.join(' -> ')}`)
  return { ms: plan['Execution Time'], scans }
}

try {
  await pool.query('DROP TABLE IF EXISTS probe')
  await pool.query('CREATE TABLE probe (collection text, id text PRIMARY KEY, body jsonb)')

  const rows = []
  for (let r = 0; r < RECORDS; r++) {
    const rid = `rec-${r}`
    for (let v = 0; v < VERSIONS; v++) {
      rows.push(['record_versions', `${rid}:${v}`,
        JSON.stringify({ record_id: rid, valid_to: `2026-0${v + 1}-01T00:00:00Z` })])
    }
  }
  for (let i = 0; i < rows.length; i += 2000) {
    const p = rows.slice(i, i + 2000)
    await pool.query(
      'INSERT INTO probe (collection, id, body) SELECT * FROM UNNEST($1::text[], $2::text[], $3::jsonb[])',
      [p.map((x) => x[0]), p.map((x) => x[1]), p.map((x) => x[2])])
  }
  const { rows: [c] } = await pool.query('SELECT count(*)::int n FROM probe')
  console.log(`seeded ${c.n} version rows over ${RECORDS} records (cap ${VERSIONS})\n`)

  await pool.query('DROP INDEX IF EXISTS probe_expr_idx')
  const none = await timePrune('no index')

  await pool.query(
    `CREATE INDEX probe_expr_idx ON probe ((body->>'record_id'), (body->>'valid_to'))
     WHERE collection = 'record_versions'`)
  const expr = await timePrune('expr index')

  // The proposed alternative: a real column, which is what ENH-12's remaining
  // half is. If the expression index already plans the same way, the column is
  // a schema change that buys nothing.
  await pool.query('ALTER TABLE probe ADD COLUMN record_id text GENERATED ALWAYS AS (body->>\'record_id\') STORED')
  await pool.query('CREATE INDEX probe_col_idx ON probe (record_id, (body->>\'valid_to\')) WHERE collection = \'record_versions\'')
  const col = await timePrune('real column', PRUNE_COLUMN)

  console.log(`\nno index     ${none.scans.join(', ') || 'scan'}`)
  console.log(`expr index   ${expr.scans.join(', ')}`)
  console.log(`real column  ${col.scans.join(', ')}`)
  console.log(`\nexpression index vs no index   ${(none.ms / expr.ms).toFixed(1)}x faster`)
  console.log(`real column vs expression index ${(expr.ms / col.ms).toFixed(2)}x`)
  console.log('(both variants keep their own index; the column query names `record_id`,')
  console.log(' so the column index is reachable and the comparison is of the two keys.)')
} finally {
  await pool.end()
  await cluster.stop()
}
