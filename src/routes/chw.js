/**
 * ARC-01 — the CHW routes, out of the god function.
 *
 * Two writes the community health worker app posts: a field report filed from
 * the phone, and a reply to an alert. They are a family because they are the
 * only two routes that take a record *directly from a device in the field* —
 * they write `field_reports`/`rapidpro_inbound_messages` without passing
 * through an ingestion run or a RapidPro webhook — and because that directness
 * is exactly what makes their correctness load-bearing.
 *
 * The properties this module exists to hold, each of which was a bug once:
 *
 *   - **an absent fix is not a point at Null Island.** Location used to be
 *     `body.location?.latitude || 0`, which turned a missing fix, an explicit
 *     null and a real zero alike into 0/0. A field report is a disease signal,
 *     and a signal placed at a fixed ocean coordinate looks located, so cluster
 *     detection and any "facilities near this report" join treat it as real. The
 *     record now carries `location_source` so a caller can tell "the CHW is
 *     standing in it" from "we do not know where".
 *   - **the id is minted from the device's submission id when it sent one.**
 *     ENH-39. Without it the id hashed the server's `now`, so a lost response
 *     followed by a queue drain wrote the same report twice.
 *   - **the redactor sees the object it is about to store.** The reporter's name
 *     and number live on the inbound record, not the field report; handing the
 *     raw `body` to the inbound built it with the fields the redactor never saw,
 *     so both survived into the export. The inbound is redacted here, like the
 *     RapidPro path redacts the object it stores.
 *   - **the category is a taxonomy value, not the form name.** `body.category ||
 *     body.kind` stored `symptom` or `incident` — the *form* — whenever a client
 *     sent no category. This route writes `field_reports` directly and never
 *     reaches `normalizeFieldReport`, so the registry has to be called here too.
 *   - **the quality verdict is stamped after redaction.** ENH-44, so the
 *     duplicate comparison runs over the text that will actually be kept.
 *
 * `matchChwRoute` reads the pathname only; both routes are POST and the handler
 * answers 405 for anything else.
 */

import { actionLog } from '../operations.js'
import { loadPolicy, redactPii } from '../pii.js'
import { stampQuality } from '../quality.js'
import { assertCategory } from '../taxonomy.js'
import { stableId, readRequestJson } from '../utils.js'
import { FIELD_REPORT_PREFIX, recordIdForSubmission } from '../submission-id.js'
import { formFor, mergeForms, validateAnswers } from '../forms.js'

/**
 * Every form version this deployment can serve: the built-ins merged with
 * whatever has been published to the store.
 *
 * A function of `data` rather than a module-level cache, because a published
 * version must be servable on the next request rather than after a restart — and
 * because two replicas reading one store must agree, which a per-process cache
 * would only do until one of them published. This is the `data`-shaped adapter
 * `server.js` defined locally, carried here verbatim; it is not a `forms.js`
 * primitive, so it does not belong there.
 */
function activeForms(data) {
  return mergeForms(data?.form_definitions || [])
}

/**
 * Which CHW route a request is, or null.
 *
 * Pathname only: both are POST, and the handler answers 405 for a verb it does
 * not serve. `check-openapi.mjs` reads the two literals.
 */
export function matchChwRoute(pathname) {
  if (pathname === '/api/v1/chw/report') return { kind: 'report' }
  if (pathname === '/api/v1/chw/reply') return { kind: 'reply' }
  return null
}

/**
 * Handle one CHW route. Returns true when it handled the request.
 *
 * The `loadPolicy()` read at the top is carried over verbatim from the inline
 * handler, where it was dead: the report branch declared its own `policy` (the
 * per-request literal below) and shadowed it, and the reply branch never reads
 * one. It is a pure read with no side effect, so leaving the call in place keeps
 * the move behaviour-identical; removing it would be a separate change. See the
 * report for the finding.
 */
