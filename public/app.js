// =============================================================
// Lindela Lite — Operations Console
// =============================================================
import { REGION_POLYGONS, INDIAN_OCEAN_POLYGON, LAKE_VICTORIA, PILOT_DISTRICTS } from '/shared/basemap.js'
import { FLOOD_DEPTH_BANDS, floodCellsForGrid, floodCoverage, surveyedAreaKm2 } from '/shared/flood-bands.js'
import { globalEventQuery, isFinitePoint, localEventQuery, mapFrame, mergeEventSets } from '/shared/map-frame.js'
import { seasonalNarrative, seasonalPhaseLabel, readSeasonalState } from '/shared/seasonal.js'
import { fillAppVersion } from '/shared/app-version.js'
import { apiFetch, apiSettled, initOfflineQueue, initServiceWorker } from '/shared/runtime.js'
import { applyLocaleToDocument, esc as escapeHtml, formatTimestamp, metres, num, pct, safeClass, sevClass, signed, truncate, truncateId } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'
import { formatRelative } from '/shared/fmt.js'

initServiceWorker()

// =============================================================
// State
// =============================================================
const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  catalog: {},
  activeTab: 'alerts',
  alertFilter: 'all',
  workflowTypeFilter: null,
  mapTransform: { x: 0, y: 0, scale: 1 },
  mapDragging: false,
  mapDragStart: null,
  data: {},
  reports: [],
  templates: [],
  filters: {
    coldChain: false,
  },
  _paletteItems: [],
  _paletteIndex: 0,
  _dispatchGateAlert: null,
  // A source restored from the URL before /api/v1/sources has populated the
  // filter; consumed by the next populateMapSourceFilter.
  _restoredSource: null,
  // Flood simulation and road status overlays. floodAreaKey records which
  // district the current grid covers; the overlays survive map re-renders and
  // are redrawn from here.
  floodGrid: null,
  floodAreaKey: null,
  floodFocus: null,
  routeFocus: null,
  roadAccess: [],
  showRoads: false,
  // IPC area overlay + food-security/outbreak strips. ipcRecords holds only
  // the current-window area records the overlay draws; the strip reads the
  // server-side summary so 4,500 records never cross the wire twice.
  foodSecurity: [],
  diseaseSummary: null,
  showIpcAreas: false,
  climate: [],
  routePlan: null,
  roadsById: new Map(),
  // workflow type -> Set of alert ids that a workflow of that type governs.
  // Built once per refresh so the ribbon tiles can filter the alert rail.
  workflowAlertIds: {},
}

// =============================================================
// DOM references
// =============================================================
const $ = (id) => document.getElementById(id)

const apiKeyInput       = $('apiKeyInput')
const storageMode       = $('storageMode')
const offlineBanner     = $('offlineBanner')
const queuedBadge       = $('queuedBadge')
const connectionStatus  = $('connectionStatus')
const statusText        = $('status')
const sourceDots        = $('sourceDots')
const queuedCount       = $('queuedCount')

// =============================================================
// API key
// =============================================================
const savedApiKey = localStorage.getItem('lindela_lite_api_key') || ''
if (apiKeyInput) {
  apiKeyInput.value = savedApiKey
  apiKeyInput.addEventListener('input', () => {
    const value = apiKeyInput.value.trim()
    if (value) localStorage.setItem('lindela_lite_api_key', value)
    else localStorage.removeItem('lindela_lite_api_key')
  })
}

function authHeaders(headers = {}) {
  const apiKey = apiKeyInput?.value.trim()
  return apiKey ? { ...headers, 'x-api-key': apiKey } : headers
}

// =============================================================
// Utilities
// =============================================================
// escapeHtml, safeClass and the date formatters now live in /shared/fmt.js.
// They were duplicated here, and in six other surfaces, with enough drift that
// the same value rendered three ways.

function displayDate(value) {
  return escapeHtml(formatTimestamp(value))
}

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

// =============================================================
// i18n
// =============================================================
/**
 * Load a locale with English as the base layer.
 *
 * This used to replace the catalogue outright, so any key the active locale did
 * not have rendered as the raw key name. The dashboard offered nine languages
 * and was complete in two, so a Somali or French operator saw
 * `equity.acknowledged` as a column header. A missing translation should degrade
 * to English, not to a key.
 *
 * English is loaded first and the active locale layered over it, so a partially
 * translated locale shows English where it has no translation and its own text
 * where it does. Coverage is reported by scripts/check-i18n.mjs, so a gap is
 * visible rather than silently masked.
 */
async function loadLocale(locale) {
  const catalog = {}
  try {
    const base = await fetch('/i18n/en.json')
    if (base.ok) Object.assign(catalog, await base.json())
  } catch {
    // No English either: the key itself is all we have.
  }
  if (locale !== 'en') {
    try {
      const res = await fetch(`/i18n/${locale}.json`)
      if (res.ok) Object.assign(catalog, await res.json())
    } catch {
      // Keep the English layer.
    }
  }
  state.catalog = catalog
  // lang and dir come from the shared locale table rather than an `=== 'ar'`
  // test here, so adding an RTL locale is a one-line change in one place.
  applyLocaleToDocument(locale)
  applyI18n()
}

function t(key, vars = {}) {
  let str = state.catalog[key] || key
  for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, String(v))
  return str
}

function applyI18n() {
  applyLocaleToDocument(state.locale)
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n
    el.textContent = t(key)
  })
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle)
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder)
  })
}

// =============================================================
// Flood depth overlay
// =============================================================

/**
 * Single writer for the flood status line. Routed through one function so the
 * live-region text and the visible text cannot drift, and so a missing element
 * degrades to console output instead of throwing mid-render.
 */
function setFloodStatus(message) {
  if (floodStatusEl) floodStatusEl.textContent = message
  else console.warn('[flood]', message)
}

/**
 * Draws the depth grid as SVG rects in map space, so it stays crisp under the
 * existing pan/zoom transform instead of being rasterised once.
 *
 * Geometry and banding live in shared/flood-bands.js so they can be tested
 * without a DOM; this function only turns cells into elements.
 */
function renderFloodLayer(grid, bbox) {
  if (!mapFloodEl) return
  mapFloodEl.innerHTML = ''
  const cells = floodCellsForGrid(grid, (lat, lon) => project(lat, lon, bbox))
  for (const cell of cells) {
    const rect = svgEl('rect', {
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      class: `flood-cell flood-${safeClass(cell.band.key)}`,
    })
    const title = svgEl('title')
    title.textContent = `${cell.depth.toFixed(2)} m deep — ${cell.band.note}`
    rect.append(title)
    mapFloodEl.append(rect)
  }
}

/** Road status overlay: cut-off segments need to read as impassable at a glance. */
function renderRoadLayer(roads, bbox) {
  if (!mapRoadsEl) return
  mapRoadsEl.innerHTML = ''
  for (const r of roads) {
    if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const status = r.access_status || 'passable'
    const dot = svgEl('circle', {
      cx: x, cy: y,
      r: status === 'impassable' ? 5 : status === 'restricted' ? 4 : 2.5,
      class: `road-marker road-${safeClass(status)}`,
    })
    const title = svgEl('title')
    title.textContent = `${r.road_name || 'Road'} — ${status}${r.access_reason ? `: ${r.access_reason}` : ''}`
    dot.append(title)
    mapRoadsEl.append(dot)
  }
}

/**
 * IPC area overlay: one shaded bounding box per current-window area record.
 *
 * Two honesty rules are enforced here. First, the shading bands are bands of
 * the *published* Phase 3+ fraction — thresholds chosen for legibility, not a
 * re-classification of IPC's work; IPC's own phase for the area is not
 * recomputed. Second, a bbox is drawn with a dashed edge and a title that says
 * what it is, because a rectangle includes neighbouring ground the
 * classification does not cover and a solid fill would read as a footprint.
 */
const IPC_FRACTION_BANDS = [
  { key: 'low', max: 0.15, note: 'Phase 3+ below 15% of analysed population' },
  { key: 'medium', max: 0.3, note: 'Phase 3+ 15-30% of analysed population' },
  { key: 'high', max: 0.4, note: 'Phase 3+ 30-40% of analysed population' },
  { key: 'severe', max: Infinity, note: 'Phase 3+ above 40% of analysed population' },
]

function renderFoodSecurityLayer(records, bbox) {
  if (!mapFoodSecurityEl) return
  mapFoodSecurityEl.innerHTML = ''
  for (const r of records) {
    const box = r.bbox
    if (!box || ![box.west, box.south, box.east, box.north].every(Number.isFinite)) continue
    const fraction = r.phase3plus_fraction
    // No published Phase 3+ figure: coverage is still drawn, as a neutral
    // outline with the fact in the title — shading it green would invent a value.
    if (!Number.isFinite(fraction)) {
      const nw0 = project(Math.min(box.north, 90), box.west, bbox)
      const se0 = project(Math.max(box.south, -90), box.east, bbox)
      const outline = svgEl('rect', {
        x: Math.min(nw0.x, se0.x), y: Math.min(nw0.y, se0.y),
        width: Math.abs(se0.x - nw0.x), height: Math.abs(se0.y - nw0.y),
        class: 'food-cell food-unclassified',
      })
      const title0 = svgEl('title')
      title0.textContent = `${r.area || 'National'} (${r.country}) — IPC classification present; no Phase 3+ figure published for this window.`
      outline.append(title0)
      mapFoodSecurityEl.append(outline)
      continue
    }
    const band = IPC_FRACTION_BANDS.find((b) => fraction < b.max) || IPC_FRACTION_BANDS[IPC_FRACTION_BANDS.length - 1]
    const nw = project(Math.min(box.north, 90), box.west, bbox)
    const se = project(Math.max(box.south, -90), box.east, bbox)
    const rect = svgEl('rect', {
      x: Math.min(nw.x, se.x),
      y: Math.min(nw.y, se.y),
      width: Math.abs(se.x - nw.x),
      height: Math.abs(se.y - nw.y),
      class: `food-cell food-${band.key}`,
    })
    const people = Number.isFinite(r.phase3plus_number)
      ? ` — ${r.phase3plus_number.toLocaleString()} people`
      : ''
    const title = svgEl('title')
    title.textContent = `${r.area || 'National'} (${r.country}) — IPC Phase 3+ ${Number.isFinite(fraction)
      ? `${Math.round(fraction * 100)}% of analysed population` : 'not published'}${people}, ` +
      `${r.valid_from} to ${r.valid_to}. Bounding box, not the mapped polygon.`
    rect.append(title)
    rect.addEventListener('click', () => openDetailDialog(r))
    mapFoodSecurityEl.append(rect)
  }
}

/**
 * Pilot districts the flood simulation can be run over.
 *
 * The area must be chosen explicitly. Framing the map on the whole region of
 * interest and simulating its centre produces ocean — the pilot region spans
 * roughly 25 degrees, which is far too large for the terrain service to serve
 * at a meaningful zoom, and the middle of that box is Sudan and the Red Sea,
 * not anywhere the operator is working.
 */
const FLOOD_SIM_AREAS = {
  turkana: { name: 'Turkana', country: 'KE', lat: 3.1167, lon: 35.6, spanDeg: 0.6, defaultLevelM: 500 },
  karamoja: { name: 'Karamoja', country: 'UG', lat: 2.5333, lon: 34.6667, spanDeg: 0.6, defaultLevelM: 1000 },
  bor: { name: 'Bor', country: 'SS', lat: 6.207, lon: 31.548, spanDeg: 0.6, defaultLevelM: 400 },
  aweil: { name: 'Aweil', country: 'SS', lat: 8.767, lon: 27.4, spanDeg: 0.6, defaultLevelM: 400 },
  mandera: { name: 'Mandera', country: 'KE', lat: 3.9366, lon: 41.8569, spanDeg: 0.6, defaultLevelM: 1000 },
}
async function loadFloodSimulation() {
  if (!floodLevelInput || !floodSimulateBtn) return
  const raw = floodLevelInput.value.trim()
  // Number('') is 0, so an empty field would otherwise silently simulate sea
  // level and shade the coastline. Require a value the operator actually typed.
  if (raw === '') {
    setFloodStatus('Enter a water surface elevation in metres')
    floodLevelInput.focus()
    return
  }
  const levelM = Number(raw)
  if (!Number.isFinite(levelM)) {
    setFloodStatus(`"${raw}" is not a number. Enter a water level in metres.`)
    return
  }

  const areaKey = floodAreaEl?.value || 'turkana'
  const area = FLOOD_SIM_AREAS[areaKey]
  if (!area) {
    setFloodStatus('Choose an area to simulate')
    return
  }

  floodSimulateBtn.disabled = true
  setFloodStatus(`Simulating ${area.name} at ${levelM} m…`)
  try {
    // The extent is the chosen district, NOT the map frame. The frame spans
    // the whole pilot region, which is far too large for the terrain service
    // to serve at a meaningful zoom, and its centre is ocean.
    const half = area.spanDeg / 2
    const query = new URLSearchParams({
      south: String(area.lat - half),
      north: String(area.lat + half),
      west: String(area.lon - half),
      east: String(area.lon + half),
      level_m: String(levelM),
      grid_size: '64',
    })
    state.floodAreaKey = areaKey
    // Remember the extent so the map can frame on it. Padding keeps the
    // shoreline off the very edge of the viewport.
    const pad = area.spanDeg * 0.6
    state.floodFocus = {
      minLat: area.lat - half - pad,
      maxLat: area.lat + half + pad,
      minLon: area.lon - half - pad,
      maxLon: area.lon + half + pad,
    }
    const body = await fetchJson(`/api/v1/flood-depth?${query}`)
    if (!body?.success || !body.data?.depth_grid) {
      state.floodGrid = null
      setFloodStatus(body?.error || 'No flood data for this area')
      reRenderMapFromState()
      return
    }

    state.floodGrid = body.data
    const level = body.data.per_level?.[0]
    const coverage = floodCoverage(body.data.depth_grid)
    // The grid covers a box around the area, not the area itself, so the share
    // has to name what it is a share of. Labelling it "of the area" invited
    // reading 40% of Turkana as underwater when the flooded footprint is a
    // specific and much smaller part of the district.
    const b = body.data.bounds
    const surveyedKm2 = surveyedAreaKm2(b)
    setFloodStatus(
      level
        ? `${area.name} at ${levelM} m: ${level.area_sq_km.toFixed(0)} km² below water `
          + `— ${level.coverage_pct}% of the ${surveyedKm2} km² surveyed around `
          + `${area.name}, deepest cell ${coverage.max_depth_m.toFixed(1)} m. `
          + `This is the flooded footprint within the surveyed box, not a share `
          + `of the district. ${body.data.model}. `
          + `Elevation ±${body.data.vertical_resolution_m} m.`
        : 'Simulation complete.',
    )
    reRenderMapFromState()
    renderFloodLegendBox(body.data)
  } catch (error) {
    setFloodStatus(`Flood simulation failed: ${error.message}`)
  } finally {
    floodSimulateBtn.disabled = false
  }
}

