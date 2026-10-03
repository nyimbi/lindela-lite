#!/usr/bin/env node
/**
 * Bulk upload with a validation report.
 *
 * The claim under test is not "the endpoint exists". It is that an operator who
 * sends four thousand rows of ACLED export gets back a statement about every one
 * of them — and that a batch with anything wrong in it writes nothing at all.
 *
 * Those are different claims and the second is the one that matters. A partial
 * import is the outcome nobody wants: the caller has to work out which half
 * landed, and the half that landed is the half they did not look at. So the
 * route refuses, and the tests below are mostly about whether it really does.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import {
  UPLOAD_COLLECTIONS, UPLOAD_COLLECTION_IDS, normalizeColumn, validateUpload, parseMultipart,
} from '../src/upload.js'

const ASSETS = [
  'name,latitude,longitude,service_type,capacity',
  'Kakuma Clinic,-1.5,36.2,health,120',
  'Borno Borehole,11.5,13.2,water,50',
  'Kisumu Road,-0.1,34.75,road,0',
].join('\n')

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-upload-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const post = (base, body, headers = {}, query = '') => fetch(`${base}/api/v1/upload${query}`, {
  method: 'POST', headers, body,
})

/** What a browser actually puts on the wire, built here rather than stubbed. */
function multipart({ collection, csv, dryRun = false, filename = 'assets.csv', boundary = '----lindelaTest7MA' }) {
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="collection"\r\n\r\n${collection}\r\n`,
  ]
  if (dryRun) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="dry_run"\r\n\r\ntrue\r\n`)
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/csv\r\n\r\n${csv}\r\n`,
    `--${boundary}--\r\n`,
  )
  return { body: Buffer.from(parts.join('')), contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('the contract is published, not guessed', () => {
  it('serves every collection with its required and optional columns', async () => {
		await withServer(async (base) => {
			const body = await (await fetch(`${base}/api/v1/upload`)).json()
			assert.equal(body.success, true)
			assert.deepEqual(body.collections.map((c) => c.id).sort(), [...UPLOAD_COLLECTION_IDS].sort())
			for (const definition of UPLOAD_COLLECTIONS) {
				const served = body.collections.find((c) => c.id === definition.id)
				assert.deepEqual(served.required_columns, [...definition.required])
				assert.ok(served.required_columns.length > 0, `${definition.id} declares no required columns`)
			}
		})
	})

  it('keeps `id` optional — it is generated when absent', () => {
    const assets = UPLOAD_COLLECTIONS.find((c) => c.id === 'service_assets')
    assert.ok(!assets.required.includes('id'), 'a supplied id is checked, but absence is fine')
    assert.ok(assets.optional.includes('id'))
  })
})

describe('column names are normalised, never guessed at', () => {
  it('maps the headers real exports actually use', () => {
    assert.equal(normalizeColumn('Lat'), 'latitude')
    assert.equal(normalizeColumn(' LON '), 'longitude')
    assert.equal(normalizeColumn('Longitude'), 'longitude')
    assert.equal(normalizeColumn('Event Date'), 'event_date')
    assert.equal(normalizeColumn('event-date'), 'event_date')
    assert.equal(normalizeColumn('EventIDCNTY'), 'event_id_cnty')
  })

  it('passes an unknown header through rather than dropping it', () => {
    assert.equal(normalizeColumn('District'), 'district')
    assert.equal(normalizeColumn(''), '')
    assert.equal(normalizeColumn(null), '')
  })

  it('reads a file headed `Lat`/`LON` as coordinates', () => {
    const report = validateUpload('Name,Lat,LON\nClinic,-1.5,36.2', { collection: 'service_assets' })
    assert.equal(report.ok, true)
    assert.equal(report.rows[0].latitude, -1.5)
    assert.equal(report.rows[0].longitude, 36.2)
  })

  it('carries an unrecognised column into the record rather than losing it', () => {
    // Dropping it would be a silent data loss the operator never learns about.
    const report = validateUpload('name,latitude,longitude,district\nClinic,-1.5,36.2,Wajir', {
      collection: 'service_assets',
    })
    assert.equal(report.rows[0].district, 'Wajir')
  })
})

describe('zero is a coordinate', () => {
  it('accepts latitude 0 and longitude 0', () => {
    // `latitude && longitude` is the falsy-zero guard this codebase has been
    // bitten by repeatedly. The equator and the prime meridian are ordinary
    // places and a row at either is valid.
    const report = validateUpload('name,latitude,longitude\nOrigin,0,0', { collection: 'service_assets' })
    assert.equal(report.ok, true)
    assert.equal(report.rows[0].latitude, 0)
    assert.equal(report.rows[0].longitude, 0)
  })

  it('still rejects a blank coordinate', () => {
    const blank = validateUpload('name,latitude,longitude\nNowhere,,36.2', { collection: 'service_assets' })
    assert.equal(blank.ok, false)
    assert.equal(blank.errors[0].value, '')
    assert.match(blank.errors[0].message, /required and this row leaves it empty/)
  })

  it('rejects out-of-range values rather than clamping them', () => {
    // A latitude of 91 is not a latitude at ±90. Clamping would put the record
    // in the store claiming to be somewhere it is not.
    const cases = [['91', '36.2', 'latitude'], ['-90.5', '36.2', 'latitude'], ['0', '181', 'longitude']]
    for (const [lat, lon, column] of cases) {
      const report = validateUpload(`name,latitude,longitude\nX,${lat},${lon}`, { collection: 'service_assets' })
      assert.equal(report.ok, false, `${column}=${lat}/${lon} should be rejected`)
      assert.equal(report.errors[0].column, column)
    }
  })

  it('accepts the exact bounds', () => {
    const report = validateUpload('name,latitude,longitude\nX,90,180', { collection: 'service_assets' })
    assert.equal(report.ok, true)
    assert.equal(report.rows[0].latitude, 90)
    assert.equal(report.rows[0].longitude, 180)
  })

  it('reports a coordinate on a row that has no required coordinate column', () => {
    // `conflict_events` does not require coordinates. A bad one that *is* present
    // is still a bad one.
    const report = validateUpload('event_date,latitude\n2026-01-01,91', { collection: 'conflict_events' })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0].column, 'latitude')
  })
})

describe('every rejection names the row, the column and the value', () => {
  it('counts the header, so line numbers point at the real file line', () => {
    const report = validateUpload(ASSETS.replace('-1.5', 'ninety'), { collection: 'service_assets' })
    assert.equal(report.ok, false)
    // Row 1 of the data is line 2 of the file. Getting this off by one sends an
    // operator to line 1 to fix line 2.
    assert.equal(report.errors[0].row, 2)
    assert.equal(report.errors[0].column, 'latitude')
    assert.equal(report.errors[0].value, 'ninety')
  })

  it('reports the last row at its own line', () => {
    const report = validateUpload(ASSETS.replace('34.75', '999'), { collection: 'service_assets' })
    assert.equal(report.errors[0].row, 4)
    assert.equal(report.errors[0].column, 'longitude')
  })

  it('collects every problem in a row, not just the first', () => {
    const report = validateUpload('name,latitude,longitude,service_type\nX,91,nope,satellite', {
      collection: 'service_assets',
    })
    const columns = report.errors.map((e) => e.column).sort()
    assert.deepEqual(columns, ['latitude', 'longitude', 'service_type'])
  })

  it('names a missing required column once, not once per row', () => {
    // Four thousand rows do not need four thousand copies of the same sentence.
    const csv = Array.from({ length: 50 }, (_, i) => `A${i},36.2`).join('\n')
    const report = validateUpload(`longitude\n${csv}`, { collection: 'service_assets' })
    assert.equal(report.ok, false)
    assert.equal(report.errors.length, 2, 'name and latitude are both absent')
    assert.ok(report.errors.every((e) => e.row === 1))
    assert.match(report.errors[0].message, /Present: longitude/)
  })

  it('rejects a header-only file rather than reporting success', () => {
    const report = validateUpload('name,latitude,longitude', { collection: 'service_assets' })
    assert.equal(report.ok, false)
    assert.equal(report.summary.total_rows, 0)
    assert.match(report.errors[0].message, /No rows could be read/)
  })

  it('rejects an empty file', () => {
    for (const empty of ['', '   ', '\n\n']) {
      const report = validateUpload(empty, { collection: 'service_assets' })
      assert.equal(report.ok, false)
      assert.match(report.errors[0].message, /empty/)
    }
  })

  it('rejects an unknown collection and says which are valid', () => {
    const report = validateUpload(ASSETS, { collection: 'weather' })
    assert.equal(report.ok, false)
    assert.match(report.errors[0].message, /Unknown collection 'weather'/)
    assert.match(report.errors[0].message, /service_assets/)
  })
})

describe('a date is a date or it is nothing', () => {
  it('accepts ISO-8601 and normalises it', () => {
    const report = validateUpload('event_date,title\n2026-03-04,Clash', { collection: 'conflict_events' })
    assert.equal(report.ok, true)
    assert.equal(report.rows[0].event_date, '2026-03-04T00:00:00.000Z')
  })

  it('refuses to guess at a format it does not recognise', () => {
    const report = validateUpload('event_date\nlast tuesday-ish', { collection: 'conflict_events' })
    assert.equal(report.ok, false)
    assert.match(report.errors[0].message, /ISO-8601/)
  })

  it('leaves an absent optional date absent rather than filling it', () => {
    const report = validateUpload('event_date\n2026-03-04', { collection: 'conflict_events' })
    assert.ok(!('observed_at' in report.rows[0]))
  })
})

describe('duplicates are two different problems', () => {
  const file = 'id,name,latitude,longitude\na,A,-1.5,36.2\nb,B,-1.5,36.2\na,A,-1.5,36.2'

  it('calls out a repeat inside the file', () => {
    const report = validateUpload(file, { collection: 'service_assets' })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0].row, 4)
    assert.match(report.errors[0].message, /more than once in this file/)
  })

  it('calls out an id already in the store separately', () => {
    const report = validateUpload(file, { collection: 'service_assets', existingIds: new Set(['b']) })
    assert.equal(report.errors.find((e) => e.row === 3).message.includes('already in the store'), true)
  })

  it('says which of the two happened', () => {
    // Collapsing both into "duplicate" would hide the second: a repeat in the
    // file is a mistake in the file, an existing id is an overwrite of somebody
    // else's record.
    const report = validateUpload(file, { collection: 'service_assets', existingIds: new Set(['a']) })
    const messages = report.errors.map((e) => e.message)
    assert.ok(messages.some((m) => m.includes('more than once')))
    assert.ok(messages.some((m) => m.includes('already in the store')))
  })

  it('generates an id when none is supplied', () => {
    const report = validateUpload(ASSETS, { collection: 'service_assets' })
    assert.equal(report.ok, true)
    const ids = report.rows.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, 'generated ids collide')
    assert.ok(ids.every(Boolean))
  })
})

describe('typed fields are typed before they are stored', () => {
  it('rejects a value that is not a number', () => {
    const report = validateUpload('observed_at,metric,value\n2026-01-01,rainfall,heavy', {
      collection: 'climate_observations',
    })
    assert.equal(report.ok, false)
    assert.match(report.errors[0].message, /must be a number/)
  })

  it('accepts zero', () => {
    // Zero rain is a real observation. Conflating it with absent is the falsy-zero
    // defect, and this field is the one most likely to hit it.
    const report = validateUpload('observed_at,metric,value\n2026-01-01,rainfall,0', {
      collection: 'climate_observations',
    })
    assert.equal(report.ok, true)
    assert.equal(report.rows[0].value, 0)
  })

  it('rejects negative fatalities', () => {
    const report = validateUpload('event_date,fatalities\n2026-01-01,-4', { collection: 'conflict_events' })
    assert.equal(report.ok, false)
    assert.match(report.errors[0].message, /zero or more/)
  })

  it('rejects a service type the schema does not have', () => {
    const report = validateUpload('name,latitude,longitude,service_type\nX,0,0,helipad', {
      collection: 'service_assets',
    })
    assert.equal(report.ok, false)
    assert.match(report.errors[0].message, /must be one of/)
  })
})

describe('the summary accounts for every row', () => {
  it('adds up', () => {
    const report = validateUpload(ASSETS, { collection: 'service_assets' })
    assert.equal(report.summary.total_rows, 3)
    assert.equal(report.summary.valid_rows, 3)
    assert.equal(report.summary.invalid_rows, 0)
  })

  it('adds up when rows are rejected', () => {
    const report = validateUpload(ASSETS.replace('-1.5', 'x').replace('13.2', 'y'), {
      collection: 'service_assets',
    })
    assert.equal(report.summary.total_rows, 3)
    assert.equal(report.summary.valid_rows, 1)
    assert.equal(report.summary.invalid_rows, 2)
    assert.equal(report.errors.length, 2, 'two bad cells, one message each')
  })

  it('does not lose a row to a blank line in the middle', () => {
    // A stray blank line from a spreadsheet export must not make the two rows
    // around it disappear, nor count as a fourth row that failed.
    const report = validateUpload(`name,latitude,longitude
