/**
 * The Settings panel: its rendering and the operations forms behind it.
 *
 * Fetched with the panel's markup, like the other deferred panels' behaviour.
 * Every control here is for a route or a workflow an operator opens Settings to
 * configure and nobody touches on the first load, and `check-budget` measures
 * the console's first load on a field connection — so this code is parsed on
 * every load to render a screen that usually is not.
 *
 * The console passes itself in rather than being imported: importing `app.js`
 * here would load the whole console to render a settings list.
 */

export function mount(console_) {
  const {
    $, state, escapeHtml, fetchJson, lazy, setStatus, queueRequest, refresh,
    bindApiKeyInput, reportsPanel, postJson, patchJson, safeClass,
  } = console_

  // Captured from the confirm module when it loads (same lazy chain as the
  // operations controls). Switching a protocol to live is the one destructive
  // direction here — it removes the human gate — so it gets the confirm dialog.
  let askToConfirm = null

  const OPERATORS = ['>=', '>', '<=', '<', '==', '!=']
  const COMBINATOR_WORD = { and: 'ALL of', or: 'ANY of', xor: 'EXACTLY ONE of' }

  function describeLogic(p) {
    const set = p.condition_set
    if (!set?.terms?.length) return `${p.metric} ${p.operator} ${p.threshold}`
    const terms = set.terms
      .map((t) => `${t.negate ? 'NOT ' : ''}${t.metric} ${t.operator} ${t.threshold}`)
      .join('  ·  ')
    return `When ${COMBINATOR_WORD[set.combinator] || 'ALL of'}: ${terms}${set.negate ? '  —  and the combination is INVERTED (fires when it does not hold)' : ''}`
  }

  function renderProtocolList() {
    const list = $('triggerProtocolsList')
    if (!list) return
    fetchJson('/api/v1/trigger-protocols').then((payload) => {
      const protos = payload.data || []
      list.innerHTML = protos.length
        ? protos.map((p) => `<div class="proto-protocol-row" data-protocol="${escapeHtml(p.id)}">
            <div class="proto-protocol-head">
              <strong>${escapeHtml(p.name || p.id)}</strong>
              <span>
                <span class="proto-mode-pill" data-mode="${escapeHtml(p.mode || 'shadow')}">${escapeHtml(p.mode || 'shadow')}</span>
                <button type="button" class="btn btn-sm" data-op="toggle-mode" data-next="${p.mode === 'live' ? 'shadow' : 'live'}">
                  ${p.mode === 'live' ? 'Set shadow' : 'Set live'}
                </button>
              </span>
            </div>
            <div class="proto-protocol-logic">${escapeHtml(describeLogic(p))}</div>
            <div class="proto-protocol-meta">
              severity ${escapeHtml(p.severity || 'medium')}
              · lead ${escapeHtml(String(p.lead_time_days ?? 3))}d
              · v${escapeHtml(String(p.version || 1))}
              · agreed ${p.agreed_at ? escapeHtml(String(p.agreed_at).slice(0, 10)) : 'date not recorded'}
              ${(p.approvers || []).length ? ` · approvers: ${escapeHtml(p.approvers.join(', '))}` : ''}
            </div>
          </div>`).join('')
        : `<p class="settings-note">No trigger protocols configured. Define one below — it stays in shadow until the evidence and the signatures justify live.</p>`

      list.querySelectorAll('[data-op="toggle-mode"]').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.closest('.proto-protocol-row')?.dataset.protocol
          const next = button.dataset.next
          const protocol = protos.find((p) => p.id === id)
          if (!id || !protocol) return
          if (next === 'live') {
            const agreed = protocol.agreed_at ? String(protocol.agreed_at).slice(0, 10) : null
            const ok = askToConfirm
              ? await askToConfirm(`Set "${protocol.name}" LIVE?`, `Live removes the human gate: when the conditions hold, the playbook executes immediately. ${agreed ? `The protocol was agreed on ${agreed}.` : 'WARNING: no agreement date is recorded for this protocol.'}`)
              : window.confirm(`Set "${protocol.name}" live? The playbook will execute without a human gate.`)
            if (!ok) return
          }
          setStatus(`Setting ${id} to ${next}…`)
          try {
            const payload = await patchJson(`/api/v1/trigger-protocols/${encodeURIComponent(id)}`, { mode: next })
            if (payload?.success) {
              setStatus(`Protocol ${next === 'live' ? 'is now LIVE — it executes without a human gate' : 'set to shadow'}.`)
              await refresh({ force: true })
              renderProtocolList()
            } else {
              setStatus(payload?.error || 'Mode change failed')
            }
          } catch (err) {
            setStatus(String(err.message || err))
          }
        })
      })
    }).catch(() => {
      if (list) list.innerHTML = `<p class="settings-note">Trigger protocols unavailable.</p>`
    })
  }

  // --- The definition form: "when this and that, then do this" --------------

  function termRow() {
    const row = document.createElement('div')
    row.className = 'proto-term-row'
    row.innerHTML = `
      <label class="proto-negate"><input type="checkbox" data-field="negate" title="Negate this condition"> NOT</label>
      <input type="text" data-field="metric" list="protoMetricList" placeholder="counts.hazard_events" aria-label="Metric">
      <select data-field="operator" aria-label="Operator">
        ${OPERATORS.map((op) => `<option value="${op}">${op}</option>`).join('')}
      </select>
      <input type="number" data-field="threshold" placeholder="1" step="any" aria-label="Threshold">
      <button type="button" class="btn btn-sm" data-remove title="Remove this condition">×</button>`
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if ($('protoTermRows').children.length > 1) row.remove()
    })
    return row
  }

  const ACTION_FIELDS = {
    notify: [
      ['recipients', 'Recipients (URNs, comma-separated)', 'text', '+254700000000, +211…'],
    ],
    intervention: [
      ['id', 'Label (for tasks to reference)', 'text', 'protect'],
      ['title', 'Title (required)', 'text', 'Protect the cold chain'],
      ['objective', 'Objective', 'text', 'Move vaccines to the solar fridge'],
      ['lead_org', 'Lead org', 'text', 'County health team'],
      ['district', 'District', 'text', 'turkana'],
    ],
    task: [
      ['for', 'Attached to intervention label', 'text', 'protect'],
      ['title', 'Title (required)', 'text', 'Relocate vaccines within 6 hours'],
      ['owner', 'Owner', 'text', 'cold-chain-tech'],
      ['due_at', 'Due', 'date', ''],
    ],
  }

  function actionRow() {
    const row = document.createElement('div')
    row.className = 'proto-action-row'
    row.innerHTML = `
      <select data-field="type" aria-label="Action type">
        <option value="intervention">Open an intervention</option>
        <option value="task">Create a task</option>
        <option value="notify">Send an SMS notification</option>
      </select>
      <div class="proto-action-fields"></div>
      <button type="button" class="btn btn-sm" data-remove title="Remove this action">×</button>`
    const fields = row.querySelector('.proto-action-fields')
    const typeSelect = row.querySelector('[data-field="type"]')
    const renderFields = () => {
      fields.innerHTML = ACTION_FIELDS[typeSelect.value]
        .map(([key, label, kind, ph]) => `<label>${label}
            <input type="${kind}" data-field="${key}" placeholder="${ph}" ${kind === 'date' ? '' : ''}>
          </label>`).join('')
    }
    typeSelect.addEventListener('change', renderFields)
    renderFields()
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if ($('protoActionRows').children.length > 1) row.remove()
    })
    return row
  }

  function wireProtocolForm() {
    const termRows = $('protoTermRows')
    const actionRows = $('protoActionRows')
    if (!termRows || !actionRows) return
    termRows.appendChild(termRow())
    actionRows.appendChild(actionRow())
    $('protoAddTermButton')?.addEventListener('click', () => {
      if (termRows.children.length < 5) termRows.appendChild(termRow())
    })
    $('protoAddActionButton')?.addEventListener('click', () => {
      if (actionRows.children.length < 4) actionRows.appendChild(actionRow())
    })
    $('createProtocolButton')?.addEventListener('click', createProtocolFromForm)
  }

  async function createProtocolFromForm() {
    const status = $('protocolFormStatus')
    const say = (text) => { if (status) status.textContent = text }
    const name = $('protoNameInput')?.value?.trim()
    if (!name) return say('A protocol needs a name — this is the agreement being pre-authorised.')
    const terms = [...$('protoTermRows').children].map((row) => ({
      metric: row.querySelector('[data-field="metric"]')?.value?.trim(),
      operator: row.querySelector('[data-field="operator"]')?.value || '>=',
      threshold: Number(row.querySelector('[data-field="threshold"]')?.value),
      negate: row.querySelector('[data-field="negate"]')?.checked || false,
    }))
    if (terms.some((t) => !t.metric || !Number.isFinite(t.threshold))) {
      return say('Every condition needs a metric and a numeric threshold.')
    }
    const actions = [...$('protoActionRows').children].map((row) => {
      const action = { type: row.querySelector('[data-field="type"]')?.value }
      for (const input of row.querySelectorAll('.proto-action-fields [data-field]')) {
        const value = input.value?.trim()
        if (value) action[input.dataset.field] = value
      }
      return action
    })
    const agreedAt = $('protoAgreedInput')?.value
    if (!agreedAt) return say('Record the date the protocol was agreed — pre-authorisation is a claim about a decision made on a date.')
    const body = {
      name,
      metric: terms[0].metric,
      operator: terms[0].operator,
      threshold: terms[0].threshold,
      condition_set: {
        combinator: $('protoCombinatorInput')?.value || 'and',
        negate: $('protoNegateInput')?.checked || false,
        terms,
      },
      agreed_at: agreedAt,
      severity: $('protoSeverityInput')?.value || 'medium',
      mode: $('protoModeInput')?.value || 'shadow',
      lead_time_days: Number($('protoLeadInput')?.value || 3),
      approvers: ($('protoApproversInput')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
      action_playbook: actions,
    }
    say('Creating protocol…')
    try {
      const payload = await postJson('/api/v1/trigger-protocols', body)
      if (payload?.success) {
        say(`Created "${payload.data?.name || name}" in ${body.mode} mode. ${body.mode === 'shadow' ? 'Run a backtest, watch shadow evaluations, then set it live when the evidence justifies it.' : 'It will execute on the next run.'}`)
        $('defineProtocolDetails')?.removeAttribute('open')
        await refresh({ force: true })
        renderProtocolList()
      } else {
        say(payload?.error || 'Protocol creation failed')
      }
    } catch (err) {
      say(String(err.message || err))
    }
  }

function renderSettingsPanel() {
    // The six API-only routes. Mounted once, on the first visit to Settings,
    // because a control for a route nobody has asked for is not a first-paint cost
    // worth paying for.
    lazy('/workflow/confirm.js').then(({ askToConfirm: confirmFn }) => {
      askToConfirm = confirmFn
      return lazy('/workflow/ops.js').then((m) => m.mountOps({ askToConfirm: confirmFn }))
    }).catch((err) => console.error('Operations controls failed to load:', err))

    renderProtocolList()
    wireProtocolForm()

    fetchJson('/api/v1/webhooks').then((payload) => {
      const list = $('webhooksList')
      if (!list) return
      const webhooks = payload.data || []
      list.innerHTML = webhooks.length
        ? webhooks.map((w) => `<div class="source-card"><div class="source-card-header">
            <span class="source-name">${escapeHtml(w.url || w.id)}</span>
            <span class="status-pill status-${safeClass(w.status || 'unknown')}">${escapeHtml(w.status || 'unknown')}</span>
          </div></div>`).join('')
        : `<p class="settings-note">No webhooks configured.</p>`
    }).catch(() => {})
  }

  // Operations forms

  async function createIncident() {
    setStatus('Creating incident...')
    const body = {
      title:         $('incidentTitleInput')?.value,
      incident_type: $('incidentTypeInput')?.value,
      priority:      $('incidentPriorityInput')?.value,
      country:       $('countryInput')?.value,
      latitude:      Number($('latInput')?.value),
      longitude:     Number($('lonInput')?.value),
    }
    // A field report raised without connectivity is the ordinary case this app is
    // meant to survive, so the write is queued rather than rejected.
    const payload = await queueRequest('/api/v1/incidents', body)
    if (payload?.queued) {
      setStatus('Incident queued — it will be sent when the connection returns.')
      return
    }
    if (!payload?.success) { setStatus(payload?.error || 'Incident creation failed'); return }
    const intInput = $('interventionIncidentInput')
    if (intInput) intInput.value = payload.data.id
    setStatus(`Created incident ${payload.data.id}.`)
    await refresh({ force: true })
  }

  async function createIntervention() {
    setStatus('Creating intervention...')
    const body = {
      incident_id: $('interventionIncidentInput')?.value,
      title:       $('interventionTitleInput')?.value,
      lead_org:    $('interventionLeadInput')?.value,
      status:      'active',
    }
    const payload = await postJson('/api/v1/interventions', body)
    if (!payload.success) { setStatus(payload.error || 'Intervention creation failed'); return }
    const taskInput = $('taskInterventionInput')
    if (taskInput) taskInput.value = payload.data.id
    setStatus(`Created intervention ${payload.data.id}.`)
    await refresh({ force: true })
  }

  async function createTask() {
    setStatus('Creating task...')
    const body = {
      intervention_id: $('taskInterventionInput')?.value,
      title:           $('taskTitleInput')?.value,
      owner:           $('taskOwnerInput')?.value,
      status:          'todo',
    }
    const payload = await postJson('/api/v1/tasks', body)
    if (!payload.success) { setStatus(payload.error || 'Task creation failed'); return }
    setStatus(`Created task ${payload.data.id}.`)
    await refresh({ force: true })
  }

  async function createAlertRule() {
    setStatus('Creating alert rule...')
    const payload = await postJson('/api/v1/alert-rules', {
      name:      $('alertNameInput')?.value,
      metric:    $('alertMetricInput')?.value,
      operator:  '>=',
      threshold: Number($('alertThresholdInput')?.value),
      severity:  'high',
      actions:   [{ type: 'notify', target: 'response-lead' }],
    })
    if (!payload.success) { setStatus(payload.error || 'Alert rule creation failed'); return }
    setStatus(`Created alert rule ${payload.data.id}.`)
    await refresh({ force: true })
  }

  async function evaluateAlerts() {
    setStatus('Evaluating alert rules...')
    const payload = await postJson('/api/v1/alerts/evaluate', {})
    if (!payload.success) { setStatus(payload.error || 'Alert evaluation failed'); return }
    setStatus(`Evaluated ${payload.evaluated} rules; created ${payload.created} alert events.`)
    await refresh({ force: true })
  }

  async function sendLatestRapidProAlert() {
    setStatus('Sending latest alert through RapidPro...')
    const alerts = await fetchJson('/api/v1/alert-events?status=open&limit=1')
    const alert = alerts.data?.[0]
    if (!alert) { setStatus('No open alert event to send.'); return }
    const urns = $('rapidProUrnsInput')?.value?.split(',').map((u) => u.trim()).filter(Boolean)
    const payload = await postJson(`/api/v1/rapidpro/alert-events/${alert.id}/send`, { urns })
    if (!payload.success) { setStatus(payload.data?.error || payload.error || 'RapidPro dispatch failed'); return }
    setStatus(`RapidPro dispatch ${payload.data.id} recorded.`)
    await refresh({ force: true })
  }

  async function createReportSchedule() {
    setStatus('Creating report schedule...')
    let templateId = $('reportTemplateIdInput')?.value?.trim()
    if (!templateId) {
      // The template creator lives in the reports panel now; ask it rather than
      // keeping a second copy here, which is how the two drift.
      const panel = await reportsPanel()
      await panel.createReportTemplate()
      templateId = $('reportTemplateIdInput')?.value?.trim()
    }
    const localValue = $('reportScheduleNextRunInput')?.value
    const payload = await postJson('/api/v1/report-schedules', {
      template_id:  templateId,
      timezone:     Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      recurrence:   { type: 'daily', time: '07:00' },
      next_run_at:  localValue ? new Date(localValue).toISOString() : undefined,
      auto_distribute: false,
    })
    if (!payload.success) { setStatus(payload.error || 'Report schedule creation failed'); return }
    setStatus(`Created report schedule ${payload.data.id}.`)
    await refresh({ force: true })
  }

  async function runDueReports() {
    setStatus('Running due report schedules...')
    const payload = await postJson('/api/v1/report-schedules/run-due', {})
    if (!payload.success) { setStatus(payload.error || 'Due report run failed'); return }
    setStatus(`Completed ${payload.data.length} due report schedule runs.`)
    await refresh({ force: true })
  }

  return { renderSettingsPanel, createIncident, createIntervention, createTask, createAlertRule, evaluateAlerts, sendLatestRapidProAlert, createReportSchedule, runDueReports }
}
