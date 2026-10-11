import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { toCsv } from '../src/utils.js'
import { HXL_HASHTAGS, hxlRow, isValidHashtag } from '../src/hxl.js'

/**
 * ENH-31 — HXL-tagged CSV export.
 *
 * HDX's whole ingestion pipeline keys on an HXL hashtag row: a second header
 * line carrying `#loc+name`, `#date+occurred`, `#affected+flooded` above the
 * human column names. Without it a partner hand-maps every one of the 341
 * columns the widest read in the product emits — which is the same as saying
 * the export is not interoperable, only readable.
 *
 * The row is aligned column-for-column with the header row, so a hashtag can
 * only ever describe the column above it. A registry that emitted hashtags in
 * its own order would produce a file whose tags are all correct and all on the
 * wrong columns, and nothing downstream could tell.
 */

const ENV_KEYS = ['LINDELA_LITE_TOKENS', 'LINDELA_LITE_API_KEY', 'LINDELA_LITE_PUBLIC_PATHS']

async function withServer(fn, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-hxl-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) {
    if (v === '') delete process.env[k]
    else process.env[k] = v
  }
  const listener = createServer({ store }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    for (const [k, v] of Object.entries(env)) {
      if (!(k in saved)) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** The raw text of one line, split on commas that are not inside quotes. */
function splitCsv(line) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { cells.push(cell); cell = '' }
    else cell += ch
  }
  cells.push(cell)
  return cells
}

describe('ENH-31 — an HXL hashtag row, aligned to the header it describes', () => {
  it('leaves the export byte-identical when HXL is not asked for', () => {
    // The default is the file that exists today. An export that changed shape
    // because a new option was added would break every consumer that already
    // parses it, and the change would look like an improvement in the diff.
    const records = [{ id: 'r1', district: 'Kampala', latitude: 0.3 }]
    assert.equal(toCsv(records), 'district,id,latitude\nKampala,r1,0.3\n')
    assert.equal(toCsv(records, { hxl: false }), toCsv(records))
  })

  it('puts the hashtag row directly above the header row', () => {
    const csv = toCsv([{ district: 'Kampala', latitude: 0.3, longitude: 32.6 }], { hxl: true })
    const [tags, headers] = csv.split('\n')
    assert.deepEqual(splitCsv(headers), ['district', 'latitude', 'longitude'])
    assert.deepEqual(splitCsv(tags), ['#adm2+name', '#geo+lat', '#geo+lon'])
  })

  it('aligns every hashtag to its own column, never to the registry order', () => {
    // The failure this guards is silent: a hashtag row built from the registry
    // rather than from the headers tags every column correctly and puts each
    // one on the wrong column, and the file still parses.
    const records = [{ longitude: 32.6, district: 'Kampala', latitude: 0.3 }]
    const [tags, headers] = toCsv(records, { hxl: true }).split('\n')
    const headerCells = splitCsv(headers)
    const tagCells = splitCsv(tags)
    assert.equal(tagCells.length, headerCells.length,
      'the hashtag row and the header row must have the same width')
    assert.equal(tagCells[headerCells.indexOf('district')], '#adm2+name')
    assert.equal(tagCells[headerCells.indexOf('latitude')], '#geo+lat')
    assert.equal(tagCells[headerCells.indexOf('longitude')], '#geo+lon')
  })

  it('leaves an unmapped column blank rather than inventing a tag', () => {
    const csv = toCsv([{ id: 'r1', derivation_context_snapshot_counts_hazard_events: 3 }], { hxl: true })
    const [tags, headers] = csv.split('\n')
    const headerCells = splitCsv(headers)
    const tagCells = splitCsv(tags)
    const unmapped = headerCells.indexOf('derivation_context_snapshot_counts_hazard_events')
    assert.equal(tagCells[unmapped], '',
      'a hashtag that is not in the registry is a claim HDX will act on')
    assert.equal(tagCells[headerCells.indexOf('id')], '#meta+id')
  })

  it('emits only well-formed hashtags', () => {
    for (const tag of Object.values(HXL_HASHTAGS)) {
      assert.ok(isValidHashtag(tag), `${tag} is not a well-formed HXL hashtag`)
    }
  })

  it('spells every registry key the way flattening produces it', async () => {
    // The registry is keyed by *column* name, and a column name is what
    // `flattenRecord` makes of a record key: a nested field becomes a dotted
    // path (`location.admin1`), an underscored one stays underscored
    // (`source_id`). A registry written against the store's own field names is
    // off by exactly that convention, and the failure is silent — the tag
    // simply never matches a header and the column reads as unmapped.
    //
    // This builds a record from the registry's own keys, nesting each dotted
    // key, and asserts the export emits every one of them as a column. It
    // proves the convention, which is the part that can be checked without a
    // seeded store; it does not prove a production record carries the field,
    // and says so rather than implying coverage it did not measure.
    const record = {}
    for (const key of Object.keys(HXL_HASHTAGS)) {
      const parts = key.split('.')
      let node = record
      for (const part of parts.slice(0, -1)) node = (node[part] ??= {})
      node[parts.at(-1)] = 'x'
    }
    const csv = toCsv([record])
    const headers = new Set(splitCsv(csv.split('\n')[0]))
    const unmatched = Object.keys(HXL_HASHTAGS).filter((field) => !headers.has(field))
    assert.deepEqual(unmatched, [],
      `these registry keys do not match any column flattening produces: ${unmatched.join(', ')}`)
  })
})

