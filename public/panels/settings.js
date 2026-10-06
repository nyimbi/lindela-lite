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
    bindApiKeyInput, reportsPanel, postJson,
  } = console_

function renderSettingsPanel() {
    // The six API-only routes. Mounted once, on the first visit to Settings,
    // because a control for a route nobody has asked for is not a first-paint cost
    // worth paying for.
    lazy('/workflow/confirm.js').then(({ askToConfirm }) =>
      lazy('/workflow/ops.js').then((m) => m.mountOps({ askToConfirm }))
    ).catch((err) => console.error('Operations controls failed to load:', err))

    fetchJson('/api/v1/trigger-protocols').then((payload) => {
      const list = $('triggerProtocolsList')
      if (!list) return
      const protos = payload.data || []
      list.innerHTML = protos.length
        ? protos.map((p) => `<div class="source-card"><div class="source-card-header">
            <span class="source-name">${escapeHtml(p.name || p.id)}</span>
          </div></div>`).join('')
        : `<p class="settings-note">No trigger protocols configured.</p>`
    }).catch(() => {
      const list = $('triggerProtocolsList')
      if (list) list.innerHTML = `<p class="settings-note">Trigger protocols unavailable.</p>`
    })

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
