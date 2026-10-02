// Districts surface — hash-based router
// #         -> list of districts
// #/<slug>  -> district overview
//
// This file had no escaping function at all. Every render path was innerHTML
// with interpolated data: district names from the API, hazard types, incident
// titles, reporter names, community feedback messages. `sevChip` went further
// and interpolated the severity straight into a class attribute, unquoted, so a
// severity containing a quote injected markup. The not-found branch interpolated
// the URL hash. The console, by contrast, had 55 uses of one escapeHtml — the
// discipline existed, in one file.

import { apiFetch } from '/shared/runtime.js'
import { esc, formatTimestamp, num, pct, sevClass } from '/shared/fmt.js'

function sevChip(sev) {
  const s = sevClass(sev)
  return `<span class="chip chip-${s}">${esc(s)}</span>`
}

function stateChip(state) {
  return `<span class="chip chip-neutral">${esc(state || '—')}</span>`
}

function sentimentChip(sentiment) {
  const map = { positive: 'ok', negative: 'critical', unclear: 'neutral' }
  const cls = map[sentiment] || 'neutral'
  return `<span class="chip chip-${cls}">${esc(sentiment || '—')}</span>`
}

function recordDetails(r) {
  const skip = new Set(['id'])
  return Object.entries(r)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`)
    .join('\n')
}

function recordItem(title, chipHtml, r) {
  return `<details class="record-item">
    <summary>
      <span class="record-item-title">${esc(title)}</span>
      ${chipHtml}
    </summary>
    <pre class="record-full">${recordDetails(r)}</pre>
  </details>`
}

const emptyNote = (what) => `<p class="empty-note">${esc(what)}</p>`

function kpiTile(label, value, unit, gap) {
  return `<div class="kpi-tile">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value">${esc(value)}</span>
    <span class="kpi-unit">${esc(unit)}</span>
    ${gap ? '<span class="data-gap">data gap</span>' : ''}
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
    // Allowlisted, so a severity from the API cannot reach the style attribute.
    const col = r.severity ? `var(--sev-${sevClass(r.severity)})` : 'var(--brand)'
    dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${col}" opacity="0.75"/>`
  }

  const label = esc(district.name)
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Recorded locations in ${label}">
    <rect width="${W}" height="${H}" fill="var(--bg)"/>
    <circle cx="${cx.x.toFixed(1)}" cy="${cx.y.toFixed(1)}" r="8" fill="var(--brand)" opacity="0.25"/>
    <circle cx="${cx.x.toFixed(1)}" cy="${cx.y.toFixed(1)}" r="4" fill="var(--brand)"/>
    ${dots}
    <text x="${PAD}" y="${H - 6}" font-size="10" fill="var(--ink-muted)">${label}</text>
  </svg>`
}

function renderList(districts) {
  const app = document.getElementById('app')
  const loading = document.getElementById('loading-msg')
  if (loading) loading.remove()

  const h = document.createElement('h1')
  h.className = 'page-title'
  h.textContent = 'Districts'
  app.appendChild(h)

  const grid = document.createElement('div')
  grid.className = 'district-grid'

  for (const d of districts) {
    const card = document.createElement('a')
    card.className = 'district-card'
    // A real href, so middle-click, "open in new tab" and "copy link address"
    // work. The click handler used to preventDefault unconditionally, which
    // defeated all three on a page whose entire purpose is linking onward.
    card.href = `/districts#/${encodeURIComponent(d.slug)}`
    card.innerHTML = `
      <span class="district-card-name">${esc(d.name)}</span>
      <span class="district-card-meta">${esc(d.country)} &middot; ${esc(num(d.radius_km, { int: true }))} km radius</span>
      <span class="district-card-counts" id="counts-${esc(d.slug)}" aria-live="polite">Loading counts&hellip;</span>
    `
    grid.appendChild(card)

    apiFetch(`/api/v1/districts/${encodeURIComponent(d.slug)}`)
      .then(({ data }) => {
        const el = document.getElementById(`counts-${d.slug}`)
        if (!el || !data) return
        const c = data.counts
        el.textContent = `Assets ${num(c.service_assets, { int: true })} · Incidents ${num(c.incidents, { int: true })} · Alerts ${num(c.alert_events, { int: true })}`
      })
      .catch(() => {
        // This used to be `.catch(() => {})`, which left the literal text
        // "Loading counts..." on screen forever after any failure — a spinner
        // that stops spinning and never resolves into either state.
        const el = document.getElementById(`counts-${d.slug}`)
        if (el) {
          el.textContent = 'Counts unavailable'
          el.classList.add('data-gap')
        }
      })
  }

  app.appendChild(grid)
}

