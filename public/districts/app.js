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

import { apiFetch, autoMarkScrollableRegions, initI18n } from '/shared/runtime.js'
import { esc, formatTimestamp, formatRelative, num, pct, sevClass } from '/shared/fmt.js'
import {
  districtsShareUrl, encodeDistrictsView, isDistrictsViewCustom, resolveDistrictsView,
} from '/shared/districts-view.js'

/**
 * A string in the language the reader selected, or in English.
 *
 * The fallback argument is not decoration. A key no catalogue carries resolves,
 * under the shared runtime, to the key itself — so an untranslated surface shows
 * `districts.count_assets` where a heading belongs, which is the failure this
 * layer exists to make impossible. English is a complete rendering of this
 * surface, so it is always available even when a locale is not.
 */
function t(key, fallback = key) {
  const catalog = window.__i18n?.catalog
  return (catalog && catalog[key]) || fallback
}

/**
 * `{name}` interpolation for the sentences, which cannot be concatenated.
 *
 * An unknown placeholder is left as written rather than blanked: a translator
 * who mistypes a key should see `{perod}` in the running interface, not a
 * sentence with a hole in it.
 */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`))
}

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

/**
 * The languages this page offers, and the only ones `currentLocale` will
 * honour. Kept beside the `<select>` it mirrors rather than read out of the
 * DOM, so a locale cannot be offered without the code that accepts it.
 *
 * English alone, and that is a measurement rather than modesty: `scripts/check-i18n.mjs`
 * fails any surface whose picker offers a language that cannot render every
 * string the page names, and no other catalogue carries a `districts.*` key yet.
 * Adding Swahili here is correct the day sw.json carries this namespace, and
 * wrong the day before — which is the failure the gate was written after.
 */
const OFFERED_LOCALES = ['en']

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
    ${gap ? `<span class="data-gap">${esc(t('districts.data_gap', 'data gap'))}</span>` : ''}
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
    list.innerHTML = shown ? items.slice(0, shown).map(render).join('') : emptyNote(t('districts.none', 'None.'))
    const all = shown === items.length
    note.textContent = items.length
      ? (all
        ? fill(t('districts.showing_all', 'Showing all {n}.'), { n: String(items.length) })
        : fill(t('districts.showing_some', 'Showing {shown} of {n}.'), { shown: String(shown), n: String(items.length) }))
      : t('districts.no_records', 'No records.')
    more.hidden = all
    more.textContent = fill(t('districts.show_all', 'Show all {n}'), { n: String(items.length) })
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
    if (det.open) status.textContent = fill(t('districts.expanded_status', '{label}: showing {shown} of {n}.'),
      { label, shown: String(visible), n: String(items.length) })
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
  const noun = plotted === 1
    ? t('districts.location', 'location')
    : t('districts.locations', 'locations')
  const skipped = records.length - plotted
  const shortfall = skipped > 0
    ? '; ' + (skipped === 1
      ? fill(t('districts.unplaced_one', '{n} record had no usable coordinates and is not shown'), { n: String(skipped) })
      : fill(t('districts.unplaced_many', '{n} records had no usable coordinates and are not shown'), { n: String(skipped) }))
    : ''
  const mapLabel = fill(
    t('districts.map_label', 'Map of {name}: {n} recorded {noun} plotted{shortfall}, with the district centre marked'),
    { name: district.name, n: String(plotted), noun, shortfall },
  )
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

/**
 * The state a districts link carries.
 *
 * Read from the controls, not from the address bar, for the reason the console
 * gives: a second copy of the view is a second thing that can be wrong, and a
 * link that disagrees with the screen beside it is worse than no link. Reading
 * the URL instead would be circular here — the URL is written *from* this view,
 * so a filter typed but not yet stamped would be lost the moment it was encoded.
 * The one field not held in a control is the district, and that one is read from
 * the hash because the hash is the route: a card's `href` already worked and it
 * has to keep working.
 */
function currentView() {
  const { selected } = resolveDistrictsView({ hash: location.hash })
  return { query: filters.query, attentionOnly: filters.attentionOnly, selected }
}

/**
 * The `/districts/` query string for the current filters, or '' for none.
 *
 * `selected` is excluded deliberately: the district rides in the fragment, and
 * a link back to the list must not leave one selected. The version parameter
 * alone is not a view either, so a cleared filter yields '' rather than a
 * `?v=v1` that says only "this URL was written by a build that understood it".
 */
function filtersQuery() {
  const view = { ...currentView(), selected: '' }
  return isDistrictsViewCustom(view) ? encodeDistrictsView(view) : ''
}

/** The href for a district card, filters included. */
function districtHref(slug) {
  const query = filtersQuery()
  return `/districts${query ? `?${query}` : ''}#/${encodeURIComponent(slug || '')}`
}

