/**
 * The ingestion panel, loaded with its markup.
 *
 * ENH: this is ~9 KB of `app.js` that no console load needed until somebody
 * opened the Ingestion tab — the same deferral the four panel *templates*
 * already had, applied to the panel's *behaviour*. `check-budget` measures the
 * first-load graph, and these eight functions were in it for a control that is
 * usually not on screen.
 *
 * `mount(console)` takes what the panel needs from the console rather than
 * importing it: `app.js` is 5,000 lines and importing it here would load the
 * entire console to render a tab. Everything it passes is listed in the
 * parameter block below, so a second caller can see the surface without reading
 * the module.
 */

import { apiFetch } from '/shared/runtime.js'

export async function mount(console_) {
  const {
    $, escapeHtml, setStatus, authHeaders, postJson, refresh, state, ensureEscalation,
  } = console_

  const api = (path, options) => apiFetch(path, { headers: authHeaders(), ...options })

/**
 * The ingestion tab's source picker.
 *
 * `await`ed at the top level of the module. With a bare `fetch` and no catch, a
 * dead server rejected here and threw out of module evaluation — so
 * `restoreFiltersFromUrl`, `ensureEscalation`, `watchEvidenceSurfaces` and the
 * first `refresh` never ran. The console did not report an outage; it booted
 * half-built and said nothing, which is the same failure as the empty-state
 * lie one layer down and harder to notice.
 *
 * So: `apiFetch` (which raises a status-bearing error rather than a bare
 * `TypeError`), and a grid that states the failure rather than going blank.
 */
async function loadSources() {
  const grid = $('sourceGrid')
  if (!grid) return
  let payload
  try {
    payload = await apiFetch('/api/v1/sources', { headers: authHeaders() })
  } catch (err) {
    // An empty picker reads as "this platform has no sources", which is a claim
    // about the system rather than about the connection. Say which it is.
    grid.innerHTML = '<p class="workflow-empty">The source list has not been checked. '
      + 'The request did not get an answer, so this is not an empty list.</p>'
    return
  }
  if (!Array.isArray(payload?.data)) {
    grid.innerHTML = '<p class="workflow-empty">The source list has not been checked — '
      + 'the server answered with something that is not a source list.</p>'
    return
  }
  const defaultSources = ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms']
  grid.innerHTML = payload.data.map((source) => `
    <label title="${escapeHtml(source.name)}">
      <input type="checkbox" value="${escapeHtml(source.id)}" ${defaultSources.includes(source.id) ? 'checked' : ''}>
      <span>${escapeHtml(source.id)}</span>
    </label>
  `).join('')
}


async function runSingleSource(sourceId) {
  setStatus(`Running ${sourceId}. This fetches live data from the source; it may take a moment.`)
  const payload = await postJson('/api/v1/ingest/run', { sources: [sourceId] })
  setStatus(payload.success ? `Ran ${sourceId}.` : (payload.error || 'Ingestion failed'))
  await refresh({ force: true })
}

async function runIngestion() {
  setStatus('Running ingestion...')
  const grid = $('sourceGrid')
  const selectedSources = [...(grid?.querySelectorAll('input:checked') || [])].map((inp) => inp.value)
  const payload = await postJson('/api/v1/ingest/run', {
    sources: selectedSources,
    regions: [{
      name:    $('regionInput')?.value,
      country: $('countryInput')?.value,
      lat:     Number($('latInput')?.value),
      lon:     Number($('lonInput')?.value),
    }],
  })
  if (!payload.success) { setStatus(payload.error || 'Ingestion failed'); return }
  setStatus(`Ingestion complete. ${payload.source_runs.length} source runs recorded.`)
  await refresh({ force: true })
}

/**
 * Create the default public ingestion schedules — behind a preview (JTBD-002).
 *
 * This wrote one schedule per built-in public source with nothing showing what
 * would be created, and each schedule then runs on its own interval from an
 * external scheduler. The preview names every source that has no schedule today
 * and every schedule that already exists; the route still chooses the subset
 * it treats as built-in and public, and reports back what it actually created.
 */
async function createPublicIngestionSchedules() {
  setStatus('Reading what the default schedules would change...')
  try {
    const { askToConfirm } = await lazy('/workflow/confirm.js')
    await lazy('/workflow/ingest-gates.js').then((m) => m.confirmDefaultSchedules(askToConfirm, async () => {
      setStatus('Creating default public ingestion schedules...')
      await refresh({ force: true })
    }))
  } catch (err) {
    setStatus(`Could not prepare the schedule preview: ${err.message}`)
  }
}

/** ACLED conflict import — behind the licence assertion it depends on (JTBD-007). */
async function importAcledConflictCsv() {
  const csv = $('acledCsvInput')?.value || ''
  const section = $('acledSection')
  if (!csv.trim()) {
    setStatus('Paste the ACLED CSV before importing.')
    $('acledCsvInput')?.focus()
    return
  }
  try {
    const { askToConfirm } = await lazy('/workflow/confirm.js')
    await lazy('/workflow/ingest-gates.js').then((m) => m.confirmAcledImport(askToConfirm, csv, async () => {
      setStatus('Importing ACLED conflict data...')
      await refresh({ force: true })
    }))
  } catch (err) {
    const out = section?.querySelector('.ops-result')
    if (out) out.textContent = String(err.message || err)
  }
}

async function runDueIngestion() {
  setStatus('Running due public ingestion schedules...')
  const payload = await postJson('/api/v1/ingest/run-due', {})
  setStatus(payload.success ? `Completed ${payload.data.length} due source runs.` : (payload.error || 'Due ingestion failed'))
  await refresh({ force: true })
}

async function importServiceAssets(kind) {
  setStatus(`Importing service assets as ${kind.toUpperCase()}...`)
  const key = kind === 'geojson' ? 'service_assets_geojson' : 'service_assets_csv'
  // `apiFetch`, not raw `fetch`. This one checked neither `res.ok` nor a
  // timeout, and the consequence was specific: an import that hung left the
  // status line reading "Importing service assets as GEOJSON…" for the life of
  // the page, promising work still in progress that had already been abandoned.
  // A write with no timeout is worse than a read with none — a read going
  // quiet is annoying, a write going quiet leaves the operator unsure whether to
  // resubmit, and resubmitting an import is not free.
  let payload
  try {
    payload = await apiFetch('/api/v1/service-assets', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ [key]: $('serviceAssetInput')?.value }),
    })
  } catch (err) {
    // Say what happened. The alternative — an unhandled rejection — leaves the
    // status line mid-sentence, which is the state `states.js` forbids.
    setStatus(`Import failed: ${err.message || 'the request did not get an answer'}`)
    return
  }
  setStatus(payload.success ? `Imported ${payload.imported} service assets.` : ((payload.errors || [payload.error]).join(' | ')))
  await refresh({ force: true })
}

// =============================================================

  // Exposed so `app.js` can wire the panel's buttons, and so its command-palette
  // entries have something to call. The panel is not loaded until the tab is
  // opened, so a caller reaching one of these before that is a caller with a
  // button the user cannot see.
  return { loadSources, runIngestion, runSingleSource, createPublicIngestionSchedules, importAcledConflictCsv, runDueIngestion, importServiceAssets }
}
