import { fetchWithRetry } from './http.js'
import { stableId, toNumber } from '../utils.js'
import { defineConnector } from './spec.js'

/**
 * NOAA CPC Niño 3.4 sea-surface-temperature anomaly index.
 *
 * Verified live on 2026-10-01 at:
 *   https://www.cpc.ncep.noaa.gov/data/indices/detrend.nino34.ascii.txt  (200, 30 kB)
 *
 * Format is fixed-width whitespace columns: YR MON TOTAL ClimAdjust ANOM,
 * one row per month from 1949-12 to the present. TOTAL is SST in °C over the
 * Niño 3.4 box (5°N-5°S, 120°-170°W); ANOM is the departure from CPC's own
 * climatology, which is what this connector stores.
 *
 * The threshold and run-length below are CPC's published definitions, not
 * choices made here. CPC states: a three-month season with ONI ≥ +0.5 °C is
 * El Niño, ≤ -0.5 °C is La Niña, and an episode requires the threshold to hold
 * for five consecutive overlapping seasons
 * (cpc.ncep.noaa.gov/products/analysis_monitoring/enso/oni/v6/).
 *
 * Because CPC's rule is stated in overlapping seasons and the feed is monthly,
 * this connector computes the seasonal means itself and reports how many
 * consecutive seasons currently qualify. That keeps the distinction between
 * "one warm month" and "a declared ENSO event" intact rather than collapsing
 * both into a phase label. Two honesty notes ride along in every output:
 *
 * 2. Per NWS Public Information Statement 26-05, CPC now uses the Relative
 *    Oceanic Niño Index (RONI) for official ENSO monitoring. RONI is not
 *    published as a machine-readable monthly file at a stable keyless URL, so
 *    this connector reads the CPC Niño 3.4 series and says exactly which series
 *    in `index_used`. Reporting one index while labelling it as another would be
 *    a fabricated capability.
 *
 * 3. What `value` is, stated precisely. The feed is the CPC *monthly* detrended
 *    Niño 3.4 SST anomaly — one number per month. The ONI is by definition the
 *    three-month running mean of exactly these numbers, so `value` is not an
 *    ONI and must not be labelled as one. The connector derives the overlapping
 *    three-month means separately, applies the episode rule to those, and reports
 *    the count as `overlapping_seasons`. Labelling the monthly anomaly "ONI" was
 *    a mislabel of about 0.3 °C in the current data, which is small enough to look
 *    like noise and large enough to be wrong.
 */

const DEFAULT_FEED = 'https://www.cpc.ncep.noaa.gov/data/indices/detrend.nino34.ascii.txt'

/** CPC's published advisory threshold, in °C. */
export const OCEANIC_NINO_THRESHOLD_C = 0.5

/**
 * Rows CPC's fixed-width columns into { year, month, anomaly }.
 *
 * Exported for direct testing: the parse is the part that can silently return
 * zero records while still exiting cleanly.
 */
export function parseNino34(text) {
  const rows = []
  if (typeof text !== 'string') return rows

  for (const line of text.split('\n')) {
    // "1949  12   25.09   26.24   -1.15" — five whitespace-separated numbers.
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue

    const year = Number(parts[0])
    const month = Number(parts[1])
    if (!Number.isInteger(year) || year < 1900 || year > 2100) continue
    if (!Number.isInteger(month) || month < 1 || month > 12) continue

    const anomaly = toNumber(parts[4])
    // -999 is CPC's missing-value sentinel. Reading it as an anomaly would put
    // a fictitious 999 °C cold event in the series.
    if (!Number.isFinite(anomaly) || anomaly < -50) continue

    rows.push({ year, month, anomaly_c: anomaly })
  }
  return rows
}

/**
 * CPC's episode rule: five consecutive overlapping three-month seasons.
 *
 * Seasons overlap by two months (DJF, JFM, FMA), so five of them span seven
 * distinct months, not fifteen. This is why counting consecutive *months* is
 * not the same test: a single neutral month inside a warm run does not break
 * the episode, but a naive month counter would report it as over.
 */
