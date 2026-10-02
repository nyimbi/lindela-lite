// Parametric disbursement UI — testnet only
//
// This file was a light-theme holdout: pastels like #f0fdf4 and #374151 inline
// on every panel, `#6b7280` for muted text at 12px, `new Date(...).toLocaleString()`
// for timestamps, an `onclick="return false"` where a link should not have been,
// and a table whose 32-character identifiers were wide enough to push the last
// column off the right edge of the viewport with no way to scroll to it.

import { apiFetch } from '/shared/runtime.js'
import { esc, formatTimestamp, num, truncateId } from '/shared/fmt.js'

const BASE = '/api/v1'

// State
let rules = []
let disbursements = []

/** Metric keys arrive as raw field names; the UI shows what they measure. */
const METRIC_LABELS = {
  precipitation_mm: 'Rainfall (mm)',
  temperature_max_c: 'Peak temperature (°C)',
  conflict_events_count_7d: 'Conflict events (7d)',
}

const metricLabel = (key) => (key && METRIC_LABELS[key]) || key || '—'

function setError(id, message) {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = message || ''
  el.hidden = !message
}

async function loadRules() {
  try {
    const json = await apiFetch(BASE + '/parametric-rules')
    rules = json.data || []
  } catch {
    rules = []
  }
  renderRules()
  renderSimPicker()
}

async function loadDisbursements() {
  try {
    const json = await apiFetch(BASE + '/parametric-disbursements')
    disbursements = json.data || []
  } catch {
    disbursements = []
  }
  renderHistory()
}

function renderRules() {
  const list = document.getElementById('rulesList')
  if (!list) return
  if (!rules.length) {
    list.innerHTML = '<p class="empty-note">No rules defined yet. Add one below to start simulating.</p>'
    return
  }
  list.innerHTML = rules.map((r) => `
    <div class="rule-card">
      <div class="rule-head">
        <strong>${esc(r.name)}</strong>
        <span class="chain-badge">${esc(r.chain)}</span>
        <span class="muted-sm">${esc(r.status)}</span>
      </div>
      <div class="rule-meta">
        <span><span class="meta-key">Triggers when</span> ${esc(metricLabel(r.trigger_metric))} ${r.trigger_threshold === null || r.trigger_threshold === undefined ? '' : `≥ ${esc(r.trigger_threshold)}`}</span>
        <span><span class="meta-key">Releases</span> ${num(r.disbursement_amount_local_currency, { int: true })} ${esc(r.currency || '')}</span>
        <span><span class="meta-key">Focal point approval</span> ${r.requires_focal_point_approval ? 'required' : 'not required'}</span>
      </div>
    </div>
  `).join('')
}

/**
 * Show the picker once a rule exists.
 *
 * The form used to hide itself the moment any rule was present, so the app
 * silently became read-only after the first rule with nothing on screen saying
 * so. Adding a rule is the normal thing to do from this screen.
 */
function renderSimPicker() {
  const picker = document.getElementById('simRulePicker')
  const section = document.getElementById('simSection')
  const form = document.getElementById('simForm')
  if (!picker || !section || !form) return
  if (!rules.length) {
    section.hidden = false
    form.hidden = true
    return
  }
  section.hidden = true
  form.hidden = false
  picker.innerHTML = rules.map((r) =>
    `<option value="${esc(r.id)}">${esc(r.name)} (${esc(r.chain)})</option>`
  ).join('')
}

function renderHistory() {
  const tbody = document.getElementById('historyBody')
  if (!tbody) return
  if (!disbursements.length) {
    // Eight columns, so the empty row spans eight.
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No simulations yet.</td></tr>'
    return
  }
  tbody.innerHTML = disbursements.map((d) => {
    const rule = rules.find((r) => r.id === d.rule_id)
    return `<tr>
      <td class="mono-sm" title="${esc(d.disbursement_id)}">${esc(truncateId(d.disbursement_id, { head: 6, tail: 5 }))}</td>
      <td>${esc(rule?.name || d.rule_id)}</td>
      <td><span class="chain-badge">${esc(d.chain)}</span></td>
      <td><span class="chain-badge" title="${esc(d.tx_hash)}">${esc(truncateId(d.tx_hash, { head: 6, tail: 4 }))}</span></td>
      <td class="num-cell">${num(d.amount, { int: true })} ${esc(d.currency || '')}</td>
      <td>${esc(d.status)}</td>
      <td class="muted-sm">${esc(screeningLabel(d))}</td>
      <td class="muted-sm nowrap">${esc(formatTimestamp(d.simulated_at))}</td>
    </tr>`
  }).join('')
}