function renderFloodLegendBox(grid) {
  if (!floodLegendEl) return
  if (!grid) { floodLegendEl.hidden = true; floodLegendEl.innerHTML = ''; return }
  floodLegendEl.hidden = false
  const rows = FLOOD_DEPTH_BANDS.map((b) =>
    `<li><span class="flood-swatch flood-${b.key}"></span><span class="flood-band">${escapeHtml(b.label)}</span><span class="flood-note">${escapeHtml(b.note)}</span></li>`
  ).join('')
  floodLegendEl.innerHTML = `
    <h3 class="legend-title">Flood depth at ${escapeHtml(grid.level_m)} m</h3>
    <ul class="flood-legend-list">${rows}</ul>
    <p class="legend-note">${escapeHtml(grid.model)}. Elevation ±${escapeHtml(grid.vertical_resolution_m)} m from SRTM.</p>`
}

function clearFloodSimulation() {
  state.floodGrid = null
  state.floodFocus = null
  state.floodAreaKey = null
  if (floodLegendEl) { floodLegendEl.hidden = true; floodLegendEl.innerHTML = '' }
  setFloodStatus('Flood overlay cleared')
  reRenderMapFromState()
}

/** Loads road status so cut-off segments appear on the map. */
/**
 * Draws the planned route.
 *
 * Road assets are points, not lines, so this does NOT draw a polyline between
 * hops. A straight line between two road markers would be an invented geometry
 * claim — the routing module refuses to return one, and the overlay must not
 * imply the router knows where the road physically runs. Instead it rings the
 * roads on the path in route order, and the numbered hop list carries the
 * sequence.
 */
/**
 * The extent a planned route should frame on, from the roads it actually uses.
 *
 * Derived from the returned hops rather than the requested endpoints, because a
 * plan that reroutes around a cut segment does not pass through either. Falls
 * back to the requested endpoints when the plan carries no usable hops, which is
 * the infeasible case: the map should still show where the operator asked to go.
 */
function routeFocusFor(plan, requested) {
  const leg = plan?.legs?.find((l) => l.feasible) || plan?.legs?.[0]
  const points = []
  for (const hop of leg?.hops || []) {
    const road = state.roadsById.get(hop.id)
    if (road && Number.isFinite(road.latitude) && Number.isFinite(road.longitude)) {
      points.push({ lat: road.latitude, lon: road.longitude })
    }
  }
  if (!points.length) {
    for (const id of [requested?.from, ...(requested?.to || [])]) {
      const road = state.roadsById.get(id)
      if (road && Number.isFinite(road.latitude) && Number.isFinite(road.longitude)) {
        points.push({ lat: road.latitude, lon: road.longitude })
      }
    }
  }
  if (points.length < 2) return null

  // A little padding so the first and last hop markers are not on the frame edge.
  const spanLat = Math.max(...points.map((p) => p.lat)) - Math.min(...points.map((p) => p.lat))
  const spanLon = Math.max(...points.map((p) => p.lon)) - Math.min(...points.map((p) => p.lon))
  const pad = Math.max(spanLat, spanLon) * 0.35 || 0.05
  return {
    minLat: Math.min(...points.map((p) => p.lat)) - pad,
    maxLat: Math.max(...points.map((p) => p.lat)) + pad,
    minLon: Math.min(...points.map((p) => p.lon)) - pad,
    maxLon: Math.max(...points.map((p) => p.lon)) + pad,
  }
}

function renderRouteLayer(plan, bbox) {
  if (!mapRouteEl) return
  mapRouteEl.innerHTML = ''
  const leg = plan?.legs?.find((l) => l.feasible) || plan?.legs?.[0]
  if (!leg) return

  const ring = svgEl('circle', {
    cx: 0, cy: 0, r: 11,
    class: 'route-halo',
  })
  const title = svgEl('title')
  title.textContent = `Planned route: ${leg.hops?.map((h) => h.name).join(' -> ')}`
  ring.append(title)

  leg.hops?.forEach((hop, index) => {
    const road = state.roadsById.get(hop.id)
    if (!road || !Number.isFinite(road.latitude) || !Number.isFinite(road.longitude)) return
    const { x, y } = project(road.latitude, road.longitude, bbox)
    ring.setAttribute('cx', x)
    ring.setAttribute('cy', y)

    const marker = svgEl('circle', {
      cx: x,
      cy: y,
      r: 8,
      class: `route-hop${hop.access_status === 'restricted' ? ' route-hop-restricted' : ''}`,
    })
    const order = svgEl('text', {
      x, y: y + 3.5,
      class: 'route-hop-order',
      'text-anchor': 'middle',
    })
    order.textContent = String(index + 1)
    const hopTitle = svgEl('title')
    hopTitle.textContent = `${index + 1}. ${hop.name} (${hop.road_class})`
    marker.append(hopTitle)

    mapRouteEl.append(ring)
    mapRouteEl.append(marker)
    mapRouteEl.append(order)
  })
}

/**
 * Renders the seasonal-context strip.
 *
 * The wording is the point. This reports an advisory and how many of CPC's five
 * consecutive overlapping seasons currently qualify. It never says "El Ni\u00f1o"
 * on its own, because one warm month is not a declared ENSO event and a panel
 * reading a bare phase name would reasonably assume it was.
 */
function renderSeasonalStrip(observations) {
  if (!seasonalPhaseEl) return
  const state = readSeasonalState(observations)

  if (seasonalPhaseEl) {
    seasonalPhaseEl.textContent = seasonalPhaseLabel(state)
    seasonalPhaseEl.className = `seasonal-phase seasonal-phase-${state ? state.phase : 'unknown'}`
  }
  if (seasonalAnomalyEl) {
    seasonalAnomalyEl.textContent = state ? `${state.anomalyC > 0 ? '+' : ''}${state.anomalyC.toFixed(2)} \u00b0C` : '\u2014'
    seasonalAnomalyEl.className = `seasonal-anomaly ${state ? (state.anomalyC >= 0 ? 'is-warm' : 'is-cold') : ''}`
  }
  if (seasonalPeriodEl) seasonalPeriodEl.textContent = state ? state.period : ''

  if (seasonalPipsEl) {
    const required = state ? state.seasonsRequired : 5
    const met = state ? Math.min(state.overlappingSeasons, required) : 0
    seasonalPipsEl.innerHTML = Array.from({ length: required }, (_, i) => (
      `<span class="seasonal-pip${i < met ? ' is-met' : ''}"></span>`
    )).join('')
  }
  if (seasonalSeasonsEl) {
    seasonalSeasonsEl.textContent = state
      ? `${Math.min(state.overlappingSeasons, state.seasonsRequired)} of ${state.seasonsRequired} seasons`
      : ''
  }
  if (seasonalNoteEl) seasonalNoteEl.textContent = seasonalNarrative(state)
  if (seasonalIndexEl && state?.indexUsed) {
    seasonalIndexEl.textContent = `Niño 3.4 SST anomaly (${state.indexUsed})`
  }
}

