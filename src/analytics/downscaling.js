export function quantileMap(gridded, station) {
  if (!gridded || !station || gridded.length < 2 || station.length < 2) {
    return (x) => x
  }

  const sortedGridded = [...gridded].sort((a, b) => a - b)
  const sortedStation = [...station].sort((a, b) => a - b)

  return (x) => {
    // Find rank of x in gridded array
    let rank = 0
    for (let i = 0; i < sortedGridded.length; i += 1) {
      if (sortedGridded[i] <= x) rank = i
    }
    rank = Math.min(rank, sortedGridded.length - 1)

    // Map to station array
    const stationIdx = Math.round((rank / sortedGridded.length) * (sortedStation.length - 1))
    return sortedStation[stationIdx]
  }
}

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
    const gridValues = obsGroup.map((o) => Number(o[field] || 0))
    const stationValues = stationGroup.map((s) => Number(s[field] || 0))

    const mapper = quantileMap(gridValues, stationValues)

    for (const obs of obsGroup) {
      const original = Number(obs[field] || 0)
      const correctedValue = mapper(original)
      const stationSource = stationGroup.length > 0 ? stationGroup[0].source : 'unknown'
      corrected.push({
        ...obs,
        [`bias_corrected_${field}`]: correctedValue,
        bias_correction_source: stationSource,
      })
    }
  }

  return corrected
}