/** The list href, filters included — the back link's target. */
function listHref() {
  const query = filtersQuery()
  return `/districts${query ? `?${query}` : ''}`
}

/**
 * Write the current view back to the URL, and every href that is a claim about
 * it.
 *
 * The cards are re-stamped here as well as in the address bar, because a card
 * `href` computed once at render is a claim about a view that no longer exists:
 * the operator filters to three districts, opens one, and finds "back" — and
 * every card — offering the list they no longer had.
 *
 * replaceState, not pushState, for the reason the console uses: a keystroke in
 * the filter should not bury the back button under forty identical list states,
 * and the card counts landing asynchronously must never add one either.
 */
function syncViewToUrl() {
  const query = filtersQuery()
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
  for (const card of filters.cards) {
    if (card.dataset.slug) card.href = districtHref(card.dataset.slug)
  }
  const back = document.querySelector('.back-link')
  if (back) back.href = listHref()
  updateShareControl()
}

/**
 * The copy control, shown only when the view differs from the default.
 *
 * Matches the console: a share button on an untouched list invites someone to
 * send a link that says nothing they had not already sent. Its presence answers
 * "is there anything here worth passing on".
 */
function updateShareControl() {
  const btn = document.getElementById('copyLinkBtn')
  if (btn) btn.hidden = !isDistrictsViewCustom(currentView())
}

/**
 * Copy the current view's link.
 *
 * The three strings here are bare English rather than `t()` lookups, which is
 * what the console's own share control does — and here it is not a lapse but the
 * only honest option. `test/i18n-districts.test.js` fails any `districts.*` key
 * the page asks for that `en.json` does not define, and this surface's catalogue
 * is not a file this change may edit. A key with no catalogue entry is a string
 * no language can ever translate; the gate is right to refuse it, and adding it
 * is a one-line follow-up for whoever owns `public/i18n/`.
 *
 * The clipboard needs a secure origin; on a plain-HTTP deployment it is simply
 * unavailable, so the fallback prints the URL rather than swallowing the click
 * and leaving the operator with no link and no idea anything happened.
 */
async function copyViewLink() {
  const status = document.getElementById('copyLinkStatus')
  const url = districtsShareUrl(currentView(), { origin: location.origin, pathname: '/districts/' })
  try {
    await navigator.clipboard.writeText(url)
    if (status) status.textContent = 'Link copied. It opens this exact view.'
  } catch {
    if (status) {
      status.textContent = `Copying is blocked in this browser. This link opens this view: ${url}`
    }
  }
}

/**
 * The share control and its status line.
 *
 * Built here rather than in the markup because `clearApp()` empties `#app` on
 * every route — a control written into the HTML would survive exactly until the
 * first district rendered and then take itself out of the page.
 */