function renderOverview(overview) {
  const app = document.getElementById('app')
  app.innerHTML = ''

  const d = overview.district
  const c = overview.counts

  const back = document.createElement('a')
  back.className = 'back-link'
  back.href = '/districts'
  back.textContent = '← All districts'
  app.appendChild(back)

  const ribbon = document.createElement('div')
  ribbon.className = 'ribbon'
  ribbon.innerHTML = `
    <div class="ribbon-title">
      ${esc(d.name)}
      <span class="ribbon-sub-name">${esc(d.country)}</span>
    </div>
    <div class="ribbon-subtitle">${esc(num(d.radius_km, { int: true }))} km radius &middot; ${esc(Number(d.center.lat).toFixed(4))}, ${esc(Number(d.center.lon).toFixed(4))}</div>
    <div class="counts-strip">
      <span>Assets <strong>${num(c.service_assets, { int: true })}</strong></span>
      <span>Incidents <strong>${num(c.incidents, { int: true })}</strong></span>
      <span>Interventions <strong>${num(c.interventions, { int: true })}</strong></span>
      <span>Tasks <strong>${num(c.tasks, { int: true })}</strong></span>
      <span>Field reports <strong>${num(c.field_reports, { int: true })}</strong></span>
      <span>Alerts <strong>${num(c.alert_events, { int: true })}</strong></span>
      <span>Workflows <strong>${num(c.workflow_instances, { int: true })}</strong></span>
    </div>
  `
  app.appendChild(ribbon)

  // --- Situation ------------------------------------------------
  const sitSection = document.createElement('section')
  sitSection.className = 'section'
  sitSection.innerHTML = '<h2 class="section-title">Situation</h2>'

  const sitRow = document.createElement('div')
  sitRow.className = 'situation-row'

  const mapRecords = [...overview.active_hazards, ...overview.risk_scores, ...overview.service_assets]
  const mapWrap = document.createElement('div')
  mapWrap.className = 'map-inset'
  mapWrap.innerHTML = buildSvgMap(d, mapRecords)
  sitRow.appendChild(mapWrap)

  const hazardWrap = document.createElement('div')
  hazardWrap.className = 'situation-table'
  const top10 = overview.active_hazards.slice(0, 10)
  if (top10.length) {
    hazardWrap.innerHTML = `
      <div class="table-wrap">
        <table>
          <caption class="visually-hidden">Most recent active hazards in ${esc(d.name)}</caption>
          <thead><tr>
            <th scope="col">Hazard</th>
            <th scope="col">Severity</th>
            <th scope="col">Date</th>
          </tr></thead>
          <tbody>${top10.map(h => `<tr>
            <td>${esc(h.event_type || h.type || '—')}</td>
            <td>${sevChip(h.severity)}</td>
            <td class="muted-sm nowrap">${esc(formatTimestamp(h.occurred_at || h.observed_at || h.created_at, { style: 'date' }))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
  } else {
    hazardWrap.innerHTML = emptyNote('No active hazards.')
  }
  sitRow.appendChild(hazardWrap)
  sitSection.appendChild(sitRow)
  app.appendChild(sitSection)

  // --- Operations ----------------------------------------------
  const opsSection = document.createElement('section')
  opsSection.className = 'section'
  opsSection.innerHTML = '<h2 class="section-title">Operations</h2>'

  const collapsible = (label, items, render) => {
    const det = document.createElement('details')
    det.className = 'collapsible'
    det.innerHTML = `<summary>${esc(label)} (${items.length})</summary>
      <div class="collapsible-body">${items.length ? items.map(render).join('') : emptyNote('None.')}</div>`
    opsSection.appendChild(det)
    return det
  }

  collapsible('Incidents', overview.incidents, (r) => recordItem(r.title || r.id, sevChip(r.severity), r))
  collapsible('Interventions', overview.interventions, (r) => recordItem(r.title || r.id, stateChip(r.status), r))
  collapsible('Tasks', overview.intervention_tasks, (t) => recordItem(t.title || t.id, stateChip(t.status), t))

  // Field reports (last 10)
  const recentFr = overview.field_reports.slice(0, 10)
  const frDet = document.createElement('details')
  frDet.className = 'collapsible'
  frDet.innerHTML = `<summary>Field Reports (last 10 of ${overview.field_reports.length})</summary>
    <div class="collapsible-body">${recentFr.length
      ? recentFr.map(r => {
          const demo = r.demographics
          const demoStr = demo ? ` · ${demo.gender || ''} ${demo.age_band || ''}` : ''
          const reporter = r.reported_by ? `<span class="chip chip-neutral">${esc(r.reported_by)}</span>` : ''
          return recordItem(String(r.summary || r.id).slice(0, 80) + demoStr, reporter, r)
        }).join('')
      : emptyNote('None.')
    }</div>`
  opsSection.appendChild(frDet)
  app.appendChild(opsSection)

  // --- Signal and response --------------------------------------
  const sigSection = document.createElement('section')
  sigSection.className = 'section'
  sigSection.innerHTML = '<h2 class="section-title">Signal and Response</h2>'

  const sigCollapsible = (label, items, render) => {
    const det = document.createElement('details')
    det.className = 'collapsible'
    det.innerHTML = `<summary>${esc(label)} (${items.length})</summary>
      <div class="collapsible-body">${items.length ? items.map(render).join('') : emptyNote('None.')}</div>`
    sigSection.appendChild(det)
  }

  sigCollapsible('Alert Events', overview.alert_events, (a) => {
    const wfBadge = a.workflow_id ? '<span class="chip chip-neutral">wf</span>' : ''
    return recordItem(a.message || a.rule_name || a.id, `${sevChip(a.severity)} ${stateChip(a.status)} ${wfBadge}`, a)
  })
  sigCollapsible('Workflows', overview.workflow_instances, (w) => recordItem(w.type || w.id, stateChip(w.state), w))
  sigCollapsible('Community Feedback', overview.community_feedback, (f) =>
    recordItem(String(f.message || f.id).slice(0, 70), sentimentChip(f.sentiment), f))

  // --- KPI snapshot ---------------------------------------------
  const kpi = overview.kpi_snapshot
  const kpiRow = document.createElement('div')
  kpiRow.className = 'kpi-row'
  // A KPI with no data shows its reason rather than a bare em dash, so a reader
  // can tell "nothing happened" from "we did not measure it".
  kpiRow.innerHTML = [
    kpiTile('People reached', num(kpi.people_reached, { int: true }), 'people'),
    kpiTile('Warning to action', num(kpi.warning_to_action_median_hours, { dp: 2 }), 'hours median'),
    kpiTile('False alert rate', pct(kpi.false_alert_rate), '', kpi.false_alert_rate === null || kpi.false_alert_rate === undefined),
    kpiTile('Cold-chain rate', pct(kpi.cold_chain_protection_rate), '', kpi.cold_chain_protection_rate === null || kpi.cold_chain_protection_rate === undefined),
  ].join('')
  sigSection.appendChild(kpiRow)
  app.appendChild(sigSection)
}

function showError(app, message) {
  app.innerHTML = `<div class="error-panel" role="alert">
    <strong>${esc(message)}</strong>
    <p>The district data could not be loaded. Check the connection and try again.</p>
  </div>`
}

async function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
  const app = document.getElementById('app')
  if (!app) return

  if (!hash) {
    app.innerHTML = '<div id="loading-msg" class="loading-note">Loading districts…</div>'
    try {
      const { data } = await apiFetch('/api/v1/districts')
      renderList(data || [])
    } catch {
      showError(app, 'Could not load districts.')
    }
    return
  }

  app.innerHTML = '<div class="loading-note">Loading…</div>'
  try {
    const { data } = await apiFetch(`/api/v1/districts/${encodeURIComponent(hash)}`)
    if (!data) {
      showError(app, 'District not found.')
      return
    }
    renderOverview(data)
  } catch (err) {
    // `hash` came from the URL and used to be interpolated into innerHTML
    // unescaped, so the not-found branch reflected whatever the address bar
    // held. It is escaped now, and the detail is not echoed back at all.
    showError(app, err.status === 404 ? 'District not found.' : 'Could not load this district.')
  }
}

window.addEventListener('hashchange', route)

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', route)
} else {
  route()
}