/** Fills the origin and destination selects from the imported road assets. */
function populateRouteEndpoints(roads) {
  if (!routeFromEl || !routeToEl) return
  state.roadsById = new Map((roads || []).map((r) => [r.id, r]))
  const options = (roads || [])
    .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
    .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`)
    .join('')
  if (!options) return

  const previousFrom = routeFromEl.value
  const previousTo = routeToEl.value
  routeFromEl.innerHTML = options
  routeToEl.innerHTML = options
  if (previousFrom) routeFromEl.value = previousFrom
  if (previousTo) routeToEl.value = previousTo
  // Default to the first two distinct roads so the control is usable
  // immediately rather than requiring two selections before anything happens.
  if (!routeFromEl.value) routeFromEl.selectedIndex = 0
  if (!routeToEl.value || routeToEl.value === routeFromEl.value) {
    routeToEl.selectedIndex = routeFromEl.selectedIndex === 0 ? 1 : 0
  }
}

async function planRoute() {
  if (!routeFromEl || !routeToEl || !routePlanBtn) return
  const from = routeFromEl.value
  const to = routeToEl.value
  if (!from || !to) return
  if (from === to) {
    state.routePlan = null
    state.routeFocus = null
    renderRouteHops(null)
    setRouteStatus('Origin and destination must be different roads.')
    reRenderMapFromState()
    return
  }

  routePlanBtn.disabled = true
  setRouteStatus('Planning…')
  try {
    // postJson, not fetchJson: fetchJson only forwards a path, so passing
    // request options to it silently issued a GET and got a 404 back.
    const body = await postJson('/api/v1/routing/plan', { from, to: [to] })
    const plan = body.data || body
    state.routePlan = plan
    // Frame on the route the way a flood simulation frames on its extent.
    // Without this the map stayed on the whole Horn, where the Lodwar corridor
    // is four roads inside six kilometres and the reroute that is the entire
    // point of the feature collapsed into one unreadable cluster.
    state.routeFocus = routeFocusFor(plan, { from, to: [to] })
    renderRouteHops(plan)
    setRouteStatus(describeRoutePlan(plan))
    reRenderMapFromState()
  } catch (error) {
    state.routePlan = null
    renderRouteHops(null)
    setRouteStatus(`Routing failed: ${error.message}`)
    reRenderMapFromState()
  } finally {
    routePlanBtn.disabled = false
  }
}

/** Plain-language summary, including the honest failure case. */
function describeRoutePlan(plan) {
  const leg = plan?.legs?.[0]
  if (!leg) return 'No route returned.'
  if (!leg.feasible) {
    const severed = (leg.severed_by || []).map((b) => b.name).join(', ')
    return `No feasible road route: ${leg.reason}. `
      + (severed ? `Cut-off segment(s): ${severed}.` : '')
      + ' Needs an alternative modality, a different distribution point, or the obstruction cleared.'
  }
  const via = leg.hops.map((h) => h.name).join(' → ')
  return `${via}. ${leg.total_distance_km} km, about ${leg.total_minutes} min by `
    + `${leg.mode}${leg.degraded ? ' — degraded, relies on a restricted segment' : ''}. `
    + `Road classes used: ${[...new Set(leg.road_classes)].join(', ')}. `
    + 'Impassable segments are removed from the network, not penalised.'
}

function renderRouteHops(plan) {
  if (!routeHopsEl) return
  const leg = plan?.legs?.[0]
  if (!leg?.hops?.length) {
    routeHopsEl.hidden = true
    routeHopsEl.innerHTML = ''
    return
  }
  routeHopsEl.hidden = false
  routeHopsEl.innerHTML = leg.hops.map((hop, index) => `
    <li class="route-hop-row${hop.access_status === 'restricted' ? ' is-restricted' : ''}">
      <span class="route-hop-index">${index + 1}</span>
      <span class="route-hop-name">${escapeHtml(hop.name)}</span>
      <span class="route-hop-class">${escapeHtml(hop.road_class)}</span>
      <span class="route-hop-status">${escapeHtml(hop.access_status)}</span>
    </li>`).join('')
}

function setRouteStatus(message) {
  if (routeStatusEl) routeStatusEl.textContent = message
  else console.warn('[route]', message)
}

function clearRoutePlan() {
  state.routePlan = null
  state.routeFocus = null
  renderRouteHops(null)
  setRouteStatus('Route cleared. Routing works over imported road assets.')
  reRenderMapFromState()
}

async function loadRoadStatus() {
  try {
    const body = await fetchJson('/api/v1/road-access')
    if (body?.success) {
      state.roadAccess = body.data || []
      const cut = body.summary?.impassable || 0
      if (roadStatusEl && roadOverlayToggle?.checked) {
        roadStatusEl.textContent = cut
          ? `${cut} of ${body.summary.total_roads} roads impassable`
          : `All ${body.summary.total_roads} roads passable`
      }
      if (roadOverlayToggle?.checked) reRenderMapFromState()
    }
  } catch {
    state.roadAccess = []
  }
}

/**
 * IPC area overlay loader. Records are the current-window area rows only —
 * projections and national records are classification, not something to shade
 * a map with — and the summary strip reads the server's roll-up so the light
 * payload is loaded even when the overlay is off.
 */
async function loadIpcOverlay() {
  try {
    const list = await fetchJson('/api/v1/food-security?limit=5000')
    if (list?.success) {
      state.foodSecurity = (list.data || []).filter(
        (r) => r.scope === 'area' && r.validity_period === 'current')
      const withBox = state.foodSecurity.filter((r) => r.bbox).length
      if (ipcStatusEl && ipcOverlayToggle?.checked) {
        ipcStatusEl.textContent = withBox
          ? `${withBox} IPC areas shaded by published Phase 3+ share; boxes include neighbouring ground`
          : 'No IPC area geometry matched — see food-security records for the classifications'
      }
      if (ipcOverlayToggle?.checked) reRenderMapFromState()
    }
  } catch {
    if (ipcStatusEl) ipcStatusEl.textContent = 'IPC food-security data unavailable'
  }
}

async function loadFoodSecuritySummary() {
  try {
    const body = await fetchJson('/api/v1/food-security/summary')
    if (body?.success) renderFoodSecurityStrip(body.data)
  } catch {
    if (ipcStripEl) ipcStripEl.hidden = true
  }
}

function renderFoodSecurityStrip(summary) {
  if (!ipcStripEl) return
  const worst = summary?.worst_areas?.[0]
  const countryCount = summary?.countries?.length || 0
  const areaCount = (summary?.worst_areas || []).length
  ipcStripEl.hidden = !worst && !countryCount
  if (!worst && !countryCount) return
  if (worst) {
    const pct = Number.isFinite(worst.phase3plus_fraction)
      ? `${Math.round(worst.phase3plus_fraction * 100)}%`
      : '—'
    ipcWorstValueEl.textContent = `Worst area: ${worst.area || 'unknown'} (${worst.country}) — Phase 3+ ${pct}${
      Number.isFinite(worst.phase3plus_number) ? `, ${worst.phase3plus_number.toLocaleString()} people` : ''}`
    ipcWorstPeriodEl.textContent = `${worst.valid_from} → ${worst.valid_to}`
  }
  ipcAreasEl.textContent = `${countryCount} countries · ${areaCount} worst areas`
  ipcAreasEl.className = `seasonal-phase ${worst ? '' : 'seasonal-phase-unknown'}`
}

/**
 * Outbreak strip. State wording mirrors who-gho's verdicts: a stale series is
 * a data fact (publication stopped), not a disease fact.
 */
async function loadDiseaseSummary() {
  try {
    const body = await fetchJson('/api/v1/disease-observations/summary')
    if (!body?.success) return
    state.diseaseSummary = body.data
    const states = body.data?.series_state || []
    if (!states.length) {
      diseaseStripEl.hidden = true
      return
    }
    diseaseStripEl.hidden = false
    const stale = states.filter((s) => s.state === 'stale').length
    const current = states.filter((s) => s.state === 'current').length
    diseaseSeriesStateEl.textContent = `${states.length} indicator series · ${current} current · ${stale} stale`
    diseaseSeriesStateEl.className = `seasonal-phase ${stale === states.length ? 'seasonal-phase-unknown' : ''}`
    const latest = states.reduce((a, b) => (b.latest_year > (a?.latest_year || 0) ? b : a), null)
    if (latest) {
      diseaseLatestEl.textContent = `${latest.indicator_name}: latest data ${latest.latest_year}`
      diseaseLatestMetaEl.textContent = latest.state !== 'current' ? `${latest.years_behind_calendar}y behind calendar` : ''
    }
    diseaseNoteEl.textContent = `National annual aggregates. Context, not district evidence; not an alert trigger.` +
      (stale ? ` Series marked stale have stopped publishing; silence is absence of published data, not absence of disease.` : '')
  } catch {
    if (diseaseStripEl) diseaseStripEl.hidden = true
  }
}

/**
 * Flood-probability strip. Shows the trained models the store holds, one per
 * district — including districts that returned a refusal, because "this
 * district has 40 months, not the 60 required" is a fact a reader can act on,
 * while a blank strip would read as a missing widget.
 */
async function loadFloodProbabilityModels() {
  try {
    const body = await fetchJson('/api/v1/flood-probability/models')
    if (!body?.success) return
    const models = body.data || []
    if (!models.length) {
      if (floodProbStripEl) floodProbStripEl.hidden = true
      return
    }
    floodProbStripEl.hidden = false
    const okModels = models.filter((m) => m.model)
    floodProbRegionsEl.textContent = `${okModels.length} district${okModels.length === 1 ? '' : 's'} trained · ${models.length - okModels.length} refused`
    floodProbRegionsEl.className = `seasonal-phase ${okModels.length ? '' : 'seasonal-phase-unknown'}`
    // Highest validated skill among refits wins the headline; a model without
    // LOYO scores leads with its sample size instead.
    const best = okModels
      .filter((m) => Number.isFinite(m.folds?.folds?.skill_over_base_rate))
      .sort((a, b) => b.folds.folds.skill_over_base_rate - a.folds.folds.skill_over_base_rate)[0]
    const bestAny = best || okModels[0]
    if (bestAny) {
      const t = bestAny.model.training
      const skill = bestAny.folds?.folds?.skill_over_base_rate
      floodProbBestEl.textContent = `${bestAny.region_name}: ${Math.round((t.base_rate || 0) * 100)}% flood-month base rate`
        + (Number.isFinite(skill) ? `, skill +${Math.round(skill * 100)}% over base rate` : '')
      floodProbBestMetaEl.textContent = `${t.months} months · ${t.flood_months} flood months · trained ${String(bestAny.trained_at).slice(0, 10)}`
    }
    const refused = models.filter((m) => !m.model)
    const notes = []
    for (const r of refused) {
      notes.push(`${r.region_name}: ${r.refusal || r.model || 'no model'}`)
    }
    floodProbNoteEl.textContent = 'Empirical rainfall–flood co-occurrence trained on ERA5 daily precipitation and '
      + 'reported GDACS floods. Reporting-conditioned: the probability is a flood entering the archive, '
      + 'not water at a given elevation.'
      + (notes.length ? ` Not trained: ${notes.join('; ')}.` : '')
  } catch {
    if (floodProbStripEl) floodProbStripEl.hidden = true
  }
}

// =============================================================
// Fetch helpers
// =============================================================
// Both of these used to check only that the response parsed, never that it
// succeeded. A 503 from the service worker's offline fallback arrived as
// {error:'Offline'}, which every caller then read as data.
async function fetchJson(path) {
  return apiFetch(path, { headers: authHeaders() })
}

async function postJson(path, body) {
  return apiFetch(path, { method: 'POST', body, headers: authHeaders() })
}

// =============================================================
// Status bar
// =============================================================
function setStatus(message) {
  statusText.textContent = message
}

// =============================================================
// Offline
// =============================================================
function updateConnectionStatus() {
  const online = navigator.onLine
  offlineBanner.hidden = online
  connectionStatus.textContent = online ? 'online' : 'offline'
  connectionStatus.className = `badge badge-connection${online ? '' : ' offline'}`
}

window.addEventListener('online', () => {
  updateConnectionStatus()
  window.lindelaQueue?.flush()
})
window.addEventListener('offline', updateConnectionStatus)
updateConnectionStatus()

/**
 * The offline queue.
 *
 * This posted `{type:'queueRequest'}` to the service worker, which only ever
 * handled `{type:'flushQueue'}`, and wrote nothing to IndexedDB itself — so the
 * message was discarded, the counter incremented forever, and the status bar
 * promised "N queued" for records that existed nowhere. A correct implementation
 * already existed in shared/runtime.js and was not imported.
 *
 * Now it is that implementation, with the console's own pending-count readout
 * driven by the store rather than by a counter.
 */
initOfflineQueue().then(() => {
  const paint = () => {
    window.lindelaQueue?.pendingCount().then((count) => {
      const label = `${count} queued`
      if (queuedCount) { queuedCount.textContent = label; queuedCount.hidden = count === 0 }
      if (queuedBadge) { queuedBadge.textContent = label; queuedBadge.hidden = count === 0 }
    })
  }
  paint()
  window.addEventListener('lindela-queue-changed', paint)
  window.addEventListener('lindela-queue-flushed', paint)
})

/** Submit now, or persist for replay when there is no connection. */
async function queueRequest(url, body) {
  if (navigator.onLine) return postJson(url, body)
  await window.lindelaQueue?.enqueue(url, { method: 'POST', body, headers: authHeaders() })
  return { success: true, queued: true }
}

// =============================================================
// SVG Map
// =============================================================
const SVG_W = 800
const SVG_H = 500
const DEFAULT_BBOX = { minLat: -2, maxLat: 12, minLon: 29, maxLon: 46 }

const mapEl           = $('situationMap')
const mapTransformEl  = $('mapTransform')
const mapOceanEl      = $('mapOcean')
const mapLandEl       = $('mapLand')
const mapDistrictsEl  = $('mapDistricts')
const mapGraticuleEl  = $('mapGraticule')
const mapHazardsEl    = $('mapHazards')
const mapAssetsEl     = $('mapAssets')
const mapRiskEl       = $('mapRisk')
const mapFloodEl      = $('mapFlood')
const mapRoadsEl      = $('mapRoads')
const mapRouteEl      = $('mapRoute')
const mapFoodSecurityEl = $('mapFoodSecurity')
const seasonalIndexEl    = $('seasonalIndex')
const seasonalPhaseEl    = $('seasonalPhase')
const seasonalAnomalyEl  = $('seasonalAnomaly')
const seasonalPeriodEl   = $('seasonalPeriod')
const seasonalPipsEl     = $('seasonalPips')
const seasonalSeasonsEl  = $('seasonalSeasonsText')
const seasonalNoteEl     = $('seasonalNote')
const routeFromEl      = $('routeFrom')
const routeToEl        = $('routeTo')
const routePlanBtn     = $('routePlan')
const routeClearBtn    = $('routeClear')
const routeStatusEl    = $('routeStatus')
const routeHopsEl      = $('routeHops')
const mapLegendEl     = $('mapLegend')
const mapDefsEl       = $('mapDefs')
const floodLegendEl   = $('floodLegend')
const floodStatusEl   = $('floodStatus')
const floodAreaEl  = $('floodArea')
const floodLevelInput = $('floodLevelInput')
const floodSimulateBtn = $('floodSimulate')
const floodClearBtn   = $('floodClear')
const roadOverlayToggle = $('roadOverlayToggle')
const roadStatusEl       = $('roadStatus')
const ipcOverlayToggle   = $('ipcOverlayToggle')
const ipcStatusEl        = $('ipcStatus')
const ipcStripEl         = $('ipcStrip')
const ipcAreasEl         = $('ipcAreas')
const ipcWorstValueEl    = $('ipcWorstValue')
const ipcWorstPeriodEl   = $('ipcWorstPeriod')
const diseaseStripEl     = $('diseaseStrip')
const diseaseSeriesStateEl = $('diseaseSeriesState')
const diseaseLatestEl    = $('diseaseLatest')
const diseaseLatestMetaEl = $('diseaseLatestMeta')
const diseaseNoteEl      = $('diseaseNote')
const floodProbStripEl   = $('floodProbStrip')
const floodProbRegionsEl = $('floodProbRegions')
const floodProbBestEl    = $('floodProbBest')
const floodProbBestMetaEl = $('floodProbBestMeta')
const floodProbNoteEl    = $('floodProbNote')

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}


function project(lat, lon, bbox) {
  const x = ((lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * SVG_W
  const y = ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * SVG_H
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}

function renderGraticule(bbox) {
  mapGraticuleEl.innerHTML = ''
  const step = 5
  const latS = Math.ceil(bbox.minLat / step) * step
  const latE = Math.floor(bbox.maxLat / step) * step
  const lonS = Math.ceil(bbox.minLon / step) * step
  const lonE = Math.floor(bbox.maxLon / step) * step

  for (let lat = latS; lat <= latE; lat += step) {
    const a = project(lat, bbox.minLon, bbox)
    const b = project(lat, bbox.maxLon, bbox)
    mapGraticuleEl.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
    const lbl = svgEl('text', { x: a.x + 3, y: a.y - 3 })
    lbl.textContent = `${lat}°`
    mapGraticuleEl.append(lbl)
  }

  for (let lon = lonS; lon <= lonE; lon += step) {
    const a = project(bbox.maxLat, lon, bbox)
    const b = project(bbox.minLat, lon, bbox)
    mapGraticuleEl.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
    const lbl = svgEl('text', { x: a.x + 2, y: b.y - 3 })
    lbl.textContent = `${lon}°`
    mapGraticuleEl.append(lbl)
  }
}

// Convert a closed ring [[lon,lat],...] to an SVG path d string.
function ringToPath(ring, bbox) {
  return ring.map(([lon, lat], i) => {
    const { x, y } = project(lat, lon, bbox)
    return `${i === 0 ? 'M' : 'L'}${x},${y}`
  }).join(' ') + ' Z'
}

// Approximate km radius to viewBox units, averaging x/y scale at given latitude.
function kmToViewBoxUnits(km, latitude, bbox) {
  const latRad = latitude * Math.PI / 180
  const degLat = km / 111
  const degLon = km / (111 * Math.cos(latRad))
  const xUnits = degLon * SVG_W / (bbox.maxLon - bbox.minLon)
  const yUnits = degLat * SVG_H / (bbox.maxLat - bbox.minLat)
  return (xUnits + yUnits) / 2
}

function renderBasemap(bbox) {
  // Ocean layer
  if (mapOceanEl) {
    mapOceanEl.innerHTML = ''
    for (const ring of [INDIAN_OCEAN_POLYGON, LAKE_VICTORIA]) {
      mapOceanEl.append(svgEl('path', { d: ringToPath(ring, bbox) }))
    }
  }

  // Land layer
  if (mapLandEl) {
    mapLandEl.innerHTML = ''
    for (const [, { name, ring }] of Object.entries(REGION_POLYGONS)) {
      const path = svgEl('path', { d: ringToPath(ring, bbox) })
      const titleEl = svgEl('title')
      titleEl.textContent = name
      path.append(titleEl)
      mapLandEl.append(path)
    }
  }

  // District rings
  if (mapDistrictsEl) {
    mapDistrictsEl.innerHTML = ''
    for (const d of PILOT_DISTRICTS) {
      const { x, y } = project(d.center[1], d.center[0], bbox)
      const r = kmToViewBoxUnits(d.radius_km, d.center[1], bbox)
      mapDistrictsEl.append(svgEl('circle', { cx: x, cy: y, r: Math.round(r * 10) / 10 }))
      const lbl = svgEl('text', { x: x + 4, y: y - r - 3 })
      lbl.textContent = d.name
      mapDistrictsEl.append(lbl)
    }
  }
}

function sevRadius(severity) {
  return { critical: 13, high: 10, medium: 7, low: 5 }[String(severity).toLowerCase()] ?? 5
}

function hazardClass(eventType) {
  const s = String(eventType || '').toLowerCase()
  // Checked before 'flood' so a debris-flow alert, which is a landslide, is not
  // painted as a flood. Both block roads, but they call for different responses.
  if (s.includes('landslide') || s.includes('slide') || s.includes('debris') || s.includes('mud')) return 'hazard-landslide'
  if (s.includes('flood'))                       return 'hazard-flood'
  if (s.includes('storm') || s.includes('cycl')) return 'hazard-storm'
  if (s.includes('fire'))                        return 'hazard-fire'
  if (s.includes('disast') || s.includes('quake')) return 'hazard-disaster'
  if (s.includes('conflict') || s.includes('tension') || s.includes('communal')) return 'hazard-conflict'
  return 'hazard-default'
}

function assetClass(serviceType) {
  const s = String(serviceType || '').toLowerCase()
  if (s.includes('health') || s.includes('clinic') || s.includes('hospital')) return 'asset-health'
  if (s.includes('water'))  return 'asset-water'
  if (s.includes('edu') || s.includes('school')) return 'asset-education'
  return 'asset-default'
}

/** Whether a record carries a bounding box with four finite edges. */
function hasUsableBbox(record) {
  const box = record?.bbox
  return Boolean(box) && [box.west, box.south, box.east, box.north].every(Number.isFinite)
}

// The basemap and the graticule are functions of the frame alone — they never
// look at a record — yet renderMap rebuilt both on every 30-second refresh,
// reallocating a few hundred SVG nodes twice a minute to reproduce the picture
// already on screen. Key the rebuild on the frame, so only a frame that
// actually moved repaints the ground under the data.
let _staticLayerFrame = ''
function renderStaticLayers(bbox) {
  const frame = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`
  if (frame === _staticLayerFrame) return
  _staticLayerFrame = frame
  renderBasemap(bbox)
  renderGraticule(bbox)
}

// Two risk blobs with the same score get the same fade, and the id said nothing
// about the score — it was the blob's position in the array, which changes as
// soon as one record filters out. Keying the definition on the opacity makes it
// reusable; keying it on the index made every frame allocate a fresh copy of a
// handful of distinct fades and threw the old ones away.
const _riskGradients = new Map()
function ensureRiskGradient(opacity) {
  const key = String(opacity)
  const id = `rg-${key.replace('.', '-')}`
  if (_riskGradients.has(id)) return id
  const grad = svgEl('radialGradient', { id, cx: '50%', cy: '50%', r: '50%' })
  grad.append(
    svgEl('stop', { offset: '0%',   'stop-color': 'oklch(65% 0.22 25)', 'stop-opacity': key }),
    svgEl('stop', { offset: '100%', 'stop-color': 'oklch(65% 0.22 25)', 'stop-opacity': '0' }),
  )
  _riskGradients.set(id, grad)
  // <defs> is never cleared now that the gradients outlive a frame. They are
  // addressed by id from the ellipses, not by position, so a stale entry costs
  // nothing and an evicted one would break every blob still pointing at it.
  mapDefsEl?.append(grad)
  return id
}

/** Start of the window a map time filter selects, or null for "all". */
function rangeStart(value) {
  const now = Date.now()
  switch (value) {
    case '24h': return new Date(now - 24 * 3600 * 1000)
    case '7d': return new Date(now - 7 * 24 * 3600 * 1000)
    case '30d': return new Date(now - 30 * 24 * 3600 * 1000)
    default: return null
  }
}

