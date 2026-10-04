// Scenario Workbench UI
//
// The workbench opened with eight empty text boxes and a "Run scenario" button
// at the bottom of an 850px form, so the primary action was the last thing on
// screen and the right-hand two-thirds was permanently empty. A planner arrives
// with a question, not a blank form, so the surface now opens on five named
// scenarios and Run sits with the results it produces.

import { apiFetch, initI18n, autoMarkScrollableRegions } from '/shared/runtime.js'
import { esc, formatRelative, num, signed } from '/shared/fmt.js'

const BASE = '/api/v1'

/**
 * `t` with an English fallback, because the shared runtime's returns the key
 * itself for a key no catalogue carries — and this surface ships keys in a
 * staged map the catalogues have not absorbed yet. The fallback is what a reader
 * sees in that window; the key name is what they would see instead, and the
 * whole reason check-i18n.mjs exists is that a health worker once met
 * `chw.submit` where a button label should have been.
 *
 * The gate scans for a two-argument `t(key, fallback)` call, so the second
 * argument is load-bearing: dropping it turns a translatable string into a name.
 */
export function t(key, fallback = key) {
  const resolved = window.__i18n?.t(key)
  return !resolved || resolved === key ? fallback : resolved
}

/**
 * `{name}` interpolation for the sentences.
 *
 * An unknown placeholder is left as written rather than blanked: a translator
 * who mistypes a key should meet `{precip}` in the running interface, not a
 * sentence with a hole in it.
 */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`))
}

/**
 * The languages this surface offers, mirrored in the `<select>` in index.html.
 *
 * English alone, because no catalogue carries a `scenarios.*` key yet and a
 * second option would render the whole workbench as key names. `init()` reads
 * the picker rather than trusting this list, and the test asserts the two agree
 * — a picker and a catalogue that disagree in either direction produce exactly
 * the bug the gate was written to catch.
 */
const OFFERED_LOCALES = ['en']
export { OFFERED_LOCALES }

const storedLocale = localStorage.getItem('lindela_lite_locale')
const state = {
  // The stored locale is written by surfaces that do offer more languages, so a
  // reader who last chose Swahili on the CHW app would arrive here holding `sw`
  // — with a page that cannot render one string of it, and a picker showing
  // English. The picker is the authority on what this surface can offer.
  locale: OFFERED_LOCALES.includes(storedLocale) ? storedLocale : 'en',
  precipitation_multiplier: 1.0,
  offline_asset_ids: new Set(),
  added_hazard_events: [],
  added_conflict_events: [],
}

/** The last run's payload, so a language switch redraws it instead of blanking it. */
let lastResult = null
/** The last error shown, for the same reason. */
let lastError = ''
/** The link the Copy button writes, bound once at module scope. */
let shareUrl = ''
/** Set when the hash names a scenario this server does not have. */
let shareUnavailable = false

/**
 * Whether this session has a result on screen.
 *
 * One flag for both halves of the results panel. The empty state used to be
 * hidden by a `hidden` attribute that the page's own `.empty-state-large`
 * `display: flex` outranked, so it stayed on screen at full size directly above
 * a complete set of numbers — the workbench telling an analyst who had just
 * run the model that they had not run one. Two independent toggles are what let
 * that happen; one flag read in one place cannot.
 */
let hasRun = false

/**
 * Named starting points.
 *
 * Each one is a complete perturbation a planner can run without touching a
 * form. The free-form controls remain for building something these do not cover.
 *
 * There is no `label` here any more. It was never read — the button captions
 * are markup, carrying `data-i18n` — so it was a second copy of five strings
 * that had already drifted from the ones on screen ("assets offline" against
 * "asset offline"), and translating it would have given a translator six strings
 * to maintain for a page that shows five.
 */
const PRESETS = {
  drought: {
    precipitation_multiplier: 0.6,
    offline_asset_ids: [],
    events: { hazards: [], conflicts: [] },
  },
  flood: {
    precipitation_multiplier: 2.0,
    offline_asset_ids: [],
    events: { hazards: [], conflicts: [] },
  },
  asset_outage: {
    precipitation_multiplier: 1.0,
    offline_asset_ids: 'all',
    events: { hazards: [], conflicts: [] },
  },
  conflict: {
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
    listEl.innerHTML = `<p class="empty-note">${esc(t('scenarios.assets_error', 'Assets could not be loaded. Scenarios that do not reference assets still work.'))}</p>`
    return
  }

  if (!assets.length) {
    listEl.innerHTML = `<p class="empty-note">${esc(t('scenarios.no_assets', 'No service assets are recorded yet.'))}</p>`
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
/**
 * The verdict on one coordinate, written beside the box that produced it.
 *
 * `aria-invalid` rather than colour alone: the message is a `p` the input points
 * at through `aria-describedby`, so it is announced with the field rather than
 * only painted under it.
 */
function setFieldError(inputId, errorId, message) {
  const input = $(inputId)
  const el = $(errorId)
  if (el) {
    el.textContent = message || ''
    el.hidden = !message
  }
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true')
    else input.removeAttribute('aria-invalid')
  }
}

const COORD_LIMITS = { lat: 90, lon: 180 }

/**
 * Read one coordinate, or say which of the two rules it broke.
 *
 * Both rules are the same on the server: a missing coordinate and one outside
 * WGS84's range. They are checked here as well because a form that reports a
 * problem only after a round trip is a form the operator has already learned to
 * distrust.
 */
function readCoordinate(inputId, errorId, which) {
  const limit = COORD_LIMITS[which]
  const raw = ($(inputId)?.value ?? '').trim()
  if (raw === '') {
    setFieldError(inputId, errorId,
      t('scenarios.err_coords_required', 'Scenario events need both a latitude and a longitude.'))
    return null
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < -limit || n > limit) {
    setFieldError(inputId, errorId,
      t('scenarios.err_coords_range', 'Latitude must be between −90 and 90, longitude between −180 and 180.'))
    return null
  }
  setFieldError(inputId, errorId, '')
  return n
}

function readEvent(typeId, severityId, latId, lonId, atId, fallbackType) {
  const at = $(atId)?.value
  const lat = readCoordinate(latId, `${latId}Error`, 'lat')
  const lon = readCoordinate(lonId, `${lonId}Error`, 'lon')
  if (lat === null || lon === null) {
    setError(t('scenarios.err_coords_required', 'Scenario events need both a latitude and a longitude.'))
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

// Live verdicts. `input` rather than `change` so the answer arrives while the
// operator is still typing the number, not when they leave the field; the
// message is only raised once something has been typed, so an untouched box is
// never scolded for being empty.
for (const [latId, lonId] of [['hazardLat', 'hazardLon'], ['conflictLat', 'conflictLon']]) {
  for (const [id, which, pairId] of [[latId, 'lat', lonId], [lonId, 'lon', latId]]) {
    $(id)?.addEventListener('input', () => {
      const raw = ($(id)?.value ?? '').trim()
      if (raw === '') {
        setFieldError(id, `${id}Error`, '')
        return
      }
      readCoordinate(id, `${id}Error`, which)
    })
    // On leaving the field, an empty box is only a problem when its partner has
    // been filled in — one coordinate without the other is what the model drops.
    // Two empty boxes are an untouched form, not a mistake.
    $(id)?.addEventListener('change', () => {
      const raw = ($(id)?.value ?? '').trim()
      if (raw !== '') {
        readCoordinate(id, `${id}Error`, which)
        return
      }
      const pair = ($(pairId)?.value ?? '').trim()
      setFieldError(id, `${id}Error`, pair === ''
        ? ''
        : t('scenarios.err_coords_required', 'Scenario events need both a latitude and a longitude.'))
    })
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
  lastError = message || ''
  const el = $('scenarioError')
  if (!el) return
  el.textContent = lastError
  el.hidden = !lastError
}

/**
 * The perturbation, in words, under the controls that set it.
 *
 * The counts were interpolated into English prose with a plural decided by a
 * ternary here — `"1 asset offline"` and `"2 assets offline"` were two
 * hand-assembled sentences. A translator cannot move a noun across a number,
 * so the plural now lives in the catalogue: English reads `{n} asset(s)` and a
 * language that marks plural by suffix or by gender has the string to do it in.
 */
function updateSummary() {
  const el = $('perturbationSummary')
  if (!el) return
  // A shared link this server cannot resolve outranks the run summary: it is
  // the only thing on the page explaining why the perturbation did not load,
  // and it used to be written straight to the element, so the next slider move
  // or language switch replaced it with the run summary and the reader was left
  // with a scenario that had silently failed to load.
  if (shareUnavailable) {
    el.textContent = t('scenarios.share_unavailable', 'This link points at a scenario that is not available on this server.')
    return
  }
  const parts = []
  if (state.precipitation_multiplier !== 1.0) {
    parts.push(fill(t('scenarios.part_rainfall', 'rainfall ×{n}'), { n: state.precipitation_multiplier.toFixed(2) }))
  }
  if (state.offline_asset_ids.size) {
    parts.push(fill(t('scenarios.part_assets_offline', '{n} asset(s) offline'), { n: String(state.offline_asset_ids.size) }))
  }
  if (state.added_hazard_events.length) {
    parts.push(fill(t('scenarios.part_hazard_events', '{n} hazard event(s)'), { n: String(state.added_hazard_events.length) }))
  }
  if (state.added_conflict_events.length) {
    parts.push(fill(t('scenarios.part_conflict_events', '{n} conflict event(s)'), { n: String(state.added_conflict_events.length) }))
  }
  el.textContent = parts.length
    ? fill(t('scenarios.running', 'Running: {parts}'), { parts: parts.join(', ') })
    : t('scenarios.running_baseline', 'Running: no perturbation (baseline)')
}

// --- Run --------------------------------------------------------------------
// One run control, `[data-run]`, in the bar at the top of the results rail. It
// used to be the last element of an 850px builder form — y:879 on a 960px
// viewport, below a 20-item checkbox list — and briefly there were two of it, a
// second "Run again" in the results header, two hundred pixels below the first.
// One primary action per page: the one at the top of the rail is the one the
// audit asked to be findable. The query still asks for every `[data-run]`, so
// restoring a second button needs no change here.
const runButtons = () => Array.from(document.querySelectorAll('[data-run]'))

async function runScenario() {
  setError('')
  const labels = runButtons().map((b) => b.textContent)
  runButtons().forEach((b, i) => { b.disabled = true; b.textContent = t('scenarios.running_busy', 'Running…') })

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
    if (!payload.diff) throw new Error(t('scenarios.err_no_comparison', 'The server returned no comparison for this scenario.'))
    showResults(payload, perturbation)
  } catch (err) {
    setError(err.message)
  } finally {
    runButtons().forEach((b, i) => { b.disabled = false; b.textContent = labels[i] })
  }
}

runButtons().forEach((b) => b.addEventListener('click', runScenario))

// Bound once, here, rather than inside showResults: that bound a fresh listener
// on every run and every shared link opened from the hash, so the eleventh run
// copied the same text eleven times. It reads `shareUrl` at click time, so a
// later run replaces what it writes.
//
// The clipboard failure used to be swallowed: on a non-secure origin the user
// got no link, no confirmation, and no indication anything had happened.
$('copyShareBtn')?.addEventListener('click', async () => {
  const status = $('copyStatus')
  try {
    await navigator.clipboard.writeText(shareUrl)
    if (status) status.textContent = t('scenarios.link_copied', 'Link copied.')
  } catch {
    if (status) status.textContent = t('scenarios.copy_blocked', 'Copying is blocked here. Select the link above and copy it manually.')
  }
})

/**
 * Everything below `#results` that is written from a payload rather than from
 * the form.
 *
 * Split out of `showResults` so a locale switch can redraw it. Painting it was
 * fused to the fetch that produced it, which meant the one control that changes
 * a string on this page left every result on it in the previous language — the
 * results half translated and the builder half not, which reads as a fault in
 * the data rather than in the interface.
 */
