// =============================================================
// Lindela Lite — ENH-19 wiring: "where did this number come from"
// =============================================================
// Clicking a map marker or an alert row has always opened a dialog that printed
// the record's own fields: a `<dl>` of the API's response, with the score among
// them and no way to ask why it is that number. This module puts the derivation
// above that list — the terms, their weights, what each contributed, what was
// missing, and whether the arithmetic the console can recompute agrees with the
// number it published.
//
// **Two sources, and the split between them matters.** `GET /api/v1/explain/:id`
// exists (`src/server.js`) and serves records out of the store collections by
// `?kind=`, returning the record plus its provenance — the source run that
// produced it and the lineage rows behind that run. That provenance cannot be
// computed in the browser: it is other rows in the store, joined by id. So for a
// record the route serves, this fetches it and renders the provenance it returns.
//
// Everything else — the arithmetic — comes from `explainRecord` in
// `public/shared/viz-explain.js`, run on the record the click already carried.
// One implementation of the derivation, in the module the tests guard, rather
// than a server copy that drifts. The optional `lookup` that module accepts is
// left out on purpose: those source records are not in the console's store under
// the same key, and a list of ids that resolve to nothing is worse than saying
// the term is a sum over records we are not holding.
//
// A record the route does not serve — an alert event, a hazard event, a service
// asset — gets the derivation and a line saying its origin could not be traced,
// rather than a 404 and an empty dialog.

import { explainRecord } from '/shared/viz-explain.js'
import { sensitivityRange } from '/shared/viz-uncertainty.js'
import { esc } from '/shared/fmt.js'

const num = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const shown = (v) => (v === null || v === undefined || v === '' ? 'not recorded' : String(v))

const paragraphs = (cls, items) => items.map((i) => `<p class="${cls}">${i}</p>`).join('')

/**
 * The terms, as a table: what was read, what it was worth, what it contributed.
 *
 * A term that contributes but cannot be recomputed says so in its own row. That
 * row is the honest minimum, and hiding it would let the equation below the
 * table sum to less than the score above it without saying why.
 *
 * The input value is joined from `explanation.inputs` on the driver key rather
 * than read off the term: a `sumOf` term's number is a count of records, and
 * showing it under a weight that does not exist would be a column that reads as
 * "3 x something".
 */
