import { clamp } from './utils.js'
import { elevationAt, elevationWindow, lonLatToTile, tileBounds, loadTile, MAX_ZOOM, MIN_ZOOM } from './terrain.js'

/**
 * Static flood inundation from a water surface elevation.
 *
 * This answers one question exactly: given a river or lake surface at
 * elevation L metres, which ground is under water, and by how much at any
 * point? depth = L - elevation.
 *
 * What it is NOT:
 * - It is not a hydraulic simulation. It does not route flow, model
 *   channels, storage, or infiltration. A water surface at L floods everything
 *   below L that is hydraulically connected, which in reality is only some of
 *   it — a closed basin below L does not magically contain a lake.
 * - It is not forecast. L is an input, not a prediction.
 *
 * Where it is genuinely useful: "the river is forecast to reach 512 m at this
 * gauge; which of our facilities are under water, and how deep?" That question
 * is answerable from a DEM alone, and it is the question relief logistics asks
 * first.
 *
 * Vertical accuracy is inherited from the source DEM (roughly +/-15 m for
 * SRTM-derived tiles). That is meaningful when a water level differs from a
 * road surface by tens of metres, and meaningless at the margin. Every response
 * therefore carries the vertical resolution so a caller can decide.
 */

const DEFAULT_LEVELS_M = [0.5, 1, 2, 3, 5]

// Terrarium tiles carry terrain only. Values at or below this are void
// (no-data sentinels), not sea-floor depth.
const NO_DATA_FLOOR_M = -400

/**
 * Rejects levels that cannot correspond to a real water surface.
 *
 * Without this, a "water level" of 0 m over the middle of the Pacific is
 * reported as several thousand metres of water, because the tile there is
 * void and the void sentinel reads as a very low elevation. That is worse than
 * useless during a response: it looks like catastrophic inundation.
 */
function validateLevel(levelM) {
  if (!Number.isFinite(levelM)) return { ok: false, reason: 'level_m must be a finite number' }
  if (levelM < -500) {
    return { ok: false, reason: `level_m ${levelM} m is below the terrain data floor (-500 m); no elevation data covers this area` }
  }
  if (levelM > 9000) {
    return { ok: false, reason: `level_m ${levelM} m exceeds the maximum plausible water surface elevation (9000 m)` }
  }
  return { ok: true }
}

/**
 * Elevation, but only where the underlying data actually exists.
 */
async function sampleElevation(lat, lon, options) {
  const elevation = await elevationAt(lat, lon, options)
  if (elevation === null) return { error: 'No terrain data covers this location' }
  if (elevation <= NO_DATA_FLOOR_M) {
    return { error: `Terrain void (${Math.round(elevation)} m): elevation data is bathymetry-free and does not cover this point` }
  }
  return { value: elevation }
}

/**
 * Flood depth at a single point for a given water level.
 */
export async function depthAtPoint(lat, lon, levelM, options = {}) {
  if (!Number.isFinite(levelM)) throw new Error('level_m must be a finite number')
  const levelCheck = validateLevel(levelM)
  if (!levelCheck.ok) {
    return {
      lat,
      lon,
      level_m: levelM,
      elevation_m: null,
      depth_m: null,
      flooded: null,
      data_available: false,
      reason: levelCheck.reason,
    }
  }
  const sample = await sampleElevation(lat, lon, options)
  if (sample.error) {
    return {
      lat,
      lon,
      level_m: levelM,
      elevation_m: null,
      depth_m: null,
      flooded: null,
      data_available: false,
      reason: sample.error,
    }
  }
  const elevation = sample.value

  const depth = levelM - elevation
  return {
    lat,
    lon,
    level_m: levelM,
    elevation_m: Math.round(elevation * 100) / 100,
    depth_m: Math.round(depth * 100) / 100,
    flooded: depth > 0,
    // Depth below which a walking adult or a light vehicle is impeded.
    // Thresholds are conventional rather than site-specific; they are exposed
    // so they can be overridden per deployment.
    passability: depthPassability(depth, options),
    data_available: true,
    vertical_resolution_m: 15,
    source: 'AWS terrain-tiles-prod (Terrarium/SRTM)',
  }
}