/** The most recent timestamp on a record, whatever field carries it. */
function recordTime(record) {
  const raw = record.occurred_at || record.observed_at || record.first_seen_at ||
              record.created_at || record.generated_at || record.updated_at
  if (!raw) return null
  const t = new Date(raw).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * Whether a record falls inside the selected window.
 *
 * A record with no timestamp at all is kept: "no date" is not "outside the
 * range", and dropping it would silently empty the map whenever a feed omits
 * one. The window bounds what it can exclude, and says nothing about the rest.
 */
function withinRange(record, since) {
  const t = recordTime(record)
  return t === null ? true : t >= since.getTime()
}

/**
 * Whether an asset is a cold-chain node.
 *
 * The connector seeds `meta.cold_chain` on service assets; the map filter reads
 * the same field rather than guessing from the asset's type.
 */
function isColdChainAsset(record) {
  if (record.meta?.cold_chain === true) return true
  if (record.metadata?.cold_chain === true) return true
  if (typeof record.cold_chain === 'boolean') return record.cold_chain
  return String(record.service_type || '').toLowerCase() === 'cold_chain'
}

function renderMap(records) {
  // Records count as plottable if they have a point OR a usable bounding box.
  // Filtering on coordinates alone dropped every bbox-only hazard before the
  // hazard loop could draw its footprint.
  const geo = records.filter((r) => isFinitePoint(r) || hasUsableBbox(r))

  // Frame the map around the region of interest rather than around whatever the
  // global feeds contain. See shared/map-frame.js for the bug this fixes, which
  // was found by screenshotting the running dashboard.
  // Frame on the active simulation when there is one, so the shaded extent
  // fills the viewport instead of sitting as a few pixels in a Horn-wide view.
  // A route frame is an explicit operator request too: zoom to the planned
  // corridor rather than letting a region-wide view swallow it.
  const bbox = mapFrame(geo, undefined, state.floodFocus || state.routeFocus || null).frame

  // Apply map filters.
  //
  // Severity and source were applied; the other three controls on this bar were
  // inert. "Time" had no listener and filtered nothing, "Cold-chain nodes" wrote
  // a flag that nothing read, and the workflow tiles set a filter that no panel
  // consulted. Each looked like a control and did nothing, which is worse than
  // not offering it: an operator narrows the map, sees no change, and concludes
  // the data is wrong.
  const sevFilter = $('mapSeverity')?.value || ''
  const srcFilter = $('mapSource')?.value || ''
  const since = rangeStart($('mapTimeRange')?.value)
  const coldOnly = $('coldChainToggle')?.checked ? true : state.filters.coldChain

  const visible = geo.filter((r) => {
    if (sevFilter && r.severity && r.severity !== sevFilter) return false
    if (srcFilter && r.source && r.source !== srcFilter) return false
    if (since && !withinRange(r, since)) return false
    if (coldOnly && !isColdChainAsset(r)) return false
    return true
  })

  renderStaticLayers(bbox)
  mapHazardsEl.innerHTML = ''
  mapAssetsEl.innerHTML = ''
  mapRiskEl.innerHTML = ''
  if (mapFloodEl) mapFloodEl.innerHTML = ''
  if (mapRoadsEl) mapRoadsEl.innerHTML = ''
  if (mapRouteEl) mapRouteEl.innerHTML = ''
  if (mapFoodSecurityEl) mapFoodSecurityEl.innerHTML = ''

  // The simulation overlay and road status persist across filter changes, so
  // a severity or source filter must not silently discard the flood extent the
  // operator just computed.
  if (state.floodGrid) renderFloodLayer(state.floodGrid, bbox)
  if (state.roadAccess?.length) renderRoadLayer(state.roadAccess, bbox)
  if (state.routePlan) renderRouteLayer(state.routePlan, bbox)
  if (state.showIpcAreas && state.foodSecurity?.length) renderFoodSecurityLayer(state.foodSecurity, bbox)

  const hazards = visible.filter((r) => r.event_type || r.source === 'gdacs' || r.source === 'glofas' || r.source === 'nasa_firms')
  const assets  = visible.filter((r) => r.service_type)
  const risks   = visible.filter((r) => Number.isFinite(r.score))

  // Risk blobs (radial gradient fills). Score is 0..100; normalize to 0..1.
  risks.forEach((r) => {
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const normalized = Math.max(0, Math.min(1, (Number(r.score) || 0) / 100))
    if (normalized === 0) return
    const gradId = ensureRiskGradient(normalized * 0.45)
    const radius = 18 + normalized * 42
    mapRiskEl.append(svgEl('ellipse', {
      cx: x, cy: y, rx: radius, ry: radius * 0.55,
      fill: `url(#${gradId})`,
      class: 'risk-blob',
    }))
  })

  // Hazard markers.
  //
  // When the source gives only a bounding box, the box is drawn as a footprint
  // rather than a dot at the box centre. A dot would place the event at a point
  // the source never asserted: a live GDACS green flood alert for France
  // carries a box spanning ~40 degrees, so its centre is in Chad. The
  // connector now omits those coordinates, and the map shows the region the
  // source actually claims.
  hazards.forEach((r) => {
    if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) {
      const box = r.bbox
      if (box && [box.west, box.south, box.east, box.north].every(Number.isFinite)) {
        const nw = project(Math.min(box.north, 90), box.west, bbox)
        const se = project(Math.max(box.south, -90), box.east, bbox)
        const foot = svgEl('rect', {
          x: Math.min(nw.x, se.x),
          y: Math.min(nw.y, se.y),
          width: Math.abs(se.x - nw.x),
          height: Math.abs(se.y - nw.y),
          class: `hazard-footprint ${hazardClass(r.event_type)} hazard-footprint-${safeClass(r.severity)}`,
        })
        const footTitle = svgEl('title')
        footTitle.textContent = `${r.title || r.event_type || 'Hazard'} — reported area, not a point location`
        foot.append(footTitle)
        foot.addEventListener('click', () => openDetailDialog(r))
        mapHazardsEl.append(foot)
      }
      // No point and no usable box: nothing to draw, and the record count in
      // the filter and status bar still reflects it.
      return
    }
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const circle = svgEl('circle', {
      cx: x, cy: y,
      r: sevRadius(r.severity),
      class: `hazard-marker ${hazardClass(r.event_type)}`,
    })
    const titleEl = svgEl('title')
    titleEl.textContent = r.title || r.event_type || 'Hazard'
    circle.append(titleEl)
    circle.addEventListener('click', () => openDetailDialog(r))
    mapHazardsEl.append(circle)
  })

  // Asset squares
  assets.forEach((r) => {
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const size = 9
    const rect = svgEl('rect', {
      x: x - size / 2, y: y - size / 2,
      width: size, height: size,
      class: `asset-marker ${assetClass(r.service_type)}`,
    })
    const titleEl = svgEl('title')
    titleEl.textContent = r.name || r.service_type || 'Asset'
    rect.append(titleEl)
    rect.addEventListener('click', () => openDetailDialog(r))
    mapAssetsEl.append(rect)
  })

  renderMapLegend()

  const countEl = $('mapRecordCount')
  if (countEl) countEl.textContent = `${visible.length} record${visible.length === 1 ? '' : 's'}`

  // Classify the same way the draw loops above do, so the list says "asset" for
  // exactly the records drawn as squares. Classifying twice with two predicates
  // would let the list and the map disagree, which is worse than either.
  const kindOf = (r) => {
    if (r.service_type) return 'asset'
    if (Number.isFinite(r.score)) return 'risk'
    return 'hazard'
  }
  renderMapRecordList(visible.map((r) => ({ record: r, kind: kindOf(r) })))
}

/**
 * The map's text alternative.
 *
 * Everything drawn above — hazards, assets, IPC areas — rendered as a click
 * target with an SVG <title> child, and nothing anywhere listed them as text.
 * A screen-reader user met the map as a single `role="img"` labelled "Situation
 * map", which collapsed every marker into one atomic picture. This is the same
 * data the map draws, in a table, with the same detail dialog behind each row.
 */
function renderMapRecordList(entries) {
  const tbody = $('mapRecordListBody')
  if (!tbody) return

  const empty = $('mapRecordListEmpty')
  if (empty) empty.hidden = entries.length > 0

  if (!entries.length) {
    tbody.innerHTML = ''
    return
  }

  // Risk records name themselves with `type` and carry `risk_level`, not
  // `severity`; reading severity off them gave every row "unknown" and every
  // risk row read "risk — — Turkana", which is the same string 99 times.
  const describe = ({ record, kind }) => {
    if (kind === 'asset') {
      return {
        type: 'asset',
        name: record.name || record.service_type || record.id || 'Asset',
        detail: record.road_class || record.service_type || '',
        severity: null,
        when: record.updated_at || null,
      }
    }
    if (kind === 'risk') {
      // `type` is already "flood_risk", so metricLabel gives "Flood risk" and
      // appending " risk" produced "Flood risk risk" on every row.
      const hazard = metricLabel(record.type || record.metric)
      return {
        type: hazard,
        name: `${record.region_name || record.country || 'region'} — score ${num(record.score, { int: true })}`,
        detail: record.country || '',
        severity: record.risk_level || null,
        when: record.generated_at || null,
      }
    }
    const typeLabel = metricLabel(record.event_type)
    return {
      type: typeLabel,
      // A GDELS event can name forty countries in its title. The list is for
      // scanning, so the row shows the leading phrase and the full text stays
      // one click away in the detail dialog.
      name: truncate(record.title || record.headline || record.id || 'Record', { max: 90 }),
      detail: truncate(record.country || record.source || '', { max: 40 }),
      severity: record.severity || null,
      when: record.occurred_at || record.observed_at || record.first_seen_at || record.created_at || null,
    }
  }

  // Actionable records first: a reviewer wants the hazards and the assets, not
  // 99 region-level risk scores in generation order.
  const order = { hazard: 0, asset: 1, risk: 2 }
  const sorted = entries
    .map((entry, i) => ({ ...describe(entry), record: entry.record, index: i, kind: entry.kind }))
    .sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.type).localeCompare(String(b.type)))

  tbody.innerHTML = sorted.map((row) => `<tr>
    <td>${escapeHtml(row.type)}</td>
    <td>${escapeHtml(row.name)}${row.detail ? ` <span class="muted-sm">${escapeHtml(row.detail)}</span>` : ''}</td>
    <td>${row.severity
      ? `<span class="sev-chip sev-${sevClass(row.severity)}">${escapeHtml(row.severity)}</span>`
      : '<span class="muted-sm">—</span>'}</td>
    <td class="muted-sm nowrap">${escapeHtml(formatTimestamp(row.when, { style: 'date', dash: '—' }))}</td>
    <td><button type="button" class="btn btn-xs" data-map-record="${row.index}">Details</button></td>
  </tr>`).join('')

  tbody.querySelectorAll('[data-map-record]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = entries[Number(btn.dataset.mapRecord)]
      if (entry) openDetailDialog(entry.record)
    })
  })
}

let _legendDrawn = false
function renderMapLegend() {
  // Eight fixed swatches, rebuilt on every refresh for the life of the console
  // to say the same thing. Drawn once; nothing about it varies with the data.
  if (_legendDrawn) return
  _legendDrawn = true
  mapLegendEl.innerHTML = ''
    const items = [
    { cls: 'hazard-flood',     label: 'Flood',     shape: 'circle' },
    { cls: 'hazard-landslide', label: 'Landslide', shape: 'circle' },
    { cls: 'hazard-fire',      label: 'Fire',      shape: 'circle' },
    { cls: 'hazard-conflict',  label: 'Conflict',  shape: 'circle' },
    { cls: 'hazard-footprint', label: 'Area (box)',shape: 'footprint' },
    { cls: 'food-medium',      label: 'IPC Phase 3+ area', shape: 'footprint' },
    { cls: 'asset-health',     label: 'Health',    shape: 'rect' },
    { cls: 'asset-water',      label: 'Water',     shape: 'rect' },
  ]
  const pad = 8
  const rowH = 17
  const bW = 92
  const bH = items.length * rowH + pad * 2
  const bY = SVG_H - bH - 6

  mapLegendEl.append(svgEl('rect', {
    x: 6, y: bY, width: bW, height: bH,
    class: 'legend-bg', rx: 5,
  }))

  items.forEach((item, i) => {
    const y = bY + pad + i * rowH + rowH / 2
    if (item.shape === 'circle') {
      mapLegendEl.append(svgEl('circle', { cx: 18, cy: y, r: 5, class: `hazard-marker ${item.cls}` }))
    } else if (item.shape === 'footprint') {
      // Dashed, matching how a regional bbox is drawn on the map, and hollow so
      // it cannot be mistaken for a point event with a location we actually know.
      mapLegendEl.append(svgEl('rect', {
        x: 12, y: y - 5, width: 12, height: 10,
        class: 'hazard-footprint', fill: 'oklch(62% 0.12 260)', stroke: 'oklch(72% 0.12 260)',
      }))
    } else {
      mapLegendEl.append(svgEl('rect', { x: 14, y: y - 4, width: 8, height: 8, class: `asset-marker ${item.cls}` }))
    }
    const lbl = svgEl('text', { x: 30, y: y, class: 'legend-label' })
    lbl.textContent = item.label
    mapLegendEl.append(lbl)
  })
}

// Map zoom / pan
function applyMapTransform() {
  if (!mapTransformEl) return
  mapTransformEl.setAttribute('transform',
    `translate(${state.mapTransform.x},${state.mapTransform.y}) scale(${state.mapTransform.scale})`)
}

mapEl?.addEventListener('wheel', (e) => {
  e.preventDefault()
  const delta = e.deltaY > 0 ? 0.86 : 1.16
  state.mapTransform.scale = Math.max(0.3, Math.min(10, state.mapTransform.scale * delta))
  applyMapTransform()
}, { passive: false })

mapEl?.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.hazard-marker, .asset-marker')) return
  state.mapDragging = true
  state.mapDragStart = { x: e.clientX - state.mapTransform.x, y: e.clientY - state.mapTransform.y }
  mapEl.setPointerCapture(e.pointerId)
})

mapEl?.addEventListener('pointermove', (e) => {
  if (!state.mapDragging) return
  state.mapTransform.x = e.clientX - state.mapDragStart.x
  state.mapTransform.y = e.clientY - state.mapDragStart.y
  applyMapTransform()
})

mapEl?.addEventListener('pointerup', () => { state.mapDragging = false })
mapEl?.addEventListener('pointercancel', () => { state.mapDragging = false })

// Double-click resets zoom
mapEl?.addEventListener('dblclick', () => {
  state.mapTransform = { x: 0, y: 0, scale: 1 }
  applyMapTransform()
})

/**
 * Keyboard control of the map.
 *
 * Pan and zoom were wheel and drag only. There was no keyboard path at all, and
 * no `tabindex` anywhere in the codebase, so a keyboard user could not reach
 * the map or any marker on it. The keys mirror what the mouse already does.
 */
const PAN_STEP = 40
const ZOOM_STEP = 1.2

mapEl?.addEventListener('keydown', (e) => {
  // Let a modifier combination through; it is not a map gesture.
  if (e.ctrlKey || e.metaKey || e.altKey) return

  switch (e.key) {
    case 'ArrowLeft':  state.mapTransform.x += PAN_STEP; break
    case 'ArrowRight': state.mapTransform.x -= PAN_STEP; break
    case 'ArrowUp':    state.mapTransform.y += PAN_STEP; break
    case 'ArrowDown':  state.mapTransform.y -= PAN_STEP; break
    case '+': case '=': state.mapTransform.scale = Math.min(10, state.mapTransform.scale * ZOOM_STEP); break
    case '-': case '_': state.mapTransform.scale = Math.max(0.3, state.mapTransform.scale / ZOOM_STEP); break
    case '0':
      state.mapTransform = { x: 0, y: 0, scale: 1 }
      break
    case 't': case 'T':
      toggleMapRecordList()
      break
    default:
      return
  }
  e.preventDefault()
  applyMapTransform()
  announceMapView()
})

