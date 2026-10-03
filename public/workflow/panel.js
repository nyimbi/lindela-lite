/**
 * The six-attribute subject panel.
 *
 * The JTBD catalogue's Definition of Done item 11 asks for current state,
 * owner, next action, blockers, deadline and history on one panel, without the
 * operator navigating between screens. Three of the six are stored.
 * `workflow_instances` carries `state`, `owner` and `transitions[]`; nothing in
 * src/ writes a deadline, a blocker or a next action for a workflow, and
 * normalizeWorkflowInstance in src/workflows.js is the only place an instance is
 * shaped, so the absence is a property of the schema and not of this render.
 *
 * The panel therefore prints the three and names the other three as unrecorded,
 * in a sentence. An em dash in a "Deadline" row is not neutral: it reads as
 * "nothing due", which is a claim about a deadline. What is true is that the
 * platform holds no deadline at all, and an operator acting on the first
 * reading would be acting on a field that does not exist.
 */

import { apiFetch } from '/shared/runtime.js'
import { esc, formatRelative, formatTimestamp } from '/shared/fmt.js'

/**
 * How to fetch and name each subject kind the panel understands.
 *
 * All three are read from the collection rather than from `/kind/:id`.
 * `GET /api/v1/incidents/:id` and `GET /api/v1/alert-events/:id` exist;
 * `GET /api/v1/service-assets/:id` does not — src/server.js handles only the
 * bare `/api/v1/service-assets` pathname. A panel that assumed the single-record
 * route worked would open successfully for an incident and 404 for an asset,
 * which is the subject kind an operator is least likely to have open in another
 * tab and most likely to be trying to find.
 */
export const SUBJECT_KINDS = {
  alert_event: {
    label: 'Alert event',
    path: '/api/v1/alert-events?limit=500',
    log: 'alert_events',
    name: (r) => r.rule_name || r.message || r.id,
    state: (r) => r.status,
  },
  incident: {
    label: 'Incident',
    path: '/api/v1/incidents?limit=500',
    log: 'incidents',
    name: (r) => r.title || r.id,
    state: (r) => r.status,
  },
  service_asset: {
    label: 'Service asset',
    path: '/api/v1/service-assets?limit=500',
    log: 'service_assets',
    name: (r) => r.name || r.id,
    // An asset is not a case. It has no status to report, and printing an empty
    // cell beside "Current state" would imply one exists.
    state: () => null,
  },
}

const dialog = () => document.getElementById('subjectPanelDialog')
const body = () => document.getElementById('subjectPanelBody')
const title = () => document.getElementById('subjectPanelTitle')

/**
 * Where the keyboard was before the panel took it.
 *
 * Most of these panels open from a button the console rebuilt thirty seconds
 * ago or from a palette row that has already been removed from the list, so the
 * opener is frequently gone by the time the panel closes. Focus therefore falls
 * back to the rail rather than to the top of the document.
 */
const openers = new WeakMap()

export function mountDialog(dlg) {
  if (!dlg || dlg.dataset.mounted) return
  dlg.dataset.mounted = '1'
  openers.set(dlg, document.activeElement === document.body ? null : document.activeElement)
  // Backdrop click, not a click handler on every child: the dialog's own box is
  // the only region where the click missed the content.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  dlg.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => dlg.close())
  })
  dlg.addEventListener('close', () => {
    const opener = openers.get(dlg)
    if (opener && opener.isConnected && opener.tabIndex >= 0) opener.focus()
    else document.getElementById('railPanel')?.focus()
  })
}

function row(label, value, { missing } = {}) {
  return `<div class="subject-attr">
    <dt>${esc(label)}</dt>
    <dd class="${missing ? 'subject-unrecorded' : ''}">${value}</dd>
  </div>`
}

/**
 * The three attributes the schema does not hold, stated rather than dashed.
 *
 * Kept as one place so the wording is identical in every panel and a reader who
 * has seen it once knows what it means the second time.
 */
function unrecorded(attribute, schemaNote) {
  return `<span class="subject-unrecorded">Not recorded</span> <span class="subject-unrecorded-note">${esc(schemaNote)}</span>`
}

