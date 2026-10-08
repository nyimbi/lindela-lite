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

/**
 * Read scopes, checked in order; first prefix match wins.
 *
 * Exported so a test can iterate it. It was module-private, which made the
 * deny-by-default rule uncheckable: a route added to `server.js` with no entry
 * here fails closed to `admin:*` and looks like correct behaviour from the
 * outside, so nothing but reading this file would ever notice. A table nobody
 * can iterate is a table nobody maintains.
 */
export const READ_SCOPES = Object.freeze([
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
  // Model governance and financial instruments. These carry no field reports,
  // but they carry what a disbursement is, a risk score is, and whether the
  // models are still calibrated — which is not a hazard-reader's business.
  ['/api/v1/kpi', 'read:analytics'],
  ['/api/v1/equity', 'read:analytics'],
  ['/api/v1/analytics', 'read:analytics'],
  ['/api/v1/model-drift', 'read:analytics'],
  ['/api/v1/data-lineage', 'read:analytics'],
  ['/api/v1/data-quality', 'read:analytics'],
  ['/api/v1/flood-probability', 'read:analytics'],
  ['/api/v1/scenarios', 'read:scenarios'],
  // The audit chain, and the caller's own identity. `read:self` is not a
  // privilege — it names what `/auth-info` returns, which is the caller's own
  // token subject and organisation. Satisfied by any authenticated caller, and
  // only by one: there is nothing in that response another caller could want.
  ['/api/v1/audit', 'read:integrations'],
  ['/api/v1/auth-info', 'read:self'],
  ['/api/v1/districts', 'read:hazards'],
  // The observation and assessment surfaces the console reads. Every one of
  // these was readable by the fallback before, which meant a `read:hazards`
  // token — the narrowest one the platform issues — could read all of them
  // without any of them ever having been classified.
  ['/api/v1/climate', 'read:hazards'],
  ['/api/v1/conflict-risk', 'read:hazards'],
  ['/api/v1/flood-risk', 'read:hazards'],
  ['/api/v1/flood-depth', 'read:hazards'],
  ['/api/v1/food-security', 'read:hazards'],
  ['/api/v1/disease-observations', 'read:hazards'],
  ['/api/v1/events', 'read:hazards'],
  ['/api/v1/assessments', 'read:hazards'],
  ['/api/v1/service-assets', 'read:hazards'],
  ['/api/v1/service-impacts', 'read:hazards'],
  ['/api/v1/impact', 'read:hazards'],
  ['/api/v1/road-access', 'read:hazards'],
  ['/api/v1/routing', 'read:hazards'],
  ['/api/v1/operations', 'read:hazards'],
  // Calibration and model governance, kept out of the hazard scope deliberately.
  ['/api/v1/calibration', 'read:analytics'],
  // Parametric insurance instruments and disbursements: financial, not hazard.
  ['/api/v1/parametric-rules', 'read:parametric'],
  ['/api/v1/parametric-disbursements', 'read:parametric'],
])

/**
 * Write scopes, checked in order; first prefix match wins.
 *
 * Exported for the same reason as `READ_SCOPES`, and it matters more here: a
 * mutating route absent from this list is refused rather than served, so the
 * failure mode is over-restriction rather than a hole — which is exactly why it
 * can go unnoticed until somebody reports that an endpoint they were told
 * existed returns 403 for their own token.
 */
export const WRITE_SCOPES = Object.freeze([
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
  // Field signals. A school attendance observation and a sensor reading are both
  // evidence someone was present somewhere — which is what makes them
  // `write:incidents`-class writes and not an ingest concern the integrations
  // scope covers. A cold-chain reading is a trigger input, so a token that can
  // post one can, by that route, write the evidence a pre-authorised protocol
  // fires on. Gated as a first-class write rather than left to fail closed to
  // `admin:*`, which is correct by default and invisible to every caller.
  ['/api/v1/school-attendance', 'write:incidents'],
  ['/api/v1/iot-observations', 'write:incidents'],
  // Bulk import. It writes to whichever collection the caller names, so it is
  // gated at the level of the collections it can touch rather than given a scope
  // of its own — an import is not a lesser `write:incidents`, it is a
  // `write:incidents` with four thousand rows of it.
  ['/api/v1/upload', 'write:incidents'],
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
  // Two mutating routes that were absent and therefore failed closed to
  // `admin:*`. Not a leak — a `403` to an operator whose token carried every
  // scope the documentation named.
  ['/api/v1/routing', 'admin:workflows'],
  ['/api/v1/equity', 'admin:analytics'],
  // Seven more that no prefix covered. Every one of them already failed closed
  // to `admin:*`, so this is not a hole — it is seven routes that returned 403
  // to a caller holding the scope the documentation told them to hold. They are
  // here because `scopeForRoute` matches on a `/` boundary, so `/api/v1/parametric`
  // does *not* cover `/api/v1/parametric-rules`: that is the safe direction, and
  // it is also why a prefix silently fails to apply and nobody finds out.
  ['/api/v1/parametric-rules', 'admin:parametric'],
  ['/api/v1/trigger-protocols', 'admin:alerts'],
  ['/api/v1/report-distributions', 'write:reports'],
  ['/api/v1/report-schedule-runs', 'write:reports'],
])

