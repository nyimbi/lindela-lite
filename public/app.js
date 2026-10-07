// =============================================================
// Lindela Lite — Operations Console
// =============================================================
import { REGION_POLYGONS, INDIAN_OCEAN_POLYGON, LAKE_VICTORIA, PILOT_DISTRICTS } from '/shared/basemap.js'
import { FLOOD_DEPTH_BANDS, floodCellsForGrid, floodCoverage, surveyedAreaKm2 } from '/shared/flood-bands.js'
import { globalEventQuery, isFinitePoint, localEventQuery, mapFrame, mergeEventSets, withinBbox, NEAR_REGION_MARGIN_DEG, REGION_OF_INTEREST } from '/shared/map-frame.js'
import { seasonalNarrative, seasonalPhaseLabel, readSeasonalState, seasonalCalendar, seasonalCalendarNote } from '/shared/seasonal.js'
import { decodeView, encodeView, isCustom, resolveView, shareUrl } from '/shared/view-state.js'
import { fillAppVersion } from '/shared/app-version.js'
import { apiFetch, apiSettled, autoMarkScrollableRegions, initOfflineQueue, initServiceWorker } from '/shared/runtime.js'
import { applyLocaleToDocument, esc as escapeHtml, formatTimestamp, metres, num, pct, safeClass, sevClass, signed, truncate, truncateId } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'
import { formatRelative } from '/shared/fmt.js'
import { describeState, ERROR } from '/shared/states.js'
import { readApiKey, writeApiKey, clearApiKey, bindApiKeyField, hydrateFromSecureStore, keyStorage } from '/shared/secret.js'
import { determinationFor, submitOutcome, fetchCoverage, fetchReasons, coverageNote, reasonOptions, humanReason } from '/shared/outcomes.js'

/**
 * Load a console module the first time something needs it.
 *
 * The subject panel, the escalation view, the operations controls and the
 * record search are each reachable from exactly one affordance, and the budget
 * gate measures what a first paint costs on a field connection. Fetching them
 * with the console meant every operator downloaded them to look at a map they
 * may never have queried. The browser caches the module after the first import,
 * so the second open is as fast as a static one.
 */
const _lazyModules = new Map()
function lazy(path) {
  if (!_lazyModules.has(path)) {
    _lazyModules.set(path, import(path).catch((err) => {
      // A rejected promise cached here would fail every later call identically,
      // and the console would report a broken feature with no way to retry it.
      _lazyModules.delete(path)
      throw err
    }))
  }
  return _lazyModules.get(path)
}

initServiceWorker()

// =============================================================
// State
// =============================================================
const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  catalog: {},
  // Panels the last refresh could not reach. Empty until a refresh runs and
  // nothing failed; a surface that has never polled has not checked anything,
  // and the workflow panel must not say otherwise.
  failedSources: new Set(),
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
  foodSecuritySummary: null,
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

// `#apiKeyInput` is looked up lazily, never captured into a module-scope const.
//
// It lives in the deferred settings panel, so a const captured at load would
// hold `null` for the life of the page: the field would never restore the saved
// key, its `input` listener would never attach, and — because `authHeaders`
// reads the same reference — every authenticated request would go out with no
// key at all. A whole surface silently failing to authenticate, from a
// performance change, in a file with no error and no failing test.
//
// `?.` on the old code hid exactly this: every access was already null-safe,
// so nothing about the failure looked like a failure.
const apiKeyInput       = () => $('apiKeyInput')
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
// ENH/native: the key lives in the Keychain or the Keystore when a shell is
// installed, and in localStorage otherwise. Read here for the synchronous
// answer every request needs; the migration into secure hardware happens once
// below, because it cannot.
const savedApiKey = readApiKey() || ''
hydrateFromSecureStore().then((key) => {
  if (key && key !== savedApiKey) {
    // The vault had a different key than the field was seeded with — a key
    // rotated on another device, or a migration that has just completed.
    const input = apiKeyInput()
    if (input) input.value = key
  }
})

/**
 * Restore the saved API key into the field and start persisting edits.
 *
 * Called at boot and again after the settings panel is mounted. The second call
 * is the one that matters: before the deferral the element existed at load, so
 * this ran once against a live field; now it runs against nothing until the
 * panel is fetched.
 */
function bindApiKeyInput() {
  const input = apiKeyInput()
  if (!input) return false
  if (!input.value) input.value = savedApiKey
  if (input.dataset.lindelaBound === '1') return true
  bindApiKeyField(input)
  return true
}
bindApiKeyInput()

function authHeaders(headers = {}) {
  // Re-read the field on every call rather than caching the element. A request
  // can be made long before the settings panel is opened — the key is set on
  // one tab and used by every other — so a cached reference is a cached
  // "no key", permanently.
  const apiKey = apiKeyInput()?.value?.trim()
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
// Pagination
// =============================================================

/**
 * Rows per page for the console's three long lists.
 *
 * The alert rail fetched 30 and rendered all 30, which on a 900px-tall laptop
 * pushed every action button below the fold; the map's own record list is
 * worse still, since it renders one row per hazard and the hazard count follows
 * whatever GDACS is doing that week. Twenty-five is the figure the plan set and
 * is enough to scan a screen without scrolling.
 */
// The arithmetic lives in shared/paging.js because app.js imports
// browser-absolute specifiers and therefore cannot be required by a Node test
// runner. While it lived here the pager rendered on no list in any test run,
// because no demo list ever exceeded a page — untested logic that had never
// executed. `test/paging.test.js` now covers it directly.
import { LIST_PAGE_SIZE, pageWindow, setPage, pagerSummary } from '/shared/paging.js'
export { LIST_PAGE_SIZE, pageWindow, setPage, pagerSummary }

function renderPager(host, key, total, onGo) {
  if (!host) return
  const { page, pages, start, end } = pageWindow(key, total)
  host.hidden = pages <= 1
  if (pages <= 1) { host.innerHTML = ''; return }

  const link = (n, label, current, disabled) => (
    `<li class="pagination-item"><button type="button" class="pagination-link"
        ${current ? 'aria-current="page"' : ''} ${disabled ? 'aria-disabled="true"' : ''}
        data-page-key="${escapeHtml(key)}" data-page="${n}">${escapeHtml(label)}</button></li>`
  )
  // Windowed page numbers. A 400-row alert list renders 16 links otherwise, and
  // the operator has to read past nine of them to reach the one they want.
  const from = Math.max(1, Math.min(page - 2, pages - 4))
  const to = Math.min(pages, Math.max(page + 2, 5))
  const numbers = []
  for (let n = from; n <= to; n += 1) numbers.push(link(n, String(n), n === page, false))

  host.innerHTML = `<ul class="pagination-list">`
    + link(page - 1, '‹ Prev', false, page === 1)
    + numbers.join('')
    + link(page + 1, 'Next ›', false, page === pages)
    + `</ul><span class="pagination-status">Showing ${start + 1}–${end} of ${total}</span>`

  // The out-of-range guard below is also what makes `aria-disabled` honest: the
  // boundary link carries a page number of 0 or pages+1 and is dropped here, so
  // it stays in the tab order and stays announced without being operable. Per
  // components.css that beats `disabled`, which removes the control from the tab
  // order entirely and leaves a keyboard user never learning it exists.
  host.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = Number(btn.dataset.page)
      if (n < 1 || n > pages || n === page) return
      setPage(key, n, total)
      onGo()
    })
  })
}

/** Jump back to page 1 when the filter that produced the list changes. */
function resetListPage(key) { setPage(key, 1, 0) }

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
  if (seasonalSummaryEl) seasonalSummaryEl.textContent = seasonalSummary(state)
  if (seasonalNoteEl) seasonalNoteEl.textContent = seasonalNarrative(state)
  const advVal = $('seasonalAdvisoryValue')
  const advCount = $('seasonalAdvisoryCount')
  const advQual = $('seasonalAdvisoryQual')
  if (advVal && state) { advVal.textContent = `${state.anomalyC > 0 ? '+' : ''}${state.anomalyC?.toFixed(2) || '—'}` } else if (advVal) { advVal.textContent = '—' }
  if (advCount && state) { const met = Math.min(state.overlappingSeasons || 0, 5); advCount.textContent = `${met} of 5` } else if (advCount) { advCount.textContent = '— of 5' }
  if (advQual && state) { advQual.textContent = state.episodeDeclared ? 'CPC episode criterion met: declared event' : 'Not a declared event — advisory only' } else if (advQual) { advQual.textContent = 'Not ingested — no advisory' }
  if (seasonalIndexEl && state?.indexUsed) {
    seasonalIndexEl.textContent = `Niño 3.4 SST anomaly (${state.indexUsed})`
  }
  renderSeasonalCalendar(observations)
}

/**
 * The month × year calendar under the strip.
 *
 * The strip reports one anomaly. This shows the annual shape — an ENSO warm
 * phase peaks around Nov–Dec and decays through the following spring, and that
 * is invisible in a single number. Twelve cells per year make it legible, and
 * they make the months that were never ingested legible as gaps rather than as
 * neutral conditions.
 *
 * Hidden when nothing is ingested: an empty grid reads as "nothing happened
 * this year", which is a claim about the climate rather than about our
 * coverage.
 *
 * The charting library is loaded the same lazy way the flood-probability strip
 * loads it — a calendar is not worth a tenth of the first load for an operator
 * who only wanted the map.
 */
