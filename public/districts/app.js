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
import { esc, formatTimestamp, formatRelative, num, pct, sevClass } from '/shared/fmt.js'

/**
 * Records a <details> body shows before it admits to withholding the rest.
 *
 * Field reports have always worked this way. Incidents, interventions, tasks,
 * alert events, workflows and community feedback rendered every row, so one
 * district with 42 feedback notes buried the three alert events above it and
 * the officer scrolling to find them stopped reading. Ten is the number the
 * field-report list already uses, for the same reason.
 *
 * The remainder is counted and offered, never dropped: a silent truncation
 * reads as "that is all of them", and this product has been bitten by that
 * class of lie before.
 */
const PAGE = 10

const appEl = () => document.getElementById('app')

/**
 * One status region for the whole surface, declared in the HTML and never
 * replaced.
 *
 * Live regions are announced by observing a node. Clearing and re-creating the
 * node — which is what `app.innerHTML = ''` did to every render — means the
 * thing a screen reader was watching no longer exists by the time it has
 * anything to say.
 */
const statusEl = () => document.getElementById('app-status')

function setStatus(message) {
  const el = statusEl()
  if (el) el.textContent = message
}

/** Drop what the last route rendered, keeping the status region alive. */
function clearApp() {
  const app = appEl()
  if (!app) return
  const keep = statusEl()
  for (const child of [...app.children]) {
    if (child !== keep) child.remove()
  }
}

/**
 * Alert events whose status is exactly "open".
 *
 * Only that one status is counted, because it is the only one this surface can
 * name without inventing a taxonomy. "acknowledged" or "in_progress" are not
 * "open", and folding them in would be a number nobody could trace back to a
 * record.
 *
 * The overview endpoint caps alert events and field reports at 30 before they
 * reach this surface, and `counts.alert_events` is computed from the same
 * capped list — so this is "open among the alert events this surface
 * received" and it agrees with the Alerts figure already on screen. It is not a
 * district-wide total, because the API does not send one.
 */
const openAlerts = (alerts) => alerts.filter((a) => a.status === 'open')

/**
 * The newest hazard by time.
 *
 * `active_hazards` arrives sorted by severity, not by date, so "most recent"
 * needs its own pass. A hazard with no parseable timestamp sorts last rather
 * than poisoning the comparison with NaN.
 */
function mostRecentHazard(hazards) {
  let best = null
  let bestTs = -Infinity
  for (const h of hazards) {
    const ts = Date.parse(h.occurred_at || h.observed_at || h.created_at || '')
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts
      best = h
    }
  }
  return best ? { hazard: best, at: new Date(bestTs) } : null
}

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

function kpiTile(label, value, unit, gap, valueClass = '') {
  return `<div class="kpi-tile">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value ${esc(valueClass)}">${esc(value)}</span>
    <span class="kpi-unit">${esc(unit)}</span>
    ${gap ? '<span class="data-gap">data gap</span>' : ''}
  </div>`
}

/**
 * A <details> section over a record list, showing `page` rows and a footer
 * that states how many the surface received and offers the rest.
 *
 * The expansion announces itself through its own `role="status"` region: the
 * summary already said how many records there are, and the only orientation a
 * keyboard user had was the count changing under them.
 */
function pagedList(parent, label, items, render, { page = PAGE } = {}) {
  const det = document.createElement('details')
  det.className = 'collapsible'

  const summary = document.createElement('summary')
  summary.textContent = `${label} (${items.length})`

  const list = document.createElement('div')
  list.className = 'record-list'

  const note = document.createElement('span')
  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'btn btn-secondary'

  const foot = document.createElement('p')
  foot.className = 'list-footer'
  foot.append(note, more)

  const status = document.createElement('p')
  status.className = 'visually-hidden'
  status.setAttribute('role', 'status')

  const setShown = (n) => {
    const shown = Math.min(n, items.length)
    list.innerHTML = shown ? items.slice(0, shown).map(render).join('') : emptyNote('None.')
    const all = shown === items.length
    note.textContent = items.length
      ? (all ? `Showing all ${items.length}.` : `Showing ${shown} of ${items.length}.`)
      : 'No records.'
    more.hidden = all
    more.textContent = `Show all ${items.length}`
    return shown
  }

  let visible = setShown(Math.min(page, items.length))

  more.addEventListener('click', () => {
    visible = setShown(items.length)
    // Move the keyboard to the last row revealed: a control that expands 30
    // rows and leaves focus parked on itself gives no cue that anything grew.
    list.querySelector('.record-item:last-child > summary')?.focus()
  })

  det.addEventListener('toggle', () => {
    if (det.open) status.textContent = `${label}: showing ${visible} of ${items.length}.`
  })

  const body = document.createElement('div')
  body.className = 'collapsible-body'
  body.append(list, foot, status)

  det.append(summary, body)
  parent.appendChild(det)
  return det
}

