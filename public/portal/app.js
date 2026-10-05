import { initI18n, t, apiFetch, initOfflineBanner, autoMarkScrollableRegions } from '/shared/runtime.js'
import { mountNavbar } from '/shared/navbar.js'
import { ERROR, EMPTY, LOADING, OK, createLoadSequence, describeState, distinguishFailure } from '/shared/states.js'
import { esc as escapeHtml, formatTimestamp, num, pct, sevChipHtml, truncate, applyLocaleToDocument } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'
mountNavbar({ activePath: '/portal' })

/** The four collections this portal shows. One list: the loader, the per-table
 *  verdict and the failure summary all derive from it, so adding a table cannot
 *  leave one of the three behind. */
const COLLECTIONS = ['risk', 'hazards', 'assets', 'alerts']

const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  // Not localStorage. The organisation this portal shows must be the one the
  // server says the token speaks for, not one the browser remembered from a
  // previous session on a shared machine.
  partnerOrg: null,
  currentTab: 'risk',
  data: Object.fromEntries(COLLECTIONS.map((k) => [k, []])),
  // Per-collection verdict from /shared/states.js. The table renders on this,
  // never on row count: a failed request has no rows, and rows are what the
  // empty state used to read.
  loaded: Object.fromEntries(COLLECTIONS.map((k) => [k, null])),
}

const $ = (id) => document.getElementById(id)

const apiKey = () => localStorage.getItem('lindela_lite_api_key')

/** One load in flight at a time. `loadData` is reachable from its own retry
 *  button, and two overlapping partner loads would otherwise let the slower,
 *  older response write last. */
const loadSequence = createLoadSequence()

/**
 * The surface's status line, and the only three things it is ever allowed to
 * say.
 *
 * It was absent entirely, so a partner watched a blank page through two
 * sequential round trips and could not distinguish a portal that was working
 * from a portal that was broken. `setLoadState` is deliberately the only way to
 * write to it: the working state cannot be left behind, because every call
 * site that starts a load also calls this once it has settled.
 */
function setLoadState(stateName, detail = {}) {
  const el = $('load-status')
  if (!el) return
  const copy = describeState(stateName, detail)
  el.dataset.state = stateName
  el.textContent = copy.title
}

const localeSelect = $('locale-select')
const signoutBtn = $('signoutBtn')
const authPanel = $('authPanel')
const contentArea = $('contentArea')
const partnerOrgDisplay = $('partnerOrg')

