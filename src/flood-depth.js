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
 *
 * Vertical *reference* is a separate matter and was previously unstated. Every
 * height here is a difference within one datum, and the code holds no geoid or
 * ellipsoid model: it can name the datum it is working in, and it can take an
 * offset a caller has derived elsewhere, but it cannot convert between datums.
 * A depth in metres whose datum is unknown is not comparable to any other
 * depth in metres, so the datum is an explicit input and appears in every
 * response. See `verticalReference`.
 */

const DEFAULT_LEVELS_M = [0.5, 1, 2, 3, 5]

// Terrarium tiles carry terrain only. Values at or below this are void
// (no-data sentinels), not sea-floor depth. depthAtPoint has always refused
// these; the grid refused nothing, so a coastal cell the dataset does not cover
// came back as several hundred metres of water.
const NO_DATA_FLOOR_M = -400

/**
 * The vertical reference the source tiles are published in.
 *
 * AWS terrain-tiles states its Terrarium heights are referenced to mean sea
 * level. That is the source's statement, not something this code verifies, and
 * the distinction is load-bearing: nothing here can check it, and nothing here
 * can produce a number outside it.
 */
export const SOURCE_DATUM = 'terrarium_mean_sea_level'

const DATUM_NOTE = 'Heights are differences inside one vertical reference. This code holds no '
  + 'geoid or ellipsoid model, so it can name the datum it is working in but cannot convert '
  + 'between datums: a conversion has to arrive as an explicit offset_m from the caller.'

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
 * Resolves the vertical reference a response is expressed in.
 *
 * Three cases, and only three:
 *
 * - No datum declared, or the source datum declared. Resolved, no shift. The
 *   default is the source datum, and it is documented as such.
 * - An offset supplied (with or without a datum name). Resolved; the offset is
 *   applied to every elevation before any depth is taken, and recorded as
 *   caller-supplied because that is exactly what it is — an unverifiable
 *   assertion from outside.
 * - A foreign datum declared with no offset. NOT resolved, and no number is
 *   produced. Emitting a source-datum depth labelled with someone else's datum
 *   is a number with a caveat; this product's policy is the other way round,
 *   an absent value is not a zero.
 */
function verticalReference(datum, offsetM) {
  const declared = typeof datum === 'string' && datum.trim() !== ''
  const name = declared ? datum.trim() : SOURCE_DATUM
  const offset = Number.isFinite(offsetM) ? offsetM : null
  const base = { datum: name, declared_by: declared ? 'caller' : 'source_default', note: DATUM_NOTE, resolution_m: 15 }

  if (offset !== null) {
    return { ...base, offset_applied_m: offset, offset_source: 'caller_supplied', resolved: true, reason: null }
  }
  if (!declared || name === SOURCE_DATUM) {
    return { ...base, offset_applied_m: null, offset_source: 'none', resolved: true, reason: null }
  }
  return {
    ...base,
    offset_applied_m: null,
    offset_source: 'none',
    resolved: false,
    reason: `datum '${name}' is not the source datum ('${SOURCE_DATUM}') and no offset_m was supplied; `
      + 'no geoid model is available here to derive the shift, so no height is reported in it',
  }
}

