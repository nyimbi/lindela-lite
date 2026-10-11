#!/usr/bin/env node
/**
 * ENH-57 — scheduled multi-audience briefing.
 *
 * `narrator.js` already refuses a paragraph that introduces a figure the report
 * does not state. This file covers the thing that is *new* here and the thing
 * that is dangerous: one fact set, several audiences, and the requirement that
 * an audience not entitled to a figure receives neither the figure nor a
 * paragraph that implies it.
 *
 * Three of these tests are the ones worth reading:
 *
 *   1. **The section names are real.** The registry is written by hand and the
 *      section vocabulary lives in `reports.js`. A typo there (`hazards` for
 *      `risk_summary`) keeps zero sections and makes every briefing refuse
 *      `no_permitted_facts` — a refusal an operator reads as "no data" rather
 *      than "the registry is misspelled". Asserted against the imported
 *      `SECTION_LIBRARY`, so it tracks the generator rather than a copy.
 *   2. **The withheld figure is not in the fact set.** The audit is the
 *      mechanism, so the test is about what reaches the audit: a figure living
 *      only in a section the audience may not see must be absent from
 *      `allowedNumbers`. A narrowing that is declared but not applied passes
 *      every other test in this file.
 *   3. **The per-audience length is applied.** `narrateReport` ignored
 *      `maxWords` until this item; a briefing that declares 90 words and sends
 *      the narrator's default is a length chosen for nobody.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BRIEFING_AUDIENCES,
  BRIEFING_AUDIENCE_IDS,
  assertAudienceSectionsAreReal,
  briefingSchedule,
  buildBriefingRequest,
  narrateBriefing,
  narrateBriefings,
  selectFacts,
} from '../src/briefing.js'
import { SECTION_LIBRARY } from '../src/reports.js'

const section = (id, title, summary) => ({ id, title, type: 'deterministic_summary', content: { summary } })

/**
 * A report whose every section carries a figure that appears nowhere else, so a
 * figure's presence in `allowedNumbers` names exactly which sections survived.
 */
const REPORT = {
  title: 'Situation report — Karonga',
  report_type: 'situation_report',
  scope: { district: 'Karonga', region: 'Northern', country: 'MW', partner_org: 'org-1' },
  sections: [
    section('executive_summary', 'Executive summary', 'The report covers 11 events.'),
    section('risk_summary', 'Risk summary', '2 high or critical risks, of which 77 concern the lake shore.'),
    section('events_summary', 'Events summary', '14 events were recorded.'),
    section('incident_summary', 'Incident summary', '3 incidents remain open.'),
    section('intervention_summary', 'Interventions', '5 interventions are active.'),
    section('service_impact_summary', 'Service impact', '9 facilities are unreachable.'),
    section('field_report_summary', 'Field reports', '6 field reports arrived, from 4 partners.'),
    section('alert_summary', 'Alerts', '1 alert is current.'),
    section('recommended_actions', 'Recommended actions', 'Pre-position stock before the 22nd.'),
    section('appendix_sources', 'Appendix: sources', 'The appendix lists 88 sources.'),
  ],
}

/** A transport that answers with fixed text, so the audit can be driven. */
const answering = (text) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ response: text }),
})

const enabled = { enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'test-model' }

describe('ENH-57 — the audience registry names sections the generator emits', () => {
  it('declares every section out of the report generator\'s own vocabulary', () => {
    // The failure this guards: `hazards`/`access`/`actions` read like plausible
    // section names and match nothing. Every briefing would then refuse
    // `no_permitted_facts`, which reads as a data problem.
    assert.equal(assertAudienceSectionsAreReal(), true)
    const known = new Set(SECTION_LIBRARY)
    for (const id of BRIEFING_AUDIENCE_IDS) {
      for (const s of BRIEFING_AUDIENCES[id].sections) assert.ok(known.has(s), `${id} names ${s}, which reports.js cannot emit`)
    }
  })

  it('refuses an unknown audience by name rather than briefing everyone', () => {
    const result = selectFacts(REPORT, 'district_officerr')
    assert.equal(result.refusal, 'unknown_audience')
    assert.equal(result.report, null)
    assert.match(result.reason, /district_officer, national_coordinator, partner/)
  })

  it('gives each audience a distinct length and a named decision', () => {
    // Two audiences with the same length is a length chosen for neither, and an
    // audience with no decision named cannot be checked for relevance.
    const lengths = new Set(BRIEFING_AUDIENCE_IDS.map((id) => BRIEFING_AUDIENCES[id].maxWords))
    assert.equal(lengths.size, BRIEFING_AUDIENCE_IDS.length)
    for (const id of BRIEFING_AUDIENCE_IDS) assert.ok(BRIEFING_AUDIENCES[id].deciding.length > 10)
  })
})

