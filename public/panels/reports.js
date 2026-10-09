/**
 * The reports panel: rendering and the six actions behind it.
 *
 * Fetched with the panel's markup, for the same reason the ingestion panel's
 * behaviour is: the console's first load is measured on a field connection,
 * and a table an operator opens when exporting a briefing is not part of the
 * first paint.
 *
 * The console passes itself in rather than being imported — importing `app.js`
 * here would load the whole console to render a list. The parameter block is the
 * whole dependency surface.
 */

export function mount(console_) {
  const {
    $, state, escapeHtml, truncate, displayDate, pageWindow, renderPager,
    setStatus, postJson, refresh, t, safeClass,
  } = console_

  function renderReportsPanel() {
    const container = $('reportsList')
    if (!container) return
    const reports = state.reports

    if (!reports.length) {
      container.innerHTML = `<div class="empty-state"><p>${escapeHtml(t('state.empty_reports'))}</p></div>`
    } else {
      const slice = pageWindow('reports', reports.length)
      container.innerHTML = reports.slice(slice.start, slice.end).map((r) => {
        const canApprove = r.status === 'ready' || r.status === 'draft'
        const canDist    = r.status === 'approved' || r.status === 'ready'
        // A generated report's title is the generator's own prose and can run to
        // a clause. Shortened for the rail; the full string is on the title, and
        // the exported document carries all of it.
        const title = r.title || r.template_name || 'Untitled report'
        // The narrator's state, on the row it belongs to — narrated, refused,
        // or untouched. A narrated row says which model wrote it, because a
        // reader must know which words were computed and which were written.
        const narrationChip = r.narrative?.status === 'narrated'
          ? `<span class="status-pill status-narrated" title="${escapeHtml(t('reports.narratedTitle', { model: r.narrative.model || '' }))}">${escapeHtml(t('reports.narratedChip', { model: r.narrative.model || '' }))}</span>`
          : r.narrative?.status === 'refused'
            ? `<span class="status-pill status-refused" title="${escapeHtml(String(r.narrative.reason || ''))}">${escapeHtml(t('reports.narrationRefused'))}</span>`
            : ''
        return `<div class="report-item" role="listitem">
          <div class="report-item-title" title="${escapeHtml(title)}">${escapeHtml(truncate(title, { max: 64 }))}</div>
          <div class="report-item-meta">
            <span class="status-pill status-${safeClass(r.status || 'draft')}">${escapeHtml(r.status || '')}</span>
            ${narrationChip}
            <span>${displayDate(r.generated_at)}</span>
          </div>
          <div class="item-actions">
            ${canApprove ? `<button class="btn btn-xs btn-approve" data-id="${escapeHtml(r.id)}" data-action="approve">Approve</button>` : ''}
            ${canDist    ? `<button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="distribute">Distribute</button>` : ''}
            <button class="btn btn-xs btn-narrate" data-id="${escapeHtml(r.id)}" data-action="narrate" data-i18n="reports.narrate">Narrate</button>
            <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-md">MD</button>
            <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-csv">CSV</button>
            <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-json">JSON</button>
            <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-geojson">GeoJSON</button>
          </div>
        </div>`
      }).join('')

      container.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const { id, action } = e.currentTarget.dataset
          handleReportAction(id, action)
        })
      })
    }

    renderPager($('reportsPager'), 'reports', reports.length, renderReportsPanel)

    // Populate template select
    const sel = $('reportTemplateIdInput')
    if (sel) {
      const cur = sel.value
      sel.innerHTML = `<option value="">None (create new)</option>` +
        state.templates.map((tmpl) => `<option value="${escapeHtml(tmpl.id)}">${escapeHtml(tmpl.name)}</option>`).join('')
      if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) sel.value = cur
      else if (state.templates[0] && !sel.value) sel.value = state.templates[0].id
    }
  }

  async function handleReportAction(id, action) {
    const safeId = encodeURIComponent(id)
    if (action === 'narrate') {
      const payload = await postJson(`/api/v1/reports/${safeId}/narrate`, { actor: 'dashboard' })
      const narr = payload.data?.narrative
      if (narr?.status === 'narrated') {
        setStatus(t('reports.narratedStatus', { model: narr.model || '' }))
      } else {
        setStatus(t('reports.narrationFailed', { reason: narr?.reason || payload.error || 'the server gave no reason' }))
      }
      await refresh({ force: true })
    } else if (action === 'approve') {
      const payload = await postJson(`/api/v1/reports/${safeId}/approve`, { actor: 'dashboard' })
      setStatus(payload.success ? `Report ${id} approved. It can now be distributed.`
        : `Could not approve report ${id}: ${payload.error || 'the server gave no reason'}.`)
      await refresh({ force: true })
    } else if (action === 'distribute') {
      const payload = await postJson(`/api/v1/reports/${safeId}/distribute`, { channels: [{ channel: 'markdown_download' }] })
      if (payload.success || payload.report) {
        window.open(`/api/v1/reports/${safeId}/export.md`, '_blank')
        setStatus(`Report ${id} distributed. Check the delivery record for who received it.`)
      } else {
        setStatus(payload.error || 'Distribute failed')
      }
      await refresh({ force: true })
    } else if (action === 'export-md') {
      window.open(`/api/v1/reports/${safeId}/export.md`, '_blank')
    } else if (action === 'export-csv') {
      window.open(`/api/v1/reports/${safeId}/export.csv`, '_blank')
    } else if (action === 'export-json') {
      window.open(`/api/v1/reports/${safeId}/export.json`, '_blank')
    } else if (action === 'export-geojson') {
      window.open(`/api/v1/reports/${safeId}/export.geojson`, '_blank')
    }
  }

  // The four deferred panels' controls are bound by `bindDeferredPanel` once
  // their markup has been fetched — see DEFERRED_PANEL_BINDINGS. These bindings
  // used to live here at module scope, where `?.` made them silently no-ops
  // against markup that no longer exists at load.
  function reportScope() {
    return Object.fromEntries(Object.entries({
      country:         $('reportCountryInput')?.value?.trim(),
      incident_id:     $('reportIncidentInput')?.value?.trim(),
      intervention_id: $('reportInterventionInput')?.value?.trim(),
    }).filter(([, v]) => v))
  }

  function reportSections() {
    return ($('reportSectionsInput')?.value || 'executive_summary,incident_summary,appendix_sources')
      .split(',').map((s) => s.trim()).filter(Boolean)
  }

  async function createReportTemplate() {
    setStatus('Creating report template...')
    const body = {
      name: 'SITREP',
      report_type: 'situation_report',
      title_pattern: 'SITREP - {{country}} - {{date}}',
      default_filters: reportScope(),
      sections: reportSections(),
    }
    const payload = await postJson('/api/v1/report-templates', body)
    if (!payload.success) { setStatus(payload.error || 'Template creation failed'); return }
    const sel = $('reportTemplateIdInput')
    if (sel) sel.value = payload.data.id
    setStatus(`Template created. Reports built on it will use your section list.`)
    await refresh({ force: true })
  }

  async function generateReport() {
    setStatus('Generating report...')
    let templateId = $('reportTemplateIdInput')?.value?.trim()
    if (!templateId) {
      await createReportTemplate()
      templateId = $('reportTemplateIdInput')?.value?.trim()
    }
    const payload = await postJson('/api/v1/reports', { template_id: templateId, scope: reportScope(), generate: true })
    if (!payload.success) { setStatus(payload.error || 'Report generation failed'); return }
    setStatus(`Report generated. It needs approval before anyone is sent it.`)
    await refresh({ force: true })
  }

  async function approveLatestReport() {
    const report = state.reports.find((r) => r.status === 'ready') || state.reports[0]
    if (!report) { setStatus('No report to approve.'); return }
    const payload = await postJson(`/api/v1/reports/${report.id}/approve`, {})
    setStatus(payload.success ? `Approved report ${payload.data.id}.` : (payload.error || 'Approval failed'))
    await refresh({ force: true })
  }

  async function distributeLatestReport() {
    const report = state.reports.find((r) => ['ready', 'approved'].includes(r.status)) || state.reports[0]
    if (!report) { setStatus('No report to distribute.'); return }
    const payload = await postJson(`/api/v1/reports/${report.id}/distribute`, { channels: [{ channel: 'markdown_download' }] })
    if (!payload.success) { setStatus(payload.error || payload.data?.[0]?.error || 'Distribution failed'); return }
    window.open(`/api/v1/reports/${report.id}/export.md`, '_blank')
    setStatus(`Markdown export ready for report ${report.id}. The browser will download it.`)
    await refresh({ force: true })
  }

  // Every action the panel's buttons call, so a binding elsewhere in the console
  // does not need its own copy — the six closures in DEFERRED_PANEL_BINDINGS
  // used to close over functions that lived here, which is how they kept the
  // console's first load paying for a tab.
  return {
    renderReportsPanel,
    handleReportAction,
    createReportTemplate,
    generateReport,
    approveLatestReport,
    distributeLatestReport,
  }
}
