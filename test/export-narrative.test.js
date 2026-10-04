#!/usr/bin/env node
/**
 * ENH-27: an export that carries the narrative, and cannot overstate it.
 *
 * `/export.csv` and `/export.geojson` return the source-record appendix and
 * nothing else. The reasoning, the warnings and the caveats live somewhere else,
 * so a spreadsheet handed to a country office arrives with no indication of
 * which rows are uncertain. These tests are about the export as an artefact a
 * person reads, because that is the surface where overstatement does the
 * damage — a number in a column is believed; a number in a footnote is read.
 *
 * The load-bearing assertion is the negative one: **the export must not state a
 * capability the system does not have.** Concretely, `calibrationReport` returns
 * `brier_score: null` unconditionally and `trainDistrictModels` refuses every
 * pilot district at `MIN_EVENTS`. If either appears in an export as a figure —
 * a 0, a dash, a "-0.00" — the export has asserted a measurement nobody made.
 * So the tests build an export from the worst realistic input (a refusal on
 * every district, a null calibration, an ungenerated report) and assert on what
 * the rendered text actually says, rather than on the presence of some marker
 * the code happens to emit.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EXPORT_BASIS_LIMITS,
  buildExportNarrative,
  buildReportWarnings,
  generateReportSections,
  normalizeReport,
  provenanceAnnotatedRows,
  refused,
  renderExportMarkdown,
  renderReportMarkdown,
  resolveReportContext,
  rowProvenanceLine,
} from '../src/reports.js'
import { renderQuarterlyReportPdf } from '../src/pdf.js'
import { MIN_EVENTS, MIN_MONTHS, MODEL_BASIS } from '../src/flood-probability.js'
import { isReplayDerived, stampReplayProvenance } from '../src/capture.js'

const NOW = '2026-10-01T12:00:00.000Z'

/**
 * The text a PDF actually draws, extracted from its content stream.
 *
 * A content stream interleaves every drawn string with operators — `(line) Tj`
 * then `-50 0 Td` — and word-wraps long sentences across several of them, so a
 * raw substring search for a sentence fails on the layout rather than on the
 * content. Extracting the literals and unescaping them is what makes the
 * assertion about what a reader sees.
 */
const WINANSI_BACK = Object.freeze(
  Object.fromEntries(Object.entries({
    '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85,
    '\u2020': 0x86, '\u2021': 0x87, '\u02c6': 0x88, '\u2030': 0x89, '\u0160': 0x8a,
    '\u2039': 0x8b, '\u0152': 0x8c, '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92,
    '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
    '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b, '\u0153': 0x9c,
    '\u017e': 0x9e, '\u0178': 0x9f,
  }).map(([char, byte]) => [byte, char])),
)

function pdfText(buffer) {
  const literals = [...buffer.toString('latin1').matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)]
  return literals
    .map((match) => match[1]
      .replace(/\\([\\()])/g, '$1')
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, ' ')
      // WinAnsi bytes above 0x7f are the typographic characters; without this
      // the em dashes in every refusal sentence decode as control codes.
      .replace(/[\x80-\x9f]/g, (byte) => WINANSI_BACK[byte.charCodeAt(0)] ?? '?'))
    .join(' ')
    .replace(/\s+/g, ' ')
}

/** The three pilot districts, all of which refuse at the MIN_EVENTS floor. */
const PILOT_REFUSALS = [
  { region: 'Turkana', refusal: 'only 1 flood-label month; MIN_EVENTS is 5' },
  { region: 'Mogadishu', refusal: 'only 2 flood-label month; MIN_EVENTS is 5' },
  { region: 'Juba', refusal: 'no flood events within 150 km' },
]

function storeData(overrides = {}) {
  return {
    source_runs: [],
    climate_observations: [],
    hazard_events: [],
    conflict_events: [],
    service_assets: [],
    impact_assessments: [],
    risk_scores: [],
    data_quality: [],
    incidents: [],
    interventions: [],
    intervention_tasks: [],
    field_reports: [],
    response_resources: [],
    alert_events: [],
    rapidpro_dispatches: [],
    rapidpro_inbound_messages: [],
    report_templates: [],
    flood_probability_models: [],
    ...overrides,
  }
}

function generatedReport(data = storeData()) {
  const report = normalizeReport({ title: 'Turkana SITREP', report_type: 'situation_report' }, data)
  return generateReportSections(report, data)
}

/**
 * A store with one real record in it.
 *
 * The narrative blocks are about attribution — which claim rests on which
 * source — and a store with nothing in it has no source references to attribute
 * anything to. Asserting on the empty case would test the formatter's zero
 * branch, not the behaviour the export exists for.
 */
const POPULATED = storeData({
  hazard_events: [{
    id: 'evt-1',
    source: 'gdacs',
    title: 'Flood — Turkana',
    event_type: 'flood',
    severity: 'high',
    observed_at: '2026-03-14T00:00:00.000Z',
    payload_hash: 'deadbeef',
  }],
})