function depthPassability(depth, options = {}) {
  if (depth <= 0) return 'dry'
  const walk = options.walkImpassableM ?? 0.3
  const vehicle = options.vehicleImpassableM ?? 0.3
  const severe = options.vehicleSevereM ?? 1.0
  if (depth >= severe) return 'impassable_severe'
  if (depth >= vehicle) return 'impassable'
  if (depth >= walk) return 'restricted'
  return 'passable_wet'
}

/**
 * Depth across a bounding box, as a regular grid.
 * Returns the grid plus the water level needed to interpret it, so a map can
 * shade cells without re-deriving anything.
 */
export async function depthGrid({ south, west, north, east, levelM, gridSize = 32, zoom, tileOptions = {} }) {
  if (![south, west, north, east].every(Number.isFinite)) throw new Error('bounds must be finite numbers')
  if (north <= south || east <= west) throw new Error('bounds must define a non-degenerate box')
  const size = clamp(Math.floor(gridSize), 2, 256)
  const targetZoom = clamp(Math.floor(zoom ?? pickZoom(south, west, north, east, size)), MIN_ZOOM, MAX_ZOOM)

  const tiles = new Map()
  const missing = new Set()
  for (let row = 0; row < size; row += 1) {
    const lat = north - ((row + 0.5) / size) * (north - south)
    const t = lonLatToTile(west + ((0.5) / size) * (east - west), lat, targetZoom)
    for (let col = 0; col < size; col += 1) {
      const lon = west + ((col + 0.5) / size) * (east - west)
      const tile = lonLatToTile(lon, lat, targetZoom)
      const key = `${targetZoom}/${tile.x}/${tile.y}`
      if (tiles.has(key) || missing.has(key)) continue
      try {
        tiles.set(key, { tile, decoded: await loadTile(tile.x, tile.y, targetZoom, tileOptions) })
      } catch {
        missing.add(key)
      }
    }
  }

  const elevations = new Float64Array(size * size)
  for (let row = 0; row < size; row += 1) {
    const lat = north - ((row + 0.5) / size) * (north - south)
    for (let col = 0; col < size; col += 1) {
      const lon = west + ((col + 0.5) / size) * (east - west)
      const tile = lonLatToTile(lon, lat, targetZoom)
      const entry = tiles.get(`${targetZoom}/${tile.x}/${tile.y}`)
      elevations[row * size + col] = entry
        ? elevationFromDecodedTile(entry.decoded, entry.tile, targetZoom, lat, lon)
        : NaN
    }
  }

  return summarizeGrid({ elevations, size, south, west, north, east, levelM, zoom: targetZoom })
}

/** Chooses the coarsest zoom where the box fits inside a small tile footprint. */
/**
 * Picks the finest zoom that keeps the whole box within a tile budget.
 *
 * Iterating upward from MIN_ZOOM and taking the first zoom whose tile span
 * fits is wrong: for a city-sized box, *coarse* zooms always fit inside a
 * single tile, so that always selects z5 — about 1,200 km per pixel, which
 * averages a whole landscape into each cell and makes flooded area meaningless.
 * Search downward from MAX_ZOOM and stop at the first zoom whose tile count is
 * within budget, so resolution is maximised for the region asked about.
 */
function pickZoom(south, west, north, east, size, maxTiles = 12) {
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom -= 1) {
    const a = lonLatToTile(west, north, zoom)
    const b = lonLatToTile(east, south, zoom)
    const tiles = (Math.abs(b.x - a.x) + 1) * (Math.abs(b.y - a.y) + 1)
    if (tiles <= maxTiles) return zoom
  }
  return MIN_ZOOM
}

