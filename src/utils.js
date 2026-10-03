import crypto from 'node:crypto'
import { KNOWN_DISTRICTS } from './districts.js'

export function stableId(prefix, value) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  return `${prefix}_${hash}`
}

/**
 * Deterministic JSON with object keys sorted at every depth.
 *
 * The previous implementation used `JSON.stringify(filtered, Object.keys(filtered))`.
 * The second argument to JSON.stringify is a property *allowlist* which applies at
 * every level of nesting, so only the top-level keys survived — `metadata` was
 * kept as a key but every key inside it was dropped, and the hash of a record was
 * identical no matter what its metadata said.
 *
 * That is not cosmetic. mergeById skips an incoming record whose payload_hash
 * already exists, so a connector whose metadata changed — a corrected model
 * limit, a flipped episode_declared, a new geolocation note — produced the same
 * hash and the update was silently discarded. Since connector metadata is where
 * the qualifications and provenance live, the one thing that must be able to
 * change is exactly what could not.
 */
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    )
  }
  return value
}

export function canonicalHash(record, ignoreKeys = ['id', 'payload_hash', 'ingested_at', 'generated_at', 'updated_at', 'created_at', 'first_seen_at']) {
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => !ignoreKeys.includes(key))
  )
  return crypto.createHash('sha256').update(JSON.stringify(canonicalise(filtered))).digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Coerce to a finite number, or the fallback.
 *
 * Null, undefined and the empty string must fall back rather than coerce to 0.
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so the previous
 * implementation turned "no value" into a real zero. That is harmless for a
 * threshold and not harmless for a coordinate: a field report whose location was
 * unknown was stored with null latitude and longitude, and the moment anything
 * updated or soft-deleted it through the operational API, the normaliser read
 * those nulls and wrote 0 — putting the report back at Null Island in the Gulf
 * of Guinea. A null is an absence; a zero is a location.
 */
export function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
  if (Array.isArray(value)) return fallback
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

/** Whether two west,south,east,north boxes overlap. */
export function boxIntersectsBbox(inner, outer) {
  if (!inner || !outer) return false
  const [w, s, e, n] = [inner.west, inner.south, inner.east, inner.north]
  if (![w, s, e, n].every(Number.isFinite)) return false
  return w <= outer.east && e >= outer.west && s <= outer.north && n >= outer.south
}

/**
 * Whether a record belongs in a bbox query.
 *
 * A point inside the box qualifies. So does a record the source reported as an
 * *area* overlapping the box, even with no point at all.
 *
 * That second case is not hypothetical. GDACS reports most events as a bounding
 * box, and the connector deliberately withholds a point when the box is
 * regional, because a box centre can be hundreds of km from the event. Filtering
 * on points alone therefore returned nothing for those events: a caller asking
 * "what is in this district" was told there was nothing, for a hazard the source
 * had explicitly placed there as an area.
 */
export function recordInBbox(item, bbox) {
  if (!bbox) return true
  if (pointInBbox(item, bbox)) return true
  return boxIntersectsBbox(parseRecordBbox(item.bbox), bbox)
}

function parseRecordBbox(value) {
  if (!value) return null
  if (Array.isArray(value)) return parseBbox(value.join(','))
  if (typeof value === 'object') return value
  return null
}

/**
 * @param {object} [context] optional `{ data, collection }`, used to resolve
 *   records that carry no location of their own. Without it a district filter
 *   matches nothing for those collections.
 */
export function filterRecords(records, query, context = {}) {
  const districtRelations = buildDistrictRelations(context.data, context.collection, resolveDistrictFilter(query.get('district') || query.get('region')))
  const bbox = parseBbox(query.get('bbox'))
  const country = query.get('country')
  const source = query.get('source')
  const eventType = query.get('event_type')
  const reportType = query.get('report_type') || query.get('type')
  const severity = query.get('severity')
  const status = query.get('status')
  const priority = query.get('priority')
  const incidentId = query.get('incident_id')
  const interventionId = query.get('intervention_id')
  const serviceType = query.get('service_type')
  const owner = query.get('owner')
  const templateId = query.get('template_id')
  const scheduleId = query.get('schedule_id')
  // `district` and `region` used to be read by nothing here. filterRecords
  // ignores parameters it does not understand, so `?district=Bor` was
  // indistinguishable from no filter at all and returned every record in the
  // collection — cross-district data handed to any caller that asked to be
  // scoped to one district. Both are now real filters.
  const districtFilter = resolveDistrictFilter(query.get('district') || query.get('region'))
  const from = query.get('from') ? Date.parse(query.get('from')) : null
  const to = query.get('to') ? Date.parse(query.get('to')) : null
  const limit = Math.min(Math.max(Number(query.get('limit') || 500), 1), 5000)

  return records
    .filter((item) => recordInBbox(item, bbox))
    .filter((item) => !country || item.country === country || item.scope?.country === country)
    .filter((item) => !source || item.source === source || item.source_name === source)
    .filter((item) => !eventType || item.event_type === eventType || item.type === eventType)
    .filter((item) => !reportType || item.report_type === reportType || item.type === reportType)
    .filter((item) => !severity || item.severity === severity || item.risk_level === severity)
    .filter((item) => !status || item.status === status)
    .filter((item) => !priority || item.priority === priority)
    .filter((item) => !incidentId || item.incident_id === incidentId || item.scope?.incident_id === incidentId || item.id === incidentId)
    .filter((item) => !interventionId || item.intervention_id === interventionId || item.scope?.intervention_id === interventionId || item.id === interventionId)
    .filter((item) => !serviceType || item.service_type === serviceType || item.scope?.service_type === serviceType)
    .filter((item) => !owner || item.owner === owner)
    .filter((item) => !templateId || item.template_id === templateId)
    .filter((item) => !scheduleId || item.schedule_id === scheduleId)
    .filter((item) => !districtFilter || recordInDistrict(item, districtFilter, districtRelations))
    .filter((item) => {
      const timestamp = Date.parse(item.observed_at || item.occurred_at || item.event_date || item.generated_at || item.approved_at || item.distributed_at || item.updated_at || item.created_at || '')
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

const DEFAULT_MAX_BODY_BYTES = Number(process.env.LINDELA_LITE_MAX_BODY_BYTES || 5 * 1024 * 1024)

/**
 * Buffers the request body once and caches it on `req.__rawBody`.
 *
 * A webhook signature covers the exact bytes sent, so verification has to
 * happen after buffering but before anything interprets the body. Draining the
 * stream twice yields nothing the second time — the chunks are gone — which is
 * why this caches and why readRequestJson() reuses it.
 */
export async function readRawBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  if (req.__rawBody !== undefined) return req.__rawBody

  // Check Content-Length first so an oversized upload is rejected before it is
  // buffered. This is advisory: it can lie, so the streaming check below is
  // the authoritative one.
  const declaredLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw Object.assign(
      new Error(`Request body too large: ${declaredLength} bytes exceeds limit of ${maxBytes}`),
      { statusCode: 413 }
    )
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      throw Object.assign(
        new Error(`Request body too large: exceeds limit of ${maxBytes} bytes`),
        { statusCode: 413 }
      )
    }
    chunks.push(chunk)
  }

  req.__rawBody = Buffer.concat(chunks).toString('utf8')
  return req.__rawBody
}

