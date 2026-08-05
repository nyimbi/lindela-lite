// Districts surface — hash-based router
// #         -> list of districts
// #/<slug>  -> district overview

function sevChip(sev) {
  const s = (sev || 'unknown').toLowerCase()
  return `<span class="chip chip-${s}">${s}</span>`
}

function stateChip(state) {
  return `<span class="chip chip-neutral">${state || '—'}</span>`
}

function sentimentChip(s) {
  const map = { positive: 'ok', negative: 'critical', unclear: 'neutral' }
  const cls = map[s] || 'neutral'
  return `<span class="chip chip-${cls}">${s || '—'}</span>`
}

function fmt(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return v % 1 === 0 ? String(v) : v.toFixed(1)
  return String(v)
}

function recordDetails(r) {
  const skip = new Set(['id'])
  return Object.entries(r)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n')
}

function recordItem(title, chipHtml, r) {
  return `<details class="record-item">
    <summary>
      <span class="record-item-title">${title}</span>
      ${chipHtml}
    </summary>
    <pre class="record-full">${recordDetails(r)}</pre>
  </details>`
}

function kpiTile(label, value, unit) {
  return `<div class="kpi-tile">
    <span class="kpi-label">${label}</span>
    <span class="kpi-value">${fmt(value)}</span>
    <span class="kpi-unit">${unit}</span>
  </div>`
}

function buildSvgMap(district, records) {
  const W = 320, H = 200, PAD = 24
  const allPoints = [
    { lat: district.center.lat, lon: district.center.lon },
    ...records.map(r => ({ lat: r.latitude ?? r.lat, lon: r.longitude ?? r.lon })).filter(p => p.lat && p.lon),
  ]
  const lats = allPoints.map(p => p.lat)
  const lons = allPoints.map(p => p.lon)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const dLat = maxLat - minLat || 1
  const dLon = maxLon - minLon || 1

  function project(lat, lon) {
    const x = PAD + ((lon - minLon) / dLon) * (W - PAD * 2)
    const y = H - PAD - ((lat - minLat) / dLat) * (H - PAD * 2)
    return { x, y }
  }

  const cx = project(district.center.lat, district.center.lon)
  let dots = ''
  for (const r of records) {
    const lat = r.latitude ?? r.lat
    const lon = r.longitude ?? r.lon
    if (!lat || !lon) continue
    const p = project(lat, lon)
    const col = r.severity ? `var(--sev-${r.severity}, var(--brand))` : 'var(--brand)'
    dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${col}" opacity="0.75"/>`
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="var(--bg)"/>
    <circle cx="${cx.x.toFixed(1)}" cy="${cx.y.toFixed(1)}" r="8" fill="var(--brand)" opacity="0.25"/>
    <circle cx="${cx.x.toFixed(1)}" cy="${cx.y.toFixed(1)}" r="4" fill="var(--brand)"/>
    ${dots}
    <text x="${PAD}" y="${H - 6}" font-size="10" fill="var(--ink-muted)">${district.name}</text>
  </svg>`
}

function renderList(districts) {
  const app = document.getElementById('app')
  const loading = document.getElementById('loading-msg')
  if (loading) loading.remove()

  const h = document.createElement('h1')
  h.style.cssText = 'font-size:1.3rem;font-weight:700;margin-bottom:0.5rem'
  h.textContent = 'Districts'
  app.appendChild(h)

  const grid = document.createElement('div')
  grid.className = 'district-grid'

  for (const d of districts) {
    const card = document.createElement('a')
    card.className = 'district-card'
    card.href = `/districts#/${d.slug}`
    card.innerHTML = `
      <span class="district-card-name">${d.name}</span>
      <span class="district-card-meta">${d.country} &middot; ${d.radius_km} km radius</span>
      <span class="district-card-counts" id="counts-${d.slug}">Loading counts...</span>
    `
    card.addEventListener('click', (e) => {
      e.preventDefault()
      location.hash = `/${d.slug}`
    })
    grid.appendChild(card)

    fetch(`/api/v1/districts/${d.slug}`)
      .then(r => r.json())
      .then(({ data }) => {
        const el = document.getElementById(`counts-${d.slug}`)
        if (!el || !data) return
        const c = data.counts
        el.textContent = `Assets ${c.service_assets} · Incidents ${c.incidents} · Alerts ${c.alert_events}`
      })
      .catch(() => {})
  }

  app.appendChild(grid)
}

