/**
 * The action rail — what the platform DID about what the map is showing.
 *
 * The console's map, panels and counters all describe the world. This panel
 * describes the platform's own behaviour: which pre-authorised protocols are
 * armed, what each of them did last time, and how long a warning takes to become
 * a confirmed action in the field.
 *
 * Three commitments this module holds, each of which is a way the panel could
 * quietly lie:
 *
 * 1. **A refusal is content, not an error.** A playbook whose `notify` step
 *    declined because RapidPro is unconfigured has still opened an incident, and
 *    the operator's next action is to configure the gateway. Rendering that as an
 *    error, collapsing it, or filtering it out removes the most useful sentence
 *    on the page for a half-configured deployment. So `partial` and `refused`
 *    render as rows, in the warning colour, carrying the step's own `detail`.
 *
 * 2. **A failed request is not a refusal.** The server publishes a `refusal`
 *    string when it declined to compute a figure; that is a fact about the
 *    programme. A request that threw is a fact about this page, and rendering
 *    the two identically would tell an operator their response had not been
 *    confirmed often enough when in truth the console could not reach the server.
 *    Every panel below therefore carries its own failed flag, and the chips say
 *    which of the two happened.
 *
 * 3. **Nothing is hidden by default.** The panel appears when there is something
 *    to say — a protocol, or an execution, or a confirmation. An empty
 *    "Pre-authorised action" frame reads as a broken product rather than an
 *    unconfigured one.
 */

import { apiFetch, t } from '/shared/runtime.js'

/**
 * Translate, with an English fallback.
 *
 * `runtime.t` interpolates its second argument as params, so it cannot also be a
 * fallback string. This checks whether the catalogue actually had the key: a
 * missing translation degrades to readable English, where the raw helper
 * degrades to printing `ops.protocolModeShadow` at the operator.
 */
function tr(key, fallback) {
  const value = t(key)
  return value === key ? fallback : value
}

const $ = (id) => document.getElementById(id)

/**
 * Fetch one panel input, keeping failure distinguishable from an empty result.
 *
 * `apiSettled` returns `null` for both "the server said no figure" and "the
 * request threw", which is precisely the distinction commitment 2 turns on. So
 * this returns the failure as data rather than as an absent value.
 */
async function attempt(path, headers) {
  try {
    return { ok: true, data: await apiFetch(path, { headers }), failed: null }
  } catch (error) {
    return { ok: false, data: null, failed: error?.message || 'the server did not answer' }
  }
}

function railChip(id, value, { refused = false, failed = false, title = '' } = {}) {
  const el = $(id)
  if (!el) return
  el.textContent = value
  el.classList.toggle('is-refused', refused && !failed)
  el.classList.toggle('is-failed', failed)
  if (title) el.title = title
}

function setRailStatus(message) {
  const el = $('railStatus')
  if (el) el.textContent = message
}

/**
 * What can carry an alert out, and what can carry the answer back.
 *
 * Two different questions, and the server answers two different things, so they
 * are not merged into one count.
 *
 * **Outbound** is `enabled` — a RapidPro token exists, so a playbook's notify step
 * can reach a responder. Nothing else is configurable per deployment: there is no
 * USSD or IVR endpoint this platform holds credentials for, because USSD and IVR
 * are session types the gateway originates and relays. An earlier draft of this
 * panel read `ussd_enabled` / `ivr_enabled` off the status payload, which are not
 * fields on it — the chip would have read "SMS USSD IVR" on a deployment that could
 * send nothing at all.
 *
 * **Inbound** is what `parseRapidProReply` accepts: free text, a USSD digit answer
 * or an IVR key press. That is a property of the parser and holds for every
 * deployment, so it is stated as what it is — what will be understood — and is
 * never counted as a channel that is switched on.
 */
function outboundChannel(status) {
  return status?.enabled ? 'SMS' : null
}

/**
 * One protocol row.
 *
 * The condition is shown as the operator wrote it, not prettified: `counts.
 * hazard_events >= 3` is the thing they wrote and the thing they will recognise.
 * A prettified "3 or more hazard events" would be nicer and would also hide a
 * metric path that no longer resolves.
 */