let mapAnnounceTimer = null
function announceMapView() {
  const el = $('mapViewAnnouncer')
  if (!el) return
  el.textContent = `Map at ${Math.round(state.mapTransform.scale * 100)}% zoom.`
  clearTimeout(mapAnnounceTimer)
  mapAnnounceTimer = setTimeout(() => { el.textContent = '' }, 2000)
}

/** Show or hide the map's text alternative. */
function toggleMapRecordList(force) {
  const list = $('mapRecordList')
  const toggle = $('mapListToggle')
  if (!list || !toggle) return
  const show = force !== undefined ? force : list.hidden
  list.hidden = !show
  toggle.setAttribute('aria-expanded', String(show))
  toggle.textContent = show ? 'Show map' : 'Show as list'
}

$('mapListToggle')?.addEventListener('click', () => toggleMapRecordList())

// Map filter triggers re-render
$('mapSeverity')?.addEventListener('change', () => { syncFiltersToUrl(); reRenderMapFromState() })
$('mapSource')?.addEventListener('change', () => { syncFiltersToUrl(); reRenderMapFromState() })

// Flood simulation and road overlay controls
floodSimulateBtn?.addEventListener('click', loadFloodSimulation)
floodClearBtn?.addEventListener('click', clearFloodSimulation)
floodLevelInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadFloodSimulation()
})
floodAreaEl?.addEventListener('change', () => {
  // Offer a plausible starting level for the chosen district. Turkana sits
  // around 500 m and Karamoja around 1,000 m, so a level that floods one is
  // nowhere near flooding the other.
  const area = FLOOD_SIM_AREAS[floodAreaEl.value]
  if (area) {
    floodLevelInput.value = String(area.defaultLevelM)
    setFloodStatus(`${area.name}: enter a water surface elevation above the local ground to see inundation.`)
  }
})
routePlanBtn?.addEventListener('click', planRoute)
routeClearBtn?.addEventListener('click', clearRoutePlan)
routeFromEl?.addEventListener('change', clearRoutePlan)
routeToEl?.addEventListener('change', clearRoutePlan)
roadOverlayToggle?.addEventListener('change', async () => {
  state.showRoads = roadOverlayToggle.checked
  if (state.showRoads) {
    await loadRoadStatus()
  } else {
    state.roadAccess = []
    if (roadStatusEl) roadStatusEl.textContent = ''
    reRenderMapFromState()
  }
})
ipcOverlayToggle?.addEventListener('change', async () => {
  state.showIpcAreas = ipcOverlayToggle.checked
  if (state.showIpcAreas) {
    await loadIpcOverlay()
  } else {
    state.foodSecurity = []
    if (ipcStatusEl) ipcStatusEl.textContent = ''
    reRenderMapFromState()
  }
})

function reRenderMapFromState() {
  const d = state.data
  renderMap([
    ...(d.flood?.data || []),
    ...(d.conflict?.data || []),
    ...(d.events?.data || []),
    ...(d.assets?.data || []),
  ])
}

// =============================================================
// Data refresh
// =============================================================
let _refreshInFlight = false
let _refreshFailures = 0

/**
 * Load every panel the console shows.
 *
 * This ran on a bare 30-second interval with no in-flight guard, no visibility
 * check and no try/catch around a twelve-way `Promise.all`. One failing endpoint
 * rejected the whole set, so `setStatus` at the bottom never ran and the status
 * bar froze on the last successful "Updated ..." — an operator could not tell a
 * live console from one that had been silently dead for an hour.
 *
 * Each panel now settles independently, so a dead endpoint blanks its own panel
 * and is named in the status bar rather than taking the other eleven with it.
 */
async function refresh() {
  if (_refreshInFlight) return
  if (document.hidden) return
  _refreshInFlight = true

  const load = async (name, path) => {
    try {
      return { [name]: await fetchJson(path), failed: null }
    } catch (err) {
      return { [name]: null, failed: name }
    }
  }

  try {
    const results = await Promise.all([
      load('health', '/api/v1/health'),
      load('sources', '/api/v1/sources'),
      load('ingestionHealth', '/api/v1/ingest/status'),
      load('flood', '/api/v1/flood-risk'),
      load('conflict', '/api/v1/conflict-risk'),
      // Two requests, deliberately. The region the map is about, plus recent
      // global events for context. Asking only for the most recent global events
      // let a busy feed page out the local flood and landslide entirely.
      (async () => {
        try {
          const local = await fetchJson(localEventQuery())
          const global_ = await fetchJson(globalEventQuery())
          return { events: { data: mergeEventSets(local.data || [], global_.data || []) }, failed: null }
        } catch {
          return { events: null, failed: 'events' }
        }
      })(),
      load('assets', '/api/v1/service-assets?limit=100'),
      load('alerts', '/api/v1/alert-events?limit=30'),
      load('reports', '/api/v1/reports?limit=20'),
      load('reportTemplates', '/api/v1/report-templates?limit=20'),
      load('climate', '/api/v1/climate?limit=200'),
      load('dispatches', '/api/v1/rapidpro/dispatches?limit=200'),
      load('workflows', '/api/v1/workflows?limit=200'),
    ])

    const failed = results.filter((r) => r.failed).map((r) => r.failed)
    const merged = Object.assign({}, ...results)

    const health = merged.health
    if (health) {
      state.data.health = health
      if (storageMode) storageMode.textContent = health.storage?.mode || 'json'
    }

    const sources = merged.sources
    if (sources) {
      state.data.sources = sources
      populateMapSourceFilter(sources.data || [])
    }

    if (merged.ingestionHealth) {
      state.data.ingestionHealth = merged.ingestionHealth
      renderSourceDots(merged.ingestionHealth.data || [])
    }

    const alerts = merged.alerts
    if (alerts) {
      state.data.alerts = alerts
      renderAlertsBadge(alerts.data || [])
    }

    if (merged.events) state.data.events = merged.events
    if (merged.assets) {
      state.data.assets = merged.assets
      populateRouteEndpoints(merged.assets.data || [])
    }
    if (merged.flood) state.data.flood = merged.flood
    if (merged.conflict) state.data.conflict = merged.conflict
    if (merged.reports) {
      state.data.reports = merged.reports
      state.reports = merged.reports.data || []
    }
    if (merged.reportTemplates) {
      state.data.reportTemplates = merged.reportTemplates
      state.templates = merged.reportTemplates.data || []
    }
    if (merged.dispatches) state.data.dispatches = merged.dispatches
    if (merged.workflows) {
      state.data.workflows = merged.workflows
      // Index the alert each workflow governs, so selecting a ribbon tile can
      // narrow the rail. A workflow's subject is what it acts on; only alert
      // subjects are relevant to the alert list.
      const index = {}
      for (const wf of merged.workflows.data || []) {
        if (wf.subject_kind !== 'alert_event' || !wf.subject_id) continue
        ;(index[wf.type] ||= new Set()).add(wf.subject_id)
      }
      state.workflowAlertIds = index
    }

    if (merged.climate) {
      state.data.climate = merged.climate
      state.climate = merged.climate.data || []
      renderSeasonalStrip(state.climate)
    }

    // Strips load once per refresh for every viewer; the IPC overlay still only
    // fetches its records when the operator ticks it on.
    loadFoodSecuritySummary().catch(() => {})
    loadDiseaseSummary().catch(() => {})
    loadFloodProbabilityModels().catch(() => {})

    renderMap([
      ...(merged.flood?.data || []),
      ...(merged.conflict?.data || []),
      ...(merged.events?.data || []),
      ...(merged.assets?.data || []),
    ])

    loadWorkflowMetrics().catch(() => {})

    if (state.activeTab === 'alerts')         renderAlertsPanel()
    else if (state.activeTab === 'reports')   renderReportsPanel()
    else if (state.activeTab === 'equity')    renderEquityTab()
    else if (state.activeTab === 'ingestion') renderIngestionPanel()

    loadSignalToAction().catch(() => {})

    if (failed.length) {
      _refreshFailures += 1
      setStatus(
        `Updated ${formatTimestamp(new Date())} — ` +
        `${failed.length} source${failed.length === 1 ? '' : 's'} unavailable (${failed.join(', ')}). GDELT excluded.`
      )
      // A single missed poll is a blip; a persistent one is an outage, and the
      // operator should be told rather than left reading a stale timestamp.
      if (_refreshFailures >= 3) connectionStatus?.classList.add('degraded')
    } else {
      _refreshFailures = 0
      connectionStatus?.classList.remove('degraded')
      setStatus(`Updated ${formatTimestamp(new Date())}. GDELT excluded.`)
    }
  } finally {
    _refreshInFlight = false
  }
}

function populateMapSourceFilter(sources) {
  const sel = $('mapSource')
  if (!sel) return
  const restored = state._restoredSource
  state._restoredSource = null
  const current = restored || sel.value
  sel.innerHTML = `<option value="">All</option>` +
    sources.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')
  // A source that no longer exists leaves the filter on All rather than on a
  // value the select cannot represent, which would silently match everything.
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current
}

// =============================================================
// Source health dots (statusbar)
// =============================================================
function renderSourceDots(healthData) {
  if (!sourceDots) return
  sourceDots.innerHTML = healthData.slice(0, 8).map((h) => {
    const cls = h.status === 'fresh' ? 'health-dot-fresh'
      : h.status === 'failed' ? 'health-dot-failed'
      : h.status === 'stale'  ? 'health-dot-stale'
      : 'health-dot-never-run'
    return `<span class="source-dot ${cls}" title="${escapeHtml(h.source)}: ${escapeHtml(h.status)}"></span>`
  }).join('')
}

// =============================================================
// Workflows panel
// =============================================================
const WORKFLOW_TYPES = [
  'anticipatory_alert',
  'cold_chain_protection',
  'school_feeding_continuity',
  'school_health_decision',
  'chw_outbreak_triage',
  'community_feedback_loop',
  'equity_audit_action',
  'parametric_disbursement',
]

async function loadWorkflowMetrics() {
  let byType = {}
  let totals = { open: 0, closed: 0, rejected: 0 }
  try {
    const payload = await apiFetch('/api/v1/workflows/metrics')
    byType = payload?.data?.by_type || {}
    totals = {
      open: payload?.data?.open ?? 0,
      closed: payload?.data?.closed ?? 0,
      rejected: payload?.data?.rejected ?? 0,
    }
  } catch (err) {
    // The tiles still render from whatever byType holds, so the breakdown stays
    // useful even when the totals request fails.
    console.error('Failed to load workflow metrics:', err)
  }
  renderWorkflowsTab(byType, totals)
}

function renderWorkflowsTab(byType, totals = {}) {
  const grid = $('workflowMetricsGrid')
  if (!grid) return

  // Totals first. "9 open" is the number an operator can act on; eight tiles
  // each saying "1" is a breakdown of it, not eight findings.
  const open = totals.open ?? WORKFLOW_TYPES.reduce((n, k) => n + (byType[k]?.open || 0), 0)
  const closed = totals.closed ?? WORKFLOW_TYPES.reduce((n, k) => n + (byType[k]?.closed || 0), 0)
  const rejected = totals.rejected ?? WORKFLOW_TYPES.reduce((n, k) => n + (byType[k]?.rejected || 0), 0)

  const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value) }
  set('workflowOpen', open)
  set('workflowClosed', closed)
  set('workflowRejected', rejected)
  const rejectedWrap = $('workflowRejectedWrap')
  if (rejectedWrap) rejectedWrap.hidden = !rejected

  grid.innerHTML = WORKFLOW_TYPES.filter((type) => (byType[type]?.open || byType[type]?.closed || byType[type]?.rejected)).map((type) => {
    const m = byType[type] || { open: 0, closed: 0, rejected: 0 }
    const i18nKey = `workflow.${type}`
    return `<div class="workflow-metric" data-type="${escapeHtml(type)}" role="listitem" tabindex="0">
      <span class="workflow-metric-name" data-i18n="${escapeHtml(i18nKey)}">${escapeHtml(t(i18nKey))}</span>
      <span class="workflow-metric-count">${escapeHtml(String(m.open || 0))}</span>
      <span class="workflow-metric-meta">${m.closed ? `closed: ${escapeHtml(String(m.closed))}` : 'none closed'}</span>
    </div>`
  }).join('') || '<p class="workflow-empty">No workflow instances recorded.</p>'

  const selectType = (card) => {
    // Selecting the same tile again clears it, so there is a way back without
    // a separate control.
    const same = state.workflowTypeFilter === card.dataset.type
    state.workflowTypeFilter = same ? null : card.dataset.type
    grid.querySelectorAll('.workflow-metric').forEach((c) => {
      c.classList.toggle('active', !same && c === card)
    })
    syncFiltersToUrl()
    setStatus(state.workflowTypeFilter
      ? `Showing ${card.dataset.type.replace(/_/g, ' ')} workflows only. Select the tile again to clear.`
      : 'Showing all workflow types.')
    renderAlertsPanel()
    switchTab('alerts')
  }

  // A type restored from the URL has to read as selected once the tiles are
  // rebuilt, or the persisted filter looks like it did nothing at all.
  if (state.workflowTypeFilter) {
    grid.querySelectorAll('.workflow-metric')
      .forEach((c) => c.classList.toggle('active', c.dataset.type === state.workflowTypeFilter))
  }

  grid.querySelectorAll('.workflow-metric').forEach((card) => {
    card.addEventListener('click', () => selectType(card))
    // Clickable div with no keyboard path: the tiles were reachable by pointer
    // only, and announced as list items with no action.
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectType(card) }
    })
  })
}

// =============================================================
// Equity panel
// =============================================================
function renderEquityTab() {
  const alerts = state.data.alerts?.data || []
  const dispatches = state.data.dispatches?.data || []
  const table = $('equityTable')
  const emptyState = $('equityEmptyState')
  if (!table) return

  // Dispatched counts come from rapidpro_dispatches, joined to the alert event
  // to recover the district. Alert events do not carry a dispatch_status field
  // at all, so reading it from them yields zero dispatched for every district —
  // which renders as a false-positive rate of "—" everywhere, and reads as
  // "we never send" rather than "this was computed from the wrong table".
  const dispatchedByAlert = new Map()
  for (const dispatch of dispatches) {
    if (!dispatch.alert_event_id) continue
    if (dispatch.status !== 'sent') continue
    dispatchedByAlert.set(dispatch.alert_event_id, (dispatchedByAlert.get(dispatch.alert_event_id) || 0) + 1)
  }

  const grouped = {}
  for (const a of alerts) {
    const district = a.scope?.district || 'unknown'
    if (!grouped[district]) grouped[district] = { dispatched: 0, acknowledged: 0 }
    grouped[district].dispatched += dispatchedByAlert.get(a.id) || 0
    if (a.status === 'acknowledged' || a.status === 'resolved') grouped[district].acknowledged++
  }

  const districts = Object.entries(grouped)
  if (!districts.length) {
    emptyState.hidden = false
    table.hidden = true
    return
  }

  emptyState.hidden = true
  table.hidden = false
  const tbody = table.querySelector('tbody')
  if (tbody) {
    tbody.innerHTML = districts.map(([district, data]) => {
      const rate = data.dispatched > 0 ? ((data.dispatched - data.acknowledged) / data.dispatched * 100).toFixed(1) : '—'
      return `<tr>
        <td>${escapeHtml(district)}</td>
        <td>${escapeHtml(String(data.dispatched))}</td>
        <td>${escapeHtml(String(data.acknowledged))}</td>
        <td>${escapeHtml(String(rate))}%</td>
      </tr>`
    }).join('')
  }
}

