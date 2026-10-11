/**
 * ENH-57 — scheduled multi-audience briefing.
 *
 * `narrator.js` writes one paragraph for one reader and audits it: every digit
 * figure in the text must be among the figures it was given, and a text that
 * introduces one is refused rather than published. That is the right rule and it
 * is per-report. This module extends it to *several audiences at once* — a
 * district officer, a national coordinator, a partner — from the same grounded
 * fact set, so the narrative cannot invent a figure for any of them.
 *
 * **The audience changes what is said, never what is true.** Each briefing is
 * built from the same report sections; what differs is which of them the audience
 * is entitled to see and which figures are relevant to their decision. A
 * briefing is therefore a *selection* over the fact set, and the selection is
 * declared rather than written in prose — because a rule expressed as a prompt
 * ("mention the district numbers") is a rule the model may follow or not, and
 * this module's whole point is that the model follows the code.
 *
 * **The one thing that must not happen.** An audience that is not entitled to a
 * figure must not receive it, and must not receive a briefing that *implies* it.
 * Two mechanisms, and they are deliberately separate:
 *
 *   1. The fact set handed to the model is already narrowed, so an unentitled
 *      figure is not in `allowedNumbers` and restating it is caught by the
 *      existing figure audit — the same refusal path, not a second one.
 *   2. A briefing for an audience with no facts to speak from is **refused**,
 *      not written as a short paragraph about nothing. An empty briefing reads
 *      as "nothing to report", which is a claim about the situation rather than
 *      about the audience's entitlement.
 *
 * **Scheduling is a function, not a timer.** `briefingSchedule` returns the
 * audiences due at a given instant; a caller decides what to do with them. A
 * module that starts its own interval is one a test cannot drive and a deployment
 * cannot reason about, and the repo already keeps its clocks injected (`now` is a
 * parameter everywhere).
 *
 * Nothing here reaches a network. It builds the requests; `narrateReport` in
 * `narrator.js` performs them and performs the audit.
 */

import { buildNarrativeRequest, narrateReport } from './narrator.js'
import { SECTION_LIBRARY } from './reports.js'

/**
 * The audiences, and what each is entitled to.
 *
 * `sections` names the report sections the audience sees, and the names are the
 * ones `reports.js` actually emits (`SECTION_LIBRARY`), not a private vocabulary
 * this module invents: an audience whose sections are spelled differently from
 * the report's is an audience that matches nothing, and the failure is silent —
 * `selectFacts` keeps zero sections and every briefing refuses
 * `no_permitted_facts`, which reads like a data problem and is a typo. The
 * `every declared section is one the report generator can emit` test is the
 * guard, and it is checked against `SECTION_LIBRARY` rather than a copy.
 *
 * `maxWords` is per
 * audience because a district officer's briefing is read on a phone in a field
 * office and a coordinator's is read at a desk — the same paragraph length for
 * both is a length chosen for neither.
 *
 * `cadence` is a cron-like declaration kept as data so `briefingSchedule` can be
 * driven by an injected clock. `scope_keys` names the report-scope keys the
 * audience is entitled to: a partner briefing that carried a district breakdown
 * it was not scoped to would leak a boundary the platform draws elsewhere (see
 * the `partner_org` model in `migrations.js`).
 */
export const BRIEFING_AUDIENCES = Object.freeze({
  district_officer: Object.freeze({
    title: 'District officer briefing',
    sections: ['executive_summary', 'risk_summary', 'alert_summary', 'service_impact_summary', 'recommended_actions'],
    maxWords: 90,
    cadence: 'daily',
    scope_keys: ['district', 'region'],
    // What the officer is deciding. Named so a reader can see the selection is
    // built for a decision rather than for a length.
    deciding: 'whether to act on a hazard in their own district this week',
  }),
  national_coordinator: Object.freeze({
    title: 'National coordinator briefing',
    sections: ['executive_summary', 'risk_summary', 'events_summary', 'incident_summary', 'intervention_summary', 'service_impact_summary', 'alert_summary', 'recommended_actions'],
    maxWords: 140,
    cadence: 'daily',
    scope_keys: ['region', 'country'],
    deciding: 'where to move stock and staff between districts',
  }),
  partner: Object.freeze({
    title: 'Partner briefing',
    sections: ['executive_summary', 'intervention_summary', 'service_impact_summary', 'field_report_summary', 'recommended_actions'],
    maxWords: 110,
    cadence: 'weekly',
    // A partner sees the districts they are funded for and no others. This is
    // the visibility boundary the store draws, restated where the briefing is
    // built — a briefing assembled from an unscoped read would carry another
    // organisation's figures into the paragraph.
    scope_keys: ['district', 'partner_org'],
    deciding: 'what their own funded activities should do differently',
  }),
})

