// Parametric disbursement UI — testnet only
//
// This file was a light-theme holdout: pastels like #f0fdf4 and #374151 inline
// on every panel, `#6b7280` for muted text at 12px, `new Date(...).toLocaleString()`
// for timestamps, an `onclick="return false"` where a link should not have been,
// and a table whose 32-character identifiers were wide enough to push the last
// column off the right edge of the viewport with no way to scroll to it.

import { initI18n, t as lookup, apiFetch } from '/shared/runtime.js'
import { esc, formatTimestamp, num, truncateId } from '/shared/fmt.js'

const BASE = '/api/v1'

// State
let rules = []
let disbursements = []
/** The last simulation panel on screen, kept so a locale switch can redraw it. */
let lastResult = null
let locale = 'en'

/**
 * `t` with the English sentence carried at the call site.
 *
 * The shared runtime resolves a key no catalogue defines to the key itself,
 * which is right for a module that has no opinion about what the sentence was
 * meant to say, and wrong on this page: the strings here state what a trigger
 * releases and what a sanctions match blocks. `parametric.screening_blocked`
 * standing where the sentence says the payout is held is a materially worse
 * defect than that sentence not being translated, so a missing key falls back
 * to English rather than to a key name.
 */
function t(key, fallback) {
  const text = lookup(key)
  return text === key ? fallback : text
}

/**
 * Metric keys arrive as raw field names; the UI shows what they measure.
 *
 * A function rather than a table because the table would have to be built at
 * module load, which is before the catalogue has been fetched — the labels
 * would be frozen in English for the life of the page no matter which language
 * the reader then chose. The unit is part of the label and is not translated:
 * the number beside it is compared against this exact unit by the server.
 */
function metricLabel(key) {
  const labels = {
    precipitation_mm: ['parametric.metric_precipitation', 'Rainfall (mm)'],
    temperature_max_c: ['parametric.metric_temperature', 'Peak temperature (°C)'],
    conflict_events_count_7d: ['parametric.metric_conflict', 'Conflict events (7d)'],
  }
  if (key && labels[key]) return t(labels[key][0], labels[key][1])
  return key || '—'
}

/** Redraw everything the last load painted, in whatever language is now current. */
function renderAll() {
  renderRules()
  renderSimPicker()
  renderHistory()
  if (lastResult) renderSimResult(lastResult)
}

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
    list.innerHTML = `<p class="empty-note">${esc(t('parametric.rules_empty', 'No rules defined yet. Add one below to start simulating.'))}</p>`
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
        <span><span class="meta-key">${esc(t('parametric.meta_triggers_when', 'Triggers when'))}</span> ${esc(metricLabel(r.trigger_metric))} ${r.trigger_threshold === null || r.trigger_threshold === undefined ? '' : `≥ ${esc(r.trigger_threshold)}`}</span>
        <span><span class="meta-key">${esc(t('parametric.meta_releases', 'Releases'))}</span> ${num(r.disbursement_amount_local_currency, { int: true })} ${esc(r.currency || '')}</span>
        <span><span class="meta-key">${esc(t('parametric.meta_focal_approval', 'Focal point approval'))}</span> ${esc(r.requires_focal_point_approval ? t('parametric.approval_required', 'required') : t('parametric.approval_not_required', 'not required'))}</span>
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
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">${esc(t('parametric.history_empty', 'No simulations yet.'))}</td></tr>`
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
 *
 * These three sentences are the ones on this surface that state a rule the
 * product enforces rather than decorate it: `blocked` is what stops a
 * disbursement. They are keyed like everything else, but a translator has to
 * move "blocks" without softening it into something advisory, so the English
 * fallback is written to leave no room for that reading.
 */
function sanctionsBanner(result) {
  const status = result.sanctions_status
  const messages = {
    clear: t('parametric.screening_clear', 'Screened against the OFAC SDN list — no match.'),
    not_screened: t('parametric.screening_not_screened', 'Not screened: no recipient name was supplied, so nothing was checked against the OFAC SDN list.'),
    blocked: t('parametric.screening_blocked', 'Blocked: a sanctions match requires compliance review. The disbursement will not proceed until it is cleared.'),
  }
  const kind = status === 'clear' ? 'ok' : status === 'blocked' ? 'danger' : 'warn'
  const text = messages[status] || t('parametric.screening_unknown', 'Screening state not reported by the server.')
  const detail = result.sanctions_reason ? ` ${esc(result.sanctions_reason)}.` : ''
  return `<div class="notice notice-${kind}">
    <strong>${esc(t('parametric.screening_heading', 'Sanctions screening:'))}</strong> ${esc(text)}${detail}
  </div>`
}

