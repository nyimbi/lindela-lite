/**
 * ENH-09 — the store side of the agreement check.
 *
 * `src/agreement.js` is the statistics: two series of numbers in, a verdict on
 * whether they tell the same story out. It knows nothing about this store, and
 * that is exactly why it had no production caller for as long as it did — the
 * missing half was the part that knows what a `climate_observations` record
 * looks like, which of its `source` values are two measurements of the *same*
 * rain, and how a daily series becomes the monthly one a correlation can be
 * computed over. That is this module, and it is the whole distance between a
 * tested engine and a verdict anybody can read.
 *
 * **Which sources are compared, and which are refused by name.** The engine's
 * own vocabulary is `COMPARABLE_PRODUCTS = ['chirps', 'era5', 'gauge']`, so a
 * source outside it is not folded in on a guess. `climate_observations` also
 * carries a forecast (`open_meteo`), a discharge series (`open_meteo_flood`), a
 * basin-wide SST index (`noaa_enso`) and mapped DHIS2 data elements — and every
 * one of those would produce a `disputed` verdict that means something other
 * than "two products measured the same rain differently". A forecast that
 * missed, a river that rose and a Pacific that warmed are three different
 * findings, and publishing any of them as source disagreement would put a
 * confident wrong answer where ENH-09's value is supposed to be. So
 * `sources_ignored` names each source with its reason: the omission is a
 * statement a reader can act on, not a gap they have to notice.
 *
 * **Months, and why a thin one is dropped rather than scaled.** The engine
 * correlates across months, so the daily records have to become monthly totals
 * first. Summing `precipitation_mm` is correct along the time axis and wrong
 * across space — the aggregation registry says so, and the marker below says
 * which axis this is. A month a source reported three days of is the trap: its
 * total is a tenth of the truth, and correlating it against a complete month
 * manufactures disagreement out of a coverage gap. Such a month is dropped, so
 * it arrives at the engine as a month that source did not report — which is
 * what `unmatched_months` and `only_in_a` are for. Scaling it up instead would
 * invent rainfall, and this repository does not publish invented measurements.
 */

import { AGREEMENT_THRESHOLDS, COMPARABLE_PRODUCTS, agreementReport, compareSeries } from './agreement.js'

/**
 * The sources that are a comparable rainfall product, and the product each one
 * is.
 *
 * The right-hand side is the engine's vocabulary, not a second one:
 * `open_meteo_archive` is ERA5 reanalysis — its own metadata says so — and it
 * is spelled `era5` here because that is the name `COMPARABLE_PRODUCTS` uses.
 * `gauge` maps to itself for an uploaded series that carries the name; no
 * connector writes one today, and the entry exists so that a store which gains
 * one does not need this table edited to be compared.
 */
export const PRODUCT_SOURCES = Object.freeze({
  chirps: 'chirps',
  open_meteo_archive: 'era5',
  gauge: 'gauge',
})

/**
 * Sources that land in `climate_observations` and are not a rainfall product.
 *
 * Each reason names what the source *is*, because "not comparable" on its own
 * reads as an oversight. A source absent from both tables gets the generic
 * reason below, which asks for a decision rather than assuming one.
 */
export const IGNORED_SOURCES = Object.freeze({
  open_meteo: 'a forecast, not an observation — comparing it against CHIRPS measures whether the forecast was right, which is forecast skill and not whether two products measured the same rain',
  open_meteo_flood: 'river discharge, not rainfall — every record carries precipitation_mm: null and the series is in m3/s',
  noaa_enso: 'a basin-wide equatorial Pacific SST index with no region_name and no precipitation, so it cannot be attributed to a region at all',
  dhis2: 'mapped DHIS2 data elements — a data element is not necessarily a rain gauge, and its unit is declared per mapping, so folding it in would put an unlabelled quantity into a rainfall comparison',
})

/** What an undeclared source is told, so the omission is actionable. */
const UNKNOWN_SOURCE_REASON = 'not declared as a comparable rainfall product; add it to PRODUCT_SOURCES with the product it is, or to IGNORED_SOURCES with the reason it is not'

/**
 * How much of a month a source must have reported before its total is usable.
 *
 * Not a taste: below this the monthly total is a fraction of the real one, and
 * a fraction correlated against a whole is a disagreement the weather did not
 * have. The floor travels in the payload so a reader can see which months it
 * cost them.
 */
