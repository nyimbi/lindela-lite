/**
 * ENH-60 — the operator-maintenance family, out of the god function.
 *
 * Two routes, and they are one family because `src/auth.js` already says so:
 * both match the `/api/v1/maintenance` and `/api/v1/demo` prefixes and both
 * resolve to the same scope, `admin:maintenance`. A route group the
 * authorization table treats as one privilege is one group, whatever the
 * dispatcher's line numbering says.
 *
 * The family carried a live defect, and it is the reason these two belong in
 * one file rather than two.
 *
 * `apply-retention` and the driver's `retention` item (`applyScheduledRetention`
 * in `src/server.js`) are two implementations of one operation, 1,200 lines
 * apart, and they disagreed. The route read its refusal off `retentionWindowDays`
 * — the *general* window — and 400'd when that was unset. The driver read each
 * collection's own window off `retentionWindowFor`. So a deployment that
 * configured only `communityFeedbackDays`, the more sensitive window, and left
 * `retentionDays` at zero got:
 *
 *   POST /api/v1/maintenance/apply-retention
 *   → 400 "retentionDays is not a positive number ... Nothing was deleted."
 *
 * while the scheduled driver had been expiring `community_feedback` every tick.
 * The operator reads "nothing was deleted" and is exactly wrong; the collection
 * that carries a member of the public's own words is the one being purged.
 *
 * The route now applies each collection's own window, the way the driver does,
 * and refuses only when *no* collection has a window — which is the condition
 * the refusal message was always about. A per-collection window of null is a
 * collection with no rule, reported as `window_days: null` beside the counts,
 * not a reason to refuse the whole request and lie about the other two.
 *
 * The two implementations still exist and that is deliberate rather than tidy:
 * the driver takes `data` the server already read and must not read the store
 * again inside a tick, while the route answers a single request. Unifying them
 * fully is a larger change than this extraction; what this file fixes is that
 * they no longer *disagree*, and what it makes possible is that the next reader
 * finds both in one place.
 */

import { refreshAnalytics } from '../analytics.js'
import { actionLog } from '../operations.js'
import { applyRetention, loadPolicy, personalWindowKey, retentionWindowFor } from '../pii.js'
import { logger } from '../observability.js'
import { captureRun, parseRunCapture, pinClock, replayRun, serialiseRunCapture } from '../replay.js'

/**
 * ENH-76. The body cap for a replay request, larger than the 5 MB default.
 *
 * A run capture carries the input snapshot, the published rows and the audit
 * chain, and a real store's snapshot is megabytes. The default would refuse the
 * document this route exists to accept, with a 413 that reads as "your capture is
 * too big" when the truth is "the cap was written for a form post". Named here
 * rather than inlined so the number is one decision in one place.
 */
export const REPLAY_BODY_MAX_BYTES = 64 * 1024 * 1024

/**
 * The collections retention applies to, and the window each is measured by.
 *
 * Named once, here, because the route and the driver must agree about the set.
 * `community_feedback` carries a window of its own — R-12's point was that a
 * person's words are not an operational record, and being the only collection
 * without a rule was what made its omission an oversight rather than a decision.
 * `annotations` is the second collection of a person's own free text (ENH-74),
 * and it is here for the same reason.
 *
 * The driver imports this list rather than repeating it. It used to write the
 * same three names out as an object literal 1,200 lines away in `src/server.js`,
 * which is the repo's signature defect with the worst possible consequence: a
 * collection named in one list and not the other is purged by one call site and
 * kept forever by the other, and nothing fails. `test/maintenance-route-module
 * .test.js` asserted the two agreed, which is a test standing in for a
 * derivation that removes the drift rather than detecting it.
 */
export const RETENTION_COLLECTIONS = Object.freeze(['field_reports', 'rapidpro_inbound_messages', 'community_feedback', 'annotations'])

/** The default deadline for `POST /api/v1/demo/seed`'s live-ingestion half. */
export const DEMO_SEED_BUDGET_MS = 45_000

/**
 * Which maintenance route a request is, or null.
 *
 * Method-aware: both are POST mutations of operator state, and a `GET` to
 * either path is not a route. `check-openapi.mjs` reads this matcher's
 * `pathname === '…'` literals, so they are spelled out rather than assembled.
 */
export function matchMaintenanceRoute(pathname, method = 'POST') {
  if (String(method).toUpperCase() !== 'POST') return null
  if (pathname === '/api/v1/maintenance/apply-retention') return { kind: 'apply-retention' }
  if (pathname === '/api/v1/maintenance/capture-run') return { kind: 'capture-run' }
  if (pathname === '/api/v1/maintenance/replay-run') return { kind: 'replay-run' }
  if (pathname === '/api/v1/demo/seed') return { kind: 'demo-seed' }
  return null
}

