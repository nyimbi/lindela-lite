/**
 * The auth-info family: one path, two branches of one answer.
 *
 * `GET /api/v1/auth-info` answers "what is this token, as the server understands
 * it" — and it answered from **two places** in the dispatcher, because the
 * question has to be reachable *before* authentication as well as after it:
 *
 *   - on the 401 path, so a console with no key can learn that it needs one.
 *     Gating it meant the client asked, got the same 401 as every other route,
 *     and had nothing to distinguish "this deployment requires a token" from
 *     "this deployment is broken" (`test/auth-bootstrap.test.js` is the story);
 *   - on the authenticated path, where the caller's identity is known.
 *
 * Two copies of one response is the shape VER-18 recorded: a path served twice
 * has exactly one tested implementation, and it is the one nobody is calling.
 * Here the two copies happened to agree — the 401-path copy hardcodes
 * `auth_configured: true`, which is precisely what `isAuthConfigured()` returns
 * inside the branch that guards it — but agreement by coincidence is not a
 * contract. The family is one handler called at both points, with `auth` null
 * on the first, so the two answers are one expression rather than two that
 * currently match.
 *
 * It is a family rather than a pair of blocks by the same test the other
 * extractions used: the two copies are the *same route*, at two depths of the
 * same question, and the module is the missing member they both belong to.
 */

import { isAuthConfigured, publicReadsOpen } from '../auth.js'

export function matchAuthInfoRoute(pathname, method) {
  if (method !== 'GET') return null
  if (pathname === '/api/v1/auth-info') return { kind: 'auth-info' }
  return null
}

/**
 * Answer the route. `auth` is the resolved identity, or `null` on the 401 path.
 *
 * Identity is returned only for a caller who presented a valid token; without
 * one the response is nulls and the flag. A *wrong* token collapses to the same
 * answer as no token, deliberately: `authenticate()` has already collapsed them,
 * and a distinct response would be an oracle distinguishing a bad credential
 * from an absent one — a distinction worth nothing, since the 401 that follows
 * for every other route already reveals that auth is enabled.
 */
export function handleAuthInfoRoute(route, { auth, res, jsonResponse }) {
  jsonResponse(res, 200, {
    success: true,
    data: {
      subject: auth?.subject || null,
      scopes: auth?.scopes || [],
      partner_org: auth?.partner_org || null,
      auth_configured: isAuthConfigured(),
      // Whether anonymous visitors can read the console's data surface. The
      // banner gate uses this to tell "paste a token to see anything" from
      // "browse freely; a token only unlocks writes".
      anonymous_reads: publicReadsOpen(),
    },
  })
  return true
}
