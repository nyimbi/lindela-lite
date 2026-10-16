import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { alertRailRow } from '../src/alerts.js'
import { reportRailRow } from '../src/reports.js'

/**
 * HX-06 — the rail fetches a row, not the document behind it.
 *
 * Measured on the 128.5 MB demo store through the live ingress: the console's
 * boot tick pulled **1,213,354 bytes** across eighteen requests, and two
 * endpoints were 771 KB of it. `/api/v1/alert-events` carried
 * `derivation.context_snapshot` — the store's counter snapshot at fire time,
 * **36.6 KB of a 38.3 KB row**, 343 KB of a 359 KB page for 19 alerts — and
 * `/api/v1/reports` carried `sections` and `source_refs`, 405 KB of a 411 KB
 * page for six reports.
 *
 * Neither is read by anything that draws a row. The alert rail reads a severity
 * chip, a rule name, a date, the metric, the status, the location and the
 * approval block; the report rail reads a title, a status pill, the narration
 * chip and a date, and opens no detail dialog. The alert dialog renders every
 * field with `String(v)`, which turns that snapshot into `[object Object]` —
 * the bytes were not merely unused, they were unreadable in the one place they
 * were carried to.
 *
 * What is asserted here is the **shape contract**, not a byte count: a size
 * assertion would pass on a fixture too small to show the cost, and would
 * change with the store. The heavy members must be absent, and every field the
 * rail reads must be present — a projection that dropped a drawn field would be
 * a blank card, which is a worse defect than the bytes.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const REPORTS_PANEL = fs.readFileSync(path.join(ROOT, 'public', 'panels', 'reports.js'), 'utf8')

/** A row shaped like the demo store's, with the heavy members present. */
function fatAlert() {
  return {
    id: 'alert_1', rule_id: 'rule_1', rule_name: 'Hazard pressure watch',
    status: 'open', severity: 'medium', metric: 'counts.hazard_events',
    value: 4, threshold: 3, operator: '>',
    location: { name: 'Bor', admin1: 'Jonglei', country: 'SS' },
    approval: { state: 'approved', reviewer: 'ops' },
    metadata: { execution_id: 'ex_1' },
    message: 'Hazard pressure in Bor', created_at: '2026-10-16T00:00:00.000Z',
    derivation: {
      rule_id: 'rule_1', rule_version: 4, rule_name_at_fire: 'Hazard pressure watch',
      metric: 'counts.hazard_events', operator: '>', threshold: 3, observed_value: 4,
      observed_at: '2026-10-16T00:00:00.000Z',
      input_record_ids: ['h1', 'h2', 'h3', 'h4'],
      input_record_ids_total: 4, input_record_ids_truncated: false,
      engine: { module: 'src/alerts.js', rule_schema: '1' },
      // The heavy member. Present in the store, read by nothing that draws.
      context_snapshot: { counts: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`c${i}`, i])) },
    },
  }
}