/**
 * A coordinate pair that is present, or null.
 *
 * 0 is a coordinate. The equator and the prime meridian both run through this
 * project's districts, and `p.lat && p.lon` dropped every record sitting on
 * either from the officer's map without a word. Absence has to be ruled out
 * explicitly: `Number(null)` and `Number('')` are both 0, so the tidier-looking
 * `Number.isFinite(Number(x))` reinstates the same defect and puts Null Island
 * on the map.
 *
 * Exported so the map can be built and asserted on in a test rather than
 * inferred from its source text.
 */
export function coordinatePair(lat, lon) {
  if (lat === null || lat === undefined || lat === '') return null
  if (lon === null || lon === undefined || lon === '') return null
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null
  return { lat: Number(lat), lon: Number(lon) }
}

/**
 * A record's coordinates and the record itself, in either field naming, or null
 * if it has no usable pair.
 */
const recordPoint = (r) => {
  const pt = coordinatePair(r.latitude ?? r.lat, r.longitude ?? r.lon)
  return pt ? { ...pt, record: r } : null
}

export function buildSvgMap(district, records) {
  const W = 320, H = 200, PAD = 24
  const centre = coordinatePair(district.center.lat, district.center.lon)
  const recordPoints = records.map(recordPoint).filter(Boolean)
  const allPoints = [...(centre ? [centre] : []), ...recordPoints]
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

  const cx = centre ? project(centre.lat, centre.lon) : { x: W / 2, y: H / 2 }
  let dots = ''
  let plotted = 0
  for (const pt of recordPoints) {
    plotted += 1
    const p = project(pt.lat, pt.lon)
    const r = pt.record
    // Allowlisted, so a severity from the API cannot reach the style attribute.
    const col = r.severity ? `var(--sev-${sevClass(r.severity)})` : 'var(--brand)'
    dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${col}" opacity="0.75"/>`
  }

  const label = esc(district.name)
  // `plotted`, not `records.length`: records with no coordinates are skipped
  // above, and a map labelled "42 recorded locations" over 39 dots is the sort
  // of small overstatement that makes a reader distrust the counts beside it.
  // The shortfall is named rather than absorbed, so "how many did the map lose"
  // is answerable from the map itself.
  const noun = plotted === 1 ? 'location' : 'locations'
  const skipped = records.length - plotted
  const shortfall = skipped > 0
    ? `; ${skipped} record${skipped === 1 ? '' : 's'} had no usable coordinates and ${skipped === 1 ? 'is' : 'are'} not shown`
    : ''
  const mapLabel = `Map of ${district.name}: ${plotted} recorded ${noun} plotted${shortfall}, with the district centre marked`
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(mapLabel)}">
    <rect width="${W}" height="${H}" fill="var(--bg)"/>
    <circle cx="${cx.x.toFixed(1)}" cy="${cx.y.toFixed(1)}" r="8" fill="var(--brand)" opacity="0.25"/>
    <circle cx="${cx.x.toFixed(1)}" cy="${cx.y.toFixed(1)}" r="4" fill="var(--brand)"/>
    ${dots}
    <text x="${PAD}" y="${H - 6}" font-size="10" fill="var(--ink-muted)">${label}</text>
  </svg>`
}

/**
 * List-page filter state. Module scope because the toolbar, the cards it
 * hides and the arrival of each card's counts all have to agree on it, and a
 * card's counts land long after its markup was built.
 */
const filters = { query: '', attentionOnly: false, cards: [] }

function applyFilters(total) {
  let shown = 0
  for (const card of filters.cards) {
    const haystack = `${card.dataset.name} ${card.dataset.country}`.toLowerCase()
    const matchesText = !filters.query || haystack.includes(filters.query)
    // Anything the filter cannot prove is quiet stays visible. A district
    // whose counts failed to load is not a district without alerts, and hiding
    // it from an "attention" view hides it for the wrong reason.
    const matchesAttention = !filters.attentionOnly || card.dataset.attention !== 'no'
    const visible = matchesText && matchesAttention
    card.hidden = !visible
    if (visible) shown += 1
  }
  const note = document.getElementById('filter-note')
  if (note) note.textContent = shown === total ? `${total} districts` : `${shown} of ${total} districts`
  const empty = document.getElementById('grid-empty')
  if (empty) empty.hidden = shown > 0
  setStatus(`${shown} of ${total} districts listed.`)
}

/**
 * Name filter plus "open alerts or active hazards only", over data the cards
 * have already fetched.
 *
 * Client-side because `/api/v1/districts` returns nothing but identity — no
 * counts, no hazards — so a server round trip per keystroke would buy nothing
 * the cards do not already hold. Both filters are restored to their defaults on
 * every route, so a stale filter cannot silently hide a district after a
 * navigation.
 */
function filterBar(total) {
  filters.query = ''
  filters.attentionOnly = false
  filters.cards = []

  const bar = document.createElement('div')
  bar.className = 'list-toolbar'
  bar.innerHTML = `
    <div class="filter-field">
      <label for="district-filter">Filter districts</label>
      <input id="district-filter" type="search" autocomplete="off" placeholder="Name or country code">
    </div>
    <label class="filter-check" for="district-attention">
      <input id="district-attention" type="checkbox">
      <span>Open alerts or active hazards only</span>
    </label>
    <span class="list-toolbar-note muted-sm" id="filter-note">${esc(total)} districts</span>
  `

  const search = bar.querySelector('#district-filter')
  search.addEventListener('input', () => {
    filters.query = search.value.trim().toLowerCase()
    applyFilters(total)
  })

  const attention = bar.querySelector('#district-attention')
  attention.addEventListener('change', () => {
    filters.attentionOnly = attention.checked
    applyFilters(total)
  })

  return bar
}

function renderList(districts) {
  const app = appEl()
  clearApp()

  const h = document.createElement('h1')
  h.className = 'page-title'
  h.textContent = 'Districts'
  app.appendChild(h)

  const lede = document.createElement('p')
  lede.className = 'page-lede'
  // The list endpoint carries identity only, so every card makes its own
  // request. Saying so up front is the difference between a page that looks
  // broken for two seconds and one that looks like it is working.
  lede.textContent = `${districts.length} districts. Counts, hazards and the most recent event load per card, so one slow district does not hold up the rest of the list.`
  app.appendChild(lede)

  app.appendChild(filterBar(districts.length))

  const grid = document.createElement('div')
  grid.className = 'district-grid'

  for (const d of districts) {
    const card = document.createElement('a')
    card.className = 'district-card'
    // A real href, so middle-click, "open in new tab" and "copy link address"
    // work. The click handler used to preventDefault unconditionally, which
    // defeated all three on a page whose entire purpose is linking onward.
    card.href = `/districts#/${encodeURIComponent(d.slug)}`
    card.dataset.name = String(d.name || '')
    card.dataset.country = String(d.country || '')
    card.dataset.attention = 'unknown'
    card.innerHTML = `
      <span class="district-card-name">${esc(d.name)}</span>
      <span class="district-card-meta">${esc(d.country)} &middot; ${esc(num(d.radius_km, { int: true }))} km radius</span>
      <span class="district-card-counts" role="status" aria-live="polite" aria-busy="true">Loading counts&hellip;</span>
    `
    grid.appendChild(card)
    filters.cards.push(card)

    // The element is held directly rather than looked up by id. A fetch that
    // lands after the reader has moved to a district overview used to write
    // into whatever element happened to carry that id by then.
    const counts = card.querySelector('.district-card-counts')

    apiFetch(`/api/v1/districts/${encodeURIComponent(d.slug)}`)
      .then(({ data }) => {
        if (!data || !card.isConnected) return
        const c = data.counts || {}
        const alerts = data.alert_events || []
        const hazards = data.active_hazards || []
        const open = openAlerts(alerts).length
        const latest = mostRecentHazard(hazards)
        card.dataset.attention = open > 0 || hazards.length > 0 ? 'yes' : 'no'
        counts.setAttribute('aria-busy', 'false')
        counts.innerHTML = `
          <span class="district-stat-list">
            <span class="district-stat"><strong>${esc(num(open, { int: true }))}</strong> open alert${open === 1 ? '' : 's'}</span>
            <span class="district-stat"><strong>${esc(num(hazards.length, { int: true }))}</strong> active hazard${hazards.length === 1 ? '' : 's'}</span>
            <span class="district-stat"><strong>${esc(num(c.service_assets, { int: true }))}</strong> assets</span>
            <span class="district-stat"><strong>${esc(num(c.incidents, { int: true }))}</strong> incidents</span>
          </span>
          ${latest
            ? `<span class="district-card-latest">Most recent hazard ${sevChip(latest.hazard.severity)}${esc(latest.hazard.event_type || latest.hazard.type || 'unlabelled')} &middot; ${esc(formatRelative(latest.at))}</span>`
            : `<span class="district-card-latest muted-sm">${esc(hazards.length
                ? 'Active hazards carry no timestamp.'
                : 'No active hazards on record.')}</span>`}
        `
        // The filter reads `dataset.attention`, which only exists now.
        applyFilters(districts.length)
      })
      .catch(() => {
        // This used to be `.catch(() => {})`, which left the literal text
        // "Loading counts..." on screen forever after any failure — a spinner
        // that stops spinning and never resolves into either state.
        if (!card.isConnected) return
        counts.setAttribute('aria-busy', 'false')
        counts.textContent = 'Counts unavailable'
        counts.classList.add('data-gap')
        // Left unresolved: the filter cannot honestly call this district
        // quiet, and it will keep showing under the attention filter.
        card.dataset.attention = 'unknown'
        applyFilters(districts.length)
      })
  }

  app.appendChild(grid)

  const empty = document.createElement('p')
  empty.className = 'empty-note'
  empty.id = 'grid-empty'
  empty.hidden = true
  empty.textContent = 'No district matches that filter.'
  app.appendChild(empty)

  applyFilters(districts.length)
}

