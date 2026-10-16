#!/usr/bin/env node
/**
 * ENH-12 probe, the read half: can `/history/:collection/record` be answered
 * from an index instead of scanning every version row?
 *
 * The prune half of ENH-12 shipped as migration 4's expression index on
 * `((body->>'record_id'), (body->>'valid_to'))`. The read path still loads the
 * whole `record_versions` collection and filters it in JavaScript, so a request
 * about one record pays for all of them. This measures whether the *existing*
 * index can answer a record-scoped read, which would make the schema split
 * (a real `record_id` column) unnecessary for this too.
 */
import pg from 'pg'

import { postgresCluster } from '../test/pg-harness.mjs'

const RECORDS = 6000
const VERSIONS = 5

const cluster = await postgresCluster()
if (cluster.skipped) {
  console.error(`no postgres: ${cluster.skipped}`)
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: cluster.url })

/**
 * Median of RUNS, not one shot. The scoped plans execute in well under 0.1 ms,
 * so a single `Execution Time` is dominated by scheduler noise: on one unchanged
 * table the index-vs-column ratio wanders over 0.9x-2.4x between runs. A ratio
 * the register cites has to be reproducible, so report the median.
 */
const RUNS = 9

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** One `EXPLAIN ANALYZE`; returns the execution time and whether it scanned. */
async function timeOnce(sql, params) {
  const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)
  const plan = rows[0]['QUERY PLAN'][0]
  const nodes = []
  const walk = (n) => { nodes.push(n['Node Type']); (n.Plans || []).forEach(walk) }
  walk(plan.Plan)
  return { ms: plan['Execution Time'], seq: nodes.includes('Seq Scan') }
}

async function explain(label, sql, params) {
  await pool.query('ANALYZE probe')
  const samples = []
  for (let i = 0; i < RUNS; i++) samples.push(await timeOnce(sql, params))
  const ms = median(samples.map((s) => s.ms))
  const scanned = samples[0].seq ? 'SEQ SCAN (all rows)' : 'index path'
  console.log(`${label.padEnd(22)} ${ms.toFixed(3).padStart(8)} ms   ${scanned}`)
  return ms
}

try {
  await pool.query('DROP TABLE IF EXISTS probe')
  await pool.query('CREATE TABLE probe (collection text, id text PRIMARY KEY, body jsonb)')
  const rows = []
  for (let r = 0; r < RECORDS; r++) {
    const rid = `rec-${r}`
    for (let v = 0; v < VERSIONS; v++) {
      rows.push(['record_versions', `${rid}:${v}`,
        JSON.stringify({ collection: 'food_security_records', record_id: rid, valid_to: `2026-0${v + 1}-01T00:00:00Z` })])
    }
  }
  for (let i = 0; i < rows.length; i += 2000) {
    const p = rows.slice(i, i + 2000)
    await pool.query(
      'INSERT INTO probe (collection, id, body) SELECT * FROM UNNEST($1::text[], $2::text[], $3::jsonb[])',
      [p.map((x) => x[0]), p.map((x) => x[1]), p.map((x) => x[2])])
  }
  console.log(`seeded ${rows.length} version rows over ${RECORDS} records\n`)

  await pool.query(
    `CREATE INDEX probe_expr_idx ON probe ((body->>'record_id'), (body->>'valid_to'))
     WHERE collection = 'record_versions'`)

  // Today: the whole collection, filtered in JS.
  const WHOLE = `SELECT collection, body FROM probe WHERE collection = $1`
  const whole = await explain('whole collection', WHOLE, ['record_versions'])

  // Proposed: one record's versions, from the index.
  const EXPR = `SELECT collection, body FROM probe
     WHERE collection = $1 AND body->>'record_id' = $2`
  const expr = await explain('one record (index)', EXPR, ['record_versions', 'rec-42'])

  // The comparison that decides the schema split: a real column.
  await pool.query(`ALTER TABLE probe ADD COLUMN record_id text GENERATED ALWAYS AS (body->>'record_id') STORED`)
  await pool.query(`CREATE INDEX probe_col_idx ON probe (record_id) WHERE collection = 'record_versions'`)
  const COL = `SELECT collection, body FROM probe
     WHERE collection = $1 AND record_id = $2`
  const col = await explain('one record (column)', COL, ['record_versions', 'rec-42'])

  // The two ratios the register cites, computed here so they are read off a
  // measurement rather than off a reader's calculator.
  console.log(`\nexpression index vs whole collection   ${(whole / expr).toFixed(1)}x faster`)

  // The column ratio is the one that decides the schema split, and it is the one
  // a block-then-block comparison gets wrong: both plans run in under 0.1 ms, so
  // whatever drifts between the two blocks lands in the ratio. Interleave them
  // and pair each sample with its own neighbour.
  await pool.query('ANALYZE probe')
  const paired = []
  for (let i = 0; i < RUNS; i++) {
    const a = await timeOnce(EXPR, ['record_versions', 'rec-42'])
    const b = await timeOnce(COL, ['record_versions', 'rec-42'])
    paired.push(a.ms / b.ms)
  }
  paired.sort((x, y) => x - y)
  const mid = paired[Math.floor(paired.length / 2)]
  console.log(`real column vs expression index        ${mid.toFixed(2)}x faster`
    + `  (${paired[0].toFixed(2)}x-${paired[paired.length - 1].toFixed(2)}x over ${RUNS} paired runs)`)
  console.log('\n(the second ratio is the one that decides the schema split, and it straddles')
  console.log(' 1.0: both plans are index paths already, and the column buys a fraction of a')
  console.log(' plan that is already hundreds of times faster than the scan it replaces.)')
} finally {
  await pool.end()
  await cluster.stop()
}
