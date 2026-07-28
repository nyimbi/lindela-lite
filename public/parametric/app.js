// Parametric disbursement UI — testnet only

const BASE = '/api/v1'

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, opts)
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

// State
let rules = []
let disbursements = []

async function loadRules() {
  try {
    const json = await apiFetch('/parametric-rules')
    rules = json.data || []
  } catch {
    rules = []
  }
  renderRules()
  renderSimPicker()
}

async function loadDisbursements() {
  try {
    const json = await apiFetch('/parametric-disbursements')
    disbursements = json.data || []
  } catch {
    disbursements = []
  }
  renderHistory()
}

function renderRules() {
  const list = document.getElementById('rulesList')
  if (!rules.length) {
    list.innerHTML = '<p style="color:#6b7280;font-size:0.875rem">No rules yet.</p>'
    return
  }
  list.innerHTML = rules.map((r) => `
    <div class="rule-card">
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <strong>${esc(r.name)}</strong>
        <span class="chain-badge">${esc(r.chain)}</span>
        <span style="font-size:0.75rem;color:#6b7280">${esc(r.status)}</span>
      </div>
      <div style="font-size:0.75rem;color:#374151;margin-top:0.4rem">
        Trigger: ${esc(r.trigger_metric || '—')} ≥ ${r.trigger_threshold ?? '—'} &nbsp;|&nbsp;
        Amount: ${r.disbursement_amount_local_currency ?? '—'} ${esc(r.currency || '')} &nbsp;|&nbsp;
        FP required: ${r.requires_focal_point_approval ? 'Yes' : 'No'}
      </div>
    </div>
  `).join('')
}

function renderSimPicker() {
  const picker = document.getElementById('simRulePicker')
  const section = document.getElementById('simSection')
  const form = document.getElementById('simForm')
  if (!rules.length) {
    section.style.display = ''
    form.style.display = 'none'
    return
  }
  section.style.display = 'none'
  form.style.display = ''
  picker.innerHTML = rules.map((r) =>
    `<option value="${esc(r.id)}">${esc(r.name)} (${esc(r.chain)})</option>`
  ).join('')
}

function renderHistory() {
  const tbody = document.getElementById('historyBody')
  if (!disbursements.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:#6b7280;text-align:center">No simulations yet.</td></tr>'
    return
  }
  tbody.innerHTML = disbursements.map((d) => {
    const rule = rules.find((r) => r.id === d.rule_id)
    const txLink = `<span class="chain-badge">${esc(d.tx_hash)}</span> <small style="color:#6b7280">(no real tx)</small>`
    return `<tr>
      <td style="font-family:monospace;font-size:0.75rem">${esc(d.disbursement_id)}</td>
      <td>${esc(rule?.name || d.rule_id)}</td>
      <td><span class="chain-badge">${esc(d.chain)}</span></td>
      <td>${txLink}</td>
      <td>${d.amount ?? '—'} ${esc(d.currency || '')}</td>
      <td>${esc(d.status)}</td>
      <td style="font-size:0.75rem">${d.simulated_at ? new Date(d.simulated_at).toLocaleString() : '—'}</td>
    </tr>`
  }).join('')
}

function renderSimResult(result) {
  const box = document.getElementById('simResult')
  box.style.display = ''
  box.innerHTML = `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:0.5rem;padding:1rem">
      <strong>Simulation complete</strong>
      <div style="margin-top:0.5rem;font-size:0.875rem">
        Tx hash: <span class="sim-tx">${esc(result.tx_hash)}</span>
        <a href="#" onclick="return false" style="font-size:0.75rem;color:#6b7280;margin-left:0.5rem">(testnet explorer — no live link)</a>
      </div>
      <div style="font-size:0.75rem;color:#374151;margin-top:0.4rem">
        Chain: ${esc(result.chain)} &nbsp;|&nbsp;
        Amount: ${result.amount ?? '—'} ${esc(result.currency || '')} &nbsp;|&nbsp;
        Status: ${esc(result.status)} &nbsp;|&nbsp;
        Simulated: ${result.simulated_at ? new Date(result.simulated_at).toLocaleString() : '—'}
      </div>
    </div>
  `
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Add rule form
document.getElementById('addRuleForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = document.getElementById('addRuleError')
  errEl.style.display = 'none'
  const body = {
    name: document.getElementById('ruleName').value.trim(),
    chain: document.getElementById('ruleChain').value,
    trigger_metric: document.getElementById('ruleTriggerMetric').value.trim() || null,
    trigger_threshold: document.getElementById('ruleTriggerThreshold').value
      ? Number(document.getElementById('ruleTriggerThreshold').value)
      : null,
    disbursement_amount_local_currency: document.getElementById('ruleAmount').value
      ? Number(document.getElementById('ruleAmount').value)
      : null,
    currency: document.getElementById('ruleCurrency').value.trim() || 'USD',
    recipient_group_id: document.getElementById('ruleRecipientGroup').value.trim() || null,
    requires_focal_point_approval: document.getElementById('ruleFocalPoint').checked,
  }
  try {
    await apiFetch('/parametric-rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    e.target.reset()
    await loadRules()
  } catch (err) {
    errEl.textContent = err.message
    errEl.style.display = ''
  }
})

// Simulate form
document.getElementById('simForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = document.getElementById('simError')
  errEl.style.display = 'none'
  const ruleId = document.getElementById('simRulePicker').value
  const focal_point_approved = document.getElementById('simFocalApproved').checked
  try {
    const json = await apiFetch(`/parametric-rules/${encodeURIComponent(ruleId)}/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ focal_point_approved, actor: 'ui_operator' }),
    })
    renderSimResult(json.data)
    await loadDisbursements()
  } catch (err) {
    errEl.textContent = err.message
    errEl.style.display = ''
  }
})

// Init
loadRules()
loadDisbursements()