function fatReport() {
  return {
    id: 'report_1', template_id: 'tpl_1', report_type: 'situation_report',
    status: 'ready', title: 'Daily operations SITREP', scope: { district: 'bor' },
    section_ids: ['incident_summary', 'hazard_summary'],
    sections: Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`, title: `Section ${i}`, type: 'prose',
      content: 'x'.repeat(2000), source_refs: [{ collection: 'hazard_events', id: 'h1' }],
    })),
    source_refs: Array.from({ length: 26 }, (_, i) => ({ collection: 'hazard_events', id: `h${i}` })),
    warnings: [], narrative: { status: 'narrated', model: 'claude-sonnet-5-5' },
    distribution_defaults: [], generated_at: '2026-10-16T00:00:00.000Z',
    owner: 'ops', created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z', metadata: {},
  }
}

describe('HX-06 — an alert event reaches the rail as a row, not as the store document', () => {
  it('drops the context snapshot and keeps every field the rail draws', () => {
    const row = alertRailRow(fatAlert())
    assert.equal(row.derivation.context_snapshot, undefined,
      'the counter snapshot is still on the list — it is 36.6 KB of a 38.3 KB row and the dialog renders it as [object Object]')
    // The fields the rail's own render path reads. Named individually so a
    // projection that dropped one fails here rather than painting a blank card.
    for (const key of ['id', 'status', 'severity', 'rule_name', 'metric', 'value',
      'threshold', 'operator', 'location', 'approval', 'metadata', 'created_at']) {
      assert.ok(key in row, `the rail draws ${key} and the projection dropped it`)
    }
    // `ruleDerivationBlock` branches on this array existing: with it, "the
    // reading was computed from N record(s)"; without it, "an aggregate over
    // the store". Dropping it would turn the first claim into the second.
    assert.ok(Array.isArray(row.derivation.input_record_ids),
      'input_record_ids was dropped, so the explanation block will now claim the metric was an aggregate')
    assert.equal(row.derivation.rule_version, 4)
  })

  it('the derivation is an allowlist: a member the evaluator grows later does not ride along', () => {
    // The derivation is where unbounded members live, so it is an allowlist and
    // a new one is absent until someone names it. The top level is deliberately
    // a passthrough — see the note in `src/alerts.js` — so this asserts the
    // derivation only, and says which of the two it is testing.
    const alert = fatAlert()
    alert.derivation.a_field_added_later = 'x'.repeat(100)
    const row = alertRailRow(alert)
    assert.equal(row.derivation.a_field_added_later, undefined,
      'the derivation list is a blocklist in disguise — a new member ships to every operator by default')
    assert.equal(row.derivation.context_snapshot, undefined)
  })

  it('passes a record with no derivation through without inventing one', () => {
    const bare = { id: 'a', status: 'open', severity: 'low' }
    const row = alertRailRow(bare)
    assert.equal(row.derivation, null)
    assert.equal(row.id, 'a')
  })

  it('the rail reads no field the projection drops', () => {
    // The projection is justified by "nothing reads it". That claim is about the
    // console's source, so it is checked against the console's source: if a
    // later change makes the rail read `context_snapshot`, this fails rather
    // than the rail silently rendering an empty cell.
    assert.doesNotMatch(APP, /\.context_snapshot/,
      'public/app.js now reads context_snapshot, which the list route no longer sends')
    assert.doesNotMatch(REPORTS_PANEL, /\.sections\b/,
      'the reports panel now reads sections, which the list route no longer sends')
    assert.doesNotMatch(REPORTS_PANEL, /\.source_refs\b/,
      'the reports panel now reads source_refs, which the list route no longer sends')
  })
})

describe('HX-06 — a report reaches the rail as a row, not as the generated document', () => {
  it('drops the section prose and the refs, and keeps the card fields', () => {
    const row = reportRailRow(fatReport())
    assert.equal(row.sections, undefined,
      'the section prose is still on the list — 289 KB of a 411 KB page and the card draws none of it')
    assert.equal(row.source_refs, undefined,
      'the source refs are still on the list — 116 KB of the same page')
    for (const key of ['id', 'title', 'template_id', 'status', 'narrative',
      'generated_at', 'warnings', 'section_ids', 'scope']) {
      assert.ok(key in row, `the reports rail draws ${key} and the projection dropped it`)
    }
    assert.equal(row.title, 'Daily operations SITREP')
    assert.equal(row.narrative.status, 'narrated',
      'the narration chip reads narrative.status, and without it a narrated report renders as untouched')
  })

  it('does not invent a field nothing reads', () => {
    // A `source_ref_count` was written here and removed: the card has no room
    // for it and no surface reads it, which is the "written and never read"
    // defect this repository records. Asserted so it cannot come back.
    const row = reportRailRow(fatReport())
    assert.equal('source_ref_count' in row, false)
    // Every key present is one the allowlist names, and the fixture carries
    // every allowlisted field, so this is the allowlist's own set — asserted
    // rather than a length, so a rename cannot satisfy it and a re-added
    // invention fails by name.
    assert.deepEqual(Object.keys(row).sort(), [
      'created_at', 'distribution_defaults', 'generated_at', 'id', 'metadata',
      'narrative', 'owner', 'report_type', 'scope', 'section_ids', 'status',
      'template_id', 'title', 'updated_at', 'warnings',
    ].sort())
  })

  it('passes a record through unchanged when it is not an object', () => {
    assert.equal(reportRailRow(null), null)
    assert.equal(reportRailRow(undefined), undefined)
  })
})
