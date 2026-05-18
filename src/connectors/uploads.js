import { SERVICE_TYPES, normalizeSeverity } from '../schema.js'
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
      updated_at: asset.updated_at || new Date().toISOString(),
      metadata: asset.metadata || {},
    },
  }
}

function normalizeConflictEvent(row, source) {
  const latitude = toNumber(row.latitude ?? row.lat)
  const longitude = toNumber(row.longitude ?? row.lon ?? row.lng)
  const eventDate = row.event_date || row.date || row.occurred_at
  if (!eventDate) return null
  return {
    id: row.id || stableId('conflict', [source, row.event_id_cnty, row.source_id, row.title, eventDate, latitude, longitude]),
    source,
    source_id: row.event_id_cnty || row.source_id || row.id || null,
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
