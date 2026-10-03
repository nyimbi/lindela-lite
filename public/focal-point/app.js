import { initI18n, t, apiFetch, initOfflineBanner, initServiceWorker } from '/shared/runtime.js'
import { esc as escapeHtml, formatTimestamp, sevClass } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'
import { mountNavbar } from '/shared/navbar.js'
mountNavbar({ activePath: '/focal-point' })

// Registration used to be hand-rolled here *and* performed by initServiceWorker
// further down: two registrations for one worker.
initServiceWorker()

const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  identity: localStorage.getItem('lindela_lite_focal_point') || 'focal-point',
  currentDialogMode: null,
  currentWorkflowId: null,
}

const $ = (id) => document.getElementById(id)

const pendingList = $('pendingList')
const protocolsList = $('protocolsList')
const auditList = $('auditList')
const fpIdentity = $('fp-identity')
const connectionStatus = $('connectionStatus')
const statusText = $('statusText')
const localeSelect = $('locale-select')
const signoutBtn = $('signoutBtn')

const decisionDialog = $('decisionDialog')
const reasonSelect = $('reasonSelect')
const dialogConfirmBtn = $('dialogConfirmBtn')
const dialogCancelBtn = $('dialogCancelBtn')
const decisionTitle = $('decisionTitle')

initOfflineBanner()
initServiceWorker()

localeSelect.value = state.locale
localeSelect.addEventListener('change', async (e) => {
  state.locale = e.target.value
  localStorage.setItem('lindela_lite_locale', state.locale)
  await window.__i18n.set(state.locale)
  document.documentElement.lang = state.locale
  document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr'
})

signoutBtn.addEventListener('click', () => {
  localStorage.removeItem('lindela_lite_api_key')
  localStorage.removeItem('lindela_lite_focal_point')
  window.location.href = '/'
})

async function loadData() {
  try {
    connectionStatus.textContent = '●'
    connectionStatus.style.color = '#10b981'
    statusText.textContent = 'Loading...'

    const [workflows, protocols, alertsResp] = await Promise.all([
      apiFetch(`/api/v1/workflows?type=anticipatory_alert&state=focal_point_review`),
      apiFetch(`/api/v1/trigger-protocols`),
      apiFetch(`/api/v1/alert-events`),
    ])

    // Index alert events by id for O(1) card hydration
    const alertIndex = new Map((alertsResp.data || []).map((a) => [a.id, a]))

    fpIdentity.textContent = `${state.identity} (${state.locale})`
    await renderPending(workflows.data || [], alertIndex)
    await renderProtocols(protocols.data || [])
    await renderAuditTrail(workflows.data || [])
    statusText.textContent = 'Ready'
  } catch (error) {
    connectionStatus.style.color = '#ef4444'
    statusText.textContent = `Error: ${error.message}`
  }
}

function severityClass(severity) {
  // Allowlisted: this value came off the API and was interpolated straight
  // into a class name.
  return `severity-${sevClass(severity)}`
}