function renderProtocolRow(protocol, latest, headers) {
  const row = document.createElement('tr')

  const name = document.createElement('td')
  name.textContent = protocol.name || protocol.metric
  row.appendChild(name)

  const condition = document.createElement('td')
  condition.className = 'is-mono'
  condition.textContent = `${protocol.metric} ${protocol.operator} ${protocol.threshold}`
  row.appendChild(condition)

  const mode = document.createElement('td')
  mode.textContent = protocol.mode === 'shadow'
    ? tr('ops.protocolModeShadow', 'shadow')
    : tr('ops.protocolModeLive', 'live')
  row.appendChild(mode)

  // The last execution for THIS protocol. `latest_per_protocol` is keyed by id,
  // so a protocol with no row yet is reported as having never run rather than
  // inheriting another protocol's status.
  const last = document.createElement('td')
  if (!latest) {
    last.textContent = tr('ops.neverRun', 'never')
    last.className = 'is-mono'
  } else {
    const badge = document.createElement('span')
    badge.className = 'rail-status-badge'
    badge.dataset.status = latest.status
    badge.textContent = latest.status
    last.appendChild(badge)
  }
  row.appendChild(last)

  const run = document.createElement('td')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-xs'
  // Labelled "Preview", not "Run", because pressing it does not act. A button
  // labelled "Run" that needs a confirmation afterwards has already taught the
  // operator the wrong expectation.
  button.textContent = tr('ops.runDry', 'Preview')
  button.addEventListener('click', (event) => previewProtocol(headers, event.currentTarget))
  run.appendChild(button)
  row.appendChild(run)

  return row
}

/**
 * Preview the protocols: a dry run, which returns the plan and writes nothing.
 *
 * The response is rendered as text rather than as a diff or a count, because
 * "what would happen" is a list of consequences and a count cannot say whether
 * any of them was a refusal.
 */
async function previewProtocol(headers, button) {
  // The pressed button, not a looked-up one: these are created per protocol row
  // and are never in the document by id, so disabling a global "the preview
  // button" would leave the one the operator actually clicked looking idle.
  if (button) button.disabled = true
  setRailStatus(tr('ops.previewing', 'Working out what these protocols would do…'))
  try {
    const result = await apiFetch('/api/v1/trigger-protocols/run', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    })
    const executions = result?.data?.executions || []
    if (!executions.length) {
      setRailStatus(tr('ops.previewNone', 'No protocol would fire right now.'))
      return
    }
    const lines = executions.map((execution) => {
      const who = execution.protocol_name || execution.protocol_id
      const detail = (execution.actions || [])
        .map((a) => `${a.type}:${a.status}` + (a.detail ? ` (${a.detail})` : ''))
        .join(', ')
      return `${who} — ${execution.status}${detail ? ` · ${detail}` : ''}`
    })
    setRailStatus(`${tr('ops.previewResult', 'Dry run — nothing was written:')} ${lines.join(' | ')}`)
  } catch (error) {
    // Named, not swallowed: a failed preview is the operator's only evidence
    // that the button is broken, and a silent failure makes the panel look inert
    // rather than wrong.
    setRailStatus(`${tr('ops.previewFailed', 'Could not preview the protocols:')} ${error?.message || 'the server did not answer'}`)
  } finally {
    if (button) button.disabled = false
  }
}

/** The execution feed: what happened, most recent first, refusals included. */
function renderExecutions(rows) {
  const list = $('railExecutions')
  const empty = $('railExecutionsEmpty')
  if (!list) return
  list.innerHTML = ''
  if (empty) empty.hidden = rows.length > 0

  for (const row of rows) {
    const li = document.createElement('li')

    const head = document.createElement('div')
    const badge = document.createElement('span')
    badge.className = 'rail-status-badge'
    badge.dataset.status = row.status
    // The status word is text, not a class alone, so it reaches a screen reader
    // and a colour-blind operator.
    badge.textContent = row.status
    head.appendChild(badge)
    head.appendChild(document.createTextNode(` ${row.protocol_name || row.protocol_id}`))
    li.appendChild(head)

    const meta = document.createElement('div')
    meta.className = 'rail-feed-meta'
    meta.textContent = `${row.fired_at || ''} · ${row.metric} ${row.operator} ${row.threshold} = ${row.observed_value}`
    li.appendChild(meta)

    for (const action of row.actions || []) {
      const chip = document.createElement('span')
      chip.className = 'rail-action-chip'
      chip.dataset.status = action.status
      chip.textContent = `${action.type}:${action.status}`
      if (action.detail) {
        // The reason, on hover AND as the accessible name. A title attribute
        // alone hides it from the people who most need it — the ones who cannot
        // read the colour.
        chip.title = action.detail
        chip.setAttribute('aria-label', `${action.type} ${action.status}: ${action.detail}`)
      }
      li.appendChild(chip)
    }

    if (row.alert_id) {
      const link = document.createElement('a')
      link.href = `#${row.alert_id}`
      link.className = 'rail-feed-meta'
      link.textContent = tr('ops.viewAlert', 'view alert')
      li.appendChild(link)
    }

    list.appendChild(li)
  }
}

/**
 * Load and render the whole rail.
 *
 * Each part settles independently: a failure on the summary must not blank the
 * protocol table, and a failure on the executions must not hide the fact that
 * the field-action figure is refusing. A single `Promise.all` would let the
 * slowest failure decide what the operator sees.
 *
 * `headers` is passed in rather than imported because the API key lives in the
 * settings field, which this module has no business reaching for.
 */
