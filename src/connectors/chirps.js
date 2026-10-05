import { fetchWithRetry } from './http.js'
import { stableId } from '../utils.js'
import { assessPagination, completenessVerdictName, recordCap } from '../completeness.js'

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
 *
 * It also reports what the walk cost. `.slice(0, limit)` used to drop up to 700
 * of 730 daily files with nothing in the return value saying so, and the
 * dropped files were indistinguishable from days with no rainfall product at
 * all. The completeness block is that missing evidence. Note what it measures:
 * the count of files the index offered against the count this run kept. It
 * never needs a pixel reader for that, because "how many rasters exist" is a
 * property of the directory listing, not of the pixels inside them. Decoding
 * pixels would be a different question — did we read every value in every file —
 * and one this connector cannot answer, which `values_included: false` on each
 * record already says out loud.
 */


/**
 * What the walk found, what it kept, and whether the gap between them is
 * recorded anywhere.
 *
 * `counts_found` is the pre-cap count — the number of daily files the probed
 * year directories actually offered. It is `null`, not `0`, when nothing was
 * found and no cap bound, because "we looked and there was nothing" and "we
 * never looked" are different claims and this repo has paid for conflating
 * them once already.
 */
function chirpsCompleteness({ found, kept, limit, pagesFetched }) {
  const cap = recordCap({
    found,
    taken: kept.length,
    cap: limit,
    reason: `chirps keeps the ${limit} most recent dates and drops the rest`,
  })

  const lastPageFull = kept.length >= limit
  const verdict = assessPagination({
    pagesFetched,
    recordsSeen: kept.length,
    // The index is a directory listing, not a paginated API, so there is no
    // provider page size. The cap is the only bound on a run.
    pageSize: limit,
    // Nothing to be full, strictly: what can come back full is the retained
    // slice, and a slice filled to its limit is the shape that means "there
    // may have been more behind this".
    lastPageFull,
    // The CHIRPS index declares no total — it is an HTML listing of hrefs — so
    // the only expectation available is the connector's own count of it, and
    // it is passed only when records were actually dropped. `expectedTotal`
    // is the module's fallback for a provider that reports nothing, and it
    // yields a counted shortfall rather than a guess.
    expectedTotal: found > kept.length ? found : null,
  })

  return {
    ...verdict,
    // recordCap's count, not assessPagination's: this connector's question is
    // how much was dropped, so the pre-cap number is the one that answers it.
    counts_found: cap.counts_found,
    records_kept: cap.records,
    cap: limit,
    capped: cap.capped,
    cap_reason: cap.cap_reason,
    pages_fetched: pagesFetched,
    provider_total: null,
    last_page_full: lastPageFull,
  }
}

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
    // Keep only the most recent requested number of dates.
    const limit = options.limit || 30
    let probed = 0

    /**
     * The single exit, so no path returns records without the accounting.
     * A truncated walk also leaves a line in `errors`, because that is the one
     * channel `runIngestion` carries from a connector's return value into the
     * source run's own record — without it the verdict is returned to a direct
     * caller and then dropped on the floor by the pipeline that actually runs
     * this connector.
     */
    const finish = (records) => {
      const kept = records.slice(0, limit)
      const completeness = chirpsCompleteness({ found: records.length, kept, limit, pagesFetched: probed })
      if (!completeness.complete) {
        errors.push(`chirps: walk is ${completenessVerdictName(completeness)} — ${completeness.reason}`)
      }
      return { climate_observations: kept, errors, completeness }
    }

    try {
      const html = await fetchWithRetry(indexUrl, { timeoutMs, retries, parse: 'text', source: options.source })
      const years = [...new Set([...html.matchAll(YEAR_DIR_PATTERN)].map((m) => m[1]))]
        .sort()
        .reverse()
        .slice(0, maxYears)

      if (!years.length) {
        errors.push('chirps: product index lists no year directories; upstream layout may have changed again')
        return finish([])
      }

      let filesFound = 0

      for (const year of years) {
        let yearHtml
        try {
          yearHtml = await fetchWithRetry(`${indexUrl.replace(/\/$/, '')}/${year}/`, { timeoutMs, retries, parse: 'text', source: options.source })
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

    return finish(climate_observations)
  },
}