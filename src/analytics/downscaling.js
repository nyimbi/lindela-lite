import { numericOrNull } from './numeric.js'

/**
 * Stations needed before a quantile map may answer.
 *
 * This used to be 2, on the reasoning that two arrays of length two are an
 * array. With two stations the map is a straight line between its two endpoints
 * and it returns that line's value for *any* input — an observation of 900 mm
 * was published as 90 mm, a tenfold reduction of the most extreme event in the
 * record, produced by a two-value lookup table rather than measured anywhere.
 *
 * Three is the floor at which a rank-to-rank map is interpolating between
 * neighbours rather than extrapolating from a segment, and even then the
 * result is a mapping between two distributions rather than a measurement of
 * this station. The stated limits above this function say exactly that, and the
 * implementation now matches them.
 */
export const MIN_STATIONS_FOR_QUANTILE_MAP = 3

/** Observations needed for their own ranks to mean anything. */
const MIN_GRID_FOR_QUANTILE_MAP = 3

/**
 * Map a gridded observation onto a station's distribution by rank.
 *
 * Returns a function returning `null` — never a number — when the mapping
 * cannot be built or cannot answer the question put to it. The refusal is the
 * result; a substituted value would be a fabrication wearing the units of a
 * measurement.
 */
export function quantileMap(gridded, station) {
  return quantileMapTraced(gridded, station).value
}

/**
 * The same map, plus which station answered.
 *
 * The station record is carried through the map rather than matched afterwards
 * on the returned number. `stationGroup[0].source` regardless of which station
 * answered attributed every row to a station that contributed neither the grid
 * value nor the station value, and matching on value afterwards would have been
 * only marginally better — two stations reporting the same millimetres are not
 * the same station, and the field is read as provenance by whoever debugs the
 * number later.
 */
function quantileMapTraced(gridded, station, sources = []) {
  const grid = (gridded || []).map(numericOrNull).filter((v) => v !== null)
  const stations = (station || []).map(numericOrNull).filter((v) => v !== null)

  if (grid.length < MIN_GRID_FOR_QUANTILE_MAP || stations.length < MIN_STATIONS_FOR_QUANTILE_MAP) {
    return { value: () => null, traced: () => null }
  }

  // `index` is the position in the station array as it was passed in, so the
  // source list stays aligned with it.
  const sortedStations = (station || [])
    .map((value, index) => ({ value: numericOrNull(value), index }))
    .filter((s) => s.value !== null)
    .sort((a, b) => a.value - b.value)

  const sortedGrid = [...grid].sort((a, b) => a - b)

  const traced = (x) => {
    const value = numericOrNull(x)
    if (value === null) return null

    // Find rank of x in gridded array
    let rank = 0
    for (let i = 0; i < sortedGrid.length; i += 1) {
      if (sortedGrid[i] <= value) rank = i
    }
    rank = Math.min(rank, sortedGrid.length - 1)

    // Map to station array
    const stationIdx = Math.round((rank / sortedGrid.length) * (sortedStations.length - 1))
    const chosen = sortedStations[Math.min(stationIdx, sortedStations.length - 1)]
    return { value: chosen.value, source: sources[chosen.index] ?? null }
  }

  return { value: (x) => traced(x)?.value ?? null, traced }
}

/**
 * Bias-correct gridded observations onto the station distribution, per group.
 *
 * Three things this must not do, each of which it did:
 *
 * - Coerce an absent observation into a 0 mm reading. A month nobody measured
 *   then sorts to the bottom of its own grid and enters the correction as the
 *   driest month on record.
 * - Answer from a grid too small to support the answer.
 * - Name a station that did not produce the value.
 *
 * An observation with no recorded value is carried through with the original
 * fields intact, `bias_corrected_*` set to null, and a reason string. The row
 * is not dropped: dropping it would hide a data gap behind a shorter array, and
 * the gap is the finding.
 */
export function biasCorrectClimate(observations, stationRecords, { field = 'precipitation_mm', matchBy = 'country' } = {}) {
  const byGroup = new Map()

  // Build maps by group
  for (const obs of observations || []) {
    const key = obs[matchBy] || 'unknown'
    if (!byGroup.has(key)) byGroup.set(key, { observations: [], stations: [] })
    byGroup.get(key).observations.push(obs)
  }

  for (const station of stationRecords || []) {
    const key = station[matchBy] || 'unknown'
    if (!byGroup.has(key)) byGroup.set(key, { observations: [], stations: [] })
    byGroup.get(key).stations.push(station)
  }

  // Build quantile maps and apply
  const corrected = []
  for (const [, { observations: obsGroup, stations: stationGroup }] of byGroup) {
    // Only finite values enter either distribution. Coercing here with `|| 0`
    // is what turned "not measured" into the driest month in the record.
    const gridValues = obsGroup.map((o) => numericOrNull(o[field]))
    const stationValues = stationGroup.map((s) => numericOrNull(s[field]))
    const finiteGrid = gridValues.filter((v) => v !== null).length
    const finiteStations = stationValues.filter((v) => v !== null).length

    const mapper = quantileMapTraced(
      gridValues,
      stationValues,
      stationGroup.map((s) => s.source ?? null),
    )

    // Whether the map itself can answer, so the reason can distinguish "this
    // observation is missing" from "there were not enough stations to correct
    // with" — two different data gaps that both used to arrive as a number.
    const mapRefusal = finiteStations < MIN_STATIONS_FOR_QUANTILE_MAP || finiteGrid < MIN_GRID_FOR_QUANTILE_MAP
      ? `quantile map needs ${MIN_GRID_FOR_QUANTILE_MAP} finite observations and ${MIN_STATIONS_FOR_QUANTILE_MAP} finite station values; this group has ${finiteGrid} and ${finiteStations}`
      : null

    for (const obs of obsGroup) {
      const original = numericOrNull(obs[field])
      const answer = original === null ? null : mapper.traced(original)
      const refusal = original === null
        ? `${field} is not measured for this observation, so no correction is applied and no corrected value is published`
        : answer === null
          ? mapRefusal
          : null
      corrected.push({
        ...obs,
        [`bias_corrected_${field}`]: answer?.value ?? null,
        // Null when nothing was corrected. Naming a station for a correction
        // that did not happen is the provenance lie in its purest form.
        bias_correction_source: answer?.source ?? null,
        bias_correction_refusal: refusal,
      })
    }
  }

  return corrected
}