function shareControl() {
  // The button label is bare English for the reason `copyViewLink` gives.
  const bar = document.createElement('div')
  bar.className = 'share-bar'
  bar.innerHTML = `
    <button type="button" class="btn btn-secondary" id="copyLinkBtn" hidden>Copy link to this view</button>
    <span class="field-note" id="copyLinkStatus" role="status"></span>
  `
  bar.querySelector('#copyLinkBtn').addEventListener('click', copyViewLink)
  return bar
}

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
  if (note) note.textContent = shown === total
    ? fill(t('districts.count_total', '{n} districts'), { n: String(total) })
    : fill(t('districts.count_shown', '{shown} of {n} districts'), { shown: String(shown), n: String(total) })
  const empty = document.getElementById('grid-empty')
  if (empty) empty.hidden = shown > 0
  setStatus(fill(t('districts.status_listed', '{shown} of {n} districts listed.'), { shown: String(shown), n: String(total) }))
}

/**
 * Name filter plus "open alerts or active hazards only", over data the cards
 * have already fetched.
 *
 * Client-side because `/api/v1/districts` returns nothing but identity — no
 * counts, no hazards — so a server round trip per keystroke would buy nothing
 * the cards do not already hold.
 *
 * The starting values come from the URL rather than from constants. They used to
 * be reset to empty on every route, which was correct while a filter could not
 * be shared and a link could not carry one; now that a link can, resetting would
 * silently drop the filter the reader was sent, and a link that opens showing
 * the whole list is worse than the screenshot it replaced. Navigating back to
 * the list re-reads the URL, so the filter survives the round trip rather than
 * being remembered in a module variable that the next route resets anyway.
 */
function filterBar(total) {
  // Straight from the URL, not from `currentView()`: this is the one direction
  // the URL is the source, since a link the reader followed carries the filter
  // and the controls do not exist yet.
  const restored = resolveDistrictsView({ search: location.search, hash: location.hash })
  filters.query = String(restored.query || '').trim().toLowerCase()
  filters.attentionOnly = restored.attentionOnly === true
  filters.cards = []

  const bar = document.createElement('div')
  bar.className = 'list-toolbar'
  bar.innerHTML = `
    <div class="filter-field">
      <label for="district-filter">${esc(t('districts.filter_label', 'Filter districts'))}</label>
      <input id="district-filter" type="search" autocomplete="off" placeholder="${esc(t('districts.filter_placeholder', 'Name or country code'))}">
    </div>
    <label class="filter-check" for="district-attention">
      <input id="district-attention" type="checkbox">
      <span>${esc(t('districts.filter_attention', 'Open alerts or active hazards only'))}</span>
    </label>
    <span class="list-toolbar-note muted-sm" id="filter-note">${esc(fill(t('districts.count_total', '{n} districts'), { n: String(total) }))}</span>
  `

  const search = bar.querySelector('#district-filter')
  // The box is stamped, not left empty under a filter already hiding half the
  // list: a reader who cannot see why the list is short cannot clear it.
  search.value = filters.query
  search.addEventListener('input', () => {
    filters.query = search.value.trim().toLowerCase()
    applyFilters(total)
    syncViewToUrl()
  })

  const attention = bar.querySelector('#district-attention')
  attention.checked = filters.attentionOnly
  attention.addEventListener('change', () => {
    filters.attentionOnly = attention.checked
    applyFilters(total)
    syncViewToUrl()
  })

  return bar
}

