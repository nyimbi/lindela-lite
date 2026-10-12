/**
 * ENH-60 — the ambient-layer family, out of the dispatcher.
 *
 * Three reads that feed the map overlay and the climate page: the raw
 * observation series, the per-district weather roll-up, and the latest modelled
 * river discharge per region. They are one family because they are the routes a
 * *partner* reads rather than the browser — the overlay bands what it draws
 * itself, so a JSON consumer is the one who sees a bare number and has to know
 * where the operational thresholds begin.
 *
 * That is the property the family holds, and it is the ARC-05 class three times:
 *
 *   - `weather` carries a `band` per forecast day and a `temperature_band` plus
 *     `condition_label` on the current block, with the cut points published once
 *     in `precip_bands` / `temp_bands` so a consumer can audit the boundaries
 *     without reading this repository.
 *   - `river-discharge` carries the band, its label and its severity beside the
 *     figure, and `model_note` states that the series is modelled rather than
 *     gauged. `band_max_m3s` is null when the number was reported but no band
 *     matched — a different state from "no reading", and the route says so.
 *   - `climate` is the raw series, paged, because a caller that wants the
 *     banded view wants `river-discharge` or `weather` and a caller that wants
 *     the record wants this.
 *
 * `river-discharge` rolls a full daily series to one current point per region,
 * so the overlay can draw it like the other ambient layers. No records at all is
 * normal on a fresh deployment, and the route answers an empty array with a
 * `note` rather than a 404.
 */

import { districtWeatherReport } from '../connectors/open-meteo-forecast.js'
import { DISCHARGE_BANDS, DISCHARGE_MODEL_NOTE, dischargeBand } from '../../public/shared/discharge-bands.js'
import { PRECIP_BANDS, TEMP_BANDS, precipBand, tempBand, weatherCodeLabel } from '../../public/shared/weather-bands.js'
import { collectionPage } from '../utils.js'

/**
 * Which ambient-layer route a request is, or null.
 *
 * All three are reads, so the matcher refuses everything but GET — the VER-14
 * class, applied at the point of extraction rather than found by the next sweep.
 * `check-openapi.mjs` reads this body, so the paths are discoverable without a
 * second list.
 */
export function matchAmbientRoute(pathname, method = 'GET') {
  if (method !== 'GET') return null
  if (pathname === '/api/v1/climate') return { kind: 'climate' }
  if (pathname === '/api/v1/weather') return { kind: 'weather' }
  if (pathname === '/api/v1/river-discharge') return { kind: 'river-discharge' }
  return null
}

/** The band table, published so a consumer can audit the cut points. */
const bandTable = (bands) => bands.map((b) => ({
  key: b.key,
  label: b.label,
  severity: b.severity,
  max_mm: Number.isFinite(b.max) ? b.max : null,
}))

/**
 * Handle one ambient-layer route. Returns true when it handled the request.
 */
export function handleAmbientRoute(route, { data, req, res, url, jsonResponse }) {
  const { kind } = route

  if (kind === 'climate') {
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(data.climate_observations, url.searchParams, {
        auth: req.__auth, data, collection: 'climate_observations',
      }),
    })
    return true
  }

  if (kind === 'weather') {
    // The map overlay's roll-up: per pilot district, one current reading and the
    // 7-day daily forecast, each batch-stamped with the forecast's issue time.
    // Not paged — five districts, seven days each, is a fixed small payload, and
    // `districtWeatherReport` states the absence of data rather than answering
    // with an empty page that reads as "no weather".
    const report = districtWeatherReport(data.weather_forecasts || [])
    jsonResponse(res, 200, {
      success: true,
      ...report,
      districts: report.districts.map((district) => ({
        ...district,
        current: district.current
          ? {
            ...district.current,
            temperature_band: tempBand(district.current.temperature_c)?.key || null,
            condition_label: weatherCodeLabel(district.current.weather_code),
          }
          : null,
        forecast: (district.forecast || []).map((day) => ({
          ...day,
          band: precipBand(day.precipitation_mm)?.key || null,
          band_label: precipBand(day.precipitation_mm)?.label || null,
        })),
      })),
      precip_bands: bandTable(PRECIP_BANDS),
      temp_bands: TEMP_BANDS.map((b) => ({ key: b.key, label: b.label, max_c: Number.isFinite(b.max) ? b.max : null })),
    })
    return true
  }

  if (kind === 'river-discharge') {
    // Latest non-null daily river discharge per region from the GloFAS model.
    const note = 'Modelled river discharge from GloFAS; not gauged observations.'
    const records = (data.climate_observations || []).filter((r) => r.source === 'open_meteo_flood')
    if (!records.length) {
      jsonResponse(res, 200, { success: true, data: [], as_of: null, note })
      return true
    }

    const latestByRegion = new Map()
    for (const record of records) {
      const days = Array.isArray(record.daily) ? record.daily : []
      let latest = null
      for (const day of days) {
        if (!day || !Number.isFinite(day.river_discharge_m3s)) continue
        if (!latest || day.date > latest.date) latest = day
      }
      if (!latest) continue
      const existing = latestByRegion.get(record.region_name)
      // The tiebreak is the discharge, not the insertion order: two records for
      // one region on the same day is a re-ingest, and the later one is not
      // necessarily the higher reading.
      //
      // The comparison reads `existing.as_of`, which is the field this map
      // stores. It read `existing.date` — a field the stored object has never
      // had — so both date comparisons were against `undefined` and always
      // false, and the map kept whichever record for a region arrived first.
      // `test/river-discharge.test.js:94` asserts the higher value wins and
      // passed anyway, because its two Mandera records are ordered 250 then 180:
      // the bug and the fixture agreed by luck. The tiebreak below is now the
      // behaviour the route has always claimed.
      if (
        !existing
        || latest.date > existing.as_of
        || (latest.date === existing.as_of && latest.river_discharge_m3s > existing.river_discharge_m3s)
      ) {
        latestByRegion.set(record.region_name, {
          region_name: record.region_name,
          latitude: record.latitude,
          longitude: record.longitude,
          river_discharge_m3s: latest.river_discharge_m3s,
          as_of: latest.date,
          model_limit: record.metadata?.model_limit ?? null,
        })
      }
    }

    const items = [...latestByRegion.values()]
      .sort((a, b) => String(a.region_name).localeCompare(String(b.region_name)))
    let asOf = null
    for (const item of items) {
      if (!asOf || item.as_of > asOf) asOf = item.as_of
    }
    const withBand = items.map((item) => {
      const band = dischargeBand(item.river_discharge_m3s)
      return {
        ...item,
        band: band?.key || 'unknown',
        band_label: band?.label || null,
        severity: band?.severity || 'ungraded',
        // Null when the band is unknown: the number was reported but no band
        // matched, which is a different state from "no reading".
        band_max_m3s: band && Number.isFinite(band.max) ? band.max : null,
      }
    })
    jsonResponse(res, 200, {
      success: true,
      data: withBand,
      as_of: asOf,
      note,
      model_note: DISCHARGE_MODEL_NOTE,
      bands: DISCHARGE_BANDS.map((b) => ({
        key: b.key, label: b.label, severity: b.severity,
        max_m3s: Number.isFinite(b.max) ? b.max : null,
      })),
    })
    return true
  }

  return false
}