export async function renderActionRail(headers = {}) {
  const section = $('actionRail')
  if (!section) return

  const [protocols, summary, fieldAction, rapidpro, executions] = await Promise.all([
    attempt('/api/v1/trigger-protocols?limit=50', headers),
    attempt('/api/v1/protocol-executions/summary', headers),
    attempt('/api/v1/field-outcomes/summary', headers),
    attempt('/api/v1/rapidpro/status', headers),
    attempt('/api/v1/protocol-executions?limit=10', headers),
  ])

  const protocolRows = protocols.ok ? (protocols.data?.data || []) : []
  const latestByProtocol = summary.ok ? (summary.data?.latest_per_protocol || {}) : {}
  const executionRows = executions.ok ? (executions.data?.data || []) : []

  // Hidden only when there is genuinely nothing to say. A deployment with
  // protocols and no executions yet still shows, because "armed and has not
  // fired" is information and silence would read as "not configured".
  const hasSomething = protocolRows.length > 0 || executionRows.length > 0
  section.hidden = !hasSomething
  if (!hasSomething) return

  const live = protocolRows.filter((p) => p.mode !== 'shadow').length
  railChip('railProtocolsLive', `${tr('ops.protocolsLive', 'live')} ${live}/${protocolRows.length}`, { failed: !protocols.ok })
  railChip(
    'railExecutions24h',
    `${tr('ops.executions24h', 'executions 24 h')} ${summary.ok ? (summary.data?.last_24h ?? 0) : '—'}`,
    { failed: !summary.ok, title: summary.failed || '' },
  )

  // The server's refusal is the value; a failed request is reported as a failure.
  // A dash here would read as "zero hours" or "no data", and for a failed request
  // it would also be false.
  if (!fieldAction.ok) {
    railChip('railFieldAction', `${tr('ops.fieldAction', 'field action')} —`, { failed: true, title: fieldAction.failed })
  } else if (fieldAction.data?.refusal) {
    railChip('railFieldAction', tr('ops.belowFloor', 'below sample floor'), {
      refused: true,
      title: fieldAction.data.refusal,
    })
  } else if (fieldAction.data?.median_hours !== undefined && fieldAction.data?.median_hours !== null) {
    railChip('railFieldAction', `${tr('ops.fieldAction', 'field action')} ${fieldAction.data.median_hours} h`, {
      title: `${fieldAction.data.samples ?? 0} ${tr('ops.confirmations', 'confirmations')}${fieldAction.data.basis ? ` · ${fieldAction.data.basis}` : ''}`,
    })
  } else {
    railChip('railFieldAction', `${tr('ops.fieldAction', 'field action')} —`, { refused: true })
  }

  // Outbound first: a playbook's notify step can only reach someone if the
  // gateway holds a token. When it does not, this is the refusal an operator
  // needs to see and act on, so it is never folded into "0 channels" or hidden.
  const outbound = rapidpro.ok ? outboundChannel(rapidpro.data?.data || rapidpro.data) : null
  railChip(
    'railChannels',
    `${tr('ops.channels', 'channels')} ${outbound || tr('ops.channelNone', 'none configured')}`,
    {
      refused: rapidpro.ok && !outbound,
      failed: !rapidpro.ok,
      title: rapidpro.ok && !outbound ? tr('ops.channelNoneWhy', 'no RapidPro token: set RAPIDPRO_API_TOKEN to reach responders') : (rapidpro.failed || ''),
    },
  )

  const body = $('railProtocolBody')
  const emptyNote = $('railProtocolEmpty')
  if (body) {
    body.innerHTML = ''
    if (emptyNote) emptyNote.hidden = protocolRows.length > 0
    for (const protocol of protocolRows) {
      body.appendChild(renderProtocolRow(protocol, latestByProtocol[protocol.id], headers))
    }
  }

  renderExecutions(executionRows)

  // The status line names what failed rather than leaving a chip to explain it,
  // and is empty when everything answered.
  const failures = [protocols, summary, fieldAction, rapidpro, executions]
    .filter((f) => !f.ok)
    .map((f) => f.failed)
  setRailStatus(failures.length
    ? `${tr('ops.partialLoad', 'Some panels could not load:')} ${failures.join(' · ')}`
    : '')
}

/**
 * Wire the rail's own controls.
 *
 * `getHeaders` is a function rather than a headers object because the API key
 * can be set on the Settings tab long after this runs, so capturing the headers
 * once would bind the button to a key that was blank at boot.
 *
 * Idempotent: the console re-renders on every tick, and a second listener on the
 * Refresh button would fire two refreshes — each fetching five endpoints.
 */
let _wired = false
export function mountActionRail(getHeaders) {
  if (_wired) return
  _wired = true
  const refresh = $('railRefresh')
  if (refresh) refresh.addEventListener('click', () => renderActionRail(getHeaders()))
}