function renderOverview(overview) {
  const app = document.getElementById('app')
  app.innerHTML = ''

  const d = overview.district
  const c = overview.counts

  // Back link
  const back = document.createElement('a')
  back.className = 'back-link'
  back.href = '/districts'
  back.innerHTML = '&#8592; All districts'
  back.addEventListener('click', (e) => { e.preventDefault(); location.hash = '' })
  app.appendChild(back)

  // Header ribbon
  const ribbon = document.createElement('div')
  ribbon.className = 'ribbon'
  ribbon.innerHTML = `
    <div class="ribbon-title">
      ${d.name}
      <span style="font-size:0.85rem;font-weight:400;color:var(--ink-muted)">${d.country}</span>
    </div>
    <div class="ribbon-subtitle">${d.radius_km} km radius &middot; ${d.center.lat.toFixed(4)}, ${d.center.lon.toFixed(4)}</div>
    <div class="counts-strip">
      <span>Assets <strong>${c.service_assets}</strong></span>
      <span>Incidents <strong>${c.incidents}</strong></span>
      <span>Interventions <strong>${c.interventions}</strong></span>
      <span>Tasks <strong>${c.tasks}</strong></span>
      <span>Field reports <strong>${c.field_reports}</strong></span>
      <span>Alerts <strong>${c.alert_events}</strong></span>
      <span>Workflows <strong>${c.workflow_instances}</strong></span>
    </div>
  `
  app.appendChild(ribbon)

  // Situation
  const sitSection = document.createElement('div')
  sitSection.className = 'section'
  sitSection.innerHTML = '<div class="section-title">Situation</div>'

  const sitRow = document.createElement('div')
  sitRow.className = 'situation-row'

  // SVG map
  const mapRecords = [...overview.active_hazards, ...overview.risk_scores, ...overview.service_assets]
  const mapWrap = document.createElement('div')
  mapWrap.className = 'map-inset'
  mapWrap.innerHTML = buildSvgMap(d, mapRecords)
  sitRow.appendChild(mapWrap)

  // Hazard table
  const hazardWrap = document.createElement('div')
  hazardWrap.className = 'situation-table'
  const top10 = overview.active_hazards.slice(0, 10)
  if (top10.length) {
    hazardWrap.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Hazard</th><th>Severity</th><th>Date</th></tr></thead>
          <tbody>${top10.map(h => `<tr>
            <td>${h.event_type || h.type || '—'}</td>
            <td>${sevChip(h.severity)}</td>
            <td style="font-size:0.75rem;color:var(--ink-muted)">${(h.observed_at || h.created_at || '').slice(0, 10)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
  } else {
    hazardWrap.innerHTML = '<p style="color:var(--ink-muted);font-size:0.83rem">No active hazards.</p>'
  }
  sitRow.appendChild(hazardWrap)
  sitSection.appendChild(sitRow)
  app.appendChild(sitSection)

  // Operations
  const opsSection = document.createElement('div')
  opsSection.className = 'section'
  opsSection.innerHTML = '<div class="section-title">Operations</div>'

  // Incidents
  const incDet = document.createElement('details')
  incDet.className = 'collapsible'
  incDet.innerHTML = `<summary>Incidents (${overview.incidents.length})</summary>
    <div class="collapsible-body">${overview.incidents.length
      ? overview.incidents.map(r => recordItem(r.title || r.id, sevChip(r.severity), r)).join('')
      : '<p style="color:var(--ink-muted);font-size:0.83rem">None.</p>'
    }</div>`
  opsSection.appendChild(incDet)

  // Interventions
  const intDet = document.createElement('details')
  intDet.className = 'collapsible'
  intDet.innerHTML = `<summary>Interventions (${overview.interventions.length})</summary>
    <div class="collapsible-body">${overview.interventions.length
      ? overview.interventions.map(r => recordItem(r.title || r.id, stateChip(r.status), r)).join('')
      : '<p style="color:var(--ink-muted);font-size:0.83rem">None.</p>'
    }</div>`
  opsSection.appendChild(intDet)

  // Tasks
  const taskGroups = {}
  for (const t of overview.intervention_tasks) {
    const key = t.intervention_id || 'unlinked'
    if (!taskGroups[key]) taskGroups[key] = []
    taskGroups[key].push(t)
  }
  const taskDet = document.createElement('details')
  taskDet.className = 'collapsible'
  taskDet.innerHTML = `<summary>Tasks (${overview.intervention_tasks.length})</summary>
    <div class="collapsible-body">${overview.intervention_tasks.length
      ? overview.intervention_tasks.map(t => recordItem(t.title || t.id, stateChip(t.status), t)).join('')
      : '<p style="color:var(--ink-muted);font-size:0.83rem">None.</p>'
    }</div>`
  opsSection.appendChild(taskDet)

  // Field reports (last 10)
  const frDet = document.createElement('details')
  frDet.className = 'collapsible'
  const recentFr = overview.field_reports.slice(0, 10)
  frDet.innerHTML = `<summary>Field Reports (last 10 of ${overview.field_reports.length})</summary>
    <div class="collapsible-body">${recentFr.length
      ? recentFr.map(r => {
          const demo = r.demographics
          const demoStr = demo ? ` · ${demo.gender || ''} ${demo.age_band || ''}` : ''
          const reporter = r.reported_by ? `<span class="chip chip-neutral">${r.reported_by}</span>` : ''
          return recordItem((r.summary || r.id).slice(0, 80) + demoStr, reporter, r)
        }).join('')
      : '<p style="color:var(--ink-muted);font-size:0.83rem">None.</p>'
    }</div>`
  opsSection.appendChild(frDet)
  app.appendChild(opsSection)

  // Signal and response
  const sigSection = document.createElement('div')
  sigSection.className = 'section'
  sigSection.innerHTML = '<div class="section-title">Signal and Response</div>'

  // Alert events
  const alertDet = document.createElement('details')
  alertDet.className = 'collapsible'
  alertDet.innerHTML = `<summary>Alert Events (${overview.alert_events.length})</summary>
    <div class="collapsible-body">${overview.alert_events.length
      ? overview.alert_events.map(a => {
          const wfBadge = a.workflow_id ? `<span class="chip chip-neutral">wf</span>` : ''
          return recordItem(a.message || a.rule_name || a.id, `${sevChip(a.severity)} ${stateChip(a.status)} ${wfBadge}`, a)
        }).join('')
      : '<p style="color:var(--ink-muted);font-size:0.83rem">None.</p>'
    }</div>`
  sigSection.appendChild(alertDet)

  // Workflow instances
  const wfDet = document.createElement('details')
  wfDet.className = 'collapsible'
  wfDet.innerHTML = `<summary>Workflows (${overview.workflow_instances.length})</summary>
    <div class="collapsible-body">${overview.workflow_instances.length
      ? overview.workflow_instances.map(w => recordItem(w.type || w.id, stateChip(w.state), w)).join('')
      : '<p style="color:var(--ink-muted);font-size:0.83rem">None.</p>'
    }</div>`
  sigSection.appendChild(wfDet)

  // Community feedback
  const fbDet = document.createElement('details')
  fbDet.className = 'collapsible'
  fbDet.innerHTML = `<summary>Community Feedback (${overview.community_feedback.length})</summary>
    <div class="collapsible-body">${overview.community_feedback.length
      ? overview.community_feedback.map(f => recordItem((f.message || f.id).slice(0, 70), sentimentChip(f.sentiment), f)).join('')
      : '<p style="color:var(--ink-muted);font-size:0.83rem">None.</p>'
    }</div>`
  sigSection.appendChild(fbDet)

  // KPI snapshot tiles
  const kpi = overview.kpi_snapshot
  const kpiRow = document.createElement('div')
  kpiRow.className = 'kpi-row'
  kpiRow.innerHTML = [
    kpiTile('People reached', kpi.people_reached, 'people'),
    kpiTile('Warning-to-action', kpi.warning_to_action_median_hours, 'hours median'),
    kpiTile('False alert rate', kpi.false_alert_rate !== null ? kpi.false_alert_rate?.toFixed(1) : null, '%'),
    kpiTile('Cold-chain rate', kpi.cold_chain_protection_rate !== null ? kpi.cold_chain_protection_rate?.toFixed(1) : null, '%'),
  ].join('')
  sigSection.appendChild(kpiRow)
  app.appendChild(sigSection)
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '')
  const app = document.getElementById('app')

  if (!hash) {
    const loading = document.getElementById('loading-msg')
    if (loading) loading.textContent = 'Loading districts...'
    try {
      const res = await fetch('/api/v1/districts')
      const { data } = await res.json()
      renderList(data || [])
    } catch (e) {
      if (app) app.innerHTML = '<p style="color:var(--ink-muted);padding:2rem">Failed to load districts.</p>'
    }
    return
  }

  if (app) app.innerHTML = '<div id="loading-msg" style="padding:2rem;color:var(--ink-muted)">Loading...</div>'
  try {
    const res = await fetch(`/api/v1/districts/${hash}`)
    if (!res.ok) {
      app.innerHTML = `<p style="padding:2rem;color:var(--ink-muted)">District not found: ${hash}</p>`
      return
    }
    const { data } = await res.json()
    renderOverview(data)
  } catch (e) {
    if (app) app.innerHTML = '<p style="color:var(--ink-muted);padding:2rem">Failed to load district.</p>'
  }
}

window.addEventListener('hashchange', route)

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', route)
} else {
  route()
}
