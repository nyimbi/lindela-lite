// Scenario Workbench UI

const BASE = '/api/v1'

// Perturbation state
const state = {
  precipitation_multiplier: 1.0,
  offline_asset_ids: new Set(),
  added_hazard_events: [],
  added_conflict_events: [],
}

// Precipitation slider
const precipSlider = document.getElementById('precipMultiplier')
const precipValue = document.getElementById('precipValue')
precipSlider.addEventListener('input', () => {
  state.precipitation_multiplier = parseFloat(precipSlider.value)
  precipValue.textContent = `${state.precipitation_multiplier.toFixed(2)}x`
  updateSummary()
})

// Load assets for multiselect
async function loadAssets() {
  const listEl = document.getElementById('assetList')
  try {
    const res = await fetch(`${BASE}/service-assets`)
    if (!res.ok) throw new Error('failed')
    const json = await res.json()
    const assets = (json.data || []).slice(0, 20)
    if (!assets.length) {
      listEl.innerHTML = '<p style="color:#6b7280;font-size:0.75rem;padding:0.25rem">No assets found.</p>'
      return
    }
    listEl.innerHTML = assets.map((a) => `
      <label style="display:flex;align-items:center;gap:0.4rem;padding:0.15rem 0.25rem;font-size:0.8rem;cursor:pointer">
        <input type="checkbox" data-asset-id="${esc(a.id)}" style="width:auto">
        ${esc(a.name || a.id)} <span style="color:#6b7280">(${esc(a.service_type || '')})</span>
      </label>
    `).join('')
    listEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.assetId
        if (cb.checked) state.offline_asset_ids.add(id)
        else state.offline_asset_ids.delete(id)
        updateSummary()
      })
    })
  } catch {
    listEl.innerHTML = '<p style="color:#6b7280;font-size:0.75rem;padding:0.25rem">Could not load assets.</p>'
  }
}

// Add hazard event
document.getElementById('addHazardBtn').addEventListener('click', () => {
  const ev = {
    event_type: document.getElementById('hazardType').value || 'flood',
    severity: document.getElementById('hazardSeverity').value || 'high',
    latitude: parseFloat(document.getElementById('hazardLat').value) || 0,
    longitude: parseFloat(document.getElementById('hazardLon').value) || 0,
    occurred_at: document.getElementById('hazardAt').value
      ? new Date(document.getElementById('hazardAt').value).toISOString()
      : new Date().toISOString(),
    source: 'scenario_synthetic',
  }
  state.added_hazard_events.push(ev)
  updateSummary()
})

// Add conflict event
document.getElementById('addConflictBtn').addEventListener('click', () => {
  const ev = {
    event_type: document.getElementById('conflictType').value || 'intercommunal',
    severity: document.getElementById('conflictSeverity').value || 'medium',
    latitude: parseFloat(document.getElementById('conflictLat').value) || 0,
    longitude: parseFloat(document.getElementById('conflictLon').value) || 0,
    occurred_at: document.getElementById('conflictAt').value
      ? new Date(document.getElementById('conflictAt').value).toISOString()
      : new Date().toISOString(),
    source: 'scenario_synthetic',
  }
  state.added_conflict_events.push(ev)
  updateSummary()
})

function updateSummary() {
  const el = document.getElementById('perturbationSummary')
  const parts = []
  if (state.precipitation_multiplier !== 1.0) parts.push(`precip ×${state.precipitation_multiplier.toFixed(2)}`)
  if (state.offline_asset_ids.size) parts.push(`${state.offline_asset_ids.size} assets offline`)
  if (state.added_hazard_events.length) parts.push(`+${state.added_hazard_events.length} hazard events`)
  if (state.added_conflict_events.length) parts.push(`+${state.added_conflict_events.length} conflict events`)
  el.textContent = parts.length ? `Perturbations: ${parts.join(', ')}` : ''
}

