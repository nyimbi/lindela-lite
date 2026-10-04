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
// **There is no `/api/v1/explain` route.** `src/` is not this change's to touch,
// and adding a server endpoint would have bought nothing: the record the
// operator clicked is already in the console's hands, and
// `public/shared/viz-explain.js` recomputes from that record alone. So this calls
// `explainRecord(record)` directly on the object the click carried. The optional
// `lookup` it accepts — used to list the source records behind a count — is left
// out on purpose: those records are not in the console's store by the same key,
// and a list of ids that resolve to nothing is worse than saying the term is a
// sum over records we are not holding.

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
 * Render the derivation of one record into `host`.
 *
 * Returns the explanation object so a caller that wants to keep it — for a test,
 * or for the console palette — does not have to recompute it.
 */
export function renderExplain(host, record) {
  if (!host || !record) return null
  let explanation
  try {
    explanation = explainRecord(record)
  } catch (err) {
    host.innerHTML = `<p class="chart-panel-refused">${esc(err.message)}</p>`
    return null
  }

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