/**
 * The six routes that had a backend and no dashboard.
 *
 * JTBD-600 / DoD item 13: "no transition is API-only without a corresponding
 * dashboard affordance." Six routes were reachable with curl and nothing else:
 *
 *   POST /api/v1/trigger-protocols/:id/backtest     — would this have fired?
 *   POST /api/v1/trigger-protocols/:id/shadow-run   — would this fire now?
 *   POST /api/v1/analytics/bias-correct              — map gridded to station
 *   POST /api/v1/outbox/dispatch                     — flush the outbox
 *   POST /api/v1/maintenance/apply-retention         — irreversible delete
 *   GET  /api/v1/connectors                          — the registry
 *
 * Each control reports what happened in a sentence, and keeps every caveat the
 * server attached to the number. A backtest whose verdict is "weak evidence"
 * is reported as weak evidence; a shadow run whose metric could not be resolved
 * is reported as unresolved, not as "would not fire", because those two are
 * different answers and the second one is a guess.
 */

import { apiFetch, apiSettled } from '/shared/runtime.js'
import { esc, num, truncate } from '/shared/fmt.js'
import { listScope } from '/shared/paging.js'

const json = (path, options) => apiFetch(path, options)

function result(node, text, cls = '') {
  const el = node.querySelector('.ops-result')
  if (el) {
    el.className = `ops-result ${cls}`
    el.textContent = text
  }
}

/** `null` is a number the platform declined to produce; say so, do not print 0. */
const orUnstated = (value, digits = 3) => (Number.isFinite(value) ? num(value, { dp: digits }) : 'not determined')

// --- Trigger protocols: shadow run and backtest -----------------------------

function protocolRow(protocol) {
  return `<div class="ops-control" data-protocol="${esc(protocol.id)}">
    <h4>${esc(protocol.name || protocol.id)}</h4>
    <p class="ops-control-note">${esc(protocol.metric)} ${esc(protocol.operator)} ${esc(String(protocol.threshold))}
      · lead time ${esc(String(protocol.lead_time_days ?? 3))}d</p>
    <div class="form-actions">
      <button class="btn btn-sm" type="button" data-op="shadow">Shadow run</button>
      <button class="btn btn-sm" type="button" data-op="backtest">Backtest</button>
    </div>
    <p class="ops-result" role="status" aria-live="polite"></p>
  </div>`
}

async function runShadow(protocol, out) {
  const payload = await json(`/api/v1/trigger-protocols/${encodeURIComponent(protocol.id)}/shadow-run`, { method: 'POST', body: '{}' })
  const d = payload?.data
  if (!d) return result(out, 'Shadow run returned nothing.', 'notice-warn')
  const value = d.computed_value
  if (!Number.isFinite(value)) {
    // would_fire is false here because the comparison was never made, not
    // because the condition failed. Reporting "would not fire" would be the
    // platform's silence read as a negative finding.
    //
    // The path named is the one the server could not read, not the protocol's
    // primary metric. A compound condition set has more than one term and the
    // dead one is rarely the first, so naming `protocol.metric` sent the
    // operator to edit a path that was fine.
    const dead = d.unresolvable_metrics?.length ? d.unresolvable_metrics : [protocol.metric]
    return result(out, `Unresolved: ${dead.join(', ')} did not evaluate to a number, so no trigger condition could be tested. Nothing fired, and nothing was tested.`, 'notice-warn')
  }
  result(out, d.would_fire
    ? `Would fire. ${protocol.metric} is ${num(value, { dp: 4 })}, which is ${d.would_fire ? '' : ''}${protocol.operator} ${protocol.threshold}. Nothing was sent — this was a shadow run.`
    : `Would not fire. ${protocol.metric} is ${num(value, { dp: 4 })}, which does not meet ${protocol.operator} ${protocol.threshold}.`,
  d.would_fire ? 'notice-warn' : '')
}

