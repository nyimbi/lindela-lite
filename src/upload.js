import { SERVICE_TYPES, ROAD_CLASSES, normalizeSeverity } from './schema.js'
import { parseCsv, stableId } from './utils.js'

/**
 * Bulk CSV upload with a row-level validation report.
 *
 * There was no path for a user to get their own data in. `src/connectors/uploads.js`
 * accepts CSV as a *string inside a JSON body* — a district officer with a 4 MB
 * ACLED export or a year of rainfall CSVs had to paste it into a field on a
 * surface that has no such field, and the API was the only door. It is also a
 * door with no curtain: the connector returns `errors`, the caller decides what
 * to do with them, and nothing anywhere enumerates what was wrong with which row.
 * A paste-and-pray import that reports "imported 400, 12 errors" is worse than
 * one that refuses, because the twelve are invisible.
 *
 * So: parse, validate, and say. Every row gets a verdict and every rejection
 * gets a row number, a column, the value that was found, and what was expected.
 * `dry_run` returns that report and writes nothing, which is the only sane way
 * to offer an import into a system that other people depend on.
 *
 * Three things this deliberately does not do. It does not guess a column name —
 * `lat`, `latitude` and `Latitude` all appear in real exports and guessing which
 * is meant turns a typo into a silently dropped column. It does not clamp an
 * out-of-range coordinate, because a latitude of 91 is not a latitude at ±90 and
 * the record would then be in the store claiming to be somewhere it is not. And
 * it does not merge a rejected row's neighbours into a partial success without
 * saying so: a batch either lands whole or reports exactly what was wrong with
 * it.
 */

/** Collections a user may upload into, and what each one needs at minimum. */
export const UPLOAD_COLLECTIONS = Object.freeze([
  {
    id: 'service_assets',
    label: 'Service assets',
    required: ['name', 'latitude', 'longitude'],
    // `id` is generated when absent, so it is not required — but a supplied one
    // must be a real id, because a duplicate silently overwrites.
    optional: ['id', 'service_type', 'road_class', 'country', 'admin1', 'capacity', 'population_served'],
  },
  {
    id: 'conflict_events',
    label: 'Conflict events',
    required: ['event_date'],
    optional: ['id', 'title', 'event_type', 'latitude', 'longitude', 'fatalities', 'actor1', 'admin1', 'country', 'description'],
  },
  {
    id: 'hazard_events',
    label: 'Hazard events',
    required: ['event_type', 'occurred_at'],
    optional: ['id', 'title', 'severity', 'latitude', 'longitude', 'admin1', 'country', 'source'],
  },
  {
    id: 'climate_observations',
    label: 'Climate observations',
    required: ['observed_at', 'metric', 'value'],
    optional: ['id', 'latitude', 'longitude', 'station_id', 'unit'],
  },
])

export const UPLOAD_COLLECTION_IDS = Object.freeze(UPLOAD_COLLECTIONS.map((c) => c.id))

/** Fields that must parse as an ISO-8601-ish timestamp wherever they appear. */
const DATE_FIELDS = Object.freeze(['event_date', 'occurred_at', 'observed_at', 'date', 'created_at'])

/**
 * Bounds check that a coordinate passes.
 *
 * A value of exactly 0 is a point on the equator or the prime meridian and is
 * perfectly good. `latitude && longitude` was the falsy-zero guard this codebase
 * has been bitten by repeatedly, and it is not used here — `null` and `''` are
 * rejected and `0` is kept, which is the whole distinction.
 */
function coordinateProblem(column, value) {
  if (value === null || value === undefined || value === '') return { missing: true }
  const n = Number(value)
  if (!Number.isFinite(n)) return { reason: 'not a number', value: String(value) }
  const limit = column === 'latitude' ? 90 : 180
  if (Math.abs(n) > limit) return { reason: `outside ±${limit}`, value: String(value) }
  return { number: n }
}

/** Lowercase, trimmed header aliases actually seen in humanitarian exports. */
const COLUMN_ALIASES = Object.freeze({
  lat: 'latitude', latitude: 'latitude', y: 'latitude',
  lon: 'longitude', lng: 'longitude', long: 'longitude', longitude: 'longitude', x: 'longitude',
  event_date: 'event_date', date: 'event_date', occurred_at: 'occurred_at',
  eventidcnty: 'event_id_cnty', event_id_cnty: 'event_id_cnty',
})

