import { ROAD_CLASSES, ROAD_PASSABILITY, SERVICE_TYPES, normalizeSeverity } from '../schema.js'
import { parseCsv, stableId, toNumber } from '../utils.js'

export const serviceAssetsConnector = {
  id: 'service_assets',
  async ingest(options = {}) {
    const provided = collectServiceAssetInputs(options)
    const service_assets = []
    const errors = []
    provided.forEach((asset, index) => {
      const normalized = normalizeServiceAsset(asset, index)
      if (normalized.error) errors.push(normalized.error)
      else service_assets.push(normalized.value)
    })
    return { service_assets, errors }
  },
}

export const conflictCsvConnector = {
  id: 'conflict_csv',
  async ingest(options = {}) {
    const rows = Array.isArray(options.conflict_events)
      ? options.conflict_events
      : parseCsv(options.conflict_csv || '')
    return {
      conflict_events: rows.map((row) => normalizeConflictEvent(row, 'conflict_csv')).filter(Boolean),
      errors: [],
    }
  },
}

export const acledCsvConnector = {
  id: 'acled_csv',
  async ingest(options = {}) {
    if (!options.acled_license_accepted) {
      return {
        conflict_events: [],
        errors: ['ACLED imports require acled_license_accepted=true and user-supplied licensed data.'],
      }
    }
    const rows = Array.isArray(options.acled_events)
      ? options.acled_events
      : parseCsv(options.acled_csv || '')
    return {
      conflict_events: rows.map((row) => normalizeConflictEvent(row, 'acled_csv')).filter(Boolean),
      errors: [],
    }
  },
}

export function collectServiceAssetInputs(options = {}) {
  const assets = []
  if (Array.isArray(options.service_assets)) assets.push(...options.service_assets)
  if (options.service_assets_csv) assets.push(...parseCsv(options.service_assets_csv))
  if (options.service_assets_geojson) assets.push(...parseServiceAssetGeoJson(options.service_assets_geojson))
  return assets
}

export function parseServiceAssetGeoJson(input) {
  const geojson = typeof input === 'string' ? JSON.parse(input) : input
  const features = geojson?.type === 'FeatureCollection' ? geojson.features || [] : geojson?.type === 'Feature' ? [geojson] : []
  return features.map((feature) => {
    const [longitude, latitude] = feature.geometry?.coordinates || []
    return {
      ...(feature.properties || {}),
      latitude,
      longitude,
    }
  })
}

export function normalizeServiceAsset(asset, index = 0) {
  const latitude = toNumber(asset.latitude ?? asset.lat)
  const longitude = toNumber(asset.longitude ?? asset.lon ?? asset.lng)
  const serviceType = asset.service_type || asset.type
  const country = asset.country || asset.country_code || null
  const label = asset.name || asset.id || `row ${index + 1}`
  if (!Number.isFinite(latitude)) return { error: `${label}: latitude is required and must be numeric` }
  if (!Number.isFinite(longitude)) return { error: `${label}: longitude is required and must be numeric` }
  if (!serviceType) return { error: `${label}: service_type is required` }
  if (!SERVICE_TYPES.includes(serviceType)) return { error: `${label}: service_type must be one of ${SERVICE_TYPES.join(', ')}` }
  if (!country) return { error: `${label}: country is required` }

  // Road-specific attributes only apply to road assets. A health clinic with a
  // stray "road_class" field should not silently acquire road semantics.
  const isRoad = serviceType === 'road'
  const roadClass = isRoad ? normalizeRoadClass(asset.road_class ?? asset.roadClass ?? asset.class) : null
  const passability = isRoad ? normalizePassability(asset.passability ?? asset.access ?? asset.access_status) : null
  if (isRoad && asset.road_class && !roadClass) {
    return { error: `${label}: road_class must be one of ${ROAD_CLASSES.join(', ')}` }
  }
  if (isRoad && asset.passability && !passability) {
    return { error: `${label}: passability must be one of ${ROAD_PASSABILITY.join(', ')}` }
  }

  return {
    value: {
      id: asset.id || stableId('asset', [asset.name, serviceType, latitude, longitude]),
      source: 'service_assets',
      name: asset.name || `${serviceType} asset`,
      service_type: serviceType,
      status: asset.status || 'unknown',
      country,
      admin1: asset.admin1 || null,
      latitude,
      longitude,
      capacity: toNumber(asset.capacity),
      road_class: roadClass,
      passability: passability,
      // Metres of carriageway width, when known. Used to judge whether an
      // obstruction fully blocks a segment or can be worked around.
      width_m: toNumber(asset.width_m ?? asset.widthM ?? asset.width),
      updated_at: asset.updated_at || new Date().toISOString(),
      metadata: asset.metadata || {},
    },
  }
}