function renderSimResult(result) {
  const box = document.getElementById('simResult')
  if (!box) return
  box.hidden = false
  box.innerHTML = `
    <div class="notice notice-ok notice-block">
      <strong>${esc(t('parametric.sim_complete', 'Simulation complete.'))}</strong>
      <span>${esc(t('parametric.sim_nothing_moved', 'Nothing was moved: this is a testnet simulation.'))}</span>
      ${sanctionsBanner(result)}
      <dl class="result-grid">
        <dt>${esc(t('parametric.result_tx_ref', 'Transaction reference'))}</dt>
        <dd><span class="sim-tx">${esc(truncateId(result.tx_hash, { head: 10, tail: 8 }))}</span>
            <span class="muted-sm">${esc(t('parametric.result_tx_local', 'local digest, not a blockchain transaction'))}</span></dd>
        <dt>${esc(t('parametric.col_chain', 'Chain'))}</dt>
        <dd>${esc(result.chain)}</dd>
        <dt>${esc(t('parametric.col_amount', 'Amount'))}</dt>
        <dd>${num(result.amount, { int: true })} ${esc(result.currency || '')}</dd>
        <dt>${esc(t('parametric.col_status', 'Status'))}</dt>
        <dd>${esc(result.status)}</dd>
        <dt>${esc(t('parametric.result_simulated', 'Simulated'))}</dt>
        <dd>${esc(formatTimestamp(result.simulated_at))}</dd>
      </dl>
    </div>
  `
}

/** Short screening state for the disbursements table. Never blank. */
function screeningLabel(d) {
  if (d.sanctions_status) return d.sanctions_status.replace(/_/g, ' ')
  return d.sanctions_screened
    ? t('parametric.screened_clear', 'screened clear')
    : t('parametric.not_screened', 'not screened')
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
  if (!body.name) { setError('addRuleError', t('parametric.error_name_required', 'Give the rule a name.')); return }
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
  if (!ruleId) { setError('simError', t('parametric.error_rule_required', 'Choose a rule to simulate.')); return }
  try {
    const json = await apiFetch(`${BASE}/parametric-rules/${encodeURIComponent(ruleId)}/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ focal_point_approved, recipient_name, actor: 'ui_operator' }),
    })
    lastResult = json.data
    renderSimResult(json.data)
    await loadDisbursements()
  } catch (err) {
    setError('simError', err.message)
  }
})

async function init() {
  const sel = document.getElementById('locale-select')
  // English is the only locale offered, and it is the base layer every other
  // catalogue falls back to, so the stored preference is honoured only when it
  // names a language this page can actually render. Accepting a stored `sw`
  // here and rendering key names is the failure scripts/check-i18n.mjs exists
  // to prevent, and localStorage is shared across surfaces — a reader who chose
  // Swahili on the console lands here with `sw` already in it.
  const stored = localStorage.getItem('lindela_lite_locale')
  const OFFERED = ['en']
  locale = OFFERED.includes(stored) ? stored : 'en'

  await initI18n(locale)
  if (sel) {
    sel.value = locale
    sel.addEventListener('change', async (e) => {
      locale = e.target.value
      localStorage.setItem('lindela_lite_locale', locale)
      await window.__i18n.set(locale)
      // `set` re-applies every `data-i18n` in the document, so the static
      // markup is already current; what it cannot reach is the panels this file
      // built as HTML strings, which is why they are redrawn rather than
      // considered done.
      renderAll()
    })
  }

  // Init. Rules first: the history table resolves each row's rule name by id,
  // and firing both at once let the history render against an empty rules list,
  // so every row fell back to the raw rule id ("pr-3").
  await loadRules()
  await loadDisbursements()
}

init()