export const MIN_MONTH_COVERAGE = 0.8

/** A day count is a count of days, and a month's length is not a constant. */
function daysInMonth(key) {
  const [year, month] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** `YYYY-MM` from a timestamp, or null when the value states no month. */
function monthOf(value) {
  const key = String(value ?? '').slice(0, 7)
  return /^\d{4}-\d{2}$/.test(key) ? key : null
}

/**
 * The daily points a record carries, whichever of the two shapes it is.
 *
 * `open_meteo_archive` writes one record per region holding the whole daily
 * array; CHIRPS writes one record per region per day. Both are legitimate and
 * both have to reach the same monthly series, so the shape is normalised here
 * rather than at two call sites.
 */
function dailyPoints(record) {
  if (Array.isArray(record?.daily)) {
    const out = []
    for (const day of record.daily) {
      const date = String(day?.date ?? '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      out.push({ date, mm: day?.precipitation_mm })
    }
    return out
  }
  const date = String(record?.observed_at ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  return [{ date, mm: record?.precipitation_mm }]
}

/**
 * One source's records for one region, as monthly totals.
 *
 * Returns the series the engine consumes plus the two counts that explain what
 * it is missing: months dropped for thin coverage, and days whose value was not
 * a rainfall measurement. The second exists because the CHIRPS nodata sentinel
 * is −9999 and a negative day silently *subtracts* from a month's total — a
 * defect that would arrive at the correlation as a plausible-looking number
 * rather than as an error.
 */
export function monthlySeries(records = []) {
  const byMonth = new Map()
  let implausibleDays = 0

  for (const record of records) {
    for (const point of dailyPoints(record)) {
      const key = point.date.slice(0, 7)
      if (!byMonth.has(key)) byMonth.set(key, new Map())
      const month = byMonth.get(key)
      // First writer wins, the same rule `indexByPeriod` applies: a duplicated
      // day inside one source is a defect in that source, and averaging it away
      // here would hide the defect behind a plausible total.
      if (month.has(point.date)) continue
      const mm = point.mm === null || point.mm === undefined ? null : Number(point.mm)
      if (mm !== null && (!Number.isFinite(mm) || mm < 0)) {
        implausibleDays += 1
        month.set(point.date, null)
        continue
      }
      month.set(point.date, mm)
    }
  }

  const series = []
  const thinMonths = []
  for (const key of [...byMonth.keys()].sort()) {
    const measured = [...byMonth.get(key).values()].filter((value) => value !== null)
    if (measured.length < Math.ceil(daysInMonth(key) * MIN_MONTH_COVERAGE)) {
      thinMonths.push(key)
      continue
    }
    // aggregation-ok: rainfall accumulates along the *time* axis — 20 mm on each
    // of five consecutive days at one point is 100 mm of rain, while 20 mm at
    // each of five stations is one storm reported five times. This sums days
    // within one region and one source, so the time axis is the axis, and
    // `aggregationKindFor('precipitation_mm', { axis: 'time' })` says the same.
    series.push({ period: key, precipitation_mm: measured.reduce((sum, value) => sum + value, 0) })
  }

  return {
    series,
    thin_months: thinMonths,
    implausible_days: implausibleDays,
    reported_days: [...byMonth.values()].reduce((total, month) => total + month.size, 0),
  }
}

/** The verdict tally, so a region whose pairs all refused cannot read as clean. */
function tallyVerdicts(comparisons) {
  return comparisons.reduce((acc, comparison) => {
    acc[comparison.verdict] = (acc[comparison.verdict] || 0) + 1
    return acc
  }, {})
}

/**
 * Every unordered pair of the products present, in a stable order.
 *
 * Sorted rather than taken as found, because a `product_a`/`product_b`
 * assignment that follows insertion order makes the same comparison read
 * differently between two runs over the same store.
 */
function pairsOf(products) {
  const sorted = [...products].sort()
  const out = []
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) out.push([sorted[i], sorted[j]])
  }
  return out
}

/**
 * The whole payload: one row per region that has a comparable product.
 *
 * The comparison window is a calendar year. `compareSeries` takes a `period`
 * that labels the window and correlates *across* the months inside it, so a
 * year is the unit that makes "these two products rank the months the same way"
 * a question with an answer — a season's cycle stays inside one window, and
 * `disputed_months` names the years a disagreement was found in rather than
 * blending a decade into one number nobody can act on.
 *
 * A region with fewer than two products gets a row anyway, carrying the reason
 * it could not be compared. Dropping it would make "this region is missing from
 * the list" the only signal, and the two things that causes — one product
 * ingested, and no product at all — are different operational problems.
 */
export function sourceAgreement(data = {}) {
  const records = (data.climate_observations || []).filter((record) => !record?.deleted_at)

  const byRegion = new Map()
  const ignored = new Map()
  let unattributed = 0

  for (const record of records) {
    const source = String(record?.source ?? 'unknown')
    if (!PRODUCT_SOURCES[source]) {
      const entry = ignored.get(source) || { source, records: 0, reason: IGNORED_SOURCES[source] || UNKNOWN_SOURCE_REASON }
      entry.records += 1
      ignored.set(source, entry)
      continue
    }
    const region = String(record?.region_name ?? '').trim()
    // A comparable product with no region cannot be paired against anything,
    // and attributing it by proximity is how a point reading becomes a claim
    // about a district. Counted and stated rather than placed.
    if (!region) { unattributed += 1; continue }
    if (!byRegion.has(region)) byRegion.set(region, new Map())
    const products = byRegion.get(region)
    if (!products.has(PRODUCT_SOURCES[source])) products.set(PRODUCT_SOURCES[source], [])
    products.get(PRODUCT_SOURCES[source]).push(record)
  }

  const rows = []
  for (const region of [...byRegion.keys()].sort()) {
    const products = byRegion.get(region)
    const names = [...products.keys()].sort()
    const series = new Map()
    const coverage = {}
    for (const name of names) {
      const built = monthlySeries(products.get(name))
      series.set(name, built.series)
      coverage[name] = { months: built.series.length, thin_months: built.thin_months, implausible_days: built.implausible_days, reported_days: built.reported_days }
    }

    const comparisons = []
    for (const [productA, productB] of pairsOf(names)) {
      const seriesA = series.get(productA)
      const seriesB = series.get(productB)
      const years = [...new Set([...seriesA, ...seriesB].map((record) => record.period.slice(0, 4)))].sort()
      for (const year of years) {
        comparisons.push(compareSeries({
          district: region,
          period: year,
          productA,
          productB,
          recordsA: seriesA.filter((record) => record.period.startsWith(year)),
          recordsB: seriesB.filter((record) => record.period.startsWith(year)),
        }))
      }
    }

    const report = agreementReport(comparisons, { district: region })
    rows.push({
      region_name: region,
      district: region,
      products_present: names,
      pairs_compared: new Set(comparisons.map((comparison) => `${comparison.product_a}|${comparison.product_b}`)).size,
      // Over every pair-year, `unavailable` included. `report.periods_compared`
      // counts only the usable ones, so a region where nothing could be
      // compared would otherwise show an empty tally and read as healthy.
      verdicts: tallyVerdicts(comparisons),
      coverage,
      // Null when there was something to compare. When there was not, the
      // engine cannot say why — it was handed no usable comparison — so the
      // reason a human needs is written here rather than left to be inferred
      // from two zeroes. The condition is the *usable* count, not the row count:
      // two products that each reported a different year produce two rows and
      // nothing comparable, and a reason keyed on `comparisons.length` would go
      // missing in exactly that case.
      refusal_reason: report.periods_compared
        ? null
        : names.length < 2
          ? `only one comparable rainfall product is present in this region (${names.join(', ') || 'none'}); agreement is a statement about two`
          : 'the products present share no month that both reported, so there is no comparison to make',
      report,
    })
  }

  return {
    regions: rows.length,
    // No `returned`: this route has no filter, so a second count equal to the
    // first would be a number that can only ever agree.
    refused: rows.filter((row) => row.report.periods_compared === 0).length,
    // The declarations, in the payload. Which sources count as products, what
    // was skipped and why, and the thresholds the verdicts were read against —
    // a threshold a reader cannot see is a threshold they cannot argue with.
    products: PRODUCT_SOURCES,
    comparable_products: COMPARABLE_PRODUCTS,
    sources_ignored: [...ignored.values()].sort((a, b) => a.source.localeCompare(b.source)),
    unattributed_records: unattributed,
    min_month_coverage: MIN_MONTH_COVERAGE,
    thresholds: AGREEMENT_THRESHOLDS,
    data: rows,
  }
}