async function init() {
  await initI18n(state.locale)
  applyLocaleToDocument(state.locale)
  initOfflineBanner()

  // Set here rather than only in the HTML: a retry re-enters `init`, and the
  // partner is owed the working state again for the round trip that retry
  // starts.
  setLoadState(LOADING, { noun: 'this partner portal' })

  localeSelect.value = state.locale
  localeSelect.addEventListener('change', async (e) => {
    state.locale = e.target.value
    localStorage.setItem('lindela_lite_locale', state.locale)
    await window.__i18n.set(state.locale)
    // `set()` already applied lang and dir; this pair was a second RTL list.
    // See the boot call below for why it is being removed rather than kept.
  })

  signoutBtn.addEventListener('click', () => {
    localStorage.removeItem('lindela_lite_api_key')
    window.location.href = '/'
  })

  // The organisation comes from the server, which is the only party that knows
  // which token was presented. This used to be read from localStorage, so the
  // header displayed whatever a previous session on a shared machine had
  // typed — an isolation indicator with nothing behind it.
  //
  // The catch used to swallow the failure and fall through to "Authentication
  // is not configured", which is an assertion about the server's configuration
  // that a dead socket knows nothing about. A partner reading that would go
  // re-key their token, when the real problem was the network.
  let identity = null
  let identityError = null
  try {
    identity = (await apiFetch('/api/v1/auth-info', { token: apiKey() }))?.data || null
  } catch (error) {
    identityError = error
  }

  if (identityError) {
    renderIdentityFailure(identityError)
    return
  }

  state.partnerOrg = identity?.data?.partner_org || null

  if (!state.partnerOrg) {
    // No partner scope on this token. Say so rather than showing the whole
    // platform's data under a heading that implies it is this partner's.
    //
    // Restored here because `renderIdentityFailure` suppresses them: the auth
    // claims are withdrawn only while the cause is a dead socket, and a retry
    // that succeeds must put them back or a genuine auth problem would render
    // as a network one.
    for (const el of authPanel.querySelectorAll('h2, p[data-i18n]')) el.hidden = false
    $('portalIdentityError')?.remove()
    partnerOrgDisplay.textContent = identity?.data?.auth_configured
      ? 'No partner scope on this token'
      : 'Authentication is not configured'
    // The server answered; the partner's scope is the reason there is nothing
    // to show. The loading line has no work left to describe.
    setLoadState(OK)
    return
  }

  partnerOrgDisplay.textContent = `Org: ${state.partnerOrg}`
  contentArea.style.display = 'block'
  authPanel.style.display = 'none'

  setupTabs()
  await loadData()
}

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'))
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'))
      e.target.classList.add('active')
      const tab = e.target.dataset.tab
      state.currentTab = tab
      $(`${tab}Tab`).classList.add('active')
    })
  })

  document.querySelectorAll('.export-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tab = e.target.id.split('Export')[0]
      const format = e.target.id.split('Export')[1].toLowerCase()
      exportData(tab, format)
    })
  })
}

async function loadData() {
  const token = loadSequence.start()
  setLoadState(LOADING, { noun: 'the four tables' })

  const load = async (key, path) => {
    try {
      const data = (await apiFetch(path, { token: apiKey() })).data || []
      return { [key]: { ok: true, data, error: null } }
    } catch (error) {
      // Settle rather than reject: this is a read-only partner view of four
      // independent collections, and one dead endpoint should not blank the
      // other three. Previously the first failure rejected the whole Promise.all
      // and the portal rendered an empty page with no explanation anywhere on
      // screen — `console.error` is not something a partner reads.
      //
      // The failure is now carried as a failure rather than as an empty array.
      // The array is what `renderTable` used to read as "the server answered
      // and there is nothing", which is how a dead endpoint produced four
      // confidently empty tables.
      return { [key]: { ok: false, data: [], error } }
    }
  }

  const results = await Promise.all([
    // No partner_org parameter. The server now refuses one that disagrees with
    // the token and applies the token's own organisation itself, so sending it
    // was claiming a scoping the server was not performing.
    load('risk', '/api/v1/flood-risk'),
    load('hazards', '/api/v1/events'),
    load('assets', '/api/v1/service-assets'),
    load('alerts', '/api/v1/rapidpro/dispatches'),
  ])

  // A load superseded by a newer one writes nothing at all — not even to
  // `state`. Its rows are for a partner view the reader has already moved
  // past, and letting it reach the shared state while withholding only the
  // render would leave the tables on screen describing one period and the
  // state behind them describing another.
  if (!loadSequence.isCurrent(token)) return

  const loaded = Object.assign({}, ...results)
  for (const key of COLLECTIONS) {
    state.data[key] = loaded[key].data
    // Per-table verdict. `renderTable` branches on this rather than on length,
    // so a failed table says so in the cell a reader was about to read as data.
    state.loaded[key] = distinguishFailure({
      ok: loaded[key].ok,
      error: loaded[key].error,
      isEmpty: !loaded[key].data.length,
    })
  }

  renderRiskTable()
  renderHazardsTable()
  renderAssetsTable()
  renderAlertsTable()

  // Settled on both paths, before the render branch below decides what to say.
  // A status line that resolves when the answer arrives but not when the
  // request dies is the same defect as one that never resolves.
  loadSequence.settle(token)

  const failed = COLLECTIONS.filter((k) => state.loaded[k] === ERROR)
  setLoadState(failed.length ? ERROR : OK)
  $('portalError')?.remove()
  if (failed.length) {
    const copy = describeState(ERROR, {
      subject: failed.length === COLLECTIONS.length
        ? 'These tables'
        : `${failed.length} of these tables`,
    })
    // A child of contentArea, not contentArea itself: the summary is added to
    // the page, and the tabs it sits above must survive the retry that replaces it.
    let host = $('portalError')
    if (!host) {
      host = document.createElement('div')
      host.id = 'portalError'
      host.style.margin = '1rem'
      contentArea.prepend(host)
    }
    renderStatePanel(host, { ...copy, state: ERROR }, { retry: () => loadData() })
  }
}

