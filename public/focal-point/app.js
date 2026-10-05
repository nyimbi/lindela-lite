import { initI18n, t, apiFetch, initOfflineBanner, initServiceWorker, autoMarkScrollableRegions } from '/shared/runtime.js'
import { esc as escapeHtml, formatTimestamp, sevChipHtml, applyLocaleToDocument } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'
import { mountNavbar } from '/shared/navbar.js'
import { ERROR, LOADING, OK, createLoadSequence, describeActionFailure, describeState, distinguishFailure } from '/shared/states.js'
mountNavbar({ activePath: '/focal-point' })

// Registration used to be hand-rolled here *and* performed by initServiceWorker
// further down: two registrations for one worker.
initServiceWorker()

const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  // The operator's own name, or empty. Nothing on this surface ever set it, so
  // it used to default to the literal string "focal-point" — a machine handle
  // rendered in the header as though it were a person's name, and posted as
  // though it were a claim about who approved. An empty value is honest and the
  // server records the decision as unattributed; a defaulted one is neither.
  identity: (localStorage.getItem('lindela_lite_focal_point') || '').trim(),
  currentDialogMode: null,
  currentWorkflowId: null,
  protocols: [],
}

const $ = (id) => document.getElementById(id)

/** One load in flight at a time, so a superseded response cannot write last. */
const loadSequence = createLoadSequence()

/** `t`, but with a fallback: `t` echoes the key back when nothing is translated. */
const tr = (key, fallback) => {
  const value = t(key)
  return !value || value === key ? fallback : value
}

const pendingList = $('pendingList')
const protocolsList = $('protocolsList')
const auditList = $('auditList')
const connectionStatus = $('connectionStatus')
const statusText = $('statusText')
const localeSelect = $('locale-select')
const signoutBtn = $('signoutBtn')

const decisionDialog = $('decisionDialog')
const reasonSelect = $('reasonSelect')
const dialogConfirmBtn = $('dialogConfirmBtn')
const dialogCancelBtn = $('dialogCancelBtn')
const decisionTitle = $('decisionTitle')
const decisionSummary = $('decisionSummary')
const fpNameInput = $('fpName')

initOfflineBanner()
initServiceWorker()

fpNameInput.value = state.identity
fpNameInput.addEventListener('change', () => {
  state.identity = fpNameInput.value.trim()
  if (state.identity) localStorage.setItem('lindela_lite_focal_point', state.identity)
  else localStorage.removeItem('lindela_lite_focal_point')
  // The confirm modal quotes the actor ("... as Peter Deng"). It was opened
  // against the name stored when the page loaded, so a rename left the modal
  // asserting a stale actor.
  if (state.currentWorkflowId) openDecisionDialog(state.currentDialogMode)
})

localeSelect.value = state.locale
localeSelect.addEventListener('change', async (e) => {
  state.locale = e.target.value
  localStorage.setItem('lindela_lite_locale', state.locale)
  await window.__i18n.set(state.locale)
  // lang/dir come from applyLocaleToDocument, which reads the shared
  // locale table. This was a hand-copied second RTL list.
})

signoutBtn.addEventListener('click', () => {
  localStorage.removeItem('lindela_lite_api_key')
  localStorage.removeItem('lindela_lite_focal_point')
  window.location.href = '/'
})

/**
 * Render one queue's honest state into its container.
 *
 * Every list on this surface used to branch only on `length === 0`, so a failed
 * load and a genuinely empty queue produced the same DOM. "No pending
 * workflows." told a focal point that every trigger had been dealt with when
 * nothing had been checked at all — the single worst sentence this screen can
 * be wrong about, because acting on it means stopping the search.
 */
