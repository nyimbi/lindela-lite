// Scenario Workbench UI
//
// The workbench opened with eight empty text boxes and a "Run scenario" button
// at the bottom of an 850px form, so the primary action was the last thing on
// screen and the right-hand two-thirds was permanently empty. A planner arrives
// with a question, not a blank form, so the surface now opens on five named
// scenarios and Run sits with the results it produces.

import { apiFetch } from '/shared/runtime.js'
import { esc, formatRelative, num, signed } from '/shared/fmt.js'

const BASE = '/api/v1'

// Perturbation state
const state = {
  precipitation_multiplier: 1.0,
  offline_asset_ids: new Set(),
  added_hazard_events: [],
  added_conflict_events: [],
}

/**
 * Named starting points.
 *
 * Each one is a complete perturbation a planner can run without touching a
 * form. The free-form controls remain for building something these do not cover.
 */
const PRESETS = {
  drought: {
    label: 'Drought — rains fail',
    precipitation_multiplier: 0.6,
    offline_asset_ids: [],
    events: { hazards: [], conflicts: [] },
  },
  flood: {
    label: 'Flood — rains double',
    precipitation_multiplier: 2.0,
    offline_asset_ids: [],
    events: { hazards: [], conflicts: [] },
  },
  asset_outage: {
    label: 'Access lost — assets offline',
    precipitation_multiplier: 1.0,
    offline_asset_ids: 'all',
    events: { hazards: [], conflicts: [] },
  },
  conflict: {
    label: 'Conflict — displacement events',
    precipitation_multiplier: 1.0,
    offline_asset_ids: [],
    events: {
      hazards: [],
      conflicts: [
        { event_type: 'intercommunal', severity: 'medium', latitude: 3.12, longitude: 35.6 },
        { event_type: 'intercommunal', severity: 'medium', latitude: 3.5, longitude: 35.9 },
        { event_type: 'armed-clash', severity: 'medium', latitude: 2.8, longitude: 35.2 },
      ],
    },
  },
  baseline: {
    label: 'Baseline',
    precipitation_multiplier: 1.0,
    offline_asset_ids: [],
    events: { hazards: [], conflicts: [] },
  },
}

let assets = []
let activePreset = null

const $ = (id) => document.getElementById(id)

// --- Precipitation slider ---------------------------------------------------
const precipSlider = $('precipMultiplier')
const precipValue = $('precipValue')

precipSlider?.addEventListener('input', () => {
  state.precipitation_multiplier = parseFloat(precipSlider.value)
  // The old format was "1.00x"; a multiplier reads as a multiple, not a decimal.
  precipValue.textContent = `${state.precipitation_multiplier.toFixed(2)}×`
  // Any manual movement means the preset is no longer what is running.
  clearPresetSelection()
  updateSummary()
})

function clearPresetSelection() {
  activePreset = null
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-pressed', 'false'))
}

// --- Assets -----------------------------------------------------------------
async function loadAssets() {
  const listEl = $('assetList')
  if (!listEl) return
  try {
    const json = await apiFetch(`${BASE}/service-assets`)
    assets = (json.data || []).slice(0, 20)
  } catch {
    listEl.innerHTML = '<p class="empty-note">Assets could not be loaded. Scenarios that do not reference assets still work.</p>'
    return
  }

  if (!assets.length) {
    listEl.innerHTML = '<p class="empty-note">No service assets are recorded yet.</p>'
    return
  }

  renderAssetList()
}

function renderAssetList() {
  const listEl = $('assetList')
  listEl.innerHTML = assets.map((a) => `
    <label class="check-row">
      <input type="checkbox" data-asset-id="${esc(a.id)}" ${state.offline_asset_ids.has(a.id) ? 'checked' : ''}>
      <span>${esc(a.name || a.id)}</span>
      <span class="muted-sm">${esc(a.service_type || '')}</span>
    </label>
  `).join('')

  listEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.assetId
      if (cb.checked) state.offline_asset_ids.add(id)
      else state.offline_asset_ids.delete(id)
      clearPresetSelection()
      updateSummary()
    })
  })
}

// --- Presets ----------------------------------------------------------------
document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset]
    if (!preset) return
    applyPreset(btn.dataset.preset, preset)
  })
})