/**
 * Accepts common spellings and aliases for road class, defaulting to
 * 'unpaved' rather than guessing 'trunk'.
 */
function normalizeRoadClass(value) {
  if (value == null || value === '') return null
  const raw = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  const ALIASES = {
    highway: 'trunk',
    motorway: 'trunk',
    a_road: 'trunk',
    b_road: 'primary',
    main: 'primary',
    all_weather: 'trunk',
    tarmac: 'paved',
    paved: 'primary',
    gravel: 'unpaved',
    dirt: 'unpaved',
    earth: 'unpaved',
    footpath: 'track',
    path: 'track',
    trail: 'track',
  }
  const candidate = ALIASES[raw] || raw
  return ROAD_CLASSES.includes(candidate) ? candidate : null
}

/**
 * Accepts common spellings for passability. Defaults to 'passable' when a road
 * asset gives no access information, so absence of data never invents a
 * closure.
 */
function normalizePassability(value) {
  if (value == null || value === '') return null
  const raw = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  const ALIASES = {
    open: 'passable',
    clear: 'passable',
    accessible: 'passable',
    ok: 'passable',
    partial: 'restricted',
    limited: 'restricted',
    difficult: 'restricted',
    congested: 'restricted',
    blocked: 'impassable',
    closed: 'impassable',
    impassable: 'impassable',
    submerged: 'impassable',
    flooded: 'impassable',
    washed_out: 'impassable',
    buried: 'impassable',
    landslide: 'impassable',
    obstructed: 'impassable',
  }
  const candidate = ALIASES[raw] || raw
  return ROAD_PASSABILITY.includes(candidate) ? candidate : null
}

function normalizeConflictEvent(row, source) {
  const latitude = toNumber(row.latitude ?? row.lat)
  const longitude = toNumber(row.longitude ?? row.lon ?? row.lng)
  const eventDate = row.event_date || row.date || row.occurred_at
  if (!eventDate) return null
  const id = row.id || stableId('conflict', [source, row.event_id_cnty, row.source_id, row.title, eventDate, latitude, longitude])
  // ACLED exports always carry event_id_cnty, but the documented lite format
  // (event_date, event_type, latitude, longitude, country, fatalities, title)
  // has no identifier column at all. Leaving source_id null there meant every
  // lite upload quarantined on `required_fields` — a guard that condemns the
  // one format we document. Minting it from the same fields the id is minted
  // from costs nothing and keeps the row citable; the flag says it came from us
  // rather than the operator, so nobody reads it as an upstream key.
  const upstreamId = row.event_id_cnty || row.source_id || row.id || null
  return {
    id,
    source,
    source_id: upstreamId || id,
    source_id_minted: !upstreamId,
    event_type: row.event_type || row.type || 'conflict_event',
    sub_event_type: row.sub_event_type || null,
    severity: normalizeSeverity(toNumber(row.fatalities, 0) > 10 ? 'high' : toNumber(row.fatalities, 0) > 0 ? 'medium' : row.severity),
    title: row.title || row.notes || row.event_type || 'Conflict event',
    description: row.description || row.notes || '',
    occurred_at: new Date(eventDate).toISOString(),
    country: row.country_code || row.country || null,
    admin1: row.admin1 || null,
    latitude,
    longitude,
    fatalities: toNumber(row.fatalities, 0),
    actor1: row.actor1 || null,
    actor2: row.actor2 || null,
    metadata: {
      importer: source,
      license: source === 'acled_csv' ? 'user_supplied_acled_license' : 'user_supplied',
    },
  }
}
