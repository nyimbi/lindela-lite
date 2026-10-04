#!/usr/bin/env node
/**
 * ENH-12: capture live responses and seed the fixture suite from them.
 *
 * Thin CLI over `seedFixturesFromCaptures`. Everything it knows about fixture
 * shape lives in `src/capture.js`; this file parses arguments, fetches, and
 * prints what it wrote.
 *
 * The seven fixtures in `test/fixtures/` were assembled by hand after each
 * upstream broke, which means each one encodes the fix rather than the failure.
 * This script replaces them with the bytes that actually arrived: capture the
 * live response, write it beside the suite, keep the provenance, and the next
 * connector change is tested against what the provider really serves.
 *
 * Usage:
 *   # Capture one response and write it into the fixture directory.
 *   node scripts/capture-fixtures.mjs --url https://www.gdacs.org/rss.xml \
 *     --source gdacs --out test/fixtures
 *
 *   # Seed from a capture store the service already wrote (no network).
 *   node scripts/capture-fixtures.mjs --from-store data/captures.json --out test/fixtures
 *
 *   # Capture into a retained store, then seed from it.
 *   node scripts/capture-fixtures.mjs --url ... --source gdacs \
 *     --store data/captures.json --retention-days 30 --out test/fixtures
 *
 * `--out` is mandatory on purpose. The fixtures beside it cannot be
 * regenerated, so a seeder with a remembered output path is one flag away from
 * overwriting them with a response nobody has read yet.
 *
 * ## Retention is a stated policy, not a filter
 *
 * Every run states the window it is pruning to and prints it, because a
 * retention rule nobody was told about reads as data loss the first time
 * something goes missing. Pruning runs through `CaptureStore.prune`, which
 * leaves a tombstone per expired body — retrieved-at, pruned-at, window — and
 * those tombstones ride in the store file and into `createReplayStore`, so a
 * later replay of an expired URL says *pruned* with its dates rather than
 * answering an empty body. An empty body from a replay is indistinguishable
 * from a provider that returned nothing, which is how the three parsing defects
 * this whole module exists for got in.
 *
 * `--prune-only` is the scheduled run: prune a store, write it back, seed no
 * fixtures. It does not need `--out`, because it writes nothing into the
 * fixture directory and demanding a path for a run that touches no fixtures
 * would be safety theatre.
 */

import fs from 'node:fs/promises'
import process from 'node:process'

import {
  CaptureStore,
  DEFAULT_RETENTION_DAYS,
  RETENTION_POLICY,
  parseCaptures,
  pruneCaptures,
  retentionWindow,
  seedFixturesFromCaptures,
} from '../src/capture.js'

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  process.stdout.write(`Usage: node scripts/capture-fixtures.mjs --out <dir> [--url <url> --source <id>]... [--from-store <file>]

  --out <dir>              fixture directory to write into (required unless --prune-only)
  --url <url>              fetch and capture; repeatable
  --source <id>            source id for --url (required with --url)
  --content-type <type>    override the captured content type
  --name <file-stem>       fixture filename stem, e.g. gdacs -> gdacs.xml
  --store <file>           capture store to read, extend and write back
  --from-store <file>      seed only; take captures from this store
  --retention-days <n>     prune the store before writing (default ${DEFAULT_RETENTION_DAYS})
  --prune-only             prune --store and write it back, seeding no fixtures
  --list                   print what is held in --from-store, write nothing

${retentionWindow()}

Pruned captures leave a tombstone recording when they were retrieved, when they
were pruned, and under which window, so a later replay of that URL reports it as
pruned rather than answering with an empty body.
`)
  process.exit(0)
}

if (!args.out && !args.pruneOnly) fail('--out is required: this script writes into a real fixture directory')

// One store for the whole run, whether the captures came from the network or
// from a store file, because pruning has to leave a tombstone and only the
// store knows how to do that. A `pruneCaptures` filter over a bare array would
// drop the bodies and take the record of the drop with them, which is how a
// retention window turns into indistinguishable data loss.
const store = new CaptureStore()

if (args.store || args.fromStore) {
  const file = args.store ?? args.fromStore
  if (await exists(file)) {
    const restored = parseCaptures(await fs.readFile(file, 'utf8'))
    for (const entry of restored) store.add(entry)
    for (const stone of restored.tombstones) store.adoptTombstone(stone)
    process.stdout.write(`read ${restored.length} capture(s) and ${restored.tombstones.length} tombstone(s) from ${file}\n`)
  }
  if (args.list) {
    const held = pruneCaptures(store.list(), { retentionDays: args.retentionDays })
    process.stdout.write(`${retentionWindow()}\n\n`)
    for (const entry of held) {
      process.stdout.write(`${entry.content_hash.slice(0, 12)}  ${entry.byte_length}b  ${entry.content_type ?? '-'}  ${entry.retrieved_at}  seen ${entry.seen_count}x  ${entry.url}\n`)
    }
    for (const stone of store.tombstones()) {
      process.stdout.write(`pruned  ${stone.content_hash.slice(0, 12)}  retrieved ${stone.retrieved_at}  pruned ${stone.pruned_at}  ${stone.url}\n`)
    }
    process.exit(0)
  }
}