function paintResults(data) {
  const diff = data.diff || {}

  const limit = $('scenarioLimit')
  if (limit) {
    const parts = []
    if (data.model_limit) parts.push(esc(data.model_limit))
    if (diff.regions_compared != null) {
      parts.push(esc(fill(t('scenarios.averaged_over', 'Averaged over {n} region scores.'),
        { n: String(diff.regions_compared) })))
    }
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
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">${esc(t('scenarios.no_dataset_assets', 'No assets in the dataset.'))}</td></tr>`
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
}

function showResults(data, perturbation) {
  // The empty state and the results are one panel with two states, not two
  // blocks. Toggling them from two places is what let the empty state survive a
  // run; they are toggled together here and nowhere else.
  hasRun = true
  $('noResults').hidden = hasRun
  $('results').hidden = !hasRun
  lastResult = data
  paintResults(data)

  const token = data.token || btoa(JSON.stringify(perturbation)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  shareUrl = `${location.origin}/scenarios#${token}`
  $('shareUrl').textContent = shareUrl

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
  // "Up" and "Down" are two whole sentences rather than a word spliced in front
  // of a shared clause: a language that puts the verb last, or marks the
  // direction with a prefix, cannot be handed `${dir} 19.4 score points` and
  // read. The unit stays in the string, because a sentence that names an axis
  // without naming the unit is the sentence a reader skims past.
  const vars = { n: Math.abs(bar.value).toFixed(1), lo, hi }
  const reading = bar.value === 0
    ? fill(t('scenarios.delta_flat', 'No change in the mean sensitivity score. Axis runs from {lo} to {hi} score points.'), vars)
    : bar.value > 0
      ? fill(t('scenarios.delta_up', 'Up {n} score points on an axis running from {lo} to {hi} score points.'), vars)
      : fill(t('scenarios.delta_down', 'Down {n} score points on an axis running from {lo} to {hi} score points.'), vars)

  barsEl.innerHTML = `
    <div class="delta-axis" role="img" aria-label="${esc(reading)}">
      <span class="delta-tick">${esc(lo)}</span>
      <div class="delta-track">
        ${bar.direction === 'none' ? '' : `<div class="delta-fill ${bar.direction}" style="width:${bar.lengthPx.toFixed(2)}px"></div>`}
        <div class="delta-zero"></div>
      </div>
      <span class="delta-tick">${esc(hi)}</span>
    </div>
    <div class="delta-caption">${esc(t('scenarios.score_points', 'score points'))}</div>
  `
}

// --- Init -------------------------------------------------------------------
async function init() {
  await initI18n(state.locale)
  // The tab title is not a `data-i18n` target — the shared runtime rewrites
  // attributes and text nodes inside the document, and this is neither — so it
  // is set from the catalogue like any other string a reader meets.
  document.title = t('scenarios.doc_title', 'Lindela Scenario Workbench')

  const localeSelect = $('locale-select')
  localeSelect?.addEventListener('change', async (e) => {
    state.locale = e.target.value
    localStorage.setItem('lindela_lite_locale', state.locale)
    await window.__i18n.set(state.locale)
    // `set()` repaints the markup; everything below it was painted from a
    // payload or from form state, so it is repainted here.
    document.title = t('scenarios.doc_title', 'Lindela Scenario Workbench')
    updateSummary()
    if (lastError) setError(lastError)
    if (lastResult) paintResults(lastResult)
  })

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
    shareUnavailable = true
    updateSummary()
  }
}

init()
autoMarkScrollableRegions()