// =============================================================
// Signal to action metrics
// =============================================================
async function loadSignalToAction() {
  try {
    const [eventsRes, dispatchesRes] = await Promise.all([
      fetch('/api/v1/events?limit=1&order=desc'),
      fetch('/api/v1/rapidpro/dispatches?limit=50'),
    ])

    const events = await eventsRes.json()
    const dispatches = await dispatchesRes.json()

    const lastEvent = events.data?.[0]
    const lastDispatch = dispatches.data?.sort((a, b) =>
      new Date(b.sent_at || 0) - new Date(a.sent_at || 0))[0]

    // A metric with no value used to render an em dash and stay there, so the
    // status bar carried two permanently-empty readouts that looked broken. Each
    // one now appears only once it has something to say.
    const lastSignalEl = $('lastSignalTime')
    if (lastSignalEl && lastEvent?.observed_at) {
      lastSignalEl.textContent = formatRelative(lastEvent.observed_at)
      $('lastSignalMetric')?.removeAttribute('hidden')
    }

    const lastActionEl = $('lastActionTime')
    if (lastActionEl && lastDispatch?.sent_at) {
      lastActionEl.textContent = formatRelative(lastDispatch.sent_at)
      $('lastActionMetric')?.removeAttribute('hidden')
    }

    // Median lag
    if (dispatches.data && dispatches.data.length > 0) {
      const lags = dispatches.data
        .filter((d) => d.dispatched_at && d.matched_signal_at)
        .map((d) => (new Date(d.dispatched_at) - new Date(d.matched_signal_at)) / 1000 / 60)
        .sort((a, b) => a - b)
      if (lags.length > 0) {
        const median = lags[Math.floor(lags.length / 2)]
        const medianEl = $('medianLag')
        const dotEl = $('lagDot')
        if (medianEl) medianEl.textContent = formatDuration(median)
        $('medianLagMetric')?.removeAttribute('hidden')
        if (dotEl) {
          dotEl.className = 'dot '
          if (median < 1440) dotEl.classList.add('dot-ok')
          else if (median < 2880) dotEl.classList.add('dot-warn')
          else dotEl.classList.add('dot-danger')
        }
      }
    }
  } catch (err) {
    console.error('Failed to load signal-to-action metrics:', err)
  }
}

// =============================================================
// Dispatch gate dialog
// =============================================================
function openDispatchGateDialog(alert) {
  const dialog = $('dispatchGateDialog')
  if (!dialog) return
  state._dispatchGateAlert = alert
  $('dispatchGateSeverity').textContent = escapeHtml(alert.severity || '—')
  $('dispatchGateRule').textContent = escapeHtml(alert.rule_name || alert.metric || '—')
  rememberDialogOpener(dialog)
  dialog.showModal()
}

function closeDispatchGateDialog() {
  $('dispatchGateDialog')?.close()
}

// The held alert is cleared on `close`, not on the cancel button. Dismissing the
// gate with Esc left a high-severity alert in state, and the next confirm — the
// button is re-enabled the moment the dialog goes away — dispatched whatever
// the operator had abandoned ten minutes earlier.
$('dispatchGateDialog')?.addEventListener('close', () => {
  state._dispatchGateAlert = null
  restoreDialogFocus($('dispatchGateDialog'))
})

// =============================================================
// Tabs
// =============================================================
function switchTab(name) {
  state.activeTab = name
  document.querySelectorAll('.rail-tab').forEach((btn) => {
    const active = btn.dataset.tab === name
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', String(active))
    // Roving tabindex. The markup declares role="tablist"/"tab" and
    // aria-selected, which promises one stop for the whole group and arrow-key
    // movement; without it Tab walked five buttons to reach one panel and the
    // arrows did nothing, so the declared pattern was decoration.
    btn.tabIndex = active ? 0 : -1
  })
  document.querySelectorAll('.rail-panel').forEach((panel) => {
    const active = panel.id === `panel-${name}`
    panel.classList.toggle('active', active)
    panel.hidden = !active
  })
  if (name === 'workflows')   { loadWorkflowMetrics() }
  else if (name === 'alerts')    renderAlertsPanel()
  else if (name === 'reports')   renderReportsPanel()
  else if (name === 'equity')    renderEquityTab()
  else if (name === 'ingestion') renderIngestionPanel()
  else if (name === 'settings')  renderSettingsPanel()
}

document.querySelectorAll('.rail-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
})

// The active tab is the only one reachable by Tab, set here because the boot
// path never calls switchTab — the markup's `active` class is the initial state.
document.querySelectorAll('.rail-tab').forEach((btn) => {
  btn.tabIndex = btn.classList.contains('active') ? 0 : -1
})

const railTablist = document.querySelector('.rail-tabs')
railTablist?.addEventListener('keydown', (e) => {
  const tabs = [...railTablist.querySelectorAll('.rail-tab')]
  const from = tabs.indexOf(document.activeElement)
  if (from < 0) return
  let to = null
  if (e.key === 'ArrowRight')       to = (from + 1) % tabs.length
  else if (e.key === 'ArrowLeft')   to = (from - 1 + tabs.length) % tabs.length
  else if (e.key === 'Home')        to = 0
  else if (e.key === 'End')         to = tabs.length - 1
  else return
  // Selection follows focus: this console has no deferred-activation case —
  // every panel's render is one fetch or one innerHTML — and a tab that looks
  // focused but does nothing is the same trap the role attributes caused.
  e.preventDefault()
  switchTab(tabs[to].dataset.tab)
  tabs[to].focus()
})

// =============================================================
// URL filter state
// =============================================================
/**
 * Filters in the query string.
 *
 * JTBD-089: an operator who narrowed the map to one severity and one source
 * lost the whole view to an accidental reload, because every filter lived only
 * in memory and the console redrew from defaults. The query string is the one
 * form of console state that survives a reload, can be pasted to a colleague and
 * can be linked from an incident note.
 *
 * Only non-default values are written, so a shared link carries what the
 * operator chose and nothing else, and an absent parameter always means the
 * default the markup ships with.
 */
const FILTER_DEFAULTS = { sev: '', source: '', range: '7d', cold: '', alerts: 'all', workflow: '' }

const FILTER_READERS = {
  sev:      () => $('mapSeverity')?.value || '',
  source:   () => $('mapSource')?.value || '',
  range:    () => $('mapTimeRange')?.value || '',
  cold:     () => ($('coldChainToggle')?.checked ? '1' : ''),
  alerts:   () => state.alertFilter,
  workflow: () => state.workflowTypeFilter || '',
}

function syncFiltersToUrl() {
  const params = new URLSearchParams(window.location.search)
  for (const [key, read] of Object.entries(FILTER_READERS)) {
    const value = read()
    if (value && value !== FILTER_DEFAULTS[key]) params.set(key, value)
    else params.delete(key)
  }
  const query = params.toString()
  // replaceState, not pushState: a filter change should not bury the operator's
  // back button under a stack of identical console states, and the 30-second
  // refresh rewriting the URL must never add one.
  history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname)
}

/** Apply a restored value only if the control still offers it. */
function applyFilterValue(id, value) {
  const el = $(id)
  if (!el || !value) return false
  if (![...el.options].some((o) => o.value === value)) return false
  el.value = value
  return true
}

function syncAlertFilterChips() {
  document.querySelectorAll('#alertFilterChips .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === state.alertFilter)
  })
}

function restoreFiltersFromUrl() {
  const params = new URLSearchParams(window.location.search)
  applyFilterValue('mapSeverity', params.get('sev'))
  applyFilterValue('mapTimeRange', params.get('range'))
  // The source list arrives from /api/v1/sources and is empty until it does, so
  // a restored source has nowhere to land yet. Hand it forward rather than
  // dropping it, and let populateMapSourceFilter discard it if the feed is gone.
  const source = params.get('source')
  if (source) state._restoredSource = source

  if (params.get('cold') === '1' && $('coldChainToggle')) $('coldChainToggle').checked = true
  state.filters.coldChain = Boolean($('coldChainToggle')?.checked)

  state.alertFilter = params.get('alerts') || 'all'
  state.workflowTypeFilter = params.get('workflow') || null
  syncAlertFilterChips()
}

// =============================================================
// Alerts panel
// =============================================================
function renderAlertsBadge(alerts) {
  const badge = $('alertsBadge')
  if (!badge) return
  const open = alerts.filter((a) => a.status === 'open').length
  if (open > 0) { badge.textContent = open; badge.hidden = false }
  else { badge.hidden = true }
}

function renderAlertsPanel() {
  const alerts = state.data.alerts?.data || []
  const filter = state.alertFilter
  let filtered = filter === 'all' ? alerts
    : filter === 'auto_approved' ? alerts.filter((a) => a.status === 'auto_approved' || a.status === 'auto-approved')
    : alerts.filter((a) => a.status === filter)

  // The workflow tiles set this and nothing read it, so selecting "Anticipatory
  // Alert" highlighted a tile and changed nothing else.
  //
  // The link runs through the workflow, not the alert: a workflow whose
  // subject_kind is "alert_event" points at the alert by id. Reading
  // alert.metadata instead — which carries only a district — matched nothing and
  // emptied the list, which is worse than not filtering at all.
  const type = state.workflowTypeFilter
  if (type) {
    const linked = state.workflowAlertIds?.[type]
    filtered = linked ? filtered.filter((a) => linked.has(a.id)) : []
  }

  const container = $('alertsList')
  if (!container) return

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(t('state.empty_alerts'))}</p></div>`
    return
  }

  container.innerHTML = filtered.map((alert, i) => {
    const delay = Math.min(i * 40, 320)
    const canSend = alert.status === 'approved' || alert.status === 'auto_approved' || alert.status === 'auto-approved'
    // The metric was rendered straight from the API — `precipitation_mm`,
    // `conflict_events_count_7d` — as the line that says why this alert fired.
    // It is now the metric's name and unit.
    const metric = alert.metric_expression || alert.metric || ''
    const metricText = metric.includes(' ')
      ? metric
      : metricLabel(metric)
    const statusText = String(alert.status || '').replace(/_/g, ' ')
    return `<div class="alert-item" style="animation-delay:${delay}ms" role="listitem">
      <div class="alert-item-row">
        <span class="sev-chip sev-${sevClass(alert.severity)}">${escapeHtml(alert.severity || 'unknown')}</span>
        <span class="alert-rule-name">${escapeHtml(alert.rule_name || metricLabel(alert.metric) || alert.id || '')}</span>
        <span class="alert-timestamp">${displayDate(alert.created_at)}</span>
      </div>
      <div class="alert-item-meta">
        <span class="alert-metric">${escapeHtml(metricText)}</span>
        <span class="status-pill status-${safeClass(alert.status || 'unknown')}">${escapeHtml(statusText)}</span>
      </div>
      <div class="item-actions">
        <button class="btn btn-xs btn-approve" data-id="${escapeHtml(alert.id)}" data-action="approve"
                data-i18n="action.approve">Approve</button>
        <button class="btn btn-xs btn-reject" data-id="${escapeHtml(alert.id)}" data-action="reject"
                data-i18n="action.reject">Reject</button>
        <button class="btn btn-xs btn-send" data-id="${escapeHtml(alert.id)}" data-action="send"
                ${canSend ? '' : 'disabled'} data-i18n="action.send">Send</button>
      </div>
    </div>`
  }).join('')

  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const { id, action } = e.currentTarget.dataset
      handleAlertAction(id, action)
    })
  })
}

$('alertFilterChips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip')
  if (!chip) return
  state.alertFilter = chip.dataset.filter
  syncAlertFilterChips()
  syncFiltersToUrl()
  renderAlertsPanel()
})

async function handleAlertAction(id, action) {
  const safeId = encodeURIComponent(id)
  if (action === 'approve') {
    const payload = await postJson(`/api/v1/alert-events/${safeId}/approve`, { actor: 'dashboard' })
    setStatus(payload.success ? `Alert approved.` : (payload.error || 'Approve failed'))
  } else if (action === 'reject') {
    const payload = await postJson(`/api/v1/alert-events/${safeId}`, { status: 'rejected' })
    setStatus(payload.success ? `Alert rejected.` : (payload.error || 'Reject failed'))
  } else if (action === 'send') {
    const alert = (state.data.alerts?.data || []).find((a) => a.id === id)
    if (alert && (alert.severity === 'high' || alert.severity === 'critical')) {
      openDispatchGateDialog(alert)
      return
    }
    const urns = prompt('URNs (comma-separated, e.g. +254700000000):')
    if (!urns) return
    const payload = await postJson(`/api/v1/rapidpro/alert-events/${safeId}/send`, {
      urns: urns.split(',').map((u) => u.trim()).filter(Boolean),
    })
    setStatus(payload.success ? 'Alert sent via RapidPro.' : (payload.error || 'Send failed'))
  }
  await refresh()
}

// =============================================================
// Reports panel
// =============================================================
function renderReportsPanel() {
  const container = $('reportsList')
  if (!container) return
  const reports = state.reports

  if (!reports.length) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(t('state.empty_reports'))}</p></div>`
  } else {
    container.innerHTML = reports.map((r) => {
      const canApprove = r.status === 'ready' || r.status === 'draft'
      const canDist    = r.status === 'approved' || r.status === 'ready'
      return `<div class="report-item" role="listitem">
        <div class="report-item-title">${escapeHtml(r.title || r.template_name || 'Untitled report')}</div>
        <div class="report-item-meta">
          <span class="status-pill status-${safeClass(r.status || 'draft')}">${escapeHtml(r.status || '')}</span>
          <span>${displayDate(r.generated_at)}</span>
        </div>
        <div class="item-actions">
          ${canApprove ? `<button class="btn btn-xs btn-approve" data-id="${escapeHtml(r.id)}" data-action="approve">Approve</button>` : ''}
          ${canDist    ? `<button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="distribute">Distribute</button>` : ''}
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-md">MD</button>
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-csv">CSV</button>
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-json">JSON</button>
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-geojson">GeoJSON</button>
        </div>
      </div>`
    }).join('')

    container.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const { id, action } = e.currentTarget.dataset
        handleReportAction(id, action)
      })
    })
  }

  // Populate template select
  const sel = $('reportTemplateIdInput')
  if (sel) {
    const cur = sel.value
    sel.innerHTML = `<option value="">None (create new)</option>` +
      state.templates.map((tmpl) => `<option value="${escapeHtml(tmpl.id)}">${escapeHtml(tmpl.name)}</option>`).join('')
    if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) sel.value = cur
    else if (state.templates[0] && !sel.value) sel.value = state.templates[0].id
  }
}

