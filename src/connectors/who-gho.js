import { fetchWithRetry } from './http.js'
import { stableId, toNumber } from '../utils.js'
import { defineConnector } from './spec.js'

/**
 * WHO Global Health Observatory outbreak-relevant indicators (OData, keyless).
 *
 * Verified live on 2026-10-02 at:
 *   https://ghoapi.azureedge.net/api/CHOLERA_0000000001?$format=json&$top=2&$orderby=TimeDim desc
 *
 * What this deliberately is:
 * - national-annual context. Every indicator below reports with
 *   SpatialDimType COUNTRY and TimeDimType YEAR. That is the source's own
 *   granularity, and this project's operational grain is districts — so the
 *   records carry coordinates null, never pretend to district evidence, and
 *   say so at every level. National cholera totals are situational context,
 *   not district triage input.
 * - relay, not analysis. Case counts are stored verbatim with their indicator
 *   codes and years. No trend, incidence rate, or risk score is derived here
 *   — the store has no denominators or reporting-quality metadata, and an
 *   invented rate would look surveillance-grade while being neither.
 *
 * Series freshness varies per indicator and is not uniform (probed 2026-10-02):
 * measles and yellow fever run to 2025; the cholera and meningitis series end
 * at 2016 and 2014 respectively. A series that has stopped publishing is not
 * a current outbreak signal, and the summary therefore marks an indicator
 * stale when its latest year lags the calendar rather than letting an old
 * count sit next to fresh ones looking current.
 *
 * Why no `$filter` and no `$orderby`: the GHO OData endpoint accepts a
 * `$filter` on TimeDim and answers 200 with zero rows, and accepts
 * `$orderby=TimeDim desc` and silently ignores it (probed 2026-10-02 — the
 * "top" rows were 2016 in arbitrary order while the series runs to 2025).
 * Both would have filtered or trimmed records invisibly. The connector fetches
 * the full series and selects the recent window in this process, which fails
 * loudly instead.
 *
 * What this deliberately is not, and had to be decided before the code:
 * - not a surveillance product. Outbreak numbers can move funding flows and
 *   operational prioritisation, and can stigmatise districts even when the
 *   rows themselves are national aggregates. These records therefore carry a
 *   policy note in the API: decision-support context, attribution required
 *   per WHO data terms.
 * - no subnational claims. The keyless data that would match the operational
 *   need (subnational, near-real-time) is not available; ReliefWeb's report
 *   API needs a registered appname (403 keyless, verified 2026-10-02), and
 *   WHO Disease Outbreak News publishes no machine-readable feed (scoping
 *   checked 2026-10-01).
 */

const GHO_ROOT = 'https://ghoapi.azureedge.net/api'

/**
 * Outbreak-relevant indicators, codes verified live on 2026-10-02 via the
 * Indicator endpoint. The unit belongs to the row here so a report cannot
 * misread deaths as cases.
 */
const INDICATORS = Object.freeze([
  { code: 'CHOLERA_0000000001', name: 'Number of reported cases of cholera', unit: 'cases' },
  { code: 'CHOLERA_0000000002', name: 'Number of reported deaths from cholera', unit: 'deaths' },
  { code: 'CHOLERA_0000000003', name: 'Cholera case fatality rate', unit: 'ratio' },
  { code: 'MENING_2', name: 'Number of suspected meningitis cases reported', unit: 'cases' },
  { code: 'MENING_3', name: 'Number of meningitis epidemic districts', unit: 'districts' },
  { code: 'WHS3_62', name: 'Measles - number of reported cases', unit: 'cases' },
  { code: 'WHS3_50', name: 'Yellow fever - number of reported cases', unit: 'cases' },
  { code: 'WHS3_52', name: 'Plague - number of reported cases', unit: 'cases' },
])

export const WHO_GHO_INDICATORS = INDICATORS

export function buildIndicatorUrl(code) {
  // No $orderby (silently ignored by this endpoint) and no $filter (silently
  // returns empty) and no $top (anything above 1000 is rejected with HTTP
  // 400, while omitting it returns the full series — probed 2026-10-02). The
  // full series comes back and the recent window is selected in this process,
  // where the failure mode is visible instead of silent.
  return `${GHO_ROOT}/${code}?$format=json`
}

