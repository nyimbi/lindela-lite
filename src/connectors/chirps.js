import { fetchWithRetry } from './http.js'
import { stableId } from '../utils.js'

const INDEX_URL = 'https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05/'
const FILE_PATTERN = /chirps-v2\.0\.(\d{4}\.\d{2}\.\d{2})\.tif(?:\.gz)?/g
const YEAR_DIR_PATTERN = />(\d{4})\/</g

/**
 * CHIRPS-2.0 daily precipitation, UCSB CHC.
 *
 * Keyless public dataset index (no account, no licence gate).
 *
 * Layout note, verified 2026-10-01: the product root no longer lists files
 * directly. It lists one directory per year (1981 through the current year),
 * each containing the daily .tif.gz files. An earlier version matched
 * filenames on the root listing and therefore returned zero records while
 * reporting no error — the connector looked healthy and ingested nothing.
 * So the index is walked one level down, and a year directory that yields no
 * filenames is recorded as an error rather than silently skipped.
 *
 * What this connector reports: the availability and dates of daily CHIRPS
 * precipitation rasters at 0.05 degrees. It does NOT read pixel values — the
 * rasters are gzip-compressed GeoTIFF, and decoding them is not something to
 * do without a raster library. Every observation therefore carries
 * `precipitation_mm: null` and `type: rainfall_dataset_available`.
 *
 * This is a limitation worth stating plainly: this connector tells you what
 * data exists and where to get it, not what fell. Anything that needs actual
 * rainfall numbers must state which source it used.
 */
export const chirpsConnector = {
  id: 'chirps',
  async ingest(options = {}) {
    const climate_observations = []
    const errors = []
    const indexUrl = options.chirps_index_url || INDEX_URL
    const retries = options.retries ?? 2
    const timeoutMs = options.timeout_ms || 20000
    // Only the most recent years need probing: the walk is for finding recent
    // daily files, not building a catalogue of the whole archive.
    const maxYears = Number.isFinite(options.chirps_years) ? Number(options.chirps_years) : 2

    try {
      const html = await fetchWithRetry(indexUrl, { timeoutMs, retries, parse: 'text' })
      const years = [...new Set([...html.matchAll(YEAR_DIR_PATTERN)].map((m) => m[1]))]
        .sort()
        .reverse()
        .slice(0, maxYears)

      if (!years.length) {
        errors.push('chirps: product index lists no year directories; upstream layout may have changed again')
        return { climate_observations, errors }
      }

      let probed = 0
      let filesFound = 0

      for (const year of years) {
        let yearHtml
        try {
          yearHtml = await fetchWithRetry(`${indexUrl.replace(/\/$/, '')}/${year}/`, { timeoutMs, retries, parse: 'text' })
        } catch (error) {
          errors.push(`chirps: ${year} directory unreadable: ${error.message}`)
          continue
        }
        probed += 1

        const dates = [...new Set([...yearHtml.matchAll(FILE_PATTERN)].map((m) => m[1]))].sort().reverse()
        filesFound += dates.length

        for (const date of dates) {
          climate_observations.push({
            id: stableId('climate', ['chirps', date]),
            source: 'chirps',
            type: 'rainfall_dataset_available',
            region_name: 'global',
            country: null,
            latitude: null,
            longitude: null,
            observed_at: date.replaceAll('.', '-'),
            // Null because this connector does not decode raster pixels. A
            // reader seeing a null must not infer "no rainfall".
            precipitation_mm: null,
            metadata: {
              provider: 'UCSB CHC CHIRPS',
              dataset: 'CHIRPS-2.0 global daily p05',
              resolution: '0.05_degree',
              source_url: indexUrl,
              file_url: `${indexUrl.replace(/\/$/, '')}/${year}/chirps-v2.0.${date}.tif.gz`,
              values_included: false,
              values_note: 'This connector reports dataset availability and dates, not pixel values. The rasters are gzip-compressed GeoTIFF and are not decoded here.',
            },
          })
        }
      }

      if (probed && !filesFound) {
        errors.push(`chirps: probed ${probed} year director${probed === 1 ? 'y' : 'ies'} but found no daily files; expected files named chirps-v2.0.YYYY.MM.DD.tif.gz`)
      }
    } catch (error) {
      errors.push(`chirps: ${error.message}`)
    }

    // Keep only the most recent requested number of dates.
    const limit = options.limit || 30
    return { climate_observations: climate_observations.slice(0, limit), errors }
  },
}