async function runBacktest(protocol, out) {
  const payload = await json(`/api/v1/trigger-protocols/${encodeURIComponent(protocol.id)}/backtest`, { method: 'POST', body: '{}' })
  const b = payload?.backtest_result
  if (!b) return result(out, 'Backtest returned nothing.', 'notice-warn')
  const parts = [
    `Verdict: ${b.verdict}.`,
    `Over ${num(b.samples, { int: true })} ingestion runs, ${num(b.evaluable, { int: true })} could be evaluated and ${num(b.unevaluable, { int: true })} could not.`,
    `True positives ${num(b.true_positives, { int: true })}, false positives ${num(b.false_positives, { int: true })}, misses ${num(b.misses, { int: true })}, true negatives ${num(b.true_negatives, { int: true })}.`,
    `Precision ${orUnstated(b.precision)}, recall ${orUnstated(b.recall)}, F1 ${orUnstated(b.f1)}.`,
    `Event base rate ${orUnstated(b.event_base_rate)}; precision lift over firing on every run ${orUnstated(b.precision_lift)}.`,
  ]
  result(out, parts.join(' '), b.evaluable ? '' : 'notice-warn')
}

// --- Bias correction ---------------------------------------------------------

async function runBiasCorrect(out) {
  const raw = document.getElementById('biasCorrectInput')?.value?.trim()
  if (!raw) return result(out, 'Paste an observations and stations payload first.', 'notice-warn')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return result(out, `That is not JSON: ${err.message}`, 'notice-danger')
  }
  const payload = await json('/api/v1/analytics/bias-correct', { method: 'POST', body: JSON.stringify(parsed) })
  const rows = payload?.data || []
  if (!rows.length) return result(out, 'No observations were corrected. The mapper groups by `country` by default; observations whose country has no station record are corrected against nothing and still come back.', 'notice-warn')

  out.querySelector('.ops-result').innerHTML =
    `<table class="ops-table"><caption class="visually-hidden">Bias-corrected observations</caption><thead><tr>
      <th scope="col">Station source</th><th scope="col">Original</th><th scope="col">Corrected</th></tr></thead><tbody>`
    + rows.map((r) => `<tr><td>${esc(truncate(String(r.bias_correction_source ?? 'unknown'), { max: 40 }))}</td>
        <td>${esc(orUnstated(Number(r.precipitation_mm)))}</td>
        <td>${esc(orUnstated(Number(r.bias_corrected_precipitation_mm)))}</td></tr>`).join('')
    + '</tbody></table>'
    + `<p class="ops-control-note">${num(rows.length, { int: true })} observation(s) corrected by quantile mapping to station values. Nothing was stored: this route returns a result and writes no record, and runIngestion does not call it.</p>`
}

// --- Outbox dispatch ---------------------------------------------------------

/**
 * What the dispatch count may be said to have come from.
 *
 * The count is read off a bounded page, so it is a count of the backlog this
 * panel could *see* — while the dispatch that follows acts on the whole outbox.
 * "from N pending" over a truncated page reads as the whole backlog; over a
 * failed read it reads as a confident zero. Both are the same defect as
 * `retentionRow`'s: a bounded observation stated as a total.
 */
export function outboxBacklog(envelope, pending) {
  if (envelope == null) {
    return 'a pending count this panel could not read — the outbox request failed, and dispatch acted on the whole outbox'
  }
  if (envelope.has_more === true) {
    return `${num(pending, { int: true })} pending in the first ${num((envelope.data || []).length, { int: true })} events read, of ${num(envelope.total, { int: true })} in the outbox — dispatch acts on the whole outbox, not only the events counted here`
  }
  return `${num(pending, { int: true })} pending`
}

async function runOutboxDispatch(out) {
  const before = await apiSettled('/api/v1/outbox?limit=500')
  const pending = (before?.data || []).filter((e) => e.status === 'pending').length
  const payload = await json('/api/v1/outbox/dispatch', { method: 'POST', body: '{}' })
  result(out, `${num(payload?.dispatched ?? 0, { int: true })} event(s) marked sent, ${num(payload?.failed ?? 0, { int: true })} failed, from ${outboxBacklog(before, pending)}. `
    + 'An event with no active webhook subscription matching it is still marked sent — nothing was delivered to it, and this count does not distinguish those from deliveries. A failure is retried until five attempts, then marked failed.',
  payload?.failed ? 'notice-warn' : '')
}