async function handleReportAction(id, action) {
  const safeId = encodeURIComponent(id)
  if (action === 'approve') {
    const payload = await postJson(`/api/v1/reports/${safeId}/approve`, { actor: 'dashboard' })
    setStatus(payload.success ? `Report approved.` : (payload.error || 'Approve failed'))
    await refresh()
  } else if (action === 'distribute') {
    const payload = await postJson(`/api/v1/reports/${safeId}/distribute`, { channels: [{ channel: 'markdown_download' }] })
    if (payload.success || payload.report) {
      window.open(`/api/v1/reports/${safeId}/export.md`, '_blank')
      setStatus('Report distributed.')
    } else {
      setStatus(payload.error || 'Distribute failed')
    }
    await refresh()
  } else if (action === 'export-md') {
    window.open(`/api/v1/reports/${safeId}/export.md`, '_blank')
  } else if (action === 'export-csv') {
    window.open(`/api/v1/reports/${safeId}/export.csv`, '_blank')
  } else if (action === 'export-json') {
    window.open(`/api/v1/reports/${safeId}/export.json`, '_blank')
  } else if (action === 'export-geojson') {
    window.open(`/api/v1/reports/${safeId}/export.geojson`, '_blank')
  }
}

$('newReportButton')?.addEventListener('click', () => {
  const form = $('newReportForm')
  if (form) form.hidden = !form.hidden
})

$('generateReportButton')?.addEventListener('click', generateReport)
$('createReportTemplateButton')?.addEventListener('click', createReportTemplate)

function reportScope() {
  return Object.fromEntries(Object.entries({
    country:         $('reportCountryInput')?.value?.trim(),
    incident_id:     $('reportIncidentInput')?.value?.trim(),
    intervention_id: $('reportInterventionInput')?.value?.trim(),
  }).filter(([, v]) => v))
}

function reportSections() {
  return ($('reportSectionsInput')?.value || 'executive_summary,incident_summary,appendix_sources')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

async function createReportTemplate() {
  setStatus('Creating report template...')
  const body = {
    name: 'SITREP',
    report_type: 'situation_report',
    title_pattern: 'SITREP - {{country}} - {{date}}',
    default_filters: reportScope(),
    sections: reportSections(),
  }
  const payload = await postJson('/api/v1/report-templates', body)
  if (!payload.success) { setStatus(payload.error || 'Template creation failed'); return }
  const sel = $('reportTemplateIdInput')
  if (sel) sel.value = payload.data.id
  setStatus(`Created template ${payload.data.id}.`)
  await refresh()
}

async function generateReport() {
  setStatus('Generating report...')
  let templateId = $('reportTemplateIdInput')?.value?.trim()
  if (!templateId) {
    await createReportTemplate()
    templateId = $('reportTemplateIdInput')?.value?.trim()
  }
  const payload = await postJson('/api/v1/reports', { template_id: templateId, scope: reportScope(), generate: true })
  if (!payload.success) { setStatus(payload.error || 'Report generation failed'); return }
  setStatus(`Generated report ${payload.data.id}.`)
  await refresh()
}

async function approveLatestReport() {
  const report = state.reports.find((r) => r.status === 'ready') || state.reports[0]
  if (!report) { setStatus('No report to approve.'); return }
  const payload = await postJson(`/api/v1/reports/${report.id}/approve`, {})
  setStatus(payload.success ? `Approved report ${payload.data.id}.` : (payload.error || 'Approval failed'))
  await refresh()
}

async function distributeLatestReport() {
  const report = state.reports.find((r) => ['ready', 'approved'].includes(r.status)) || state.reports[0]
  if (!report) { setStatus('No report to distribute.'); return }
  const payload = await postJson(`/api/v1/reports/${report.id}/distribute`, { channels: [{ channel: 'markdown_download' }] })
  if (!payload.success) { setStatus(payload.error || payload.data?.[0]?.error || 'Distribution failed'); return }
  window.open(`/api/v1/reports/${report.id}/export.md`, '_blank')
  setStatus(`Prepared Markdown export for report ${report.id}.`)
  await refresh()
}

// =============================================================
// Ingestion panel
// =============================================================
async function loadSources() {
  const response = await fetch('/api/v1/sources')
  const payload = await response.json()
  const grid = $('sourceGrid')
  if (!grid) return
  const defaultSources = ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms']
  grid.innerHTML = payload.data.map((source) => `
    <label title="${escapeHtml(source.name)}">
      <input type="checkbox" value="${escapeHtml(source.id)}" ${defaultSources.includes(source.id) ? 'checked' : ''}>
      <span>${escapeHtml(source.id)}</span>
    </label>
  `).join('')
}

function renderIngestionPanel() {
  const healthData = state.data.ingestionHealth?.data || []
  const sources    = state.data.sources?.data || []
  const container  = $('sourceStatusList')
  if (!container) return

  container.innerHTML = sources.map((source) => {
    const health  = healthData.find((h) => h.source === source.id) || {}
    const run     = source.last_run
    const status  = health.status || (run ? run.status : 'never_run')
    const dotCls  = status === 'fresh' ? 'health-dot-fresh'
      : status === 'failed' ? 'health-dot-failed'
      : status === 'stale'  ? 'health-dot-stale'
      : 'health-dot-never-run'
    const nextRun = health.schedule?.next_run_at ? `next ${displayDate(health.schedule.next_run_at)}` : ''
    const records = run ? `${escapeHtml(String(run.records_processed))} records` : ''
    const meta = [displayDate(run?.completed_at), records, nextRun].filter(Boolean).join(' · ')

    // "never_run" with no explanation invites "is this broken?". For sources
    // that are unavailable by design — no keyless access, or an upstream
    // layout change — say which, from the catalog's own metadata rather than
    // hard-coding it here.
    const unavailable = source.requires_credentials
      ? `Needs configuration: ${source.credential_hint || 'a credential is required'}`
      : source.status_note || ''
    const lastError = run?.errors?.length ? run.errors[run.errors.length - 1] : ''
    const reason = unavailable || lastError || ''

    return `<div class="source-card${reason ? ' is-unavailable' : ''}">
      <div class="source-card-header">
        <span class="health-dot ${dotCls}"></span>
        <span class="source-name">${escapeHtml(source.name)}</span>
        <span class="status-pill status-${safeClass(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="source-meta">${meta || '<span class="source-idle">no runs recorded</span>'}</div>
      ${reason ? `<div class="source-reason">${escapeHtml(reason)}</div>` : ''}
      <div class="item-actions">
        <button class="btn btn-xs" data-source="${escapeHtml(source.id)}" data-action="run-source"
                data-i18n="action.run_now">Run now</button>
        <button class="btn btn-xs" data-source="${escapeHtml(source.id)}" data-action="view-lineage"
                data-i18n="action.view_lineage">Lineage</button>
      </div>
    </div>`
  }).join('')

  container.querySelectorAll('[data-action="run-source"]').forEach((btn) => {
    btn.addEventListener('click', (e) => runSingleSource(e.currentTarget.dataset.source))
  })
}

async function runSingleSource(sourceId) {
  setStatus(`Running ${sourceId}...`)
  const payload = await postJson('/api/v1/ingest/run', { sources: [sourceId] })
  setStatus(payload.success ? `Ran ${sourceId}.` : (payload.error || 'Ingestion failed'))
  await refresh()
}

async function runIngestion() {
  setStatus('Running ingestion...')
  const grid = $('sourceGrid')
  const selectedSources = [...(grid?.querySelectorAll('input:checked') || [])].map((inp) => inp.value)
  const payload = await postJson('/api/v1/ingest/run', {
    sources: selectedSources,
    regions: [{
      name:    $('regionInput')?.value,
      country: $('countryInput')?.value,
      lat:     Number($('latInput')?.value),
      lon:     Number($('lonInput')?.value),
    }],
  })
  if (!payload.success) { setStatus(payload.error || 'Ingestion failed'); return }
  setStatus(`Ingestion complete. ${payload.source_runs.length} source runs recorded.`)
  await refresh()
}

async function createPublicIngestionSchedules() {
  setStatus('Creating default public ingestion schedules...')
  const payload = await postJson('/api/v1/ingest/schedules/defaults', {})
  setStatus(payload.success ? `Created ${payload.created} ingestion schedules.` : (payload.error || 'Ingestion schedule creation failed'))
  await refresh()
}

async function runDueIngestion() {
  setStatus('Running due public ingestion schedules...')
  const payload = await postJson('/api/v1/ingest/run-due', {})
  setStatus(payload.success ? `Completed ${payload.data.length} due source runs.` : (payload.error || 'Due ingestion failed'))
  await refresh()
}

async function importServiceAssets(kind) {
  setStatus(`Importing service assets as ${kind.toUpperCase()}...`)
  const key = kind === 'geojson' ? 'service_assets_geojson' : 'service_assets_csv'
  const response = await fetch('/api/v1/service-assets', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ [key]: $('serviceAssetInput')?.value }),
  })
  const payload = await response.json()
  setStatus(payload.success ? `Imported ${payload.imported} service assets.` : ((payload.errors || [payload.error]).join(' | ')))
  await refresh()
}

// =============================================================
// Settings panel
// =============================================================
function renderSettingsPanel() {
  fetchJson('/api/v1/trigger-protocols').then((payload) => {
    const list = $('triggerProtocolsList')
    if (!list) return
    const protos = payload.data || []
    list.innerHTML = protos.length
      ? protos.map((p) => `<div class="source-card"><div class="source-card-header">
          <span class="source-name">${escapeHtml(p.name || p.id)}</span>
        </div></div>`).join('')
      : `<p class="settings-note">No trigger protocols configured.</p>`
  }).catch(() => {
    const list = $('triggerProtocolsList')
    if (list) list.innerHTML = `<p class="settings-note">Trigger protocols unavailable.</p>`
  })

  fetchJson('/api/v1/webhooks').then((payload) => {
    const list = $('webhooksList')
    if (!list) return
    const webhooks = payload.data || []
    list.innerHTML = webhooks.length
      ? webhooks.map((w) => `<div class="source-card"><div class="source-card-header">
          <span class="source-name">${escapeHtml(w.url || w.id)}</span>
          <span class="status-pill status-${safeClass(w.status || 'unknown')}">${escapeHtml(w.status || 'unknown')}</span>
        </div></div>`).join('')
      : `<p class="settings-note">No webhooks configured.</p>`
  }).catch(() => {})
}

$('addWebhookForm')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const url    = $('webhookUrlInput')?.value?.trim()
  const events = ($('webhookEventsInput')?.value || 'alert.*').split(',').map((s) => s.trim()).filter(Boolean)
  if (!url) return
  const payload = await postJson('/api/v1/webhooks', { url, events })
  setStatus(payload.success ? `Webhook added.` : (payload.error || 'Webhook failed'))
  renderSettingsPanel()
})

// Operations forms
$('createIncidentButton')?.addEventListener('click', createIncident)
$('createInterventionButton')?.addEventListener('click', createIntervention)
$('createTaskButton')?.addEventListener('click', createTask)
$('createAlertRuleButton')?.addEventListener('click', createAlertRule)
$('evaluateAlertsButton')?.addEventListener('click', evaluateAlerts)
$('sendRapidProAlertButton')?.addEventListener('click', sendLatestRapidProAlert)
$('createReportScheduleButton')?.addEventListener('click', createReportSchedule)
$('runDueReportsButton')?.addEventListener('click', runDueReports)

async function createIncident() {
  setStatus('Creating incident...')
  const body = {
    title:         $('incidentTitleInput')?.value,
    incident_type: $('incidentTypeInput')?.value,
    priority:      $('incidentPriorityInput')?.value,
    country:       $('countryInput')?.value,
    latitude:      Number($('latInput')?.value),
    longitude:     Number($('lonInput')?.value),
  }
  // A field report raised without connectivity is the ordinary case this app is
  // meant to survive, so the write is queued rather than rejected.
  const payload = await queueRequest('/api/v1/incidents', body)
  if (payload?.queued) {
    setStatus('Incident queued — it will be sent when the connection returns.')
    return
  }
  if (!payload?.success) { setStatus(payload?.error || 'Incident creation failed'); return }
  const intInput = $('interventionIncidentInput')
  if (intInput) intInput.value = payload.data.id
  setStatus(`Created incident ${payload.data.id}.`)
  await refresh()
}

async function createIntervention() {
  setStatus('Creating intervention...')
  const body = {
    incident_id: $('interventionIncidentInput')?.value,
    title:       $('interventionTitleInput')?.value,
    lead_org:    $('interventionLeadInput')?.value,
    status:      'active',
  }
  const payload = await postJson('/api/v1/interventions', body)
  if (!payload.success) { setStatus(payload.error || 'Intervention creation failed'); return }
  const taskInput = $('taskInterventionInput')
  if (taskInput) taskInput.value = payload.data.id
  setStatus(`Created intervention ${payload.data.id}.`)
  await refresh()
}

async function createTask() {
  setStatus('Creating task...')
  const body = {
    intervention_id: $('taskInterventionInput')?.value,
    title:           $('taskTitleInput')?.value,
    owner:           $('taskOwnerInput')?.value,
    status:          'todo',
  }
  const payload = await postJson('/api/v1/tasks', body)
  if (!payload.success) { setStatus(payload.error || 'Task creation failed'); return }
  setStatus(`Created task ${payload.data.id}.`)
  await refresh()
}

async function createAlertRule() {
  setStatus('Creating alert rule...')
  const payload = await postJson('/api/v1/alert-rules', {
    name:      $('alertNameInput')?.value,
    metric:    $('alertMetricInput')?.value,
    operator:  '>=',
    threshold: Number($('alertThresholdInput')?.value),
    severity:  'high',
    actions:   [{ type: 'notify', target: 'response-lead' }],
  })
  if (!payload.success) { setStatus(payload.error || 'Alert rule creation failed'); return }
  setStatus(`Created alert rule ${payload.data.id}.`)
  await refresh()
}

async function evaluateAlerts() {
  setStatus('Evaluating alert rules...')
  const payload = await postJson('/api/v1/alerts/evaluate', {})
  if (!payload.success) { setStatus(payload.error || 'Alert evaluation failed'); return }
  setStatus(`Evaluated ${payload.evaluated} rules; created ${payload.created} alert events.`)
  await refresh()
}

async function sendLatestRapidProAlert() {
  setStatus('Sending latest alert through RapidPro...')
  const alerts = await fetchJson('/api/v1/alert-events?status=open&limit=1')
  const alert = alerts.data?.[0]
  if (!alert) { setStatus('No open alert event to send.'); return }
  const urns = $('rapidProUrnsInput')?.value?.split(',').map((u) => u.trim()).filter(Boolean)
  const payload = await postJson(`/api/v1/rapidpro/alert-events/${alert.id}/send`, { urns })
  if (!payload.success) { setStatus(payload.data?.error || payload.error || 'RapidPro dispatch failed'); return }
  setStatus(`RapidPro dispatch ${payload.data.id} recorded.`)
  await refresh()
}

async function createReportSchedule() {
  setStatus('Creating report schedule...')
  let templateId = $('reportTemplateIdInput')?.value?.trim()
  if (!templateId) {
    await createReportTemplate()
    templateId = $('reportTemplateIdInput')?.value?.trim()
  }
  const localValue = $('reportScheduleNextRunInput')?.value
  const payload = await postJson('/api/v1/report-schedules', {
    template_id:  templateId,
    timezone:     Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    recurrence:   { type: 'daily', time: '07:00' },
    next_run_at:  localValue ? new Date(localValue).toISOString() : undefined,
    auto_distribute: false,
  })
  if (!payload.success) { setStatus(payload.error || 'Report schedule creation failed'); return }
  setStatus(`Created report schedule ${payload.data.id}.`)
  await refresh()
}

