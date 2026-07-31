import { initI18n, t, apiFetch, initOfflineBanner, initServiceWorker } from '/shared/runtime.js'
import { mountNavbar } from '/shared/navbar.js'
mountNavbar({ activePath: '/focal-point' })

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

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

    const [workflows, protocols] = await Promise.all([
      apiFetch(`/api/v1/workflows?type=anticipatory_alert&state=focal_point_review`),
      apiFetch(`/api/v1/trigger-protocols`)
    ])

    fpIdentity.textContent = `${state.identity} (${state.locale})`
    await renderPending(workflows.data || [])
    await renderProtocols(protocols.data || [])
    await renderAuditTrail(workflows.data || [])
    statusText.textContent = 'Ready'
  } catch (error) {
    connectionStatus.style.color = '#ef4444'
    statusText.textContent = `Error: ${error.message}`
  }
}

function severityClass(severity) {
  return `severity-${severity || 'medium'}`
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(state.locale)
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

async function renderPending(workflows) {
  if (workflows.length === 0) {
    pendingList.innerHTML = '<div class="queue-empty" data-i18n="focal-point.no_pending">No pending workflows.</div>'
    return
  }

  pendingList.innerHTML = workflows.map((w) => `
    <div class="workflow-card">
      <div class="card-header">
        <span class="severity-chip ${severityClass(w.metadata?.severity || 'medium')}">${w.metadata?.severity || 'medium'}</span>
      </div>
      <div class="workflow-details">
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.rule">Rule</span>
          <span class="detail-value">${escapeHtml(w.metadata?.rule_name || 'Unknown')}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.metric">Metric</span>
          <span class="detail-value">${escapeHtml(w.metadata?.metric || '')}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.threshold">Threshold</span>
          <span class="detail-value">${w.metadata?.threshold} (value: ${w.metadata?.value})</span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.district">District</span>
          <span class="detail-value">${escapeHtml(w.district || '')}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label" data-i18n="label.timestamp">Time</span>
          <span class="detail-value">${formatTime(w.created_at)}</span>
        </div>
      </div>
      <div class="action-buttons">
        <button class="btn-approve" data-workflow-id="${w.id}" data-mode="approve" data-i18n="action.approve">Approve</button>
        <button class="btn-reject" data-workflow-id="${w.id}" data-mode="reject" data-i18n="action.reject">Reject</button>
      </div>
    </div>
  `).join('')

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

  const filtered = protocols.filter((p) => p.mode === 'live' || p.mode !== 'shadow')
  protocolsList.innerHTML = filtered.map((p) => `
    <div class="protocol-item">
      <div>
        <div class="protocol-name">${escapeHtml(p.name)}</div>
        <div class="protocol-expiry">${p.metric} >= ${p.threshold}</div>
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

  decisionDialog.showModal()
}

dialogCancelBtn.addEventListener('click', () => {
  decisionDialog.close()
  state.currentWorkflowId = null
  state.currentDialogMode = null
})

decisionDialog.querySelector('.dialog-close').addEventListener('click', () => {
  decisionDialog.close()
  state.currentWorkflowId = null
  state.currentDialogMode = null
})

dialogConfirmBtn.addEventListener('click', async () => {
  if (!state.currentWorkflowId || !state.currentDialogMode) return

  try {
    const nextState = state.currentDialogMode === 'approve' ? 'approved' : 'rejected'
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
    await loadData()
  } catch (error) {
    statusText.textContent = `Error: ${error.message}`
  }
})

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]))
}

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