A,0,0

B,0,0`, { collection: 'service_assets' })
    assert.equal(report.ok, true)
    assert.equal(report.summary.total_rows, 2)
  })
})

describe('multipart is parsed without a dependency', () => {
  const { body, contentType } = multipart({ collection: 'service_assets', csv: ASSETS })

  it('separates fields from files', () => {
    const parsed = parseMultipart(body, contentType)
    assert.equal(parsed.fields.collection, 'service_assets')
    assert.equal(parsed.files.length, 1)
    assert.equal(parsed.files[0].field, 'file')
    assert.equal(parsed.files[0].filename, 'assets.csv')
    assert.equal(parsed.files[0].content.toString('utf8'), ASSETS)
  })

  it('reads a boolean field', () => {
    const parsed = parseMultipart(multipart({ collection: 'service_assets', csv: ASSETS, dryRun: true }).body,
      multipart({ collection: 'service_assets', csv: ASSETS, dryRun: true }).contentType)
    assert.equal(parsed.fields.dry_run, 'true')
  })

  it('stops at the epilogue rather than reading it as a part', () => {
    // Without the `--` check the trailing boundary becomes a part with no
    // Content-Disposition, which is exactly the case the parser refuses.
    const parsed = parseMultipart(body, contentType)
    assert.equal(parsed.files.length, 1)
  })

  it('handles a quoted boundary', () => {
    const parsed = parseMultipart(body, contentType.replace(/boundary=(.*)$/, 'boundary="$1"'))
    assert.equal(parsed.files[0].content.toString('utf8'), ASSETS)
  })

  it('refuses a body with no boundary to find', () => {
    assert.throws(() => parseMultipart(Buffer.from('nothing here'), 'multipart/form-data; boundary=zzz'),
      /does not contain its boundary/)
  })

  it('refuses a content type with no boundary parameter', () => {
    assert.throws(() => parseMultipart(Buffer.from(''), 'multipart/form-data'),
      /requires a boundary/)
  })

  it('does not split a quoted field on its comma', () => {
    const csv = 'name,latitude,longitude\n"Clinic, Main",0,0'
    const parsed = parseMultipart(multipart({ collection: 'service_assets', csv }).body,
      multipart({ collection: 'service_assets', csv }).contentType)
    const report = validateUpload(parsed.files[0].content.toString('utf8'), { collection: 'service_assets' })
    assert.equal(report.ok, true)
    assert.equal(report.rows[0].name, 'Clinic, Main')
  })
})

describe('three content types, one report', () => {
  it('imports a multipart browser upload', async () => {
		await withServer(async (base, store) => {
			const { body, contentType } = multipart({ collection: 'service_assets', csv: ASSETS })
			const res = await post(base, body, { 'content-type': contentType })
			const json = await res.json()
			assert.equal(res.status, 201)
			assert.equal(json.imported, 3)
			assert.equal(json.filename, 'assets.csv')
			assert.equal((await store.read()).service_assets.length, 3)
		})
	})

  it('imports a text/csv body', async () => {
		await withServer(async (base, store) => {
			const res = await post(base, ASSETS, { 'content-type': 'text/csv' })
			assert.equal(res.status, 201)
			assert.equal((await store.read()).service_assets.length, 3)
		})
	})

  it('imports rows already in memory as JSON', async () => {
		await withServer(async (base, store) => {
			const res = await post(base, JSON.stringify({ collection: 'service_assets', csv: ASSETS }),
				{ 'content-type': 'application/json' })
			assert.equal(res.status, 201)
			assert.equal((await store.read()).service_assets.length, 3)
		})
	})

  it('says so when the body holds no rows at all', async () => {
		await withServer(async (base) => {
			const res = await post(base, 'nothing', { 'content-type': 'text/csv' })
			assert.equal(res.status, 422)
			const json = await res.json()
			assert.match(json.error, /Nothing was written/)
			assert.match(json.errors[0].message, /No rows could be read/)
		})
	})
})

describe('a batch lands whole or not at all', () => {
  it('writes nothing when any row is invalid', async () => {
		await withServer(async (base, store) => {
			const csv = ASSETS.replace('-1.5', 'ninety')
			const res = await post(base, csv, { 'content-type': 'text/csv' })
			assert.equal(res.status, 422)
			const json = await res.json()
			assert.equal(json.valid_rows, 2)
			assert.equal(json.invalid_rows, 1)
			assert.match(json.error, /partial import is refused/)
			assert.equal((await store.read()).service_assets.length, 0, 'nothing at all was written')
		})
	})

  it('still records that the attempt was made', async () => {
		await withServer(async (base, store) => {
			await post(base, ASSETS.replace('-1.5', 'x'), { 'content-type': 'text/csv' })
			const logs = (await store.read()).action_logs
			assert.equal(logs.length, 1)
			assert.equal(logs[0].action, 'uploaded')
			assert.equal(logs[0].metadata.invalid_rows, 1)
		})
	})

  it('refuses to overwrite a record that already exists', async () => {
		await withServer(async (base, store) => {
			const first = await post(base, ASSETS, { 'content-type': 'text/csv' })
			assert.equal(first.status, 201)
			const ids = (await store.read()).service_assets.map((r) => r.id)
			const res = await post(base, ASSETS.replace(/^([^,]*,)/gm, '$1'),
				{ 'content-type': 'text/csv' })
			assert.equal(res.status, 422)
			assert.match(JSON.stringify(await res.json()), /already in the store/)
			assert.deepEqual((await store.read()).service_assets.map((r) => r.id), ids)
		})
	})

  it('reports every error it found, capped so the reader is not drowned', async () => {
		await withServer(async (base) => {
			const bad = Array.from({ length: 200 }, (_, i) => `A${i},91,36.2`).join('\n')
			const res = await post(base, `name,latitude,longitude\n${bad}`, { 'content-type': 'text/csv' })
			assert.equal(res.status, 422)
			const json = await res.json()
			assert.equal(json.errors.length, 20)
			assert.equal(json.errors_truncated, true)
			assert.equal(json.error_count, 200)
		})
	})

  it('does not truncate a report that fits', async () => {
		await withServer(async (base) => {
			const res = await post(base, ASSETS.replace('-1.5', 'x'), { 'content-type': 'text/csv' })
			assert.equal((await res.json()).errors_truncated, false)
		})
	})
})

describe('a dry run says what would happen and changes nothing', () => {
  it('reports without writing the records', async () => {
		await withServer(async (base, store) => {
			const res = await post(base, ASSETS, { 'content-type': 'text/csv' }, '?dry_run=true')
			assert.equal(res.status, 200)
			const json = await res.json()
			assert.equal(json.dry_run, true)
			assert.equal(json.valid_rows, 3)
			assert.equal(json.invalid_rows, 0)
			assert.deepEqual(json.errors, [])
			// `read()` returns the full collection shape whether or not anything
			// was written, so the assertion is on the rows, not on key presence.
			assert.equal((await store.read()).service_assets.length, 0)
		})
	})

  it('uses a different log action so the two are distinguishable after the fact', async () => {
		await withServer(async (base, store) => {
			await post(base, ASSETS, { 'content-type': 'text/csv' }, '?dry_run=true')
			assert.equal((await store.read()).action_logs[0].action, 'upload_validated')
		})
	})

  it('accepts the flag as a form field, which is how a browser sends it', async () => {
		await withServer(async (base, store) => {
			const { body, contentType } = multipart({ collection: 'service_assets', csv: ASSETS, dryRun: true })
			const res = await post(base, body, { 'content-type': contentType })
			assert.equal((await res.json()).dry_run, true)
			assert.equal((await store.read()).service_assets.length, 0)
		})
	})

  it('reports a dry run that would fail, rather than pretending it would succeed', async () => {
		await withServer(async (base, store) => {
			const res = await post(base, ASSETS.replace('-1.5', 'x'), { 'content-type': 'text/csv' }, '?dry_run=true')
			assert.equal(res.status, 200)
			assert.equal((await res.json()).invalid_rows, 1)
			assert.equal((await store.read()).service_assets.length, 0)
		})
	})
})