function elevationFromDecodedTile(decoded, tile, zoom, lat, lon) {
  const bounds = tileBounds(tile.x, tile.y, zoom)
  const fx = clamp(((lon - bounds.west) / (bounds.east - bounds.west)) * decoded.width, 0, decoded.width - 1)
  const fy = clamp(((lat - bounds.north) / (bounds.south - bounds.north)) * decoded.height, 0, decoded.height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, decoded.width - 1)
  const y1 = Math.min(y0 + 1, decoded.height - 1)
  const dx = fx - x0
  const dy = fy - y0
  const g = decoded.grid
  const e00 = g[y0 * decoded.width + x0]
  const e10 = g[y0 * decoded.width + x1]
  const e01 = g[y1 * decoded.width + x0]
  const e11 = g[y1 * decoded.width + x1]
  if ([e00, e10, e01, e11].some(Number.isNaN)) return NaN
  return (e00 * (1 - dx) * (1 - dy)) + (e10 * dx * (1 - dy)) + (e01 * (1 - dx) * dy) + (e11 * dx * dy)
}

/** Turns a raw elevation grid into depths, coverage and a GeoJSON polygon set. */
function summarizeGrid({ elevations, size, south, west, north, east, levelM, zoom }) {
  const levels = Array.isArray(levelM) ? levelM : [levelM]
  const depth = new Float64Array(size * size)
  let dataCells = 0
  let minElev = Infinity
  let maxElev = -Infinity

  for (let i = 0; i < elevations.length; i += 1) {
    if (Number.isNaN(elevations[i])) continue
    dataCells += 1
    if (elevations[i] < minElev) minElev = elevations[i]
    if (elevations[i] > maxElev) maxElev = elevations[i]
  }

  const coveragePct = dataCells ? Math.round((dataCells / elevations.length) * 10000) / 100 : 0

  // Per-level coverage, so a map can offer a depth selector without refetching.
  const perLevel = levels.map((level) => {
    let cells = 0
    let areaSqKm = 0
    for (let i = 0; i < elevations.length; i += 1) {
      if (!Number.isNaN(elevations[i]) && level - elevations[i] > 0) {
        cells += 1
        areaSqKm += cellAreaSqKm(south, west, north, east, size)
      }
    }
    return {
      level_m: level,
      flooded_cells: cells,
      coverage_pct: dataCells ? Math.round((cells / dataCells) * 10000) / 100 : 0,
      area_sq_km: Math.round(areaSqKm * 100) / 100,
    }
  })

  const primary = levels[0]
  for (let i = 0; i < elevations.length; i += 1) {
    if (Number.isNaN(elevations[i])) continue
    depth[i] = primary - elevations[i]
  }

  return {
    bounds: { south, west, north, east },
    size,
    zoom,
    level_m: primary,
    levels_m: levels,
    coverage_pct: coveragePct,
    elevation_range_m: dataCells ? { min: Math.round(minElev * 100) / 100, max: Math.round(maxElev * 100) / 100 } : null,
    per_level: perLevel,
    depth_grid: Array.from(depth, (d) => (Number.isFinite(d) ? Math.round(d * 100) / 100 : null)),
    // Coarse polygons, one per contiguous run per row. Enough to shade a map
    // without shipping 10k points; not a hydrology product.
    extent_geojson: contoursToGeoJson(depth, size, south, west, north, east, 0),
    vertical_resolution_m: 15,
    source: 'AWS terrain-tiles-prod (Terrarium/SRTM)',
    model: 'static water-surface elevation; no flow routing or storage modelled',
    generated_at: new Date().toISOString(),
  }
}

function cellAreaSqKm(south, west, north, east, size) {
  const meanLat = (south + north) / 2
  const dLat = (north - south) / size
  const dLon = (east - west) / size
  const kmPerDegLat = 110.574
  const kmPerDegLon = 111.32 * Math.cos((meanLat * Math.PI) / 180)
  return dLat * kmPerDegLat * dLon * kmPerDegLon
}

/**
 * Row-run polygons for cells deeper than `thresholdM`.
 * Contours are the honest primitive here: true isobaths need marching squares
 * and a hydrology-consistent surface, which this is not.
 */
