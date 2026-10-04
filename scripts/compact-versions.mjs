#!/usr/bin/env node
/**
 * Rewrite superseded version rows into the compact `changed_fields` encoding.
 *
 * A version row stores two copies of the same fact: `body`, the whole previous
 * value, and `changed_fields`, a description of what moved. The second used to
 * compare top-level keys and store both sides whole, so one changed integer
 * inside `metadata` carried every sibling with it — 3.3 KB to say `enrolment`
 * went from 820 to 815. That was 99 MB of a 255 MB store, and it is why the
 * process needed 850 MB of resident memory to hold a file whose live data is
 * under 30 MB.
 *
 * `changedFields` now descends to the leaf and reports `metadata.enrolment`,
 * which is 416 bytes for the same fact. Rows written after that change are
 * already compact; this script converts the ones written before it.
 *
 * **It rewrites derived data from data still present in the same row.** `body`
 * is untouched. `changed_fields` carries no information `body` plus the
 * successor's body does not already carry, and nothing machine-reads it —
 * `valueAsOf` reads `body` and only `body`. So this is a lossless re-encoding,
 * not a deletion. Nothing is dropped that cannot be recomputed.
 *
 * The successor's body is the next version row's `body` for the same record,
 * or the live record when there is no later version. Where neither is available
 * the row is left alone rather than guessed at — a history entry that claims a
 * change nobody can verify is worse than a large one.
 *
 * Usage: node scripts/compact-versions.mjs [--dry-run]
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

import { changedFields } from '../src/bitemporal.js'

const storePath = process.env.LINDELA_LITE_STORE
  || path.resolve('data/lindela-lite-store.json')
const dryRun = process.argv.includes('--dry-run')

/** `metadata.enrolment` means the leaf; `metadata` means the whole subtree. */
function isCompact(changes) {
  return Object.keys(changes).some((k) => k.includes('.') || k.startsWith('["'))
}

const raw = await readFile(storePath, 'utf8')
const data = JSON.parse(raw)
const versions = data.record_versions || []

if (!versions.length) {
  console.log('No version rows. Nothing to compact.')
  process.exit(0)
}

// Successor body per (collection, record_id): the next version's body, or the
// live record where the row was the last write.
const live = new Map()
for (const [collection, records] of Object.entries(data)) {
  if (!Array.isArray(records)) continue
  for (const record of records) {
    if (record && typeof record === 'object' && record.id) live.set(`${collection}:${record.id}`, record)
  }
}

const ordered = new Map()
for (const version of versions) {
  const key = `${version.collection}:${version.record_id}`
  const list = ordered.get(key)
  if (list) list.push(version)
  else ordered.set(key, [version])
}

let rewritten = 0
let skippedNoBody = 0
let alreadyCompact = 0
let bytesBefore = 0
let bytesAfter = 0

for (const list of ordered.values()) {
  list.sort((a, b) => String(a.valid_from || '').localeCompare(String(b.valid_from || '')))
  for (let i = 0; i < list.length; i += 1) {
    const version = list[i]
    const changes = version.changed_fields
    if (!changes) continue
    bytesBefore += JSON.stringify(changes).length
    if (isCompact(changes)) { alreadyCompact += 1; bytesAfter += JSON.stringify(changes).length; continue }
    if (!version.body) { skippedNoBody += 1; bytesAfter += JSON.stringify(changes).length; continue }

    // The value that superseded this one: the following version's body, else
    // the live record.
    const successor = list[i + 1]?.body || live.get(`${version.collection}:${version.record_id}`)
    if (!successor) { skippedNoBody += 1; bytesAfter += JSON.stringify(changes).length; continue }

    const recomputed = changedFields(version.body, successor)
    version.changed_fields = recomputed
    rewritten += 1
    bytesAfter += recomputed ? JSON.stringify(recomputed).length : 0
  }
}

const savedBytes = bytesBefore - bytesAfter
const mb = (n) => (n / 1048576).toFixed(1)

console.log(`store            ${storePath}`)
console.log(`version rows     ${versions.length}`)
console.log(`already compact  ${alreadyCompact}`)
console.log(`rewritten        ${rewritten}`)
console.log(`left alone       ${skippedNoBody}  (no body to recompute from)`)
console.log(`changed_fields   ${mb(bytesBefore)} MB -> ${mb(bytesAfter)} MB  (saved ${mb(savedBytes)} MB)`)

if (dryRun) {
  console.log('\n--dry-run: nothing written.')
  process.exit(0)
}

if (!rewritten) {
  console.log('\nNothing to write.')
  process.exit(0)
}

const tmp = `${storePath}.${process.pid}.tmp`
await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
await rename(tmp, storePath)
console.log(`\nWritten. Re-seed with 'npm run demo:seed' to rebuild derived state.`)