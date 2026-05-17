import { stableId } from '../utils.js'

const INDEX_URL = 'https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05/'
const FILE_PATTERN = /chirps-v2\.0\.(\d{4}\.\d{2}\.\d{2})\.tif(?:\.gz)?/g

export const chirpsConnector = {
  id: 'chirps',
  async ingest(options = {}) {
    const climate_observations = []
    const errors = []
    try {
      const response = await fetch(options.chirps_index_url || INDEX_URL, { signal: AbortSignal.timeout(options.timeout_ms || 20000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const html = await response.text()
      const dates = [...new Set([...html.matchAll(FILE_PATTERN)].map((match) => match[1]))].sort().reverse()
      for (const date of dates.slice(0, options.limit || 30)) {
        climate_observations.push({
          id: stableId('climate', ['chirps', date]),
          source: 'chirps',
          type: 'rainfall_dataset_available',
          region_name: 'global',
          country: null,
          latitude: null,
          longitude: null,
          observed_at: date.replaceAll('.', '-'),
          precipitation_mm: null,
          metadata: {
            provider: 'UCSB CHC CHIRPS',
            dataset: 'CHIRPS-2.0 global daily p05',
            resolution: '0.05_degree',
            source_url: options.chirps_index_url || INDEX_URL,
          },
        })
      }
    } catch (error) {
      errors.push(error.message)
    }
    return { climate_observations, errors }
  },
}