/**
 * Expire every collection whose window is configured, and report all three.
 *
 * The refusal is by name and it names the *right* condition: no collection has
 * a window. That is what makes the request impossible rather than empty — an
 * unset window used to become `NaN`, `age > NaN` is false for every record, and
 * the route expired nothing while reporting `success: true` (DAT-07). Refusing
 * is what an operator can act on.
 *
 * Returns the response body. The caller sends it.
 */
export async function applyRetentionForRequest(store, data, policy, now = Date.now()) {
  const perCollection = {}
  const removals = {}
  for (const collection of RETENTION_COLLECTIONS) {
    const records = data[collection] || []
    const days = retentionWindowFor(policy, collection)
    if (days === null) {
      perCollection[collection] = { window_days: null, kept: records.length, expired: 0 }
      continue
    }
    const result = applyRetention(records, days, now)
    perCollection[collection] = {
      window_days: days,
      kept: result.kept.length,
      expired: result.expired.length,
    }
    removals[collection] = result.expired.map((record) => record.id)
  }

  const expiredTotal = Object.values(perCollection).reduce((sum, c) => sum + c.expired, 0)
  if (expiredTotal > 0) {
    // remove(), not merge(). merge() keyed on id, so re-merging the survivors
    // over the originals left every expired record exactly where it was — the
    // route reported `{success: true, expired: 1}` and deleted nothing (DAT-07).
    await store.remove({ collection: removals })
  }
  return perCollection
}

/**
 * Handle one maintenance route. Returns true when it handled the request.
 *
 * `withTimeout` and `readRequestJson` are injected rather than imported:
 * `withTimeout` lives in `src/server.js` and importing it from a module that
 * file imports would be a cycle, and `readRequestJson` reads the live request
 * stream, which the server owns.
 */
