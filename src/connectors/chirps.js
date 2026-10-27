import { gunzipSync } from 'node:zlib'
import { fetchWithRetry } from './http.js'
import { decodeGeoTiff, sampleAt } from '../geotiff.js'
import { DEFAULT_REGIONS } from '../schema.js'
import { stableId, toNumber } from '../utils.js'
import { assessPagination, completenessVerdictName, recordCap } from '../completeness.js'

const INDEX_URL = 'https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05/'
const FILE_PATTERN = /chirps-v2\.0\.(\d{4}\.\d{2}\.\d{2})\.tif(?:\.gz)?/g
const YEAR_DIR_PATTERN = />(\d{4})\/</g

/**
 * CHIRPS nodata, by convention rather than declaration.
 *
 * The daily p05 files carry no `GDAL_NODATA` tag — verified against the live
 * bytes and recorded in `docs/research/chirps-geotiff/README.md` — so the
 * reader cannot resolve it and this connector has to state it. The value is
 * confirmed empirically: the leading cells of row 0, which are ocean at 50N
 * near the antimeridian, are exactly -9999.0.
 */
const CHIRPS_NODATA = -9999

/**
 * CHIRPS-2.0 daily precipitation, UCSB CHC.
 *
 * Keyless public dataset index (no account, no licence gate). Public domain
 * (CC0); the CHC asks for the Funk et al. 2014 citation, which is in
 * `sources/INDEX.md`.
 *
 * Layout note, verified 2026-10-01: the product root no longer lists files
 * directly. It lists one directory per year (1981 through the current year),
 * each containing the daily .tif.gz files. An earlier version matched
 * filenames on the root listing and therefore returned zero records while
 * reporting no error — the connector looked healthy and ingested nothing.
 * So the index is walked one level down, and a year directory that yields no
 * filenames is recorded as an error rather than silently skipped.
 *
 * **It reads pixels.** Until 2026-10-14 this connector reported only which
 * daily rasters exist, on the reasoning that decoding gzip-compressed GeoTIFF
 * needs a raster library. `src/geotiff.js` removed that reason, and with it the
 * limitation that made the records unjoinable: every observation carried
 * `precipitation_mm: null` and `region_name: 'global'`, so nothing could be
 * paired against a region's Open-Meteo series and `src/agreement.js` had no
 * production caller. Each record is now one region on one day with a real
 * millimetre figure, and `source: 'chirps'` beside `source: 'open_meteo'` is
 * what makes the two comparable.
 *
 * Reading pixels means downloading the raster, not listing its name — ~3 MB a
 * day, up to ~11 MB on wet-season days, against 57.6 MB uncompressed. So the
 * number of rasters decoded per run is capped (`chirps_days`) and the cap is
 * reported in the completeness block, the same way the listing cap already is.
 * A run that decodes fewer days than the index offered says so; it does not
 * quietly become a run over a shorter window.
 *
 * Every failure is a named refusal on the record, never a silent 0. A decode
 * that fails, a coordinate outside the raster's 50S-50N extent, a nodata cell
 * under a region — each leaves `precipitation_mm: null` with `values_note`
 * saying which, because a reader seeing a null must not infer "no rainfall".
 *
 * It also reports what the walk cost. `.slice(0, limit)` used to drop up to 700
 * of 730 daily files with nothing in the return value saying so, and the
 * dropped files were indistinguishable from days with no rainfall product at
 * all. The completeness block is that missing evidence.
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
function chirpsCompleteness({ found, datesKept, limit, pagesFetched }) {
  const cap = recordCap({
    found,
    taken: datesKept,
    cap: limit,
    reason: `chirps keeps the ${limit} most recent dates and drops the rest`,
  })

  const lastPageFull = datesKept >= limit
  const verdict = assessPagination({
    pagesFetched,
    recordsSeen: datesKept,
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
    expectedTotal: found > datesKept ? found : null,
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
    //
    // `options.limit || 30` kept any truthy value, and the cap is compared as
    // `datesKept >= limit`. A schedule whose `default_options` said `"limit":
    // "30"` — a string, which is what a JSON form field produces — made every
    // comparison false, so the cap did not bind at all and the walk kept every
    // date the index offered: the one bound on a run that downloads multi-MB
    // rasters, switched off by a quoting mistake. `-5` did the opposite and kept
    // nothing, and `0` fell through to the default while `-5` fell through to
    // nothing, so two spellings of "none" behaved differently.
    //
    // Absent, unreadable and non-positive all take the default. Defaulting is
    // the safe direction — the cap applies — where the old coercion let the
    // unreadable case remove it entirely.
    const requestedLimit = toNumber(options.limit, 30)
    const limit = requestedLimit > 0 ? requestedLimit : 30
    // Decoding is on by default. It is switchable because a caller that only
    // wants the availability census should not pay ~3 MB a day for it, but the
    // default has to be the useful one — an off-by-default reader is the state
    // this connector was just moved out of.
    const readValues = options.chirps_read_values !== false
    // A raster is ~3 MB, up to ~11 MB on a wet day, so the number of days
    // decoded is its own bound, separate from the listing cap. Small by
    // default: the agreement route needs a handful of paired days to say
    // anything, and an operator raising it should be doing so deliberately.
    const decodeCap = Number.isFinite(options.chirps_days) ? Number(options.chirps_days) : 3
    const regions = options.chirps_regions || DEFAULT_REGIONS
    let probed = 0
    let decoded = 0
    let decodeAttempts = 0
    let decodeFailures = 0
    // Declared outside the try: the single exit reads them, and a walk that
    // threw halfway still has to report what it had counted by then.
    let filesFound = 0
    // Dates this run took a record for, against dates the index offered. The
    // cap is applied per date rather than by slicing the records, so the two
    // counts stay in the same unit.
    let datesKept = 0

    /**
     * The single exit, so no path returns records without the accounting.
     * A truncated walk also leaves a line in `errors`, because that is the one
     * channel `runIngestion` carries from a connector's return value into the
     * source run's own record — without it the verdict is returned to a direct
     * caller and then dropped on the floor by the pipeline that actually runs
     * this connector.
     */
    const finish = (records, datesFound, datesKept) => {
      const completeness = chirpsCompleteness({
        found: datesFound,
        // The listing cap counts *dates*, not records. One date now yields one
        // record per region, so a cap read off `records.length` would mean a
        // different window depending on how many regions were configured —
        // 30 days at three regions would silently become a 10-day cap.
        datesKept,
        limit,
        pagesFetched: probed,
      })
      // The decode cap is a second, independent bound, and it has to reach the
      // return value for the same reason the listing cap does: a run that read
      // three days out of thirty looks identical to a run over a three-day
      // window unless the shortfall is stated.
      completeness.days_decoded = decoded
      completeness.decode_cap = readValues ? decodeCap : 0
      completeness.decode_failures = decodeFailures
      if (readValues && decodeFailures > 0) {
        errors.push(`chirps: ${decodeFailures} raster${decodeFailures === 1 ? '' : 's'} failed to decode; affected records carry precipitation_mm: null with values_note saying why`)
      }
      if (!completeness.complete) {
        errors.push(`chirps: walk is ${completenessVerdictName(completeness)} — ${completeness.reason}`)
      }
      return { climate_observations: records, errors, completeness }
    }

    /**
     * One record for one region on one day.
     *
     * `sampled` is `sampleAt`'s result or null when the raster was never
     * fetched. The two null paths are kept apart on purpose: "the value is
     * missing because we did not look" and "because the cell is nodata" are
     * different findings, and collapsing them would make a dry day and a
     * skipped download read the same.
     */
    const recordFor = (region, date, fileUrl, sampled) => {
      const hasValue = sampled !== null && sampled.value !== null
      return {
        id: stableId('climate', ['chirps', region.name, date]),
        source: 'chirps',
        // The type still says what the record is. A region-day carrying a
        // millimetre figure is a rainfall observation, not merely a notice that
        // a file exists, and the assertion set distinguishes them.
        type: hasValue ? 'rainfall_observation' : 'rainfall_dataset_available',
        region_name: region.name,
        country: region.country,
        latitude: region.lat,
        longitude: region.lon,
        observed_at: date.replaceAll('.', '-'),
        precipitation_mm: hasValue ? sampled.value : null,
        metadata: {
          provider: 'UCSB CHC CHIRPS',
          dataset: 'CHIRPS-2.0 global daily p05',
          resolution: '0.05_degree',
          source_url: indexUrl,
          file_url: fileUrl,
          values_included: hasValue,
          values_note: valuesNote(sampled, readValues),
        },
      }
    }

    try {
      const html = await fetchWithRetry(indexUrl, { timeoutMs, retries, parse: 'text', source: options.source })
      const years = [...new Set([...html.matchAll(YEAR_DIR_PATTERN)].map((m) => m[1]))]
        .sort()
        .reverse()
        .slice(0, maxYears)

      if (!years.length) {
        errors.push('chirps: product index lists no year directories; upstream layout may have changed again')
        return finish([], 0, 0)
      }

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
          if (datesKept >= limit) continue
          datesKept += 1
          const fileUrl = `${indexUrl.replace(/\/$/, '')}/${year}/chirps-v2.0.${date}.tif.gz`
          // Decode the most recent `decodeCap` dates only; older ones keep the
          // availability shape. The cap is counted across years, not per year,
          // so a two-year walk does not silently double the transfer budget.
          if (!readValues || decodeAttempts >= decodeCap) {
            for (const region of regions) {
              climate_observations.push(recordFor(region, date, fileUrl, null))
            }
            continue
          }

          // Counted before the fetch, not after. A cap on *successes* would let
          // a source serving undecodable rasters pull every date the index
          // lists — the bound that matters is the transfer, and the transfer
          // happens whether or not the bytes turn out to be a TIFF.
          decodeAttempts += 1
          let raster = null
          try {
            const gz = await fetchWithRetry(fileUrl, { timeoutMs, retries, parse: 'buffer', source: options.source })
            raster = decodeGeoTiff(gunzipSync(gz), { nodata: CHIRPS_NODATA })
            decoded += 1
          } catch (error) {
            // Named, not silent. The records still go out — a date whose raster
            // failed to decode is still a date the index offered — but every
            // one of them says on its face that the value is missing and why.
            decodeFailures += 1
            errors.push(`chirps: ${date} raster unreadable: ${error.message}`)
          }

          for (const region of regions) {
            climate_observations.push(recordFor(region, date, fileUrl, raster === null ? null : sampleAt(raster, region.lat, region.lon)))
          }
        }
      }

      if (probed && !filesFound) {
        errors.push(`chirps: probed ${probed} year director${probed === 1 ? 'y' : 'ies'} but found no daily files; expected files named chirps-v2.0.YYYY.MM.DD.tif.gz`)
      }
    } catch (error) {
      errors.push(`chirps: ${error.message}`)
    }

    return finish(climate_observations, filesFound, datesKept)
  },
}

/**
 * Why a record holds the value it does, in the record's own words.
 *
 * The four cases are the four things that can happen, and each names itself:
 * a sampled value, a nodata cell, a point outside the raster, and a raster
 * never fetched. None of them is "no rainfall" — that is `precipitation_mm: 0`,
 * which is a fifth case and reads as a number.
 */
function valuesNote(sampled, readValues) {
  if (!readValues) {
    return 'Pixel decoding was switched off for this run (chirps_read_values: false); the record reports that the raster exists and when.'
  }
  if (sampled === null) {
    return 'The raster was not fetched or did not decode, so this record carries no value. A null here is not zero rainfall; see the run errors for the reason.'
  }
  if (sampled.reason === 'nodata') {
    return 'The grid cell under this region holds CHIRPS nodata (-9999), which is ocean or outside the product extent, not a dry day.'
  }
  if (sampled.reason === 'outside_grid') {
    return 'This region falls outside the CHIRPS 50S-50N extent, so the raster cannot answer for it.'
  }
  if (sampled.reason !== null) {
    return `The raster could not be sampled at this region (${sampled.reason}).`
  }
  return 'Sampled from the CHIRPS daily p05 GeoTIFF at the region centre, nearest cell.'
}