export async function readRequestJson(req, options = {}) {
  const raw = await readRawBody(req, options)
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 })
  }
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

/**
 * Resolve a `district` or `region` filter value to a known district.
 *
 * An unknown value is returned as-is so `recordInDistrict` can match nothing,
 * rather than being dropped and silently ignored the way it was before: a
 * misspelled district should return nothing, not everything.
 */
export function resolveDistrictFilter(value) {
  if (value === null || value === undefined || value === '') return null
  const key = String(value).trim().toLowerCase()
  if (!key) return null
  const known = KNOWN_DISTRICTS.find(
    (d) => d.slug === key || d.name.toLowerCase() === key,
  )
  return known || { slug: key, name: value, center: null, radius_km: null, unknown: true }
}

/**
 * Does this record belong to the district?
 *
 * Matched on an explicit label where the record has one, otherwise spatially
 * against the district extent. A record with neither is not in the district —
 * the same rule the report scope uses, so an API filter and a report cannot
 * disagree about what is in Turkana.
 */
export function recordInDistrict(item, district, relations = null) {
  if (!district) return true
  const labels = [district.slug, district.name, String(district.name).toLowerCase()]
  const named = [item.district, item.region, item.region_name, item.admin1, item.scope?.district]
  for (const value of named) {
    if (typeof value !== 'string') continue
    if (labels.some((label) => label && label.toLowerCase() === value.toLowerCase())) return true
  }
  // Multi-value labels, e.g. an event covering "Turkana, Bor".
  for (const value of named) {
    if (typeof value !== 'string') continue
    const parts = value.split(/[,;/]/).map((part) => part.trim().toLowerCase())
    if (parts.some((part) => labels.some((label) => label && label.toLowerCase() === part))) return true
  }
  if (district.center && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
    const distance = haversineKm(
      { latitude: district.center.lat, longitude: district.center.lon },
      { latitude: item.latitude, longitude: item.longitude },
    )
    return distance <= district.radius_km
  }
  // Interventions, their tasks and alert dispatches carry no coordinates and no
  // district field. Filtered directly they match nothing, so every district
  // reported no activity while interventions were attached to it — which reads
  // as a finding rather than as an absence of data. They are reached through the
  // record that does carry a location, the same way `districtOverview` does it,
  // so the list endpoints and the district overview cannot disagree.
  if (relations) {
    for (const key of DISTRICT_RELATION_KEYS) {
      const relatedId = item[key]
      if (!relatedId) continue
      const state = relations.get(relatedId)
      if (state === true) return true
      if (state === false) return false
    }
  }
  return false
}

const DISTRICT_RELATION_KEYS = ['incident_id', 'intervention_id', 'alert_event_id']

/**
 * Collections whose records carry no location of their own, and the chain of
 * collections to attribute them through, nearest first. Interventions hang off
 * an incident; their tasks hang off the intervention; dispatches hang off the
 * alert event.
 */
const DISTRICT_PARENT_CHAINS = {
  interventions: ['incidents', 'interventions'],
  intervention_tasks: ['incidents', 'interventions', 'intervention_tasks'],
  rapidpro_dispatches: ['alert_events', 'rapidpro_dispatches'],
  rapidpro_inbound_messages: ['alert_events', 'rapidpro_inbound_messages'],
}

/**
 * Map each record id in the chain's last collection to whether it falls in the
 * district, so children with no location of their own are attributed through the
 * nearest ancestor that has one.
 */
function buildDistrictRelations(data, collection, district) {
  const chain = DISTRICT_PARENT_CHAINS[collection]
  if (!data || !district || !chain) return null
  // Every level but the last. The last entry is the collection being filtered,
  // and its records are attributed by looking their parent id up in the map
  // returned here — so returning that level's own map would key intervention ids
  // where incident ids are looked for, and every lookup would miss.
  let relations = null
  for (const name of chain.slice(0, -1)) {
    const next = new Map()
    for (const record of data[name] || []) {
      if (!record?.id) continue
      next.set(record.id, recordInDistrict(record, district, relations))
    }
    relations = next
  }
  return relations
}
