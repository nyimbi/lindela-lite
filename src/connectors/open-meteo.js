import { fetchWithRetry } from './http.js'
import { DEFAULT_REGIONS } from '../schema.js'
import { asUtcTimestamp, stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { computeEnsembleStats } from '../analytics/ensemble.js'

/**
 * This connector reads a deterministic forecast, so it has no ensemble members to
 * report and must not imply that it has.
 *
 * It used to invent them. A spread of `0.25 + (1 - probability/100) * 0.75` was
 * applied to the single point value to manufacture p10/p50/p90, which were
 * published under exactly the field names a probabilistic forecast uses. At a
 * reported probability of 10% that made p90 roughly 1.9x the observed
 * precipitation, and the risk scorer preferred p90 over the point value — so the
 * flood risk score was inflated by an invented coefficient before it was even
 * scaled by precipitation * 1.5.
 *
 * Invented uncertainty is worse than none: it looks calibrated, it is
 * indistinguishable from a real ensemble downstream, and it moves a number
 * someone dispatches resources on. Probabilistic members require Open-Meteo's
 * ensemble endpoint and its real member set. Until that is wired up, the
 * observation states the limit and carries no percentiles.
 */
/**
 * Read a measurement, keeping "no reading" distinct from "a reading of zero".
 *
 * `Number(x || 0)` cannot tell those apart. A missing value became 0 mm of rain,
 * which reads downstream as a measured dry spell and lowers flood risk. A day the
 * API did not report — `?.[i]` past the end of a shorter array — likewise became
 * a confident zero. Absence is preserved so the risk scorer can treat it as
 * unknown, which reduces confidence, rather than as a measurement, which would
 * silently reduce the risk.
 */
// Exported so the archive connector keeps the same absence discipline: a
// missing day is null in both, and the model treats them the same way.
export function readMeasurement(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export const ENSEMBLE_MODEL_LIMIT =
  'Deterministic point forecast only; no ensemble members are produced. ' +
  'Percentile fields are absent because this connector does not fetch a probabilistic forecast.'

/**
 * The limit stated on a record that *does* carry percentiles.
 *
 * The deterministic limit above says "no ensemble members are produced", which
 * is false on a record holding thirty of them. One string cannot be both, and a
 * record that published real percentiles under a limit saying it has none would
 * be the invented-uncertainty defect wearing the honesty note as cover.
 */
export const ENSEMBLE_ATTRIBUTION =
  'Ensemble members from the Open-Meteo Ensemble API; percentiles computed here over the member set, ' +
  'not published by the provider. Data licenced CC BY 4.0, attribution required.'

/**
 * How many API calls one ensemble request costs.
 *
 * Open-Meteo's own documentation states an ensemble call "is equivalent to 4.0
 * calls", against one HTTP request = one call for the deterministic API. It is
 * published on the record rather than only in this comment because a deployment
 * that widens `DEFAULT_REGIONS` is multiplying this figure and cannot see it
 * from the region list.
 */
export const ENSEMBLE_CALL_WEIGHT = 4

/** The host serving ensemble members. A different host from the deterministic API. */
const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble'

/** The model requested when the caller names none. See `docs/research/open-meteo-ensemble/`. */
export const DEFAULT_ENSEMBLE_MODEL = 'ecmwf_ifs025'

/**
 * The ensemble member values for one day, read off the response's own keys.
 *
 * Members are extra keys in the same `daily` object, suffixed `_memberNN`, and
 * **the count differs by model** — 39 for ICON, 30 for GFS, 51 for ECMWF IFS at
 * the time of writing. A parser that assumed a count would read a truncated
 * ensemble and report a narrower spread, which is the one error a spread index
 * exists to catch. So the keys are the source of the count, never a constant.
 *
 * The suffix is anchored at the end of the key. A *multi-model* request appends
 * the model id after the member number
 * (`precipitation_sum_member27_ncep_gefs_seamless`), and this connector asks for
 * one model per call — because a p90 across two models is a p90 of neither.
 *
 * The unsuffixed `precipitation_sum` key is the **control run**, verified against
 * live responses (it equals a member exactly on most days and is nowhere near the
 * mean). It is excluded: it is already one of the members, and counting it twice
 * biases the distribution toward it.
 */
export function ensembleMemberValues(daily, variable = 'precipitation_sum') {
  const keys = Object.keys(daily || {}).filter((key) => key.startsWith(`${variable}_member`) && /_member\d+$/.test(key))
  // Sorted by member number, so the member list is in a stable order rather than
  // whatever order the JSON happened to arrive in — the record is compared and
  // diffed downstream.
  const ordered = keys
    .map((key) => [Number(/_member(\d+)$/.exec(key)[1]), key])
    .sort((a, b) => a[0] - b[0])
    .map(([, key]) => key)
  // The columns are handed back raw — one array per member, the API's own shape.
  // Reading them through `readMeasurement` here would coerce each *array* to a
  // number, which is `NaN`, which is null: every member absent, on a response
  // full of them. The absence rule belongs on the element, where a value lives.
  return { keys: ordered, values: ordered.map((key) => daily[key]) }
}

/**
 * The ensemble fields for one day of the daily block, or the deterministic
 * refusal when there are no members to compute from.
 *
 * Percentiles are computed here rather than published by the provider: the API
 * returns members, not quantiles, and `computeEnsembleStats` is the module that
 * turns one into the other. A day whose members are all absent keeps null
 * percentiles and says so, rather than reporting a percentile of nothing.
 */
export function ensembleFieldsFor(daily, index, variable = 'precipitation_sum') {
  const { values } = ensembleMemberValues(daily, variable)
  const readings = values.map((column) => readMeasurement(Array.isArray(column) ? column[index] : null))
  const usable = readings.filter((value) => value !== null)
  if (!usable.length) return { ...withoutEnsemble(), ensemble_source: null, ensemble_members_reported: 0, ensemble_members_absent: readings.length }
  const stats = computeEnsembleStats(usable)
  return {
    ensemble_members: usable.map((value) => ({ value })),
    ensemble_p10: stats.p10,
    ensemble_p50: stats.p50,
    ensemble_p90: stats.p90,
    // The read path in `src/analytics.js` prefers `ensemble_p90` over the point
    // value *only* when this field says a real probabilistic forecast supplied
    // it. It is the guard that keeps a synthesized percentile from inflating the
    // flood score, and it is only set here, from fetched members.
    ensemble_source: 'open_meteo_ensemble',
    ensemble_model: null,
    ensemble_mean: stats.mean,
    ensemble_stddev: stats.stddev,
    ensemble_members_reported: stats.count,
    ensemble_members_absent: readings.length - usable.length,
    model_limit: ENSEMBLE_ATTRIBUTION,
  }
}

function withoutEnsemble() {
  return {
    ensemble_members: [],
    ensemble_p10: null,
    ensemble_p50: null,
    ensemble_p90: null,
    model_limit: ENSEMBLE_MODEL_LIMIT,
  }
}

async function openMeteoIngest(options = {}) {
    const regions = options.regions?.length ? options.regions : DEFAULT_REGIONS
    const climate_observations = []
    const errors = []
    // The ensemble fetch is opt-in, and defaults off, because it multiplies this
    // source's API cost by `ENSEMBLE_CALL_WEIGHT` against a free tier the
    // deployment shares with every other source. Turning it on is a decision a
    // deployment makes, not a default it inherits.
    const useEnsemble = Boolean(options.include_ensemble) && process.env.LINDELA_LITE_ENSEMBLE_ENABLED !== 'off'
    const ensembleModel = options.ensemble_model || DEFAULT_ENSEMBLE_MODEL
    const forecastDays = options.forecast_days || 7

    for (const region of regions) {
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast')
        url.searchParams.set('latitude', region.lat)
        url.searchParams.set('longitude', region.lon)
        url.searchParams.set('daily', 'precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min')
        url.searchParams.set('current', 'precipitation,temperature_2m,relative_humidity_2m')
        url.searchParams.set('forecast_days', String(forecastDays))
        url.searchParams.set('timezone', 'UTC')

        const data = await fetchWithRetry(url, { timeoutMs: options.timeout_ms || 20000, retries: options.retries ?? 2, parse: 'json', source: options.source })

        // A second request to a different host, and a failure here must not cost
        // the deterministic forecast — the point reading is the one the map and
        // the scorers need, and losing it because the *probabilistic* half was
        // unreachable would be an availability regression dressed as a feature.
        // A refused ensemble is recorded in `errors` and the daily records fall
        // back to the stated limit, which is the same shape they had before this
        // was wired.
        let ensemble = null
        if (useEnsemble) {
          try {
            const ensembleUrl = new URL(ENSEMBLE_URL)
            ensembleUrl.searchParams.set('latitude', region.lat)
            ensembleUrl.searchParams.set('longitude', region.lon)
            ensembleUrl.searchParams.set('daily', 'precipitation_sum')
            ensembleUrl.searchParams.set('forecast_days', String(forecastDays))
            ensembleUrl.searchParams.set('models', ensembleModel)
            ensembleUrl.searchParams.set('timezone', 'UTC')
            ensemble = await fetchWithRetry(ensembleUrl, { timeoutMs: options.timeout_ms || 20000, retries: options.retries ?? 2, parse: 'json', source: options.source })
          } catch (error) {
            // Named with the model, because "the ensemble failed" is not
            // actionable and "ecmwf_ifs025 failed" is: the parameter is required
            // by the API and an unsupported id is an error, not a fallback.
            errors.push(`${region.name || region.lat}: ensemble (${ensembleModel}): ${error.message}`)
          }
        }

        if (data.current) {
          climate_observations.push({
            id: stableId('climate', ['open_meteo_current', region, data.current.time]),
            source: 'open_meteo',
            type: 'current_weather',
            region_name: region.name,
            country: region.country,
            latitude: Number(region.lat),
            longitude: Number(region.lon),
            observed_at: asUtcTimestamp(data.current.time),
            precipitation_mm: readMeasurement(data.current.precipitation),
            temperature_c: readMeasurement(data.current.temperature_2m),
            humidity_pct: readMeasurement(data.current.relative_humidity_2m),
            ...withoutEnsemble(),
            metadata: { provider: 'Open-Meteo' },
          })
        }

        const daily = data.daily || {}
        // The ensemble block is keyed by the same dates as the deterministic
        // one, but it is matched by date rather than by index: the two are
        // separate requests to separate hosts and nothing guarantees the arrays
        // align. Pairing by position would attach one day's members to another
        // day's point value, which is a wrong number that looks plausible.
        const ensembleDaily = ensemble?.daily || null
        const ensembleIndexByDate = new Map(
          (ensembleDaily?.time || []).map((date, index) => [date, index]),
        )
        for (let i = 0; i < (daily.time || []).length; i += 1) {
          const precip = readMeasurement(daily.precipitation_sum?.[i])
          const ensembleIndex = ensembleDaily ? ensembleIndexByDate.get(daily.time[i]) : undefined
          const ensembleFields = ensembleIndex === undefined
            ? withoutEnsemble()
            : { ...ensembleFieldsFor(ensembleDaily, ensembleIndex), ensemble_model: ensembleModel }
          climate_observations.push({
            id: stableId('climate', ['open_meteo_daily', region, daily.time[i]]),
            source: 'open_meteo',
            type: 'precipitation_forecast',
            region_name: region.name,
            country: region.country,
            latitude: Number(region.lat),
            longitude: Number(region.lon),
            observed_at: asUtcTimestamp(daily.time[i]),
            precipitation_mm: precip,
            precipitation_probability_pct: readMeasurement(daily.precipitation_probability_max?.[i]),
            temperature_max_c: readMeasurement(daily.temperature_2m_max?.[i]),
            temperature_min_c: readMeasurement(daily.temperature_2m_min?.[i]),
            ...ensembleFields,
            // Named on every record that carries percentiles, so the 4x cost is
            // visible where the widening happens rather than only in the docs.
            ...(ensembleIndex === undefined ? {} : { ensemble_call_weight: ENSEMBLE_CALL_WEIGHT }),
            metadata: {
              provider: 'Open-Meteo',
              horizon: 'forecast',
              ...(ensembleIndex === undefined ? {} : { ensemble_attribution: ENSEMBLE_ATTRIBUTION }),
            },
          })
        }
      } catch (error) {
        errors.push(`${region.name || region.lat}: ${error.message}`)
      }
    }

    return { climate_observations, errors }
}

export const spec = defineConnector({
  id: 'open_meteo',
  description: 'Open-Meteo weather forecasts and observations',
  schema: {
    requestSchema: {
      regions: 'array of {name, country, lat, lon}',
      forecast_days: 'number (default 7)',
      include_ensemble: `boolean (default false) — fetches real ensemble members and their percentiles; costs ${ENSEMBLE_CALL_WEIGHT}x an ordinary call per region`,
      ensemble_model: `string (default ${DEFAULT_ENSEMBLE_MODEL}) — the ensemble model id; required by the API, which refuses an unknown one rather than falling back`,
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      climate_observations: 'array of current and forecast weather observations; daily records carry ensemble members and p10/p50/p90 when include_ensemble is set',
    },
  },
  defaults: {
    rateLimit: { perMinute: 60 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  source: 'Open-Meteo (forecast API and ensemble API)',
  license: 'CC BY 4.0, per open-meteo.com terms — attribution required',
  ingest: openMeteoIngest,
})

export const openMeteoConnector = {
  id: 'open_meteo',
  ingest: openMeteoIngest,
}
