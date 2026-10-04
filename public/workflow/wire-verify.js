// =============================================================
// Lindela Lite — ENH-21 wiring: forecast against outcome
// =============================================================
// A probability is a claim about how often something is right. Nothing in the
// console ever checked one, because checking needs two records where there is
// normally one: the forecast made for a day, and what actually fell on it. This
// module joins them on region and day through `pairForecasts`, bins the result
// with `reliability`, and draws `reliabilityDiagram` — **when there is anything
// to draw**.
//
// **The honest case is the common one.** The Open-Meteo connector files a
// seven-day forecast; the archive connector that would supply the outcome for
// those days has usually not run over the same window. So the pairs this finds
// are mostly `pending` (the day has not happened yet) or `no_outcome` (the day
// happened and nothing recorded it). Those are counted and named on the panel,
// and no diagram is drawn, because a reliability diagram over zero verified
// pairs is a chart of nothing wearing the clothes of a chart of calibration.
//
// The threshold is 0.1 mm, because that is the question the forecast answers:
// `precipitation_probability_max` is the probability that precipitation occurs,
// not that it exceeds a depth. Stating the threshold next to the diagram is part
// of the deliverable — a reliability curve without its event definition is a
// curve about an unstated question.

import { pairForecasts, reliability, reliabilityDiagram, verificationByLead } from '/shared/viz-verify.js'
import { caption } from '/shared/charts.js'
import { esc } from '/shared/fmt.js'

const RAIN_THRESHOLD_MM = 0.1

const dayOf = (value) => {
  const ms = Date.parse(value ?? '')
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null
}

/**
 * Forecasts the store already holds.
 *
 * `type: 'precipitation_forecast'` is the field the connector writes for a
 * forecast day, and it is what separates a forecast from the `current_weather`
 * record the same connector files alongside it. Filtering on the source alone
 * would pair the current-conditions reading with itself, which verifies nothing:
 * a measurement is not a prediction of it.
 */
export function forecastsFrom(observations) {
  return (observations || []).filter((o) => o?.type === 'precipitation_forecast'
    && o?.precipitation_probability_pct !== null
    && o?.precipitation_probability_pct !== undefined)
}

/**
 * Outcomes the store already holds, one record per region-day.
 *
 * `open_meteo_archive` files one record per region *window*, carrying a `daily`
 * array. The window is flattened here because the join is by day: a record whose
 * key is a window can never match a forecast whose key is a day, and a join that
 * never matches is the failure mode `pairForecasts` calls out as `joinSuspect`.
 *
 * A `null` day is kept rather than dropped. Dropping it would shorten the
 * observation list and quietly improve the join's apparent hit rate; keeping it
 * means the panel can say "N days have no measurement", which is the true
 * reason a forecast went unverified.
 */
export function outcomesFrom(observations) {
  const out = []
  for (const record of observations || []) {
    if (record?.source !== 'open_meteo_archive') continue
    for (const day of Array.isArray(record.daily) ? record.daily : []) {
      const date = dayOf(day?.date)
      if (!date) continue
      out.push({
        id: `${record.region_name ?? record.id}:${date}`,
        region_name: record.region_name ?? null,
        observed_at: `${date}T00:00:00.000Z`,
        precipitation_mm: day?.precipitation_mm ?? null,
      })
    }
  }
  return out
}

/** The one-line coverage statement, whether or not a diagram follows. */
function coverageSentence(pairs, outcomeCount) {
  const parts = [`${pairs.total} forecast${pairs.total === 1 ? '' : 's'} in the store`]
  parts.push(`${pairs.counts.verified || 0} checked against an outcome`)
  if (pairs.counts.pending) parts.push(`${pairs.counts.pending} still in the future`)
  if (pairs.counts.no_outcome) parts.push(`${pairs.counts.no_outcome} have no recorded outcome`)
  if (pairs.counts.unusable) parts.push(`${pairs.counts.unusable} carry no probability to bin`)
  if (pairs.skipped) parts.push(`${pairs.skipped} skipped`)
  return `${parts.join(', ')}. ${outcomeCount === 0
    ? 'Nothing in the store records what actually fell on those days, so nothing here can be verified yet.'
    : `${outcomeCount} archived region-day outcome(s) available.`}`
}

/**
 * Draw the verification panel into `host`.
 *
 * Returns the pairing so a caller — or a test — can read the counts without
 * re-parsing the DOM.
 */
export function renderVerification(host, { observations, asOf } = {}) {
  if (!host) return null
  const forecasts = forecastsFrom(observations)
  const outcomes = outcomesFrom(observations)

  if (!forecasts.length) {
    host.innerHTML = `<p class="chart-panel-note">No forecasts are in the store, so there is nothing to verify. `
      + 'Run the open_meteo connector: it files a probability for each of the next seven days.</p>'
    return null
  }

  const pairs = pairForecasts(forecasts, outcomes, {
    // Region and day. Without both, the join matches every forecast in one
    // region to every other day's rainfall in it.
    key: (record) => {
      const day = dayOf(record?.observed_at ?? record?.valid_at)
      const region = record?.region_name ?? ''
      return day ? `${region}|${day}` : null
    },
    eventOf: (observation) => {
      const mm = Number(observation?.precipitation_mm)
      if (!Number.isFinite(mm)) return null
      return mm > RAIN_THRESHOLD_MM ? 1 : 0
    },
    asOf: asOf ?? Date.now(),
  })

  const statement = coverageSentence(pairs, outcomes.length)
  if (!pairs.verified.length) {
    // The honest empty state, and the one this panel will show most of the time.
    // It names what is missing rather than filling the space with a diagonal.
    host.innerHTML = `<p class="chart-panel-refused">Not yet measured.</p>`
      + `<p class="chart-panel-note">${esc(statement)}</p>`
      + caption(
        `A reliability diagram answers one question: of the forecasts issued at 70%, how often did it rain? `
        + `This product has issued ${forecasts.length} and checked none, so it cannot answer that yet and will not draw a curve that implies otherwise. `
        + `The gap is missing outcomes, not a good result: verification needs the archive connector to have run over the same region-days the forecast covered. `
        + `Event definition, once there is something to check: precipitation above ${RAIN_THRESHOLD_MM} mm on the valid day, against precipitation_probability_max.`,
        { class: 'chart-panel-note' })
    return pairs
  }

  const summary = reliability(pairs)
  const diagram = reliabilityDiagram(summary)
  const byLead = verificationByLead(pairs)

  host.innerHTML = diagram.svg
    + `<p class="chart-panel-note">${esc(statement)}</p>`
    + caption(
      `Event definition: precipitation above ${RAIN_THRESHOLD_MM} mm on the valid day. `
      + `The dashed line is a perfectly reliable forecaster; bars below it mean this product was over-confident in that bin. `
      + `Bins with no forecasts are drawn hollow — the gap is where it never issued a probability at all.`,
      { class: 'chart-panel-note' })
    + (byLead.length
      ? `<div class="chart-table"><table class="data-alt">
          <caption>Outcome rate by forecast lead time</caption>
          <thead><tr><th scope="col">Lead</th><th scope="col" class="num">Checked</th><th scope="col" class="num">Outcome rate</th></tr></thead>
          <tbody>${byLead.map((b) => `<tr><th scope="row">${esc(b.label)}</th>`
            + `<td class="num">${b.verified} checked, ${b.pending} pending</td>`
            + `<td class="num">${b.verified === 0 ? 'nothing checked at this lead' : `${Math.round(b.observedRate * 100)}%`}</td></tr>`).join('')}</tbody>
        </table></div>`
      : '')

  return pairs
}