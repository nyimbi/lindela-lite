import { fetchWithRetry } from './http.js'
import { normalizeSeverity } from '../schema.js'
import { parseCsv, stableId, toNumber } from '../utils.js'

const AREA_CSV = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_SNPP_NRT/{bbox}/{days}'
const REGIONAL_BBOXES = [
  { name: 'East Africa / Horn', bbox: '33,-5,52,15', country: 'KE' },
  { name: 'Central Africa', bbox: '15,-5,35,10', country: 'CD' },
  { name: 'Sahel / West', bbox: '-15,5,15,25', country: 'ML' },
]

export const nasaFirmsConnector = {
  id: 'nasa_firms',
  async ingest(options = {}) {
    const hazard_events = []
    const errors = []
    const key = options.nasa_firms_key || process.env.NASA_FIRMS_MAP_KEY || 'OPEN_KEY'
    const regions = options.firms_bboxes?.length ? options.firms_bboxes : REGIONAL_BBOXES
    const days = Math.min(Math.max(Number(options.days || 1), 1), 10)

    for (const region of regions) {
      try {
        const url = AREA_CSV.replace('{key}', key).replace('{bbox}', region.bbox).replace('{days}', String(days))
        const rows = parseCsv(await fetchWithRetry(url, { timeoutMs: options.timeout_ms || 30000, retries: options.retries ?? 2 }))
        for (const row of rows) {
          const lat = toNumber(row.latitude)
          const lon = toNumber(row.longitude)
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
          const frp = toNumber(row.frp, 0)
          hazard_events.push({
            id: stableId('hazard', ['nasa_firms', row.latitude, row.longitude, row.acq_date, row.acq_time, row.satellite]),
            source: 'nasa_firms',
            source_id: `${row.satellite || 'viirs'}:${row.acq_date}:${row.acq_time}:${lat}:${lon}`,
            event_type: 'fire',
            severity: normalizeSeverity(frp > 100 ? 'high' : frp > 25 ? 'medium' : 'low'),
            title: `Active fire detection (${frp || 0} MW FRP)`,
            description: `VIIRS active fire detection from NASA FIRMS.`,
            occurred_at: `${row.acq_date || new Date().toISOString().slice(0, 10)}T${String(row.acq_time || '0000').padStart(4, '0').slice(0, 2)}:${String(row.acq_time || '0000').padStart(4, '0').slice(2, 4)}:00Z`,
            source_url: 'https://firms.modaps.eosdis.nasa.gov/',
            country: region.country,
            latitude: lat,
            longitude: lon,
            metadata: {
              provider: 'NASA FIRMS',
              brightness: toNumber(row.brightness),
              confidence: row.confidence,
              frp,
              region: region.name,
            },
          })
        }
      } catch (error) {
        errors.push(`${region.name}: ${error.message}`)
      }
    }
    return { hazard_events, errors }
  },
}
