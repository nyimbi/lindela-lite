/**
 * The authentication gate: the preamble every API request passes through
 * before any route is matched.
 *
 * This is the last block ENH-60 names as entangled in `server.js`, and it is a
 * family by the same test the other thirty-three extractions used — a
 * contiguous block with one job and a name. It is not a route family: it has no
 * `match` because it runs *before* matching, and it returns a verdict rather
 * than a boolean, because the dispatcher has three things to do with the answer
 * (continue with the identity it resolved, stop with a response, or continue
 * anonymously) and a boolean would lose the identity.
 *
 * ## The four things this gate decides, and why the order is load-bearing
 *
 * 1. **A signed RapidPro webhook is verified against its raw bytes.** The body
 *    must be buffered *first*: a signature covers the exact bytes sent, and the
 *    request stream cannot be read twice. Verifying before buffering meant every
 *    HMAC-signed request failed closed against the real route while passing in
 *    tests that buffered the body themselves — a failure mode that is invisible
 *    to any test that hands the handler a body it already has.
 * 2. **Everything else authenticates, unless it is a public *read*.** The old
 *    guard rejected only non-GET methods, so `GET /api/v1/export.csv` — field
 *    reports and RapidPro message bodies — was served to anyone who could reach
 *    the port even with API keys configured. `isPublicRequest` is a read
 *    widening only: a mutation to a publicly listed path still authenticates.
 * 3. **An unauthenticated caller reaches `/auth-info` and nothing else.** It is
 *    here rather than in the handler so the answer is available *because* the
 *    key was missing. Gating it meant a fresh console asked, got the same 401 as
 *    every other route, and could not tell "this deployment requires a token"
 *    from "this deployment is broken".
 * 4. **A resolved caller is scope-checked before dispatch.** `requireScope`
 *    throws with the status the response should carry; the gate turns that into
 *    the response rather than letting it become a 500.
 *
 * ## Why this is not a route module
 *
 * Every other family under `src/routes/` exports `match*Route` and
 * `handle*Route`. This one exports `enforceAuthGate` alone, because there is
 * nothing to match: it runs at a fixed point in the dispatcher, above the store
 * read and above every matcher, and it is the only thing that runs there. The
 * `auth-info` family it delegates to *is* a route family, at
 * `src/routes/auth-info.js`, and it is called here for the reason in (3).
 */

import { authenticate, isAuthConfigured, isPublicRequest, requireScope, scopeForRoute } from '../auth.js'
import { verifyRapidProWebhook } from '../rapidpro.js'
import { ERROR_CODES } from '../errors.js'
import { readRawBody } from '../utils.js'
import { handleAuthInfoRoute, matchAuthInfoRoute } from './auth-info.js'

/**
 * Run the gate. Returns a verdict the dispatcher acts on.
 *
 *   { outcome: 'continue', auth }  — proceed with this identity (possibly null)
 *   { outcome: 'handled' }         — a response has been written; stop
 *
 * The `auth` on `continue` is what the gate resolved, which is the caller's
 * identity when one was presented and the identity the dispatcher already held
 * when the deployment has no auth configured. Returning the resolved value
 * rather than mutating a parameter is the difference between a gate whose
 * answer is its return value and one whose answer is a side effect on a
 * variable the caller has to remember to read.
 */
export async function enforceAuthGate(req, res, url, { auth = null, jsonResponse } = {}) {
  if (!isAuthConfigured()) return { outcome: 'continue', auth }

  if (url.pathname === '/api/v1/rapidpro/field-report' && req.method === 'POST') {
    req.rawBody = await readRawBody(req)
    if (!verifyRapidProWebhook(req)) {
      jsonResponse(res, 401, { success: false, error: 'Invalid RapidPro webhook', code: ERROR_CODES.INVALID_SIGNATURE })
      return { outcome: 'handled' }
    }
    return { outcome: 'continue', auth }
  }

  if (isPublicRequest(req.method, url.pathname)) return { outcome: 'continue', auth }

  const resolved = authenticate(req)
  if (!resolved) {
    // The one route an unauthenticated caller may reach, answered *because* the
    // key was missing. `auth` is null here, which is what makes this the
    // anonymous answer — the same handler the authenticated path uses, so the
    // two cannot drift.
    const authInfoRoute = matchAuthInfoRoute(url.pathname, req.method)
    if (authInfoRoute && handleAuthInfoRoute(authInfoRoute, { auth: null, res, jsonResponse })) {
      return { outcome: 'handled' }
    }
    jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
    return { outcome: 'handled' }
  }

  try {
    requireScope(resolved, scopeForRoute(req.method, url.pathname))
  } catch (error) {
    jsonResponse(res, error.statusCode || 403, { success: false, error: error.message })
    return { outcome: 'handled' }
  }
  return { outcome: 'continue', auth: resolved }
}
