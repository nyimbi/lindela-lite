import { fetchWithRetry } from './http.js'
import { normalizeSeverity } from '../schema.js'
import { numericOrNull } from '../analytics/numeric.js'
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
    // FIRMS requires a MAP_KEY obtained by email signup
    // (firms.modaps.eosdis.nasa.gov/api/map_key). There is no keyless access,
    // and there never was an "OPEN_KEY" sentinel that works — verified
    // 2026-10-01, the API answers HTTP 400 "Invalid MAP_KEY." for it. Sending
    // the placeholder produced three identical HTTP 400s per run while the
    // catalog claimed requires_credentials: false, so the source looked
    // healthy and keyless when it was neither.
    const key = options.nasa_firms_key || process.env.NASA_FIRMS_MAP_KEY
    if (!key) {
      errors.push(
        'nasa_firms: NASA_FIRMS_MAP_KEY is not set. FIRMS requires a free MAP_KEY '
        + '(sign up at firms.modaps.eosdis.nasa.gov/api/map_key); there is no keyless access. '
        + 'This source will report 0 records until a key is configured.',
      )
      return { hazard_events, errors }
    }

    const regions = options.firms_bboxes?.length ? options.firms_bboxes : REGIONAL_BBOXES
    // `Math.min(Math.max(Number(x || 1), 1), 10)` clamps a *number*, and `NaN`
    // survives both bounds — every comparison against it is false, so `abc`
    // fell through and the URL was built with the literal `NaN` where the day
    // count belongs: `/…/{bbox}/NaN`. FIRMS answers that with a 400, the
    // connector records an error, and a typo in a schedule's options reads as a
    // source outage. `toNumber` reads an unreadable value as absent, which is
    // what the clamp already assumes it is.
    const days = Math.min(Math.max(toNumber(options.days, 1), 1), 10)
    // A row dropped for having no date is a detection the source reported and
    // this run did not. Counted rather than swallowed: an operator comparing
    // "what FIRMS said it had" against "what arrived" needs the difference to
    // be a number, and a silent `continue` makes it unanswerable.
    let undated = 0

    for (const region of regions) {
      try {
        const url = AREA_CSV.replace('{key}', key).replace('{bbox}', region.bbox).replace('{days}', String(days))
        const rows = parseCsv(await fetchWithRetry(url, { timeoutMs: options.timeout_ms || 30000, retries: options.retries ?? 2, source: options.source }))
        for (const row of rows) {
          const lat = toNumber(row.latitude)
          const lon = toNumber(row.longitude)
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
          // A detection with no acquisition date used to be stamped with today,
          // which put it at the top of every "recent fire activity" query and
          // inside every freshness window — a row the provider could not date
          // reading as the newest thing on the map. The date is what a fire
          // detection is *for*, so an undated row is dropped the same way a row
          // with unreadable coordinates is, rather than given one.
          if (!row.acq_date) { undated += 1; continue }
          // A blank FRP is not a 0 MW fire. `toNumber(row.frp, 0)` graded a
          // blank, a whitespace cell and `'abc'` as 0, which the severity ladder
          // reads as `low` and the title announces as "(0 MW FRP)" — an
          // unmeasured detection published as a measured faint one. The record
          // is kept because the detection is real (position, date and satellite
          // are all present and the coordinate assertion checks them), with
          // `frp: null` and an ungraded severity. `severityWeight(null)` is
          // below every measured level, so it contributes less rather than
          // standing in for a reading.
          const frp = numericOrNull(row.frp)
          hazard_events.push({
            id: stableId('hazard', ['nasa_firms', row.latitude, row.longitude, row.acq_date, row.acq_time, row.satellite]),
            source: 'nasa_firms',
            source_id: `${row.satellite || 'viirs'}:${row.acq_date}:${row.acq_time}:${lat}:${lon}`,
            event_type: 'fire',
            severity: frp === null ? null : normalizeSeverity(frp > 100 ? 'high' : frp > 25 ? 'medium' : 'low'),
            title: frp === null ? 'Active fire detection (FRP not reported)' : `Active fire detection (${frp} MW FRP)`,
            description: `VIIRS active fire detection from NASA FIRMS.`,
            occurred_at: `${row.acq_date}T${String(row.acq_time || '0000').padStart(4, '0').slice(0, 2)}:${String(row.acq_time || '0000').padStart(4, '0').slice(2, 4)}:00Z`,
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
    // An undated row means the CSV shape changed, not that the fires were
    // undated: `acq_date` is a column FIRMS always fills. Reported as an error
    // line so the run reads `degraded` — the same treatment `dhis2` gives a
    // skipped reading — rather than a clean run with a smaller count.
    if (undated > 0) {
      errors.push(`nasa_firms: ${undated} detection(s) carried no acq_date and were dropped; FIRMS always fills that column, so the response shape has changed.`)
    }
    return { hazard_events, errors }
  },
}