function termsTable(terms, inputs) {
  if (!terms.length) return ''
  const byKey = new Map((inputs || []).map((i) => [i.key, i]))
  const rows = terms.map((term) => {
    const contribution = term.contribution
    const value = contribution === null || contribution === undefined
      ? '<span class="chart-panel-refused">contributes; not recomputable from this record alone</span>'
      : `${contribution} — ${term.contributing ? 'contributing' : 'contributes nothing'}`
    return `<tr>
      <th scope="row">${esc(term.name)}<br /><span class="chart-panel-note">${esc(term.note)}</span></th>
      <td>${esc(shown(byKey.get(term.reads)?.value))}${term.unit ? ` ${esc(term.unit)}` : ''}</td>
      <td class="num">${value}</td>
    </tr>`
  }).join('')
  return `<div class="chart-table"><table class="data-alt">
    <caption>Contributing terms, as the scorer read them</caption>
    <thead><tr>
      <th scope="col">Term</th><th scope="col">Input</th><th scope="col" class="num">Contribution</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

/**
 * The confidence vector, as points awarded per input class.
 *
 * The point of showing this is the sentence under it: coverage is scored for the
 * *presence* of an input class, so a district with one hazard event and a
 * district with four hundred score the same, and a reader who treats the number
 * as a sample size will over-trust the thin one.
 */
function confidenceBlock(confidence) {
  if (!confidence) return ''
  const rows = (confidence.parts || []).map((part) => `<tr>
    <th scope="row">${esc(part.part)}</th>
    <td class="num">${esc(shown(part.count))}</td>
    <td class="num">${part.awarded ? `+${part.weight}` : 'not awarded'}</td>
  </tr>`).join('')
  const rowsHtml = rows ? `<div class="chart-table"><table class="data-alt">
    <caption>Input coverage, in points — presence of the class, not how many of it</caption>
    <thead><tr>
      <th scope="col">Input class</th><th scope="col" class="num">Count</th><th scope="col" class="num">Points</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>` : ''
  return rowsHtml + `<p class="chart-panel-note">${esc(confidence.statement)}</p>`
}

/** The band's own geometry, drawn on the record's own bounded scale. */
function bandBlock(record, explanation) {
  const band = explanation.band
  if (!band || (band.low === null && band.high === null)) return ''
  let out = ''
  try {
    // Throws on a record claiming a calibrated interval. The console catches that
    // and shows the refusal rather than a relabelled predictive interval.
    out = sensitivityRange(record, { title: `${record?.region_name || record?.id || 'Score'} — sensitivity band` }).svg
  } catch (err) {
    return `<p class="chart-panel-refused">${esc(err.message)}</p>`
  }
  return `<p class="chart-panel-title">Sensitivity band</p>${out}`
}

/**
 * The store collection a record type lives in, or null.
 *
 * The default `?kind=` is risk_scores; a caller names any other collection it
 * wants. Two things decide what this panel may fetch:
 *
 *   - The record's `type` field, for the derived scores that carry one.
 *   - The record's `source` field, when source IS the store collection's name
 *     (service_assets records carry it). It is NOT always the collection: a
 *     hazard_event's source is `gdacs`, an upstream ingestor's id, and asking
 *     explain for that kind is a 404 by design. Only a real collection name is
 *     used; anything else gets the truthful refusal, which names the value and
 *     says nothing was fetched for it.
 */
const KIND_BY_TYPE = Object.freeze({
  flood_risk: 'risk_scores',
  climate_conflict_risk: 'risk_scores',
})

/** `/^[a-z][a-z0-9_]+$/` and at least one underscore, to keep upstream source
 *  ids like `gdacs` or `acled_csv` from masquerading as collection names. */
function collectionMaybeFromSource(source) {
  if (typeof source !== 'string' || !/^[a-z][a-z0-9_]+_[a-z0-9_]+$/.test(source)) return null
  return source
}

/** The provenance block, from whatever `/api/v1/explain` returned. */
function provenanceBlock(provenance, served, refusal) {
  // The four reasons provenance can be missing are different facts and say
  // different things: the route was not fetched (no kind was derived), the
  // fetch failed (network), the route has no such record (404), or the
  // record genuinely names no run (a 200 with known:false). The first three
  // are rendered by the caller as a refusal naming what actually happened;
  // this block only renders when a real answer arrived.
  if (!served) return refusal || ''
  const run = provenance?.source_run
  const lineage = Array.isArray(provenance?.lineage) ? provenance.lineage : []
  if (!run && !lineage.length) {
    return `<p class="chart-panel-note">Provenance: ${esc(provenance?.note || 'no source run is named by this record, so its origin cannot be traced from the store.')}</p>`
  }
  const bits = [
    run?.id ? `source run ${esc(String(run.id))}` : null,
    run?.source_id ? `from ${esc(String(run.source_id))}` : null,
    run?.started_at || run?.created_at ? `at ${esc(String(run.started_at || run.created_at))}` : null,
    `${lineage.length} lineage row${lineage.length === 1 ? '' : 's'}`,
  ].filter(Boolean)
  const rows = lineage.slice(0, 10).map((l) => `<tr><th scope="row">${esc(String(l.field ?? l.column ?? l.source_id ?? 'lineage'))}</th>`
    + `<td>${esc(String(l.source ?? l.origin ?? '—'))}</td>`
    + `<td>${esc(String(l.recorded_at ?? l.at ?? '—'))}</td></tr>`).join('')
  return `<p class="chart-panel-title">Provenance</p>`
    + `<p class="chart-panel-note">${bits.join(' · ')}</p>`
    + (rows
      ? `<div class="chart-table"><table class="data-alt"><caption>Lineage behind this record</caption>`
        + `<thead><tr><th scope="col">Field</th><th scope="col">Source</th><th scope="col">Recorded</th></tr></thead>`
        + `<tbody>${rows}</tbody></table></div>`
      : '')
}

/**
 * Render the derivation of one record into `host`.
 *
 * `load` is the console's own authenticated `fetchJson`. It is a parameter
 * rather than an import so this module has no idea how the console authenticates,
 * and so a caller without one still gets the full derivation.
 *
 * Returns the explanation object so a caller that wants to keep it — for a test,
 * or for the console palette — does not have to recompute it.
 */
export async function renderExplain(host, record, { load, kind } = {}) {
  if (!host || !record) return null
  // An alert event is not a score. Its own derivation IS the explanation — the
  // score path below would only refuse to decompose what was never computed.
  const alertKind = alertEventKind(record)
  if (alertKind) return renderAlertExplain(host, record, load, alertKind)
  let explanation
  try {
    explanation = explainRecord(record)
  } catch (err) {
    host.innerHTML = `<p class="chart-panel-refused">${esc(err.message)}</p>`
    return null
  }

  const collection = kind || KIND_BY_TYPE[record?.type] || collectionMaybeFromSource(record?.source) || null
  let served = null
  let fetchState = null // null | 'unreachable' | 'not-a-record'
  if (collection && typeof load === 'function' && record?.id) {
    try {
      const body = await load(`/api/v1/explain/${encodeURIComponent(record.id)}?kind=${encodeURIComponent(collection)}`)
      if (body?.success === false) {
        served = null
        fetchState = 'not-a-record'
      } else {
        served = body
      }
    } catch {
      // A record the store cannot serve, or a console running without a
      // network. Neither invalidates the arithmetic, so the derivation still
      // renders and the provenance line says why it is thin.
      served = null
      fetchState = 'unreachable'
    }
  }

  const provedanceRefusal = !collection
    ? `<p class="chart-panel-refused">The dashboard does not know a /api/v1/explain kind for this record's <code>${esc(String(record?.source || 'type'))}</code>. Nothing was fetched, and the derivation below is what this record itself carries.</p>`
    : fetchState === 'unreachable'
      ? `<p class="chart-panel-refused">/api/v1/explain could not be reached for <code>${esc(String(record.id))}</code> (kind=${esc(collection)}); the derivation below is what this record itself carries.</p>`
      : fetchState === 'not-a-record'
        ? `<p class="chart-panel-refused">/api/v1/explain answered 404 for <code>${esc(String(record.id))}</code> with kind=${esc(collection)}. The derivation below is what this record itself carries.</p>`
        : null

  const verdict = explanation.consistent === null
    ? 'not checkable from this record alone'
    : explanation.consistent ? 'the recomputed terms agree with the published score' : 'the recomputed terms disagree with the published score'
  const confidenceVerdict = explanation.confidence?.consistent === null
    ? ''
    : explanation.confidence.consistent ? '' : ' Coverage points do not add up to the published figure.'

  const provenance = explanation.provenance
  const provenanceBits = [
    provenance.generated_at ? `computed ${esc(String(provenance.generated_at))}` : null,
    provenance.source ? `source ${esc(String(provenance.source))}` : null,
  ].filter(Boolean).join(' · ')

  host.innerHTML = `
    <p class="chart-panel-title">${esc(explanation.title)}</p>
    <p class="chart-panel-note">${esc(explanation.caption)}</p>
    <p class="chart-panel-note"><strong>Arithmetic:</strong> ${esc(explanation.equation)}</p>
    <p class="chart-panel-note"><strong>Self-check:</strong> ${esc(verdict)}.${esc(confidenceVerdict)}</p>
    ${termsTable(explanation.terms, explanation.inputs)}
    ${confidenceBlock(explanation.confidence)}
    ${bandBlock(record, explanation)}
    ${explanation.missing.length ? `<p class="chart-panel-title">Absent inputs</p>${paragraphs('chart-panel-refused', explanation.missing.map((m) => `${esc(m.key)} — ${esc(m.reason || 'contributed nothing')}`))}` : ''}
    ${explanation.limits.length ? `<p class="chart-panel-title">What this score does not model</p>${paragraphs('chart-panel-note', explanation.limits.map((l) => esc(l)))}` : ''}
    ${provenanceBlock(served?.provenance, served, provedanceRefusal)}
    ${provenanceBits ? `<p class="chart-panel-note">${provenanceBits}${provenance.methodology ? ` · ${esc(provenance.methodology)}` : ''}</p>` : ''}`
  return explanation
}