/**
 * Every prefix this module knows about, with the scope it maps to.
 *
 * The union of the two tables, for a test that wants to assert something about
 * route coverage without caring which side a path falls on.
 */
export const ROUTE_SCOPES = Object.freeze([
  ...READ_SCOPES.map(([prefix, scope]) => Object.freeze({ prefix, scope, method: 'READ' })),
  ...WRITE_SCOPES.map(([prefix, scope]) => Object.freeze({ prefix, scope, method: 'WRITE' })),
])

/**
 * Routes reachable without a token, whatever the token configuration.
 *
 * `LINDELA_LITE_PUBLIC_PATHS` is an explicit, comma-separated list an operator
 * sets to widen this deliberately. There is no blanket "public reads" switch:
 * the previous behaviour was that every GET was public, which meant a
 * deployment with correctly configured keys still handed out the district's
 * operational picture to anyone who could reach the port.
 */
/**
 * The paths this build decides are public, and how each is matched.
 *
 * `/ready` is public so a load balancer can reach it. It carries no records:
 * store mode, reachability and latency. Anything more would be a map of the
 * deployment's internals for anyone who can reach the port.
 *
 * The two matching rules are separate because R-15 lived in the difference
 * between them. Everything was prefix-matched, so `/api/v1/health/anything` was
 * public too — a path that 404s, but only *after* the request had been
 * authenticated-or-not and, on a public path, handed a full-table read. An
 * unauthenticated read amplifier with a 404 at the end of it.
 *
 * So: the paths this file ships with are matched exactly, and only an
 * operator's own entries — who wrote them knowing what they are publishing —
 * get prefix semantics. A prefix under a shipped path is the one thing a
 * deployment can still opt into, and only by naming it.
 */
const SHIPPED_PUBLIC_PATHS = Object.freeze(['/api/v1/health', '/api/v1/ready'])

export function publicPaths(env = process.env) {
  const configured = String(env.LINDELA_LITE_PUBLIC_PATHS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...SHIPPED_PUBLIC_PATHS, ...configured]
}

/**
 * Does this path answer without a token?
 *
 * Exact for the shipped paths, prefix for the operator's. Returns false for
 * anything under a shipped path that is not the path itself, which is what
 * sends `/api/v1/health/anything` to the auth gate instead of to a store read.
 */
export function isPublicPath(pathname, env = process.env) {
  if (SHIPPED_PUBLIC_PATHS.includes(pathname)) return true
  const configured = publicPaths(env).filter((allowed) => !SHIPPED_PUBLIC_PATHS.includes(allowed))
  return configured.some((allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`))
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
  // `read:self` names a response that can only describe the caller — their own
  // token subject and organisation. Requiring a scope for it would be
  // theatre: holding no scopes at all would still be allowed, because the
  // content is the caller's own.
  if (scope === 'read:self') return
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
 * An unmapped route returns `admin:*`, which no scoped token holds — so adding a
 * route without adding it here closes it rather than opening it.
 *
 * **Reads used to fall back to `read:hazards` instead**, on the reasoning that
 * "an unread route leaks data rather than changing it" and the write path is
 * where a wrong default is dangerous. That is inverted. For a read, the leak
 * *is* the harm — it is the only harm — and `read:hazards` is a real,
 * routinely-issued scope: the one the project's own roadmap names first, and the
 * one `test/auth-deny-by-default.test.js` issues its own test token with.
 *
 * So every unmapped read was readable by the narrowest legitimate scope across
 * the institutional KPI report, the equity tables, the model-governance
 * endpoints, parametric disbursements, trigger protocol configuration and the
 * audit chain — about twenty routes, none of them named in the table.
 *
 * The cost of the correct default is a 403 on a newly-added read route until it
 * is classified. That is the same failure the write table has always accepted,
 * and `test/route-scope-coverage.test.js` enumerates mutating routes from
 * `server.js` and fails the build when one is missing, so the cost is caught
 * rather than paid.
 */
export function scopeForRoute(method, pathname) {
  const readOnly = method === 'GET' || method === 'HEAD'
  return (readOnly ? firstMatch(READ_SCOPES, pathname) : firstMatch(WRITE_SCOPES, pathname)) || DENIED_SCOPE
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