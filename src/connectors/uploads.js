import { SERVICE_TYPES, normalizeSeverity } from '../schema.js'
import { parseCsv, stableId, toNumber } from '../utils.js'

export const serviceAssetsConnector = {
  id: 'service_assets',
  async ingest(options = {}) {
    const provided = options.service_assets || []
    const service_assets = Array.isArray(provided) ? provided.map(normalizeServiceAsset).filter(Boolean) : []
    return { service_assets, errors: [] }
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

function normalizeServiceAsset(asset) {
  const latitude = toNumber(asset.latitude ?? asset.lat)
  const longitude = toNumber(asset.longitude ?? asset.lon ?? asset.lng)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const service_type = SERVICE_TYPES.includes(asset.service_type || asset.type) ? (asset.service_type || asset.type) : 'other'
  return {
    id: asset.id || stableId('asset', [asset.name, service_type, latitude, longitude]),
    source: 'service_assets',
    name: asset.name || `${service_type} asset`,
    service_type,
    status: asset.status || 'unknown',
    country: asset.country || null,
    admin1: asset.admin1 || null,
    latitude,
    longitude,
    capacity: toNumber(asset.capacity),
    updated_at: asset.updated_at || new Date().toISOString(),
    metadata: asset.metadata || {},
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