function applyPreset(key, preset) {
  activePreset = key
  document.querySelectorAll('.preset').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.preset === key))
  })

  state.precipitation_multiplier = preset.precipitation_multiplier
  if (precipSlider) precipSlider.value = String(preset.precipitation_multiplier)
  if (precipValue) precipValue.textContent = `${preset.precipitation_multiplier.toFixed(2)}×`

  state.offline_asset_ids = preset.offline_asset_ids === 'all'
    ? new Set(assets.map((a) => a.id))
    : new Set(preset.offline_asset_ids || [])

  const now = new Date().toISOString()
  const withTime = (events) => (events || []).map((e) => ({ ...e, occurred_at: e.occurred_at || now, source: 'scenario_synthetic' }))
  state.added_hazard_events = withTime(preset.events.hazards)
  state.added_conflict_events = withTime(preset.events.conflicts)

  renderAssetList()
  updateSummary()
}

// --- Add events -------------------------------------------------------------
function readEvent(typeId, severityId, latId, lonId, atId, fallbackType) {
  const at = $(atId)?.value
  const rawLat = $(latId)?.value
  const rawLon = $(lonId)?.value
  if (rawLat === '' || rawLon === '') {
    setError('Scenario events need both a latitude and a longitude.')
    return null
  }
  const lat = Number(rawLat)
  const lon = Number(rawLon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    setError('Latitude must be between −90 and 90, longitude between −180 and 180.')
    return null
  }
  setError('')
  return {
    event_type: $(typeId)?.value.trim() || fallbackType,
    severity: $(severityId)?.value || 'medium',
    latitude: lat,
    longitude: lon,
    occurred_at: at ? new Date(at).toISOString() : new Date().toISOString(),
    source: 'scenario_synthetic',
  }
}

$('addHazardBtn')?.addEventListener('click', () => {
  const ev = readEvent('hazardType', 'hazardSeverity', 'hazardLat', 'hazardLon', 'hazardAt', 'flood')
  if (!ev) return
  state.added_hazard_events.push(ev)
  clearPresetSelection()
  updateSummary()
})

$('addConflictBtn')?.addEventListener('click', () => {
  const ev = readEvent('conflictType', 'conflictSeverity', 'conflictLat', 'conflictLon', 'conflictAt', 'intercommunal')
  if (!ev) return
  state.added_conflict_events.push(ev)
  clearPresetSelection()
  updateSummary()
})

function setError(message) {
  const el = $('scenarioError')
  if (!el) return
  el.textContent = message || ''
  el.hidden = !message
}

function updateSummary() {
  const el = $('perturbationSummary')
  if (!el) return
  const parts = []
  if (state.precipitation_multiplier !== 1.0) parts.push(`rainfall ×${state.precipitation_multiplier.toFixed(2)}`)
  if (state.offline_asset_ids.size) parts.push(`${state.offline_asset_ids.size} asset${state.offline_asset_ids.size === 1 ? '' : 's'} offline`)
  if (state.added_hazard_events.length) parts.push(`${state.added_hazard_events.length} hazard event${state.added_hazard_events.length === 1 ? '' : 's'}`)
  if (state.added_conflict_events.length) parts.push(`${state.added_conflict_events.length} conflict event${state.added_conflict_events.length === 1 ? '' : 's'}`)
  el.textContent = parts.length ? `Running: ${parts.join(', ')}` : 'Running: no perturbation (baseline)'
}

// --- Run --------------------------------------------------------------------
// Both the builder panel and the results header carry a run control; one is
// labelled "Run scenario" and the other "Run again", and both are disabled
// together while a run is in flight.
const runButtons = () => Array.from(document.querySelectorAll('[data-run]'))

async function runScenario() {
  setError('')
  const labels = runButtons().map((b) => b.textContent)
  runButtons().forEach((b, i) => { b.disabled = true; b.textContent = 'Running…' })

  const perturbation = {
    precipitation_multiplier: state.precipitation_multiplier,
    offline_asset_ids: Array.from(state.offline_asset_ids),
    added_hazard_events: state.added_hazard_events,
    added_conflict_events: state.added_conflict_events,
  }

  try {
    const json = await apiFetch(`${BASE}/scenarios`, { method: 'POST', body: perturbation })
    // The endpoint returns the scenario at the top level, not under `data`. This
    // read `json.data`, so "Run scenario" threw on every run, rendered nothing,
    // and left the three delta cards showing em dashes. Nothing caught it: the
    // error was caught and shown as text, so the page reported no console error
    // and every check passed.
    const payload = json.data || json
    if (!payload.diff) throw new Error('The server returned no comparison for this scenario.')
    showResults(payload, perturbation)
  } catch (err) {
    setError(err.message)
  } finally {
    runButtons().forEach((b, i) => { b.disabled = false; b.textContent = labels[i] })
  }
}