export async function handleMaintenanceRoute(route, { store, data, req, res, url, jsonResponse, withTimeout, readRequestJson }) {
  const { kind } = route

  if (kind === 'apply-retention') {
    const policy = await loadPolicy()
    const perCollection = await applyRetentionForRequest(store, data, policy)

    // Refuse only when nothing at all can be applied. A deployment that set the
    // community window and not the general one gets a 200 that says so per
    // collection — the driver was already expiring feedback in that state, and
    // a 400 here told the operator the opposite of the truth.
    const anyWindow = Object.values(perCollection).some((c) => c.window_days !== null)
    if (!anyWindow) {
      // Every field the policy could have set, named with its value, so the
      // operator sees which knob is missing rather than a single window that was
      // never the only one. Built from the policy's own keys: a hand-typed list
      // here is how `annotationDays` would go unmentioned the day it is added.
      const windows = RETENTION_COLLECTIONS
        .map((collection) => `${personalWindowKey(collection) || 'retentionDays'} is ${JSON.stringify(retentionWindowFor(policy, collection))}`)
      jsonResponse(res, 400, {
        success: false,
        error: `no retention window is configured (${windows.join(', ')}); set one in data/pii-policy.json or LINDELA_LITE_PII_POLICY. Nothing was deleted.`,
      })
      return true
    }

    jsonResponse(res, 200, { success: true, ...perCollection })
    return true
  }

  if (kind === 'capture-run') {
    // ENH-76. Run the derivation once and write down everything a replay needs:
    // the snapshot it read, the rows it published, the instant it ran.
    //
    // The snapshot is taken *before* the refresh, because `refreshAnalytics`
    // swaps the derived collections — a capture that read the store afterwards
    // would hold the run's own output as its input, and replaying it would
    // compare a run against itself. That is a capture which reproduces by
    // construction and verifies nothing, and it is the failure mode this route
    // is most likely to introduce.
    const body = await readRequestJson(req).catch(() => ({}))
    const inputs = await store.read()
    // The clock is pinned *around* the refresh, not read after it. The run stamps
    // `generated_at` and `honesty.evidence.retrieved_at` on every derived row
    // from `new Date()`, and `replayRun` re-derives under a pin at the capture's
    // own `pinned_at` — so a route that ran on the real clock and then recorded a
    // later instant would write a capture that diverges from itself on every
    // timestamp it carries. Pinning here is what makes the pair symmetric: the
    // run and its replay see one instant.
    const now = new Date().toISOString()
    const published = await pinClock(now, () => refreshAnalytics(store))
    let capture
    try {
      capture = captureRun({ inputs, published, now, note: typeof body?.note === 'string' ? body.note : null })
    } catch (error) {
      // `captureRun` refuses a malformed input or published set by name. That is
      // a 400 the operator can act on rather than a 500 for a bad request.
      jsonResponse(res, 400, { success: false, error: error.message, code: error.name })
      return true
    }
    const document = serialiseRunCapture(capture)
    const log = actionLog('maintenance', 'capture_run', { pinned_at: capture.pinned_at, bytes: document.length }, body?.actor, req.__auth?.subject)
    await store.merge({ action_logs: [log] })
    jsonResponse(res, 201, {
      success: true,
      pinned_at: capture.pinned_at,
      bytes: document.length,
      // The capture is the response body's `capture` field rather than a file
      // this route writes. A maintenance route that wrote a path the caller
      // named would be a write primitive; the caller already has the bytes and
      // can put them wherever it keeps evidence.
      capture: JSON.parse(document),
      action_log: log,
    })
    return true
  }

  if (kind === 'replay-run') {
    // ENH-76. Re-derive a captured run through the production engine and report
    // whether every published number came back bit-for-bit.
    //
    // The capture arrives in the body. It is a portable document by design —
    // `serialiseRunCapture` exists so a run can be handed to somebody else to
    // check — and verifying one is exactly the act this route serves. It writes
    // nothing: a replay that wrote its result into the store would be a run, and
    // the module's whole claim is that a replay is not a re-run.
    const body = await readRequestJson(req, { maxBytes: REPLAY_BODY_MAX_BYTES }).catch((error) => ({ __error: error }))
    if (body?.__error) {
      jsonResponse(res, body.__error.statusCode || 400, { success: false, error: body.__error.message })
      return true
    }
    let capture
    try {
      // Accept the document directly, or nested under `capture` — a client that
      // posted the route's own 201 body should not have to unwrap it.
      capture = parseRunCapture(body?.capture ? JSON.stringify(body.capture) : JSON.stringify(body))
    } catch (error) {
      jsonResponse(res, 400, { success: false, error: error.message, code: error.name })
      return true
    }
    const verdict = await replayRun(capture)
    const log = actionLog('maintenance', 'replay_run', { verdict: verdict.verdict, pinned_at: capture.pinned_at }, body?.actor, req.__auth?.subject)
    await store.merge({ action_logs: [log] })
    // A divergence is a 200. The replay ran and answered; the answer is that a
    // number moved. A 4xx would make "the engine disagrees with its own record"
    // read as a malformed request, and that is the one reading an operator must
    // not get.
    jsonResponse(res, 200, { success: true, ...verdict, action_log: log })
    return true
  }

  if (kind === 'demo-seed') {
    // Declared outside the `try` because the `catch` needs all of them: it
    // reports `budgetMs`, and the budget-exhausted path — the one path that
    // matters — has to seed the demo data with the same three functions that
    // threw. A `const` in the block is not in scope in its own handler.
    let budgetMs = DEMO_SEED_BUDGET_MS
    let seedAll, ingestPublicSources, summary
    try {
      // ARC-03. `../demo-seed.js`, not `../../scripts/seed-demo.mjs`. A
      // production request path reaching into `scripts/` is inverted layering,
      // and it put the 75 KB seed module on the runtime path where an import
      // error there is a 500 on a live route. The script is a wrapper over the
      // module. `test/layering.test.js` is the guard that it stays that way.
      ;({ seedAll, ingestPublicSources, summary } = await import('../demo-seed.js'))
      // The `sources` field was documented on `ingestPublicSources` and on this
      // route and read by neither: the route called it with no options, so a
      // caller who asked for one source got all nine, live. That is not a
      // cosmetic gap — the default set is nine third-party services, and
      // `ipc_hdx` alone fans ~92 requests against a 20/min budget, so an
      // unscoped seed is a three-minute request that a test cannot bound and a
      // deployment cannot interrupt.
      const body = await readRequestJson(req).catch(() => ({}))
      const sources = Array.isArray(body?.sources) && body.sources.length ? body.sources : undefined
      // A deadline, because the alternative is a request held open by whichever
      // upstream is slowest. `ipc_hdx`'s own per-request timeout does not bound
      // this: it has 92 requests to make and each may take its full 30s.
      budgetMs = Number.isFinite(body?.timeout_ms) && body.timeout_ms > 0
        ? Number(body.timeout_ms)
        : DEMO_SEED_BUDGET_MS
      await withTimeout(ingestPublicSources(store, { sources }), budgetMs)
      await seedAll(store)
      await refreshAnalytics(store)
      const counts = await summary(store)
      jsonResponse(res, 200, { success: true, counts })
    } catch (e) {
      // A seed that ran out of wall clock is not a failed seed: the demo data
      // below still lands, and the live half is the part that is optional.
      // Reporting 500 for it would make a slow upstream look like a broken
      // deployment, which is the confusion this route exists to avoid.
      if (e?.name === 'TimeoutError') {
        logger.warn('demo_seed_ingestion_budget_exhausted', { budget_ms: budgetMs, err: { message: e.message } })
        try {
          await seedAll(store)
          await refreshAnalytics(store)
          const counts = await summary(store)
          jsonResponse(res, 200, { success: true, counts, ingestion: 'budget_exhausted' })
          return true
        } catch (fallbackError) {
          logger.error('demo_seed_failed', { err: { message: fallbackError.message, stack: fallbackError.stack } })
          jsonResponse(res, 500, { success: false, error: fallbackError.message })
          return true
        }
      }
      logger.error('demo_seed_failed', {
        err: { message: e.message, stack: e.stack },
      })
      jsonResponse(res, 500, { success: false, error: e.message })
    }
    return true
  }

  return false
}
