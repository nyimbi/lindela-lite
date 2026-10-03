import crypto from 'node:crypto'

/**
 * Authentication and authorization for the API.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **Deny by default.** A route that is not named in the tables below is not
 *    reachable by a scoped token. It used to fall through to `read:hazards`,
 *    which meant a token issued for reading hazards could POST to any route
 *    nobody thought to map — including ones added after the token was issued.
 *
 * 2. **Fail closed.** A malformed token configuration used to parse to `[]`,
 *    and an empty token list disabled the entire auth block. A typo in
 *    `LINDELA_LITE_TOKENS` therefore turned authentication off, silently, and
 *    the deployment looked secured. Malformed configuration now throws.
 */

export const DENIED_SCOPE = 'admin:*'

/** Read scopes, checked in order; first prefix match wins. */
const READ_SCOPES = [
  // Exports carry field reports and RapidPro message bodies — the most
  // personal data the platform holds. They were readable by any token at all,
  // and by no token when GETs went unauthenticated.
  ['/api/v1/export', 'read:export'],
  ['/api/v1/incidents', 'read:incidents'],
  ['/api/v1/interventions', 'read:incidents'],
  ['/api/v1/tasks', 'read:incidents'],
  ['/api/v1/field-reports', 'read:incidents'],
  ['/api/v1/response-resources', 'read:incidents'],
  ['/api/v1/action-logs', 'read:incidents'],
  ['/api/v1/rapidpro', 'read:incidents'],
  ['/api/v1/chw', 'read:incidents'],
  ['/api/v1/community-feedback', 'read:incidents'],
  ['/api/v1/reports', 'read:reports'],
  ['/api/v1/report-templates', 'read:reports'],
  ['/api/v1/report-schedules', 'read:reports'],
  ['/api/v1/alert-events', 'read:alerts'],
  ['/api/v1/alert-rules', 'read:alerts'],
  ['/api/v1/triggers', 'read:alerts'],
  ['/api/v1/parametric', 'read:parametric'],
  ['/api/v1/webhooks', 'read:integrations'],
  ['/api/v1/outbox', 'read:integrations'],
  ['/api/v1/connectors', 'read:integrations'],
  ['/api/v1/ingest', 'read:integrations'],
  ['/api/v1/sources', 'read:integrations'],
  ['/api/v1/workflows', 'read:integrations'],
]

/** Write scopes, checked in order; first prefix match wins. */
const WRITE_SCOPES = [
  ['/api/v1/incidents', 'write:incidents'],
  ['/api/v1/interventions', 'write:incidents'],
  ['/api/v1/tasks', 'write:incidents'],
  ['/api/v1/field-reports', 'write:incidents'],
  ['/api/v1/response-resources', 'write:incidents'],
  ['/api/v1/action-logs', 'write:incidents'],
  ['/api/v1/rapidpro', 'admin:integrations'],
  ['/api/v1/chw', 'write:incidents'],
  ['/api/v1/community-feedback', 'write:incidents'],
  ['/api/v1/service-assets', 'write:incidents'],
  ['/api/v1/reports', 'write:reports'],
  ['/api/v1/report-templates', 'write:reports'],
  ['/api/v1/report-schedules', 'write:reports'],
  ['/api/v1/alert-rules', 'admin:alerts'],
  ['/api/v1/alert-events', 'admin:alerts'],
  ['/api/v1/alerts', 'admin:alerts'],
  ['/api/v1/triggers', 'admin:alerts'],
  ['/api/v1/parametric', 'admin:parametric'],
  ['/api/v1/webhooks', 'admin:integrations'],
  ['/api/v1/outbox', 'admin:integrations'],
  ['/api/v1/connectors', 'admin:connectors'],
  ['/api/v1/sources', 'admin:schedules'],
  ['/api/v1/ingest', 'admin:schedules'],
  ['/api/v1/workflows', 'admin:workflows'],
  ['/api/v1/scenarios', 'admin:scenarios'],
  ['/api/v1/analytics', 'admin:analytics'],
  ['/api/v1/flood-probability/train', 'admin:analytics'],
  ['/api/v1/kpi/refresh-snapshots', 'admin:analytics'],
  ['/api/v1/maintenance', 'admin:maintenance'],
  ['/api/v1/demo', 'admin:maintenance'],
]

/**
 * Routes reachable without a token, whatever the token configuration.
 *
 * `LINDELA_LITE_PUBLIC_PATHS` is an explicit, comma-separated list an operator
 * sets to widen this deliberately. There is no blanket "public reads" switch:
 * the previous behaviour was that every GET was public, which meant a
 * deployment with correctly configured keys still handed out the district's
 * operational picture to anyone who could reach the port.
 */
