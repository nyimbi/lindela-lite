#!/usr/bin/env node
/**
 * Back up the Lindela Lite store with a timestamp, and rotate old backups.
 *
 * The store is the whole demo world — a gitignored JSON file locally, an
 * ephemeral container path or a database volume on a host — and there is
 * exactly one of it. `npm run demo:seed` is idempotent, but corruption is not
 * reversible, and "the deploy wiped the volume" is not a backup strategy.
 *
 *   npm run demo:backup            # back up + rotate (keeps the newest 5)
 *
 * The backup is verified before it counts: the copy is parsed and its record
 * total compared against the source, and a backup that fails either check is
 * deleted rather than left to look like safety.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createStoreFromEnv } from '../src/storage.js'

const KEEP = 5
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data/backups')
fs.mkdirSync(dir, { recursive: true })

const store = await createStoreFromEnv()
const data = await store.read()
const total = Object.entries(data)
  .filter(([, rows]) => Array.isArray(rows))
  .reduce((sum, [, rows]) => sum + rows.length, 0)

const target = path.join(dir, `store-backup-${stamp}.json`)
fs.writeFileSync(target, JSON.stringify(data, null, 2))

// Verify before it counts: a corrupt backup is worse than none, because it
// looks like safety until the day it is the only copy.
let ok = true
try {
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  const backupTotal = Object.entries(parsed)
    .filter(([, rows]) => Array.isArray(rows))
    .reduce((sum, [, rows]) => sum + rows.length, 0)
  if (backupTotal !== total) {
    console.error(`backup rejected: record total ${backupTotal} != source ${total}`)
    ok = false
  }
} catch (err) {
  console.error(`backup rejected: does not parse (${err.message})`)
  ok = false
}
if (!ok) {
  fs.rmSync(target)
  process.exit(1)
}

const backups = fs.readdirSync(dir)
  .filter((name) => name.startsWith('store-backup-') && name.endsWith('.json'))
  .sort()
const removed = backups.slice(0, Math.max(0, backups.length - KEEP))
for (const name of removed) fs.rmSync(path.join(dir, name))

console.log(`backed up ${total} records -> data/backups/${path.basename(target)}`)
if (removed.length) console.log(`rotated ${removed.length} old backup(s), kept newest ${KEEP}`)