describe('ENH-57 — selection narrows sections and scope, and says what it withheld', () => {
  it('keeps the audience\'s sections and records the rest as withheld', () => {
    // Kept in the *report's* order, not the registry's: a briefing reads in the
    // report's narrative order, and re-ordering it to match a declaration would
    // make the paragraph's sequence a property of the registry.
    const { selection } = selectFacts(REPORT, 'district_officer')
    assert.deepEqual(selection.sections_kept, ['executive_summary', 'risk_summary', 'service_impact_summary', 'alert_summary', 'recommended_actions'])
    assert.ok(selection.sections_withheld.includes('appendix_sources'))
    assert.ok(selection.sections_withheld.includes('incident_summary'))
  })

  it('drops a scope key the audience is not entitled to, rather than passing it through', () => {
    // The partner boundary: a partner briefing assembled from an unscoped read
    // carries another organisation's figures into the paragraph.
    const officer = selectFacts(REPORT, 'district_officer').selection
    assert.deepEqual(officer.scope_kept, ['district', 'region'])
    assert.ok(officer.scope_withheld.includes('partner_org'))

    const partner = selectFacts(REPORT, 'partner').selection
    assert.deepEqual(partner.scope_kept, ['district', 'partner_org'])
    assert.ok(partner.scope_withheld.includes('region'))
  })

  it('narrows the report itself, not just the record of narrowing', () => {
    // A selection that is recorded but not applied is the whole defect: the
    // record would be right and the fact set would be the full report.
    const { report } = selectFacts(REPORT, 'partner')
    assert.equal(report.sections.length, 5)
    assert.ok(!report.sections.some((s) => s.id === 'risk_summary'))
    assert.deepEqual(Object.keys(report.scope).sort(), ['district', 'partner_org'])
  })
})

describe('ENH-57 — an unentitled figure is not in the fact set', () => {
  it('withholds a figure that lives only in a section the audience may not see', () => {
    // 77 lives only in `risk_summary`; 6 and 4 only in `field_report_summary`.
    const officer = buildBriefingRequest(REPORT, 'district_officer').request
    const partner = buildBriefingRequest(REPORT, 'partner').request
    const coordinator = buildBriefingRequest(REPORT, 'national_coordinator').request

    assert.ok(officer.allowedNumbers.has('77'), 'the officer sees the risk summary')
    assert.ok(!partner.allowedNumbers.has('77'), 'the partner does not')
    assert.ok(partner.allowedNumbers.has('6'), 'the partner sees their own field reports')
    assert.ok(!officer.allowedNumbers.has('6'), 'the officer does not')
    // 88 is the appendix, which no audience is entitled to.
    for (const request of [officer, partner, coordinator]) {
      assert.ok(!request.allowedNumbers.has('88'), 'the appendix figure reaches nobody')
    }
  })

  it('refuses to write a briefing about nothing rather than an empty paragraph', () => {
    // An empty briefing reads as "nothing to report" — a claim about the
    // situation, when the truth is a claim about entitlement.
    const thin = { ...REPORT, sections: [section('appendix_sources', 'Appendix: sources', '88 sources.')] }
    const built = buildBriefingRequest(thin, 'district_officer')
    assert.equal(built.refusal, 'no_permitted_facts')
    assert.equal(built.request, null)
    assert.match(built.reason, /rather than a paragraph about nothing/)
  })

  it('refuses a report that carries no sections at all', () => {
    const built = buildBriefingRequest({ ...REPORT, sections: [] }, 'partner')
    assert.equal(built.refusal, 'no_permitted_facts')
  })
})

describe('ENH-57 — the audit is the narrator\'s, and it covers the narrowed set', () => {
  it('refuses a paragraph that restates a withheld figure', async () => {
    // The partner may not see 77. A model that writes it anyway is caught by the
    // same refusal path the report narrator uses — not a second audit.
    const result = await narrateBriefing(REPORT, 'partner', {
      env: {}, narrator: enabled, http: answering('Six field reports arrived and 77 risks are critical.'),
    })
    assert.equal(result.status, 'refused')
    assert.match(result.reason, /introduced a figure the facts do not state: 77/)
    assert.equal(result.text, null)
  })

  it('publishes a paragraph whose figures all come from the audience\'s own sections', async () => {
    // Digit figures, because the audit counts digit tokens: "six" is prose and
    // `numbers_checked` is the count of figures actually audited, so a text with
    // no digits must report 0 rather than a count of words that look like numbers.
    const result = await narrateBriefing(REPORT, 'partner', {
      env: {}, narrator: enabled, http: answering('6 field reports arrived from 4 partners.'),
    })
    assert.equal(result.status, 'narrated')
    assert.equal(result.audience, 'partner')
    assert.equal(result.numbers_checked, 2)
    assert.deepEqual(result.selection.sections_kept, ['executive_summary', 'intervention_summary', 'service_impact_summary', 'field_report_summary', 'recommended_actions'])
  })

  it('counts only digit figures, so word-form numbers are not claimed as audited', async () => {
    const result = await narrateBriefing(REPORT, 'partner', {
      env: {}, narrator: enabled, http: answering('Six field reports arrived from four partners.'),
    })
    assert.equal(result.status, 'narrated')
    assert.equal(result.numbers_checked, 0, 'no digit was audited, so the count is zero')
  })

  it('sends the audience\'s own word limit to the narrator', async () => {
    // `narrateReport` ignored `maxWords` until ENH-57: the option was read by
    // `buildNarrativeRequest` and never passed. A briefing that declares 90
    // words and sends 120 is a length chosen for neither audience.
    let sent = null
    const capture = async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ response: 'Eleven events were recorded.' }) }
    }
    await narrateBriefing(REPORT, 'district_officer', { env: {}, narrator: enabled, http: capture })
    assert.match(sent.system, /90 words is your maximum/)
    assert.doesNotMatch(sent.system, /120 words/)

    await narrateBriefing(REPORT, 'national_coordinator', { env: {}, narrator: enabled, http: capture })
    assert.match(sent.system, /140 words is your maximum/)
  })

  it('refuses every audience when the narrator is not configured, without inventing text', async () => {
    const result = await narrateBriefings(REPORT, { env: {}, narrator: { enabled: false } })
    assert.equal(result.narrated, 0)
    assert.equal(result.refused, BRIEFING_AUDIENCE_IDS.length)
    for (const b of result.briefings) assert.equal(b.text, null)
  })

  it('writes one briefing per audience and counts them', async () => {
    const result = await narrateBriefings(REPORT, {
      env: {}, narrator: enabled, http: answering('Eleven events were recorded.'),
    })
    assert.equal(result.briefings.length, 3)
    assert.equal(result.narrated, 3)
    assert.equal(result.refused, 0)
    assert.deepEqual(result.briefings.map((b) => b.audience), [...BRIEFING_AUDIENCE_IDS])
  })
})