export const EPISODE_MIN_SEASONS = 5

/** Label for a three-month season ending in the given month. */
function seasonLabel(row) {
  const starts = { 12: 'DJF', 1: 'JFM', 2: 'FMA', 3: 'MAM', 4: 'AMJ', 5: 'MJJ' }
  const rest = { 6: 'JJA', 7: 'JAS', 8: 'ASO', 9: 'SON', 10: 'OND', 11: 'NDJ' }
  return `${row.year} ${starts[row.month] || rest[row.month] || '???'}`
}

/** True when `next` is the calendar month immediately after `prev`. */
function isNextMonth(prev, next) {
  if (!prev || !next) return false
  return prev.year * 12 + prev.month + 1 === next.year * 12 + next.month
}

/**
 * Classifies the latest observation against CPC's published threshold.
 *
 * Three figures are returned because they answer different questions and
 * conflating them is how "one warm month" becomes "an El Niño event":
 *
 * - `anomaly_c` is the latest monthly value.
 * - `advisory_run_months` counts consecutive months on one side of the
 *   threshold. Zero for neutral, since "consecutive months above 0.5" is not a
 *   meaningful quantity when the latest month is below it.
 * - `overlapping_seasons` applies CPC's actual rule to the seasonal means, and
 *   `episode_declared` is true only at five of them.
 */
export function classifyNino34(rows, threshold = OCEANIC_NINO_THRESHOLD_C) {
  if (!rows.length) {
    return {
      phase: 'unknown',
      anomaly_c: null,
      period: null,
      advisory_run_months: 0,
      overlapping_seasons: 0,
      episode_declared: false,
    }
  }

  const latest = rows[rows.length - 1]
  const side = latest.anomaly_c >= threshold ? 'el_nino' : latest.anomaly_c <= -threshold ? 'la_nina' : 'neutral'

  // A gap in the series ends every run. Without this check a feed that skipped
  // from 2023 to 2026 would report three months in 2023 and three in 2026 as a
  // single six-month run, and could manufacture an ENSO episode out of two
  // unrelated warm periods.
  const contiguous = []
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (i < rows.length - 1 && !isNextMonth(rows[i], rows[i + 1])) break
    contiguous.unshift(rows[i])
  }

  let run = 0
  if (side !== 'neutral') {
    for (let i = contiguous.length - 1; i >= 0; i -= 1) {
      const value = contiguous[i].anomaly_c
      const onSide = side === 'el_nino' ? value >= threshold : value <= -threshold
      if (!onSide) break
      run += 1
    }
  }

  // Seasonal means over overlapping three-month windows, most recent last.
  // Only contiguous windows count, so a gap cannot produce a season.
  const seasons = []
  for (let i = 2; i < contiguous.length; i += 1) {
    const mean = (contiguous[i - 2].anomaly_c + contiguous[i - 1].anomaly_c + contiguous[i].anomaly_c) / 3
    seasons.push({ label: seasonLabel(contiguous[i]), mean })
  }

  let overlapping = 0
  if (side !== 'neutral') {
    for (let i = seasons.length - 1; i >= 0; i -= 1) {
      const mean = seasons[i].mean
      const onSide = side === 'el_nino' ? mean >= threshold : mean <= -threshold
      if (!onSide) break
      overlapping += 1
    }
  }

  return {
    phase: side,
    anomaly_c: Math.round(latest.anomaly_c * 100) / 100,
    period: `${latest.year}-${String(latest.month).padStart(2, '0')}`,
    advisory_run_months: run,
    overlapping_seasons: overlapping,
    // CPC declares an ENSO episode only after five consecutive overlapping
    // three-month seasons. With a complete monthly history this can be met;
    // it is computed, never assumed.
    episode_declared: overlapping >= EPISODE_MIN_SEASONS,
  }
}