async function runDueReports() {
  setStatus('Running due report schedules...')
  const payload = await postJson('/api/v1/report-schedules/run-due', {})
  if (!payload.success) { setStatus(payload.error || 'Due report run failed'); return }
  setStatus(`Completed ${payload.data.length} due report schedule runs.`)
  await refresh()
}

// =============================================================
// Detail dialog
// =============================================================
const detailDialog  = $('detailDialog')
const detailTitleEl = $('detailTitle')
const detailBodyEl  = $('detailBody')

/**
 * Where the keyboard was before a modal dialog took it.
 *
 * A dialog restores focus to whatever had it when it closed, but most dialogs
 * here are opened by clicking an SVG marker: a <circle> is not focusable, so
 * activeElement is <body> and focus falls back to the top of the document. The
 * operator closes the detail and has to Tab through the whole header again to
 * get back to the map. Remember the opener and put it back, or land on the rail
 * rather than nowhere.
 */
const _dialogOpeners = new WeakMap()

function rememberDialogOpener(dialog) {
  const active = document.activeElement
  _dialogOpeners.set(dialog, active === document.body ? null : active)
}

function restoreDialogFocus(dialog) {
  const opener = _dialogOpeners.get(dialog)
  _dialogOpeners.delete(dialog)
  // tabIndex >= 0, not just isConnected: the opener may be a live button that
  // the 30-second refresh has already replaced, or an element the console
  // marked unfocusable. Focusing either is a no-op that still loses the place.
  if (opener && opener.isConnected && opener.tabIndex >= 0) {
    opener.focus()
    return
  }
  $('railPanel')?.focus()
}

function openDetailDialog(record) {
  if (!detailDialog) return
  const label = record.title || record.name || record.event_type || record.id || 'Detail'
  detailTitleEl.textContent = label
  const entries = Object.entries(record).filter(([k]) => k !== 'metadata')
  detailBodyEl.innerHTML = `<dl>${entries.map(([k, v]) =>
    `<dt>${escapeHtml(k.replaceAll('_', ' '))}</dt><dd>${escapeHtml(String(v ?? ''))}</dd>`
  ).join('')}</dl>`
  rememberDialogOpener(detailDialog)
  detailDialog.showModal()
}

detailDialog?.addEventListener('click', (e) => {
  if (e.target === detailDialog) detailDialog.close()
})

// `close` rather than a click handler: Esc, the backdrop and the close button
// all end the dialog, and only the event fires for every one of them.
detailDialog?.addEventListener('close', () => restoreDialogFocus(detailDialog))

document.querySelectorAll('.dialog-close').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('dialog')?.close())
})

// =============================================================
// Command palette
// =============================================================
const cmdPalette   = $('commandPalette')
const paletteInput = $('paletteInput')
const paletteResults = $('paletteResults')

const PALETTE_BASE = [
  { icon: '1', label: 'Alerts tab',              category: 'Navigation', action: () => switchTab('alerts') },
  { icon: '2', label: 'Reports tab',             category: 'Navigation', action: () => switchTab('reports') },
  { icon: '3', label: 'Ingestion tab',           category: 'Navigation', action: () => switchTab('ingestion') },
  { icon: '4', label: 'Settings tab',            category: 'Navigation', action: () => switchTab('settings') },
  { icon: '>', label: 'Run all due sources',     category: 'Ingestion',  action: runDueIngestion },
  { icon: '>', label: 'Create default schedules',category: 'Ingestion',  action: createPublicIngestionSchedules },
  { icon: '+', label: 'Generate report',         category: 'Reports',   action: generateReport },
  { icon: '+', label: 'Approve latest report',   category: 'Reports',   action: approveLatestReport },
  { icon: '+', label: 'Distribute latest report',category: 'Reports',   action: distributeLatestReport },
  { icon: '!', label: 'Evaluate alert rules',    category: 'Alerts',    action: evaluateAlerts },
  { icon: '?', label: 'Keyboard shortcuts',      category: 'Help',      action: () => $('shortcutDialog')?.showModal() },
  { icon: '~', label: 'Export GeoJSON',          category: 'Export',    action: () => window.open('/api/v1/export.geojson', '_blank') },
  { icon: '~', label: 'Export CSV',              category: 'Export',    action: () => window.open('/api/v1/export.csv', '_blank') },
  { icon: 'r', label: 'Refresh data',            category: 'System',    action: refresh },
]

function openPalette() {
  if (!cmdPalette) return
  if (paletteInput) paletteInput.value = ''
  state._paletteIndex = 0
  renderPaletteResults('')
  cmdPalette.showModal()
  paletteInput?.focus()
}

function renderPaletteResults(query) {
  const q = query.trim().toLowerCase()
  const recentAlerts = (state.data.alerts?.data || []).slice(0, 3).map((a) => ({
    icon: '!',
    label: `Alert: ${a.rule_name || a.id || ''}`,
    category: 'Recent alerts',
    action: () => { switchTab('alerts'); openDetailDialog(a) },
  }))

  const all = [...recentAlerts, ...PALETTE_BASE]
  const items = q
    ? all.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q))
    : all

  state._paletteItems = items
  state._paletteIndex = 0

  paletteResults.innerHTML = items.map((item, i) => `
    <li class="palette-result${i === 0 ? ' selected' : ''}" id="paletteOption${i}"
        data-index="${i}" role="option" aria-selected="${i === 0}">
      <span class="palette-result-icon">${escapeHtml(item.icon)}</span>
      <span class="palette-result-label">${escapeHtml(item.label)}</span>
      <span class="palette-result-category">${escapeHtml(item.category)}</span>
    </li>
  `).join('')

  paletteResults.querySelectorAll('.palette-result').forEach((li, i) => {
    li.addEventListener('click', () => {
      cmdPalette.close()
      items[i]?.action?.()
    })
  })

  syncPaletteSelection()
}

/**
 * Point the selection at the active option.
 *
 * The arrow keys move a class on an <li>, and DOM focus never leaves the input,
 * so without aria-activedescendant a screen reader announced an unchanged search
 * box while the user arrowed through it. And because the highlight moved without
 * the scroll moving, anything past the fold was selected and invisible — the list
 * looked stuck at the top no matter how far down the operator had gone.
 */
function syncPaletteSelection() {
  const options = [...paletteResults.querySelectorAll('.palette-result')]
  if (!options.length) {
    paletteInput?.removeAttribute('aria-activedescendant')
    paletteResults.removeAttribute('aria-activedescendant')
    return
  }
  const index = Math.min(state._paletteIndex, options.length - 1)
  state._paletteIndex = index
  options.forEach((li, i) => {
    const selected = i === index
    li.classList.toggle('selected', selected)
    li.setAttribute('aria-selected', String(selected))
  })
  const activeId = options[index].id
  paletteInput?.setAttribute('aria-activedescendant', activeId)
  paletteResults.setAttribute('aria-activedescendant', activeId)
  options[index].scrollIntoView({ block: 'nearest' })
}

paletteInput?.addEventListener('input', debounce((e) => renderPaletteResults(e.target.value), 100))

paletteInput?.addEventListener('keydown', (e) => {
  const count = paletteResults.querySelectorAll('.palette-result').length
  if (!count) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    state._paletteIndex = Math.min(state._paletteIndex + 1, count - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    state._paletteIndex = Math.max(state._paletteIndex - 1, 0)
  } else if (e.key === 'Home') {
    e.preventDefault()
    state._paletteIndex = 0
  } else if (e.key === 'End') {
    e.preventDefault()
    state._paletteIndex = count - 1
  } else if (e.key === 'Enter') {
    e.preventDefault()
    cmdPalette.close()
    state._paletteItems[state._paletteIndex]?.action?.()
    return
  } else {
    return
  }
  syncPaletteSelection()
})

cmdPalette?.addEventListener('click', (e) => {
  if (e.target === cmdPalette) cmdPalette.close()
})

$('cmdPaletteButton')?.addEventListener('click', openPalette)

// =============================================================
// Keyboard shortcuts
// =============================================================
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName?.toLowerCase()
  const inInput = ['input', 'textarea', 'select'].includes(tag)

  // Cmd/Ctrl+K from anywhere
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openPalette()
    return
  }

  // Native Esc already closes a modal dialog, and this second handler closed it
  // again on the same keypress — so which of the two close listeners ran first
  // decided whether the dialog's own teardown (clearing held state, restoring
  // focus) saw an open or an already-closed element. Only a dialog opened with
  // show() rather than showModal() still needs us.
  if (e.key === 'Escape') {
    document.querySelectorAll('dialog[open]:not(:modal)').forEach((dlg) => dlg.close())
  }

  if (inInput) return

  if (e.key === '/') { e.preventDefault(); $('mapSeverity')?.focus(); return }
  if (e.key === '?') { $('shortcutDialog')?.showModal(); return }
  if (e.key === 'r' || e.key === 'R') { refresh(); return }
  if (e.key === '1') { switchTab('alerts'); return }
  if (e.key === '2') { switchTab('reports'); return }
  if (e.key === '3') { switchTab('ingestion'); return }
  if (e.key === '4') { switchTab('settings'); return }
})

// =============================================================
// Locale select
// =============================================================
const locSel = $('locale-select')
if (locSel) {
  locSel.value = state.locale
  locSel.addEventListener('change', async (e) => {
    state.locale = e.target.value
    localStorage.setItem('lindela_lite_locale', state.locale)
    await loadLocale(state.locale)
  })
}

// =============================================================
// Button wiring
// =============================================================
$('refreshButton')?.addEventListener('click', refresh)
$('runButton')?.addEventListener('click', runIngestion)
$('createIngestionSchedulesButton')?.addEventListener('click', createPublicIngestionSchedules)
$('runDueIngestionButton')?.addEventListener('click', runDueIngestion)
$('importCsvButton')?.addEventListener('click', () => importServiceAssets('csv'))
$('importGeoJsonButton')?.addEventListener('click', () => importServiceAssets('geojson'))
$('exportGeoJsonButton')?.addEventListener('click', () => window.open('/api/v1/export.geojson', '_blank'))
$('exportCsvButton')?.addEventListener('click', () => window.open('/api/v1/export.csv', '_blank'))

// =============================================================
// Dispatch gate dialog handlers
// =============================================================
$('dispatchGateDialog')?.querySelector('[data-action="cancel"]')?.addEventListener('click', closeDispatchGateDialog)
$('dispatchGateDialog')?.querySelector('[data-action="confirm"]')?.addEventListener('click', async () => {
  const alert = state._dispatchGateAlert
  if (!alert) return
  const focalPoint = $('dispatchFocalPoint')?.value || 'unknown'
  const reason = $('dispatchReason')?.value || 'manual_override'
  const safeId = encodeURIComponent(alert.id)
  try {
    await postJson(`/api/v1/alert-events/${safeId}/approve`, {
      decision: 'approved',
      actor: focalPoint,
      note: reason,
    })
    const payload = await postJson(`/api/v1/rapidpro/alert-events/${safeId}/send`, {
      urns: [],
    })
    setStatus(payload.success ? 'High-severity alert approved and dispatched.' : (payload.error || 'Dispatch failed'))
  } catch (err) {
    setStatus('Dispatch failed: ' + err.message)
  }
  closeDispatchGateDialog()
  await refresh()
})

const dialogClose = $('dispatchGateDialog')?.querySelector('.dialog-close')
if (dialogClose) dialogClose.addEventListener('click', closeDispatchGateDialog)

// =============================================================
// Cold chain toggle
// =============================================================
$('coldChainToggle')?.addEventListener('change', (e) => {
  state.filters.coldChain = e.target.checked
  syncFiltersToUrl()
  reRenderMapFromState()
})

// =============================================================
// Equity audit trigger
// =============================================================
$('triggerEquityAuditButton')?.addEventListener('click', async () => {
  const district = prompt('Enter district for equity audit:')
  if (!district) return
  setStatus('Triggering equity audit workflow...')
  const payload = await postJson('/api/v1/workflows', {
    type: 'equity_audit_action',
    state: 'threshold_breached',
    district: district,
  })
  setStatus(payload.success ? `Equity audit workflow triggered for ${district}.` : (payload.error || 'Workflow trigger failed'))
  await refresh()
})

// =============================================================
// DHIS2 settings (localStorage only; no credential backend)
// =============================================================
;(function dhis2Settings() {
  const LS_KEY = 'lindela_lite_dhis2'
  const fields = ['dhis2BaseUrl', 'dhis2ApiToken', 'dhis2OrgUnits', 'dhis2DataElements', 'dhis2Period']
  const saveBtn = $('dhis2SaveBtn')
  const testBtn = $('dhis2TestBtn')
  const resultEl = $('dhis2TestResult')
  if (!saveBtn) return

  // Restore from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    if (saved.base_url) $('dhis2BaseUrl').value = saved.base_url
    if (saved.api_token) $('dhis2ApiToken').value = saved.api_token
    if (saved.org_units) $('dhis2OrgUnits').value = saved.org_units.join('\n')
    if (saved.data_elements) $('dhis2DataElements').value = saved.data_elements.join('\n')
    if (saved.period) $('dhis2Period').value = saved.period
  } catch {}

  saveBtn.addEventListener('click', () => {
    const cfg = {
      base_url: $('dhis2BaseUrl').value.trim(),
      api_token: $('dhis2ApiToken').value.trim(),
      org_units: $('dhis2OrgUnits').value.split('\n').map((s) => s.trim()).filter(Boolean),
      data_elements: $('dhis2DataElements').value.split('\n').map((s) => s.trim()).filter(Boolean),
      period: $('dhis2Period').value.trim(),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(cfg))
    if (resultEl) {
      resultEl.textContent = 'Settings saved to localStorage.'
      resultEl.style.color = 'var(--color-success, #16a34a)'
      resultEl.style.display = ''
    }
  })

  testBtn.addEventListener('click', async () => {
    if (resultEl) {
      resultEl.textContent = 'Testing...'
      resultEl.style.color = 'inherit'
      resultEl.style.display = ''
    }
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      const payload = await postJson('/api/v1/ingest/run', {
        sources: ['dhis2'],
        base_url: saved.base_url || null,
        api_token: saved.api_token || null,
        org_units: saved.org_units || [],
        data_elements: saved.data_elements || [],
        period: saved.period || null,
      })
      const errors = payload.source_runs?.[0]?.errors || payload.errors || []
      if (resultEl) {
        if (errors.length) {
          resultEl.textContent = `DHIS2: ${errors.join('; ')}`
          resultEl.style.color = '#b45309'
        } else {
          resultEl.textContent = 'DHIS2 connection OK.'
          resultEl.style.color = 'var(--color-success, #16a34a)'
        }
      }
    } catch (err) {
      if (resultEl) {
        resultEl.textContent = `Error: ${err.message}`
        resultEl.style.color = '#dc2626'
      }
    }
  })
})()

// =============================================================
// Auto-refresh (30s)
// =============================================================
setInterval(refresh, 30_000)

// =============================================================
// Boot
// =============================================================
await loadLocale(state.locale)
await loadSources()
restoreFiltersFromUrl()
await refresh()
// The build version shown in the Settings panel comes from the health
// endpoint, which reads package.json, rather than from a literal in the markup
// that can drift behind the release.
fillAppVersion()