// =============================================================
// Alert events — the explain panel reading a fired alert
// =============================================================
// An alert has no score to decompose, and the generic path correctly refuses
// to invent one. What it CAN answer — from the record alone — is the question
// the alert card answers too: which conditions were read, whether they held,
// what authorised the fire, and what authorisation DID. All three travel on
// the alert (derivation.condition_set, approval, metadata.playbook_results);
// the two facts that live in other rows — the protocol's agreed date, and a
// playbook outcome recorded before that field existed — are fetched through
// the caller's loader and never invented.

/**
 * Is this record an alert event, and which engine fired it?
 *
 * `rule_schema: 'protocol/1'` is the pre-authorised protocol path
 * (src/protocols.js); `'1'` is a registered scoring rule (src/alerts.js).
 * Both are written by the alert builders at fire time, so this is a fact
 * about how the record was made, not a shape guess. Anything else is not an
 * alert and takes the score path untouched.
 */
function alertEventKind(record) {
  const schema = record?.derivation?.engine?.rule_schema
  if (schema === 'protocol/1') return 'protocol'
  if (schema === '1') return 'rule'
  return null
}

/** The place an alert names, joined the way the alert card joins it —
 *  name, admin1, country; coordinates when no name exists. The counterpart
 *  of `alertWhere` in public/app.js; kept local because the console module
 *  is not importable from here. */
