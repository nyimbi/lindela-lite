#!/usr/bin/env node
/**
 * ENH-12 probe, the predicate: what does a *record-scoped* read of the history
 * actually cost, and does the planner reach an index for both branches?
 *
 * The live rows key on `id` under a `(collection, id)` primary key; a version
 * row's record is `body->>'record_id'` and its source collection is
 * `body->>'collection'`, because `record_versions` is one physical collection
 * holding every record's history. So one read spanning both needs an `OR` over
 * two branches — a `CASE` cannot be served by any expression index, and this
 * measures that rather than assuming it.
 *
 * The shape seeded here is the deployed one: `lite_records (collection, id,
 * body)` with `PRIMARY KEY (collection, id)` and migration 4's partial
 * expression index on `((body->>'record_id'), (body->>'valid_to')) WHERE
 * collection = 'record_versions'`.
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
 * Median of RUNS. The indexed plans finish in ~0.05 ms, where one `Execution
 * Time` is mostly scheduler noise — the same unchanged table reports the scoped
 * plan anywhere from 0.043 to 0.052 ms. The register quotes these numbers, so
 * they have to be reproducible rather than whatever the first run happened to be.
 */
const RUNS = 9

/** Median execution time, with no output — for repeated-median ranges. */
async function explainMedianOnly(sql, params) {
  await pool.query('ANALYZE probe')
  const times = []
  for (let i = 0; i < RUNS; i++) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)
    times.push(rows[0]['QUERY PLAN'][0]['Execution Time'])
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}

async function explain(label, sql, params) {
  await pool.query('ANALYZE probe')
  const times = []
  let scans = []
  for (let i = 0; i < RUNS; i++) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)
    const plan = rows[0]['QUERY PLAN'][0]
    times.push(plan['Execution Time'])
    if (i === 0) {
      scans = []
      const walk = (n) => {
        if (/Scan/.test(n['Node Type'])) scans.push(`${n['Node Type']}${n['Index Name'] ? `[${n['Index Name']}]` : ''}`)
        ;(n.Plans || []).forEach(walk)
      }
      walk(plan.Plan)
    }
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  const seq = scans.some((s) => s.startsWith('Seq')) ? '  <-- SEQ SCAN' : ''
  console.log(`${label.padEnd(30)} ${median.toFixed(3).padStart(8)} ms  ${scans.join(' + ')}${seq}`)
  return median
}

// What the record route reads today: a null manifest, history on. Every row.
const TODAY = `SELECT collection, body FROM probe WHERE collection <> '__schema'`

// The candidate. `$1` is the source collection, `$2` the record id.
const SCOPED = `SELECT collection, body FROM probe WHERE collection <> '__schema' AND (
   (collection = $1 AND id = $2)
   OR (collection = 'record_versions' AND body->>'collection' = $1 AND body->>'record_id' = $2))`

// The tempting shorter form: no collection on the live branch. Included to show
// what it costs, because `id` is not the leading column of any index.
const LOOSE = `SELECT collection, body FROM probe WHERE collection = ANY($1::text[]) AND (
   (collection <> 'record_versions' AND id = $2)
   OR (collection = 'record_versions' AND body->>'record_id' = $2))`

// The same question as a CASE, which is the form no expression index can serve.
const CASEY = `SELECT collection, body FROM probe WHERE collection = ANY($1::text[]) AND
   (CASE WHEN collection = 'record_versions' THEN body->>'record_id' ELSE id END) = $2::text`

try {
  await pool.query('DROP TABLE IF EXISTS probe')
  await pool.query('CREATE TABLE probe (collection text, id text, body jsonb, PRIMARY KEY (collection, id))')

  const rows = []
  for (let r = 0; r < RECORDS; r++) {
    const rid = `rec-${r}`
    rows.push(['food_security_records', rid, JSON.stringify({ id: rid, district: 'Kilifi' })])
    for (let v = 0; v < VERSIONS; v++) {
      rows.push(['record_versions', `${rid}:v${v}`,
        JSON.stringify({ collection: 'food_security_records', record_id: rid, valid_to: `2026-0${v + 1}-01T00:00:00Z` })])
    }
  }
  for (let i = 0; i < rows.length; i += 2000) {
    const p = rows.slice(i, i + 2000)
    await pool.query(
      'INSERT INTO probe (collection, id, body) SELECT * FROM UNNEST($1::text[], $2::text[], $3::jsonb[])',
      [p.map((x) => x[0]), p.map((x) => x[1]), p.map((x) => x[2])])
  }
  await pool.query(
    `CREATE INDEX probe_expr_idx ON probe ((body->>'record_id'), (body->>'valid_to'))
     WHERE collection = 'record_versions'`)
  const { rows: [c] } = await pool.query('SELECT count(*)::int n FROM probe')
  console.log(`seeded ${c.n} rows (${RECORDS} live + ${RECORDS * VERSIONS} versions)\n`)

  const today = await explain('today (null manifest)', TODAY, [])
  console.log('')
  const MANIFEST = ['food_security_records', 'record_versions']
  const scoped = await explain('scoped (OR, both indexed)', SCOPED, ['food_security_records', 'rec-42'])
  await explain('scoped (CASE)', CASEY, [MANIFEST, 'rec-42'])
  await explain('scoped (OR, live branch loose)', LOOSE, [MANIFEST, 'rec-42'])

  // A point estimate for the scoped plan is not reproducible — it runs in tens of
  // microseconds, so a median still moves between runs. Quote the ratio as a
  // range over repeated medians and the claim survives the noise.
  const scopedRuns = []
  for (let i = 0; i < 5; i++) scopedRuns.push(await explainMedianOnly(SCOPED, ['food_security_records', 'rec-42']))
  scopedRuns.sort((a, b) => a - b)
  console.log(`\nscoped plan over 5 repeated medians: ${scopedRuns[0].toFixed(3)}-${scopedRuns[scopedRuns.length - 1].toFixed(3)} ms`)
  console.log(`unscoped / scoped ratio: ${(today / scopedRuns[scopedRuns.length - 1]).toFixed(0)}x-${(today / scopedRuns[0]).toFixed(0)}x faster`)
  console.log(`(point median this run: ${scoped.toFixed(3)} ms)`)
  console.log('')
  console.log('rows returned by the scoped read:')
  for (const [label, sql, params] of [
    ['scoped', SCOPED, ['food_security_records', 'rec-42']],
    ['loose', LOOSE, [MANIFEST, 'rec-42']],
  ]) {
    const { rows: got } = await pool.query(sql, params)
    const byCol = {}
    for (const r of got) byCol[r.collection] = (byCol[r.collection] || 0) + 1
    console.log(`  ${label.padEnd(8)} ${got.length} rows  ${JSON.stringify(byCol)}`)
  }
} finally {
  await pool.end()
  await cluster.stop()
}