async function renderSeasonalCalendar(observations) {
  if (!seasonalCalendarFigEl) return
  const calendar = seasonalCalendar(observations)
  if (!calendar) {
    seasonalCalendarFigEl.hidden = true
    if (seasonalCalendarEl) seasonalCalendarEl.innerHTML = ''
    return
  }
  seasonalCalendarFigEl.hidden = false
  if (seasonalCalendarNoteEl) seasonalCalendarNoteEl.textContent = seasonalCalendarNote(calendar)
  if (!seasonalCalendarEl) return
  let heatmap
  try {
    ({ heatmap } = await lazy('/shared/charts.js'))
  } catch {
    // The strip above it carries the same number, so a charting library that
    // fails to load costs the calendar and nothing else. Hiding the figure is
    // better than leaving a caption with no chart under it.
    seasonalCalendarFigEl.hidden = true
    return
  }
  if (!seasonalCalendarEl) return
  // `diverging` because the anomaly is signed: a sequential ramp would put the
  // boundary between "cold" and "warm" in the middle of the observed range
  // instead of at zero, and a −0.1 °C cell would read as strongly cold next to
  // a −1.4 °C one.
  //
  // `width` is stated here rather than left to the library's default because the
  // overlay below is drawn on the same month columns and reproduces this
  // geometry from it. Two independently-defaulted widths would put the flood row
  // half a cell out of register with the calendar, which is the sort of wrong
  // that still looks like a chart.
  const calendarWidth = 480
  seasonalCalendarEl.innerHTML = heatmap(calendar, {
    width: calendarWidth,
    height: Math.max(120, calendar.rows.length * 18 + 34),
    diverging: true,
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°C`,
  }).svg
  await renderSeasonalOverlay(calendar, calendarWidth)
}

/**
 * ENH-20: the hazard and alert row, on the calendar's own month columns.
 *
 * Drawn from the same `state.data` the map is drawn from, so it cannot disagree
 * with the map about what happened. A failure here hides the overlay and leaves
 * the calendar, which is the older and more-used of the two, untouched.
 */
async function renderSeasonalOverlay(calendar, width) {
  if (!seasonalOverlayEl) return
  const hide = () => {
    seasonalOverlayEl.hidden = true
    if (seasonalOverlayCaptionEl) seasonalOverlayCaptionEl.hidden = true
    if (seasonalOverlayNoteEl) seasonalOverlayNoteEl.hidden = true
  }
  let overlay
  try {
    overlay = await lazy('/workflow/wire-seasonal.js')
  } catch {
    hide()
    return
  }
  const counts = overlay.monthlyCounts(calendar, {
    hazards: state.data.events?.data ?? [],
    alerts: state.data.alerts?.data ?? [],
  })
  const height = Math.max(46, calendar.yearsShown.length * 21 + 10)
  seasonalOverlayEl.innerHTML = overlay.seasonalOverlay(calendar, { width, counts, height })
  seasonalOverlayEl.hidden = false
  if (seasonalOverlayCaptionEl) seasonalOverlayCaptionEl.hidden = false
  if (seasonalOverlayNoteEl) {
    seasonalOverlayNoteEl.textContent = overlay.seasonalOverlayNote(counts)
    seasonalOverlayNoteEl.hidden = false
  }
}

/**
 * The one line the seasonal strip shows without a click.
 *
 * Four facts, in the order a reader needs them: what the number is, what it is
 * measured against, how many of the five seasons qualify, and what that does
 * not amount to. The last clause is not decoration — an operator who sees
 * "+2.17 °C, 3 of 5 seasons" and nothing else reasonably reads it as a
 * developing event, which is the claim CPC has not made and this product will
 * not make for them.
 *
 * `seasonalNarrative` already holds every clause; this is the subset that has
 * to survive at 13px.
 */
function seasonalSummary(state) {
  if (!state) {
    return 'Niño 3.4 has not been ingested, so there is no advisory to report. Run the noaa_enso connector to fill it.'
  }
  const seasons = Math.min(state.overlappingSeasons, state.seasonsRequired)
  const sign = state.anomalyC > 0 ? '+' : ''
  return `${state.period}: ${sign}${state.anomalyC.toFixed(2)} °C against a ±${state.thresholdC} °C `
    + `advisory threshold · ${seasons} of ${state.seasonsRequired} seasons. `
    + (state.episodeDeclared
      ? `CPC's episode criterion is met: ${state.overlappingSeasons} consecutive overlapping seasons.`
      : 'This is an advisory, not a declared event.')
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
      // "0 impassable" and "the count did not load" both used to render as
      // "All N roads passable" — the reassuring half of the sentence, from a
      // field that was never filled in.
      const cut = isUndetermined(body.summary?.impassable) ? null : Number(body.summary.impassable)
      if (roadStatusEl && roadOverlayToggle?.checked) {
        roadStatusEl.textContent = cut === null || !Number.isFinite(cut)
          ? 'Road passability not published'
          : cut
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

/**
 * Whether each context source has something to say, and why not if it does not.
 *
 * Two panels reserved for an em dash is worse than one line that says so. But
 * "one line that says so" is only honest if the line is always there: a strip
 * that hides itself when its data is absent is indistinguishable from a strip
 * whose data is legitimately empty, and an operator checking whether anyone is
 * in food crisis cannot tell those apart. So presence is recorded separately
 * from content and the empty state is rendered from it.
 */
const contextPresence = { food: 'loading', disease: 'loading' }

async function loadFoodSecuritySummary() {
  try {
    const body = await fetchJson('/api/v1/food-security/summary')
    if (!body?.success) {
      contextPresence.food = 'unavailable'
    } else {
      state.foodSecuritySummary = body.data
      const worst = body.data?.worst_areas?.[0]
      contextPresence.food = (worst || body.data?.countries?.length) ? 'present' : 'empty'
    }
  } catch {
    contextPresence.food = 'unavailable'
  }
  renderFoodSecurityStrip(state.foodSecuritySummary)
  renderContextStrips()
}

function renderFoodSecurityStrip(summary) {
  if (!ipcStripEl) return
  const worst = summary?.worst_areas?.[0]
  const countryCount = summary?.countries?.length || 0
  const areaCount = (summary?.worst_areas || []).length
  if (!worst && !countryCount) {
    ipcWorstValueEl.textContent = '—'
    ipcWorstPeriodEl.textContent = ''
    return
  }
  if (worst) {
    const pct = Number.isFinite(worst.phase3plus_fraction)
      ? `${Math.round(worst.phase3plus_fraction * 100)}%`
      : '—'
    ipcWorstValueEl.textContent = `${worst.area || 'unknown'} (${worst.country}) — Phase 3+ ${pct}${
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
    if (!body?.success) {
      contextPresence.disease = 'unavailable'
    } else {
      state.diseaseSummary = body.data
      const states = body.data?.series_state || []
      contextPresence.disease = states.length ? 'present' : 'empty'
      if (!states.length) {
        diseaseSeriesStateEl.textContent = 'no series'
        diseaseLatestEl.textContent = '—'
        diseaseLatestMetaEl.textContent = ''
      } else {
        const stale = states.filter((s) => s.state === 'stale').length
        const current = states.filter((s) => s.state === 'current').length
        diseaseSeriesStateEl.textContent = `${states.length} series · ${current} current · ${stale} stale`
        diseaseSeriesStateEl.className = `seasonal-phase ${stale === states.length ? 'seasonal-phase-unknown' : ''}`
        const latest = states.reduce((a, b) => (b.latest_year > (a?.latest_year || 0) ? b : a), null)
        if (latest) {
          diseaseLatestEl.textContent = `${latest.indicator_name}: ${latest.latest_year}`
          diseaseLatestMetaEl.textContent = latest.state !== 'current' ? `${latest.years_behind_calendar}y behind calendar` : ''
        }
        diseaseNoteEl.textContent = `National annual aggregates. Context, not district evidence; not an alert trigger.` +
          (stale ? ` Series marked stale have stopped publishing; silence is absence of published data, not absence of disease.` : '')
        diseaseNoteEl.hidden = false
      }
    }
  } catch {
    contextPresence.disease = 'unavailable'
  }
  renderContextStrips()
}

/** One row, for both sources, from recorded presence rather than from content. */
function renderContextStrips() {
  if (!contextStripsEl) return
  const present = [contextPresence.food, contextPresence.disease].filter((p) => p === 'present').length

  if (contextStateEl) {
    contextStateEl.textContent = present === 2 ? 'both' : present === 1 ? '1 of 2' : 'not ingested'
    contextStateEl.className = `seasonal-phase ${present ? '' : 'seasonal-phase-unknown'}`
  }

  // The caveats travel with their figures. A note explaining what an IPC
  // fraction means, shown next to an em dash, reads as an apology; shown next
  // to a figure, it is the definition.
  if (ipcNoteEl) ipcNoteEl.hidden = contextPresence.food !== 'present'
  if (diseaseNoteEl) diseaseNoteEl.hidden = contextPresence.disease !== 'present'

  if (!contextMissingEl) return
  const why = (p) => (p === 'unavailable'
    ? 'the summary endpoint did not answer'
    : p === 'loading' ? 'still loading' : 'the connector has written no records')
  const missing = []
  if (contextPresence.food !== 'present') missing.push(`food security (IPC) — ${why(contextPresence.food)}`)
  if (contextPresence.disease !== 'present') missing.push(`outbreak (WHO GHO) — ${why(contextPresence.disease)}`)

  contextMissingEl.hidden = missing.length === 0
  contextMissingEl.textContent = missing.length
    ? `Not shown: ${missing.join('; ')}. Absence of published data, not a measurement of zero.`
    : ''
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
      // A base rate that was not fitted is not a base rate of zero. `|| 0`
      // printed "0% flood-month base rate" for a model that published none,
      // which is the exact conflation this project wrote the rule down about:
      // an absent forecast is not a 0% chance of rain.
      const baseRate = isUndetermined(t.base_rate) ? null : Number(t.base_rate)
      floodProbBestEl.textContent = `${bestAny.region_name}: `
        + (baseRate === null || !Number.isFinite(baseRate)
          ? 'flood-month base rate not published'
          : `${Math.round(baseRate * 100)}% flood-month base rate`)
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
    renderFloodProbabilityPanels(models, await lazy('/shared/charts.js'))
  } catch {
    if (floodProbStripEl) floodProbStripEl.hidden = true
  }
}

/**
 * Every district side by side, each with its own sample size.
 *
 * This strip used to reduce every trained district to the single best
 * `skill_over_base_rate` and print that one as the headline. The base rate, the
 * month count and the spread were discarded, which is the wrong trade: a
 * district with 60 months of skill +40% and a district with 12 months of skill
 * +40% are the same headline and completely different claims, and the reader
 * could not tell which they were looking at.
 *
 * The refused districts stay in the grid too, under their own titles, for the
 * reason this function already kept them in the note: "this district has 40
 * months, not the 60 required" is actionable and a blank strip is not.
 *
 * `charts` is passed in rather than imported, because the strip is the only
 * thing in the console that draws and the charting library is a tenth of the
 * first load. See `lazy`.
 */
function renderFloodProbabilityPanels(models, { barChart, smallMultiples }) {
  if (!floodProbStripEl) return
  const existing = floodProbStripEl.querySelector('.chart-grid')
  if (existing) existing.remove()

  const panels = models.map((m) => {
    const title = m.region_name || 'Unnamed district'
    if (!m.model) {
      return { title, chart: null, refused: m.refusal || 'Not trained: insufficient data' }
    }
    const t = m.model.training || {}
    const skill = Number(m.folds?.folds?.skill_over_base_rate)
    // A base rate that was not fitted is not a base rate of zero. Drawing it as
    // a zero-height bar would say "no floods in this district", which is the
    // conflation the headline text already refuses to commit.
    const baseRate = isUndetermined(t.base_rate) ? null : Number(t.base_rate)
    const chart = barChart({
      labels: ['Base rate', 'Skill over base'],
      series: [{ name: title, values: [
        baseRate === null || !Number.isFinite(baseRate) ? null : baseRate * 100,
        Number.isFinite(skill) ? skill * 100 : null,
      ] }],
      format: (v) => `${Math.round(v)}%`,
      caption: `${title} — flood-month base rate and validated skill`,
      title,
      empty: 'No base rate or skill published for this district',
    }, { height: 140, pad: { left: 40, bottom: 34 } })
    const months = Number.isFinite(Number(t.months)) ? Number(t.months) : null
    return {
      title,
      chart,
      note: `${months === null ? 'month count not published' : `${months} months`}`
        + `${Number.isFinite(Number(t.flood_months)) ? ` · ${t.flood_months} flood months` : ''}`
        + `${Number.isFinite(skill) ? '' : ' · skill not validated'}`,
    }
  })

  const grid = smallMultiples(panels, { columns: Math.min(4, panels.length) })
  if (grid.html) floodProbStripEl.insertAdjacentHTML('beforeend', grid.html)
}

// =============================================================
// Evidence surfaces — the band, the playback, the verification
// =============================================================
// Three visualisation primitives that had call sites in their tests and none in
// the product: `sensitivityBandChart`, `buildFrames`/`frameSummary`/`peakFrame`,
// and `pairForecasts`/`reliabilityDiagram`. Each is loaded through `lazy()` into
// `public/workflow/wire-*.js`, so the code that assembles them is not part of the
// first load either. The data all comes out of `state.data`, which `refresh()`
// has already merged by the time this runs.
//
// The three are independent. One failing must not blank the other two, so each
// is awaited on its own and each hides its own panel if it cannot draw: a group
// of three empty cards reads as "nothing happened" rather than "this feature
// failed".
//
// `_evidenceInView` is what keeps the download off the field connection's first
// paint. These three modules are the largest thing added to the console and most
// operators open the console to read the map; none of them arrives until the
// block below the map is scrolled into view.
let _evidenceInView = false
let _playbackIndex = 0

async function renderEvidenceSurfaces() {
  const risks = [
    ...(state.data.flood?.data ?? []),
    ...(state.data.conflict?.data ?? []),
  ]
  const hazards = state.data.events?.data ?? []
  const alerts = state.data.alerts?.data ?? []
  const climate = state.data.climate?.data ?? []
  if (!_evidenceInView) return

  if (risks.length && uncertaintyPanelEl) {
    try {
      const { renderUncertainty } = await lazy('/workflow/wire-uncertainty.js')
      renderUncertainty({ host: uncertaintyChartEl, note: uncertaintyNoteEl }, risks)
      uncertaintyPanelEl.hidden = false
    } catch {
      uncertaintyPanelEl.hidden = true
    }
  }

  if ((hazards.length || alerts.length) && playbackPanelEl) {
    try {
      const { createPlayback, playbackRecords } = await lazy('/workflow/wire-playback.js')
      const handle = createPlayback(
        { step: playbackStepEl, summary: playbackSummaryEl, chart: playbackChartEl, peak: playbackPeakEl },
        playbackRecords({ hazards, alerts }),
        { startIndex: _playbackIndex },
      )
      _playbackIndex = handle.timeline.lastFrameIndex
      playbackPanelEl.hidden = false
    } catch {
      playbackPanelEl.hidden = true
    }
  }

  if (climate.length && verifyPanelEl) {
    try {
      const { renderVerification } = await lazy('/workflow/wire-verify.js')
      renderVerification(verifyBodyEl, { observations: climate })
      verifyPanelEl.hidden = false
    } catch {
      verifyPanelEl.hidden = true
    }
  }
}

/**
 * Draw the evidence surfaces the first time the block is scrolled to.
 *
 * One-way: once the reader has been there, every later repaint redraws. A gate
 * that closed again on scroll would blank the panels out from under someone who
 * scrolled back up to read a number.
 */
function watchEvidenceSurfaces() {
  const host = $('evidenceSurfaces')
  if (!host || typeof IntersectionObserver !== 'function') {
    // No observer: draw on the next repaint rather than never. An operator on a
    // browser without one loses the lazy first load and nothing else.
    _evidenceInView = true
    return
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return
    _evidenceInView = true
    observer.disconnect()
    renderEvidenceSurfaces().catch(() => {})
  }, { rootMargin: '200px' })
  observer.observe(host)
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
/**
 * Whether this browser holds a key for a deployment that requires one.
 *
 * Only ever cleared by a re-check after a key is pasted, so the badge can read
 * stale for one reload if the field is emptied. That is a cosmetic bug against
 * the alternative: a locked-out console that says nothing, which reads exactly
 * like a deployment with no data.
 */
let needsKey = false

function updateConnectionStatus() {
  const online = navigator.onLine
  // `hidden = online` was the bug: it showed the banner only when the network
  // was down, so a reachable server rejecting this browser rendered every panel
  // empty with no message. Two conditions, not one.
  offlineBanner.hidden = online && !needsKey
  offlineBanner.classList.toggle('banner-auth', !needsKey)
  // Exactly one message at a time. Both together would claim the data is queued
  // for sync when none of it was ever fetched.
  const locked = needsKey && online
  const offlineText = offlineBanner?.querySelector('[data-i18n="banner.offline"]')
  const authText = $('authBannerText')
  if (offlineText) offlineText.hidden = locked
  if (authText) authText.hidden = !locked
  connectionStatus.textContent = online ? (needsKey ? 'sign in' : 'online') : 'offline'
  connectionStatus.className = `badge badge-connection${online && !needsKey ? '' : ' offline'}`
}

/**
 * Ask whether this deployment needs a token, and whether ours was accepted.
 *
 * `/auth-info` answers without a key by design, so it works on a cold console
 * with nothing saved. A throw means the server is gone or the answer came from
 * cache — the offline banner already covers that, and "sign in" on worse
 * evidence would be a second guess.
 */
async function refreshAuthState() {
  try {
    const data = (await apiFetch('/api/v1/auth-info', { headers: authHeaders() }))?.data
    // Three cases: auth off, auth on and we are in, auth on and we are out.
    if (data && (needsKey = Boolean(data.auth_configured) && !data.subject)) updateConnectionStatus()
  } catch { /* unreachable; the offline banner is the honest message */ }
}

window.addEventListener('online', () => {
  updateConnectionStatus()
  window.lindelaQueue?.flush()
})
window.addEventListener('offline', updateConnectionStatus)
updateConnectionStatus()
// Asked after the connection status so the offline case wins if the server
// is unreachable — a banner saying "sign in" on a dead server would be a worse
// lie than no banner at all.
refreshAuthState()

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
const seasonalSummaryEl  = $('seasonalSummary')
const seasonalCalendarFigEl = $('seasonalCalendarFig')
const seasonalCalendarEl = $('seasonalCalendar')
const seasonalCalendarNoteEl = $('seasonalCalendarNote')
const contextStripsEl    = $('contextStrips')
const contextStateEl     = $('contextState')
const contextMissingEl   = $('contextMissing')
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
const diseaseSeriesStateEl = $('diseaseSeriesState')
const diseaseLatestEl    = $('diseaseLatest')
const diseaseLatestMetaEl = $('diseaseLatestMeta')
const diseaseNoteEl      = $('diseaseNote')
const ipcNoteEl          = $('ipcNote')
const floodProbStripEl   = $('floodProbStrip')
const floodProbRegionsEl = $('floodProbRegions')
const floodProbBestEl    = $('floodProbBest')
const floodProbBestMetaEl = $('floodProbBestMeta')
const floodProbNoteEl    = $('floodProbNote')
const uncertaintyPanelEl = $('uncertaintyPanel')
const uncertaintyChartEl = $('uncertaintyChart')
const uncertaintyNoteEl  = $('uncertaintyNote')
const playbackPanelEl    = $('playbackPanel')
const playbackStepEl     = $('playbackStep')
const playbackPeakEl     = $('playbackPeak')
const playbackSummaryEl  = $('playbackSummary')
const playbackChartEl    = $('playbackChart')
const verifyPanelEl      = $('verifyPanel')
const verifyBodyEl       = $('verifyBody')
const seasonalOverlayEl  = $('seasonalCalendarOverlay')
const seasonalOverlayCaptionEl = $('seasonalCalendarOverlayCaption')
const seasonalOverlayNoteEl = $('seasonalCalendarOverlayNote')

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

  // Land layer.
  //
  // The fill is the UNION of the country rings, not a stack of them. They share
  // edges and overlap along them — Ethiopia's ring runs through Kenya's,
  // Somalia's through Ethiopia's, Uganda's through Kenya's — so six
  // independent 60%-opacity washes do not average to one land tone, they
  // compound: 1-(1-0.6)^n puts two overlaps at 84%, three at 94%, four at 97%.
  // The canvas was therefore tiled with three or four unrelated greys and
  // near-black wedges along every shared border, none of which is geography.
  //
  // Anchoring the frame on the five pilot districts exposed exactly that. At
  // the old Horn-wide 21x25 frame the land sat as a band on the left with
  // ocean around it, so the wedges were the periphery of the picture; at
  // 14.5x6.2 the six rings are all larger than the viewport and the compounded
  // stack covers the whole frame — a grey mass with markers floating on it.
  //
  // All six rings wind the same way (shoelace sign negative for every one), so
  // nonzero fill-rule merges them into a single outline instead of punching
  // holes where they cross. One 60% wash, one land tone. The borders are drawn
  // by the stroked pass underneath, which costs one element more and keeps the
  // CSS in charge of both colour and theme — an inline fill would hard-code a
  // dark navy into a map that also renders on a light background.
  if (mapLandEl) {
    mapLandEl.innerHTML = ''
    const landFill = svgEl('path', {
      d: Object.values(REGION_POLYGONS).map(({ ring }) => ringToPath(ring, bbox)).join(' '),
      'fill-rule': 'nonzero',
    })
    // Stroke-width 0: this pass owns the fill, and stroking the union here
    // would overdraw the borders the pass below already draws.
    landFill.style.strokeWidth = '0'
    mapLandEl.append(landFill)
    for (const { name, ring } of Object.values(REGION_POLYGONS)) {
      const outline = svgEl('path', { d: ringToPath(ring, bbox) })
      const titleEl = svgEl('title')
      titleEl.textContent = name
      outline.append(titleEl)
      // No fill on this pass. `.land-layer path` in styles.css sets one, and a
      // presentation attribute loses to it — refilling each country here is
      // the compounded stack all over again.
      outline.style.fill = 'none'
      mapLandEl.append(outline)
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

// =============================================================
// WEB-04 / WEB-10 — a second channel, and a target you can hit
// =============================================================
//
// The map used to carry hazard type in a CSS class that only ever changed
// `fill`, and severity in a radius. Type was therefore readable *only* by
// someone who separates the hues: the three colour-vision deficiencies that
// affect roughly 8% of men all read a flood as a fire, and severity — the one
// thing on this screen that must never be misread — was a 5px circle against a
// 13px one on a busy map.
//
// Two redundant channels replace the dependence on hue:
//
//   type      → shape. Circle, triangle, hexagon, square, diamond, cross.
//   severity  → radius *and* stroke dash pattern. Five severities, five
//               patterns, and an ungraded record gets its own rather than
//               inheriting "low".
//
// Colour is still there, and still useful. It is just no longer load-bearing:
// deleting the stylesheet loses some polish and keeps every fact on screen.
//
// Everything below is pure. The drawing code is a thin shell over it, so the
// claims above are testable without a browser.

/** Points of a unit shape, as offsets from the centre. Null = drawn as <circle>. */
const SHAPE_OFFSETS = {
  // Upward triangle — landslide, the thing that slides downhill.
  triangle: [[0, -1], [0.866, 0.5], [-0.866, 0.5]],
  // Hexagon — storm, the widest of the set.
  hexagon: [[1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866]],
  // Square on axis — disaster, generic and blunt.
  square: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
  // Diamond on axis — fire.
  diamond: [[0, -1], [1, 0], [0, 1], [-1, 0]],
  // Cross — conflict, and the only shape that is not convex.
  cross: [
    [-0.35, -1], [0.35, -1], [0.35, -0.35], [1, -0.35], [1, 0.35], [0.35, 0.35],
    [0.35, 1], [-0.35, 1], [-0.35, 0.35], [-1, 0.35], [-1, -0.35], [-0.35, -0.35],
  ],
}

/**
 * The shape that stands for a hazard type, independent of its colour.
 *
 * Derived from `hazardClass` so there is exactly one classifier: two cascades
 * would drift, and the day they did the legend would describe a map that no
 * longer existed. Exported because the legend, the draw loop and the test all
 * have to agree on it.
 */
export function hazardShape(eventType) {
  const cls = hazardClass(eventType).replace('hazard-', '')
  return {
    flood: 'circle', landslide: 'triangle', storm: 'hexagon',
    fire: 'diamond', disaster: 'square', conflict: 'cross', default: 'circle',
  }[cls] || 'circle'
}

/**
 * Severity as a stroke dash pattern.
 *
 * Radius alone was not enough: 7px and 10px are hard to tell apart once the
 * map is dense, and both are far below the tap-target floor, so the thing the
 * operator is trying to grade is smaller than their fingertip anyway. Dash
 * pattern is unambiguous at any size, prints in black and white, and survives
 * `forced-colors` mode where the fill is overridden wholesale.
 */
export function severityDash(severity) {
  return {
    critical: 'none',      // solid: the loudest, and the default fill if a CSS drops it
    high: '7 3',
    medium: '3 3',
    low: '1 4',
    ungraded: '9 2 2 2',   // an ungraded record is not "low"
  }[String(severity || '').toLowerCase()] || '9 2 2 2'
}

/**
 * How wide the map is actually drawn, in viewBox units per CSS pixel.
 *
 * The viewBox is a fixed 800 units wide; the element is fluid and `meet`-fit,
 * so the on-screen scale is the smaller of the two axes and varies by two and a
 * half times between a 360px phone and a 1400px desktop. A hit target sized in
 * viewBox units alone is therefore 24px on a desktop and 8px in the field, which
 * is the defect restated. Returns 1 when there is no layout to measure yet,
 * which makes the floor the conservative one rather than a division by zero.
 */
export function viewBoxUnitsPerPx(viewBoxWidth, cssWidth) {
  if (!(viewBoxWidth > 0) || !(cssWidth > 0)) return 1
  return viewBoxWidth / cssWidth
}

/**
 * Radius, in viewBox units, of the invisible circle that carries a marker's
 * clicks.
 *
 * WCAG 2.2 SC 2.5.8 sets the floor at 24x24 CSS px, so this is 12px scaled
 * into whatever the map currently measures. A 5-unit visual radius on an 800px
 * render is a 5px target; the visual marker is still 5px, because a marker
 * big enough to hit with a thumb would obscure the district it sits in. The
 * target is invisible and lives behind the mark.
 */
export function hitRadiusUnits(viewBoxWidth, cssWidth, minPx = 24) {
  return Math.ceil((minPx / 2) * viewBoxUnitsPerPx(viewBoxWidth, cssWidth) * 10) / 10
}

/** Bounding box of a shape at a given radius. Circle included. */
export function shapeExtent(shape, r) {
  const offsets = SHAPE_OFFSETS[shape]
  if (!offsets) return { w: 2 * r, h: 2 * r }
  const xs = offsets.map((o) => o[0]); const ys = offsets.map((o) => o[1])
  return {
    w: (Math.max(...xs) - Math.min(...xs)) * r,
    h: (Math.max(...ys) - Math.min(...ys)) * r,
  }
}

/** An <svg> element for a marker: <circle>, or a <polygon> for everything else. */
function markerEl(shape, x, y, r, className, extra = {}) {
  const offsets = SHAPE_OFFSETS[shape]
  if (!offsets) return svgEl('circle', { cx: x, cy: y, r, class: className, ...extra })
  const points = offsets
    .map(([dx, dy]) => `${(x + dx * r).toFixed(1)},${(y + dy * r).toFixed(1)}`)
    .join(' ')
  return svgEl('polygon', { points, class: className, ...extra })
}

/** The live hit radius, measured rather than assumed. Recomputed per render. */
function currentHitRadius() {
  const rect = mapEl?.getBoundingClientRect?.()
  return hitRadiusUnits(SVG_W, rect?.width || 0)
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

/**
 * A field the source never supplied a value for.
 *
 * `null` and `undefined` mean not determined, and so does the empty string a
 * form field posts when the operator left it blank. `0` is a value — a score of
 * 0, a latitude on the equator, a count of nothing yet — and reading it as
 * absent is the same conflation running in the other direction: a record that
 * says "zero" being treated as a record that says nothing.
 */
export function isUndetermined(value) {
  return value === null || value === undefined || value === ''
}

/**
 * What one filter bar does to one record.
 *
 * A filter set to a specific value admits records that carry that value and
 * nothing else. `sevFilter && r.severity && r.severity !== sevFilter` read the
 * missing severity as a match for every severity: choose Critical and the map
 * still showed every record nobody had graded, indistinguishable from the
 * critical ones. Not-determined is excluded now — and reported, because a
 * filter that silently drops records is the same lie as one that silently keeps
 * them, and the operator needs to know the number is a floor and not the whole
 * picture.
 *
 * Exported, and free of DOM and of module state, so the decision can be tested
 * without a browser. The four fields are the only inputs.
 */
export function evaluateMapFilters(record, filters = {}) {
  const { severity = '', source = '', since = null, coldChainOnly = false } = filters
  if (severity) {
    if (isUndetermined(record.severity)) return { shown: false, undetermined: 'severity' }
    if (record.severity !== severity) return { shown: false, undetermined: null }
  }
  if (source) {
    if (isUndetermined(record.source)) return { shown: false, undetermined: 'source' }
    if (record.source !== source) return { shown: false, undetermined: null }
  }
  if (since && !withinRange(record, since)) return { shown: false, undetermined: null }
  if (coldChainOnly && !isColdChainAsset(record)) return { shown: false, undetermined: null }
  return { shown: true, undetermined: null }
}

/**
 * Why a Send button is greyed out.
 *
 * Ten of them were, with nothing anywhere on the card saying why — so the
 * operator's model of the queue ("these are sent on approval") was wrong, and
 * the fastest way to find out was to click one and get nothing.
 *
 * A disabled control carries no hover in most browsers and no announcement in
 * most screen readers, so the reason is a `title` on the button *and* the
 * per-card line below the actions, which is always present and always visible.
 */
const SEND_BLOCKED_REASON = 'Only an approved alert can be sent. This one is still '

function barScopeNote(bar, undetermined = 0) {
  const parts = []
  if (bar.severity) parts.push(`severity ${bar.severity}`)
  if (bar.source) parts.push(`source ${bar.source}`)
  if (bar.since) parts.push(`since ${bar.since}`)
  if (bar.coldChainOnly) parts.push('cold-chain assets only')
  const note = parts.length ? `Filtered by ${parts.join(', ')}.` : 'Filtered.'
  if (!undetermined) return `${note} Applies to the map and this list.`
  return `${note} Applies to the map and this list. ${undetermined} ${
    undetermined === 1 ? 'alert carries' : 'alerts carry'
  } no severity and ${undetermined === 1 ? 'is' : 'are'} not counted as a match — this count is a floor, not the whole picture.`
}

/**
 * The filter bar, read once.
 *
 * The bar sat directly above the map, so every field on it read as a map
 * control — and `Severity: High` was one: it narrowed the map and left the
 * alert rail showing `critical` and `medium` beside it, unmarked. An operator
 * reading the list and an operator reading the map were looking at two
 * different answer sets on one screen, and the UI asserted neither was
 * filtered.
 *
 * One read, consulted by every panel. Changing this to make the map-only
 * behaviour explicit again means labelling it "map only" in the markup, not
 * reintroducing a second filter that disagrees.
 */
export function currentFilters(root = document) {
  const pick = (id) => root.getElementById?.(id)?.value || ''
  return {
    severity: pick('mapSeverity'),
    source: pick('mapSource'),
    since: rangeStart(pick('mapTimeRange')),
    coldChainOnly: Boolean(root.getElementById?.('coldChainToggle')?.checked),
  }
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

/**
 * Below this span in BOTH axes, a fit is a pinprick rather than a frame.
 *
 * Two records 200m apart are real data and the operator is entitled to see
 * them, but framing to their exact extent renders two overlapping markers in a
 * district-sized window with no basemap between them and nothing to orient by.
 */
export const MIN_AUTO_FIT_SPAN_DEG = 1.5

/**
 * The extent the map should actually show.
 *
 * `mapFrame` anchors on the region of interest — 21° of latitude by 25° of
 * longitude — which answers "where is this product about" and not "what is on
 * screen". The console drew that box into roughly 890×1290px of map in which
 * the records that matter, clustered around Turkana, Bor, Aweil and Mandera,
 * occupied the lower-left quarter; the other three quarters were the Indian
 * Ocean. So when nobody has asked to look somewhere specific, frame what is
 * plotted.
 *
 * Four guards keep that from becoming a different lie:
 *
 *   - a flood simulation or a planned route is an operator saying "look here",
 *     and still wins outright
 *   - only points near the region shape the frame, and bbox-only hazards shape
 *     it not at all. GDACS is a worldwide feed whose alerts carry forty-degree
 *     boxes, some of them with a south edge below the south pole; fitting on
 *     them reproduced the ocean at a larger scale. `mapFrame` already refuses
 *     to frame on a record without a point, for the same reason, and this
 *     keeps one rule in the codebase rather than two that disagree.
 *   - nothing near the region falls through to every point, because a
 *     deployment whose data is elsewhere still has to draw that data somewhere
 *   - a single record, or a cluster under MIN_AUTO_FIT_SPAN_DEG in both axes,
 *     falls back to the region rather than zooming a viewport onto one marker
 */
export function autoFitBox(records, fallback) {
  const points = (records || []).filter(isFinitePoint)
  const near = points.filter((r) => withinBbox(r, REGION_OF_INTEREST, NEAR_REGION_MARGIN_DEG))
  // Mirrors mapFrame: near-region points shape the extent, and if none are near
  // then all of them do, rather than collapsing to an empty frame.
  const drivers = near.length ? near : points
  if (drivers.length < 2) return fallback

  const lats = drivers.map((r) => r.latitude)
  const lons = drivers.map((r) => r.longitude)

  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  if (maxLat - minLat < MIN_AUTO_FIT_SPAN_DEG && maxLon - minLon < MIN_AUTO_FIT_SPAN_DEG) return fallback

  // An eighth of the longer edge, and never less than half a degree: a tight
  // cluster still gets ground around it to orient against, and a wide spread
  // does not get a margin too small to see.
  const pad = Math.max(0.5, Math.max(maxLat - minLat, maxLon - minLon) / 8)
  return { minLat: minLat - pad, maxLat: maxLat + pad, minLon: minLon - pad, maxLon: maxLon + pad }
}

function renderMap(records) {
  // Records count as plottable if they have a point OR a usable bounding box.
  // Filtering on coordinates alone dropped every bbox-only hazard before the
  // hazard loop could draw its footprint.
  const geo = records.filter((r) => isFinitePoint(r) || hasUsableBbox(r))

  // Apply map filters.
  //
  // Severity and source were applied; the other three controls on this bar were
  // inert. "Time" had no listener and filtered nothing, "Cold-chain nodes" wrote
  // a flag that nothing read, and the workflow tiles set a filter that no panel
  // consulted. Each looked like a control and did nothing, which is worse than
  // not offering it: an operator narrows the map, sees no change, and concludes
  // the data is wrong.
  const { severity: sevFilter, source: srcFilter, since, coldChainOnly: coldOnly } = currentFilters()

  // The decision itself lives in `evaluateMapFilters`, which is pure and
  // exported. What is added here is the tally: how many records the filter bar
  // dropped because the field was never determined, as opposed to dropped
  // because it held a different value.
  let undeterminedSeverity = 0
  let undeterminedSource = 0
  // Reported areas too big to place on this map. Counted, never dropped
  // silently: they stay in the record list and open the same detail dialog.
  // Two different reasons a record cannot be drawn, kept apart because they
  // are two different sentences to the operator. "Too large to place" is a
  // hazard whose extent covers the frame; "outside this map" is a point that
  // projects beyond the frame — a different problem with a different fix, and
  // counting them as one would report a claim about extent that is not true of
  // the off-frame ones.
  let tooLargeToLocate = 0
  let outsideFrame = 0
  const visible = geo.filter((r) => {
    const verdict = evaluateMapFilters(r, {
      severity: sevFilter, source: srcFilter, since, coldChainOnly: coldOnly,
    })
    if (verdict.undetermined === 'severity') undeterminedSeverity += 1
    if (verdict.undetermined === 'source') undeterminedSource += 1
    return verdict.shown
  })

  // The frame is decided AFTER filtering, not before it. Framing on everything
  // the feeds delivered and then hiding most of it is how the console ended up
  // drawing an ocean: the fit has to describe what is on screen, and what is on
  // screen is `visible`.
  //
  // A flood simulation or a planned route overrides the fit outright — those are
  // an operator saying "look here", and a data-derived frame would swallow them.
  const focus = state.floodFocus || state.routeFocus || null
  const regionFrame = mapFrame(geo, undefined, focus).frame
  const bbox = focus ? regionFrame : autoFitBox(visible, regionFrame)

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
  //
  // `Number(r.score) || 0` reads a score of 0 as an absent score and lands on
  // the same number by luck. The filter above has already ruled absence out, so
  // divide the score directly: a real 0 is a real 0 and takes the same path on
  // purpose rather than by conflation.
  risks.forEach((r) => {
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const normalized = Math.max(0, Math.min(1, r.score / 100))
    // A score of 0 is a genuine minimum, not a missing value. The blob would
    // render at zero opacity, so there is nothing to draw — but say so with a
    // comparison, not with the falsiness of the value standing in for one.
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
  //
  // Measured once per render: the map is fluid, so the viewBox-to-pixel ratio
  // is a fact about the current viewport and not a constant.
  const hitR = currentHitRadius()
  hazards.forEach((r) => {
    if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) {
      const box = r.bbox
      if (box && [box.west, box.south, box.east, box.north].every(Number.isFinite)) {
        const nw = project(Math.min(box.north, 90), box.west, bbox)
        const se = project(Math.max(box.south, -90), box.east, bbox)
        let footWidth = 0
        let footHeight = 0
        const foot = svgEl('rect', {
          // Clipped to the viewport. A GDACS alert can span half a
          // continent, and once the frame tightened to the pilot districts that
          // box projected to several times the viewBox — a 3,000px rectangle
          // over the map, hiding everything under it. A reported area larger
          // than the view is not a marker; it is "somewhere in this region",
          // which the legend and the detail dialog already say.
          x: Math.max(0, Math.min(nw.x, se.x)),
          y: Math.max(0, Math.min(nw.y, se.y)),
          width: (footWidth = Math.min(SVG_W, Math.abs(se.x - nw.x))),
          height: (footHeight = Math.min(SVG_H, Math.abs(se.y - nw.y))),
          class: `hazard-footprint ${hazardClass(r.event_type)} hazard-footprint-${safeClass(r.severity)}`,
        })
        const footTitle = svgEl('title')
        footTitle.textContent = `${r.title || r.event_type || 'Hazard'} — ${r.severity || 'ungraded'}, reported area, not a point location`
        foot.append(footTitle)
        foot.setAttribute('data-tap-target', '')
        foot.setAttribute('tabindex', '0')
        foot.setAttribute('role', 'button')
        foot.setAttribute('aria-label', footTitle.textContent)
        foot.setAttribute('stroke-dasharray', severityDash(r.severity))

        // A reported area that fills the frame is not a marker. Clipped to the
        // viewport it is still a translucent sheet over every point hazard
        // beneath it, which is worse than showing none: it says "a flood
        // somewhere in here" by hiding the map that would say where.
        // From the dimensions already computed, not `getBBox()`: the element is
        // not in the document yet, and a detached element reports a zero box, so
        // every footprint measured 0% of the viewport and none was dimmed.
        // A box this large cannot be located on this map. It is not a marker
        // with a wide extent; it is "somewhere in this region", and drawing it
        // as a translucent sheet hides every point hazard beneath it — four
        // overlapping 10% fills read as one opaque grey shape over the map.
        //
        // So it is not drawn here. The count line names how many, the record
        // list carries them, and the detail dialog shows the extent. Losing it
        // from the map is not losing it from the product; the alternative is a
        // map nobody can read.
        //
        // Measured from the dimensions already computed, not `getBBox()`: the
        // element is not in the document yet, and a detached element reports a
        // zero box, so an earlier attempt measured every footprint at 0% of the
        // viewport and dimmed none of them.
        const share = (footWidth * footHeight) / (SVG_W * SVG_H)
        if (share > 0.15) {
          tooLargeToLocate += 1
          return
        }
        foot.addEventListener('click', () => openDetailDialog(r))
        foot.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailDialog(r) }
        })
        mapHazardsEl.append(foot)
      }
      // No point and no usable box: nothing to draw, and the record count in
      // the filter and status bar still reflects it.
      return
    }
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const cls = hazardClass(r.event_type)
    const shape = hazardShape(r.event_type)
    const label = r.title || r.event_type || 'Hazard'
    const sev = r.severity || 'ungraded'

    // A point that projects outside the frame cannot be drawn here.
    //
    // It was drawn anyway, and it is a `tabindex="0"` button carrying an
    // accessible name — so a keyboard user tabbed to "Flood Watch — high" at
    // x = -5745, five thousand pixels off-screen, with nothing on the page to
    // explain where it was. `documentElement.scrollWidth` never grew, because
    // the map is an SVG that does not scroll; the browser will not scroll to it
    // and cannot scroll that far anyway. A control that is focusable, named and
    // invisible is worse than an absent one: it costs the operator a tab stop
    // and returns nothing.
    //
    // The oversized footprint above makes the same argument for the same
    // reason, and is treated the same way: not drawn, counted, named in the
    // count line, still reachable in the record list and the detail dialog.
    const margin = hitR + sevRadius(r.severity) + 2
    if (x < -margin || y < -margin || x > SVG_W + margin || y > SVG_H + margin) {
      outsideFrame += 1
      return
    }

    // The invisible target goes first so the visible mark paints over it. The
    // mark itself keeps its severity radius: a marker sized to a fingertip
    // would hide the district it sits in, which is the information the
    // operator is actually reading the map for.
    const hit = svgEl('circle', {
      cx: x, cy: y, r: hitR,
      class: 'hazard-hit',
      fill: 'transparent', stroke: 'none', 'pointer-events': 'all',
      'data-tap-target': '',
      tabindex: '0',
      role: 'button',
      'aria-label': `${label} — ${sev}`,
    })
    hit.addEventListener('click', () => openDetailDialog(r))
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailDialog(r) }
    })
    mapHazardsEl.append(hit)

    const circle = markerEl(shape, x, y, sevRadius(r.severity), `hazard-marker ${cls}`, {
      'stroke-dasharray': severityDash(sev),
      // The oversized target behind this is what receives events.
      'pointer-events': 'none',
      'aria-hidden': 'true',
    })
    const titleEl = svgEl('title')
    // Severity goes in the accessible name because it is the one thing on this
    // screen that must never be misread, and the dash pattern carries it
    // visually only.
    titleEl.textContent = `${label} — ${sev}`
    circle.append(titleEl)
    // No click listener: the visible mark is `pointer-events: none` so that the
    // oversized target behind it is the single thing that receives the event.
    // Two overlapping listeners meant the topmost shape won, and the topmost
    // shape was the 5px one — the target would have been dead pixels.
    mapHazardsEl.append(circle)
  })

  // Asset squares. A 9-unit square is 9 CSS px on a wide map and 4 on a phone
  // — the same floor breach the hazard markers had, on a control that has to be
  // usable with cold hands on a wet screen.
  assets.forEach((r) => {
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const size = 9
    const label = r.name || r.service_type || 'Asset'
    const hit = svgEl('circle', {
      cx: x, cy: y, r: hitR,
      class: 'asset-hit',
      fill: 'transparent', stroke: 'none', 'pointer-events': 'all',
      'data-tap-target': '',
      tabindex: '0',
      role: 'button',
      'aria-label': label,
    })
    hit.addEventListener('click', () => openDetailDialog(r))
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailDialog(r) }
    })
    mapAssetsEl.append(hit)

    const rect = svgEl('rect', {
      x: x - size / 2, y: y - size / 2,
      width: size, height: size,
      class: `asset-marker ${assetClass(r.service_type)}`,
      'pointer-events': 'none',
      'aria-hidden': 'true',
    })
    const titleEl = svgEl('title')
    titleEl.textContent = label
    rect.append(titleEl)
    mapAssetsEl.append(rect)
  })

  renderMapLegend()

  const countEl = $('mapRecordCount')
  if (countEl) {
    const undetermined = []
    if (undeterminedSeverity) undetermined.push(`${undeterminedSeverity} with no severity`)
    if (undeterminedSource) undetermined.push(`${undeterminedSource} with no source`)
    // Anything not drawn is counted rather than dropped, so it is named here
    // instead of vanishing. It remains in the record list and opens the same
    // detail dialog — losing it from the map is not losing it from the product.
    const placed = visible.length - tooLargeToLocate - outsideFrame
    const parts = [`${placed} on map`]
    if (tooLargeToLocate) parts.push(`${tooLargeToLocate} reported area${tooLargeToLocate === 1 ? '' : 's'} too large to place`)
    if (outsideFrame) parts.push(`${outsideFrame} outside the area this map covers`)
    if (undetermined.length) parts.push(undetermined.join(', '))
    countEl.textContent = parts.join(' · ')
      + (undetermined.length ? ` — hidden by the filter: ${undetermined.join(', ')}` : '')
    countEl.title = undetermined.length
      ? `The filter is set to a specific value. ${undetermined.join(' and ')} did not match it, so `
        + 'they are not drawn. Choose "All" to see them.'
      : ''
  }

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
  // Same contract as the alerts list: a 30-second refresh must not move the
  // operator's focus or their scroll position out from under them.
  _lastMapEntries = entries
  preserveUiAroundRebuild(() => _renderMapRecordList(entries))
}

let _lastMapEntries = []

function _renderMapRecordList(entries) {
  const tbody = $('mapRecordListBody')
  if (!tbody) return
  tbody.setAttribute('data-live-region', 'map-records')

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
    <td><button type="button" class="btn btn-xs" data-map-record="${row.index}"
        ${FOCUS_KEY_ATTR}="map-record:${row.index}">Details</button></td>
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
    { cls: 'hazard-flood',     label: 'Flood',     shape: hazardShape('flood'),            dash: severityDash('critical') },
    { cls: 'hazard-landslide', label: 'Landslide', shape: hazardShape('landslide'),        dash: severityDash('high') },
    { cls: 'hazard-storm',     label: 'Storm',     shape: hazardShape('tropical storm'),   dash: severityDash('medium') },
    { cls: 'hazard-fire',      label: 'Fire',      shape: hazardShape('wildfire'),         dash: severityDash('low') },
    { cls: 'hazard-conflict',  label: 'Conflict',  shape: hazardShape('civil conflict'),   dash: severityDash('ungraded') },
    { cls: 'hazard-footprint', label: 'Area (box)',shape: 'footprint' },
    { cls: 'food-medium',      label: 'IPC Phase 3+ area', shape: 'footprint' },
    { cls: 'asset-health',     label: 'Health',    shape: 'asset' },
    { cls: 'asset-water',     label: 'Water',     shape: 'asset' },
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
    if (item.shape === 'footprint') {
      // Dashed, matching how a regional bbox is drawn on the map, and hollow so
      // it cannot be mistaken for a point event with a location we actually know.
      mapLegendEl.append(svgEl('rect', {
        x: 12, y: y - 5, width: 12, height: 10,
        class: 'hazard-footprint', fill: 'oklch(62% 0.12 260)', stroke: 'oklch(72% 0.12 260)',
      }))
    } else {
      // The legend draws the same shape the map draws. A swatch that differs
      // from the mark it explains is worse than no legend: the operator reads
      // the shape, does not find it, and concludes the map is wrong.
      if (item.shape === 'asset') {
        mapLegendEl.append(svgEl('rect', { x: 14, y: y - 4, width: 8, height: 8, class: `asset-marker ${item.cls}` }))
      } else {
        mapLegendEl.append(markerEl(item.shape, 18, y, 6, `hazard-marker ${item.cls}`, {
          'stroke-dasharray': item.dash,
        }))
      }
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
  if (e.target.closest('.hazard-marker, .asset-marker, .hazard-hit, .asset-hit')) return
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

// Click-to-place pin on the geographic map: a temporary reference marker.
mapEl?.addEventListener('click', (e) => {
  if (e.target.closest('.map-list-toggle, .hazard-marker, .asset-marker')) return
  const rect = mapEl.getBoundingClientRect()
  const x = e.clientX - rect.left, y = e.clientY - rect.top
  const pinEl = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  pinEl.setAttribute('class', 'user-pin')
  pinEl.innerHTML = `<circle cx="${x}" cy="${y}" r="6" fill="#e63946" stroke="white" stroke-width="1.5"/><text x="${x + 8}" y="${y + 4}" font-size="9" fill="#e63946" font-family="var(--font-mono)" font-weight="700">PIN</text>`
  $('mapAssets')?.appendChild(pinEl)
  setTimeout(() => pinEl.remove(), 8000)
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
// The time range had no listener at all, so selecting it never re-rendered and
// the control looked inert.
$('mapTimeRange')?.addEventListener('change', () => { syncFiltersToUrl(); reRenderMapFromState() })
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
  // The bar is no longer map-only, so a bar change has to repaint the rail too.
  // Skipped while the alerts tab is not showing — `renderAlertsPanel` defers
  // around a focused field, and there is no field to protect on a hidden tab.
  if (state.activeTab === 'alerts') renderAlertsPanel()
}

// =============================================================
// Data refresh
// =============================================================
let _refreshInFlight = false
let _refreshFailures = 0
let _pollTimer = null

export const POLL_BASE_MS = 30_000
export const POLL_MAX_MS = 300_000

/**
 * Milliseconds until the next poll — or null for "do not poll at all".
 *
 * The console used `setInterval(refresh, 30_000)`, which is the worst of the
 * available timers: it cannot be told to stop, it keeps its cadence when the
 * tab is in the background where nobody is reading the result, and it keeps its
 * cadence when the network is down and every request is a guaranteed timeout.
 * Thirteen endpoints at 30s is ~37,000 requests a day per open tab, on the 2G
 * link the field surfaces are built for.
 *
 * Three rules, each one a case where polling is pure waste:
 *
 *   hidden    → null. The browser is already throttling background tabs to
 *               about once a minute; we spend the operator's battery on a
 *               screen nobody is looking at.
 *   in flight → null. On a slow link this is the normal case, not the edge one.
 *   failures  → exponential, 30s → 60 → 120 → 240 → 300s. Bounded, so a link
 *               that genuinely recovered is picked up within five minutes
 *               rather than never. A successful poll resets it to the floor.
 *
 * Returning null rather than a large number is the point: "do not poll" and
 * "poll in ten minutes" are different instructions to a scheduler, and only one
 * of them is honest about a hidden tab.
 */
export function pollDelayMs({ failures = 0, hidden = false, inFlight = false } = {}) {
  if (hidden) return null
  if (inFlight) return null
  const step = Math.min(Math.max(0, Math.floor(failures)), 8)
  return Math.min(POLL_MAX_MS, POLL_BASE_MS * (2 ** step))
}

/** Every endpoint the console knows how to fetch. */
export const ALL_ENDPOINTS = [
  'health', 'sources', 'ingestionHealth', 'flood', 'conflict', 'events',
  'assets', 'alerts', 'reports', 'reportTemplates', 'climate', 'dispatches', 'workflows',
]

/** Fetched on every tick: the map and the status bar are never hidden. */
export const AMBIENT_ENDPOINTS = [
  'health', 'sources', 'ingestionHealth', 'flood', 'conflict', 'events',
  'assets', 'climate',
]

/** Endpoints owned by one tab. Nothing else is fetched while that tab is open. */
const TAB_ENDPOINTS = {
  alerts: ['alerts', 'workflows', 'dispatches'],
  reports: ['reports', 'reportTemplates'],
  equity: ['climate', 'reports'],
  ingestion: ['sources', 'ingestionHealth'],
}

/**
 * Which endpoints a tick should ask for.
 *
 * Every tick used to ask for all thirteen, including the reports list on a tab
 * showing alerts and the workflows list on a tab showing reports. The map and
 * the status bar are always on screen, so their inputs are always fetched; the
 * rest belongs to one tab. `first` is the boot sequence, which pays for
 * everything once so no tab is ever opened against an empty store.
 */
export function endpointsForTab(tab, { first = false } = {}) {
  const set = new Set(first ? ALL_ENDPOINTS : AMBIENT_ENDPOINTS)
  for (const name of TAB_ENDPOINTS[tab] || []) set.add(name)
  return set
}

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
 *
 * Which panels are fetched at all is `endpointsForTab`; how often is
 * `pollDelayMs`. `force` covers the user-initiated case — pressing Refresh or
 * bringing a hidden tab back must fetch even if the tab was hidden a moment ago.
 */
async function refresh({ first = false, force = false } = {}) {
  if (_refreshInFlight) return
  if (document.hidden && !force) return
  _refreshInFlight = true

  const want = force ? new Set(ALL_ENDPOINTS) : endpointsForTab(state.activeTab, { first })

  const load = async (name, path) => {
    if (!want.has(name)) return { skipped: true }
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
        if (!want.has('events')) return { skipped: true }
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

    // Which panels this refresh could not reach, so a panel that falls back to
    // its previous contents can say so. Without this the fallback is silent:
    // `load` returns `null` for a failed name, the assignment is skipped, and
    // `state.data.workflows` keeps whatever it held — on a cold start it holds
    // nothing at all, and `|| []` turns "never checked" into "there are none".
    state.failedSources = new Set(failed)

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
    // Outside the guard on purpose. Inside it, this ran only on success, so a
    // failed request left the panel showing whatever the previous refresh had
    // written — or, on a cold start, an empty box with no explanation at all.
    // The renderer branches on `state.failedSources`, so it has something
    // different to say in each case and must be reached in both.
    renderWorkflowInstanceList()

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

    // The evidence surfaces — the sensitivity band, the hazard playback and the
    // forecast verification — read the records already merged above. Nothing here
    // fetches: a panel that re-queried the API per panel would be four more
    // requests every thirty seconds for figures the console is already holding.
    renderEvidenceSurfaces().catch(() => {})

    // Reuse whatever state already holds for the panels this tick skipped.
    // Without the fallback the map emptied itself every time a tab whose
    // endpoints were not in `want` became active — the visible symptom of a
    // correct optimisation.
    renderMap([
      ...(merged.flood?.data ?? state.data.flood?.data ?? []),
      ...(merged.conflict?.data ?? state.data.conflict?.data ?? []),
      ...(merged.events?.data ?? state.data.events?.data ?? []),
      ...(merged.assets?.data ?? state.data.assets?.data ?? []),
    ])

    loadWorkflowMetrics().catch(() => {})

    if (state.activeTab === 'alerts')         renderAlertsPanel()
    else if (state.activeTab === 'reports')   renderReportsPanel()
    else if (state.activeTab === 'equity')    renderEquityTab()
    else if (state.activeTab === 'ingestion') renderIngestionPanel()
    // A deferred panel that is open but whose markup has not landed yet renders
    // nothing here — every one of the four renderers returns early when its
    // container is absent. That is the guard doing its job, and it would
    // otherwise leave an open tab showing data from the refresh *before* the
    // panel loaded. `mountPanel` re-renders on completion, so the gap closes
    // itself; this note is here so nobody "fixes" the early return by removing
    // it and gets an exception on every poll instead.

    loadSignalToAction().catch(() => {})

    // A partial failure and a total one are different sentences, and the total
    // one is the only one that was being written. When every panel missed, the
    // status line still said "Updated <timestamp>" — a claim that eleven
    // endpoints answered, none of which did. `Updated` is the load-bearing word
    // and it was the false one: the panels beneath it render their last known
    // values, so an operator reading a fresh timestamp would reasonably take
    // them as current.
    const totalFailure = failed.length >= results.length
    if (totalFailure) {
      _refreshFailures += 1
      connectionStatus?.classList.add('degraded')
      setStatus('Could not reach the server. Nothing on this screen has been checked — '
        + 'the figures shown are the last that were.')
    } else if (failed.length) {
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
  } catch (err) {
    // This had a `finally` and no `catch`, which is the worst pairing: a render
    // error propagated out of `refresh`, and because boot does
    // `await refresh({ first: true })` at the top level of the module, it
    // rejected module evaluation. Everything after that line — the escalation
    // mount, the app version, half of the bindings — never ran, and the console
    // sat there looking alive with a status bar that had never been written.
    // Nothing in the UI said anything was wrong, because nothing had been able
    // to say it.
    //
    // A failed refresh is now a failed refresh: reported, and the poll carries
    // on. One panel's render error must not cost the operator the other eleven.
    console.error('Refresh failed while rendering:', err)
    setStatus(`Refresh could not be completed: ${err.message}. The figures below are the last that were.`)
    connectionStatus?.classList.add('degraded')
  } finally {
    _refreshInFlight = false
    schedulePoll()
  }
}

/**
 * Self-rescheduling poll, rather than a fixed interval.
 *
 * `setInterval` fires on a wall clock no matter what happened last time, so it
 * cannot express "wait longer because the last attempt failed" and it cannot be
 * cancelled without clearing a handle nobody keeps. Rescheduling after each
 * attempt means the delay is computed from the outcome of the attempt that just
 * finished, which is the only thing worth basing a delay on.
 */
function schedulePoll() {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null }
  const delay = pollDelayMs({ failures: _refreshFailures, hidden: document.hidden })
  if (delay === null) return
  _pollTimer = setTimeout(() => {
    _pollTimer = null
    refresh()
  }, delay)
  // In a browser the handle is a number and `.unref` does not exist, so this is
  // a no-op there. Under Node — where every suite that imports this module for
  // its pure exports would otherwise be held open by a 30-second timer — it
  // says what it means: a background refresh must not be a reason to stay
  // alive.
  _pollTimer?.unref?.()
}

// A hidden tab stops polling outright; returning to it refreshes at once rather
// than waiting out whatever delay the backoff had reached. Browsers already
// throttle background timers, which means an unthrottled `setInterval` was
// asking for 30-second guarantees it could not deliver anyway.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null }
    return
  }
  schedulePoll()
  refresh({ force: true })
})

// Same on the network. `navigator.onLine` is a hint the browser keeps current
// and acting on it is free.
window.addEventListener('online', () => refresh({ force: true }))
window.addEventListener('offline', () => { _refreshFailures = Math.max(_refreshFailures, 1) })

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
    // The tiles render from whatever byType holds, but the *totals* do not:
    // with no payload the summary falls back to summing byType, which is empty,
    // and prints "0 open / 0 closed". A zero here reads as "every workflow has
    // been dealt with" — the most consequential false statement this console
    // makes — when the truth is that nobody has asked.
    console.error('Failed to load workflow metrics:', err)
    state.failedSources = new Set([...(state.failedSources || []), 'workflowMetrics'])
    for (const id of ['workflowOpen', 'workflowClosed', 'workflowRejected']) {
      const el = $(id)
      if (el) el.textContent = '—'
    }
    const wrap = $('workflowRejectedWrap')
    if (wrap) wrap.hidden = true
    const typeCount = $('workflowTypeCount')
    if (typeCount) typeCount.textContent = 'not checked'
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

  // The breakdown summary has to say what it holds, or the operator opens it to
  // find out whether there is anything in it.
  const shown = WORKFLOW_TYPES.filter((type) => (byType[type]?.open || byType[type]?.closed || byType[type]?.rejected))
  set('workflowTypeCount', shown.length ? `${shown.length} types` : '')

  grid.innerHTML = shown.map((type) => {
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
    resetListPage('alerts')
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
// Subject panel
// =============================================================
/**
 * Open the six-attribute panel on a subject.
 *
 * The reference is `{ kind, id }` and nothing else: the panel resolves the
 * record, its workflow and its history itself, so every entry point — the
 * workflow ribbon, the escalation view, the command palette — opens the same
 * panel on the same data rather than three partial versions of it.
 */
function openSubjectPanel(ref) {
  return lazy('/workflow/panel.js').then((m) => m.openSubjectPanel(ref)).catch((err) => {
    console.error('Subject panel failed to load:', err)
    setStatus('The subject panel could not be loaded.')
  })
}

/**
 * The open workflow instances, reachable.
 *
 * The ribbon reported nine open workflows and gave no route to any of them. An
 * instance here is a button rather than a row because the panel is where the
 * detail lives, and a second read-only table of the same fields would be a
 * second place for them to go stale.
 */
function renderWorkflowInstanceList() {
  const list = $('workflowInstanceList')
  if (!list) return
  // "No open workflow instances" is a finding — it says every workflow has been
  // closed. It is also what this panel printed when the request had never been
  // answered, because a failed load leaves `state.data.workflows` unset and
  // `|| []` cannot tell an empty queue from an unchecked one.
  if (state.failedSources?.has('workflows')) {
    list.innerHTML = '<p class="workflow-empty">The open workflows have not been checked. '
      + 'The request did not get an answer, so this is not an empty list.</p>'
    const failedCount = $('workflowInstanceCount')
    if (failedCount) failedCount.textContent = 'not checked'
    return
  }

  const instances = state.data.workflows?.data || []
  const open = instances.filter((w) => !['closed', 'rejected'].includes(w.state))
  const count = $('workflowInstanceCount')
  if (count) count.textContent = `${open.length} of ${instances.length}`

  if (!open.length) {
    list.innerHTML = '<p class="workflow-empty">No open workflow instances.</p>'
    return
  }

  list.innerHTML = open.map((w) => `<button class="source-card" type="button" data-instance="${escapeHtml(w.id)}">
      <span class="source-card-header">
        <span class="source-name">${escapeHtml(String(w.type || '').replace(/_/g, ' '))}</span>
        <span class="status-pill status-${safeClass(w.state)}">${escapeHtml(String(w.state || '').replace(/_/g, ' '))}</span>
      </span>
      <span class="workflow-metric-meta">${w.district ? escapeHtml(w.district) : 'no district'} · opened ${escapeHtml(formatRelative(w.created_at))}</span>
    </button>`).join('')

  list.querySelectorAll('[data-instance]').forEach((btn) => {
    btn.addEventListener('click', () => openSubjectPanel({ kind: 'workflow_instance', id: btn.dataset.instance }))
  })
}

// =============================================================
// Equity panel
// =============================================================
/**
 * The panel's rendering, in `/panels/equity.js` and fetched with the panel's
 * markup — the same deferral the other panels' behaviour got, and the reason the
 * console's first load carries a table an operator opens when auditing district
 * coverage rather than when opening the console.
 */
function renderEquityTab() {
  lazy('/panels/equity.js')
    .then((module) => module.render({
      $, state, escapeHtml, truncate, pageWindow, renderPager,
    }))
    .catch((error) => {
      // Said rather than blank: an empty equity table reads as "no district has
      // a false-positive rate", which is a finding, not a failure.
      console.error('equity panel failed to load:', error)
      const table = $('equityTable')
      const empty = $('equityEmptyState')
      if (empty) {
        empty.hidden = false
        empty.textContent = 'The equity table could not be loaded, so nothing is being shown about district coverage.'
      }
      if (table) table.hidden = true
    })
}

// =============================================================
// Signal to action metrics
// =============================================================
async function loadSignalToAction() {
  try {
    // `apiSettled`, not `fetch`. These two were raw `fetch` with no `res.ok`
    // check and no timeout, which is the specific failure `apiFetch` exists to
    // prevent and whose mechanism is recorded at runtime.js:196-202 — a service
    // worker offline-miss body parses fine as `json()`, so a disconnected
    // console called `.json()` on a response that was never the data and got
    // `undefined` rather than an error. `undefined?.data` is `undefined`, so the
    // status bar blanked all three metrics and reported nothing about why.
    //
    // Settled per endpoint rather than `Promise.all` on purpose: these are two
    // independent facts about the same question, and one dead endpoint must not
    // blank the other's. A dead `/events` with a live `/dispatches` still tells
    // an operator the last dispatch was hours ago.
    const [events, dispatches] = await Promise.all([
      apiSettled('/api/v1/events?limit=1&order=desc'),
      apiSettled('/api/v1/rapidpro/dispatches?limit=50'),
    ])

    // `?.` rather than `?.data?.` on the payload: `apiSettled` returns `null` on
    // failure, not a rejected promise, so `events.data` on a null throws — and
    // the old `catch` would then hide all three metrics, reporting one dead
    // endpoint as "nothing has been checked", which is the opposite of what
    // settled-per-endpoint is for.
    const lastEvent = events?.data?.[0]
    const lastDispatch = dispatches?.data?.sort((a, b) =>
      new Date(b.sent_at || 0) - new Date(a.sent_at || 0))[0]

    // Set on every pass, in both directions.
    //
    // This only ever removed `hidden`. Once a refresh had a dispatch, the metric
    // stayed on screen for the life of the page — and if a later refresh failed
    // or the store emptied, it stayed on screen with the value from minutes ago
    // and no indication that it was stale. Freshness is the one thing a status
    // bar exists to report, so an unread one is worse than an absent one.
    const setMetric = (metricId, valueId, value) => {
      const metric = $(metricId)
      const slot = $(valueId)
      if (!metric) return
      if (value === null || value === undefined || value === '') {
        metric.setAttribute('hidden', '')
        if (slot) slot.textContent = ''
        return
      }
      if (slot) slot.textContent = value
      metric.removeAttribute('hidden')
    }

    setMetric('lastSignalMetric', 'lastSignalTime',
      lastEvent?.observed_at ? formatRelative(lastEvent.observed_at) : null)
    setMetric('lastActionMetric', 'lastActionTime',
      lastDispatch?.sent_at ? formatRelative(lastDispatch.sent_at) : null)

    // Median lag. Guarded on the payload, not on `dispatches.data` — this
    // endpoint's failure is now a `null` from `apiSettled` rather than a
    // throw, and the metric has to go *unknown* rather than take the panel down
    // with it.
    const dispatchRows = dispatches?.data || []
    if (dispatchRows.length > 0) {
      const lags = dispatchRows
        .filter((d) => d.dispatched_at && d.matched_signal_at)
        .map((d) => (new Date(d.dispatched_at) - new Date(d.matched_signal_at)) / 1000 / 60)
        .sort((a, b) => a - b)
      if (lags.length > 0) {
        const median = lags[Math.floor(lags.length / 2)]
        const dotEl = $('lagDot')
        setMetric('medianLagMetric', 'medianLag', formatDuration(median))
        if (dotEl) {
          dotEl.className = 'dot '
          if (median < 1440) dotEl.classList.add('dot-ok')
          else if (median < 2880) dotEl.classList.add('dot-warn')
          else dotEl.classList.add('dot-danger')
        }
      } else {
        // Dispatches exist, none carries both timestamps, so the interval is not
        // measurable. Say so rather than leaving the metric off and letting the
        // absence read as "not yet" rather than "cannot be".
        setMetric('medianLagMetric', 'medianLag', t('statusbar.lag_unmeasurable', 'not measurable'))
      }
    } else {
      setMetric('medianLagMetric', 'medianLag', null)
    }
  } catch (err) {
    // The status bar is the one panel that must not keep claiming freshness
    // after it has failed to check. Hide all three.
    console.error('Failed to load signal-to-action metrics:', err)
    for (const id of ['lastSignalMetric', 'lastActionMetric', 'medianLagMetric']) $(id)?.setAttribute('hidden', '')
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

// ENH-19. The determination dialog's markup is deferred (public/panels/
// outcome.html) because eight controls at boot is eight controls a console on a
// field connection pays for, to open a dialog an operator opens about once a
// week. So its wiring cannot be a module-level element listener on an id —
// the element does not exist yet, and a listener attached to nothing is a
// control that silently does not work. Wired once the template is in the DOM.
let _outcomeTemplate = null

async function loadOutcomeTemplate() {
  if (_outcomeTemplate) return true
  try {
    // The same loader the rail panels use, so there is one place that knows how
    // to fetch a deferred template and one guard that can see it.
    _outcomeTemplate = await loadTemplate('/panels/outcome.html')
  } catch (err) {
    // Said rather than swallowed: a determination dialog that will not open is
    // the difference between a recorded judgement and an unmeasured deployment,
    // and the operator deserves to know which one they are looking at.
    setStatus('The determination dialog could not be loaded, so a determination cannot be recorded here.')
    console.error('outcome template failed to load', err)
    return false
  }
  document.body.insertAdjacentHTML('beforeend', _outcomeTemplate)
  $('outcomeDialog')?.addEventListener('close', () => {
    // The held alert is cleared on close, not on cancel: dismissing with Esc left
    // a high-severity alert in state and the next open dispatched what the
    // operator had abandoned.
    state._outcomeAlert = null
    restoreDialogFocus($('outcomeDialog'))
  })
  $('outcomeSubmit')?.addEventListener('click', () => { submitOutcomeFromDialog() })
  return true
}

/**
 * The determination dialog. ENH-19's way in.
 *
 * Three decisions worth stating, because each is a place this could have claimed
 * something it does not know:
 *
 * 1. **The reason list follows the determination.** "Justified" and "false" have
 *    disjoint reasons, and showing the union in one dropdown lets somebody file
 *    "hazard_occurred_as_warned" against a false alert — which is not a
 *    judgement, it is a contradiction, and it would poison the rollup.
 * 2. **A recorded determination opens as a correction,** pre-filled with what was
 *    recorded. Re-recording replaces nothing: the server supersedes, and the
 *    first determination stays in the record.
 * 3. **Nothing is claimed about coverage when the tally cannot be fetched.** An
 *    unanswerable request leaves the line blank, because "0 of 400 determined"
 *    and "we could not ask" are different facts and only one of them is true.
 */
async function openOutcomeDialog(alert) {
  if (!(await loadOutcomeTemplate())) return
  const dialog = $('outcomeDialog')
  if (!dialog) return
  const determination = determinationFor(alert)
  if (determination.kind === 'unavailable') {
    setStatus(determination.reason)
    return
  }
  state._outcomeAlert = alert

  const reasons = await fetchReasons()
  $('outcomeSeverity').textContent = alert.severity || '—'
  $('outcomeRule').textContent = alert.rule_name || alert.metric || '—'

  const prior = $('outcomePrior')
  if (determination.kind === 'recorded') {
    prior.hidden = false
    prior.textContent = `Recorded as ${determination.reason ? humanReason(determination.reason) : determination.determination}`
      + (determination.determined_at ? ` on ${displayDate(determination.determined_at)}` : '')
      + '. Saving below records a correction; the original stays in the record.'
  } else {
    prior.hidden = true
    prior.textContent = ''
  }

  const select = $('outcomeReason')
  select.innerHTML = ''
  const setReasons = (which) => {
    select.innerHTML = reasonOptions(determination.reasons[which])
  }
  setReasons(determination.kind === 'recorded' ? determination.determination : 'justified')

  document.querySelectorAll('input[name="outcomeDetermination"]').forEach((radio) => {
    radio.checked = determination.kind === 'recorded' && radio.value === determination.determination
    radio.addEventListener('change', () => setReasons(radio.value))
  })
  // With nothing recorded, `justified` is preselected so the dialog is one click
  // from complete — and the radio reflects that rather than starting on nothing,
  // which would read as "nobody has decided" when in fact the operator has.
  if (determination.kind !== 'recorded') {
    const first = document.querySelector('input[name="outcomeDetermination"]')
    if (first) first.checked = true
  }

  $('outcomeDeterminedBy').value = determination.determined_by || ''
  $('outcomeNote').value = ''
  const error = $('outcomeError')
  error.hidden = true
  error.textContent = ''

  rememberDialogOpener(dialog)
  dialog.showModal()
}

async function submitOutcomeFromDialog() {
  const alert = state._outcomeAlert
  const chosen = document.querySelector('input[name="outcomeDetermination"]:checked')
  const error = $('outcomeError')
  const say = (message) => {
    error.hidden = false
    error.textContent = message
  }
  if (!alert) return say('No alert is selected. Close this and open the determination from an alert row.')
  if (!chosen) return say('Choose whether the alert was justified.')

  const result = await submitOutcome({
    alertId: alert.id,
    determination: chosen.value,
    reason: $('outcomeReason').value,
    determinedBy: $('outcomeDeterminedBy').value.trim(),
    note: $('outcomeNote').value.trim(),
  }, { post: postJson })

  if (!result.ok) return say(result.error)
  $('outcomeDialog')?.close()
  // The tally has moved, so the next paint must ask again rather than trust the
  // figure it cached before this determination existed.
  state._outcomeCoverageAsked = false
  setStatus(result.data?.determination === 'false'
    ? 'Recorded: the alert was not justified. This is what the false-alert rate is computed from.'
    : 'Recorded: the alert was justified.')
  await refresh({ force: true })
  await refreshOutcomeCoverage()
}

/**
 * The coverage line above the list.
 *
 * Deliberately last in the rail rather than on every row: "12 of 400 alerts have
 * been judged" is a fact about the deployment, and repeating it four hundred times
 * is how a number becomes furniture. It is also the number an operator needs
 * before believing any rate the console shows — the registry will publish a
 * false-alert rate from twelve determinations if they clear its floor, and the
 * floor is a floor on the sample, not on how the sample was chosen.
 */
async function refreshOutcomeCoverage() {
  const host = $('alertsOutcomeCoverage')
  if (!host) return
  const tally = await fetchCoverage()
  if (!tally) {
    // Not "0 of 0": the request did not answer, and a line claiming zero
    // determined is a claim about the deployment nobody made.
    host.hidden = true
    host.textContent = ''
    return
  }
  const note = coverageNote(tally, { t: (key, vars) => formatOutcomeCoverage(key, vars) })
  host.hidden = !note
  host.textContent = note
}

/**
 * The two coverage sentences, from the catalogue.
 *
 * Built in JavaScript rather than markup, so it was the one string on this panel
 * that no locale could reach — and the gate that catches a missing `data-i18n`
 * key cannot see a template literal either. Hence `test/outcome-surface.test.js`
 * asserts both keys exist, and the fallback below is English rather than a key:
 * a coverage line reading `outcome.coverage_some: 12 of 400` is worse than no
 * line at all.
 */
function formatOutcomeCoverage(key, vars) {
  const text = t(key, vars)
  if (text === key) return formatOutcomeCoverageFallback(vars)
  return text
}

function formatOutcomeCoverageFallback(vars) {
  if (vars.determined === 0) {
    return `None of the ${vars.alerts} alerts has been judged yet — every rate on this screen is unmeasured.`
  }
  return `${vars.determined} of ${vars.alerts} alerts judged (${vars.pct}%): `
    + `${vars.false_alerts} not justified, ${vars.justified} justified.`
}

// =============================================================
// Tabs
// =============================================================

/**
 * The four panels whose markup is fetched on first open rather than shipped.
 *
 * The console shipped 58 keyboard-focusable controls inside panels that start
 * `hidden` and lay out at `opacity: 0`, at coordinates identical to the visible
 * panel's. That is 59% of the console's interactive surface reachable by Tab
 * and invisible on screen — and 12 KB gzipped of HTML that a field operator
 * paid for on every load to reach controls they could not see.
 *
 * The panel element itself stays in index.html; only its contents move. That
 * is what makes the deferral safe: `switchTab` still finds `panel-equity`, the
 * tab strip still has a panel to point `aria-controls` at, and the a11y tree
 * still has a tabpanel to land on. What is deferred is the 58 controls.
 *
 * Each tab is fetched at most once per page and then cached in the module-level
 * map, so a second switch is synchronous — the same shape as `lazy()` for the
 * workflow modules.
 */
const DEFERRED_PANELS = {
  equity: '/panels/equity.html',
  reports: '/panels/reports.html',
  ingestion: '/panels/ingestion.html',
  settings: '/panels/settings.html',
}

const _mountedPanels = new Map()

/**
 * Bindings for controls inside the four deferred panels.
 *
 * These 21 listeners used to bind by element id at module
 * scope. With the markup inline that ran against a live element and the `?.`
 * was defensive. With the markup deferred it runs against *nothing*: the
 * element does not exist yet, `?.` short-circuits, and the listener is never
 * attached — silently, with no error, because a no-op optional call is not a
 * failure anything reports.
 *
 * The result would have been four panels of buttons that render correctly and
 * do nothing when clicked. That is a far worse defect than the 12 KB the
 * deferral saves: a dead button tells an operator the platform cannot do the
 * thing, and they will not retry it or report it, because there is nothing
 * visible to report.
 *
 * So the deferred controls are bound from here, after their markup lands, and
 * the registration is idempotent — `mountPanel` runs once per panel per page, but
 * a listener added twice would fire a POST twice, which for
 * `runButton`/`generateReportButton` is not a harmless duplicate.
 */
const _deferredBound = new Set()

/** Attach every listener for one deferred panel's controls. */
function bindDeferredPanel(name) {
  // Side-effect bindings that are not a single control each. Named here rather
  // than discovered, because a panel whose wiring is "whatever ran at module
  // scope" is a panel whose wiring silently stopped when its markup moved.
  if (name === 'settings') { bindApiKeyInput(); refreshAuthState(); dhis2Settings() }
  const entries = DEFERRED_PANEL_BINDINGS[name]
  if (!entries) return 0
  let bound = 0
  for (const [id, event, handler] of entries) {
    const key = `${name}:${id}:${event}`
    if (_deferredBound.has(key)) continue
    const el = $(id)
    // A missing control is reported rather than skipped. Silence here is how a
    // renamed id produced a dead button for a release.
    if (!el) {
      console.warn(`Deferred panel "${name}": no element with id "${id}" to bind ${event}`)
      continue
    }
    el.addEventListener(event, handler)
    _deferredBound.add(key)
    bound += 1
  }
  return bound
}

/**
 * Declared after the handlers it references, and read lazily inside
 * `mountPanel`, so the ordering here is a documentation choice rather than a
 * load-order dependency. Kept as data rather than as 21 wrapped closures so
 * the set of deferred controls is greppable in one place — the failure mode
 * this file exists to prevent was invisible precisely because it was scattered
 * across 21 separate lines.
 */
const DEFERRED_PANEL_BINDINGS = {
  reports: [
    // Toggles the inline form rather than opening a dialog — the form is
    // declared hidden in the panel and revealed here, which is why the
    // `hidden` guard in R-56 matters for this control specifically.
    ['newReportButton', 'click', () => {
      const form = $('newReportForm')
      if (form) form.hidden = !form.hidden
    }],
    // Through the module: these used to close over functions in this file, so
    // every console load parsed six actions for a tab nobody had opened.
    ['generateReportButton', 'click', () => reportsPanel().then((panel) => panel.generateReport())],
    ['createReportTemplateButton', 'click', () => reportsPanel().then((panel) => panel.createReportTemplate())],
  ],
  equity: [
    ['triggerEquityAuditButton', 'click', async () => {
      const district = prompt('Enter district for equity audit:')
      if (!district) return
      setStatus('Triggering equity audit workflow...')
      const payload = await postJson('/api/v1/workflows', {
        type: 'equity_audit_action',
        state: 'threshold_breached',
        district: district,
      })
      setStatus(payload.success ? `Equity audit workflow triggered for ${district}.` : (payload.error || 'Workflow trigger failed'))
      await refresh({ force: true })
    }],
  ],
  ingestion: [
    // Through `ingestionAction`, because the panel's behaviour is loaded with its
    // markup: these buttons are inside that markup, so the module is loaded by
    // the time anyone can press one, and `runOrExplain` covers the case where it
    // is not — with a sentence, because a button that does nothing and says
    // nothing is the failure mode this whole change is arranged to avoid.
    ['runButton', 'click', () => runOrExplain('runIngestion')],
    ['createIngestionSchedulesButton', 'click', () => runOrExplain('createPublicIngestionSchedules')],
    ['runDueIngestionButton', 'click', () => runOrExplain('runDueIngestion')],
    ['importAcledButton', 'click', () => runOrExplain('importAcledConflictCsv')],
    ['importCsvButton', 'click', () => runOrExplain('importServiceAssets', 'csv')],
    ['importGeoJsonButton', 'click', () => runOrExplain('importServiceAssets', 'geojson')],
    ['exportGeoJsonButton', 'click', () => window.open('/api/v1/export.geojson', '_blank')],
    ['exportCsvButton', 'click', () => window.open('/api/v1/export.csv', '_blank')],
  ],
  settings: [
    ['addWebhookForm', 'submit', async (e) => {
      e.preventDefault()
      const url    = $('webhookUrlInput')?.value?.trim()
      const events = ($('webhookEventsInput')?.value || 'alert.*').split(',').map((s) => s.trim()).filter(Boolean)
      if (!url) return
      const payload = await postJson('/api/v1/webhooks', { url, events })
      setStatus(payload.success ? `Webhook added.` : (payload.error || 'Webhook failed'))
      renderSettingsPanel()
    }],
    ['createIncidentButton', 'click', () => settingsAction('createIncident')],
    ['createInterventionButton', 'click', () => settingsAction('createIntervention')],
    ['createTaskButton', 'click', () => settingsAction('createTask')],
    ['createAlertRuleButton', 'click', () => settingsAction('createAlertRule')],
    ['evaluateAlertsButton', 'click', () => settingsAction('evaluateAlerts')],
    ['sendRapidProAlertButton', 'click', () => settingsAction('sendLatestRapidProAlert')],
    ['createReportScheduleButton', 'click', () => settingsAction('createReportSchedule')],
    ['runDueReportsButton', 'click', () => settingsAction('runDueReports')],
  ],
}

/**
 * Fetch a deferred panel's markup and insert it into its shell.
 *
 * Resolves even on failure — the caller has already switched the tab, so a
 * rejection would leave it looking switched with a blank panel and no reason.
 * The failure is stated in words instead.
 *
 * @returns {Promise<boolean>} whether the panel's contents are now in the DOM
 */
/**
 * Fetch a deferred template once and return its markup.
 *
 * Extracted from `mountPanel` rather than duplicated for the determination
 * dialog, because a second copy is a second set of error handling and the
 * front-end's fetch guard is built to notice exactly that: the one exemption it
 * allows is a named function, so a second implementation reads as a second
 * exemption. `cache: 'no-cache'` deliberately — the service worker owns the
 * caching, and a browser HTTP cache here would serve a stale template to an
 * offline-first console with no way to tell.
 */
const _templateCache = new Map()

async function loadTemplate(url) {
  if (_templateCache.has(url)) return _templateCache.get(url)
  const pending = (async () => {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  })()
  _templateCache.set(url, pending)
  try {
    const html = await pending
    _templateCache.set(url, html)
    return html
  } catch (err) {
    // A failed template must not be cached as a failure: the next open, on a
    // connection that has come back, would replay the rejection forever.
    _templateCache.delete(url)
    throw err
  }
}

/**
 * A panel template's contents, without the wrapper it was cut from.
 *
 * Parsed rather than string-sliced: the cut has to find the first element's
 * matching close, and a regex that guesses at nesting depth produces a panel
 * missing its last form on a template that gains one.
 */
function innerMarkupOf(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const wrapper = parsed.body.firstElementChild
  // No wrapper, or a wrapper that is not the panel itself: insert it as it is
  // rather than dropping content on the floor.
  if (!wrapper) return html
  if (wrapper.children.length === 0 && !wrapper.textContent.trim()) return ''
  return wrapper.innerHTML
}

async function mountPanel(name) {
  const url = DEFERRED_PANELS[name]
  if (!url) return true
  const shell = $(`panel-${name}`)
  if (!shell) return false
  if (_mountedPanels.has(name)) return true

  let html
  try {
    html = await loadTemplate(url)
  } catch (err) {
    // Say what happened rather than showing an empty tab. "No data" here would
    // be the console's unearned-negative defect all over again, on the panel
    // that holds the settings and the connector configuration.
    console.error(`Failed to load the ${name} panel:`, err)
    shell.innerHTML = '<div class="empty-state empty-state-error" role="status">'
      + '<p class="empty-state-title">This panel could not be loaded</p>'
      + `<p>The ${name} panel's markup was not fetched, so this is not an empty panel. `
      + 'Check the connection and switch tabs again.</p></div>'
    _mountedPanels.set(name, false)
    return false
  }

  // The template carries the panel's own outer <div>, and the shell in
  // index.html is that same element — so the *contents* go in here and the
  // shell keeps its id, role, aria-labelledby and hidden.
  //
  // Which means the wrapper has to come off. Inserting the template whole put a
  // second `id="panel-reports"` inside the first, and `getElementById` then
  // answered with the outer, empty, still-hidden one — so every deferred tab
  // mounted, fetched its data, rendered into the nested copy, and displayed
  // nothing. The browser gate reported it as "rail tab renders visible content —
  // 0 chars", which was a precise description of a duplicate id.
  shell.innerHTML = innerMarkupOf(html)
  // Bind before the panel is unhidden, so a control is never focusable and
  // clickable before it does anything.
  bindDeferredPanel(name)
  _mountedPanels.set(name, true)
  return true
}

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

  // Mount before rendering: for a deferred panel the ids do not exist yet, so
  // rendering first would paint an empty panel and never fill it.
  if (DEFERRED_PANELS[name]) {
    // And say so while it loads. The tab was unhidden two lines above, so
    // without this the operator gets an empty box for the length of a fetch —
    // which on a field connection is seconds of a control that looks broken. The
    // browser gate caught this as "rail tab renders visible content — 0 chars",
    // and it was right: the panel is not empty, it has not arrived yet.
    const shell = $(`panel-${name}`)
    if (shell && !_mountedPanels.get(name)) {
      shell.innerHTML = '<div class="empty-state" role="status">'
        + '<p class="empty-state-title">Loading…</p>'
        + `<p>The ${name} panel is fetched when you first open it, so the first `
        + 'visit takes a moment on a slow connection.</p></div>'
    }
    mountPanel(name).then((mounted) => {
      if (!mounted) return
      if (name === 'reports')   renderReportsPanel()
      else if (name === 'equity')    renderEquityTab()
      else if (name === 'ingestion') renderIngestionPanel()
      else if (name === 'settings')  renderSettingsPanel()
    })
    // Data for a deferred panel is still requested now, so the fetch overlaps
    // the markup fetch rather than queueing behind it.
    refresh({ force: false })
    return
  }

  if (name === 'workflows')   { loadWorkflowMetrics() }
  else if (name === 'alerts')    renderAlertsPanel()
  // Opening a tab is a request for its data. The poll only fetches the active
  // tab's endpoints, so without this a tab left open for an hour would render
  // from whatever the boot load put in state — hours old, with no indication.
  refresh({ force: false })
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
/**
 * The console's current view, in the shape `shared/view-state.js` encodes.
 *
 * Read from the controls rather than tracked separately: a second copy of the
 * state is a second thing that can be wrong, and a link that disagrees with the
 * screen beside it is worse than no link.
 */
function currentView() {
  return {
    tab: state.activeTab,
    window: $('mapTimeRange')?.value || '',
    severity: $('mapSeverity')?.value || '',
    source: $('mapSource')?.value || '',
    selected: state.selectedRecordId || '',
    assetType: $('coldChainToggle')?.checked ? 'cold_chain' : '',
    focus: state.workflowTypeFilter || '',
    map: { ...state.mapTransform },
  }
}

function syncFiltersToUrl() {
  const query = encodeView(currentView(), { role: 'operator' })
  // replaceState, not pushState: a filter change should not bury the operator's
  // back button under a stack of identical console states, and the 30-second
  // refresh rewriting the URL must never add one.
  history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname)
  updateShareControl()
}

/**
 * The share control, shown only when the view differs from the role default.
 *
 * A share button on an untouched default view invites people to send a link
 * that says nothing they had not already sent. It appears the moment a filter
 * moves, so its presence answers "is there anything here worth passing on".
 */
function updateShareControl() {
  const btn = $('shareViewBtn')
  if (!btn) return
  btn.hidden = !isCustom(currentView(), { role: 'operator' })
}

$('shareViewBtn')?.addEventListener('click', async () => {
  const btn = $('shareViewBtn')
  const status = $('shareViewStatus')
  const url = shareUrl(currentView(), { role: 'operator', pathname: location.pathname })
  try {
    await navigator.clipboard.writeText(url)
    if (status) status.textContent = 'Link copied. It opens this exact view.'
  } catch {
    // Clipboard needs a secure origin. On a plain-HTTP district deployment it is
    // simply unavailable, and the operator still needs the link.
    if (status) {
      status.textContent = `Copying is blocked in this browser. This link opens this view: ${url}`
    }
  }
})

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
  // One decoder for the whole view rather than a parameter read per control, so
  // a link written by another surface lands here unchanged.
  const view = decodeView(window.location.search)
  applyFilterValue('mapSeverity', view.severity)
  applyFilterValue('mapTimeRange', view.window)
  if (view.map) {
    state.mapTransform = { ...state.mapTransform, ...view.map }
    applyMapTransform()
  }
  if (view.selected) state.selectedRecordId = view.selected
  // The source list arrives from /api/v1/sources and is empty until it does, so
  // a restored source has nowhere to land yet. Hand it forward rather than
  // dropping it, and let populateMapSourceFilter discard it if the feed is gone.
  if (view.source) state._restoredSource = view.source

  if (view.assetType === 'cold_chain' && $('coldChainToggle')) $('coldChainToggle').checked = true
  state.filters.coldChain = Boolean($('coldChainToggle')?.checked)

  state.alertFilter = view.window === 'open' ? 'open' : view.window === 'approved' ? 'approved' : 'all'
  state.workflowTypeFilter = view.focus || null
  syncAlertFilterChips()
  updateShareControl()
}

// =============================================================
// Alerts panel
// =============================================================
// =============================================================
// WEB-07 — a redraw that does not take the keyboard with it
// =============================================================
//
// `container.innerHTML = ...` on a 30-second timer threw away the node the
// operator was standing on. Focus fell to `<body>`, so the next Tab started
// from the top of the document, and a half-typed query died mid-word. It is
// the same conflation as the falsy-zero bugs: the code knew which *records*
// were new and had no idea which *element* the human was using.
//
// Three fixes, in order of how much they matter:
//
//   1. Don't redraw while a field has focus. The state is already loaded; a
//      paint 200ms later is indistinguishable and costs the operator nothing.
//   2. When a redraw does happen, put focus and caret back — by a stable key
//      carried in the markup, never by node identity, which the rebuild
//      destroys.
//   3. Keep scroll offsets. A rebuilt list resets to the top of a list the
//      operator had scrolled 400px into.
//
// All three helpers are pure or take their DOM by argument, so each is
// testable against plain objects.

export const FOCUS_KEY_ATTR = 'data-focus-key'

/**
 * A snapshot of "where the caret is", if it is somewhere we can find again.
 *
 * Only elements carrying `data-focus-key` are captured. Anything else in a
 * rebuilt subtree has no stable identity — its position shifts as records
 * arrive — and restoring focus to the wrong control is worse than dropping it.
 */
export function captureFocus(activeEl) {
  if (!activeEl || typeof activeEl.getAttribute !== 'function') return null
  const key = activeEl.getAttribute(FOCUS_KEY_ATTR)
  if (!key) return null
  const start = typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null
  const end = typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null
  return { key, start, end }
}

/**
 * Put the caret back where it was, if the element still exists.
 *
 * `preventScroll` matters: without it, focusing an element near the bottom of
 * a long rebuilt list scrolls the page to it, which is the scroll jump we are
 * here to prevent.
 */
export function restoreFocus(root, snapshot) {
  if (!root || !snapshot || typeof root.querySelectorAll !== 'function') return false
  const nodes = root.querySelectorAll(`[${FOCUS_KEY_ATTR}]`)
  let target = null
  for (const node of nodes) {
    if (node.getAttribute(FOCUS_KEY_ATTR) === snapshot.key) { target = node; break }
  }
  if (!target || typeof target.focus !== 'function') return false
  target.focus({ preventScroll: true })
  if (snapshot.start !== null && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start)
  }
  return true
}