// Run scenario
document.getElementById('runScenarioBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('scenarioError')
  errEl.style.display = 'none'
  const perturbation = {
    precipitation_multiplier: state.precipitation_multiplier,
    offline_asset_ids: Array.from(state.offline_asset_ids),
    added_hazard_events: state.added_hazard_events,
    added_conflict_events: state.added_conflict_events,
  }
  try {
    const res = await fetch(`${BASE}/scenarios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(perturbation),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
    // The endpoint returns the scenario at the top level, not under `data`. This
    // read `json.data`, so "Run scenario" threw on every run, rendered nothing,
    // and left the three delta cards showing em dashes. Nothing caught it: the
    // error was caught and shown as text, so the page reported no console error
    // and every check passed.
    const payload = json.data || json
    if (!payload.diff) throw new Error('Scenario response contained no diff')
    showResults(payload, perturbation)
  } catch (err) {
    errEl.textContent = err.message
    errEl.style.display = ''
  }
})

function showResults(data, perturbation) {
  document.getElementById('noResults').style.display = 'none'
  document.getElementById('results').style.display = ''

  const diff = data.diff || {}

  const limit = document.getElementById('scenarioLimit')
  if (limit) {
    const parts = []
    if (data.model_limit) parts.push(data.model_limit)
    if (diff.regions_compared != null) parts.push(`Averaged over ${diff.regions_compared} region scores.`)
    limit.textContent = parts.join(' ')
  }

  // Delta cards
  setDeltaCard('flood', diff.flood_risk_delta_mean)
  setDeltaCard('conflict', diff.conflict_risk_delta_mean)
  setDeltaCard('impacts', diff.impacts_delta_mean)

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
  const tbody = document.getElementById('affectedBody')
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#6b7280;text-align:center">No assets in dataset.</td></tr>'
  } else {
    tbody.innerHTML = sorted.map((a) => `<tr>
      <td>${esc(a.asset_name || a.asset_id || '—')}</td>
      <td>${esc(a.service_type || '—')}</td>
      <td>${esc(a.region_name || '—')}</td>
      <td>${(a.baseline_impact_score ?? '—')}</td>
      <td>${(a.impact_score ?? '—')}</td>
      <td>${a.impact_delta == null ? '—' : (a.impact_delta > 0 ? '+' : '') + a.impact_delta}</td>
    </tr>`).join('')
  }

  // Share URL
  const token = data.token || btoa(JSON.stringify(perturbation)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const shareUrl = `${location.origin}/scenarios#${token}`
  document.getElementById('shareUrl').textContent = shareUrl
  document.getElementById('shareSection').style.display = ''

  document.getElementById('copyShareBtn').onclick = () => {
    navigator.clipboard.writeText(shareUrl).catch(() => {})
  }

  // Update hash for bookmarking
  history.replaceState(null, '', `/scenarios#${token}`)
}

function setDeltaCard(prefix, value) {
  const el = document.getElementById(`${prefix}Delta`)
  const barsEl = document.getElementById(`${prefix}Bars`)
  if (value == null) {
    el.textContent = '—'
    barsEl.innerHTML = ''
    return
  }
  // Score points, not a percentage. The value used to be rendered with a "%"
  // suffix and coloured red or green, which read as a modelled physical outcome
  // — "doubling rainfall raises flood risk 19%" — rather than the change in an
  // uncalibrated sensitivity score. The colour is dropped for the same reason: a
  // higher sensitivity score is not by itself a worse outcome.
  const sign = value > 0 ? '+' : ''
  el.textContent = `${sign}${value.toFixed(1)}`
  el.style.color = '#374151'

  // Simple SVG bars: baseline (left) vs scenario (right)
  const baseH = 40
  const scenH = Math.max(4, Math.min(80, baseH + value))
  barsEl.innerHTML = `
    <div>
      <div class="bar" style="height:${baseH}px;background:#93c5fd"></div>
      <div class="bar-label">Base</div>
    </div>
    <div>
      <div class="bar" style="height:${scenH}px;background:${value > 0 ? '#f87171' : '#4ade80'}"></div>
      <div class="bar-label">Scen</div>
    </div>
  `
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// On load — check hash for shared scenario
async function init() {
  await loadAssets()
  const hash = location.hash.slice(1)
  if (hash) {
    try {
      const res = await fetch(`${BASE}/scenarios/${encodeURIComponent(hash)}`)
      const json = await res.json()
      if (res.ok && json.data) {
        // Restore perturbation controls from token, then auto-run
        const p = json.data.perturbation || {}
        if (p.precipitation_multiplier) {
          precipSlider.value = p.precipitation_multiplier
          state.precipitation_multiplier = p.precipitation_multiplier
          precipValue.textContent = `${p.precipitation_multiplier.toFixed(2)}x`
        }
        state.added_hazard_events = p.added_hazard_events || []
        state.added_conflict_events = p.added_conflict_events || []
        updateSummary()
        showResults(json.data, p)
      }
    } catch {
      // Ignore — hash may not be a valid token
    }
  }
}

init()
