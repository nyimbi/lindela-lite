/**
 * ARC-01 — the scenario routes, out of the god function.
 *
 * Two routes over two paths, and they are a family because they are one
 * perturbation engine reached two ways:
 *
 *   - `POST /api/v1/scenarios` runs a perturbation the caller just built and
 *     hands back the result *and* a token.
 *   - `GET /api/v1/scenarios/:token` decodes that token, replays the same
 *     perturbation and returns the same result.
 *
 * The property that makes them one module is the round trip: the token a create
 * mints is the token a retrieve decodes, so a change to `encodeScenarioUrl`
 * that a retrieve did not match would make every shared scenario URL a 400. The
 * two branches are read together here precisely so the encoder and the decoder
 * cannot drift apart — `decodeScenarioUrl` throws a 400 for a token that is not
 * a scenario, and that refusal travels rather than becoming a 500.
 *
 * The matcher reads the pathname only: the token form is a GET and the
 * collection form is a POST, and the handler tests the verb, so a wrong verb
 * falls through to the 404 rather than answering a body that says nothing about
 * which one it was.
 */

import { runScenario, encodeScenarioUrl, decodeScenarioUrl } from '../scenarios.js'
import { readRequestJson } from '../utils.js'

/**
 * Which scenario route a request is, or null.
 *
 * Pathname only. `check-openapi.mjs` reads both literals — the collection and
 * the `.match(/…/)` token form — so the two served paths are visible to the
 * spec gate.
 */
export function matchScenarioRoute(pathname) {
  if (pathname === '/api/v1/scenarios') return { kind: 'create' }
  const match = pathname.match(/^\/api\/v1\/scenarios\/([^/]+)$/)
  if (match) return { kind: 'retrieve', token: decodeURIComponent(match[1]) }
  return null
}

/**
 * Handle one scenario route. Returns true when it handled the request.
 *
 * A kind that matched but whose verb is wrong returns false rather than writing
 * a response, so the dispatcher's fallthrough answers the 404 — the same shape
 * the exposure and derived matchers take for a read reached with a write verb.
 */
export async function handleScenarioRoute(route, { data, req, res, jsonResponse }) {
  if (req.method === 'POST' && route.kind === 'create') {
    const body = await readRequestJson(req)
    // The perturbation may be the body itself or nested under `perturbation`; a
    // client that posts the bare object is the documented form and a client that
    // wraps it is the older one, and both are accepted rather than one being
    // read as an empty perturbation.
    const perturbation = body.perturbation || body
    const result = runScenario(data, perturbation)
    const token = encodeScenarioUrl(perturbation)
    jsonResponse(res, 201, { success: true, ...result, token })
    return true
  }
  if (req.method === 'GET' && route.kind === 'retrieve') {
    try {
      const perturbation = decodeScenarioUrl(route.token)
      const result = runScenario(data, perturbation)
      jsonResponse(res, 200, { success: true, ...result })
      return true
    } catch (error) {
      // A token that is not a scenario is a 400, not a 500: `decodeScenarioUrl`
      // already carries the status, and a malformed share link is the caller's
      // input rather than the platform's failure.
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
      return true
    }
  }
  return false
}
