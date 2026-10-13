/**
 * ENH-68 — the served surface for the grounded natural-language query.
 *
 * `src/nl-query.js` shipped complete, tested and reached by nothing: no route,
 * no console control, no caller outside its own test. A module with zero callers
 * reads as a live feature and is not one, so the register recorded the gap
 * rather than implying it was closed. This is the closure.
 *
 * **A refusal is a 200, not a 4xx.** The module's own contract is that a
 * question it cannot ground is an *answer* — "the store holds no dispatch
 * records, so 'no dispatch' cannot be told apart from dispatches that were never
 * recorded" is a fact about the data, not a fault in the request. Returning 400
 * for it would make the console render "no route" for a correct refusal and
 * teach the operator that asking a question the layer declines is a failure. The
 * one genuine error is a request with no question in it, and that is the only
 * 400 here.
 *
 * **The grounding audit is not bypassed by the model path.** The handler calls
 * `answerQueryWithModel`, which runs the same resolve-render-audit tail as
 * `answerQuery`; a subject Needle proposed is held to the same fact set. The
 * route cannot tell the two apart, which is the point.
 *
 * Method-aware at the matcher (VER-14): this is a read-shaped POST, and a GET
 * must fall through to the 404 rather than answering the same query from the
 * URL, which would put a question in a log line.
 */

import { ERROR_CODES } from '../errors.js'
import { answerQueryWithModel } from '../nl-query.js'
import { readRequestJson } from '../utils.js'

/**
 * Which ask route a request is, or null.
 *
 * POST only. A `GET /api/v1/ask` has no body to carry the question, and the
 * documented surface declares one verb, so a non-POST falls through to the
 * dispatcher's 404.
 */
export function matchAskRoute(pathname, method = 'GET') {
  if (method !== 'POST') return null
  if (pathname === '/api/v1/ask') return { kind: 'ask' }
  return null
}

/**
 * Handle the ask route. Returns true when it handled the request.
 */
export async function handleAskRoute(route, { data, req, res, jsonResponse }) {
  const body = await readRequestJson(req)
  const question = typeof body?.question === 'string' ? body.question.trim() : ''
  if (!question) {
    jsonResponse(res, 400, {
      success: false,
      error: 'A `question` string is required',
      code: ERROR_CODES.BAD_REQUEST,
    })
    return true
  }

  const answer = await answerQueryWithModel(question, data)
  jsonResponse(res, 200, { success: true, answer })
  return true
}