runButtons().forEach((b) => b.addEventListener('click', runScenario))

function showResults(data, perturbation) {
  $('noResults').hidden = true
  $('results').hidden = false

  const diff = data.diff || {}

  const limit = $('scenarioLimit')
  if (limit) {
    const parts = []
    if (data.model_limit) parts.push(esc(data.model_limit))
    if (diff.regions_compared != null) parts.push(`Averaged over ${esc(String(diff.regions_compared))} region scores.`)
    limit.innerHTML = parts.join(' ')
  }

  // One axis for all three cards. They carry the same quantity in the same
  // units — the change in the mean of an uncalibrated 0-100 sensitivity score —
  // so a shared extent is what lets the three be read against each other. Three
  // independently-scaled bars side by side are three unrelated pictures.
  const extent = deltaExtent([
    diff.flood_risk_delta_mean,
    diff.conflict_risk_delta_mean,
    diff.impacts_delta_mean,
  ])
  setDeltaCard('flood', diff.flood_risk_delta_mean, extent)
  setDeltaCard('conflict', diff.conflict_risk_delta_mean, extent)
  setDeltaCard('impacts', diff.impacts_delta_mean, extent)

  // Top affected assets, ranked by how much the scenario moved them.
  //
  // It sorted by scenario impact alone, which with every asset scoring the same
  // produced an arbitrary "top 10". It also read `asset_type`, a field that does
  // not exist on an impact assessment, and `baseline_impact_score`, which the API
  // did not return — so Type and Region showed em dashes and Delta showed a
  // fabricated +75 on every row, computed as `scenario - (missing ?? 0)`.
  const impacts = data.impact_assessments || []
  const sorted = [...impacts]
    .sort((a, b) => Math.abs(b.impact_delta ?? 0) - Math.abs(a.impact_delta ?? 0))
    .slice(0, 10)
  const tbody = $('affectedBody')
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No assets in the dataset.</td></tr>'
  } else {
    tbody.innerHTML = sorted.map((a) => `<tr>
      <td>${esc(a.asset_name || a.asset_id || '—')}</td>
      <td>${esc(a.service_type || '—')}</td>
      <td>${esc(a.region_name || '—')}</td>
      <td class="num-cell">${esc(num(a.baseline_impact_score, { dp: 1 }))}</td>
      <td class="num-cell">${esc(num(a.impact_score, { dp: 1 }))}</td>
      <td class="num-cell">${esc(signed(a.impact_delta, { dp: 1 }))}</td>
    </tr>`).join('')
  }

  const token = data.token || btoa(JSON.stringify(perturbation)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const shareUrl = `${location.origin}/scenarios#${token}`
  $('shareUrl').textContent = shareUrl

  // The clipboard failure used to be swallowed: on a non-secure origin the user
  // got no link, no confirmation, and no indication anything had happened.
  $('copyShareBtn')?.addEventListener('click', async () => {
    const status = $('copyStatus')
    try {
      await navigator.clipboard.writeText(shareUrl)
      if (status) status.textContent = 'Link copied.'
    } catch {
      if (status) status.textContent = 'Copying is blocked here. Select the link above and copy it manually.'
    }
  })

  history.replaceState(null, '', `/scenarios#${token}`)
}

/**
 * Round a magnitude up to a 1/2/5 extent — the smallest "nice" number that
 * still contains it.
 *
 * This is the whole of the fix for the truncated bars. The old scale started
 * from a hardcoded 40px baseline and clamped the bar into [4, 80]px, so it was
 * both fixed and clipping: a +2 and a +40 delta came out at nearly the same
 * width, and everything above +40 came out identical. Deriving the extent from
 * the data makes length monotonic in magnitude and never clipped, and stating
 * that extent on the axis is what lets a bar be read without the card text.
 *
 * `floor` matters for a zero or near-zero delta: an extent of 0 would divide by
 * zero and paint every bar full width.
 */
export function niceExtent(magnitude, floor = 1) {
  const m = Math.max(Number.isFinite(Number(magnitude)) ? Math.abs(Number(magnitude)) : 0, floor)
  const decade = 10 ** Math.floor(Math.log10(m))
  for (const step of [1, 2, 5, 10]) {
    if (m <= step * decade) return step * decade
  }
  return 10 * decade
}