const NO_DEADLINE = 'no workflow field records a deadline; the SLA the catalogue asks for is not implemented.'
const NO_BLOCKERS = 'no workflow field records a blocker; nothing in the store links one instance to another.'
const NO_NEXT_ACTION = 'the legal next states are enforced server-side and are not published by the API, so the panel cannot name one without guessing.'

function historyList(transitions) {
  if (!transitions.length) {
    return '<p class="subject-empty">No transitions recorded. An instance that has never moved looks exactly like one whose history was lost; both are what the store holds.</p>'
  }
  return `<ol class="subject-history">${transitions.slice().reverse().map((t) => `
    <li class="subject-history-entry">
      <span class="subject-history-move">${esc(String(t.from).replace(/_/g, ' '))} → ${esc(String(t.to).replace(/_/g, ' '))}</span>
      <span class="subject-history-meta">
        ${esc(formatRelative(t.timestamp))}${t.timestamp ? ` · ${esc(formatTimestamp(t.timestamp))}` : ''}
        ${t.actor ? ` · ${esc(t.actor)} <span class="subject-history-source" title="How this actor was established">(${esc(t.actor_source || 'unattributed')})</span>` : ''}
      </span>
      ${t.reason ? `<span class="subject-history-reason">${esc(t.reason)}</span>` : ''}
      ${t.evidence ? `<span class="subject-history-reason">${esc(t.evidence)}</span>` : ''}
    </li>`).join('')}</ol>`
}

/**
 * History for a subject no workflow governs.
 *
 * `action_logs` is a different thing from a transition log and says less: an
 * action name and a timestamp, not a from/to pair. Labelled as what it is,
 * because a reader who took it for a transition history would infer moves the
 * platform never recorded.
 */
function actionLogHistory(logs, collection) {
  if (!logs.length) {
    return `<p class="subject-empty">No action log entries for this ${esc(collection)}. An untouched record and one whose log was pruned read the same.</p>`
  }
  return `<ol class="subject-history">${logs.map((entry) => `
    <li class="subject-history-entry">
      <span class="subject-history-move">${esc(entry.action)}</span>
      <span class="subject-history-meta">
        ${esc(formatRelative(entry.created_at))}${entry.created_at ? ` · ${esc(formatTimestamp(entry.created_at))}` : ''}
        ${entry.actor ? ` · ${esc(entry.actor)}` : ''}
      </span>
    </li>`).join('')}</ol>`
}

async function loadWorkflowFor(subject, preferredId) {
  try {
    const payload = await apiFetch('/api/v1/workflows?limit=500')
    const instances = payload?.data || []
    const match = instances.find((w) =>
      preferredId ? w.id === preferredId
        : w.subject_kind === subject.kind && w.subject_id === subject.id)
    return { instance: match || null, attached: instances.some((w) => w.subject_kind === subject.kind && w.subject_id === subject.id) }
  } catch (err) {
    // The panel's other four attributes do not depend on this request, so a
    // failed lookup costs the workflow rows and names the failure rather than
    // leaving an operator looking at a panel that quietly has no history.
    console.error('Workflow lookup failed:', err)
    return { instance: null, attached: false, failed: true }
  }
}

async function loadActionLogs(collection, id) {
  try {
    const payload = await apiFetch('/api/v1/action-logs?limit=500')
    return (payload?.data || []).filter((entry) => entry.record_id === id)
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
  } catch (err) {
    console.error('Action log lookup failed:', err)
    return []
  }
}

/** The panel on a workflow instance that is not attached to a subject yet. */
function renderUnattached(instance) {
  if (title()) title().textContent = `${instance.type} · ${instance.id}`
  body().innerHTML = `
    <p class="subject-lead">This workflow instance names no subject. Nothing it acts on is recorded, so the panel can report the instance and nothing else.</p>
    <dl class="subject-attrs">
      ${row('Current state', esc(String(instance.state || '').replace(/_/g, ' ')))}
      ${row('Owner', instance.owner ? esc(instance.owner) : '<span class="subject-unrecorded">Not recorded</span> <span class="subject-unrecorded-note">owner is an empty string on every instance raised without one.</span>')}
      ${row('Next action', unrecorded('next action', NO_NEXT_ACTION))}
      ${row('Blockers', unrecorded('blockers', NO_BLOCKERS))}
      ${row('Deadline', unrecorded('deadline', NO_DEADLINE))}
    </dl>
    <h3 class="subject-section">History</h3>
    ${historyList(instance.transitions || [])}
  `
}