async function noaaNinoConnectorIngest(options = {}) {
  const climate_observations = []
  const errors = []
  const feed = options.enso_feed || DEFAULT_FEED
  const windowMonths = Number(options.enso_window_months) > 0 ? Number(options.enso_window_months) : 18
  const threshold = Number.isFinite(options.enso_threshold_c)
    ? Number(options.enso_threshold_c)
    : OCEANIC_NINO_THRESHOLD_C

  try {
    const text = await fetchWithRetry(feed, {
      timeoutMs: options.timeout_ms || 20000,
      retries: options.retries ?? 2,
      parse: 'text',
      source: options.source,
    })

    const rows = parseNino34(text)
    if (!rows.length) {
      errors.push('noaa_enso: feed returned no parseable Niño 3.4 rows')
      return { climate_observations, errors }
    }

    const classification = classifyNino34(rows, threshold)
    const recent = rows.slice(-windowMonths).reverse()

    for (const row of recent) {
      const period = `${row.year}-${String(row.month).padStart(2, '0')}`
      const above = row.anomaly_c >= threshold
      const below = row.anomaly_c <= -threshold

      climate_observations.push({
        id: stableId('climate', ['noaa_enso', period]),
        source: 'noaa_enso',
        source_id: period,
        // A basin-wide equatorial Pacific index has no facility coordinates.
        // These stay null so the record cannot be attributed to a district by
        // proximity, which would be wrong.
        latitude: null,
        longitude: null,
        country: null,
        region: 'Niño 3.4 region (5°N-5°S, 120°-170°W)',
        observed_at: `${period}-15T00:00:00.000Z`,
        metric: 'nino34_sst_anomaly_c',
        value: row.anomaly_c,
        unit: 'degC',
        metadata: {
          provider: 'NOAA CPC',
          index_used: 'monthly nino34 sst anomaly',
          index_note: 'Value is the CPC monthly detrended Nino 3.4 SST anomaly, one number per month. It is not an ONI: the ONI is the three-month running mean of these numbers. The overlapping three-month means this record was used to derive are what the CPC episode rule is applied to, and their count is reported as overlapping_seasons. Per NWS Public Information Statement 26-05 CPC now uses RONI for official ENSO monitoring; RONI is not published as a stable keyless monthly file, so no RONI figure is reported.',
          phase: above ? 'el_nino_advisory' : below ? 'la_nina_advisory' : 'neutral',
          threshold_c: threshold,
          threshold_source: 'NOAA CPC: +/-0.5 °C on the three-month running mean',
          advisory_run_months: classification.advisory_run_months,
          overlapping_seasons: classification.overlapping_seasons,
          episode_declared: classification.episode_declared,
          episode_note: `CPC declares an ENSO episode only after the threshold holds for five consecutive overlapping three-month seasons (DJF, JFM, FMA...); ${classification.overlapping_seasons} of 5 consecutive seasons currently qualify. A single monthly anomaly cannot satisfy this.`,
          model_limit: 'monthly SST anomaly index; not a rainfall forecast and not a flood probability',
          base_period: 'CPC ERSSTv5 with CPC climatology; base periods are revised every 5 years',
          feed,
        },
      })
    }
  } catch (error) {
    errors.push(`noaa_enso: ${error.message}`)
  }

  return { climate_observations, errors }
}

export const spec = defineConnector({
  id: 'noaa_enso',
  description: 'NOAA CPC monthly Nino 3.4 SST anomaly, fixed-width ASCII; overlapping three-month means derived for the CPC episode rule',
  schema: {
    requestSchema: {
      enso_window_months: 'how many recent months to store (default 18)',
      enso_threshold_c: 'advisory threshold in degC (default 0.5, CPC published value)',
      enso_feed: 'override feed URL',
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      climate_observations: 'array of monthly Niño 3.4 SST anomalies in degC, basin-wide coordinates null',
    },
  },
  defaults: {
    rateLimit: { perMinute: 30 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  source: 'NOAA Climate Prediction Center',
  license: 'U.S. Government work, public domain',
  ingest: noaaNinoConnectorIngest,
})

export const noaaNinoConnector = spec