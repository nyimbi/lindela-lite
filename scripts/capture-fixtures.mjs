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
 */

import fs from 'node:fs/promises'
import process from 'node:process'

import {
  CaptureStore,
  DEFAULT_RETENTION_DAYS,
  parseCaptures,
  pruneCaptures,
  seedFixturesFromCaptures,
} from '../src/capture.js'

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  process.stdout.write(`Usage: node scripts/capture-fixtures.mjs --out <dir> [--url <url> --source <id>]... [--from-store <file>]

  --out <dir>              fixture directory to write into (required)
  --url <url>              fetch and capture; repeatable
  --source <id>            source id for --url (required with --url)
  --content-type <type>    override the captured content type
  --name <file-stem>       fixture filename stem, e.g. gdacs -> gdacs.xml
  --store <file>           capture store to read, extend and write back
  --from-store <file>      seed only; take captures from this store
  --retention-days <n>     prune the store before writing (default ${DEFAULT_RETENTION_DAYS})
  --list                   print what is held in --from-store, write nothing
`)
  process.exit(0)
}

if (!args.out) fail('--out is required: this script writes into a real fixture directory')

const captures = []

if (args.store || args.fromStore) {
  const file = args.store ?? args.fromStore
  let existing = []
  if (await exists(file)) existing = parseCaptures(await fs.readFile(file, 'utf8'))
  captures.push(...existing)
  if (args.list) {
    for (const entry of pruneCaptures(captures, { retentionDays: args.retentionDays })) {
      process.stdout.write(`${entry.content_hash.slice(0, 12)}  ${entry.byte_length}b  ${entry.content_type ?? '-'}  ${entry.retrieved_at}  ${entry.url}\n`)
    }
    process.exit(0)
  }
}

if (args.urls.length && !args.source) fail('--source is required with --url')

for (const url of args.urls) {
  const response = await fetch(url)
  const bytes = Buffer.from(await response.arrayBuffer())
  captures.push(await captureInto({
    url,
    source: args.source,
    status: response.status,
    contentType: args.contentType ?? response.headers.get('content-type'),
    body: bytes,
  }))
  process.stdout.write(`captured ${url} → HTTP ${response.status}, ${bytes.length}b\n`)
}

if (!captures.length) fail('nothing to seed: pass --url to capture or --from-store/--store to read')

const kept = pruneCaptures(captures, { retentionDays: args.retentionDays })
process.stdout.write(`retention: ${captures.length} capture(s) in, ${kept.length} kept at ${args.retentionDays}d\n`)

const { fixtures, superseded, manifest_path: manifest } = await seedFixturesFromCaptures(kept, {
  targetDir: args.out,
  nameFor: args.name ? (capture) => args.name : null,
})

for (const fixture of fixtures) {
  process.stdout.write(`  ${fixture.file}  ${fixture.byte_length}b  ${fixture.content_type ?? '-'}  ← ${fixture.url}\n`)
}
for (const loser of superseded) {
  process.stdout.warn(`  superseded ${loser.file} (${loser.content_hash.slice(0, 12)}) by ${loser.superseded_by.slice(0, 12)}\n`)
}
process.stdout.write(`${fixtures.length} fixture(s), manifest at ${manifest}\n`)

if (args.store) {
  await fs.writeFile(args.store, new CaptureStore(kept).toJSON(), 'utf8')
  process.stdout.write(`store at ${args.store} holds ${kept.length} capture(s)\n`)
}

/**
 * Capture through the same path the wiring layer uses, so the CLI cannot
 * disagree with `withCapture` about what a capture looks like.
 */
async function captureInto(params) {
  const store = new CaptureStore()
  store.add(params)
  return store.list()[0]
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
    else if (token === '--help' || token === '-h') options.help = true
    else if (flags[token]) options[flags[token]] = argv[++i]
    else fail(`unknown argument ${token}`)
  }
  if (options.retentionDays !== DEFAULT_RETENTION_DAYS) options.retentionDays = Number(options.retentionDays)
  return options
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}