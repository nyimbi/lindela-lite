/**
 * Flood depth banding, shared by the dashboard and the test suite.
 *
 * Pure functions only, no DOM. The band cut points are operational rather
 * than arbitrary: below 0.3 m is nuisance standing water, 0.3 m impedes
 * walking, 1 m stops a light vehicle, and beyond 2 m a road is effectively
 * gone. A 0.3 m band that spanned 0–1 m would render "1 m of water" and
 * "20 cm of water" identically, which is the difference between a passable
 * road and a closed one.
 */

export const FLOOD_DEPTH_BANDS = Object.freeze([
  Object.freeze({ max: 0.3, key: 'd0', label: '0 – 0.3 m', note: 'passable' }),
  Object.freeze({ max: 1, key: 'd1', label: '0.3 – 1 m', note: 'restricted' }),
  Object.freeze({ max: 2, key: 'd2', label: '1 – 2 m', note: 'vehicle impassable' }),
  Object.freeze({ max: 5, key: 'd3', label: '2 – 5 m', note: 'severe' }),
  Object.freeze({ max: Number.POSITIVE_INFINITY, key: 'd4', label: '> 5 m', note: 'extreme' }),
])

/**
 * Returns the band for a depth, or null when the cell is dry or unknown.
 * Negative depth is not an error: the grid reports depth relative to the water
 * level, so dry ground is simply negative and must not be shaded.
 */
export function floodDepthBand(depth) {
  if (depth === null || depth === undefined) return null
  if (typeof depth !== 'number' || !Number.isFinite(depth)) return null
  if (depth <= 0) return null
  return FLOOD_DEPTH_BANDS.find((band) => depth <= band.max) || FLOOD_DEPTH_BANDS[FLOOD_DEPTH_BANDS.length - 1]
}

/**
 * Projects each wet cell of a depth grid to map space.
 *
 * Returns drawable cells with absolute x/y/width/height so the caller only has
 * to create elements. Kept free of DOM access so it can be verified directly.
 */
export function floodCellsForGrid(grid, project) {
  if (!grid || !grid.size || !Array.isArray(grid.depth_grid) || !grid.bounds) return []
  const { size, bounds, depth_grid: depths } = grid
  const cellLon = (bounds.east - bounds.west) / size
  const cellLat = (bounds.north - bounds.south) / size
  const cells = []

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const depth = depths[row * size + col]
      const band = floodDepthBand(depth)
      if (!band) continue

      const west = bounds.west + col * cellLon
      const north = bounds.north - row * cellLat
      const nw = project(north, west)
      const se = project(north - cellLat, west + cellLon)

      cells.push({
        depth,
        band,
        x: Math.min(nw.x, se.x),
        y: Math.min(nw.y, se.y),
        width: Math.abs(se.x - nw.x),
        height: Math.abs(se.y - nw.y),
      })
    }
  }
  return cells
}

/** Percentage of cells wet, and the count, for the status line. */
export function floodCoverage(depths) {
  const values = depths.filter((d) => typeof d === 'number' && Number.isFinite(d))
  const wet = values.filter((d) => d > 0)
  return {
    cells: values.length,
    wet_cells: wet.length,
    wet_pct: values.length ? Math.round((wet.length / values.length) * 10000) / 100 : 0,
    max_depth_m: wet.length ? Math.max(...wet) : 0,
  }
}