/**
 * One panel of shared vocabulary, rendered.
 *
 * Every surface needs the same three things from a failure: the words, the fact
 * that a retry exists, and a control that actually performs it. The vocabulary
 * is in /shared/states.js; only the mounting is here.
 */
function renderStatePanel(container, copy, { retry } = {}) {
  container.innerHTML = `<div class="state-panel" data-state="${copy.state}" role="alert">
    <strong>${escapeHtml(copy.title)}</strong>
    <p>${escapeHtml(copy.body)}</p>
  </div>`
  if (!copy.retryable || !retry) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'retry-btn'
  btn.textContent = copy.action
  btn.addEventListener('click', retry)
  container.firstElementChild.appendChild(btn)
}

/**
 * The partner-scope lookup failed.
 *
 * This is the failure that hides the whole portal, so it needs the strongest
 * wording available: the partner cannot know whether their token is scoped,
 * configured, or merely unreachable, and the old text picked one of those for
 * them.
 */
function renderIdentityFailure() {
  authPanel.style.display = 'block'
  partnerOrgDisplay.textContent = 'Connection lost'
  setLoadState(ERROR, { subject: 'This partner portal' })

  // The panel ships with "Authentication required" and "Sign in with your
  // partner credentials". On a dead socket both are false — the partner is not
  // unauthenticated, the client cannot tell — and a partner who believes them
  // will re-issue credentials that were never the problem. So the claim is
  // withdrawn rather than qualified.
  //
  // The sign-in button stays: it is the way out for a partner whose token
  // really is the problem, and a network blip must not take that exit away.
  for (const el of authPanel.querySelectorAll('h2, p[data-i18n]')) el.hidden = true

  const copy = describeState(ERROR, { subject: 'Your partner records' })
  let panel = $('portalIdentityError')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'portalIdentityError'
    authPanel.appendChild(panel)
  }
  renderStatePanel(panel, { ...copy, state: ERROR }, { retry: () => init() })
}

/**
 * One table renderer for all four portal tables.
 *
 * These were four near-identical 24-line blocks differing only in body id,
 * columns and button ids. Each applied `toFixed(2)` to a value that could be
 * absent, so a missing risk score rendered "0.00" — a number where the honest
 * answer is that nothing was measured. Severity was bare text rather than the
 * same chip every other surface uses.
 */