export const BRIEFING_AUDIENCE_IDS = Object.freeze(Object.keys(BRIEFING_AUDIENCES))

/**
 * Every audience's declared sections, checked against the vocabulary the report
 * generator can actually emit.
 *
 * This is a runtime check rather than a comment because the defect it catches is
 * silent in both directions: a section name spelled `hazards` when `reports.js`
 * emits `risk_summary` keeps zero sections, and a briefing for that audience
 * refuses `no_permitted_facts` — which an operator reads as "there is no data"
 * rather than "the registry names a section that does not exist". The check is
 * against the imported `SECTION_LIBRARY`, so renaming a section in `reports.js`
 * fails here instead of quietly emptying three briefings.
 */
export function assertAudienceSectionsAreReal(library = SECTION_LIBRARY) {
  const known = new Set(library)
  for (const id of BRIEFING_AUDIENCE_IDS) {
    const { sections } = BRIEFING_AUDIENCES[id]
    if (!sections.length) throw new Error(`briefing audience ${id} declares no sections`)
    const unknown = sections.filter((s) => !known.has(s))
    if (unknown.length) {
      throw new Error(`briefing audience ${id} names sections the report generator cannot emit: ${unknown.join(', ')}`)
    }
  }
  return true
}

assertAudienceSectionsAreReal()

/**
 * The facts one audience is entitled to, out of the report's own sections.
 *
 * Returns the narrowed report and the selection's own record: which sections
 * were kept, which were withheld, and which figures survived. A briefing whose
 * narrowing is invisible is one nobody can check, and the withheld list is what
 * makes the entitlement auditable after the fact.
 */
export function selectFacts(report, audienceId) {
  const audience = BRIEFING_AUDIENCES[audienceId]
  if (!audience) {
    return {
      report: null, selection: null,
      refusal: 'unknown_audience',
      reason: `'${audienceId}' is not a briefing audience; the registry carries ${BRIEFING_AUDIENCE_IDS.join(', ')}`,
    }
  }
  const all = report?.sections || []
  const wanted = new Set(audience.sections)
  const kept = all.filter((s) => wanted.has(s.slug || s.id || slugify(s.title)))
  const withheld = all.filter((s) => !kept.includes(s))

  // The scope is narrowed to the keys the audience is entitled to, and a scope
  // key the audience may not see is *dropped* rather than passed through. A
  // briefing built from a wider scope than the audience holds is the leak this
  // function exists to prevent.
  const permitted = new Set(audience.scope_keys)
  const scope = {}
  const withheldScope = []
  for (const [key, value] of Object.entries(report?.scope || {})) {
    if (permitted.has(key)) scope[key] = value
    else withheldScope.push(key)
  }

  const narrowed = { ...report, scope, sections: kept }
  return {
    report: narrowed,
    selection: {
      audience: audienceId,
      sections_kept: kept.map((s) => s.slug || s.id || slugify(s.title)),
      sections_withheld: withheld.map((s) => s.slug || s.id || slugify(s.title)),
      scope_kept: Object.keys(scope),
      scope_withheld: withheldScope,
      deciding: audience.deciding,
    },
    refusal: null,
    reason: null,
  }
}

/**
 * The narrative request for one audience.
 *
 * Built by `narrator.js`'s own `buildNarrativeRequest`, deliberately: a second
 * prompt builder is a second place the "use only the figures listed" rule lives,
 * and the two would drift. The only thing this adds is the audience's own
 * framing, which is *not* part of the fact set — the audit reads
 * `allowedNumbers` off the narrowed report, so nothing in the framing can become
 * a figure the model is free to restate.
 */