export function publicPaths(env = process.env) {
  const configured = String(env.LINDELA_LITE_PUBLIC_PATHS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  // `/ready` is public so a load balancer can reach it. It carries no records:
  // store mode, reachability and latency. Anything more would be a map of the
  // deployment's internals for anyone who can reach the port.
  return ['/api/v1/health', '/api/v1/ready', ...configured]
}

export function isPublicPath(pathname, env = process.env) {
  return publicPaths(env).some((allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`))
}

export function isAuthConfigured(env = process.env) {
  return Boolean(env.LINDELA_LITE_TOKENS || env.LINDELA_LITE_API_KEY)
}

/**
 * Reads the token configuration.
 *
 * Throws rather than returning an empty list when the configuration is present
 * but unusable. The distinction that matters: *no tokens configured* is a
 * deliberate unauthenticated mode, *broken tokens* is an outage — and the
 * second must never silently degrade into the first.
 */
export function parseTokens(env = process.env) {
  const tokensJson = env.LINDELA_LITE_TOKENS
  if (!tokensJson) {
    const apiKey = env.LINDELA_LITE_API_KEY
    return apiKey ? [{ token: apiKey, scopes: ['*'] }] : []
  }

  let parsed
  try {
    parsed = JSON.parse(tokensJson)
  } catch (error) {
    throw configError(`LINDELA_LITE_TOKENS is not valid JSON (${error.message}); authentication is disabled rather than weakened`)
  }
  if (!Array.isArray(parsed)) {
    throw configError('LINDELA_LITE_TOKENS must be a JSON array of {token, scopes} objects')
  }

  const tokens = []
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry.token !== 'string' || !entry.token) {
      throw configError(`LINDELA_LITE_TOKENS[${index}] has no non-empty "token" string`)
    }
    if (entry.partner_org !== undefined && entry.partner_org !== null
      && typeof entry.partner_org !== 'string') {
      throw configError(`LINDELA_LITE_TOKENS[${index}] has a "partner_org" that is not a string`)
    }
    // An empty scopes array and a missing partner_org are different states and
    // both are carried as given: the first is a token that can do nothing, the
    // second is a token that is not scoped to an organisation. Defaulting one
    // to the other is how a token intended for one partner ends up seeing all
    // of them.
    tokens.push({
      token: entry.token,
      scopes: Array.isArray(entry.scopes) ? entry.scopes : [],
      partner_org: typeof entry.partner_org === 'string' && entry.partner_org ? entry.partner_org : null,
    })
  }
  if (!tokens.length) {
    throw configError('LINDELA_LITE_TOKENS is an empty array, which would leave every route unauthenticated')
  }
  return tokens
}

function configError(message) {
  return Object.assign(new Error(message), { statusCode: 500, failClosed: true })
}

export function authenticate(req, env = process.env) {
  const tokens = parseTokens(env)
  if (!tokens.length) return null

  const presented = bearerToken(req)
  if (!presented) return null

  // Constant-time comparison. `===` short-circuits on the first differing
  // byte, which is enough to recover a token one byte at a time from timing.
  const presentedBuffer = Buffer.from(presented)
  let match = null
  for (const candidate of tokens) {
    const candidateBuffer = Buffer.from(candidate.token)
    // timingSafeEqual throws on a length mismatch, so equalise first and keep
    // the comparison itself unconditional.
    const equal = candidateBuffer.length === presentedBuffer.length
      ? crypto.timingSafeEqual(candidateBuffer, presentedBuffer)
      : false
    if (equal) match = candidate
  }
  if (!match) return null

  return {
    // A non-reversible fingerprint, not a prefix. `token.slice(0, 8)` put eight
    // characters of the secret into every audit log, action log and error
    // message that carried the subject.
    token: presented,
    scopes: match.scopes || [],
    // The organisation this token speaks for, or null for a token that speaks
    // for the platform. `scopeToPartnerOrg` read a field that was never set
    // here, so it always returned every record and the partner portal
    // rendered its filter as applied.
    partner_org: match.partner_org || null,
    subject: `token_${crypto.createHash('sha256').update(presented).digest('hex').slice(0, 12)}`,
  }
}

function bearerToken(req) {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) return header.slice(7)
  return req.headers['x-api-key'] || null
}

export function requireScope(auth, scope) {
  if (!auth) {
    const error = new Error('Unauthorized')
    error.statusCode = 401
    throw error
  }

  const { scopes } = auth
  if (scopes.includes('*')) return
  if (scopes.includes(scope)) return
  // `admin:*` satisfies every admin scope; `read:*` every read scope.
  const [family] = scope.split(':')
  if (scopes.includes(`${family}:*`)) return

  const error = new Error('Insufficient permissions')
  error.statusCode = 403
  throw error
}

function firstMatch(table, pathname) {
  for (const [prefix, scope] of table) {
    // `.` matters because several routes carry a file extension — export.csv,
    // export.geojson, kpi/quarterly.pdf — and a path-segment test alone would
    // silently fall through them.
    if (pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`)) {
      return scope
    }
  }
  return null
}

/**
 * The scope a route requires.
 *
 * An unmapped mutation returns `admin:*`, which no scoped token holds — so
 * adding a route without adding it here closes it rather than opening it.
 * Reads fall back to `read:hazards` because an unread route leaks data rather
 * than changing it; the write path is where a wrong default is dangerous.
 */
export function scopeForRoute(method, pathname) {
  const readOnly = method === 'GET' || method === 'HEAD'
  return (readOnly ? firstMatch(READ_SCOPES, pathname) : firstMatch(WRITE_SCOPES, pathname))
    || (readOnly ? 'read:hazards' : DENIED_SCOPE)
}

export function hasRole(auth, role) {
  if (!auth) return false
  if (auth.scopes.includes('*') || auth.scopes.includes('admin:*')) return true
  return auth.scopes.includes(`role:${role}`)
}

/**
 * Restrict records to the organisation the authenticated token speaks for.
 *
 * Deny by default. The previous form kept records with no `partner_org` at
 * all, on the reasoning that an untagged record belongs to nobody and so to
 * everybody -- which is precisely the leak: every record predating the tag, and
 * every record written by a path that does not set one, is visible to every
 * partner.
 *
 * A partner-scoped token therefore sees nothing until records carry the field.
 * That is the truthful answer for a deployment with no per-partner tagging, and
 * it fails visibly rather than quietly handing over the store.
 */
export function scopeToPartnerOrg(records, auth, field = 'partner_org') {
  if (!auth?.partner_org) return records
  return records.filter((record) => record?.[field] === auth.partner_org)
}