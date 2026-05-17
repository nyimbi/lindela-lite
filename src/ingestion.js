import { BLOCKED_SOURCE_IDS, SOURCE_IDS } from './schema.js'
import { nowIso, stableId } from './utils.js'
import { openMeteoConnector } from './connectors/open-meteo.js'
import { gdacsConnector } from './connectors/gdacs.js'
import { glofasConnector } from './connectors/glofas.js'
import { chirpsConnector } from './connectors/chirps.js'
import { nasaFirmsConnector } from './connectors/nasa-firms.js'
import { acledCsvConnector, conflictCsvConnector, serviceAssetsConnector } from './connectors/uploads.js'

const CONNECTORS = Object.freeze({
  open_meteo: openMeteoConnector,
  gdacs: gdacsConnector,
  glofas: glofasConnector,
  chirps: chirpsConnector,
  nasa_firms: nasaFirmsConnector,
  service_assets: serviceAssetsConnector,
  acled_csv: acledCsvConnector,
  conflict_csv: conflictCsvConnector,
})

export function getConnector(sourceId) {
  if (BLOCKED_SOURCE_IDS.includes(sourceId)) {
    throw new Error(`${sourceId} ingestion is intentionally excluded from Lindela Lite`)
  }
  const connector = CONNECTORS[sourceId]
  if (!connector) throw new Error(`Unknown source: ${sourceId}`)
  return connector
}

export async function runIngestion(store, request = {}) {
  const requestedSources = request.sources?.length ? request.sources : ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms', 'service_assets', 'conflict_csv']
  for (const source of requestedSources) {
    if (BLOCKED_SOURCE_IDS.includes(source)) {
      throw new Error(`${source} ingestion is intentionally excluded from Lindela Lite`)
    }
    if (!SOURCE_IDS.includes(source)) throw new Error(`Unknown source: ${source}`)
  }

  const source_runs = []
  const merged = {
    climate_observations: [],
    hazard_events: [],
    conflict_events: [],
    service_assets: [],
  }

  for (const source of requestedSources) {
    const startedAt = nowIso()
    const connector = getConnector(source)
    let status = 'success'
    let errors = []
    let output = {}
    try {
      output = await connector.ingest(request)
      errors = output.errors || []
      if (errors.length && countRecords(output) === 0) status = 'degraded'
    } catch (error) {
      status = 'failed'
      errors = [error.message]
    }

    for (const key of Object.keys(merged)) {
      merged[key].push(...(output[key] || []))
    }

    source_runs.push({
      id: stableId('run', [source, startedAt, status, errors]),
      source,
      status,
      started_at: startedAt,
      completed_at: nowIso(),
      records_processed: countRecords(output),
      errors,
    })
  }

  const data = await store.merge({ ...merged, source_runs })
  return {
    source_runs,
    counts: {
      climate_observations: merged.climate_observations.length,
      hazard_events: merged.hazard_events.length,
      conflict_events: merged.conflict_events.length,
      service_assets: merged.service_assets.length,
    },
    data,
  }
}

function countRecords(output) {
  return ['climate_observations', 'hazard_events', 'conflict_events', 'service_assets']
    .reduce((total, key) => total + (output?.[key]?.length || 0), 0)
}