// --- Retention (irreversible) ------------------------------------------------

/**
 * The scale of what retention would touch.
 *
 * Deliberately does not divide the records into "would be kept" and "would be
 * deleted". The window is server-side configuration the API does not publish,
 * and a preview that guessed 365 — the default in src/pii.js — would draw a
 * confident line through an operator's field reports that no line in their
 * deployment actually falls on. Counts and unageable records are true; the
 * verdict is the server's.
 */
export function retentionPlan(reportEnvelope, inboundEnvelope) {
  const ageable = (record) => {
    const stamp = record.occurred_at || record.created_at
    const parsed = stamp ? Date.parse(stamp) : Number.NaN
    return Number.isFinite(parsed)
  }
  const buckets = (envelope) => {
    const scope = listScope(envelope)
    return {
      // `listScope.total` is the server's matched count, not the page length.
      // The dialog says "N exist" in front of an irreversible delete, so a page
      // length printed there understates what the delete would touch.
      total: scope.total,
      // Only the held page can be scanned for missing timestamps. On a truncated
      // page this counts within the page, and the caller says so.
      unaged: (envelope?.data || []).filter((r) => !ageable(r)).length,
      held: scope.held,
      complete: scope.complete,
      // An envelope that never arrived carries no count at all. `total` falls
      // back to 0 through `listScope`; this flag is what keeps the dialog from
      // rendering that 0 as "0 exist".
      readable: envelope != null,
    }
  }
  return { fieldReports: buckets(reportEnvelope), inbound: buckets(inboundEnvelope) }
}

/**
 * One row of the retention preview.
 *
 * Three numbers, each with its own failure: a collection that could not be read,
 * a set larger than the page the panel holds, and records whose timestamps are
 * missing so no window can age them. The previous copy asserted the first of
 * these as a fact and the third as a whole-set count.
 *
 * `retentionRefusal` normally stops the dialog before this renders an unreadable
 * bucket; the branch stays because this function's contract is that it never
 * states a count it does not have, and that contract should not depend on a
 * guard living in its caller.
 */
export function retentionRow(label, bucket) {
  if (!bucket.readable) {
    return { change: 'unknown', label, detail: 'could not be read — this panel cannot say how many records this route would consider' }
  }
  const exists = bucket.complete
    ? `${num(bucket.total, { int: true })} exist`
    : `${num(bucket.total, { int: true })} exist, of which this panel has read ${num(bucket.held, { int: true })} — the count is the server's, the scan for missing timestamps is not`
  const unaged = bucket.unaged
    ? `; ${num(bucket.unaged, { int: true })} of the records read carry no timestamp and are always kept`
    : ''
  return { change: 'may delete', label, detail: `${exists}${unaged}` }
}

/**
 * The reason this panel must not open a confirm gate, or `null` to proceed.
 *
 * A preview built from a collection that could not be read would say "0 exist"
 * about a set it never saw and then ask the operator to confirm deleting it.
 * Refusing is the honest answer, and it costs nothing: nothing has been deleted
 * at this point and a retry can succeed.
 */
export function retentionRefusal(plan) {
  const missing = [
    plan.fieldReports.readable ? null : 'field reports',
    plan.inbound.readable ? null : 'RapidPro inbound messages',
  ].filter(Boolean)
  if (!missing.length) return null
  return `Cannot preview this delete: the ${missing.join(' and ')} could not be read, so this panel cannot tell you how many records the route would consider. Nothing was deleted.`
}

/**
 * @returns {Promise<string|null>} the reason the preview could not be built, or
 *   `null` when the dialog opened — the caller must report the reason rather
 *   than announcing a dialog that never appeared.
 */