export async function handleChwRoute(route, { store, data, req, res, jsonResponse }) {
  const policy = await loadPolicy()

  if (req.method === 'POST' && route.kind === 'report') {
    const body = await readRequestJson(req)
    const now = new Date().toISOString()
    // Location is nullable on purpose. It used to be `|| 0`, which turned a
    // missing fix, an explicit null and a real zero alike into latitude 0,
    // longitude 0 — Null Island, in the ocean off West Africa. A field report
    // is a disease signal, and a signal placed at a fixed ocean coordinate is
    // worse than one with no coordinate at all: it looks located, so cluster
    // detection and any "facilities near this report" join treat it as real.
    //
    // When there is no fix, the record says so via location_source, so a caller
    // can tell "the CHW is standing in it" from "we do not know where".
    const reportedLat = Number(body.location?.latitude)
    const reportedLon = Number(body.location?.longitude)
    const hasFix = Number.isFinite(reportedLat) && Number.isFinite(reportedLon)
      && !(reportedLat === 0 && reportedLon === 0)
    const record = {
      // ENH-39. The device mints a submission id once, before its first attempt,
      // and carries it through every retry — so a report delivered twice is one
      // record. Without it the id hashed the server's `now` and a lost response
      // followed by a queue drain wrote the same report twice, which was
      // measured against a live server before this changed.
      id: recordIdForSubmission(FIELD_REPORT_PREFIX, body.submission_id)
        || stableId('report', [body.description, body.location?.latitude, body.location?.longitude, now]),
      submission_id: typeof body.submission_id === 'string' && body.submission_id ? body.submission_id : null,
      summary: body.description,
      // CAP-05. `body.category || body.kind` stored free text, and it stored
      // `symptom` or `incident` — the *form* — whenever a client sent no
      // category, which made the categorical field carry a transport fact. A
      // value the taxonomy does not know is a 400 here rather than a record
      // nobody can aggregate: this route writes `field_reports` directly and
      // never reaches `normalizeFieldReport`, so the registry had to be called
      // at both doors.
      category: assertCategory(body.category ?? null),
      status: 'new',
      source: 'chw_web',
      latitude: hasFix ? reportedLat : null,
      longitude: hasFix ? reportedLon : null,
      location_source: hasFix
        ? (body.location?.source === 'gps' ? 'gps' : 'reported')
        : (body.location?.source || 'unknown'),
      location_accuracy_m: hasFix && Number.isFinite(Number(body.location?.accuracy_m))
        ? Number(body.location.accuracy_m)
        : null,
      reported_by: req.__auth?.subject,
      // CAP-01. The exact `(id, version)` this report was filled against.
      // Without it a record is only interpretable against whichever version of
      // the form happens to be current when someone reads it — so when a
      // question changes, the records collected under the old wording become
      // indistinguishable from the new ones and the column holds answers to two
      // different questions. A submission that names a version nobody can read
      // is a record nobody can interpret, which is why versions are immutable
      // and a published one is never replaced.
      //
      // Absent when the client sent no form: an older client still files a
      // report, and its record says `null` rather than claiming a version it did
      // not use. That is the honest value, and it is what makes the pre-CAP-01
      // records identifiable.
      form_id: typeof body.form_id === 'string' ? body.form_id : null,
      form_version: Number.isInteger(body.form_version) ? body.form_version : null,
      // ENH-44. When the phone says it captured the report. Distinct from
      // `created_at`, which is when the server received it — for a report that
      // sat in the offline queue for a day the two differ by a day, and that
      // difference is the only thing that separates "filed from a village with
      // no signal" from "the device clock is wrong". A client that sends
      // nothing gets `null` and the skew axis reports itself unmeasured, which
      // is the honest answer; defaulting it to `now` would claim every report
      // arrived on time.
      captured_at: typeof body.captured_at === 'string' && body.captured_at ? body.captured_at : null,
      created_at: now,
      updated_at: now,
    }

    // CAP-01. Answers validated against the version the client named, when it
    // named one. A client that sends `form_id` and no answers is filing a report
    // in the old free-text shape and is left alone; a client that sends answers
    // gets them checked against the definition, and a report that does not
    // validate is a 400 naming the field rather than a record with a value no
    // version of the form can read.
    if (record.form_id) {
      const definition = formFor(activeForms(data), record.form_id, record.form_version)
      if (!definition) {
        jsonResponse(res, 400, {
          success: false,
          error: `this deployment serves no ${record.form_id} v${record.form_version}`,
        })
        return true
      }
      const { answers, problems } = validateAnswers(definition, body.answers || {})
      if (problems.length) {
        jsonResponse(res, 400, { success: false, error: problems.join('; '), problems })
        return true
      }
      record.answers = answers
    }

    // One policy for both records written here. `anonymous` is a per-request
    // opt-in from the reporter; absent, it leaves the name to the loaded
    // default. The phone is redacted either way — a CHW who does not ask to be
    // named has not agreed to be called.
    const requestPolicy = {
      redactNames: body.anonymous,
      redactPhone: true,
      coarsenGeoToH3Cell: 3,
    }

    const redacted = redactPii(record, requestPolicy)

    // The reporter's name and number live on the inbound record, not on the
    // field report. Redacting `record` and then handing `body` straight to the
    // inbound built it with — which is what this used to do — means the redactor
    // saw an object that never had the fields and passed them through untouched,
    // so both survived into `GET /api/v1/rapidpro/inbound` and export.csv. The
    // RapidPro path redacts the object it is about to store; this now does too.
    // DATA-12. Keyed on the field report it accompanies, not on the clock. The
    // report's id is already submission-derived (ENH-39), so a retried
    // submission resolves to one report — but the inbound row hashed `now`, so
    // one report acquired a second inbound row and the operator's queue showed
    // the same message twice. `field_report_id` is the relation this row exists
    // to state; it is the right key.
    const inbound = redactPii({
      id: stableId('inbound', [redacted.id]),
      text: body.description,
      contact_urn: body.reporter_phone || '',
      contact_name: body.reporter_name || '',
      event_type: 'field_report',
      created_at: now,
    }, requestPolicy)
    inbound.field_report_id = redacted.id

    // ENH-44. The verdict is stamped onto the record before it is stored, and
    // it is stamped *after* redaction so the duplicate comparison runs over the
    // text that will actually be kept — comparing against the unredacted
    // summary would match on words the record does not contain.
    //
    // The candidates are read from the store rather than from `data`, because a
    // double submission is most often two reports filed minutes apart and the
    // dispatcher's snapshot is taken before the first of them was written.
    //
    // Scoped, and it was not. The comment above this line said "the read is
    // scoped to `field_reports` alone" for as long as the line was a bare
    // `store.read()` — which materialises every collection. Measured against
    // this deployment's store: 169 field reports wanted, 48,473 rows read, a
    // 287× over-read on the route a health worker's phone hits. The manifest is
    // what the comment claimed; a claim in a comment is not a scope.
    const candidates = (await store.read({ collections: ['field_reports'] }))?.field_reports || []
    const stamped = stampQuality(redacted, { candidates, received_at: now })

    const log = actionLog('field_reports', 'created', stamped, 'chw_web', req.__auth?.subject)
    await store.merge({
      field_reports: [stamped],
      rapidpro_inbound_messages: [inbound],
      action_logs: [log],
    })
    jsonResponse(res, 201, { success: true, data: stamped })
    return true
  }

  if (req.method === 'POST' && route.kind === 'reply') {
    const body = await readRequestJson(req)
    const now = new Date().toISOString()
    const inbound = {
      // DATA-12, the same key as the branch above: the alert and the message are
      // the reply's content, and a retry of one reply is one row.
      id: stableId('inbound', [body.alert_event_id, body.message]),
      text: body.message,
      event_type: 'chw_reply',
      alert_event_id: body.alert_event_id,
      created_at: now,
    }

    const log = actionLog('rapidpro_inbound_messages', 'created', inbound, 'chw_web', req.__auth?.subject)
    await store.merge({
      rapidpro_inbound_messages: [inbound],
      action_logs: [log],
    })
    jsonResponse(res, 201, { success: true, data: inbound })
    return true
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}