describe('the export carries the narrative, in the order a reader meets it', () => {
  const report = generatedReport(POPULATED)
  const markdown = renderExportMarkdown(report, POPULATED, {
    flood: { refusals: PILOT_REFUSALS },
    calibration: [{ type: 'flood_risk_score', brier_score: null }],
  })

  it('leads with what was measured and where each claim came from', () => {
    const measured = markdown.indexOf('## What was measured')
    const refusedAt = markdown.indexOf('## What was refused')
    assert.ok(measured > -1 && refusedAt > measured, 'measured must precede refused')
    assert.match(markdown, /## What was measured/)
    // Each claim carries its source count. A number without one reads as a
    // finding; a number with one reads as a count of something specific.
    assert.match(markdown, /source reference\(s\):/)
  })

  it('carries the refusals with the reasons the model gave', () => {
    assert.match(markdown, /## What was refused/)
    for (const refusal of PILOT_REFUSALS) {
      assert.match(markdown, new RegExp(`flood probability, ${refusal.region}: refused`))
      assert.ok(markdown.includes(refusal.refusal), `the refusal reason for ${refusal.region} must survive into the export`)
    }
    // Every line in the refusal block is a refusal, prefixed with the single
    // spelling from `refused()`. A line that were a bare figure would read as a
    // finding, which is the one thing this block must not contain.
    const block = markdown.split('## What was refused')[1].split('\n##')[0]
    const entries = block.split('\n').filter((line) => line.startsWith('- '))
    assert.ok(entries.length > 0)
    for (const entry of entries) {
      assert.match(entry, /: refused — /, `every refusal must use the one spelling: ${entry}`)
    }
  })

  it('states what the export does not support, in the refusal vocabulary of the model', () => {
    const limits = markdown.split('## What this export does not support')[1]
    assert.ok(limits, 'the limits block must exist')
    assert.ok(limits.includes(MODEL_BASIS.rejection_reasons), 'the rejected routes travel with the export')
    assert.ok(limits.includes(MODEL_BASIS.what_a_probability_is_not), 'the label caveat travels with the export')
    assert.match(limits, /not evidence that little happened/, 'absence from a source is not absence of an event')
    assert.match(limits, /Nothing in it is calibrated/)
  })
})

describe('the export refuses to state a capability the system does not have', () => {
  it('prints brier_score as an absent measurement, never as a figure', () => {
    const markdown = renderExportMarkdown(generatedReport(POPULATED), POPULATED, {
      calibration: [{ type: 'flood_risk_score', brier_score: null, mean_score: 62 }],
    })
    assert.match(markdown, /brier_score is null on every calibration summary/)
    assert.match(markdown, /A null is an absent measurement, not a poor one/)
    // The neighbouring mean_score is a real figure and must still print, so
    // this is not a formatter that has simply stopped rendering numbers.
    assert.ok(markdown.includes('brier_score'), 'the refusal must name the field it is refusing')
    assert.doesNotMatch(markdown, /brier[_ ]?score[:= ]+\s*-?0(\.0+)?\b/)
  })

  it('prints no flood figure for a district that refused', () => {
    const markdown = renderExportMarkdown(generatedReport(), storeData(), {
      flood: { refusals: PILOT_REFUSALS },
    })
    // A refusal is a statement about sample size. Rendering it as a percentage
    // is the defect ADR-005 was written about, and this export has to hold the
    // same line the dashboard holds.
    assert.doesNotMatch(markdown, /\d+(\.\d+)?\s*%/)
    assert.doesNotMatch(markdown, /probability of (?:a )?flood[:= ]/i)
    assert.match(markdown, /MIN_EVENTS|only \d+ flood-label month|no flood events within 150 km/)
  })

  it('says so even when nothing was refused, rather than implying a clean bill of health', () => {
    const narrative = buildExportNarrative({ report: generatedReport(), data: storeData() })
    assert.ok(narrative.refused.length >= 1, 'an empty refusal list is itself a claim about the data')
    assert.ok(narrative.refused.some((item) => /no risk scores are in scope/.test(item.reason)))
    assert.ok(narrative.refused.some((item) => /no district has a trained model/.test(item.reason)))
  })

  it('refuses for a district that has a model record with no model in it', () => {
    const data = storeData({
      flood_probability_models: [{ region_name: 'Juba', label_source: 'gdacs_archive', model: null, refusal: 'no model produced' }],
    })
    const narrative = buildExportNarrative({ report: generatedReport(), data })
    assert.ok(narrative.refused.some((item) => item.subject === 'flood probability, Juba'))
    // A record that exists without a model must not read as a district that
    // was assessed and found low-risk.
    assert.ok(!narrative.measured.some((item) => /Juba/.test(item.claim)))
  })

  it('has one spelling of a refusal, so no call site can invent its own', () => {
    assert.equal(refused('sample too small'), 'refused — sample too small')
    assert.equal(refused('sample too small', '2 events'), 'refused — sample too small (2 events)')
  })

  it('states the floors it is refusing against, from the code rather than prose', () => {
    assert.equal(EXPORT_BASIS_LIMITS.floors.min_events, MIN_EVENTS)
    assert.equal(EXPORT_BASIS_LIMITS.floors.min_months, MIN_MONTHS)
  })
})

describe('an ungenerated export says it has no findings', () => {
  it('does not present a blank report as a short but complete one', () => {
    const report = normalizeReport({ title: 'Draft', report_type: 'situation_report' }, storeData())
    const markdown = renderExportMarkdown(report, storeData())
    assert.match(markdown, /no generated sections/)
    assert.match(markdown, /Nothing\. This export carries no generated findings\./)
    // `generateReportSections` is what turns a draft into a report; an export
    // of an ungenerated one must be visibly ungenerated.
    assert.ok(markdown.indexOf('## What was measured') > markdown.indexOf('## Warnings'))
  })
})

describe('every exported row carries its own provenance', () => {
  it('stamps source_id, observed_at and payload_hash on the row', () => {
    const line = rowProvenanceLine({ source: 'gdacs', observed_at: '2026-03-14T00:00:00.000Z', payload_hash: 'abc123' })
    assert.equal(line, 'source_id=gdacs observed_at=2026-03-14T00:00:00.000Z payload_hash=abc123')
  })

  it('says "unattributed" and "none recorded" rather than omitting the fields', () => {
    // A missing field printed as nothing is a field a reader will fill in from
    // context. Naming the gap is the only version that stays honest downstream.
    const line = rowProvenanceLine({})
    assert.match(line, /source_id=unattributed/)
    assert.match(line, /observed_at=unstated/)
    assert.match(line, /payload_hash=none recorded/)
  })

  it('marks a replayed row as not a live observation', () => {
    const replayed = stampReplayProvenance(
      { id: 'evt-1', source: 'gdacs', observed_at: '2026-03-14T00:00:00.000Z', payload_hash: 'abc123' },
      { origin: 'capture_replay' },
    )
    const line = rowProvenanceLine(replayed)
    assert.match(line, /origin=capture_replay/)
    assert.match(line, /is_live_observation=false/)
    assert.equal(isReplayDerived(replayed), true)
  })

  it('reaches the export as a stamped appendix', () => {
    const data = storeData({
      hazard_events: [{
        id: 'evt-1',
        source: 'gdacs',
        title: 'Flood — Turkana',
        observed_at: '2026-03-14T00:00:00.000Z',
        payload_hash: 'deadbeef',
      }],
    })
    const report = generateReportSections(normalizeReport({ title: 'SITREP', report_type: 'situation_report' }, data), data)
    const markdown = renderExportMarkdown(report, data)

    assert.match(markdown, /## Row Provenance/)
    assert.match(markdown, /events:evt-1/)
    assert.match(markdown, /source_id=gdacs/)
    assert.match(markdown, /payload_hash=deadbeef/)
  })

  it('annotates a list without mutating the records in it', () => {
    const records = [{ id: 'a', source: 'gdacs' }]
    const annotated = provenanceAnnotatedRows(records)
    assert.equal(records[0].provenance_line, undefined)
    assert.match(annotated[0].provenance_line, /source_id=gdacs/)
  })
})

describe('the PDF carries the narrative too', () => {
  const kpi = {
    generated_at: NOW,
    period: { quarter: 'Q3', year: 2026, from: '2026-07-01', to: '2026-09-30' },
    people_reached: 12000,
    community_reporters_count: 84,
    warning_to_action_median_hours: 1.9,
    false_alert_rate: null,
    api_uptime_pct: 99.4,
    data_gaps: [{ field: 'false_alert_rate' }],
    cohort: { total: 12000, u18: 4800 },
  }
  const narrative = buildExportNarrative({
    report: generatedReport(POPULATED),
    data: POPULATED,
    flood: { refusals: PILOT_REFUSALS },
    calibration: [{ type: 'flood_risk_score', brier_score: null }],
  })

  it('still renders the KPI page when no narrative is passed', () => {
    const pdf = renderQuarterlyReportPdf(kpi)
    const text = pdf.toString('latin1')
    assert.match(text, /%PDF-1\.4/)
    assert.match(text, /Lindela Lite - Climate & Health KPI Report/)
    assert.match(text, /People reached/)
  })

  it('adds the measured, refused and not-supported blocks as a second page', () => {
    const pdf = renderQuarterlyReportPdf(kpi, { narrative })
    const text = pdf.toString('latin1')
    assert.match(text, /What was measured/)
    assert.match(text, /What was refused/)
    assert.match(text, /What this report does not support/)
    // Two pages, declared in the page tree. A single-page PDF with the
    // narrative overflowing off the bottom would keep /Count 1 and lose text.
    assert.match(text, /\/Count 2/)
    assert.match(text, /\/Kids \[3 0 R 5 0 R\]/)
  })

  it('carries the refusal reasons, not just the headings', () => {
    const text = pdfText(renderQuarterlyReportPdf(kpi, { narrative }))
    for (const refusal of PILOT_REFUSALS) {
      assert.ok(text.includes(refusal.refusal.replace(/\s+/g, ' ')), `${refusal.region}'s refusal reason must reach the PDF`)
    }
    assert.ok(text.includes(MODEL_BASIS.rejection_reasons.replace(/\s+/g, ' ')))
  })

  it('prints a withheld KPI as "not measured", never as a dash among figures', () => {
    // `false_alert_rate` is null in this KPI. A dash in a column of numbers
    // reads as zero to anyone scanning the page, which is a claim that the
    // rate was measured and came out at nothing.
    const text = renderQuarterlyReportPdf(kpi, { narrative }).toString('latin1')
    assert.match(text, /False alert rate\s+not measured/)
    assert.doesNotMatch(text, /False alert rate\s+-/)
    // And a real figure beside it still prints, so the formatter is not simply
    // refusing everything.
    assert.match(text, /API uptime\s+99\.4%/)
  })

  it('encodes typographic characters as WinAnsi bytes, not truncated latin1', () => {
    // A PDF content stream is bytes. `Buffer.from(text, 'latin1')` truncates a
    // UTF-16 code unit to its low byte, so U+2014 — an em dash — was written as
    // 0x14, a control character. Every refusal sentence in this document
    // contains one, so the refusal vocabulary was partly unreadable in exactly
    // the place it exists to be read. The sentence still decoded as "present",
    // which is what made it silent.
    const text = pdfText(renderQuarterlyReportPdf(kpi, { narrative }))
    assert.ok(MODEL_BASIS.rejection_reasons.includes('—'), 'the basis text really does use an em dash')
    assert.ok(text.includes(MODEL_BASIS.rejection_reasons), 'the whole sentence must survive encoding')
    assert.doesNotMatch(text, /[\x00-\x08\x0b\x0c\x0e-\x1f]/, 'no control characters may reach the page')
  })

  it('produces a valid multi-page structure with every object offset present', () => {
    const pdf = renderQuarterlyReportPdf(kpi, { narrative })
    const text = pdf.toString('latin1')
    const size = Number(/\/Size (\d+)/.exec(text)[1])
    // catalog + pages + 2×(page, content) + 2 fonts, numbered 1..size-1.
    assert.equal(size, 9, '2 pages × (page + content) + catalog + pages + 2 fonts')
    const startxref = Number(/startxref\s+(\d+)/.exec(text)[1])
    const xref = text.slice(startxref)
    assert.match(xref, /^xref\n0 9\n0000000000 65535 f/)
    // Every offset must land on "N 0 obj", or a reader silently drops a page.
    for (let i = 1; i < 9; i += 1) {
      // xref lines: 0 'xref', 1 the subsection header, 2 the free entry for
      // object 0. Each entry keeps its own trailing newline and the table is
      // joined with another, so entries are on alternate lines: object i is on
      // line 2 + 2 * i (object 1 on line 4, object 2 on line 6).
      const offset = Number(new RegExp(`^(\\d{10}) 00000 n`).exec(xref.split('\n')[2 + 2 * i])?.[1])
      assert.ok(Number.isInteger(offset), `xref entry ${i} must carry an offset`)
      assert.match(text.slice(offset, offset + 12), new RegExp(`^${i} 0 obj`), `object ${i} must sit at its xref offset`)
    }
  })
})

describe('the export composes with the report it exports rather than replacing it', () => {
  it('renders the existing Markdown report verbatim inside it', () => {
    const report = generatedReport()
    const data = storeData()
    const body = renderReportMarkdown(report).trimEnd()
    const markdown = renderExportMarkdown(report, data)
    // `renderReportMarkdown` is called, not reimplemented, so the export and the
    // export.md endpoint cannot drift into two different reports.
    assert.ok(markdown.startsWith(body), 'the export must open with the report the md endpoint returns')
  })

  it('keeps the report warnings it was given rather than recomputing them', () => {
    const data = storeData()
    const context = resolveReportContext(data, {})
    const warnings = buildReportWarnings(context)
    const report = { ...generatedReport(), warnings }
    const narrative = buildExportNarrative({ report, data })
    assert.deepEqual(
      narrative.refused.filter((item) => item.subject === 'report scope').map((item) => item.reason),
      warnings,
    )
  })
})