function renderList(districts) {
  const app = appEl()
  clearApp()

  const h = document.createElement('h1')
  h.className = 'page-title'
  h.textContent = t('districts.heading', 'Districts')
  app.appendChild(h)

  const lede = document.createElement('p')
  lede.className = 'page-lede'
  // The list endpoint carries identity only, so every card makes its own
  // request. Saying so up front is the difference between a page that looks
  // broken for two seconds and one that looks like it is working.
  lede.textContent = fill(
    t('districts.list_lede', '{n} districts. Counts, hazards and the most recent event load per card, so one slow district does not hold up the rest of the list.'),
    { n: String(districts.length) },
  )
  app.appendChild(lede)

  app.appendChild(filterBar(districts.length))
  app.appendChild(shareControl())
  updateShareControl()

  const grid = document.createElement('div')
  grid.className = 'district-grid'

  for (const d of districts) {
    const card = document.createElement('a')
    card.className = 'district-card'
    // A real href, so middle-click, "open in new tab" and "copy link address"
    // work. The click handler used to preventDefault unconditionally, which
    // defeated all three on a page whose entire purpose is linking onward.
    // The link carries the current filters as well as the district. It used to
    // be a bare `/districts#/slug`, which dropped a query the reader had typed
    // on the way in — so the operator who filtered to three districts, opened
    // one, and pressed back arrived at all forty with the filter gone and no
    // explanation. The filter is part of the view; a link that drops it is a
    // link that lies about where the reader was.
    // The href carries the current filters as well as the district. It used to be
    // a bare `/districts#/slug`, which dropped a query the reader had typed on
    // the way in — so the operator who filtered to three districts, opened one
    // and pressed back arrived at all forty, with the filter gone and no
    // explanation. Re-stamped on every filter change by `syncViewToUrl`, which
    // is the only way it stays true; a computed-once href is a claim about a
    // view that no longer exists.
    card.dataset.slug = String(d.slug || '')
    card.href = districtHref(d.slug)
    card.dataset.name = String(d.name || '')
    card.dataset.country = String(d.country || '')
    card.dataset.attention = 'unknown'
    card.innerHTML = `
      <span class="district-card-name">${esc(d.name)}</span>
      <span class="district-card-meta">${esc(d.country)} &middot; ${esc(fill(t('districts.km_radius', '{km} km radius'), { km: num(d.radius_km, { int: true }) }))}</span>
      <span class="district-card-counts" role="status" aria-live="polite" aria-busy="true">${esc(t('districts.loading_counts', 'Loading counts…'))}</span>
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
            <span class="district-stat"><strong>${esc(num(open, { int: true }))}</strong> ${esc(open === 1
              ? t('districts.open_alert_one', 'open alert')
              : t('districts.open_alerts_many', 'open alerts'))}</span>
            <span class="district-stat"><strong>${esc(num(hazards.length, { int: true }))}</strong> ${esc(hazards.length === 1
              ? t('districts.active_hazard_one', 'active hazard')
              : t('districts.active_hazards_many', 'active hazards'))}</span>
            <span class="district-stat"><strong>${esc(num(c.service_assets, { int: true }))}</strong> ${esc(t('districts.unit_assets', 'assets'))}</span>
            <span class="district-stat"><strong>${esc(num(c.incidents, { int: true }))}</strong> ${esc(t('districts.unit_incidents', 'incidents'))}</span>
          </span>
          ${latest
            ? `<span class="district-card-latest">${esc(t('districts.most_recent_hazard', 'Most recent hazard'))} ${sevChip(latest.hazard.severity)}${esc(latest.hazard.event_type || latest.hazard.type || t('districts.unlabelled', 'unlabelled'))} &middot; ${esc(formatRelative(latest.at))}</span>`
            : `<span class="district-card-latest muted-sm">${esc(hazards.length
                ? t('districts.no_hazard_timestamp', 'Active hazards carry no timestamp.')
                : t('districts.no_hazards_recorded', 'No active hazards on record.'))}</span>`}
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
        counts.textContent = t('districts.counts_unavailable', 'Counts unavailable')
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
  empty.textContent = t('districts.no_match', 'No district matches that filter.')
  app.appendChild(empty)

  applyFilters(districts.length)
}

function renderOverview(overview) {
  const app = appEl()
  clearApp()

  // Seeded first, before anything reads the view. `filterBar` runs only on the
  // list route, so without this the module holds no filters on a district
  // opened directly — and the back link and the share control, both built below
  // from the current view, would silently drop the query and the toggle the
  // sender had applied. A share link that quietly removes half of what it was
  // sharing is the worst of the three outcomes: the recipient has no way to
  // tell.
  const restored = resolveDistrictsView({ search: location.search, hash: location.hash })
  filters.query = String(restored.query || '').trim().toLowerCase()
  filters.attentionOnly = restored.attentionOnly === true

  const d = overview.district
  const c = overview.counts
  const alerts = overview.alert_events || []
  const hazards = overview.active_hazards || []
  const latest = mostRecentHazard(hazards)
  const openCount = openAlerts(alerts).length

  const back = document.createElement('a')
  back.className = 'back-link'
  // Carries the filters back to the list, for the same reason the card links
  // carry them forward: "back" that lands on a different view than the one
  // left is not back.
  back.href = listHref()
  back.textContent = t('districts.all_districts', '← All districts')
  app.appendChild(back)

  const ribbon = document.createElement('div')
  ribbon.className = 'ribbon'
  ribbon.innerHTML = `
    <div class="ribbon-title">
      ${esc(d.name)}
      <span class="ribbon-sub-name">${esc(d.country)}</span>
    </div>
    <div class="ribbon-subtitle">${esc(fill(t('districts.km_radius', '{km} km radius'), { km: num(d.radius_km, { int: true }) }))} &middot; ${esc(Number(d.center.lat).toFixed(4))}, ${esc(Number(d.center.lon).toFixed(4))}</div>
    <div class="counts-strip">
      <span>${esc(t('districts.count_assets', 'Assets'))} <strong>${num(c.service_assets, { int: true })}</strong></span>
      <span>${esc(t('districts.count_incidents', 'Incidents'))} <strong>${num(c.incidents, { int: true })}</strong></span>
      <span>${esc(t('districts.count_interventions', 'Interventions'))} <strong>${num(c.interventions, { int: true })}</strong></span>
      <span>${esc(t('districts.count_tasks', 'Tasks'))} <strong>${num(c.tasks, { int: true })}</strong></span>
      <span>${esc(t('districts.count_field_reports', 'Field reports'))} <strong>${num(c.field_reports, { int: true })}</strong></span>
      <span>${esc(t('districts.count_alerts', 'Alerts'))} <strong>${num(c.alert_events, { int: true })}</strong></span>
      <span>${esc(t('districts.count_workflows', 'Workflows'))} <strong>${num(c.workflow_instances, { int: true })}</strong></span>
    </div>
  `
  app.appendChild(ribbon)

  // A district is itself a non-default view, so this route offers the link too:
  // it is the route an operator is most often describing to someone else. Placed
  // under the ribbon, beside the district's name, because that is what the link
  // is a claim about.
  app.appendChild(shareControl())
  updateShareControl()

  // --- At a glance ----------------------------------------------
  // The ribbon answers "how much of everything"; this answers "what needs me
  // today", which is the only question the officer opening this page has. It
  // reuses the KPI tile treatment rather than inventing a sixth set of boxes.
  const glanceSection = document.createElement('section')
  glanceSection.className = 'section'
  glanceSection.innerHTML = `<h2 class="section-title">${esc(t('districts.at_a_glance', 'At a glance'))}</h2>`

  const glanceRow = document.createElement('div')
  glanceRow.className = 'kpi-row'
  glanceRow.innerHTML = [
    kpiTile(
      t('districts.open_alerts_label', 'Open alerts'),
      num(openCount, { int: true }),
      fill(t('districts.of_alert_events', 'of {n} alert events'), { n: num(alerts.length, { int: true }) }),
    ),
    kpiTile(
      t('districts.active_hazards_label', 'Active hazards'),
      num(hazards.length, { int: true }),
      t('districts.hazard_events_in_radius', 'hazard events in radius'),
    ),
    // The age, not the date: "2 days ago" is the answer to "is this still
    // news". The absolute date sits underneath for anyone filing a report.
    latest
      ? kpiTile(
          t('districts.most_recent_hazard', 'Most recent hazard'),
          formatRelative(latest.at),
          `${latest.hazard.event_type || latest.hazard.type || t('districts.unlabelled', 'unlabelled')} · ${sevClass(latest.hazard.severity)} · ${formatTimestamp(latest.at, { style: 'date' })}`,
          false,
          'kpi-value-text',
        )
      : kpiTile(
          t('districts.most_recent_hazard', 'Most recent hazard'),
          '—',
          hazards.length
            ? t('districts.no_hazard_timestamp_unit', 'active hazards carry no timestamp')
            : t('districts.no_hazards_unit', 'no active hazards on record'),
        ),
    kpiTile(
      t('districts.incidents_label', 'Incidents'),
      num(c.incidents, { int: true }),
      t('districts.recorded_in_radius', 'recorded in radius'),
    ),
  ].join('')
  glanceSection.appendChild(glanceRow)
  app.appendChild(glanceSection)

  // --- Situation ------------------------------------------------
  const sitSection = document.createElement('section')
  sitSection.className = 'section'
  sitSection.innerHTML = `<h2 class="section-title">${esc(t('districts.situation', 'Situation'))}</h2>`

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
          <caption class="visually-hidden">${esc(fill(t('districts.hazards_caption', 'Most recent active hazards in {name}'), { name: d.name }))}</caption>
          <thead><tr>
            <th scope="col">${esc(t('districts.col_hazard', 'Hazard'))}</th>
            <th scope="col">${esc(t('districts.col_severity', 'Severity'))}</th>
            <th scope="col">${esc(t('districts.col_date', 'Date'))}</th>
          </tr></thead>
          <tbody>${top10.map(h => `<tr>
            <td>${esc(h.event_type || h.type || '—')}</td>
            <td>${sevChip(h.severity)}</td>
            <td class="muted-sm nowrap">${esc(formatTimestamp(h.occurred_at || h.observed_at || h.created_at, { style: 'date' }))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
  } else {
    hazardWrap.innerHTML = emptyNote(t('districts.no_active_hazards', 'No active hazards.'))
  }
  sitRow.appendChild(hazardWrap)
  sitSection.appendChild(sitRow)
  app.appendChild(sitSection)

  // --- Operations ----------------------------------------------
  const opsSection = document.createElement('section')
  opsSection.className = 'section'
  opsSection.innerHTML = `<h2 class="section-title">${esc(t('districts.operations', 'Operations'))}</h2>`

  pagedList(opsSection, t('districts.incidents_label', 'Incidents'), overview.incidents, (r) => recordItem(r.title || r.id, sevChip(r.severity), r))
  pagedList(opsSection, t('districts.interventions', 'Interventions'), overview.interventions, (r) => recordItem(r.title || r.id, stateChip(r.status), r))
  pagedList(opsSection, t('districts.tasks', 'Tasks'), overview.intervention_tasks, (task) => recordItem(task.title || task.id, stateChip(task.status), task))

  // Field reports kept their 10-record cap; what changed is that the cap now
  // says so and offers the remainder, like every other list on this page.
  pagedList(opsSection, t('districts.field_reports', 'Field Reports'), overview.field_reports, (r) => {
    const demo = r.demographics
    const demoStr = demo ? ` · ${demo.gender || ''} ${demo.age_band || ''}` : ''
    const reporter = r.reported_by ? `<span class="chip chip-neutral">${esc(r.reported_by)}</span>` : ''
    return recordItem(String(r.summary || r.id).slice(0, 80) + demoStr, reporter, r)
  })
  app.appendChild(opsSection)

  // --- Signal and response --------------------------------------
  const sigSection = document.createElement('section')
  sigSection.className = 'section'
  sigSection.innerHTML = `<h2 class="section-title">${esc(t('districts.signal_and_response', 'Signal and Response'))}</h2>`

  pagedList(sigSection, t('districts.alert_events', 'Alert Events'), alerts, (a) => {
    const wfBadge = a.workflow_id ? '<span class="chip chip-neutral">wf</span>' : ''
    return recordItem(a.message || a.rule_name || a.id, `${sevChip(a.severity)} ${stateChip(a.status)} ${wfBadge}`, a)
  })
  pagedList(sigSection, t('districts.workflows', 'Workflows'), overview.workflow_instances, (w) => recordItem(w.type || w.id, stateChip(w.state), w))
  // 42 feedback notes was the list that started this: it is the longest on a
  // quiet district and pushed every alert above it off the screen.
  pagedList(sigSection, t('districts.community_feedback', 'Community Feedback'), overview.community_feedback, (f) =>
    recordItem(String(f.message || f.id).slice(0, 70), sentimentChip(f.sentiment), f))

  // --- KPI snapshot ---------------------------------------------
  const kpi = overview.kpi_snapshot
  const kpiRow = document.createElement('div')
  kpiRow.className = 'kpi-row'
  // A KPI with no data shows its reason rather than a bare em dash, so a reader
  // can tell "nothing happened" from "we did not measure it".
  kpiRow.innerHTML = [
    kpiTile(t('districts.people_reached', 'People reached'), num(kpi.people_reached, { int: true }), t('districts.unit_people', 'people')),
    kpiTile(t('districts.warning_to_action', 'Warning to action'), num(kpi.warning_to_action_median_hours, { dp: 2 }), t('districts.hours_median', 'hours median')),
    kpiTile(t('districts.false_alert_rate', 'False alert rate'), pct(kpi.false_alert_rate), '', kpi.false_alert_rate === null || kpi.false_alert_rate === undefined),
    kpiTile(t('districts.cold_chain_rate', 'Cold-chain rate'), pct(kpi.cold_chain_protection_rate), '', kpi.cold_chain_protection_rate === null || kpi.cold_chain_protection_rate === undefined),
  ].join('')
  sigSection.appendChild(kpiRow)
  app.appendChild(sigSection)
}

/**
 * Paint a terminal failure, in both places the reader can look.
 *
 * This cleared the app, set `aria-busy="false"` and drew the panel — and left
 * the status line reading "Loading." indefinitely. `#app-status` is the one
 * element on the page designed to be the source of truth about what is
 * happening, and it was the element lying: a reader who checks it first is told
 * the load is still running, and `/co/` by contrast resolves its status line to
 * a terminal sentence. Same product, two different answers to "did it finish?".
 *
 * So every failure resolves the status line too, from the same message. The
 * status is not a second string to keep in step; it is the message, which is
 * the only way it cannot drift.
 */
function showError(app, message) {
  clearApp()
  app.setAttribute('aria-busy', 'false')
  setStatus(message)
  const panel = document.createElement('div')
  panel.className = 'error-panel'
  // role="alert": this replaces a page the reader was waiting on, and an
  // error that only announces itself politely is an error they navigate away
  // from while it is still talking.
  panel.setAttribute('role', 'alert')
  panel.innerHTML = `<strong>${esc(message)}</strong>
    <p>${esc(t('districts.error_body', 'The district data could not be loaded. Check the connection and try again.'))}</p>`
  // The panel announces; the status line records. A screen reader that lands
  // here by tab rather than by alert still gets a terminal state to read.
  app.appendChild(panel)
}

function loadingNote(app, text) {
  clearApp()
  app.setAttribute('aria-busy', 'true')
  const note = document.createElement('div')
  note.className = 'loading-note'
  note.textContent = text
  app.appendChild(note)
  setStatus(t('districts.status_loading', 'Loading.'))
}

async function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
  const app = appEl()
  if (!app) return

  if (!hash) {
    loadingNote(app, t('districts.loading_districts', 'Loading districts…'))
    try {
      const { data } = await apiFetch('/api/v1/districts')
      app.setAttribute('aria-busy', 'false')
      renderList(data || [])
      setStatus(fill(t('districts.status_districts_loaded', '{n} districts loaded.'), { n: String((data || []).length) }))
    } catch {
      showError(app, t('districts.error_list', 'Could not load districts.'))
    }
    return
  }

  loadingNote(app, t('districts.loading', 'Loading…'))
  try {
    const { data } = await apiFetch(`/api/v1/districts/${encodeURIComponent(hash)}`)
    app.setAttribute('aria-busy', 'false')
    if (!data) {
      showError(app, t('districts.error_not_found', 'District not found.'))
      return
    }
    renderOverview(data)
    // The card counts on the list page announce themselves; the overview has
    // no such per-region chatter, so its load is announced once, here.
    setStatus(fill(t('districts.status_overview_loaded', '{name} overview loaded.'), { name: data.district.name }))
  } catch (err) {
    // `hash` came from the URL and used to be interpolated into innerHTML
    // unescaped, so the not-found branch reflected whatever the address bar
    // held. It is escaped now, and the detail is not echoed back at all.
    showError(app, err.status === 404
      ? t('districts.error_not_found', 'District not found.')
      : t('districts.error_district', 'Could not load this district.'))
  }
}

