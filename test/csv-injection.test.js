import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { toCsv, toGeoJson } from '../src/utils.js'

/**
 * The CSV export is not a data file — it is an executable one.
 *
 * A field report carries health-worker prose by design, and `export.csv` is the
 * widest read in the product: every hazard, conflict, incident and report lands
 * in one sheet. A cell beginning with `=` reaches Excel and LibreOffice as a
 * formula, not as text, so a body of `=cmd|'/c calc'!A1` executes on double
 * click. The recipient is not the attacker — it is whoever opened the widest
 * read in the system.
 *
 * These run through the real HTTP route rather than calling toCsv directly,
 * because the route is what makes the export the widest read; a unit test on
 * the helper would pass unchanged if the route stopped using it.
 */

const ENV_KEYS = ['LINDELA_LITE_TOKENS', 'LINDELA_LITE_API_KEY', 'LINDELA_LITE_PUBLIC_PATHS']
const saved = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]

function setUnauthenticated() {
  for (const key of ENV_KEYS) delete process.env[key]
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

// Payloads that reach a spreadsheet cell as a formula. Excel evaluates a cell
// whose first character is = + - or @, and will skip leading tabs, carriage
// returns, newlines and ordinary spaces before deciding, so the tab and
// space-prefixed variants are the ones a naive `^=` check misses.
const PAYLOADS = [
  "=cmd|'/c calc'!A1",
  '+1+1',
  '-1+1',
  '@SUM(A1)',
  "\t=SUM(1+1)*cmd|'/c calc'!A0",
  '  =HYPERLINK("http://evil.test","click")',
]

// A spreadsheet strips leading whitespace and control characters before it
// decides whether a cell is a formula, so that is the prefix these payloads
// are judged on.
function executablePrefix(cell) {
  return cell.replace(/^[\s\u0000-\u001f]+/, '')
}

function isNeutralised(cell) {
  const probe = executablePrefix(cell)
  if (!/^[=+\-@]/.test(probe)) return true
  // A bare number is not a formula in any of these applications: -3.12 is a
  // coordinate, +254700000000 is a phone number, and both appear in every
  // export. Escaping them would make every numeric column a string.
  return probe !== cell || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cell)
}

// Strict RFC4180 splitter. Deliberately does not trim: a leading tab that
// survives into the file is part of the attack, so the assertion must see it.
function splitCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

async function withServer(fieldReports, fn) {
  setUnauthenticated()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-csv-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.merge({
    field_reports: fieldReports.map((summary, index) => ({
      id: `fr-${index}`,
      summary,
      latitude: -0.0201,
      longitude: 35.6,
      occurred_at: '2026-10-01T00:00:00.000Z',
    })),
  })
  const server = createServer({ store })
  const listener = server.listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function summariseColumn(body, header = 'summary') {
  const [headers, ...rows] = splitCsv(body)
  const index = headers.indexOf(header)
  assert.notEqual(index, -1, `no ${header} column in the export: ${headers.join('|')}`)
  return rows.map((row) => row[index])
}

describe('CSV export is not formula-injectable', () => {
  it('neutralises every payload that reaches the export route intact', async () => {
    await withServer(PAYLOADS, async (base) => {
      const res = await fetch(`${base}/api/v1/export.csv`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type'), /text\/csv/)
      const body = await res.text()
      const cells = summariseColumn(body)

      for (const [payload, cell] of PAYLOADS.map((payload, index) => [payload, cells[index]])) {
        assert.equal(cell, `'${payload}`, `payload reached the export unchanged: ${JSON.stringify(cell)}`)
        assert.ok(
          isNeutralised(cell),
          `cell still opens as a formula: ${JSON.stringify(cell)} from payload ${JSON.stringify(payload)}`,
        )
      }
      // The exact proof the defect was real, pinned so a future revert of the
      // quote cannot pass by escaping something else.
      assert.ok(body.includes("'=cmd|'/c calc'!A1"), 'the calc payload is missing from the export entirely')
      assert.ok(!splitCsv(body)[1].includes('=cmd'), 'a bare =cmd survives in the first data row')
    })
  })

  it('leaves numeric values unquoted so machine parsers still see numbers', async () => {
    await withServer(['-3.12', '+254700000000', '0', '-0.5e3'], async (base) => {
      const body = await (await fetch(`${base}/api/v1/export.csv`)).text()
      assert.deepEqual(summariseColumn(body), ['-3.12', '+254700000000', '0', '-0.5e3'])
    })
  })

  it('does not disturb commas, doubled quotes, newlines or empty rows', () => {
    const tricky = [
      'Kapsabet, Baringo',
      'He said "flood" loudly',
      'line one\nline two',
      'plain',
    ]
    const [headers, ...rows] = splitCsv(toCsv(tricky.map((summary, index) => ({ id: `r${index}`, summary }))))
    assert.deepEqual(headers, ['id', 'summary'])
    assert.deepEqual(rows.map((row) => row[1]), tricky)
  })

  it('still emits a header-only export and an all-empty record row', () => {
    assert.equal(toCsv([]), '\n')
    assert.equal(toCsv([{ a: null, b: undefined }]), 'a,b\n,\n')
  })

  it('escapes a data-derived header the same way as a value', () => {
    const csv = toCsv([{ "=cmd|'/c calc'!A1": 1 }])
    assert.equal(csv, "'=cmd|'/c calc'!A1\n1\n")
    assert.equal(toCsv([{ 'a,b': '=1+1' }]), '"a,b"\n\'=1+1\n')
  })

  it('leaves GeoJSON alone: it is JSON, and no spreadsheet reads one as a formula', async () => {
    // toGeoJson shares its inputs with the export but not its fate: the payload
    // is a value inside a JSON string, delivered with a JSON content type. A
    // spreadsheet importing it as data has nothing to execute, and prefixing
    // here would corrupt coordinates in every map layer for no gain.
    const geojson = toGeoJson([
      { id: 'g1', latitude: -0.0201, longitude: 35.6, summary: PAYLOADS[0] },
    ])
    assert.equal(geojson.features[0].geometry.coordinates[0], 35.6)
    assert.equal(geojson.features[0].geometry.coordinates[1], -0.0201)
    assert.ok(geojson.features[0].properties.summary.includes("=cmd|'/c calc'!A1"))
    await withServer(PAYLOADS, async (base) => {
      const res = await fetch(`${base}/api/v1/export.geojson`)
      const json = await res.json()
      const reports = json.features.filter((feature) => feature.properties?.id?.startsWith('fr-'))
      assert.ok(reports.length > 0, 'no field reports in the geojson export')
    })
  })
})