function renderSubject({ kind, record, workflow, logs, workflowFailed }) {
  const spec = SUBJECT_KINDS[kind]
  const label = workflow ? `${spec.label} · ${workflow.type}` : spec.label
  if (title()) title().textContent = record ? (spec.name(record) || record.id) : label

  const subjectState = spec.state(record)
  const owner = workflow?.owner || ''

  body().innerHTML = `
    <dl class="subject-attrs">
      ${row('Current state', workflow
        ? `${esc(String(workflow.state || '').replace(/_/g, ' '))} <span class="subject-attr-note">via ${esc(String(workflow.type).replace(/_/g, ' '))} workflow</span>`
        : (subjectState ? esc(subjectState) : '<span class="subject-unrecorded">Not recorded</span> <span class="subject-unrecorded-note">a service asset is not a case and carries no status.</span>'))}
      ${row('Owner', owner
        ? esc(owner)
        : '<span class="subject-unrecorded">Not recorded</span> <span class="subject-unrecorded-note">the workflow schema has an owner field and nothing writes it in this deployment.</span>')}
      ${row('Next action', unrecorded('next action', NO_NEXT_ACTION))}
      ${row('Blockers', unrecorded('blockers', NO_BLOCKERS))}
      ${row('Deadline', unrecorded('deadline', NO_DEADLINE))}
      ${row('Subject', `${esc(spec.label)} <code>${esc(record.id)}</code>`)}
      ${row('Opened', record.created_at ? `${esc(formatRelative(record.created_at))} · ${esc(formatTimestamp(record.created_at))}` : '<span class="subject-unrecorded">Not recorded</span>')}
    </dl>
    ${workflowFailed ? '<p class="notice notice-warn">The workflow list could not be read, so the state, owner and history below are missing. Everything else on this panel is from the subject record.</p>' : ''}
    <h3 class="subject-section">History</h3>
    ${workflow
      ? historyList(workflow.transitions || [])
      : actionLogHistory(logs, spec.label.toLowerCase())}
  `
}

/**
 * Open the panel on one subject.
 *
 * `ref.kind` is a key of SUBJECT_KINDS, or 'workflow_instance' when the caller
 * has an instance rather than a subject — the workflow ribbon lists instances,
 * and most of them are attached to a subject the operator can also reach from
 * the alert list, so the panel follows the link rather than duplicating the
 * instance's own fields in two places.
 */
export async function openSubjectPanel(ref) {
  const dlg = dialog()
  if (!dlg) return
  mountDialog(dlg)
  if (body()) body().innerHTML = '<p class="subject-empty">Loading…</p>'
  dlg.showModal()

  try {
    if (ref.kind === 'workflow_instance') {
      const payload = await apiFetch(`/api/v1/workflows/${encodeURIComponent(ref.id)}`)
      const instance = payload?.data
      if (!instance) throw new Error('Workflow instance not found')
      if (!instance.subject_id) return renderUnattached(instance)
      return openSubjectPanel({ kind: instance.subject_kind, id: instance.subject_id, viaWorkflow: instance.id })
    }

    const spec = SUBJECT_KINDS[ref.kind]
    if (!spec) throw new Error(`Unknown subject kind: ${ref.kind}`)

    const record = (await apiFetch(spec.path))?.data?.find((r) => r.id === ref.id)
    if (!record) throw new Error(`${spec.label} not found in the first 500 records of ${spec.label.toLowerCase()}s`)

    const { instance, attached, failed } = await loadWorkflowFor(ref, ref.viaWorkflow)
    const logs = instance || !attached ? [] : await loadActionLogs(spec.log, record.id)
    renderSubject({ kind: ref.kind, record, workflow: instance, logs, workflowFailed: failed })
  } catch (err) {
    if (body()) {
      body().innerHTML = `<p class="notice notice-danger">Could not load this subject: ${esc(String(err.message || err))}</p>`
    }
  }
}