function renderOverview(overview) {
  const app = appEl()
  clearApp()

  const d = overview.district
  const c = overview.counts
  const alerts = overview.alert_events || []
  const hazards = overview.active_hazards || []
  const latest = mostRecentHazard(hazards)
  const openCount = openAlerts(alerts).length

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

  // --- At a glance ----------------------------------------------
  // The ribbon answers "how much of everything"; this answers "what needs me
  // today", which is the only question the officer opening this page has. It
  // reuses the KPI tile treatment rather than inventing a sixth set of boxes.
  const glanceSection = document.createElement('section')
  glanceSection.className = 'section'
  glanceSection.innerHTML = '<h2 class="section-title">At a glance</h2>'

  const glanceRow = document.createElement('div')
  glanceRow.className = 'kpi-row'
  glanceRow.innerHTML = [
    kpiTile('Open alerts', num(openCount, { int: true }), `of ${num(alerts.length, { int: true })} alert events`),
    kpiTile('Active hazards', num(hazards.length, { int: true }), 'hazard events in radius'),
    // The age, not the date: "2 days ago" is the answer to "is this still
    // news". The absolute date sits underneath for anyone filing a report.
    latest
      ? kpiTile(
          'Most recent hazard',
          formatRelative(latest.at),
          `${latest.hazard.event_type || latest.hazard.type || 'unlabelled'} · ${sevClass(latest.hazard.severity)} · ${formatTimestamp(latest.at, { style: 'date' })}`,
          false,
          'kpi-value-text',
        )
      : kpiTile(
          'Most recent hazard',
          '—',
          hazards.length ? 'active hazards carry no timestamp' : 'no active hazards on record',
        ),
    kpiTile('Incidents', num(c.incidents, { int: true }), 'recorded in radius'),
  ].join('')
  glanceSection.appendChild(glanceRow)
  app.appendChild(glanceSection)

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

  pagedList(opsSection, 'Incidents', overview.incidents, (r) => recordItem(r.title || r.id, sevChip(r.severity), r))
  pagedList(opsSection, 'Interventions', overview.interventions, (r) => recordItem(r.title || r.id, stateChip(r.status), r))
  pagedList(opsSection, 'Tasks', overview.intervention_tasks, (t) => recordItem(t.title || t.id, stateChip(t.status), t))

  // Field reports kept their 10-record cap; what changed is that the cap now
  // says so and offers the remainder, like every other list on this page.
  pagedList(opsSection, 'Field Reports', overview.field_reports, (r) => {
    const demo = r.demographics
    const demoStr = demo ? ` · ${demo.gender || ''} ${demo.age_band || ''}` : ''
    const reporter = r.reported_by ? `<span class="chip chip-neutral">${esc(r.reported_by)}</span>` : ''
    return recordItem(String(r.summary || r.id).slice(0, 80) + demoStr, reporter, r)
  })
  app.appendChild(opsSection)

  // --- Signal and response --------------------------------------
  const sigSection = document.createElement('section')
  sigSection.className = 'section'
  sigSection.innerHTML = '<h2 class="section-title">Signal and Response</h2>'

  pagedList(sigSection, 'Alert Events', alerts, (a) => {
    const wfBadge = a.workflow_id ? '<span class="chip chip-neutral">wf</span>' : ''
    return recordItem(a.message || a.rule_name || a.id, `${sevChip(a.severity)} ${stateChip(a.status)} ${wfBadge}`, a)
  })
  pagedList(sigSection, 'Workflows', overview.workflow_instances, (w) => recordItem(w.type || w.id, stateChip(w.state), w))
  // 42 feedback notes was the list that started this: it is the longest on a
  // quiet district and pushed every alert above it off the screen.
  pagedList(sigSection, 'Community Feedback', overview.community_feedback, (f) =>
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
  clearApp()
  app.setAttribute('aria-busy', 'false')
  const panel = document.createElement('div')
  panel.className = 'error-panel'
  // role="alert": this replaces a page the reader was waiting on, and an
  // error that only announces itself politely is an error they navigate away
  // from while it is still talking.
  panel.setAttribute('role', 'alert')
  panel.innerHTML = `<strong>${esc(message)}</strong>
    <p>The district data could not be loaded. Check the connection and try again.</p>`
  app.appendChild(panel)
}

function loadingNote(app, text) {
  clearApp()
  app.setAttribute('aria-busy', 'true')
  const note = document.createElement('div')
  note.className = 'loading-note'
  note.textContent = text
  app.appendChild(note)
  setStatus('Loading.')
}

async function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
  const app = appEl()
  if (!app) return

  if (!hash) {
    loadingNote(app, 'Loading districts…')
    try {
      const { data } = await apiFetch('/api/v1/districts')
      app.setAttribute('aria-busy', 'false')
      renderList(data || [])
      setStatus(`${(data || []).length} districts loaded.`)
    } catch {
      showError(app, 'Could not load districts.')
    }
    return
  }

  loadingNote(app, 'Loading…')
  try {
    const { data } = await apiFetch(`/api/v1/districts/${encodeURIComponent(hash)}`)
    app.setAttribute('aria-busy', 'false')
    if (!data) {
      showError(app, 'District not found.')
      return
    }
    renderOverview(data)
    // The card counts on the list page announce themselves; the overview has
    // no such per-region chatter, so its load is announced once, here.
    setStatus(`${data.district.name} overview loaded.`)
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