/**
 * Whether an automatic redraw should stand down.
 *
 * True while the operator is typing, or has focus inside a region that is
 * about to be replaced. Deferring is free — the data is already in `state`, and
 * the next paint or a blur puts it on screen — whereas clobbering the caret
 * loses a sentence the human wrote.
 */
export function shouldDeferRedraw(activeEl) {
  if (!activeEl || typeof activeEl.getAttribute !== 'function') return false
  if (activeEl.isContentEditable) return true
  const tag = String(activeEl.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  // Focus inside a region keyed as live: about to be rebuilt under the caret.
  return Boolean(activeEl.closest?.('[data-live-region]'))
}

/** Scroll offsets of the given scrollable nodes, as pairs. */
export function captureScroll(nodes) {
  const out = []
  for (const node of nodes || []) {
    const top = node?.scrollTop
    if (typeof top === 'number' && top !== 0) out.push([node, top])
  }
  return out
}

/** Re-apply a scroll snapshot. One-way: it never captures. */
export function restoreScroll(pairs) {
  for (const [node, top] of pairs || []) {
    try { node.scrollTop = top } catch { /* a node detached mid-rebuild */ }
  }
  return (pairs || []).length
}

/**
 * Wrap a destructive rebuild so it cannot take the UI down with it.
 *
 * Captures before, restores after, and returns whether the redraw was skipped
 * because someone was typing — the caller replays the deferred paint on blur.
 */
export function preserveUiAroundRebuild(rebuild) {
  const active = document.activeElement
  if (shouldDeferRedraw(active)) return false
  const focus = captureFocus(active)
  const scroll = captureScroll([
    document.scrollingElement, document.body, $('alertsList'), $('mapRecordListBody'),
  ])
  rebuild()
  restoreScroll(scroll)
  if (focus) restoreFocus(document, focus)
  return true
}

/**
 * The tab badge, which is a claim about how many alerts are open.
 *
 * It took `alerts` as an array and nothing else, so every failure upstream
 * arrived here as `[]` and the badge hid itself — indistinguishable from a
 * genuinely quiet queue. That is the R-64 defect in its most compressed form:
 * a number that can only ever be zero or absent, where the third honest answer
 * is "unknown". An operator scanning the tab strip saw no badge on a dead
 * console and read it as nothing to do.
 *
 * `checked` is whether the alert feed has actually answered. Unchecked gets an
 * em dash, not a zero and not nothing.
 */
function renderAlertsBadge(alerts, { checked = true } = {}) {
  const badge = $('alertsBadge')
  if (!badge) return
  if (!checked) {
    badge.textContent = '—'
    badge.hidden = false
    badge.setAttribute('title', 'Alert count not checked — the last refresh did not get an answer')
    return
  }
  badge.removeAttribute('title')
  const open = alerts.filter((a) => a.status === 'open').length
  if (open > 0) { badge.textContent = String(open); badge.hidden = false }
  else { badge.hidden = true }
}

/** Signature of the last painted alert list; see `renderAlertsPanel`. */
let _alertsSignature = ''

/** True while a deferred alert redraw is still owed. */
let _alertsRedrawPending = false

/**
 * Redraw the alerts list without disturbing the operator.
 *
 * A periodic redraw that lands mid-sentence used to discard the caret and the
 * scroll position. Two guards: stand down entirely while a field has focus, and
 * otherwise snapshot focus, caret and scroll across the rebuild. The first
 * paint of a list still animates; a repaint of the same 30 records does not.
 */
function renderAlertsPanel() {
  ensureEscalation()
  const painted = preserveUiAroundRebuild(() => _renderAlertsPanel())
  escalation?.render()
  if (!painted) _alertsRedrawPending = true
  return painted
}

// The pending paint is replayed when focus leaves the surface. Waiting for the
// next 30-second tick would leave the list stale for up to half a minute after
// the operator stopped typing.
document.addEventListener('focusout', () => {
  if (!_alertsRedrawPending) return
  // Focusout fires before focus lands, so a keystroke that moved the caret out
  // of the field would replay against the wrong element.
  setTimeout(() => {
    if (shouldDeferRedraw(document.activeElement)) return
    _alertsRedrawPending = false
    _renderAlertsPanel()
    escalation?.render()
    _renderMapRecordList(_lastMapEntries)
  }, 0)
})

/**
 * What the alert rail is allowed to claim, given what is actually known.
 *
 * The branch this replaces was `if (!filtered.length)`, and `filtered` cannot
 * distinguish "the server says there are none" from "the server never
 * answered". On a cold start with `/api/v1/alert-events` down,
 * `state.data.alerts` is undefined, `|| []` converts an unchecked request into
 * an empty array, and the rail printed **"No alerts. All rules quiet."** while
 * the status bar on the same screen said nothing had been checked. Two
 * screens, opposite claims, no way for the operator to tell which is a lie.
 *
 * This is the panel that answers "what needs my attention right now", and it
 * was the one making an unearned negative claim. A reassuring string is the
 * most expensive thing a product can get wrong: an operator who reads "all
 * rules quiet" stops reading.
 *
 * Three outcomes, and the third is the one that did not exist:
 *
 *   error       the refresh ran and `alerts` failed — the request did not
 *               answer. The only record of this is `state.failedSources`,
 *               written on every refresh; the alerts branch simply never read
 *               it, while `renderWorkflowInstanceList` does exactly this.
 *   unchecked   no refresh has populated `state.data.alerts` at all. No
 *               failure to report and no rows to show, and "all rules quiet"
 *               is still a claim about the world. This is the cold-start case
 *               a failed-branch alone does not cover.
 *   empty       the server answered, and there is genuinely nothing.
 *
 * `unchecked` is not a rare path. It is the state of the page for every
 * operator between first paint and the first refresh completing, and it is the
 * state the console sits in permanently if `/health` answers and
 * `/alert-events` does not.
 *
 * Pure and exported: the decision is the whole fix, and asserting on rendered
 * HTML would prove only that `innerHTML` was called.
 *
 * @param {{ data: Record<string, unknown>, failedSources?: Set<string> }} state
 * @returns {{ state: 'error'|'unchecked'|'empty'|'ok', neverChecked: boolean }}
 */
export function alertListOutcome(state) {
  const failed = state?.failedSources instanceof Set
    ? state.failedSources
    : new Set(state?.failedSources || [])
  if (failed.has('alerts')) return { state: 'error', neverChecked: false }
  if (state?.data?.alerts === undefined) return { state: 'unchecked', neverChecked: true }
  if (!(state?.data?.alerts?.data || []).length) return { state: 'empty', neverChecked: false }
  return { state: 'ok', neverChecked: false }
}

function _renderAlertsPanel() {
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

  // The filter bar sits above the map but its labels claim nothing about
  // scope, so `Severity: High` narrowing only the map was read as narrowing the
  // console. The rail is now held to the same bar as the map, and is told what
  // the bar cost it — including the alerts it dropped for carrying no severity
  // at all, which is the count an operator most needs and had none of.
  const bar = currentFilters()
  const barActive = Boolean(bar.severity || bar.source || bar.since || bar.coldChainOnly)
  let barUndetermined = 0
  if (barActive) {
    filtered = filtered.filter((a) => {
      const verdict = evaluateMapFilters(a, bar)
      if (verdict.undetermined) barUndetermined += 1
      return verdict.shown
    })
  }

  const container = $('alertsList')
  if (!container) return

  // A rebuild that does not know where the caret is will take it. The list is
  // marked live so `shouldDeferRedraw` stands down while a field is focused,
  // and every control carries a stable key so focus and caret survive the
  // rebuilds that do happen.
  container.setAttribute('data-live-region', 'alerts')

  // Once per paint, not once per row: the line is one fact about the deployment.
  // Deliberately not awaited — the panel paints from the alerts it already has,
  // and a slow tally must not hold the list hostage.
  if (state._outcomeCoverageAsked !== true) {
    state._outcomeCoverageAsked = true
    refreshOutcomeCoverage()
  }

  // Three outcomes, not two. Extracted so the decision can be tested directly
  // rather than inferred from rendered HTML: it is the difference between a
  // console that lies on a dead link and one that admits it.
  const outcome = alertListOutcome(state)
  if (outcome.state !== 'ok' && outcome.state !== 'empty') {
    const desc = describeState(ERROR, { subject: 'Alerts', noun: 'the alert feed' })
    container.innerHTML = '<div class="empty-state empty-state-error" role="status">'
      + `<p class="empty-state-title">${escapeHtml(desc.title)}</p>`
      + `<p>${escapeHtml(desc.body)}</p>`
      + (outcome.neverChecked
        // "Never checked" is a different fact from "the check failed", and an
        // operator debugging a dead link needs to tell them apart.
        ? '<p class="filter-scope-note">No refresh has completed on this page yet.</p>'
        : '<p class="filter-scope-note">Failed source: alerts</p>')
      + '</div>'
    // The count is a claim too. Leaving the previous number on screen while the
    // body says "not checked" is how a stale figure becomes a trusted one.
    renderAlertsBadge([], { checked: false })
    renderPager($('alertsPager'), 'alerts', 0, () => _renderAlertsPanel())
    return
  }

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(t('state.empty_alerts'))}</p>${
      barActive ? `<p class="filter-scope-note">${escapeHtml(barScopeNote(bar, barUndetermined))}</p>` : ''
    }</div>`
    renderPager($('alertsPager'), 'alerts', 0, () => _renderAlertsPanel())
    return
  }

  // Re-animating 30 cards twice a minute is motion nobody asked for, and for a
  // screen reader it is the whole list being re-announced. Animate on the
  // frames where the contents actually changed, and not otherwise.
  const signature = `${barActive ? JSON.stringify(bar) : ''}|${filtered.map((a) => `${a.id}:${a.status}`).join('|')}`
  const animate = signature !== _alertsSignature
  _alertsSignature = signature

  const slice = pageWindow('alerts', filtered.length)
  const page = filtered.slice(slice.start, slice.end)

  container.innerHTML = (barActive
    ? `<p class="filter-scope-note">${escapeHtml(barScopeNote(bar, barUndetermined))}</p>`
    : '') + page.map((alert, i) => {
    const delay = animate ? Math.min(i * 40, 320) : 0
    const canSend = alert.status === 'approved' || alert.status === 'auto_approved' || alert.status === 'auto-approved'
    // The metric was rendered straight from the API — `precipitation_mm`,
    // `conflict_events_count_7d` — as the line that says why this alert fired.
    // It is now the metric's name and unit.
    const metric = alert.metric_expression || alert.metric || ''
    const metricText = metric.includes(' ')
      ? metric
      : metricLabel(metric)
    const statusText = String(alert.status || '').replace(/_/g, ' ')
    // A rule name is free text from the connector and can run to a sentence.
    // Truncated for the rail, with the full string on the title and reachable in
    // full through the row's own detail dialog — truncated without a way back to
    // the rest is a deleted fact, not a shortened one.
    const ruleName = alert.rule_name || metricLabel(alert.metric) || alert.id || ''
    return `<div class="alert-item" style="animation-delay:${delay}ms" role="listitem">
      <div class="alert-item-row">
        <span class="sev-chip sev-${sevClass(alert.severity)}">${escapeHtml(alert.severity || 'unknown')}</span>
        <span class="alert-rule-name" title="${escapeHtml(ruleName)}">${escapeHtml(truncate(ruleName, { max: 64 }))}</span>
        <span class="alert-timestamp">${displayDate(alert.created_at)}</span>
      </div>
      <div class="alert-item-meta">
        <span class="alert-metric">${escapeHtml(metricText)}</span>
        <span class="status-pill status-${safeClass(alert.status || 'unknown')}">${escapeHtml(statusText)}</span>
      </div>
      <div class="item-actions">
        <button class="btn btn-xs btn-approve" data-id="${escapeHtml(alert.id)}" data-action="approve"
                ${FOCUS_KEY_ATTR}="alert:${escapeHtml(alert.id)}:approve"
                data-i18n="action.approve">Approve</button>
        <button class="btn btn-xs btn-reject" data-id="${escapeHtml(alert.id)}" data-action="reject"
                ${FOCUS_KEY_ATTR}="alert:${escapeHtml(alert.id)}:reject"
                data-i18n="action.reject">Reject</button>
        <button class="btn btn-xs btn-send" data-id="${escapeHtml(alert.id)}" data-action="send"
                ${canSend ? '' : `disabled title="${escapeHtml(SEND_BLOCKED_REASON)}"`} ${FOCUS_KEY_ATTR}="alert:${escapeHtml(alert.id)}:send"
                data-i18n="action.send">Send</button>
        <button class="btn btn-xs" data-id="${escapeHtml(alert.id)}" data-action="details"
                ${FOCUS_KEY_ATTR}="alert:${escapeHtml(alert.id)}:details">Details</button>
        <button class="btn btn-xs" data-id="${escapeHtml(alert.id)}" data-action="outcome"
                ${FOCUS_KEY_ATTR}="alert:${escapeHtml(alert.id)}:outcome"
                title="${escapeHtml(outcomeButtonTitle(alert))}">${escapeHtml(outcomeButtonLabel(alert))}</button>
      </div>
      ${outcomeBadge(alert)}
      ${canSend ? '' : `<p class="alert-blocked-note">${escapeHtml(
        `Send is off — ${SEND_BLOCKED_REASON}${statusText}.`
      )}</p>`}
    </div>`
  }).join('')

  renderPager($('alertsPager'), 'alerts', filtered.length, () => _renderAlertsPanel())

  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const { id, action } = e.currentTarget.dataset
      if (action === 'details') {
        const alert = (state.data.alerts?.data || []).find((a) => a.id === id)
        if (alert) openDetailDialog(alert)
        return
      }
      if (action === 'outcome') {
        const alert = (state.data.alerts?.data || []).find((a) => a.id === id)
        if (alert) openOutcomeDialog(alert)
        return
      }
      handleAlertAction(id, action)
    })
  })
}

// =============================================================
// Needs escalation (JTBD-476)
// =============================================================
/**
 * The escalation view, mounted on the first alert paint and repainted with it.
 *
 * Repainted rather than left alone because the alert list above it repaints
 * every thirty seconds, and two lists on one panel that disagree about which
 * alerts are open is worse than no second list. `render()` reads through
 * `state.data.alerts` rather than taking a snapshot, so it cannot drift.
 */
let escalation = null
let escalationReady = null

/** Mount the view, and hand back the controller even if it was already up. */
function ensureEscalation() {
  if (escalation) return Promise.resolve(escalation)
  if (escalationReady) return escalationReady
  escalationReady = lazy('/workflow/escalation.js').then((m) => {
    escalation = m.mountEscalation({
      getAlerts: () => state.data.alerts?.data || [],
      openSubject: openSubjectPanel,
    })
    escalation?.render()
    return escalation
  }).catch((err) => {
    // Not cached: a failed import would otherwise fail every later call
    // identically, and the console would report a broken feature with no way to
    // retry it.
    escalationReady = null
    console.error('Escalation view failed to load:', err)
    return null
  })
  return escalationReady
}

$('alertFilterChips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip')
  if (!chip) return
  state.alertFilter = chip.dataset.filter
  // A narrower filter yields a shorter list; leaving the page index where it was
  // shows page 2 of a list that now ends on page 1.
  resetListPage('alerts')
  syncAlertFilterChips()
  syncFiltersToUrl()
  renderAlertsPanel()
})

/**
 * ENH-19 — the alert rail's part of the outcome channel.
 *
 * Three small functions, and each answers a question an operator has while
 * looking at a row rather than a question about the data model: what does the
 * button say, does this alert already have a determination, and what does the
 * rail claim about coverage.
 */
function outcomeButtonLabel(alert) {
  const determination = determinationFor(alert)
  return determination.kind === 'recorded' ? 'Change determination' : 'Was this justified?'
}

/**
 * The button's title says *what will happen*, not what the row is. On a recorded
 * alert a title reading "justified" reads as a state; the button opens a
 * correction, and a control whose label describes the wrong action is worse than
 * no title at all.
 */
function outcomeButtonTitle(alert) {
  const determination = determinationFor(alert)
  if (determination.kind === 'unavailable') return determination.reason
  if (determination.kind === 'recorded') {
    return `Recorded as ${determination.reason ? humanReason(determination.reason) : determination.determination}`
      + (determination.determined_at ? ` on ${displayDate(determination.determined_at)}` : '')
      + '. This opens a correction.'
  }
  return 'Record whether this warning was justified, and why'
}

/**
 * The recorded determination, on the row it belongs to.
 *
 * Absent when there is nothing recorded, and that is deliberate: a badge reading
 * "unknown" on every un-reviewed alert turns a rail into a wall of hedges, and an
 * operator learns to skip it. The coverage line at the top of the panel is where
 * the unknown is stated — once, in aggregate, where it is a fact about the
 * deployment rather than a note on every row.
 */
function outcomeBadge(alert) {
  const determination = determinationFor(alert)
  if (determination.kind !== 'recorded') return ''
  const cls = determination.determination === 'false' ? 'status-false' : 'status-justified'
  const label = determination.determination === 'false' ? 'not justified' : 'justified'
  return `<p class="filter-scope-note"><span class="status-pill ${cls}">${escapeHtml(label)}</span>`
    + `${determination.reason ? ` — ${escapeHtml(humanReason(determination.reason))}` : ''}</p>`
}

async function handleAlertAction(id, action) {
  const safeId = encodeURIComponent(id)
  if (action === 'approve') {
    const payload = await postJson(`/api/v1/alert-events/${safeId}/approve`, { actor: 'dashboard' })
    setStatus(payload.success ? `Alert approved. Sending it will now release the trigger.`
      : `Could not approve: ${payload.error || 'the server gave no reason'}.`)
  } else if (action === 'reject') {
    const payload = await postJson(`/api/v1/alert-events/${safeId}`, { status: 'rejected' })
    setStatus(payload.success ? 'Alert rejected. No finance is released.'
      : `Could not reject: ${payload.error || 'the server gave no reason'}.`)
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
    setStatus(payload.success ? 'Alert sent. It will reach each recipient by SMS.'
      : `Could not send: ${payload.error || 'the server gave no reason'}.`)
  }
  await refresh({ force: true })
}

// =============================================================
// Reports panel
// =============================================================
/**
 * The panel's rendering and its six actions, in `/panels/reports.js` and
 * fetched with the panel's markup.
 *
 * The actions used to live behind `DEFERRED_PANEL_BINDINGS` closures over
 * functions in this file, which meant every console load parsed them to bind
 * buttons behind a tab. The module is loaded on first visit instead, and the
 * bindings ask for it.
 */
let _reports = null

async function reportsPanel() {
  if (_reports) return _reports
  const module = await lazy('/panels/reports.js')
  _reports = module.mount({
    $, state, escapeHtml, truncate, displayDate, pageWindow, renderPager,
    setStatus, postJson, refresh,
  })
  return _reports
}

function renderReportsPanel() {
  reportsPanel()
    .then((panel) => panel.renderReportsPanel())
    .catch((error) => {
      // An empty list reads as "no reports exist", which is a finding about the
      // district rather than about this console. Say which it is.
      console.error('reports panel failed to load:', error)
      const container = $('reportsList')
      if (container) {
        container.innerHTML = '<div class="empty-state empty-state-error" role="status">'
          + '<p class="empty-state-title">The reports panel could not be loaded</p>'
          + '<p>Nothing is being shown about reports. Switch tabs and try again.</p></div>'
      }
    })
}


// =============================================================
// Ingestion panel
// =============================================================
/**
 * The source-status list, rendered from the refresh payload.
 *
 * The panel's *behaviour* — running a source, importing a file, creating
 * schedules — moved to /panels/ingestion.js, which is fetched with the panel's
 * markup. This renderer stayed because it reads `state.data`, which the refresh
 * fills for every panel: it costs a few lines and no request, and moving it
 * would have meant passing the whole console state into the module to save them.
 */
function renderIngestionPanel() {
  const healthData = state.data.ingestionHealth?.data || []
  const sources    = state.data.sources?.data || []
  const container  = $('sourceStatusList')
  if (!container) return

  // The panel's behaviour arrives with its markup. Loaded here rather than in
  // `switchTab` because this renderer is also reached from the refresh, and the
  // module must be loaded before the panel's buttons can be bound — not merely
  // before someone clicks the tab.
  loadIngestionPanel().then(() => {
    bindDeferredPanel('ingestion')
  }).catch((err) => {
    console.error('Ingestion controls failed to load:', err)
    setStatus('The ingestion controls did not load. The source list below is still accurate.')
  })

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

/**
 * Mount the ingestion panel's behaviour, once, on first visit to the tab.
 *
 * The buttons in `DEFERRED_PANEL_BINDINGS` and the two command-palette entries
 * call through `ingestionAction`, which reads this. Before the panel has been
 * opened there is nothing to call — and that is not reachable from the UI,
 * because those buttons are inside the panel's own markup.
 */
let _ingestion = null

async function loadIngestionPanel() {
  if (_ingestion) return _ingestion
  const module = await lazy('/panels/ingestion.js')
  _ingestion = await module.mount({
    $, escapeHtml, setStatus, authHeaders, postJson, refresh, state, ensureEscalation,
  })
  return _ingestion
}

/** The panel's behaviour, or null when the tab has not been opened. */
function ingestionAction(name) {
  return _ingestion ? _ingestion[name] : null
}

/** Run one of the panel's actions, or say why it could not be run. */
async function runOrExplain(name, ...args) {
  const action = ingestionAction(name)
  if (!action) {
    setStatus('The ingestion controls have not finished loading. Open the Ingestion tab and try again.')
    return false
  }
  return action(...args)
}
// Settings panel
// =============================================================
/**
 * The Settings panel's rendering and its operations forms, in
 * `/panels/settings.js` and fetched with the panel's markup — the last of the
 * four deferred panels whose behaviour still shipped in the console's first
 * load. Its eight actions were parsed on every console open to serve a screen an
 * operator visits to configure a webhook.
 */
let _settings = null

async function settingsPanel() {
  if (_settings) return _settings
  const module = await lazy('/panels/settings.js')
  _settings = module.mount({
    $, state, escapeHtml, fetchJson, lazy, setStatus, queueRequest, refresh,
    bindApiKeyInput, reportsPanel, postJson,
  })
  return _settings
}

function renderSettingsPanel() {
  settingsPanel()
    .then((panel) => panel.renderSettingsPanel())
    .catch((error) => {
      // Said rather than blank: an empty settings list reads as "nothing is
      // configured", which is a statement about the deployment.
      console.error('settings panel failed to load:', error)
      setStatus('The settings panel could not be loaded, so nothing is being shown about configuration.')
    })
}

/** Run one of the panel's actions — the bindings and the palette both do. */
function settingsAction(name, ...args) {
  return settingsPanel().then((panel) => panel[name]?.(...args))
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
  // ENH-19. The derivation goes above the field list, not instead of it: the
  // field list is still what the record literally says, and the derivation is
  // the part a reader cannot get anywhere else.
  detailBodyEl.innerHTML = `<div id="explainHost" class="chart-panel"></div>`
    + `<dl>${entries.map(([k, v]) =>
      `<dt>${escapeHtml(k.replaceAll('_', ' '))}</dt><dd>${escapeHtml(String(v ?? ''))}</dd>`
    ).join('')}</dl>`
  rememberDialogOpener(detailDialog)
  detailDialog.showModal()
  renderExplainInto(record)
}

/**
 * Fill the dialog's explanation block.
 *
 * Filled after the dialog opens, because the module is behind `lazy()` and a
 * dialog that waits for a network fetch before it can be read is a dialog that
 * does not open on a slow link. An empty host on failure is the right outcome:
 * the field list below it is complete without this, and a stub saying "could
 * not load" would be a worse read than the absence.
 */
async function renderExplainInto(record) {
  const host = detailBodyEl?.querySelector('#explainHost')
  if (!host || !record) return
  try {
    const { renderExplain } = await lazy('/workflow/wire-explain.js')
    await renderExplain(host, record, { load: fetchJson })
  } catch {
    host.innerHTML = ''
  }
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
  // `escalation` rather than an id: the view builds its own markup when it
  // loads, and app.js asking the document for an element the module owns is how
  // the two drift apart.
  { icon: '!', label: 'Needs escalation',        category: 'Navigation', action: () => {
    switchTab('alerts')
    ensureEscalation().then(() => escalation?.expand())
  } },
  { icon: '2', label: 'Reports tab',             category: 'Navigation', action: () => switchTab('reports') },
  { icon: '3', label: 'Ingestion tab',           category: 'Navigation', action: () => switchTab('ingestion') },
  { icon: '4', label: 'Settings tab',            category: 'Navigation', action: () => switchTab('settings') },
  { icon: '>', label: 'Run all due sources',     category: 'Ingestion',  action: () => runOrExplain('runDueIngestion') },
  { icon: '>', label: 'Create default schedules',category: 'Ingestion',  action: () => runOrExplain('createPublicIngestionSchedules') },
  { icon: '+', label: 'Generate report',         category: 'Reports',   action: () => reportsPanel().then((panel) => panel.generateReport()) },
  { icon: '+', label: 'Approve latest report',   category: 'Reports',   action: () => reportsPanel().then((panel) => panel.approveLatestReport()) },
  { icon: '+', label: 'Distribute latest report',category: 'Reports',   action: () => reportsPanel().then((panel) => panel.distributeLatestReport()) },
  { icon: '!', label: 'Evaluate alert rules',    category: 'Alerts',    action: () => settingsAction('evaluateAlerts') },
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

/**
 * Palette results: actions plus, when there is a query, records (JTBD-091).
 *
 * The record index is built on the first open of the palette rather than at
 * boot, and refreshed once a minute thereafter — an operator who searched an
 * hour ago should not be told a record they just created does not exist.
 * Building it is five requests; the palette shows the actions immediately and
 * the records arrive a moment later, re-rendering in place rather than leaving
 * the operator with an empty list to interpret.
 */
let recordSearch = null
/** The index the palette last drew, so a resolved index repaints exactly once. */
let paintedRecordIndex = null

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1)

function renderPaletteResults(query) {
  const q = query.trim().toLowerCase()

  lazy('/workflow/search.js').then((m) => {
    if (!recordSearch) {
      m.bindSubjectOpener(openSubjectPanel)
      recordSearch = m
    }
    return m.recordIndex()
  }).then((ready) => {
    // Identity, not a boolean: `recordIndex` hands back the same array while it
    // is fresh and a new one after a rebuild, so this repaints when the records
    // changed and not on every keystroke's own repaint.
    if (!ready || ready === paintedRecordIndex || !cmdPalette.open) return
    paintedRecordIndex = ready
    renderPaletteResults(paletteInput?.value || '')
  }).catch((err) => console.error('Record search failed to load:', err))

  const recentAlerts = (state.data.alerts?.data || []).slice(0, 3).map((a) => ({
    icon: '!',
    label: `Alert: ${a.rule_name || a.id || ''}`,
    category: 'Recent alerts',
    haystack: `${a.rule_name || ''} ${a.id || ''}`.toLowerCase(),
    action: () => { switchTab('alerts'); openDetailDialog(a) },
  }))

  const records = recordSearch ? recordSearch.searchingFor(q) : []
  const actions = PALETTE_BASE.map((c) => ({ ...c, haystack: `${c.label} ${c.category}`.toLowerCase() }))
  const recent = q
    ? recentAlerts.filter((c) => c.haystack.includes(q))
    : recentAlerts

  // Records first: a query that matches an incident and the word "Alerts" is
  // answering a question about the incident.
  const items = [...records, ...recent, ...actions]
    .filter((c) => !q || c.haystack.includes(q))

  const caveat = recordSearch?.searchCaveat(q) || ''

  state._paletteItems = items
  state._paletteIndex = 0

  paletteResults.innerHTML = items.map((item, i) => `
    <li class="palette-result${i === 0 ? ' selected' : ''}" id="paletteOption${i}"
        data-index="${i}" role="option" aria-selected="${i === 0}">
      <span class="palette-result-icon">${escapeHtml(item.icon)}</span>
      <span class="palette-result-label">${escapeHtml(item.label)}</span>
      <span class="palette-result-category">${escapeHtml(item.category)}</span>
    </li>
  `).join('') + (q && !items.length
    ? `<li class="empty-note" role="presentation" style="padding:var(--sp-3) var(--sp-4)">No action or record matches.${caveat ? ` ${escapeHtml(sentence(caveat))}` : ''}</li>`
    : caveat
      ? `<li class="empty-note" role="presentation" style="padding:var(--sp-3) var(--sp-4)">${escapeHtml(sentence(caveat))}</li>`
      : '')

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
  await refresh({ force: true })
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
// =============================================================
// DHIS2 settings (localStorage only; no credential backend)
// =============================================================
/**
 * Wire the DHIS2 credential fields and restore their saved values.
 *
 * A named function rather than an IIFE, because these controls live in the
 * deferred settings panel. As an IIFE it ran once at module load, found no
 * `#dhis2SaveBtn` because that markup had not been fetched, and returned — so
 * the fields would never restore their saved values and neither button would
 * do anything, with nothing logged. `bindDeferredPanel` calls it after mount.
 */
function dhis2Settings() {
  const LS_KEY = 'lindela_lite_dhis2'
  const fields = ['dhis2BaseUrl', 'dhis2ApiToken', 'dhis2OrgUnits', 'dhis2DataElements', 'dhis2Period']
  const saveBtn = $('dhis2SaveBtn')
  const testBtn = $('dhis2TestBtn')
  const resultEl = $('dhis2TestResult')
  // Not a guard against a missing control but a "not mounted yet" early exit.
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
      // Reveal by removing the attribute, never by clearing `style.display`.
      // components.css closes the `[hidden]` class with `!important`, so an
      // inline-display un-hide there would be a no-op that reads as working.
      resultEl.hidden = false
    }
  })

  testBtn.addEventListener('click', async () => {
    if (resultEl) {
      resultEl.textContent = 'Testing...'
      resultEl.style.color = 'inherit'
      resultEl.hidden = false
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
}

// No-op until the settings panel has been fetched; `bindDeferredPanel` calls it again.
dhis2Settings()

// =============================================================
// Auto-refresh
// =============================================================
// There is no `setInterval` here any more. The cadence is owned by
// `schedulePoll`, which runs after each attempt and bases the next delay on
// that attempt's outcome; see `pollDelayMs` for the three rules it enforces.

// =============================================================
// Boot
// =============================================================
// Every boot step is guarded individually rather than the sequence being
// wrapped in one try. A single catch around the lot would restore nothing on a
// partial outage — the locale would stay unset and the URL filters would stay
// unrestored because an unrelated step failed first. Each step that can reject
// handles its own failure; the ones below are synchronous and cannot.
await loadLocale(state.locale).catch((err) => {
  console.error('Boot: locale catalogue did not load', err)
  setStatus('The language catalogue did not load. The interface is showing English strings.')
})
// The source picker used to be fetched here at boot, un-caught, so a dead server
// rejected and threw out of module evaluation — `restoreFiltersFromUrl` and the
// first `refresh` never ran, and the console booted half-built saying nothing.
// It is now fetched by the refresh (which is where the panel renders it from)
// and, on first visit to the tab, by /panels/ingestion.js — inside its own
// catch. Two requests for one list became one.
// Every panel repaints every thirty seconds, so a boot-time sweep would cover
// only the tables that happened to exist at boot. Observed instead — see
// `autoMarkScrollableRegions`.
autoMarkScrollableRegions()
restoreFiltersFromUrl()
// The alerts panel is the boot panel, but nothing calls switchTab to reach it —
// the markup ships with `active` on it. Mount its escalation section here, or
// it waits for a tab switch the operator never makes.
ensureEscalation()
// Armed before the first refresh so the observer's callback, if it fires during
// the boot fetch, finds a store already holding this tick's records.
watchEvidenceSurfaces()
await refresh({ first: true })
// The build version shown in the Settings panel comes from the health
// endpoint, which reads package.json, rather than from a literal in the markup
// that can drift behind the release.
fillAppVersion()