function renderQueueState(container, stateName, { subject, retry }) {
  const copy = describeState(stateName, { subject })
  container.innerHTML = `<div class="queue-empty" data-state="${stateName}" role="alert">
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

async function loadData() {
  connectionStatus.textContent = '●'
  connectionStatus.style.color = 'var(--ok)'

  // One running tally for the whole surface. A retry clicked twice, or a retry
  // overlapping the periodic refresh, would otherwise let the *older* response
  // write last — and the older response is the one for a queue that has since
  // changed.
  const token = loadSequence.start()
  const working = describeState(LOADING, { noun: 'the approval queue, the protocols and the decisions' })
  statusText.textContent = working.title
  statusText.dataset.state = LOADING

  // Settled, not all-or-nothing: a dead protocol endpoint must not blank the
  // approval queue, and a dead queue must not blank the protocol list. Each is
  // rendered in the state its own request earned.
  const load = async (path) => {
    try {
      return { data: await apiFetch(path), error: null }
    } catch (error) {
      return { data: null, error }
    }
  }

  const [workflows, protocols, alertsResp] = await Promise.all([
    load(`/api/v1/workflows?type=anticipatory_alert&state=focal_point_review`),
    load(`/api/v1/trigger-protocols`),
    load(`/api/v1/alert-events`),
  ])

  // A load superseded by a newer one writes nothing at all — not even to
  // `state`. Its queue is one the operator has already moved past, and letting
  // it reach the cards while withholding only the status line would put the
  // wrong approvals on screen. This is also what stops a second click on the
  // retry button stranding the surface at "Loading…": the loser simply leaves.
  if (!loadSequence.isCurrent(token)) return

  const states = {
    pending: distinguishFailure({ ok: !workflows.error, error: workflows.error, isEmpty: !workflows.data?.data?.length }),
    protocols: distinguishFailure({ ok: !protocols.error, error: protocols.error, isEmpty: !protocols.data?.data?.length }),
    alerts: distinguishFailure({ ok: !alertsResp.error, error: alertsResp.error }),
  }

  // Kept on state so a decision can name the district it released finance
  // for without re-reading the card it is about to be removed from.
  state.workflows = workflows.data?.data || []

  // Index alert events by id for O(1) card hydration
  const alertIndex = new Map((alertsResp.data?.data || []).map((a) => [a.id, a]))
  state.alerts = alertsResp.data?.data || []

  // Kept for the card renderer: the threshold a focal point approves against is
  // the governing protocol's, and a card rendered while the protocol fetch
  // failed has no protocol to govern it. That card says so rather than
  // borrowing another district's number.
  state.protocols = protocols.error ? [] : (protocols.data?.data || [])

  if (states.pending === ERROR) {
    renderQueueState(pendingList, ERROR, { subject: 'The pending approvals', retry: () => loadData() })
  } else {
    await renderPending(workflows.data.data || [], alertIndex, state.protocols)
  }

  if (states.protocols === ERROR) {
    renderQueueState(protocolsList, ERROR, { subject: 'The listed protocols', retry: () => loadData() })
  } else {
    await renderProtocols(protocols.data.data || [])
  }

  // The audit trail is derived from the same workflow response, so it inherits
  // that response's verdict. Showing "No recent decisions." off a failed fetch
  // would repeat the original lie in a second place.
  if (states.pending === ERROR) {
    renderQueueState(auditList, ERROR, { subject: 'The recorded decisions', retry: () => loadData() })
  } else {
    await renderAuditTrail(workflows.data.data || [])
  }

  const anyFailed = Object.values(states).includes(ERROR)
  // The working state is retired here and only here — on the failure path as
  // well as the success path. A status line that resolves when the answer
  // arrives but not when the request dies is the same defect as one that never
  // resolves.
  loadSequence.settle(token)
  statusText.dataset.state = anyFailed ? ERROR : OK
  if (anyFailed) {
    connectionStatus.style.color = 'var(--sev-high)'
    statusText.textContent = describeState(ERROR, { subject: 'The approval queue, the protocols and the decisions' }).title
  } else {
    const counts = `${state.pending.length} to review · ${state.protocols.length} active`
    statusText.textContent = `Ready — ${counts}.`
  }
}

function severityChip(severity) {
  // Allowlisted: this value came off the API and was interpolated straight into
  // a class name. shared/fmt.js emits the one class pair every surface styles
  // (HX-07); this surface used to declare its own `.severity-*` pair and render
  // `HIGH` in a 12px pill where the console rendered `high` in a 3px one.
  return sevChipHtml(severity)
}

/** Absolute, with its zone. `toLocaleString` gave "9/28/2026, 6:55:29 AM". */
function formatTime(iso) {
  return formatTimestamp(iso, { dash: '' })
}

/**
 * Which way a comparison runs.
 *
 * `>= 5` and `<= 5` are different claims about the world, and this surface
 * dropped the direction in three places: the protocol list printed a hardcoded
 * `≥` so "Aweil Drought Early-Warning Trigger — Rainfall (mm) ≥ 5" described a
 * protocol the API states as `<= 5`; the card computed `value >= threshold`
 * regardless; and the verdict said "condition met" for readings the protocol
 * says are not met. A drought trigger read as a flood trigger is the
 * difference between releasing money for water and releasing it for its absence.
 */
const OPERATORS = {
  '>=': (v, t) => v >= t,
  '>': (v, t) => v > t,
  '<=': (v, t) => v <= t,
  '<': (v, t) => v < t,
  '=': (v, t) => v === t,
  '==': (v, t) => v === t,
}

/** `>=` as `≥`. The catalogue writes ASCII; this surface reads as typeset text. */
const OPERATOR_SYMBOL = { '>=': '\u2265', '<=': '\u2264', '>': '>', '<': '<', '=': '=', '==': '=' }
const opText = (op) => OPERATOR_SYMBOL[op] || op || ''

const directionOf = (op) => ['>=', '>'].includes(op) ? 'up' : ['<=', '<'].includes(op) ? 'down' : null

/** A number, or null. 0 is a reading — a drought threshold trips on it. */
function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** True/false when both sides are numbers and the operator is one we know. */
function compare(value, threshold, operator) {
  const v = numberOrNull(value)
  const t = numberOrNull(threshold)
  const fn = OPERATORS[operator]
  if (v === null || t === null || !fn) return null
  return fn(v, t)
}

/**
 * The districts this deployment actually has.
 *
 * Read from the alerts and the queue rather than from a list kept beside the
 * code, which goes stale the first time a district is added — and the queue
 * alone is worse than useless here, because a queue holding one Turkana card
 * makes Aweil look like nowhere. Used to tell a district-scoped protocol
 * (`tp-aweil-drought`, "Aweil Drought …") from one that applies everywhere
 * (`Cold Chain Protection: Temperature Breach`).
 */
function knownDistricts(workflows, alerts) {
  const named = [
    ...(workflows || []).map((w) => w.district),
    ...(alerts || []).map((a) => a?.scope?.district || a?.metadata?.district),
  ]
  return new Set(named.filter(Boolean).map((d) => String(d).toLowerCase()))
}

function namesDistrict(p, district) {
  return Boolean(district)
    && `${p.id} ${p.name} ${p.description || ''}`.toLowerCase().includes(String(district).toLowerCase())
}

/**
 * The protocol that governs a trigger, or null.
 *
 * A card is an approval gate for a pre-agreed disbursement, so the number on it
 * has to be the one in the protocol the focal point's finance is released under
 * — not a threshold copied off the alert that raised the trigger, which is a
 * different artefact and can disagree.
 *
 * Three conditions, and dropping any one of them reintroduces the defect:
 * the metric must match, the direction must match, and a district-scoped
 * protocol must name *this* district. Matching on direction alone let a
 * drought protocol's `≤ 5` govern a flood trigger's reading of 52; matching on
 * district alone did the same thing. Falling back to the first same-metric
 * candidate let Aweil's drought protocol govern a Turkana card, which is one
 * district's finance judged against another district's threshold.
 *
 * A protocol naming no district — cold chain, CHW triage — applies everywhere.
 * Shadow protocols are drafts: they have not been activated, so they govern
 * nothing.
 */
function governingProtocol(alert, district, protocols, districts = new Set()) {
  const live = (protocols || []).filter((p) => p && p.mode !== 'shadow')
  const scope = (p) => `${p.id} ${p.name} ${p.description || ''}`.toLowerCase()
  const candidates = live.filter((p) =>
    p.metric === alert.metric
    && directionOf(p.operator) === directionOf(alert.operator)
    && numberOrNull(p.threshold) !== null
    // Scoped elsewhere? Then it is not ours, whatever the metric agrees about.
    && ![...districts].some((d) => d !== String(district || '').toLowerCase() && scope(p).includes(d)))
  return candidates.find((p) => namesDistrict(p, district)) || candidates[0] || null
}

/**
 * The threshold, direction and metric the card must be judged against.
 *
 * A protocol that governs supplies all three. Otherwise the alert's own numbers
 * stand, flagged as unverified against a protocol — the alternative is showing
 * `—`, which reads to a focal point as "no threshold exists" when in truth one
 * exists and simply was not found on this page.
 */
function thresholdFor(alert, district, protocols, districts) {
  const protocol = governingProtocol(alert, district, protocols, districts)
  if (protocol) {
    return { protocol, metric: protocol.metric, operator: protocol.operator, threshold: protocol.threshold, governed: true }
  }
  return {
    protocol: null,
    metric: alert?.metric,
    operator: alert?.operator,
    threshold: alert?.threshold,
    governed: false,
  }
}

function getReasonOptions(mode) {
  if (mode === 'approve') {
    return [
      { value: 'confirmed_threat', label: 'Confirmed threat' },
      { value: 'pre_authorized_protocol', label: 'Pre-authorized protocol' },
      { value: 'manual_override', label: 'Manual override' },
    ]
  } else {
    return [
      { value: 'false_positive', label: 'False positive' },
      { value: 'insufficient_evidence', label: 'Insufficient evidence' },
      { value: 'wrong_district', label: 'Wrong district' },
      { value: 'already_actioning', label: 'Already actioning' },
    ]
  }
}

/**
 * One card's governing facts, resolved once so the card and the confirm modal
 * cannot disagree about what is being approved.
 */
function describeTrigger(w, alertIndex, protocols, districts) {
  const alert = (w.subject_kind === 'alert_event' && w.subject_id)
    ? (alertIndex.get(w.subject_id) || null)
    : null
  const district = w.district || ''
  const ruleName = alert?.rule_name || w.metadata?.rule_name || 'Unknown'
  const severity = alert?.severity || w.metadata?.severity || 'medium'
  const value = alert?.value ?? w.metadata?.value
  const bound = thresholdFor(
    { metric: alert?.metric || w.metadata?.metric, operator: alert?.operator, threshold: alert?.threshold ?? w.metadata?.threshold },
    district,
    protocols,
    districts,
  )
  return {
    workflow: w,
    district,
    ruleName,
    severity,
    value,
    metric: bound.metric,
    operator: bound.operator,
    threshold: bound.threshold,
    protocol: bound.protocol,
    governed: bound.governed,
    verdict: compare(value, bound.threshold, bound.operator),
  }
}

/**
 * A stable queue order.
 *
 * The cards used to render in whatever order the API returned, which changed
 * with the underlying store — so "the Turkana one is second" stopped being true
 * between one visit and the next, and three identically labelled `Approve`
 * buttons were the only way to tell them apart. Sorted oldest-first, then by
 * district, then by id, so the same queue is the same queue every time.
 */
function sortQueue(entries) {
  return [...entries].sort((a, b) => {
    const at = Date.parse(a.workflow.created_at || '') || 0
    const bt = Date.parse(b.workflow.created_at || '') || 0
    if (at !== bt) return at - bt
    if (a.district !== b.district) return a.district.localeCompare(b.district)
    return String(a.workflow.id).localeCompare(String(b.workflow.id))
  })
}

async function renderPending(workflows, alertIndex = new Map(), protocols = []) {
  if (workflows.length === 0) {
    pendingList.innerHTML = '<div class="queue-empty" data-i18n="focal-point.no_pending">No pending workflows.</div>'
    return
  }

  // Resolved once and cached on the entry, because the confirm modal quotes
  // these facts and the card the operator approved is gone by the time they
  // confirm.
  const districts = knownDistricts(workflows, state.alerts)
  const entries = sortQueue(workflows.map((w) => describeTrigger(w, alertIndex, protocols, districts)))
  state.pending = entries
  const total = entries.length
  pendingList.innerHTML = entries.map((entry, i) => {
    const { workflow: w, district, ruleName, severity, value, metric, operator, threshold, protocol, governed, verdict } = entry
  // This card is the approval gate for an anticipatory trigger. It showed the
  // raw metric key ("precipitation_mm") and left the reading, "40 (value: 48)",
  // for the reader to interpret. It now states the comparison being made, in
  // the metric's own units, and separates the reading from the threshold.
  //
  // The threshold and the direction come from the protocol that governs the
  // trigger. The card used to print the alert's own threshold against a
  // hardcoded `>=`, which meant a drought protocol — `precipitation_mm <= 5` —
  // was shown on the same page as a rainfall reading of 61 against a threshold
  // of 40, and read as though the two agreed.
  const met = verdict === true
  const op = OPERATORS[operator] ? opText(operator) : ''
  return `
    <div class="workflow-card">
      <div class="card-header">
        ${severityChip(severity)}
        <span class="card-district">${escapeHtml(district || 'District not stated')}</span>
        <span class="queue-position">${i + 1} of ${total}</span>
      </div>
      <div class="workflow-consequence">
        Approving releases pre-agreed finance for <strong>${escapeHtml(district || 'this district')}</strong>
        if this trigger is met.
      </div>
      <div class="workflow-details">
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.rule">Rule</span>
          <span class="detail-value">${escapeHtml(ruleName)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.metric">Trigger condition</span>
          <span class="detail-value">${escapeHtml(metricLabel(metric))}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.threshold">Latest reading</span>
          <span class="detail-value ${met ? 'reading-met' : 'reading-unmet'}">
            <span class="reading">${escapeHtml(String(value ?? '—'))}</span>
                    <span class="threshold">against ${escapeHtml(op ? `${opText(op)} ${String(threshold ?? '—')}` : 'a threshold of —')}</span>
            <span class="verdict">${verdict === null ? 'condition could not be evaluated' : met ? 'condition met' : 'condition not met'}</span>
          </span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Governing protocol</span>
          <span class="detail-value">${governed
            ? escapeHtml(protocol.name)
            : `<span class="ungoverned">No live pre-authorised protocol governs this trigger${district ? ` in ${escapeHtml(district)}` : ''}. The threshold above is the alert's own, not one a protocol states.</span>`}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.timestamp">Raised</span>
          <span class="detail-value">${escapeHtml(formatTime(w.created_at))}</span>
        </div>
      </div>
      <div class="action-buttons">
        <button class="btn btn-primary btn-approve" data-workflow-id="${escapeHtml(w.id)}" data-mode="approve" data-i18n="action.approve">Approve</button>
        <button class="btn btn-secondary btn-reject" data-workflow-id="${escapeHtml(w.id)}" data-mode="reject" data-i18n="action.reject">Reject</button>
      </div>
    </div>
  `
  }).join('')

  document.querySelectorAll('[data-workflow-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const workflowId = e.target.dataset.workflowId
      const mode = e.target.dataset.mode
      state.currentWorkflowId = workflowId
      state.currentDialogMode = mode
      openDecisionDialog(mode)
    })
  })
}

async function renderProtocols(protocols) {
  if (protocols.length === 0) {
    protocolsList.innerHTML = '<div class="queue-empty" data-i18n="focal-point.no_protocols">No active protocols.</div>'
    return
  }

  // This was `p.mode === 'live' || p.mode !== 'shadow'`, which is true for
  // every protocol including undefined — a filter that answered no question and
  // looked like it did. Shadow protocols are pre-authorised drafts that have
  // not been activated; showing them beside live ones invites approving one by
  // mistake, so they are labelled rather than silently mixed in.
  const filtered = protocols
  protocolsList.innerHTML = filtered.map((p) => `
    <div class="protocol-item">
      <div>
        <div class="protocol-name">
          ${escapeHtml(p.name)}
          ${p.mode === 'shadow' ? '<span class="chip chip-neutral">shadow — not yet active</span>' : ''}
        </div>
        <div class="protocol-expiry">${escapeHtml(metricLabel(p.metric))} ${escapeHtml(opText(p.operator))} ${escapeHtml(String(p.threshold ?? '—'))}</div>
      </div>
    </div>
  `).join('')
}

async function renderAuditTrail(workflows) {
  const alertIndex = new Map((state.alerts || []).map((a) => [a.id, a]))
  const decisions = []
  for (const w of workflows) {
    const alert = w.subject_kind === 'alert_event' ? alertIndex.get(w.subject_id) : null
    for (const t of w.transitions || []) {
      if (['approved', 'rejected'].includes(t.to)) {
        decisions.push({
          decision: t.to,
          // "anonymous" is the absence of an actor, not a claim by one, and the
          // log used to print it as though somebody called themselves that. The
          // server records how the actor was established; say so.
          actor: t.actor_source === 'unattributed' || !t.actor || t.actor === 'anonymous'
            ? 'no actor recorded'
            : `${t.actor} (self-declared)`,
          district: w.district || 'district not stated',
          subject: alert?.rule_name || w.metadata?.rule_name || 'trigger',
          reason: t.reason || '',
          timestamp: t.timestamp,
        })
      }
    }
  }

  const recent = decisions.slice(-20).reverse()
  if (recent.length === 0) {
    auditList.innerHTML = '<div class="queue-empty" data-i18n="focal-point.no_decisions">No recent decisions.</div>'
    return
  }

  auditList.innerHTML = recent.map((d) => `
    <div class="audit-item">
      <div class="audit-decision">${d.decision === 'approved' ? '✓ Approved' : '✗ Rejected'} by ${escapeHtml(d.actor)}</div>
      <div class="audit-detail">${escapeHtml(d.district)} — ${escapeHtml(d.subject)}</div>
      <div class="audit-detail">${formatTime(d.timestamp)}</div>
      ${d.reason ? `<div class="audit-detail">Reason: ${escapeHtml(d.reason)}</div>` : ''}
    </div>
  `).join('')
}

/**
 * What is being approved, in one sentence, plus the amount.
 *
 * Three cards on this page all carry a button that reads `Approve`, and the
 * modal used to say only "Approve workflow?" with a Reason dropdown — so the
 * last check before money moves named nothing: not the district, not the rule,
 * not the reading it is being judged against, and not the amount. It named the
 * *reason*, which is the one field the operator supplies, over the four they
 * are checking.
 *
 * `tr` is `t` with a fallback: `t` returns the key itself when the catalogue
 * has no entry, so a missing translation renders as `focal-point.confirm_approve`
 * rather than as English.
 */
function decisionSentence(entry) {
  const reading = entry.value ?? '—'
  const bound = `${opText(entry.operator)} ${entry.threshold ?? '—'}`.trim()
  const who = state.identity || 'an unnamed focal point'
  return `${entry.district || 'This district'} — ${entry.ruleName}. `
    + `${metricLabel(entry.metric)} reading ${reading} against ${bound}: `
    + `${entry.verdict === null ? 'not evaluable' : entry.verdict ? 'condition met' : 'condition not met'}. `
    + `Approve as ${who}.`
}

function openDecisionDialog(mode) {
  const options = getReasonOptions(mode)
  reasonSelect.innerHTML = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join('')

  const titleKey = mode === 'approve' ? 'focal-point.confirm_approve' : 'focal-point.confirm_reject'
  decisionTitle.textContent = tr(titleKey, mode === 'approve' ? 'Approve this trigger?' : 'Reject this trigger?')
  dialogConfirmBtn.textContent = mode === 'approve' ? 'Approve' : 'Reject'
  dialogConfirmBtn.style.background = mode === 'approve' ? 'var(--ok)' : 'var(--danger)'

  const entry = (state.pending || []).find((e) => String(e.workflow.id) === String(state.currentWorkflowId))
  if (entry && decisionSummary) {
    const amount = entry.workflow.metadata?.disbursement_amount_local_currency ?? entry.workflow.metadata?.amount
    const currency = entry.workflow.metadata?.currency || ''
    decisionSummary.innerHTML = `
      <div class="summary-line">${escapeHtml(decisionSentence(entry))}</div>
      <div class="summary-line">Amount released: ${amount == null
        ? '<strong>not recorded on this trigger</strong> — the protocol\'s pre-agreed amount is not carried here'
        : `<strong>${escapeHtml(String(amount))} ${escapeHtml(currency)}</strong>`}</div>
      <div class="summary-line">Governing protocol: ${entry.governed
        ? escapeHtml(entry.protocol.name)
        : 'none found — this threshold comes from the alert, not from a protocol'}</div>
    `
  } else if (decisionSummary) {
    decisionSummary.innerHTML = '<div class="summary-line">This trigger is no longer in the queue. Close and reload the page.</div>'
  }

  // The trigger is re-rendered when the list reloads, so focus is captured here
  // and restored on close only if it is still in the document.
  state.dialogReturnFocus = document.activeElement
  decisionDialog.showModal()
}

decisionDialog.addEventListener('close', () => {
  const back = state.dialogReturnFocus
  state.dialogReturnFocus = null
  if (back && document.contains(back) && typeof back.focus === 'function') {
    back.focus({ preventScroll: true })
  } else {
    // The card this decision came from is gone after a reload. Land somewhere
    // real rather than letting focus fall to <body>.
    $('pendingQueue')?.focus?.({ preventScroll: true })
  }
})

/**
 * Clear the pending decision when the dialog goes away by any route.
 *
 * Esc and a backdrop click close a native <dialog> without running the cancel
 * button's handler, so `currentWorkflowId` and `currentDialogMode` survived a
 * dismissal and the next confirm acted on a workflow the operator had already
 * walked away from.
 */
decisionDialog.addEventListener('close', () => {
  state.currentWorkflowId = null
  state.currentDialogMode = null
})

dialogCancelBtn.addEventListener('click', () => {
  decisionDialog.close()
})

decisionDialog.querySelector('.dialog-close').addEventListener('click', () => {
  decisionDialog.close()
  state.currentWorkflowId = null
  state.currentDialogMode = null
})

dialogConfirmBtn.addEventListener('click', async () => {
  if (!state.currentWorkflowId || !state.currentDialogMode) return

  // The trigger is disabled while the transition is in flight so a second click
  // cannot dispatch the same decision twice. Approving releases finance.
  dialogConfirmBtn.disabled = true
  const mode = state.currentDialogMode
  // From the workflow record, not scraped from the DOM. Scraping took the first
  // `.detail-value` on the card, which is the rule name — so the confirmation
  // read "finance is released for Flood Watch: High Precipitation", naming a
  // rule where the operator needed a place.
  const entry = (state.pending || []).find((e) => String(e.workflow.id) === String(state.currentWorkflowId))
  try {
    const nextState = mode === 'approve' ? 'approved' : 'rejected'
    await apiFetch(`/api/v1/workflows/${state.currentWorkflowId}/transition`, {
      method: 'POST',
      body: {
        to: nextState,
        reason: reasonSelect.value,
        evidence: {},
        // Every decision this surface recorded came back as "anonymous", because
        // the transition was posted with no actor at all. The server records
        // this as `claimed` — asserted by the caller, not verified — which is
        // what it is. Sent only when the operator has actually named themselves;
        // an empty name is left off rather than posted as "".
        ...(state.identity ? { actor: state.identity } : {}),
      },
    })
    decisionDialog.close()
    state.currentWorkflowId = null
    state.currentDialogMode = null
    // Say what happened and to whom, in a region that is announced. The status
    // line is visual-only, so a screen-reader user got confirmation of nothing.
    // The sentence names the same four things the modal named: a confirmation
    // that omits them leaves the operator unable to verify afterwards what was
    // released.
    const what = entry ? decisionSentence(entry) : 'The trigger could not be described.'
    announceDecision(
      mode === 'approve'
        ? `Approved. ${what} Pre-agreed finance is released.`
        : `Rejected. ${what} No finance is released.`
    )
    await loadData()
  } catch (error) {
    // `error.message` is a machine handle — "Failed to fetch", "HTTP 502", a
    // field name. It goes to the console, where it is worth something. It does
    // not go into a sentence the operator reads, because there it is noise that
    // looks like an explanation. This is the same sentence every surface now
    // uses for a failed write, so it can be grepped and so it can be learned.
    console.error('focal-point: decision transition failed', error)
    const failure = describeActionFailure({
      action: 'record the decision',
      nextStep: 'Nothing was approved or rejected, and the queue is unchanged. Try again.',
    })
    announceDecision(`${failure.title}. ${failure.body}`)
    statusText.textContent = failure.title
    statusText.dataset.state = ERROR
  } finally {
    dialogConfirmBtn.disabled = false
  }
})

/** Say what a decision did, where both sighted and screen-reader users read it. */
function announceDecision(message) {
  const el = $('decisionOutcome')
  if (!el) return
  el.hidden = false
  // Re-setting identical text does not re-announce; clear first.
  el.textContent = ''
  requestAnimationFrame(() => { el.textContent = message })
}

// escapeHtml now comes from /shared/fmt.js. It was a fourth copy of the
// same function; this one used `||`, which dropped a legitimate 0 or false.

window.addEventListener('online', () => {
  connectionStatus.style.color = 'var(--ok)'
  loadData()
})

window.addEventListener('offline', () => {
  connectionStatus.style.color = 'var(--sev-high)'
})

await initI18n(state.locale)
applyLocaleToDocument(state.locale)
autoMarkScrollableRegions()
// lang/dir come from applyLocaleToDocument, which reads the shared
// locale table. This was a hand-copied second RTL list.
loadData()