function alertWhereText(record) {
  const parts = [record?.location?.name, record?.location?.admin1, record?.location?.country]
    .filter((p) => p !== null && p !== undefined && p !== '')
    .map((p) => String(p))
  if (parts.length) return parts.join(', ')
  const lat = Number(record?.location?.latitude)
  const lon = Number(record?.location?.longitude)
  if (Number.isFinite(lat) && Number.isFinite(lon)) return `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  const district = record?.scope?.district ?? record?.metadata?.district
  return district === null || district === undefined || district === '' ? null : String(district)
}

/** The condition set, one row per term, plus the combinator and fail-closed
 *  answer. Satisfied is a three-state answer on purpose: a term that could
 *  not resolve at all is not "not satisfied" — it is unresolvable, and that
 *  is exactly what stops the whole set (fail-closed). */
function conditionSetBlock(conditionSet) {
  const rows = (conditionSet.terms || []).map((term) => {
    const observed = term.term_unresolvable || term.observed_value === null || term.observed_value === undefined
      ? 'unresolvable'
      : String(term.observed_value)
    const verdict = term.term_unresolvable
      ? 'unresolvable'
      : term.satisfied ? 'satisfied' : 'not satisfied'
    return `<tr>`
      + `<th scope="row">${esc(String(term.metric))}</th>`
      + `<td>${esc(String(term.negate ? `NOT ${term.operator}` : term.operator))} ${esc(String(term.threshold))}</td>`
      + `<td class="num">${esc(observed)}</td>`
      + `<td>${esc(verdict)}</td>`
      + `</tr>`
  }).join('')
  const combinator = String(conditionSet.combinator || 'and').toUpperCase()
  const negateNote = conditionSet.negate
    ? '<p class="chart-panel-note">The set result is inverted (NOT): the alert fires when the combined conditions together fail.</p>'
    : ''
  const evaluableNote = conditionSet.evaluable === false
    ? '<p class="chart-panel-refused">fail-closed: an unresolvable term never fires</p>'
    : ''
  return `<p class="chart-panel-title">Conditions, as the executor read them</p>`
    + `<p class="chart-panel-note">Combined with ${esc(combinator)}.</p>`
    + `<div class="chart-table"><table class="data-alt">`
    + `<thead><tr><th scope="col">Metric</th><th scope="col">Condition</th><th scope="col" class="num">Observed</th><th scope="col">Verdict</th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`
    + negateNote
    + evaluableNote
}

/**
 * The pre-authorisation block. The alert's own approval fields render
 * directly; the protocol's `agreed_at` and name live in the protocol record,
 * fetched by the id the alert already carries — and a fetch that did not
 * happen says so rather than inventing a date or an approver.
 */
function preAuthorisationBlock(alert, protocolRecord, protocolFetchState, protocolId) {
  const approval = alert.approval || {}
  let refused = ''
  if (!protocolRecord) {
    const reason = protocolFetchState === 'no-loader'
      ? `The protocol record (${esc(String(protocolId))}) was not fetched: no authenticated loader is available, so its agreed date and name cannot be shown from the store.`
      : protocolFetchState === 'unreachable'
        ? `The protocol record (${esc(String(protocolId))}) could not be fetched; its agreed date is not checkable from this record alone.`
        : `The protocol record (${esc(String(protocolId))}) is not in this store.`
    refused = `<p class="chart-panel-refused">${reason}</p>`
  }
  const name = protocolRecord?.name || alert.rule_name || String(protocolId)
  const agreedAt = protocolRecord?.agreed_at ?? approval.agreed_at ?? null
  const approvers = Array.isArray(approval.approvers) && approval.approvers.length
    ? approval.approvers.map((a) => esc(String(a))).join(', ')
    : null
  const lines = [`Pre-authorised by protocol ${esc(String(name))} v${esc(String(approval.protocol_version ?? ''))}`, `protocol id ${esc(String(protocolId))}`, `decided ${esc(String(approval.decided_at ?? ''))}`]
  if (agreedAt) lines.push(`agreed ${esc(String(agreedAt))}`)
  const approverLine = approvers
    ? `<p class="chart-panel-note">Approvers: ${approvers}</p>`
    : '<p class="chart-panel-refused">No approvers are recorded on this alert; the pre-authorisation cannot be attributed.</p>'
  return `<p class="chart-panel-title">Pre-authorisation</p>`
    + `<p class="chart-panel-note">${lines.join(' · ')}</p>`
    + approverLine
    + refused
}

/** One playbook outcome table, or the honest empty when nothing is recorded. */
function playbookOutcomeBlock(alert, executionActions, outcomeSource) {
  const rows = Array.isArray(executionActions) ? executionActions : []
  if (!rows.length) {
    return '<p class="chart-panel-refused">No playbook outcome is recorded for this alert.</p>'
  }
  const body = rows.map((row) => `<tr>`
    + `<th scope="row">${esc(String(row?.type || 'unknown'))}</th>`
    + `<td><span class="status-pill status-${esc(String(row?.status || 'unknown'))}">${esc(String(row?.status || 'unknown'))}</span></td>`
    + `<td>${esc(String(row?.detail || ''))}</td>`
    + `<td>${row?.record_id ? `<code>${esc(String(row.record_id))}</code>` : ''}</td>`
    + `</tr>`).join('')
  const sourceNote = outcomeSource === 'execution'
    ? '<p class="chart-panel-note">Outcome read from the linked execution record (the alert itself predates the field).</p>'
    : ''
  return `<p class="chart-panel-title">Playbook outcome</p>${sourceNote}`
    + `<div class="chart-table"><table class="data-alt">`
    + `<thead><tr><th scope="col">Step</th><th scope="col">Status</th><th scope="col">Detail</th><th scope="col">Record</th></tr></thead>`
    + `<tbody>${body}</tbody></table></div>`
}

/** The rule derivation, for alerts a registered scoring rule fired. */
function ruleDerivationBlock(record) {
  const d = record.derivation || {}
  const ids = Array.isArray(d.input_record_ids) ? d.input_record_ids : null
  const countLines = []
  if (ids) countLines.push(`the reading was computed from ${ids.length} record(s)`)
  else countLines.push('the reading has no per-record inputs it can name (an aggregate over the store)')
  if (d.input_record_ids_truncated === true && d.input_record_ids_total != null) {
    countLines.push(`the id list is a sample of ${String(d.input_record_ids_total)}`)
  }
  const where = alertWhereText(record)
  const whereLine = where
    ? `<p class="chart-panel-note"><strong>Where:</strong> ${esc(where)}</p>`
    : '<p class="chart-panel-note"><strong>Where:</strong> <span class="chart-panel-refused">not recorded for this alert</span></p>'
  const approval = record.approval || {}
  const approvalLine = approval.state === 'approved'
    ? `<p class="chart-panel-note"><strong>Approval:</strong> ${esc(String(approval.reviewer || 'unknown'))} at ${esc(String(approval.reviewed_at || ''))}${approval.decision_note ? ` — ${esc(String(approval.decision_note))}` : ''}</p>`
    : ''
  return `<p class="chart-panel-note">Rule version at fire: ${esc(String(d.rule_version ?? 'unknown'))} · rule then named “${esc(String(d.rule_name_at_fire || record.rule_name || ''))}”</p>`
    + `<p class="chart-panel-note"><strong>Fired when:</strong> ${esc(String(d.metric || record.metric || ''))} ${esc(String(d.operator || record.operator || ''))} ${esc(String(d.threshold ?? record.threshold ?? ''))} (observed ${esc(String(d.observed_value ?? record.value ?? ''))} at ${esc(String(d.observed_at || ''))})</p>`
    + whereLine
    + countLines.map((l) => `<p class="chart-panel-note">${esc(l)}</p>`).join('')
    + approvalLine
}

/**
 * Render the explanation of an alert event.
 *
 * Protocol alerts get the condition set, the pre-authorisation and the
 * playbook outcome; rule alerts get the rule derivation, the input count and
 * the where. The protocol record and, for pre-field alerts, the playbook
 * outcome are fetched through `load` — the console's authenticated fetchJson
 * — and every fetch that did not happen is named rather than papered over.
 * Returns null: the alert has no score for a caller to reuse.
 */
async function renderAlertExplain(host, record, load, kind) {
  const isProtocol = kind === 'protocol'
  const approval = record.approval || {}
  const protocolId = approval.protocol_id || record.metadata?.protocol_id || record.scope?.protocol_id || null
  let protocolRecord = null
  let protocolFetchState = isProtocol && typeof load !== 'function' ? 'no-loader' : null
  if (isProtocol && protocolId && typeof load === 'function') {
    try {
      const body = await load(`/api/v1/trigger-protocols/${encodeURIComponent(String(protocolId))}`)
      if (body?.success === false) protocolFetchState = 'missing'
      else protocolRecord = body?.data || null
    } catch {
      protocolFetchState = 'unreachable'
    }
  }

  let playbookActions = Array.isArray(record.metadata?.playbook_results) ? record.metadata.playbook_results : null
  let outcomeSource = 'alert'
  if (playbookActions === null && record.metadata?.execution_id && typeof load === 'function') {
    // A pre-field alert: what authorisation did lives in the execution row the
    // alert already names. Fetched once, here, and labelled as the source.
    try {
      const body = await load('/api/v1/protocol-executions')
      const rows = body?.data?.data || body?.data || []
      const row = rows.find((r) => r?.id === record.metadata.execution_id)
      if (row && Array.isArray(row.actions)) {
        playbookActions = row.actions
        outcomeSource = 'execution'
      }
    } catch {
      // The honest empty below covers the miss.
    }
  }

  const parts = []
  const title = isProtocol
    ? 'How this alert was pre-authorised'
    : 'How this alert was produced'
  const caption = isProtocol
    ? 'A pre-authorised trigger protocol fired this alert: the protocol IS the authorisation. The conditions below are the set as it was evaluated at fire time.'
    : 'A registered scoring rule fired this alert. The rule the alert carries is the one that fired — versioned, so a later edit is a different version.'
  parts.push(`<p class="chart-panel-title">${esc(title)}</p>`)
  parts.push(`<p class="chart-panel-note">${esc(caption)}</p>`)
  if (isProtocol && (record.derivation?.condition_set?.terms || []).length) {
    parts.push(conditionSetBlock(record.derivation.condition_set))
  } else if (isProtocol) {
    parts.push('<p class="chart-panel-refused">This alert carries no condition set; what it fired on is recorded only in the metric line below.</p>')
  }
  if (isProtocol) {
    parts.push(preAuthorisationBlock(record, protocolRecord, protocolFetchState, protocolId))
    parts.push(playbookOutcomeBlock(record, playbookActions, outcomeSource))
  } else {
    parts.push(ruleDerivationBlock(record))
  }
  host.innerHTML = parts.join('\n')
  return null
}

/**
 * The score a record carries, formatted the way the console prints it elsewhere.
 *
 * Exported so the dialog header and the explanation agree on one rendering of
 * the same number rather than each rounding it its own way.
 */
export function scoreOf(record) {
  const score = num(record?.score ?? record?.value)
  return score === null ? '—' : String(Math.round(score * 100) / 100)
}