export async function runRetention(askToConfirm) {
  const [reports, inbound] = await Promise.all([
    apiSettled('/api/v1/field-reports?limit=500'),
    apiSettled('/api/v1/rapidpro/inbound?limit=500'),
  ])
  const plan = retentionPlan(reports, inbound)

  // Refuse before the confirm gate, not after it — and hand the reason back
  // rather than writing it, because the caller owns the control that reports it.
  const refusal = retentionRefusal(plan)
  if (refusal) return refusal

  askToConfirm({
    title: 'Apply retention — this deletes records',
    danger: true,
    gate: { type: 'text', expect: 'DELETE' },
    intro: `POST /api/v1/maintenance/apply-retention permanently deletes every field report and inbound RapidPro message older than the retention window. There is no undo and no soft-delete here: the records are removed from the store, not flagged. `
      + `<strong>The window itself is not readable through the API</strong> — it is set in data/pii-policy.json or LINDELA_LITE_PII_POLICY — so this panel cannot show you exactly which records fall on the wrong side of it. What it can show is the scale:`,
    rows: [
      retentionRow('Field reports', plan.fieldReports),
      retentionRow('RapidPro inbound messages', plan.inbound),
      { change: 'unchanged', label: 'Everything else', detail: 'No other collection is touched by this route' },
    ],
    confirmLabel: 'Delete permanently',
    onConfirm: async () => {
      const payload = await json('/api/v1/maintenance/apply-retention', { method: 'POST', body: '{}' })
      if (!payload?.success) throw new Error(payload?.error || 'The server refused the retention window and deleted nothing.')
      return `Deleted ${num(payload.field_reports.expired, { int: true })} field report(s) and ${num(payload.rapidpro_inbound_messages.expired, { int: true })} inbound message(s); kept ${num(payload.field_reports.kept, { int: true })} and ${num(payload.rapidpro_inbound_messages.kept, { int: true })} respectively. This cannot be undone.`
    },
  })
  return null
}

// --- Connector registry ------------------------------------------------------

async function renderConnectors(out) {
  const payload = await json('/api/v1/connectors')
  const rows = payload?.data || []
  if (!rows.length) return result(out, 'The connector registry is empty or unreadable.', 'notice-warn')
  out.querySelector('.ops-result').innerHTML =
    `<table class="ops-table"><caption class="visually-hidden">Connector registry and last run</caption><thead><tr>
      <th scope="col">Connector</th><th scope="col">Last run</th><th scope="col">Status</th></tr></thead><tbody>`
    + rows.map((c) => `<tr><td>${esc(truncate(c.id, { max: 34 }))}<br><span class="ops-control-note">${esc(truncate(c.description || '', { max: 70 }))}</span></td>
        <td>${c.last_run ? esc(String(c.last_run.completed_at || '').slice(0, 19).replace('T', ' ')) : 'never run'}</td>
        <td>${esc(c.status)}</td></tr>`).join('')
    + '</tbody></table>'
}

// --- Mount -------------------------------------------------------------------

/**
 * The section, built here rather than shipped in index.html.
 *
 * Six routes that had a backend and no control anywhere in the console
 * (JTBD-600 / DoD 13). It is markup with no meaning until this module mounts
 * it, so shipping it in the first paint bought an empty-looking heading in
 * Settings and about a kilobyte of every operator's first load.
 */
function buildSection() {
  const host = document.getElementById('opsApiHost')
  if (!host) return null
  host.innerHTML = `
<section class="settings-section" id="opsApi">
  <h3>Platform operations</h3>
  <p class="settings-note">
    Routes with no other dashboard affordance. Each one reports what
    happened, including what it could not determine.
  </p>

  <div id="opsProtocols"></div>

  <div class="ops-control" id="opsBiasCorrectControl">
    <h4>Bias-correct observations</h4>
    <p class="ops-control-note">
      Maps gridded values onto station baselines by quantile matching.
      Paste <code>{&quot;observations&quot;:[…],&quot;stations&quot;:[…]}</code>.
      Returns the corrected values and stores nothing.
    </p>
    <label class="visually-hidden" for="biasCorrectInput">Observations and stations payload</label>
    <textarea id="biasCorrectInput" rows="4" spellcheck="false"
      placeholder='{"observations":[{"country":"KE","precipitation_mm":12.4}],"stations":[{"country":"KE","precipitation_mm":9.1}]}'></textarea>
    <button id="opsBiasCorrect" class="btn btn-sm" type="button">Correct</button>
    <p class="ops-result" role="status" aria-live="polite"></p>
  </div>

  <div class="ops-control">
    <h4>Dispatch the outbox</h4>
    <p class="ops-control-note">
      Delivers pending outbox events to every active webhook subscription
      that matches them.
    </p>
    <button id="opsOutboxDispatch" class="btn btn-sm" type="button">Dispatch pending</button>
    <p class="ops-result" role="status" aria-live="polite"></p>
  </div>

  <div class="ops-control" id="opsRetentionControl">
    <h4>Apply retention</h4>
    <p class="ops-control-note">
      Deletes field reports and inbound RapidPro messages past the
      configured retention window. Irreversible, and gated hardest of
      anything in this console.
    </p>
    <button id="opsRetention" class="btn btn-sm btn-reject" type="button">Apply retention…</button>
    <p class="ops-result" role="status" aria-live="polite"></p>
  </div>

  <div class="ops-control" id="opsConnectorsControl">
    <h4>Connector registry</h4>
    <p class="ops-control-note">Every connector the platform can run, with its last run.</p>
    <button id="opsConnectors" class="btn btn-sm" type="button">Load registry</button>
    <p class="ops-result" role="status" aria-live="polite"></p>
  </div>
</section>`
  return document.getElementById('opsApi')
}