/** Absolute, with its zone. `toLocaleString` gave "9/28/2026, 6:55:29 AM". */
function formatTime(iso) {
  return formatTimestamp(iso, { dash: '' })
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

async function renderPending(workflows, alertIndex = new Map()) {
  if (workflows.length === 0) {
    pendingList.innerHTML = '<div class="queue-empty" data-i18n="focal-point.no_pending">No pending workflows.</div>'
    return
  }

  const total = workflows.length
  pendingList.innerHTML = workflows.map((w, i) => {
    // Hydrate display fields from the linked alert_event when available
    const alert = (w.subject_kind === 'alert_event' && w.subject_id)
      ? (alertIndex.get(w.subject_id) || null)
      : null
    const ruleName = alert?.rule_name || w.metadata?.rule_name || 'Unknown'
    const metric   = alert?.metric   || w.metadata?.metric   || ''
    const threshold = alert?.threshold ?? w.metadata?.threshold
    const value     = alert?.value     ?? w.metadata?.value
    const severity  = alert?.severity  || w.metadata?.severity || 'medium'
    // This card is the approval gate for an anticipatory trigger. It showed the
  // raw metric key ("precipitation_mm") and left the reading, "40 (value: 48)",
  // for the reader to interpret. It now states the comparison being made, in
  // the metric's own units, and separates the reading from the threshold.
  const above = value != null && threshold != null && Number(value) >= Number(threshold)
  return `
    <div class="workflow-card">
      <div class="card-header">
        <span class="severity-chip ${severityClass(severity)}">${escapeHtml(severity)}</span>
        <span class="queue-position">${i + 1} of ${total}</span>
      </div>
      <div class="workflow-consequence">
        Approving releases pre-agreed finance for <strong>${escapeHtml(w.district || 'this district')}</strong>
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
          <span class="detail-value ${above ? 'reading-met' : 'reading-unmet'}">
            <span class="reading">${escapeHtml(String(value ?? '—'))}</span>
            <span class="threshold">against a threshold of ${escapeHtml(String(threshold ?? '—'))}</span>
            <span class="verdict">${above ? 'condition met' : 'condition not met'}</span>
          </span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.district">District</span>
          <span class="detail-value">${escapeHtml(w.district || '—')}</span>
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
        <div class="protocol-expiry">${escapeHtml(metricLabel(p.metric))} ≥ ${escapeHtml(String(p.threshold ?? '—'))}</div>
      </div>
    </div>
  `).join('')
}

async function renderAuditTrail(workflows) {
  const decisions = []
  for (const w of workflows) {
    for (const t of w.transitions || []) {
      if (['approved', 'rejected'].includes(t.to)) {
        decisions.push({
          decision: t.to,
          actor: t.actor || 'system',
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
      <div class="audit-detail">${formatTime(d.timestamp)}</div>
      ${d.reason ? `<div class="audit-detail">Reason: ${escapeHtml(d.reason)}</div>` : ''}
    </div>
  `).join('')
}

function openDecisionDialog(mode) {
  const options = getReasonOptions(mode)
  reasonSelect.innerHTML = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join('')

  const titleKey = mode === 'approve' ? 'focal-point.confirm_approve' : 'focal-point.confirm_reject'
  decisionTitle.textContent = t(titleKey) || (mode === 'approve' ? 'Approve workflow?' : 'Reject workflow?')
  dialogConfirmBtn.textContent = mode === 'approve' ? 'Approve' : 'Reject'
  dialogConfirmBtn.style.background = mode === 'approve' ? 'var(--focal-point-approve-bg, #10b981)' : 'var(--focal-point-reject-bg, #ef4444)'

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
  const district = pendingList?.querySelector(`[data-workflow-id="${CSS.escape(state.currentWorkflowId)}"]`)
    ?.closest('.workflow-card')?.querySelector('.detail-row .detail-value')?.textContent?.trim()

  try {
    const nextState = mode === 'approve' ? 'approved' : 'rejected'
    await apiFetch(`/api/v1/workflows/${state.currentWorkflowId}/transition`, {
      method: 'POST',
      body: {
        to: nextState,
        reason: reasonSelect.value,
        evidence: {},
      },
    })
    decisionDialog.close()
    state.currentWorkflowId = null
    state.currentDialogMode = null
    // Say what happened and to whom, in a region that is announced. The status
    // line is visual-only, so a screen-reader user got confirmation of nothing.
    announceDecision(
      mode === 'approve'
        ? `Approved. Pre-agreed finance is released for ${district || 'the district'}.`
        : `Rejected. No finance is released for ${district || 'the district'}.`
    )
    await loadData()
  } catch (error) {
    announceDecision(`Could not record the decision: ${error.message}. Nothing was changed.`)
    statusText.textContent = `Error: ${error.message}`
  } finally {
    dialogConfirmBtn.disabled = false
  }
})

/** Announce a decision outcome to assistive technology. */
function announceDecision(message) {
  const el = $('decisionOutcome')
  if (!el) return
  // Re-setting identical text does not re-announce; clear first.
  el.textContent = ''
  requestAnimationFrame(() => { el.textContent = message })
}

// escapeHtml now comes from /shared/fmt.js. It was a fourth copy of the
// same function; this one used `||`, which dropped a legitimate 0 or false.

window.addEventListener('online', () => {
  connectionStatus.style.color = '#10b981'
  loadData()
})

window.addEventListener('offline', () => {
  connectionStatus.style.color = '#ef4444'
})

await initI18n(state.locale)
document.documentElement.lang = state.locale
document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr'
loadData()
