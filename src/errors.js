/**
 * ARC-07 — one error envelope, and a code a client can branch on.
 *
 * The error shape was hand-written at 129 `jsonResponse` sites in
 * `src/server.js` and nowhere else. Every one of them wrote
 * `{ success: false, error: '…' }` and nothing carried a machine-readable
 * reason, so the only way for a client to tell "this report is approved and
 * cannot be regenerated" from "this record is deleted" — both 409 — was to
 * match on the human sentence. That sentence is prose, it is rewritten whenever
 * someone improves the wording, and it is the thing a translator would touch
 * first. A client branching on it is a client that breaks on a copy edit.
 *
 * **Two layers, because one is not enough.**
 *
 * The status gives a *default* code, applied centrally in `jsonResponse`. That
 * is what makes the guarantee mechanical: a new error site cannot forget,
 * because the site does not write the code. It also cannot be wrong in the
 * common case, where the status already says everything — a 404 is a 404.
 *
 * The status is not always enough. Four distinct meanings live under 409
 * (a replay already in flight, an immutable report, an alert in the wrong
 * state, a soft-deleted record) and a client that treats them alike will retry
 * the one it must not. Those sites name their code explicitly, from
 * `ERROR_CODES` below, so the vocabulary stays closed: a code that is not in
 * this file is a typo, and `test/error-taxonomy.test.js` reads the source to
 * say so before it ships.
 *
 * **What a code is not.** It is not a substitute for the message. The message
 * stays, because a human reads it and the code is not a sentence. And it is not
 * an HTTP status — the status is the protocol's word, the code is this API's,
 * and a client that must handle "approved reports are immutable" differently
 * from "a replay is in flight" needs the second one.
 */

/**
 * Every code this API emits. Frozen, and closed: the test asserts that every
 * `ERROR_CODES.X` referenced in `src/` resolves to a key here, and that no
 * response carries a code from outside the set.
 */
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  INVALID_SIGNATURE: 'invalid_signature',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  READ_ONLY: 'read_only',
  CONFLICT: 'conflict',
  IDEMPOTENCY_IN_FLIGHT: 'idempotency_in_flight',
  IMMUTABLE: 'immutable',
  INVALID_STATE: 'invalid_state',
  RECORD_DELETED: 'record_deleted',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported_media_type',
  UNPROCESSABLE_ENTITY: 'unprocessable_entity',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_FAILED: 'upstream_failed',
  INTERNAL_ERROR: 'internal_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',
})

/** The closed vocabulary, as a set, for the membership checks. */
export const ERROR_CODE_VALUES = new Set(Object.values(ERROR_CODES))

/**
 * The default code for a status, when the site does not name one.
 *
 * The two fallbacks are deliberate rather than lazy. An unlisted 4xx is still
 * the caller's request being rejected, and an unlisted 5xx is still this
 * process failing; both are truer than `undefined`, and both are stable, which
 * is the whole property a client branches on.
 */
const STATUS_CODES = Object.freeze({
  400: ERROR_CODES.BAD_REQUEST,
  401: ERROR_CODES.UNAUTHORIZED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  405: ERROR_CODES.METHOD_NOT_ALLOWED,
  409: ERROR_CODES.CONFLICT,
  413: ERROR_CODES.PAYLOAD_TOO_LARGE,
  415: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
  422: ERROR_CODES.UNPROCESSABLE_ENTITY,
  429: ERROR_CODES.RATE_LIMITED,
  500: ERROR_CODES.INTERNAL_ERROR,
  502: ERROR_CODES.UPSTREAM_FAILED,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
})

/** The code a bare status resolves to. Never returns a non-string. */
export function errorCodeFor(status) {
  const known = STATUS_CODES[status]
  if (known) return known
  return status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.BAD_REQUEST
}

/**
 * The body as it will be sent, with a `code` on every failed response.
 *
 * Applied at the one place a response body is written, so it is a property of
 * the envelope rather than a habit each site has to keep. Three cases are left
 * exactly as the caller wrote them:
 *
 * - A body that is not a plain object (a plan, a string) is untouched. The
 *   envelope is not something to add to a value that has a shape of its own.
 * - A success carries no code. `code` on a 200 would collide with any payload
 *   field of that name and mean nothing besides.
 * - A `code` the caller already set is kept, provided it is a string in the
 *   vocabulary. A non-string or unknown value falls back to the status
 *   default: an explicit code that is `undefined` — the shape a typo'd
 *   `ERROR_CODES.NOPE` takes — must not reach a client as a missing field.
 */
export function errorEnvelope(status, body) {
  if (status < 400) return body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  if (body.success !== false) return body
  if (typeof body.code === 'string' && ERROR_CODE_VALUES.has(body.code)) return body
  return { ...body, code: errorCodeFor(status) }
}