describe('ENH-57 — the schedule is a function of an injected clock', () => {
  it('makes a daily briefing due on the first tick of a UTC day', () => {
    const due = briefingSchedule({ at: new Date('2026-10-12T06:00:00Z') })
    const ids = due.map((d) => d.audience)
    assert.ok(ids.includes('district_officer'))
    assert.ok(ids.includes('national_coordinator'))
    assert.equal(due.find((d) => d.audience === 'district_officer').period_key, '2026-10-12')
  })

  it('does not make a weekly briefing due on a day that is not its period', () => {
    // 2026-10-12 is a Monday, so the weekly key is that day. 2026-10-13 is not:
    // its key is still the 12th, and a scheduler that already sent the 12th
    // must not send again on the 13th.
    const sent = briefingSchedule({ at: new Date('2026-10-12T06:00:00Z'), previous: new Date('2026-10-11T06:00:00Z') })
    assert.ok(sent.some((d) => d.audience === 'partner'), 'the partner is due on the Monday')
    const nextDay = briefingSchedule({ at: new Date('2026-10-13T06:00:00Z'), previous: new Date('2026-10-12T06:00:00Z') })
    assert.ok(!nextDay.some((d) => d.audience === 'partner'), 'and not again the next day')
    assert.ok(nextDay.some((d) => d.audience === 'district_officer'), 'while the daily one is due')
  })

  it('is a no-op when the same period already ran', () => {
    // Idempotence is the property that stops a scheduler re-firing after a
    // restart from sending a second email.
    const previous = new Date('2026-10-12T05:00:00Z')
    const due = briefingSchedule({ at: new Date('2026-10-12T06:00:00Z'), previous })
    assert.deepEqual(due, [])
  })

  it('is due again the next day, and only once across a missed gap', () => {
    const next = briefingSchedule({ at: new Date('2026-10-13T06:00:00Z'), previous: new Date('2026-10-12T06:00:00Z') })
    assert.ok(next.some((d) => d.audience === 'district_officer'))
    // Three days later, from a tick three days back: still one briefing, not
    // three — `previous` is what makes the function idempotent across a gap.
    const afterGap = briefingSchedule({ at: new Date('2026-10-15T06:00:00Z'), previous: new Date('2026-10-12T06:00:00Z') })
    assert.equal(afterGap.filter((d) => d.audience === 'district_officer').length, 1)
  })

  it('keys a weekly briefing to its Monday, so one week is one key', () => {
    // Monday 2026-10-12; Wednesday of the same week shares the key.
    const monday = briefingSchedule({ at: new Date('2026-10-12T06:00:00Z') }).find((d) => d.audience === 'partner')
    assert.equal(monday.period_key, '2026-10-12')
    const wednesday = briefingSchedule({ at: new Date('2026-10-14T06:00:00Z') }).find((d) => d.audience === 'partner')
    assert.equal(wednesday.period_key, '2026-10-12')
    const nextMonday = briefingSchedule({ at: new Date('2026-10-19T06:00:00Z') }).find((d) => d.audience === 'partner')
    assert.equal(nextMonday.period_key, '2026-10-19')
  })

  it('treats an unreadable instant as due for nobody rather than due for everyone', () => {
    // Fail closed: `new Date('nonsense')` is Invalid, and a schedule that
    // reported every audience due would fire the whole set on a bad clock.
    assert.deepEqual(briefingSchedule({ at: 'not a date' }), [])
  })
})