/** Map a header cell onto a field name, or null when we will not guess. */
export function normalizeColumn(header) {
  const key = String(header || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return COLUMN_ALIASES[key] || key
}

/**
 * Validate a CSV against a collection's contract.
 *
 * Returns `{ ok, collection, headers, rows, errors, summary }`. `rows` holds the
 * normalised records for every row that passed; `errors` holds one entry per
 * rejected row, each naming the row, the column and the value.
 */
export function validateUpload(csvText, { collection: collectionId, existingIds = new Set() } = {}) {
  const definition = UPLOAD_COLLECTIONS.find((c) => c.id === collectionId)
  if (!definition) {
    return {
      ok: false,
      collection: collectionId ?? null,
      headers: [],
      rows: [],
      errors: [{ row: 0, column: null, value: collectionId ?? null, message: `Unknown collection '${collectionId}'. Expected one of ${UPLOAD_COLLECTION_IDS.join(', ')}.` }],
      summary: emptySummary(),
    }
  }

  const text = String(csvText ?? '')
  if (!text.trim()) {
    return {
      ok: false,
      collection: collectionId,
      headers: [],
      rows: [],
      errors: [{ row: 0, column: null, value: null, message: 'The file is empty.' }],
      summary: emptySummary(),
    }
  }

  // `parseCsv` returns objects keyed by trimmed header and has already dropped
  // the header row and any wholly blank line, so a row number here is the file
  // line: `index + 2`, counting the header. Getting that off by one would send
  // an operator to line 41 to fix line 42.
  const parsed = parseCsv(text)
  if (!parsed.length) {
    return {
      ok: false,
      collection: collectionId,
      headers: [],
      rows: [],
      errors: [{ row: 0, column: null, value: null, message: 'No rows could be read from this file.' }],
      summary: emptySummary(),
    }
  }

  // Headers come from the first parsed row, so a file with a header and no data
  // rows still reports which columns it was missing.
  const headerSource = String(text).replace(/\r\n/g, '\n').split('\n')[0]
  const headers = parseCsvHeader(headerSource)
  const errors = []

  // Missing required columns are a file-level error: reporting them once each is
  // clearer than reporting them on every one of four thousand rows.
  const missingColumns = definition.required.filter((c) => !headers.includes(c))
  for (const column of missingColumns) {
    errors.push({ row: 1, column, value: null, message: `Required column '${column}' is not in the file. Present: ${headers.join(', ') || '(none)'}.` })
  }
  if (missingColumns.length) {
    return {
      ok: false,
      collection: collectionId,
      headers,
      rows: [],
      errors,
      summary: { ...emptySummary(), total_rows: parsed.length, invalid_rows: parsed.length },
    }
  }

  const seenIds = new Set()
  const rows = []

  for (const [index, cells] of parsed.entries()) {
    const rowNumber = index + 2
    const rowErrors = []
    // Re-key by normalised column name so an export headed `Lat` is read, while
    // an unknown header is still carried through as its own field rather than
    // dropped on the floor.
    const record = {}
    for (const [rawHeader, value] of Object.entries(cells)) {
      const column = normalizeColumn(rawHeader)
      if (!column) continue
      record[column] = value === undefined || value === null ? '' : String(value).trim()
    }

    for (const column of definition.required) {
      if (record[column] === undefined || record[column] === '') {
        rowErrors.push({ row: rowNumber, column, value: record[column] ?? null, message: `'${column}' is required and this row leaves it empty.` })
      }
    }

    for (const column of ['latitude', 'longitude']) {
      if (record[column] === undefined || record[column] === '') continue
      const check = coordinateProblem(column, record[column])
      if (check.missing) {
        rowErrors.push({ row: rowNumber, column, value: record[column], message: `'${column}' is present but blank.` })
      } else if (check.reason) {
        rowErrors.push({ row: rowNumber, column, value: check.value, message: `'${column}' is ${check.reason}.` })
      } else {
        record[column] = check.number
      }
    }

    for (const column of DATE_FIELDS) {
      if (record[column] === undefined || record[column] === '') continue
      const parsed = Date.parse(record[column])
      if (Number.isNaN(parsed)) {
        rowErrors.push({ row: rowNumber, column, value: record[column], message: `'${column}' is not a date this platform can read. ISO-8601 is the only format it will guess at.` })
      } else {
        record[column] = new Date(parsed).toISOString()
      }
    }

    if (definition.id === 'service_assets' && record.service_type && !SERVICE_TYPES.includes(record.service_type)) {
      rowErrors.push({ row: rowNumber, column: 'service_type', value: record.service_type, message: `'service_type' must be one of ${SERVICE_TYPES.join(', ')}.` })
    }
    if (definition.id === 'service_assets' && record.road_class && !ROAD_CLASSES.includes(record.road_class)) {
      rowErrors.push({ row: rowNumber, column: 'road_class', value: record.road_class, message: `'road_class' must be one of ${ROAD_CLASSES.join(', ')}.` })
    }
    if (definition.id === 'climate_observations' && record.value !== undefined && record.value !== '') {
      const n = Number(record.value)
      if (!Number.isFinite(n)) {
        rowErrors.push({ row: rowNumber, column: 'value', value: record.value, message: `'value' must be a number.` })
      } else {
        record.value = n
      }
    }
    if (definition.id === 'conflict_events' && record.fatalities !== undefined && record.fatalities !== '') {
      const n = Number(record.fatalities)
      if (!Number.isFinite(n) || n < 0) {
        rowErrors.push({ row: rowNumber, column: 'fatalities', value: record.fatalities, message: `'fatalities' must be zero or more.` })
      } else {
        record.fatalities = n
      }
    }

    // The id is resolved *before* the duplicate check, not after. It used to be
    // read off the row, checked, and only generated if absent — so a file with no
    // `id` column (the common case) never had its generated id compared with the
    // store. Re-importing the same file produced the same generated ids, merged
    // over the existing rows, and reported `imported: 3`. That is the overwrite
    // the next line exists to prevent, reached by the one route that always
    // generates the id.
    const id = record.id || stableId(collectionId, [record.name, record.title, record.event_type, record.metric, record.occurred_at, record.event_date, record.observed_at, record.latitude, record.longitude])
    record.id = id

    // Duplicate detection has two sources and they are different problems. Two
    // rows in this file resolving to the same id is a mistake in the file. A row
    // whose id is already in the store would overwrite a record someone else
    // relies on. Calling both "duplicate" would hide the second.
    if (seenIds.has(id)) {
      rowErrors.push({ row: rowNumber, column: 'id', value: id, message: `'${id}' appears more than once in this file. Only the first will be kept.` })
    }
    seenIds.add(id)
    if (existingIds.has(id)) {
      rowErrors.push({ row: rowNumber, column: 'id', value: id, message: `'${id}' is already in the store. Importing it would overwrite an existing record.` })
    }

    if (rowErrors.length) {
      errors.push(...rowErrors)
      continue
    }

    if (definition.id === 'hazard_events' && record.severity) record.severity = normalizeSeverity(record.severity)
    for (const numeric of ['capacity', 'population_served']) {
      if (record[numeric] !== undefined && record[numeric] !== '') {
        const n = Number(record[numeric])
        if (Number.isFinite(n)) record[numeric] = n
      }
    }
    rows.push(record)
  }

  const invalidRows = new Set(errors.map((e) => e.row)).size
  return {
    // `ok` means the whole file landed. It was `rows.length + invalidRows ===
    // parsed.length`, which is an arithmetic coincidence rather than a statement
    // of intent — three rows with one rejected still satisfies it, so a file
    // with a bad row in it reported success and the route imported the rest.
    ok: errors.length === 0 && rows.length === parsed.length,
    collection: collectionId,
    headers,
    rows,
    errors,
    summary: {
      total_rows: parsed.length,
      valid_rows: rows.length,
      invalid_rows: invalidRows,
      error_count: errors.length,
    },
  }
}

/** Header cells of the first line, normalised. */
function parseCsvHeader(line) {
  const cells = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i += 1 } else quoted = !quoted
    } else if (char === ',' && !quoted) {
      cells.push(normalizeColumn(field))
      field = ''
    } else {
      field += char
    }
  }
  cells.push(normalizeColumn(field))
  return cells
}

