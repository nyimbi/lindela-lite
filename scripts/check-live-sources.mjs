#!/usr/bin/env node
/**
 * Probes every public source against its live upstream and reports what each
 * one actually returned.
 *
 * Why this exists: three separate connectors reported success while ingesting
 * nothing, and none of the tests caught any of them.
 *
 * - CHIRPS returned zero records because the product index moved to year
 *   subdirectories. The fixture encoded the old flat layout, so the suite
 *   confirmed the bug.
 * - GloFAS served an HTML web app at its RSS URL, so the parse found no items
 *   and the empty result passed as a healthy run.
 * - NASA FIRMS has no keyless access, and the placeholder key produced three
 *   HTTP 400s per run while the catalog claimed no credentials were needed.
 *
 * All three are invisible to a fixture-based suite, because the fixtures
 * describe what the code expects rather than what upstream serves. This script
 * asks upstream directly.
 *
 * Usage:
 *   node scripts/check-live-sources.mjs            # report, exit 0
 *   node scripts/check-live-sources.mjs --strict   # exit 1 if any source errors
 *
 * Intended for CI on a schedule rather than every push: it depends on third
 * parties being reachable and on their rate limits.
 */

import { PUBLIC_INGESTION_SOURCES, getConnector } from '../src/ingestion.js'

const strict = process.argv.includes('--strict')
const TIMEOUT_MS = Number(process.env.LINDELA_LITE_LIVE_TIMEOUT_MS) || 25000

// Two points in the pilot area, enough for a region-scoped source to have
// something to return.
const REGIONS = [
  { name: 'Turkana', country: 'KE', lat: 3.1167, lon: 35.6 },
  { name: 'Mogadishu', country: 'SO', lat: 2.0469, lon: 45.3182 },
]

const results = []

for (const sourceId of PUBLIC_INGESTION_SOURCES) {
  const startedAt = Date.now()
  try {
    const connector = getConnector(sourceId)
    const outcome = await connector.ingest({ regions: REGIONS, retries: 0, timeout_ms: TIMEOUT_MS })

    const recordCounts = Object.entries(outcome)
      .filter(([key]) => key !== 'errors')
      .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])
    const totalRecords = recordCounts.reduce((sum, [, n]) => sum + n, 0)
    const errors = outcome.errors || []

    results.push({
      source: sourceId,
      status: errors.length ? 'error' : totalRecords ? 'ok' : 'empty',
      records: totalRecords,
      detail: recordCounts.map(([k, n]) => `${k}=${n}`).join(' '),
      errors,
      ms: Date.now() - startedAt,
    })
  } catch (error) {
    results.push({
      source: sourceId,
      status: 'threw',
      records: 0,
      detail: '',
      errors: [error.message],
      ms: Date.now() - startedAt,
    })
  }
}

const pad = (value, width) => String(value).padEnd(width)
console.log(`Live source check — ${new Date().toISOString()}\n`)
for (const r of results) {
  console.log(`${pad(r.source, 17)} ${pad(r.status, 6)} records=${pad(r.records, 4)} ${pad(`${r.ms}ms`, 7)} ${r.detail}`)
  for (const error of r.errors) console.log(`${' '.repeat(18)}${error}`)
}

const problems = results.filter((r) => r.status === 'error' || r.status === 'threw')
const empty = results.filter((r) => r.status === 'empty')
const healthy = results.filter((r) => r.status === 'ok')

console.log(`\n${healthy.length} ok, ${empty.length} empty, ${problems.length} errored, ${results.length} total`)

if (empty.length) {
  // An empty result with no error is the failure mode this script exists to
  // catch, so it is always worth naming even when the run is not strict.
  console.log(`\nEmpty without error: ${empty.map((r) => r.source).join(', ')}`)
  console.log('A source that parses nothing and reports no error is a silent failure, not "no data".')
}
if (problems.length) {
  console.log(`\nSources reporting errors: ${problems.map((r) => r.source).join(', ')}`)
  console.log('See messages above. Each is either an upstream change or a configuration gap.')
}
if (strict && (problems.length || empty.length)) {
  process.exitCode = 1
}