/**
 * Wire every control. Bound to the Settings tab, which is the one panel whose
 * job is the platform's own machinery rather than a situation on the ground.
 */
export async function mountOps({ askToConfirm }) {
  const root = buildSection()
  if (!root || root.dataset.mounted) return
  root.dataset.mounted = '1'

  // Protocols first: the list has to exist before the buttons on it mean
  // anything, and a shadow run against a protocol the operator cannot see is
  // not an affordance.
  const list = root.querySelector('#opsProtocols')
  try {
    const payload = await json('/api/v1/trigger-protocols')
    const protocols = payload?.data || []
    list.innerHTML = protocols.length
      ? protocols.map(protocolRow).join('')
      : '<p class="empty-note">No trigger protocols configured.</p>'
    list.querySelectorAll('.ops-control').forEach((row) => {
      const protocol = protocols.find((p) => p.id === row.dataset.protocol)
      if (!protocol) return
      row.querySelector('[data-op="shadow"]')?.addEventListener('click', async () => {
        result(row, 'Evaluating…')
        await runShadow(protocol, row).catch((err) => result(row, String(err.message || err), 'notice-danger'))
      })
      row.querySelector('[data-op="backtest"]')?.addEventListener('click', async () => {
        result(row, 'Backtesting…')
        await runBacktest(protocol, row).catch((err) => result(row, String(err.message || err), 'notice-danger'))
      })
    })
  } catch (err) {
    list.innerHTML = `<p class="notice notice-warn">Trigger protocols unavailable: ${esc(String(err.message || err))}</p>`
  }

  // The button, not the control: `result` reports into the `.ops-result`
  // paragraph that sits beside the button, and reading it out of the button
  // finds nothing — a control that ran and reported nothing.
  const wire = (id, fn) => {
    const button = root.querySelector(`#${id}`)
    if (!button) return
    const control = button.closest('.ops-control')
    button.addEventListener('click', async () => {
      result(control, 'Working…')
      await fn(control).catch((err) => result(control, String(err.message || err), 'notice-danger'))
    })
  }

  wire('opsBiasCorrect', runBiasCorrect)
  wire('opsOutboxDispatch', runOutboxDispatch)
  wire('opsConnectors', renderConnectors)

  const retentionButton = root.querySelector('#opsRetention')
  const retentionControl = retentionButton?.closest('.ops-control')
  retentionButton?.addEventListener('click', async () => {
    result(retentionControl, 'Reading the collections that retention touches…')
    try {
      // The refusal is a string; a null return means the dialog opened. Reporting
      // "Review the dialog" over a refusal would replace the one sentence that
      // says why the delete did not happen.
      const refusal = await runRetention(askToConfirm)
      result(retentionControl, refusal || 'Review the dialog. Nothing has been deleted.', refusal ? 'notice-warn' : '')
    } catch (err) {
      result(retentionControl, String(err.message || err), 'notice-danger')
    }
  })
}