export function buildBriefingRequest(report, audienceId) {
  const { report: narrowed, selection, refusal, reason } = selectFacts(report, audienceId)
  if (refusal) return { request: null, selection: null, refusal, reason }
  if (!narrowed.sections.length) {
    // A briefing with no facts is refused rather than written short. An empty
    // paragraph reads as "nothing to report" — a claim about the situation,
    // when the truth is a claim about the audience's entitlement.
    return {
      request: null, selection,
      refusal: 'no_permitted_facts',
      reason: `the ${audienceId} briefing has no sections it is entitled to see (${BRIEFING_AUDIENCES[audienceId].sections.join(', ')}); nothing is written rather than a paragraph about nothing`,
    }
  }
  const request = buildNarrativeRequest(narrowed, { maxWords: BRIEFING_AUDIENCES[audienceId].maxWords })
  return { request, selection, refusal: null, reason: null }
}

/**
 * Write one audience's briefing.
 *
 * The audit is `narrateReport`'s, unchanged — this does not re-check the figures
 * itself. Two audit implementations would be two answers to "did the model invent
 * a number", and the second would be the one that drifted.
 */
export async function narrateBriefing(report, audienceId, options = {}) {
  const { request, selection, refusal, reason } = buildBriefingRequest(report, audienceId)
  if (refusal) {
    return { status: 'refused', audience: audienceId, reason, selection, text: null, generated_at: options.now || null }
  }
  // `narrateReport` re-derives the request from the report; handing it the
  // narrowed report is what makes the figure audit cover the narrowed set.
  const narrowed = { ...report, scope: scopeOf(selection, report), sections: sectionsFor(selection, report) }
  const result = await narrateReport(narrowed, { ...options, maxWords: BRIEFING_AUDIENCES[audienceId].maxWords })
  return { ...result, audience: audienceId, selection }
}

/**
 * Every audience's briefing for one report, in registry order.
 *
 * Sequential rather than concurrent: the narrator talks to one local model
 * server, and firing three requests at a 0.6B model at once makes each slower
 * without making the set sooner. A caller that wants concurrency can map over
 * `BRIEFING_AUDIENCE_IDS` itself.
 */
export async function narrateBriefings(report, options = {}) {
  const audiences = options.audiences || BRIEFING_AUDIENCE_IDS
  const out = []
  for (const audience of audiences) {
    out.push(await narrateBriefing(report, audience, options))
  }
  return {
    briefings: out,
    narrated: out.filter((b) => b.status === 'narrated').length,
    refused: out.filter((b) => b.status === 'refused').length,
  }
}

/**
 * Which audiences are due at `at`, from their declared cadence.
 *
 * `daily` is due on the first tick of a UTC day, `weekly` on Monday's. Both take
 * the previous tick as well, so a scheduler that missed a run still produces one
 * briefing rather than two or none — `previous` is what makes the function
 * idempotent across a gap. A caller with no previous tick passes `null` and gets
 * only the audiences due at `at` itself.
 *
 * Returns `{ audience, period_key }` entries. The `period_key` is what a caller
 * stores to know it already sent this one: the key for a daily briefing is the
 * UTC date, so re-running the same day is a no-op rather than a second email.
 */
export function briefingSchedule({ at = new Date(), previous = null } = {}) {
  const due = []
  for (const id of BRIEFING_AUDIENCE_IDS) {
    const cadence = BRIEFING_AUDIENCES[id].cadence
    const key = periodKey(cadence, at)
    if (key === null) continue
    // Already sent for this period.
    if (previous && periodKey(cadence, previous) === key) continue
    due.push({ audience: id, period_key: key, cadence })
  }
  return due
}

/** The period an instant falls in, or null for a cadence with no period defined. */
function periodKey(cadence, at) {
  const d = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(d.getTime())) return null
  const day = d.toISOString().slice(0, 10)
  if (cadence === 'daily') return day
  if (cadence === 'weekly') {
    // The Monday of this ISO week, so a weekly briefing has one key per week
    // rather than one per day it was considered.
    const dow = (d.getUTCDay() + 6) % 7
    const monday = new Date(d.getTime() - dow * 86400000)
    return monday.toISOString().slice(0, 10)
  }
  return null
}

function scopeOf(selection, report) {
  const scope = {}
  for (const key of selection.scope_kept) if (report.scope?.[key] !== undefined) scope[key] = report.scope[key]
  return scope
}

function sectionsFor(selection, report) {
  const kept = new Set(selection.sections_kept)
  return (report.sections || []).filter((s) => kept.has(s.slug || s.id || slugify(s.title)))
}

function slugify(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}
