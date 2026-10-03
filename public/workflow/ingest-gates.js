/**
 * The two ingestion writes the catalogue says went ungated.
 *
 * JTBD-002: creating the default ingestion schedules wrote one schedule per
 * built-in public source with no confirmation and nothing showing what would
 * be created. Ten schedules that then fire on a scheduler is not a small write.
 *
 * JTBD-007: the ACLED licence gate is a flag on the connector
 * (`acled_license_accepted`) with no UI step. ACLED data is licensed, not open;
 * the flag is the whole of the enforcement and an operator ticking it was the
 * entire compliance record. So the gate asks, in words, what the flag asserts.
 */

import { apiSettled } from '/shared/runtime.js'
import { esc } from '/shared/fmt.js'

const status = (node, text, cls = '') => {
  const el = node.querySelector('.ingest-gate-result')
  if (el) { el.className = `ops-result ${cls}`; el.textContent = text }
}

/**
 * Preview the default-schedule write.
 *
 * The server decides which sources are "built-in public sources" and publishes
 * that list only as code, so this panel cannot know it exactly. What it can
 * show, precisely, is every known source that has no schedule yet and every
 * schedule that already exists — and say which of the two the server will pick
 * from. The created records come back on the response and are reported then.
 */
export async function confirmDefaultSchedules(askToConfirm, onDone) {
  const [sources, schedules] = await Promise.all([
    apiSettled('/api/v1/sources'),
    apiSettled('/api/v1/ingest/schedules?limit=500'),
  ])
  const catalog = sources?.data || []
  const existing = schedules?.data || []
  const scheduled = new Set(existing.map((s) => s.source))
  const unscheduled = catalog.filter((s) => !scheduled.has(s.id))

  await askToConfirm({
    title: 'Create default ingestion schedules',
    confirmLabel: `Create schedules`,
    intro: `POST /api/v1/ingest/schedules/defaults writes one active schedule per built-in public source that does not already have one, then the scheduler runs them on their intervals. `
      + `Each of the ${unscheduled.length} source(s) below has no schedule today. The route chooses the subset it considers built-in and public — that list lives in src/ingestion.js and is not published by the API — and skips anything already scheduled. `
      + `The records it actually created are listed after it runs.`,
    rows: [
      ...unscheduled.map((s) => ({ change: 'may create', label: s.name || s.id, detail: s.id })),
      ...existing.map((s) => ({ change: 'unchanged', label: s.source, detail: s.status || 'scheduled' })),
    ],
    onConfirm: async () => {
      const payload = await apiSettled('/api/v1/ingest/schedules/defaults', { method: 'POST', body: '{}' })
      if (!payload?.success) throw new Error(payload?.error || 'The server refused the request and wrote nothing.')
      const names = (payload.data || []).map((s) => s.source)
      onDone?.(payload)
      return payload.created
        ? `Created ${payload.created} schedule(s): ${names.join(', ')}. They will run on their intervals from now on.`
        : 'Created nothing: every built-in public source already had a schedule.'
    },
  })
}

/**
 * Gate the ACLED import behind the licence assertion the flag represents.
 *
 * The connector rejects `acled_csv` unless `acled_license_accepted` is true, so
 * this gate exists to make that flag a decision rather than a default.
 */
export async function confirmAcledImport(askToConfirm, csv, onDone) {
  const rows = String(csv || '').split('\n').filter((line) => line.trim()).length
  await askToConfirm({
    title: 'Import ACLED conflict data',
    danger: true,
    confirmLabel: 'Assert the licence and import',
    gate: {
      type: 'check',
      label: 'I hold a current ACLED licence covering this data, and I am authorised to import it.',
      note: 'ACLED event data is licensed, not open data. This box is the only record the platform keeps that anyone asserted the licence; the connector then refuses the import without it.',
    },
    intro: `This runs the acled_csv connector against ${rows} line(s) of CSV and writes conflict_events into the store, then recomputes analytics. `
      + `Conflict events feed the climate-conflict risk scores, so the numbers on other panels will move.`,
    rows: [
      { change: 'may create', label: 'conflict_events', detail: `${rows - 1 <= 0 ? 'unknown' : rows - 1} data row(s) below the header` },
      { change: 'recomputes', label: 'climate-conflict risk scores', detail: 'and anything downstream of them' },
    ],
    onConfirm: async () => {
      const payload = await apiSettled('/api/v1/ingest/run', {
        method: 'POST',
        body: JSON.stringify({ sources: ['acled_csv'], acled_csv: String(csv), acled_license_accepted: true }),
      })
      if (!payload?.success) throw new Error(payload?.error || 'The import was refused and nothing was written.')
      const run = (payload.source_runs || [])[0] || {}
      onDone?.(payload)
      if (run.status && run.status !== 'success') {
        return `The connector ran and reported "${run.status}": ${(run.errors || []).join('; ') || 'no detail given'}. The licence assertion was recorded; the data was not imported.`
      }
      return `Imported. conflict_events written: ${esc(String(payload.counts?.conflict_events ?? 'not reported'))}. Analytics recomputed.`
    },
  })
}