if (args.urls.length && !args.source) fail('--source is required with --url')

for (const url of args.urls) {
  const response = await fetch(url)
  const bytes = Buffer.from(await response.arrayBuffer())
  const { entry, duplicate } = store.add({
    url,
    source: args.source,
    status: response.status,
    contentType: args.contentType ?? response.headers.get('content-type'),
    body: bytes,
  })
  // Seen-count is the honest report: a second fetch of identical bytes is the
  // dedupe working, and saying "captured" again would read as new evidence.
  process.stdout.write(
    duplicate
      ? `re-captured ${url} → HTTP ${response.status}, ${bytes.length}b (identical to stored body, now seen ${entry.seen_count}x)\n`
      : `captured ${url} → HTTP ${response.status}, ${bytes.length}b\n`,
  )
}

const beforePrune = store.size
const { pruned, kept } = store.prune({ retentionDays: args.retentionDays })
process.stdout.write(`${retentionWindow()}\n`)
process.stdout.write(`retention: ${beforePrune} capture(s) in, ${kept} kept, ${pruned} pruned at ${args.retentionDays}d\n`)
for (const stone of store.tombstones()) {
  process.stdout.write(`  pruned ${stone.content_hash.slice(0, 12)}  retrieved ${stone.retrieved_at}  pruned ${stone.pruned_at}  ${stone.url}\n`)
}

// `--prune-only` exists because "prune the store and tell me what went" is a
// real operation an operator runs on a schedule, and it must not require naming
// a fixture directory to do it. Requiring --out for a run that writes no
// fixtures would be the wrong kind of safety.
if (args.pruneOnly) {
  if (!args.store) fail('--prune-only needs --store: pruning has nowhere to record itself without one')
  await fs.writeFile(args.store, store.toJSON(), 'utf8')
  process.stdout.write(`store at ${args.store} holds ${kept} capture(s) and ${store.tombstones().length} tombstone(s)\n`)
  process.exit(0)
}

if (!store.size) fail('nothing to seed: every capture was pruned or none were supplied')

const { fixtures, superseded, manifest_path: manifest } = await seedFixturesFromCaptures(store.list(), {
  targetDir: args.out,
  nameFor: args.name ? (capture) => args.name : null,
})

for (const fixture of fixtures) {
  process.stdout.write(`  ${fixture.file}  ${fixture.byte_length}b  ${fixture.content_type ?? '-'}  ← ${fixture.url}\n`)
}
for (const loser of superseded) {
  // `process.stderr`, not `process.stdout.warn` — there is no `warn` on a
  // WriteStream, so the superseded path crashed with a TypeError after the
  // fixtures had already been written. The warning is the only record that a
  // capture was dropped, which is the last thing to lose.
  process.stderr.write(`  superseded ${loser.file} (${loser.content_hash.slice(0, 12)}) by ${loser.superseded_by.slice(0, 12)}\n`)
}
process.stdout.write(`${fixtures.length} fixture(s), manifest at ${manifest}\n`)
process.stdout.write('every seeded fixture is a replay of a captured response, marked as such in the manifest\n')

if (args.store) {
  await fs.writeFile(args.store, store.toJSON(), 'utf8')
  process.stdout.write(`store at ${args.store} holds ${kept} capture(s) and ${store.tombstones().length} tombstone(s)\n`)
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const options = {
    urls: [],
    out: null,
    source: null,
    contentType: null,
    name: null,
    store: null,
    fromStore: null,
    retentionDays: DEFAULT_RETENTION_DAYS,
    pruneOnly: false,
    list: false,
    help: false,
  }
  const flags = {
    '--out': 'out',
    '--source': 'source',
    '--content-type': 'contentType',
    '--name': 'name',
    '--store': 'store',
    '--from-store': 'fromStore',
    '--retention-days': 'retentionDays',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--url') options.urls.push(argv[++i])
    else if (token === '--list') options.list = true
    else if (token === '--prune-only') options.pruneOnly = true
    else if (token === '--help' || token === '-h') options.help = true
    else if (flags[token]) options[flags[token]] = argv[++i]
    else fail(`unknown argument ${token}`)
  }
  if (options.retentionDays !== DEFAULT_RETENTION_DAYS) options.retentionDays = Number(options.retentionDays)
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) {
    fail(`--retention-days must be a positive number of days, got ${options.retentionDays}`)
  }
  if (options.retentionDays !== RETENTION_POLICY.retention_days) {
    process.stdout.write(
      `note: ${options.retentionDays}d overrides the stated ${RETENTION_POLICY.retention_days}d window; `
      + 'the override is recorded on every tombstone this run writes\n',
    )
  }
  return options
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}