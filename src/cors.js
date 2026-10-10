/**
 * CAP-06 — cross-origin reads, off by default and named by the operator.
 *
 * The server is a JSON API with a documented OpenAPI surface and a generated
 * client, and a browser-based third-party client could not call any of it: no
 * `OPTIONS` handler and no `Access-Control-Allow-*` header existed anywhere in
 * `src/`. A dashboard on another origin got an opaque CORS failure, which the
 * browser reports the same way it reports the server being down.
 *
 * **Why this is opt-in and not `*` by default.** The API serves partner-scoped
 * rows. `Access-Control-Allow-Origin: *` on a data route is a standing grant to
 * every origin on the internet to make cross-origin reads with the visitor's
 * ambient credentials — which is precisely the boundary the token and
 * `partner_org` model exists to draw. So an operator names the origins they
 * trust in `LINDELA_LITE_CORS_ORIGINS`, the same way they name public paths, and
 * the default is that no origin is granted anything.
 *
 * **Echoing, not wildcarding.** When the list contains `*`, the concrete request
 * origin is echoed back rather than the literal `*`. A browser refuses
 * `Access-Control-Allow-Origin: *` together with credentials, so a wildcard
 * written literally would work for uncredentialed requests and silently fail for
 * credentialed ones — a configuration that reads as working and is not.
 */

/** The configured origins, trimmed, in the order the operator wrote them. */
export function corsOrigins(env = process.env) {
  return String(env.LINDELA_LITE_CORS_ORIGINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Is this request's `Origin` one the operator granted? */
export function isAllowedOrigin(origin, env = process.env) {
  if (!origin || typeof origin !== 'string') return false
  const list = corsOrigins(env)
  if (list.includes('*')) return true
  // `Origin` is a serialised origin with no trailing slash, and an exact
  // comparison is the only safe one: a suffix match would let
  // `https://ops.example.evil.test` inherit `https://ops.example`.
  return list.includes(origin)
}

/**
 * The headers a cross-origin response needs, or `{}` when the origin is not
 * allowed.
 *
 * `vary: origin` travels with every allowed response. Without it a shared cache
 * stores the response under no vary condition and serves one origin's grant —
 * or one origin's *data* — to a different origin.
 */
export function corsResponseHeaders(origin, env = process.env) {
  if (!isAllowedOrigin(origin, env)) return {}
  const wildcard = corsOrigins(env).includes('*')
  const headers = {
    'access-control-allow-origin': origin,
    vary: 'origin',
    'access-control-expose-headers': 'etag, x-request-id, retry-after',
  }
  // Credentials are granted only for an explicitly named origin. With `*` the
  // grant is "any origin may read", which is not the same statement as "any
  // origin may read with this visitor's cookies", and only the first was asked
  // for.
  if (!wildcard) headers['access-control-allow-credentials'] = 'true'
  return headers
}

/**
 * The methods the API actually serves.
 *
 * `HEAD` is on the list because the API now answers it (CAP-06's second half) —
 * a preflight that omitted it would let a browser client's `HEAD` probe fail
 * after the server had been taught to serve it.
 */
export const CORS_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/**
 * The request headers a browser client is allowed to send.
 *
 * `authorization` and `x-api-key` are both named because both are accepted, and
 * a client whose token is refused at the preflight never sends the request that
 * would have carried it — the failure looks like a broken endpoint.
 * `idempotency-key` is here because the retry it exists for is exactly the case
 * a flaky cross-origin network produces.
 */
export const CORS_HEADERS = Object.freeze([
  'authorization',
  'content-type',
  'x-api-key',
  'idempotency-key',
  'x-request-id',
  'if-none-match',
  'if-match',
  'accept',
])

/** How long a browser may cache the preflight, in seconds. */
export const CORS_MAX_AGE_SECONDS = 600

/** True when this request is a CORS preflight rather than a real request. */
export function isPreflight(req) {
  return req?.method === 'OPTIONS' && Boolean(req.headers?.origin)
    && Boolean(req.headers?.['access-control-request-method'])
}

/** The full preflight response, or a refusal when the origin is not granted. */
export function preflightResponse(origin, env = process.env) {
  if (!isAllowedOrigin(origin, env)) {
    return {
      status: 403,
      headers: {},
      body: { success: false, error: 'Origin not allowed' },
    }
  }
  return {
    status: 204,
    headers: {
      ...corsResponseHeaders(origin, env),
      'access-control-allow-methods': CORS_METHODS.join(', '),
      'access-control-allow-headers': CORS_HEADERS.join(', '),
      'access-control-max-age': String(CORS_MAX_AGE_SECONDS),
    },
    body: null,
  }
}