/**
 * One extent covering every delta on the page.
 *
 * All three cards carry the same quantity in the same units, so a shared
 * extent is what makes them comparable. Per-card extents would render three
 * equal-length bars for three unrelated magnitudes.
 */
export function deltaExtent(values) {
  let peak = 0
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n)) peak = Math.max(peak, Math.abs(n))
  }
  return niceExtent(peak, 1)
}

/**
 * A delta bar as a pure geometry descriptor: how long, which way, on what axis.
 *
 * Null means there is nothing to draw. An absent delta is not a zero delta, and
 * the card says so with an em dash rather than painting an empty track that
 * looks like "no change".
 */
export function deltaBar(value, extent, { maxPx = 48 } = {}) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const span = extent > 0 ? extent : 1
  // The ratio is what the bar means; the pixels are just its size. `niceExtent`
  // guarantees extent >= |value|, so the min is a belt-and-braces guard on that
  // invariant rather than the clamp that used to hide truncation.
  const ratio = Math.min(1, Math.abs(n) / span)
  return {
    value: n,
    extent: span,
    ratio,
    lengthPx: ratio * maxPx,
    direction: n < 0 ? 'negative' : n > 0 ? 'positive' : 'none',
  }
}

export function setDeltaCard(prefix, value, extent) {
  const el = $(`${prefix}Delta`)
  const barsEl = $(`${prefix}Bars`)
  const bar = deltaBar(value, extent)
  if (!bar) {
    el.textContent = '—'
    barsEl.innerHTML = ''
    return
  }
  // Score points, not a percentage. The value used to be rendered with a "%"
  // suffix and coloured red or green, which read as a modelled physical outcome
  // — "doubling rainfall raises flood risk 19%" — rather than the change in an
  // uncalibrated sensitivity score. The colour is dropped for the same reason: a
  // higher sensitivity score is not by itself a worse outcome.
  el.textContent = signed(value, { dp: 1 })
  el.style.color = 'var(--ink)'

  // The old chart drew a "Base" bar at an invented 40px and a "Scen" bar at
  // 40 + delta, so it encoded score *levels* while the number printed above it
  // was a *delta* — two different quantities in one card, with neither one
  // labelled or scaled. The bar now encodes the delta it sits under, anchored at
  // a zero rule, on an extent stated on both ends of the axis.
  const lo = signed(-bar.extent, { dp: 0 })
  const hi = signed(bar.extent, { dp: 0 })
  const reading = bar.value === 0
    ? `No change in the mean sensitivity score. Axis runs from ${lo} to ${hi} score points.`
    : `${bar.value > 0 ? 'Up' : 'Down'} ${Math.abs(bar.value).toFixed(1)} score points on an axis running from ${lo} to ${hi} score points.`

  barsEl.innerHTML = `
    <div class="delta-axis" role="img" aria-label="${esc(reading)}">
      <span class="delta-tick">${esc(lo)}</span>
      <div class="delta-track">
        ${bar.direction === 'none' ? '' : `<div class="delta-fill ${bar.direction}" style="width:${bar.lengthPx.toFixed(2)}px"></div>`}
        <div class="delta-zero"></div>
      </div>
      <span class="delta-tick">${esc(hi)}</span>
    </div>
    <div class="delta-caption">score points</div>
  `
}

// --- Init -------------------------------------------------------------------
async function init() {
  await loadAssets()
  updateSummary()

  const hash = location.hash.slice(1)
  if (!hash) return

  try {
    const json = await apiFetch(`${BASE}/scenarios/${encodeURIComponent(hash)}`)
    const p = json.data?.perturbation || {}
    if (p.precipitation_multiplier) {
      state.precipitation_multiplier = p.precipitation_multiplier
      if (precipSlider) precipSlider.value = String(p.precipitation_multiplier)
      if (precipValue) precipValue.textContent = `${p.precipitation_multiplier.toFixed(2)}×`
    }
    state.offline_asset_ids = new Set(p.offline_asset_ids || [])
    state.added_hazard_events = p.added_hazard_events || []
    state.added_conflict_events = p.added_conflict_events || []
    clearPresetSelection()
    renderAssetList()
    updateSummary()
    showResults(json.data, p)
  } catch {
    // A shared link may reference a scenario this server does not have. Say so
    // rather than silently showing the empty state.
    $('perturbationSummary').textContent =
      'This link points at a scenario that is not available on this server.'
  }
}

init()