async function connectorIngest(options = {}) {
  const disease_observations = []
  const errors = []
  const indicators = options.gho_indicators?.length
    ? INDICATORS.filter((indicator) => options.gho_indicators.includes(indicator.code))
    : INDICATORS
  const currentYear = new Date().getUTCFullYear()
  const minYear = Number.isFinite(options.gho_min_year) ? Number(options.gho_min_year) : currentYear - 5

  for (const indicator of indicators) {
    try {
      const text = await fetchWithRetry(buildIndicatorUrl(indicator.code), {
        timeoutMs: options.timeout_ms || 20000,
        retries: options.retries ?? 2,
        parse: 'text',
        source: options.source,
      })
      const payload = JSON.parse(text)
      const rows = Array.isArray(payload.value) ? payload.value : []
      if (!rows.length) {
        // OData answered but gave nothing: distinguishable from a network
        // failure only because it's recorded here rather than swallowed.
        errors.push(`who_gho: ${indicator.code} returned 0 rows`)
        continue
      }

      let kept = 0
      let maxRowYear = 0
      for (const row of rows) {
        // Non-country aggregates (WHO_REGION, GLOBAL) would double-count
        // countries already counted in the set.
        if (row.SpatialDimType !== 'COUNTRY') continue
        const year = Number(row.TimeDim)
        if (!Number.isInteger(year)) continue
        if (year > maxRowYear) maxRowYear = year
        if (year < minYear) continue
        const value = toNumber(row.NumericValue)
        if (value === null || value === undefined) continue

        disease_observations.push({
          id: stableId('disease', [indicator.code, row.SpatialDim, year]),
          source: 'who_gho',
          source_id: `${indicator.code}:${row.SpatialDim}:${year}`,
          // National aggregate: there is no geography finer than the country
          // in the source, and nothing here may invent one.
          latitude: null,
          longitude: null,
          indicator_code: indicator.code,
          indicator_name: row.IndicatorName || indicator.name,
          unit: indicator.unit,
          country: row.SpatialDim,
          region: row.ParentLocation || null,
          year,
          value,
          first_seen_source_type: 'national_annual_aggregate',
          observed_at: `${year}-01-01T00:00:00.000Z`,
          metadata: {
            provider: 'WHO Global Health Observatory',
            attribution_required: true,
            attribution: 'WHO Global Health Observatory, ghoapi.azureedge.net; use with attribution, per WHO data terms',
            granularity: 'COUNTRY, YEAR',
            granularity_note: 'National annual aggregate. This platform works at district level: the value is context for what surveillance says about a country, not evidence about any district, water point, or route.',
            policy_note: 'Outbreak figures can move funding flows, operational prioritisation and stigmatise affected areas. Treat as decision-support context with attribution; not an alert trigger, not an automated determination.',
            value_note: indicator.unit === 'ratio'
              ? 'Case fatality rate: deaths per reported cases, as published (0-1).'
              : null,
            reported_not_observed: 'Reported figures reflect national surveillance reporting quality; silence may mean absence of reporting, not absence of disease.',
            model_limit: 'National annual counts relayed verbatim; no rates, trends or risk scores are derived because no denominators or reporting quality metadata are available',
            fetched_at: new Date().toISOString(),
          },
        })
        kept += 1
      }
      // A series wholly older than the window is expected staleness (cholera
      // ends at 2016), flagged by the summary, not an ingest failure. Only a
      // series that had recent rows and kept none of them means the row
      // layout actually changed.
      if (!kept && maxRowYear >= minYear) {
        errors.push(`who_gho: ${indicator.code} has rows at or newer than ${minYear} but none were kept as country/annual/numeric — the indicator layout may have changed`)
      }
    } catch (error) {
      errors.push(`who_gho: ${indicator.code}: ${error.message}`)
    }
  }

  return { disease_observations, errors }
}

export function parseWhoRows(payload) {
  return Array.isArray(payload?.value) ? payload.value : []
}

/**
 * Roll-up for dashboards: latest year per indicator per country, plus an
 * explicit staleness verdict per indicator. "Latest" by year, not row order,
 * because two ingestions can leave last year's total and this year's in
 * either order.
 */
export function summarizeDiseaseObservations(records) {
  const byKey = new Map()
  for (const record of records) {
    const key = `${record.indicator_code}:${record.country}`
    const existing = byKey.get(key)
    if (!existing || record.year > existing.year) byKey.set(key, record)
  }
  const rows = [...byKey.values()]

  // An indicator can simply stop publishing (cholera ended at 2016, verified).
  // The gap is the findable fact: latest year per indicator anywhere in the
  // store, judged against the calendar, stated rather than averaged over.
  const latestPerIndicator = new Map()
  for (const record of rows) {
    const seen = latestPerIndicator.get(record.indicator_code) || 0
    if (record.year > seen) latestPerIndicator.set(record.indicator_code, record.year)
  }
  const currentYear = new Date().getUTCFullYear()
  const series_state = [...latestPerIndicator.entries()].map(([code, year]) => {
    const lag = currentYear - year
    const indicator = INDICATORS.find((item) => item.code === code)
    return {
      indicator_code: code,
      indicator_name: indicator?.name || code,
      latest_year: year,
      years_behind_calendar: lag,
      // Two calendar years of lag is the line where a national annual count
      // stops being a "current" signal. This is a statement about publication,
      // not disease: no recent rows can also mean WHO stopped collecting.
      state: lag <= 1 ? 'current' : lag <= 4 ? 'aging' : 'stale',
      note: lag > 1
        ? `The WHO series for this indicator ends ${year}; absence of recent rows means absence of published data, not absence of disease.`
        : null,
    }
  })

  return {
    generated_at: new Date().toISOString(),
    granularity: 'National annual aggregates (WHO GHO). Context only: not district evidence, not surveillance.',
    attribution: 'WHO Global Health Observatory; use with attribution, per WHO data terms.',
    series_state,
    latest_by_indicator_country: rows
      .sort((a, b) => String(a.country).localeCompare(String(b.country)) || String(a.indicator_code).localeCompare(String(b.indicator_code)))
      .map((record) => ({
        country: record.country,
        indicator_code: record.indicator_code,
        indicator_name: record.indicator_name,
        year: record.year,
        value: record.value,
        unit: record.unit,
      })),
  }
}

export const spec = defineConnector({
  id: 'who_gho',
  description: 'WHO Global Health Observatory outbreak-relevant indicators (cholera, meningitis, measles, yellow fever, plague); national-annual aggregates, keyless OData',
  schema: {
    requestSchema: {
      gho_indicators: 'array of WHO GHO indicator codes to restrict to (default the outbreak set)',
      gho_min_year: 'number (default 5 years back) - earliest publication year to keep',
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      disease_observations: 'array of national-annual outbreak indicator records; coordinates null by construction',
    },
  },
  defaults: {
    rateLimit: { perMinute: 30 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  source: 'WHO Global Health Observatory',
  license: 'WHO data: use with attribution, per WHO data terms',
  ingest: connectorIngest,
})

export const whoGhoConnector = spec