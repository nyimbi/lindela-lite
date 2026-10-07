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