/** Rounds to centimetres and normalises -0 to 0, so a sea-level cell is 0, not -0. */
function round2(value) {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
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
  const vertical = verticalReference(options.datum, options.datum_offset_m)
  const levelCheck = validateLevel(levelM)
  if (!levelCheck.ok) {
    return {
      lat,
      lon,
      level_m: levelM,
      elevation_m: null,
      depth_m: null,
      flooded: null,
      datum_resolved: vertical.resolved,
      data_available: false,
      reason: levelCheck.reason,
      vertical_reference: vertical,
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
      datum_resolved: vertical.resolved,
      data_available: false,
      reason: sample.error,
      vertical_reference: vertical,
    }
  }
  if (!vertical.resolved) {
    // Terrain exists; the requested datum is the part that does not. The
    // ground is real and its depth would be real, but only in the source
    // datum — so it is withheld rather than relabelled.
    return {
      lat,
      lon,
      level_m: levelM,
      elevation_m: null,
      depth_m: null,
      flooded: null,
      datum_resolved: false,
      data_available: true,
      reason: vertical.reason,
      vertical_reference: vertical,
    }
  }

  // 0 is a legitimate offset and a legitimate elevation: `??` not `||`.
  const elevation = sample.value + (vertical.offset_applied_m ?? 0)
  const depth = levelM - elevation
  return {
    lat,
    lon,
    level_m: levelM,
    elevation_m: round2(elevation),
    depth_m: round2(depth),
    flooded: depth > 0,
    // Depth below which a walking adult or a light vehicle is impeded.
    // Thresholds are conventional rather than site-specific; they are exposed
    // so they can be overridden per deployment.
    passability: depthPassability(depth, options),
    datum_resolved: true,
    data_available: true,
    vertical_reference: vertical,
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
export async function depthGrid({ south, west, north, east, levelM, gridSize = 32, zoom, datum, datumOffsetM, tileOptions = {} }) {
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

  return summarizeGrid({
    elevations, size, south, west, north, east, levelM, zoom: targetZoom, datum, datumOffsetM,
  })
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
function summarizeGrid({ elevations, size, south, west, north, east, levelM, zoom, datum, datumOffsetM }) {
  const levels = Array.isArray(levelM) ? levelM : [levelM]
  const vertical = verticalReference(datum, datumOffsetM)
  const offset = vertical.offset_applied_m ?? 0

  // A cell is usable only if the tile held terrain for it. A missing tile is
  // NaN; a cell at or below NO_DATA_FLOOR_M is the other kind of absent — a
  // sentinel or sea floor the dataset does not claim to hold. Both are NaN
  // from here on, so nothing downstream can mistake one for depth. depthGrid
  // had no such filter, which is how a coastal box reported hundreds of
  // metres of water over ground it had never measured.
  const usable = new Float64Array(elevations.length).fill(NaN)
  let voidCells = 0
  for (let i = 0; i < elevations.length; i += 1) {
    const elevation = elevations[i]
    if (Number.isNaN(elevation)) continue
    if (elevation <= NO_DATA_FLOOR_M) {
      voidCells += 1
      continue
    }
    usable[i] = elevation + offset
  }

  // Refused datum: the geometry is real but the numbers would be in the source
  // datum, so no depth, no area and no elevation range is stated in it.
  if (!vertical.resolved) {
    const blank = new Float64Array(size * size).fill(NaN)
    return {
      bounds: { south, west, north, east },
      size,
      zoom,
      level_m: levels[0],
      levels_m: levels,
      coverage_pct: null,
      void_cells: voidCells,
      elevation_range_m: null,
      per_level: levels.map((level) => ({ level_m: level, flooded_cells: null, coverage_pct: null, area_sq_km: null })),
      depth_grid: Array.from(blank, () => null),
      extent_geojson: { type: 'FeatureCollection', features: [] },
      datum_resolved: false,
      reason: vertical.reason,
      vertical_reference: vertical,
      vertical_resolution_m: 15,
      source: 'AWS terrain-tiles-prod (Terrarium/SRTM)',
      model: 'static water-surface elevation; no flow routing or storage modelled',
      generated_at: new Date().toISOString(),
    }
  }

  const depth = new Float64Array(size * size).fill(NaN)
  let dataCells = 0
  let minElev = Infinity
  let maxElev = -Infinity

  for (let i = 0; i < usable.length; i += 1) {
    if (Number.isNaN(usable[i])) continue
    dataCells += 1
    if (usable[i] < minElev) minElev = usable[i]
    if (usable[i] > maxElev) maxElev = usable[i]
  }

  const coveragePct = dataCells ? Math.round((dataCells / usable.length) * 10000) / 100 : 0

  // Per-level coverage, so a map can offer a depth selector without refetching.
  const perLevel = levels.map((level) => {
    let cells = 0
    let areaSqKm = 0
    for (let i = 0; i < usable.length; i += 1) {
      if (!Number.isNaN(usable[i]) && level - usable[i] > 0) {
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
  for (let i = 0; i < usable.length; i += 1) {
    if (Number.isNaN(usable[i])) continue
    depth[i] = primary - usable[i]
  }

  return {
    bounds: { south, west, north, east },
    size,
    zoom,
    level_m: primary,
    levels_m: levels,
    coverage_pct: coveragePct,
    void_cells: voidCells,
    elevation_range_m: dataCells ? { min: round2(minElev), max: round2(maxElev) } : null,
    per_level: perLevel,
    // NaN cells serialise as null, not 0. A no-data cell at 0 m of depth reads
    // as "measured, and dry" — a measurement that was never taken.
    depth_grid: Array.from(depth, (d) => (Number.isFinite(d) ? round2(d) : null)),
    // Coarse polygons, one per contiguous run per row. Enough to shade a map
    // without shipping 10k points; not a hydrology product.
    extent_geojson: contoursToGeoJson(depth, size, south, west, north, east, 0),
    datum_resolved: true,
    vertical_reference: vertical,
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

  // Relief is a difference and survives any datum; absolute heights do not.
  const vertical = verticalReference(options.datum, options.datum_offset_m)
  const shift = vertical.resolved ? (vertical.offset_applied_m ?? 0) : 0
  const absolute = (value) => (vertical.resolved ? round2(value + shift) : null)

  return {
    available: true,
    datum_resolved: vertical.resolved,
    reason: vertical.resolved ? null : vertical.reason,
    elevation_m: Number.isFinite(centre) ? absolute(centre) : null,
    local_min_m: absolute(min),
    local_max_m: absolute(max),
    local_relief_m: round2(max - min),
    local_mean_m: absolute(mean),
    surrounding_higher_pct: comparable ? Math.round((higher / comparable) * 100) / 100 : null,
    terrain: terrainLabelForSamples({ higher, comparable, relief: max - min, centreFinite: Number.isFinite(centre) }),
    terrain_refusal: terrainRefusal(comparable, Number.isFinite(centre)),
    radius_deg: options.radiusDeg ?? 0.02,
    vertical_reference: vertical,
    vertical_resolution_m: 15,
    source: 'AWS terrain-tiles-prod (Terrarium/SRTM)',
    generated_at: new Date().toISOString(),
  }
}

/**
 * The terrain label, or null when there is nothing to label.
 *
 * This took a *fraction* and defended against a zero denominator with
 * `Math.max(comparable, 1)`, which converts "no information" into a confident
 * 0 and hands it to the classifier. `terrainLabel(0, relief)` returns `'slope'`,
 * so a basin with no finite centre sample — and therefore no comparable
 * samples, and therefore nothing to compare against — was labelled a slope.
 *
 * That is the worst shape this defect takes in this codebase, because `'slope'`
 * is not a neutral placeholder in the vocabulary. It means "gradients run one
 * way", which is a claim about where water goes. A reader seeing `slope` acts
 * on it; a reader seeing `null` opens the map. The floor below is 3 comparable
 * samples, which is the smallest count at which "more of the surroundings are
 * higher than the centre" means anything about the shape rather than about the
 * sampling.
 *
 * The counts are taken here rather than as a fraction because a fraction has
 * already lost the information that distinguishes "0 of 40" from "0 of 0".
 */
export const MIN_TERRAIN_COMPARABLES = 3

export function terrainLabelForSamples({ higher = 0, comparable = 0, relief = 0, centreFinite = true } = {}) {
  if (!centreFinite || comparable < MIN_TERRAIN_COMPARABLES) return null
  return terrainLabel(higher / comparable, relief)
}

/** Why there is no terrain label, or null when there is one. */
function terrainRefusal(comparable, centreFinite) {
  if (!centreFinite) {
    return 'the centre terrain sample is not finite, so no surrounding sample can be compared against it'
  }
  if (comparable < MIN_TERRAIN_COMPARABLES) {
    return `only ${comparable} comparable surrounding sample(s) of the ${MIN_TERRAIN_COMPARABLES} required; below that the fraction of higher samples cannot describe the shape`
  }
  return null
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
  const unresolved = profile.find((p) => p.datum_resolved === false)
  return {
    lat,
    lon,
    levels_m: levels,
    profile,
    onset_level_m: onset ? onset.level_m : null,
    data_available: !unavailable || profile.some((p) => p.data_available === true),
    // Distinct from data_available: we have terrain here, and the point is dry
    // at every level asked about. That is a real answer, not a gap.
    //
    // When the datum is unresolved this is not a real answer at all — we have
    // terrain and cannot say what reference it is measured against — so it is
    // null rather than the false "not inundated" that Boolean(onset) would give.
    inundated: unresolved ? null : Boolean(onset),
    datum_resolved: !unresolved,
    reason: unresolved
      ? unresolved.reason
      : (unavailable && profile.every((p) => p.data_available === false) ? unavailable.reason : null),
    vertical_reference: profile[0]?.vertical_reference ?? null,
    vertical_resolution_m: 15,
    source: 'AWS terrain-tiles-prod (Terrarium/SRTM)',
    generated_at: new Date().toISOString(),
  }
}