describe('ENH-31 — the route serves the tagged export on request', () => {
  // One record, written straight to the store, so these run without the demo
  // seed — which reaches eleven live third-party feeds and takes minutes.
  async function withOneRecord(fn) {
    return withServer(async (base, store) => {
      await store.merge({
        hazard_events: [{
          id: 'hazard_hxl_1',
          event_type: 'flood',
          district: 'Kampala',
          latitude: 0.31,
          longitude: 32.58,
          occurred_at: '2026-10-01T00:00:00Z',
        }],
      })
      return fn(base)
    })
  }

  it('omits the hashtag row unless asked', async () => {
    await withOneRecord(async (base) => {
      const csv = await (await fetch(`${base}/api/v1/export.csv`)).text()
      const [first] = csv.split('\n')
      assert.ok(!first.includes('#'),
        'the default export must be the file consumers already parse')
    })
  })

  it('serves the hashtag row for ?hxl=1, aligned to the same header row', async () => {
    await withOneRecord(async (base) => {
      const plain = await (await fetch(`${base}/api/v1/export.csv`)).text()
      const tagged = await (await fetch(`${base}/api/v1/export.csv?hxl=1`)).text()
      const [plainHeader, ...plainRows] = plain.split('\n')
      const [tagRow, taggedHeader, ...taggedRows] = tagged.split('\n')
      assert.ok(plainHeader.length > 0, 'the export emitted no header at all')
      assert.equal(taggedHeader, plainHeader,
        'the header row must be identical; only the row above it is new')
      assert.deepEqual(taggedRows, plainRows, 'no data row may change')
      assert.equal(splitCsv(tagRow).length, splitCsv(plainHeader).length)
      assert.ok(splitCsv(tagRow).some((tag) => tag.startsWith('#')),
        'the tagged export carries no hashtag at all')
    })
  })

  it('is refused for a value that is not a switch, rather than silently ignored', async () => {
    // `?hxl=maybe` read as truthy would tag the export for a caller who did not
    // ask, and read as falsy it would silently ignore a parameter the caller
    // believes was honoured. The route refuses instead, like `?limit=abc`.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/export.csv?hxl=maybe`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.equal(body.code, 'bad_request')
    })
  })
})

describe('ENH-31 — hxlRow is the whole of the alignment', () => {
  it('returns one cell per header, in the header order', () => {
    assert.deepEqual(hxlRow(['latitude', 'district']), ['#geo+lat', '#adm2+name'])
    assert.deepEqual(hxlRow([]), [])
  })

  it('is total: an unknown field is the empty string, never undefined', () => {
    // `undefined` reaches `csvEscape` as '' and would pass, but it reaches any
    // other consumer as a missing cell. The row is total or it is not a row.
    const row = hxlRow(['nope', 'district'])
    assert.deepEqual(row, ['', '#adm2+name'])
    assert.ok(row.every((cell) => typeof cell === 'string'))
  })
})