/**
 * Render a simulation result, including what the sanctions screening did.
 *
 * The screening state used to be absent from this panel entirely: a green
 * "Simulation complete" for a 5,000 USD disbursement, with no indication that
 * no name had been screened. A reader could reasonably conclude the OFAC check
 * described in the README had run. A compliance-relevant fact must never be
 * invisible, so it is stated here whatever the outcome — screened and clear,
 * or not screened at all.
 */
function sanctionsBanner(result) {
  const status = result.sanctions_status
  const messages = {
    clear: 'Screened against the OFAC SDN list — no match.',
    not_screened: 'Not screened: no recipient name was supplied, so nothing was checked against the OFAC SDN list.',
    blocked: 'Blocked: a sanctions match requires compliance review.',
  }
  const kind = status === 'clear' ? 'ok' : status === 'blocked' ? 'danger' : 'warn'
  const text = messages[status] || 'Screening state not reported by the server.'
  const detail = result.sanctions_reason ? ` ${esc(result.sanctions_reason)}.` : ''
  return `<div class="notice notice-${kind}">
    <strong>Sanctions screening:</strong> ${esc(text)}${detail}
  </div>`
}

function renderSimResult(result) {
  const box = document.getElementById('simResult')
  if (!box) return
  box.hidden = false
  box.innerHTML = `
    <div class="notice notice-ok notice-block">
      <strong>Simulation complete.</strong> Nothing was moved: this is a testnet simulation.
      ${sanctionsBanner(result)}
      <dl class="result-grid">
        <dt>Transaction reference</dt>
        <dd><span class="sim-tx">${esc(truncateId(result.tx_hash, { head: 10, tail: 8 }))}</span>
            <span class="muted-sm">local digest, not a blockchain transaction</span></dd>
        <dt>Chain</dt>
        <dd>${esc(result.chain)}</dd>
        <dt>Amount</dt>
        <dd>${num(result.amount, { int: true })} ${esc(result.currency || '')}</dd>
        <dt>Status</dt>
        <dd>${esc(result.status)}</dd>
        <dt>Simulated</dt>
        <dd>${esc(formatTimestamp(result.simulated_at))}</dd>
      </dl>
    </div>
  `
}

/** Short screening state for the disbursements table. Never blank. */
function screeningLabel(d) {
  if (d.sanctions_status) return d.sanctions_status.replace(/_/g, ' ')
  return d.sanctions_screened ? 'screened clear' : 'not screened'
}

// Add rule form
document.getElementById('addRuleForm')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  setError('addRuleError', '')
  const value = (id) => document.getElementById(id)?.value?.trim() || null
  const body = {
    name: value('ruleName'),
    chain: value('ruleChain'),
    trigger_metric: value('ruleTriggerMetric'),
    trigger_threshold: value('ruleTriggerThreshold') ? Number(value('ruleTriggerThreshold')) : null,
    disbursement_amount_local_currency: value('ruleAmount') ? Number(value('ruleAmount')) : null,
    currency: value('ruleCurrency') || 'USD',
    recipient_group_id: value('ruleRecipientGroup'),
    requires_focal_point_approval: document.getElementById('ruleFocalPoint')?.checked ?? false,
  }
  if (!body.name) { setError('addRuleError', 'Give the rule a name.'); return }
  try {
    await apiFetch(BASE + '/parametric-rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    e.target.reset()
    await loadRules()
  } catch (err) {
    setError('addRuleError', err.message)
  }
})

// Simulate form
document.getElementById('simForm')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  setError('simError', '')
  const ruleId = document.getElementById('simRulePicker')?.value
  const focal_point_approved = document.getElementById('simFocalApproved')?.checked ?? false
  const recipient_name = document.getElementById('simRecipientName')?.value?.trim() || null
  if (!ruleId) { setError('simError', 'Choose a rule to simulate.'); return }
  try {
    const json = await apiFetch(`${BASE}/parametric-rules/${encodeURIComponent(ruleId)}/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ focal_point_approved, recipient_name, actor: 'ui_operator' }),
    })
    renderSimResult(json.data)
    await loadDisbursements()
  } catch (err) {
    setError('simError', err.message)
  }
})

// Init. Rules first: the history table resolves each row's rule name by id, and
// firing both at once let the history render against an empty rules list, so
// every row fell back to the raw rule id ("pr-3").
loadRules().then(loadDisbursements)