function renderTable(bodyId, { rows, columns, sortKey, limit = 100, collection }) {
  const tbody = $(bodyId)
  if (!tbody) return

  const verdict = collection ? state.loaded[collection] : null

  // Checked before the row count, always. This is the whole fix: a failure
  // produces zero rows, and zero rows used to reach the branch below.
  if (verdict === ERROR) {
    const copy = describeState(ERROR, { subject: 'The rows in this table' })
    tbody.innerHTML = `<tr><td colspan="${columns.length}" class="empty-cell" data-state="error" role="alert">
      <strong>${escapeHtml(copy.title)}</strong> ${escapeHtml(copy.body)}</td></tr>`
    return
  }

  const body = sortKey
    ? [...rows].sort((a, b) => new Date(b[sortKey] || 0) - new Date(a[sortKey] || 0)).slice(0, limit)
    : rows.slice(0, limit)

  if (!body.length) {
    // Reached only by a request that answered. Saying so is what separates this
    // cell from the one above it.
    const copy = describeState(EMPTY, { noun: 'these rows' })
    tbody.innerHTML = `<tr><td colspan="${columns.length}" class="empty-cell" data-state="empty">${escapeHtml(copy.body)}</td></tr>`
    return
  }

  tbody.innerHTML = body.map((row) => `<tr>${
    columns.map((col) => `<td${col.numeric ? ' class="num-cell"' : ''}>${col.render(row)}</td>`).join('')
  }</tr>`).join('')

  if (body.length < rows.length) {
    // The limit is a deliberate cap on a partner-facing export; say so rather
    // than letting a reader assume the table is complete.
    const note = document.createElement('tr')
    note.innerHTML = `<td colspan="${columns.length}" class="empty-cell">Showing the ${body.length} most recent of ${rows.length}.</td>`
    tbody.appendChild(note)
  }
}

const severityCell = (value) => sevChipHtml(value)

function renderRiskTable() {
  renderTable('riskTableBody', {
    collection: 'risk',
    rows: state.data.risk || [],
    columns: [
      { render: (r) => escapeHtml(r.district || '—') },
      // A score with no value is not zero. `|| 0` then toFixed made it so.
      { render: (r) => escapeHtml(num(r.risk_score, { dp: 2, dash: '—' })), numeric: true },
      { render: (r) => escapeHtml(pct(r.confidence, { dp: 0 })), numeric: true },
    ],
  })
}

function renderHazardsTable() {
  renderTable('hazardsTableBody', {
    collection: 'hazards',
    rows: state.data.hazards || [],
    sortKey: 'created_at',
    columns: [
      { render: (e) => escapeHtml(truncate(e.headline || e.event_type || '—', { max: 80 })) },
      { render: (e) => escapeHtml(metricLabel(e.event_type)) },
      { render: (e) => escapeHtml(formatDate(e.created_at)) },
      { render: (e) => severityCell(e.severity) },
    ],
  })
}

function renderAssetsTable() {
  renderTable('assetsTableBody', {
    collection: 'assets',
    rows: state.data.assets || [],
    columns: [
      { render: (a) => escapeHtml(a.name || '—') },
      { render: (a) => escapeHtml(metricLabel(a.asset_type)) },
      { render: (a) => escapeHtml(a.district || '—') },
    ],
  })
}

function renderAlertsTable() {
  renderTable('alertsTableBody', {
    collection: 'alerts',
    rows: state.data.alerts || [],
    sortKey: 'created_at',
    columns: [
      { render: (a) => escapeHtml(truncate(a.headline || a.event_type || '—', { max: 80 })) },
      { render: (a) => severityCell(a.severity) },
      { render: (a) => escapeHtml(formatDate(a.created_at)) },
    ],
  })
}

async function exportData(tab, format) {
  const tabMap = { risk: 'flood-risk', hazards: 'events', assets: 'service-assets', alerts: 'rapidpro/dispatches' }
  const endpoint = `/api/v1/${tabMap[tab] || tab}`

  try {
    const url = format === 'csv' ? `${endpoint}/export.csv` : `${endpoint}/export.geojson`
    window.open(url, '_blank')
  } catch (error) {
    console.error('Export failed:', error)
  }
}

function formatDate(iso) {
  // Ambiguous and locale-dependent: "9/28/2026" reads as 28 September in
  // Nairobi and 9 February to a reader elsewhere in the same deployment.
  return formatTimestamp(iso, { style: 'date', dash: '—' })
}

// escapeHtml, num, pct, truncate and sevClass come from /shared/fmt.js. This
// file carried its own copies; the escape helper used `||`, which dropped a
// legitimate 0 or false and rendered it blank.

await init()
autoMarkScrollableRegions()
