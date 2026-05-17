import crypto from 'node:crypto'

export function stableId(prefix, value) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  return `${prefix}_${hash}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function toNumber(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function parseBbox(value) {
  if (!value) return null
  const parts = String(value).split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('bbox must be west,south,east,north')
  }
  const [west, south, east, north] = parts
  if (west >= east || south >= north) throw new Error('bbox bounds are invalid')
  return { west, south, east, north }
}

export function pointInBbox(item, bbox) {
  if (!bbox) return true
  if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return false
  return item.longitude >= bbox.west && item.longitude <= bbox.east && item.latitude >= bbox.south && item.latitude <= bbox.north
}

export function filterRecords(records, query) {
  const bbox = parseBbox(query.get('bbox'))
  const country = query.get('country')
  const source = query.get('source')
  const eventType = query.get('event_type')
  const severity = query.get('severity')
  const from = query.get('from') ? Date.parse(query.get('from')) : null
  const to = query.get('to') ? Date.parse(query.get('to')) : null
  const limit = Math.min(Math.max(Number(query.get('limit') || 500), 1), 5000)

  return records
    .filter((item) => pointInBbox(item, bbox))
    .filter((item) => !country || item.country === country)
    .filter((item) => !source || item.source === source || item.source_name === source)
    .filter((item) => !eventType || item.event_type === eventType || item.type === eventType)
    .filter((item) => !severity || item.severity === severity || item.risk_level === severity)
    .filter((item) => {
      const timestamp = Date.parse(item.observed_at || item.occurred_at || item.event_date || item.generated_at || item.updated_at || '')
      if (!Number.isFinite(timestamp)) return true
      if (from && timestamp < from) return false
      if (to && timestamp > to) return false
      return true
    })
    .slice(0, limit)
}

export function parseCsv(text) {
  if (!text || !String(text).trim()) return []
  const rows = []
  let field = ''
  let row = []
  let quoted = false
  const input = String(text).replace(/\r\n/g, '\n')
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    const next = input[i + 1]
    if (char === '"' && quoted && next === '"') {
      field += '"'
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if (char === '\n' && !quoted) {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [headers = [], ...dataRows] = rows.filter((candidate) => candidate.some((cell) => String(cell).trim()))
  return dataRows.map((cells) => Object.fromEntries(headers.map((header, index) => [header.trim(), cells[index]?.trim() ?? ''])))
}

export function toCsv(records) {
  const flatRecords = records.map((record) => flattenRecord(record))
  const headers = [...new Set(flatRecords.flatMap((record) => Object.keys(record)))].sort()
  const lines = [headers.join(',')]
  for (const record of flatRecords) {
    lines.push(headers.map((header) => csvEscape(record[header])).join(','))
  }
  return `${lines.join('\n')}\n`
}

function flattenRecord(record, prefix = '') {
  const flat = {}
  for (const [key, value] of Object.entries(record || {})) {
    const nextKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flat, flattenRecord(value, nextKey))
    } else {
      flat[nextKey] = Array.isArray(value) ? JSON.stringify(value) : value
    }
  }
  return flat
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

export function toGeoJson(records) {
  return {
    type: 'FeatureCollection',
    features: records
      .filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
      .map((item) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [item.longitude, item.latitude],
        },
        properties: Object.fromEntries(
          Object.entries(item).filter(([key]) => key !== 'latitude' && key !== 'longitude'),
        ),
      })),
  }
}

export function jsonResponse(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export async function readRequestJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

export function haversineKm(a, b) {
  const earthRadiusKm = 6371
  const dLat = radians(b.latitude - a.latitude)
  const dLon = radians(b.longitude - a.longitude)
  const lat1 = radians(a.latitude)
  const lat2 = radians(b.latitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h))
}

function radians(value) {
  return value * Math.PI / 180
}