function contoursToGeoJson(depth, size, south, west, north, east, thresholdM) {
  const features = []
  const dLon = (east - west) / size
  const dLat = (north - south) / size

  for (let row = 0; row < size; row += 1) {
    let run = null
    for (let col = 0; col <= size; col += 1) {
      const value = col < size ? depth[row * size + col] : NaN
      const wet = Number.isFinite(value) && value > thresholdM
      if (wet && run === null) run = col
      if (!wet && run !== null) {
        const w0 = west + run * dLon
        const w1 = west + col * dLon
        const n0 = north - row * dLat
        const n1 = n0 - dLat
        features.push({
          type: 'Feature',
          properties: { row, depth_threshold_m: thresholdM },
          geometry: {
            type: 'Polygon',
            coordinates: [[[w0, n1], [w1, n1], [w1, n0], [w0, n0], [w0, n1]]],
          },
        })
        run = null
      }
    }
  }

  return { type: 'FeatureCollection', features }
}

/**
 * Local terrain context around a point: is this a basin or a slope?
 * Useful for explaining why a point floods at all.
 */
export async function terrainContext(lat, lon, options = {}) {
  const win = await elevationWindow(lat, lon, options)
  if (!win) return { available: false, reason: 'No terrain data' }

  const { values, size } = win
  const valid = [...values].filter(Number.isFinite)
  if (valid.length < 4) return { available: false, reason: 'Insufficient terrain samples' }

  let min = Math.min(...valid)
  let max = Math.max(...valid)
  let sum = 0
  for (const v of valid) sum += v
  const mean = sum / valid.length

  // Count how many surrounding samples are higher than the centre: a basin has
  // many, a slope has few.
  const centre = values[Math.floor(size / 2) * size + Math.floor(size / 2)]
  let higher = 0
  let comparable = 0
  if (Number.isFinite(centre)) {
    for (const v of valid) {
      if (v === centre) continue
      comparable += 1
      if (v > centre) higher += 1
    }
  }

  return {
    available: true,
    elevation_m: Number.isFinite(centre) ? Math.round(centre * 100) / 100 : null,
    local_min_m: Math.round(min * 100) / 100,
    local_max_m: Math.round(max * 100) / 100,
    local_relief_m: Math.round((max - min) * 100) / 100,
    local_mean_m: Math.round(mean * 100) / 100,
    surrounding_higher_pct: comparable ? Math.round((higher / comparable) * 100) / 100 : null,
    terrain: terrainLabel(higher / Math.max(comparable, 1), max - min),
    radius_deg: options.radiusDeg ?? 0.02,
    generated_at: new Date().toISOString(),
  }
}

function terrainLabel(higherFraction, relief) {
  if (relief < 5) return 'flat'
  if (higherFraction > 0.6) return 'basin'
  if (higherFraction < 0.25) return 'slope'
  return 'undulating'
}

/** Convenience: probe several water levels at one point. */
export async function depthProfile(lat, lon, options = {}) {
  const levels = options.levels_m ?? DEFAULT_LEVELS_M
  const profile = []
  for (const level of levels) {
    profile.push(await depthAtPoint(lat, lon, level, options))
  }
  const onset = profile.find((p) => p.flooded)
  const unavailable = profile.find((p) => p.data_available === false)
  return {
    lat,
    lon,
    levels_m: levels,
    profile,
    onset_level_m: onset ? onset.level_m : null,
    data_available: !unavailable || profile.some((p) => p.data_available === true),
    // Distinct from data_available: we have terrain here, and the point is dry
    // at every level asked about. That is a real answer, not a gap.
    inundated: Boolean(onset),
    reason: unavailable && profile.every((p) => p.data_available === false)
      ? unavailable.reason
      : null,
    vertical_resolution_m: 15,
    source: 'AWS terrain-tiles-prod (Terrarium/SRTM)',
    generated_at: new Date().toISOString(),
  }
}