window.addEventListener('hashchange', route)

/**
 * Boot, and the one control that changes what every string above says.
 *
 * `route()` is re-run rather than only re-stamped: almost nothing on this
 * surface lives in the markup — the headings, the table headers, the list
 * footers and every sentence are built in JavaScript — so translating the
 * static strings alone would leave a Swahili page wrapped in English. The
 * catalogue is awaited before the first route so the first paint is already
 * in the reader's language.
 */
async function init() {
  // The call, not the reference. `currentLocale` is a hoisted function
  // declaration, so passing it bare handed `initI18n` the function itself; it
  // was then interpolated into a URL, and the server answered
  // `/i18n/%20Shared%20with%20every%20other%20surface…json` — a 200 for the
  // SPA fallback page. `res.json()` threw, the throw was swallowed, and the
  // catalogue stayed empty. Every string on this surface then resolved to its
  // own key, permanently: the navbar read `nav.ops`, `nav.chw`, … and the
  // skip link read `districts.skip_link`. Firing a locale `change` fixed it,
  // because `set()` re-reads English by literal path and re-stamps the DOM —
  // which is why the bug survived every click-through test.
  await initI18n(currentLocale())
autoMarkScrollableRegions()
  document.title = t('districts.title', 'Lindela Districts')

  const localeSel = document.getElementById('locale-select')
  if (localeSel) {
  	localeSel.value = currentLocale()
  	localeSel.addEventListener('change', async (e) => {
  		localStorage.setItem('lindela_lite_locale', e.target.value)
  		await window.__i18n.set(e.target.value)
  		document.title = t('districts.title', 'Lindela Districts')
  		route()
  	})
  }

  route()
}

/**
 * Shared with every other surface, so a reader who chose Kiswahili on the
 * console is not offered English here.
 */
function currentLocale() {
  const stored = localStorage.getItem('lindela_lite_locale')
  // A stored preference for a language this surface does not carry would
  // leave the shared runtime layering a catalogue the reader cannot read,
  // so only a locale offered on this page is honoured.
  return OFFERED_LOCALES.includes(stored) ? stored : 'en'
}

/**
 * Settles once the catalogue is in place and the first route has rendered.
 *
 * The shared navbar is eight translated labels, and it mounts itself from a
 * module that evaluates before this file's `await initI18n(...)` resolves. Left
 * to race it, the nav is stamped from an empty catalogue — and an empty
 * catalogue resolves every key to the key, so the page opens reading
 * `nav.ops nav.chw nav.portal …`. Exporting the boot promise lets the page
 * await it and mount the nav against a catalogue that exists, instead of
 * rendering the keys and hoping a later pass repairs them.
 */
export const ready = document.readyState === 'loading'
  ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => init().then(resolve)))
  : init()