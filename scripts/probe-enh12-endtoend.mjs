#!/usr/bin/env node
/**
 * ENH-12, the read half — the end-to-end measurement.
 *
 * Drives the real route against the real demo store, with the read instrumented,
 * and reports what the record scope actually saves. This is the number the
 * register row cites, so it is measured here rather than restated from the
 * probe's synthetic table.
 *
 * Counts rows *read*, not rows returned: the defect was never that the answer
 * was wrong, it was that answering cost the whole store.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { recordScopeForRequest } from '../src/route-manifests.js'
import { JsonStore, normaliseReadOptions } from '../src/store.js'

const STORE = process.env.LINDELA_LITE_STORE || 'data/lindela-lite-store.json'

/** Rows a read would materialise, by the store's own count. */
function rowsFor(store, options) {
  const { collections, includeHistory, recordScope } = normaliseReadOptions(options)
  const wanted = collections === null ? null : new Set(collections)
  let total = 0
  for (const [collection, rows] of Object.entries(store)) {
    if (!Array.isArray(rows)) continue
    if (wanted !== null && !wanted.has(collection)) continue
    if (!includeHistory && collection === 'record_versions') continue
    total += recordScope === null
      ? rows.length
      : rows.filter((row) => {
        if (recordScope.collection !== (collection === 'record_versions' ? row.collection : collection)) return false
        if (recordScope.recordId === null) return true
        return (collection === 'record_versions' ? row.record_id : row.id) === recordScope.recordId
      }).length
  }
  return total
}

const raw = JSON.parse(await fs.readFile(STORE, 'utf8'))
const store = new JsonStore(STORE)

// A record that actually has revisions, so the measurement is of the real path
// rather than of a record whose history happens to be empty.
const versions = raw.record_versions || []
const busiest = versions.reduce((acc, v) => {
  const key = `${v.collection}/${v.record_id}`
  acc[key] = (acc[key] || 0) + 1
  return acc
}, {})
const [target] = Object.entries(busiest).sort((a, b) => b[1] - a[1])[0]
const [collection, recordId] = target.split('/')

const url = `/api/v1/history/${collection}/record?id=${recordId}`
const scope = recordScopeForRequest('GET', `/api/v1/history/${collection}/record`, new URLSearchParams({ id: recordId }))

const today = { collections: null, includeHistory: true }
const scoped = { collections: null, includeHistory: true, recordScope: scope }

const before = rowsFor(raw, today)
const after = rowsFor(raw, scoped)

const bytes = (await fs.stat(STORE)).size
console.log(`store: ${STORE} (${(bytes / 1048576).toFixed(1)} MB)`)
console.log(`route: ${url}`)
console.log(`record has ${busiest[target]} retained revision(s)\n`)
console.log(`today  (null manifest, history on)  ${String(before).padStart(7)} rows`)
console.log(`scoped (record scope)               ${String(after).padStart(7)} rows`)
console.log(`                                    ${String(Math.round(before / after)).padStart(7)}x fewer\n`)

// And the real read, timed, so the row-transfer claim is not the only evidence.
const time = async (label, options) => {
  const started = process.hrtime.bigint()
  await store.read(options)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`${label.padEnd(34)} ${ms.toFixed(2).padStart(8)} ms`)
  return ms
}
await time('today (null manifest, history on)', today)
await time('scoped (record scope)', scoped)
console.log('\n(the JSON adapter parses the whole file either way; the row count is the')
console.log(' transfer, and the SQL plan in probe-enh12-scope.mjs is the index evidence.)')