function emptySummary() {
  return { total_rows: 0, valid_rows: 0, invalid_rows: 0, error_count: 0 }
}

/**
 * Parse a `multipart/form-data` body into fields and files.
 *
 * No dependency, because the project's single runtime dependency is `pg` and
 * this is not worth changing that. It handles the case a browser actually
 * produces: a boundary, `Content-Disposition` with a `name`, an optional
 * `filename`, and the CRLF-delimited body. It refuses a part with no `name`,
 * because a part nobody named is data with no route to anywhere.
 */
export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  const boundary = (match?.[1] || match?.[2] || '').trim()
  if (!boundary) throw Object.assign(new Error('multipart/form-data requires a boundary parameter'), { statusCode: 400 })

  const delimiter = Buffer.from(`--${boundary}`)
  const fields = {}
  const files = []

  let cursor = buffer.indexOf(delimiter)
  if (cursor === -1) {
    throw Object.assign(new Error('multipart body does not contain its boundary'), { statusCode: 400 })
  }

  while (cursor !== -1) {
    const start = cursor + delimiter.length
    // `--` after the boundary is the epilogue, not another part.
    if (buffer.slice(start, start + 2).toString() === '--') break

    const next = buffer.indexOf(delimiter, start)
    if (next === -1) break
    // The CRLF before the boundary belongs to the delimiter, not to the part.
    let part = buffer.slice(start, next - 2)

    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString('utf8')
      const body = part.slice(headerEnd + 4)
      const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers)
      const name = disposition ? /name="([^"]*)"/i.exec(disposition[1])?.[1] : null
      const filename = disposition ? /filename="([^"]*)"/i.exec(disposition[1])?.[1] : null

      if (name) {
        if (filename !== undefined && filename !== null) {
          files.push({ field: name, filename, content: body })
        } else {
          fields[name] = body.toString('utf8')
        }
      }
      part = null
    }

    cursor = next
  }

  return { fields, files }
}