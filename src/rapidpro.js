import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { logger } from './observability.js'
import { stableId, toNumber } from './utils.js'

const DEFAULT_BASE_URL = 'https://rapidpro.io/api/v2'
const DEFAULT_REQUEST_TIMEOUT_MS = 10000
const HEX_DIGEST = /^[0-9a-f]{64}$/i
const TEL_PREFIX = 'tel:'
const UNCONFIGURED_SECRET_MESSAGE = 'RAPIDPRO_WEBHOOK_SECRET is not configured, so the RapidPro field-report webhook cannot authenticate any caller. Set the secret, or set LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED=1 to accept unsigned webhooks on a local development machine.'

let warnedUnconfiguredSecret = false

export function rapidProStatus(env = process.env) {
  return {
    enabled: Boolean(env.RAPIDPRO_API_TOKEN),
    base_url: normalizeBaseUrl(env.RAPIDPRO_BASE_URL || DEFAULT_BASE_URL),
    has_token: Boolean(env.RAPIDPRO_API_TOKEN),
    alert_mode: env.RAPIDPRO_ALERT_MODE || (env.RAPIDPRO_ALERT_FLOW_UUID ? 'flow_start' : 'broadcast'),
    has_alert_flow: Boolean(env.RAPIDPRO_ALERT_FLOW_UUID),
    default_urns: splitList(env.RAPIDPRO_ALERT_URNS).length,
    default_contacts: splitList(env.RAPIDPRO_ALERT_CONTACTS).length,
    default_groups: splitList(env.RAPIDPRO_ALERT_GROUPS).length,
    inbound_webhook_protected: Boolean(env.RAPIDPRO_WEBHOOK_SECRET),
    // An unsigned inbound is a deliberate local-development choice, so it gets
    // its own flag rather than hiding behind inbound_webhook_protected: false.
    inbound_webhook_secure: Boolean(env.RAPIDPRO_WEBHOOK_SECRET) || !allowUnsignedInbound(env),
    inbound_webhook_unsigned_allowed: !env.RAPIDPRO_WEBHOOK_SECRET && allowUnsignedInbound(env),
  }
}

export async function sendRapidProAlert(alert, options = {}, env = process.env) {
  const config = rapidProConfig(env)
  const recipients = normalizeRecipients(options, env)
  const message = formatAlertMessage(alert, options.text)
  const mode = options.mode || config.alertMode
  const request = buildRapidProRequest(mode, config, recipients, alert, message, options)
  const queuedAt = new Date().toISOString()
  const startedAt = queuedAt

  try {
    const { response, responseBody } = await dispatchToRapidPro(request.url, config, request.body, env)
    const sentAt = new Date().toISOString()
    const dispatch = rapidProDispatchRecord({
      alert,
      mode,
      message,
      recipients,
      request,
      response,
      responseBody,
      startedAt,
      queuedAt,
      sentAt,
      matchedSignalId: options.matched_signal_id || null,
      matchedSignalAt: options.matched_signal_at || null,
    })
    if (!response.ok) {
      dispatch.status = 'failed'
      dispatch.error = responseBody?.detail || responseBody?.error || `RapidPro HTTP ${response.status}`
    }
    return dispatch
  } catch (error) {
    return rapidProDispatchRecord({
      alert,
      mode,
      message,
      recipients,
      request,
      startedAt,
      queuedAt,
      sentAt: null,
      matchedSignalId: options.matched_signal_id || null,
      matchedSignalAt: options.matched_signal_at || null,
      error,
    })
  }
}

export async function sendRapidProReportSummary(report, summary, options = {}, env = process.env) {
  const alert = {
    id: report.id,
    rule_name: report.title,
    severity: report.warnings?.length ? 'medium' : 'low',
    message: summary,
    metric: 'report.summary',
    value: report.source_refs?.length || 0,
    threshold: null,
    operator: null,
  }
  const dispatch = await sendRapidProAlert(alert, {
    ...options,
    text: summary,
    params: {
      report_id: report.id,
      report_type: report.report_type,
      report_status: report.status,
      ...(options.params || {}),
    },
  }, env)
  return { ...dispatch, report_id: report.id }
}

export function parseRapidProFieldReport(payload = {}, data = null) {
  const text = String(payload.content || payload.text || payload.input?.text || payload.message?.text || '').trim()
  const from = normalizeSender(payload.from || payload.urn || payload.contact?.urn || payload.urns?.tel || payload.urns?.[0])
  const contact = payload.contact || {}
  const parsed = parseReportText(text)
  const observedAt = payload.observed_at || payload.created_on || payload.created_at || new Date().toISOString()
  const sourceId = payload.id || payload.uuid || payload.run?.uuid || payload.message?.uuid || stableId('rapidpro_payload', [from, text, observedAt])

  let alertEventId = payload.alert_event_id
  let dispatchId = null

  if (!alertEventId && data && from) {
    const now = new Date().getTime()
    const twentyFourHoursMs = 24 * 60 * 60 * 1000
    const recentDispatches = (data.rapidpro_dispatches || []).filter((dispatch) => {
      if (!dispatch.created_at) return false
      const dispatchTime = new Date(dispatch.created_at).getTime()
      return now - dispatchTime <= twentyFourHoursMs
    })

    for (const dispatch of recentDispatches) {
      if (dispatch.recipients?.urns?.includes(from) || dispatch.recipients?.urns?.some((urn) => urn.endsWith(from))) {
        dispatchId = dispatch.id
        alertEventId = dispatch.alert_event_id
        break
      }
    }
  }

  return {
    inbound: {
      id: stableId('rapidpro_inbound', [sourceId, from, text]),
      provider: 'rapidpro',
      source_id: sourceId,
      direction: 'incoming',
      from,
      contact_uuid: contact.uuid || payload.contact_uuid || null,
      contact_name: contact.name || payload.contact_name || null,
      text,
      status: 'processed',
      alert_event_id: alertEventId || null,
      dispatch_id: dispatchId || null,
      created_at: new Date().toISOString(),
      payload,
    },
    report: {
      incident_id: payload.incident_id || parsed.incident_id || null,
      intervention_id: payload.intervention_id || parsed.intervention_id || null,
      summary: payload.summary || parsed.summary || text || 'RapidPro field report',
      reported_by: payload.reported_by || contact.name || from || 'rapidpro',
      observed_at: observedAt,
      needs: payload.needs || parsed.needs,
      latitude: toNumber(payload.latitude ?? payload.lat ?? parsed.latitude),
      longitude: toNumber(payload.longitude ?? payload.lon ?? payload.lng ?? parsed.longitude),
      alert_event_id: alertEventId || null,
      metadata: {
        provider: 'rapidpro',
        source_id: sourceId,
        from,
        flow_uuid: payload.flow?.uuid || payload.flow_uuid || null,
        run_uuid: payload.run?.uuid || payload.run_uuid || null,
      },
    },
    fallbackIncident: {
      title: `RapidPro field report from ${from || contact.name || 'unknown sender'}`,
      incident_type: 'rapidpro_field_report',
      priority: 'medium',
      source: 'rapidpro',
      description: text,
      latitude: toNumber(payload.latitude ?? payload.lat ?? parsed.latitude),
      longitude: toNumber(payload.longitude ?? payload.lon ?? payload.lng ?? parsed.longitude),
      occurred_at: observedAt,
      metadata: {
        provider: 'rapidpro',
        source_id: sourceId,
        from,
      },
    },
  }
}

export function responseMetrics(data) {
  const dispatches = data.rapidpro_dispatches || []
  const inbounds = data.rapidpro_inbound_messages || []
  const result = {}

  for (const dispatch of dispatches) {
    const alertEventId = dispatch.alert_event_id
    if (!alertEventId) continue
    if (!result[alertEventId]) {
      result[alertEventId] = {
        alert_event_id: alertEventId,
        dispatched_count: 0,
        // Distinct responders, not inbound messages. See below.
        response_count: 0,
        response_rate_pct: null,
        first_response_at: null,
        mean_response_seconds: 0,
        responders: new Set(),
        dispatchedTo: new Set(),
        identity_available: true,
        undispatched_responders: new Set(),
      }
    }
    result[alertEventId].dispatched_count++
    // A dispatch with no sender identity means there is nothing to match a
    // reply against; the rate becomes uncomputable rather than a message
    // count wearing a percentage sign.
    const recipient = dispatch.from || dispatch.contact_uuid
    if (recipient) result[alertEventId].dispatchedTo.add(recipient)
    else result[alertEventId].identity_available = false
  }

  // Inbound messages are not replies. One CHW can answer the same alert twice,
  // and a RapidPro flow can emit several messages per answer, so counting
  // messages against dispatches yields a "rate" above 100 — which is how one
  // dispatch and two messages produced 200%. Deduplicate on the sender and
  // count distinct people who replied.
  for (const inbound of inbounds) {
    const alertEventId = inbound.alert_event_id
    if (!alertEventId || !result[alertEventId]) continue
    const responder = inbound.from || inbound.contact_uuid || inbound.contact_name || inbound.id
    const metrics = result[alertEventId]
    // Only people we actually alerted count toward the rate. A reply from
    // someone who was never dispatched to is real and worth reporting, but
    // counting them in the numerator drove the rate above 100% — a percentage
    // that has stopped being a percentage.
    if (metrics.dispatchedTo.has(responder)) {
      if (!metrics.responders.has(responder)) {
        metrics.responders.add(responder)
        metrics.response_count++
      }
    } else if (!metrics.identity_available) {
      // No identities to match on, so count the messages and say so.
      metrics.response_count++
    } else {
      metrics.undispatched_responders.add(responder)
    }
    if (!result[alertEventId].first_response_at || new Date(inbound.created_at) < new Date(result[alertEventId].first_response_at)) {
      result[alertEventId].first_response_at = inbound.created_at
    }
  }

  for (const alertEventId in result) {
    const metrics = result[alertEventId]
    // A dispatch nobody has answered yet is not a failure and not a success.
    // `null` says the question is still open; 0 would report silence as a
    // measured outcome.
    // null when nobody has answered yet. A dispatch with no reply is an open
    // question, not a measured 0% — the same conflation the alert model refuses
    // elsewhere with `false_alert: null`.
    metrics.response_rate_pct = metrics.response_count > 0 && metrics.identity_available
      ? Math.round((metrics.response_count / metrics.dispatched_count) * 10000) / 100
      : null
    if (!metrics.identity_available) {
      metrics.response_rate_note = 'dispatches carry no recipient identity, so replies cannot be matched to people; response_count is a count of inbound messages, not a rate'
    }
    metrics.undispatched_response_count = metrics.undispatched_responders.size
    delete metrics.responders
    delete metrics.dispatchedTo
    delete metrics.undispatched_responders
    if (metrics.response_count > 0 && metrics.first_response_at) {
      const dispatchTimes = dispatches
        .filter((d) => d.alert_event_id === alertEventId)
        .map((d) => new Date(d.created_at).getTime())
      const earliestDispatch = Math.min(...dispatchTimes)
      const firstResponseTime = new Date(metrics.first_response_at).getTime()
      metrics.mean_response_seconds = Math.round((firstResponseTime - earliestDispatch) / 1000)
    }
  }

  return Object.values(result)
}

/**
 * Guard for POST /api/v1/rapidpro/field-report, which writes records.
 *
 * Two credentials are accepted, in this order:
 *   - `x-rapidpro-signature`: hex HMAC-SHA256 of the raw request body, keyed
 *     with RAPIDPRO_WEBHOOK_SECRET. Covers the bytes, so it detects a tampered
 *     body as well as a wrong caller. Requires the caller to have buffered the
 *     raw body onto `req.rawBody` first; without it this fails closed.
 *   - the shared secret in `x-rapidpro-secret`, `x-lindela-rapidpro-secret`, a
 *     Bearer token, or `?secret=` — what RapidPro itself sends.
 *
 * An absent secret is NOT the same as a correct one. It throws a 503 naming the
 * operator problem rather than returning true, so a deployment that believes it
 * is protected fails loudly instead of quietly accepting every caller. The only
 * way to opt out is LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED=1, which
 * someone has to write down on purpose.
 *
 * Every rejection returns the same false so the caller cannot leak which of
 * "no signature", "malformed signature" and "wrong signature" applied.
 */
export function verifyRapidProWebhook(req, url, env = process.env) {
  const secret = env.RAPIDPRO_WEBHOOK_SECRET
  if (!secret) {
    if (allowUnsignedInbound(env)) return true
    // Say it once. Every rejected caller is an operator symptom, not a new
    // fact, and an unbounded logger is a log-flood lever pointed at ourselves.
    if (!warnedUnconfiguredSecret) {
      warnedUnconfiguredSecret = true
      logger.error('rapidpro_webhook_secret_unconfigured', {
        message: UNCONFIGURED_SECRET_MESSAGE,
      })
    }
    throw Object.assign(new Error(UNCONFIGURED_SECRET_MESSAGE), { statusCode: 503 })
  }

  const signature = signatureHeader(req.headers)
  if (signature !== null) return verifyBodySignature(signature, req.rawBody, secret)

  const provided = req.headers['x-rapidpro-secret']
    || req.headers['x-lindela-rapidpro-secret']
    || bearerToken(req.headers.authorization)
    || url.searchParams.get('secret')
  return constantTimeEquals(provided, secret)
}

/** The opt-out is deliberately narrow: exactly `1`, never truthy. */
function allowUnsignedInbound(env) {
  return env.LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED === '1'
}

function signatureHeader(headers) {
  const raw = headers['x-rapidpro-signature'] ?? headers['x-lindela-rapidpro-signature']
  if (raw === undefined || raw === null || raw === '') return null
  return String(raw).trim()
}

function verifyBodySignature(signature, rawBody, secret) {
  const hex = signature.replace(/^sha256=/i, '')
  if (!HEX_DIGEST.test(hex)) return false
  // Fail closed: a signature we cannot recompute over the exact bytes received
  // is not a signature, and guessing that it was fine is the bug this replaces.
  if (rawBody === undefined || rawBody === null) return false
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
  const expected = createHmac('sha256', secret).update(body).digest()
  return constantTimeEquals(Buffer.from(hex, 'hex'), expected)
}

/**
 * Constant-time equality over equal-length digests. timingSafeEqual throws on a
 * length mismatch, so both sides are hashed first: the secret's length is not
 * something a caller gets to probe one byte at a time, and the compare cannot
 * take the exception path instead of the comparison path.
 */
function constantTimeEquals(a, b) {
  const left = digestOf(a)
  const right = digestOf(b)
  if (!left || !right) return false
  return timingSafeEqual(left, right)
}

function digestOf(value) {
  if (value === undefined || value === null || value === '') return null
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return createHash('sha256').update(bytes).digest()
}

/**
 * One deadline across connect, headers and body. RapidPro stalling is an
 * ordinary outage, and the caller needs a dispatch record either way — an
 * unbounded fetch would hang the request that triggered the alert instead.
 */
async function dispatchToRapidPro(url, config, body, env) {
  const timeoutMs = Number(env.RAPIDPRO_REQUEST_TIMEOUT_MS) > 0
    ? Number(env.RAPIDPRO_REQUEST_TIMEOUT_MS)
    : DEFAULT_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(Object.assign(new Error(`RapidPro request timed out after ${timeoutMs}ms`), { statusCode: 504 }))
  }, timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Token ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return { response, responseBody: await readResponseBody(response) }
  } finally {
    clearTimeout(timer)
  }
}

function rapidProConfig(env) {
  const token = env.RAPIDPRO_API_TOKEN
  if (!token) throw Object.assign(new Error('RAPIDPRO_API_TOKEN is required'), { statusCode: 400 })
  return {
    token,
    baseUrl: normalizeBaseUrl(env.RAPIDPRO_BASE_URL || DEFAULT_BASE_URL),
    alertFlowUuid: env.RAPIDPRO_ALERT_FLOW_UUID || null,
    baseLanguage: env.RAPIDPRO_BASE_LANGUAGE || 'eng',
    alertMode: env.RAPIDPRO_ALERT_MODE || (env.RAPIDPRO_ALERT_FLOW_UUID ? 'flow_start' : 'broadcast'),
  }
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return trimmed.endsWith('/api/v2') ? trimmed : `${trimmed}/api/v2`
}

function normalizeRecipients(options, env) {
  const urns = splitList(options.urns || env.RAPIDPRO_ALERT_URNS).map(formatUrn)
  const contacts = splitList(options.contacts || env.RAPIDPRO_ALERT_CONTACTS)
  const groups = splitList(options.groups || env.RAPIDPRO_ALERT_GROUPS)
  if (!urns.length && !contacts.length && !groups.length) {
    throw Object.assign(new Error('At least one RapidPro urn, contact, or group is required'), { statusCode: 400 })
  }
  return { urns, contacts, groups }
}

function buildRapidProRequest(mode, config, recipients, alert, message, options) {
  if (mode === 'flow_start') {
    const flow = options.flow || config.alertFlowUuid
    if (!flow) throw Object.assign(new Error('RapidPro flow_start mode requires RAPIDPRO_ALERT_FLOW_UUID or body.flow'), { statusCode: 400 })
    return {
      url: `${config.baseUrl}/flow_starts.json`,
      body: {
        flow,
        urns: recipients.urns,
        contacts: recipients.contacts,
        groups: recipients.groups,
        restart_participants: options.restart_participants ?? true,
        exclude_active: options.exclude_active ?? false,
        params: {
          alert_id: alert.id,
          rule_name: alert.rule_name,
          severity: alert.severity,
          message,
          metric: alert.metric,
          value: alert.value,
          threshold: alert.threshold,
          operator: alert.operator,
          ...(options.params || {}),
        },
      },
    }
  }

  if (mode === 'broadcast') {
    return {
      url: `${config.baseUrl}/broadcasts.json`,
      body: {
        urns: recipients.urns,
        contacts: recipients.contacts,
        groups: recipients.groups,
        text: { [config.baseLanguage]: message },
        base_language: config.baseLanguage,
      },
    }
  }

  throw Object.assign(new Error('mode must be flow_start or broadcast'), { statusCode: 400 })
}

function rapidProDispatchRecord({ alert, mode, message, recipients, request, response = null, responseBody = null, startedAt, queuedAt = null, sentAt = null, matchedSignalId = null, matchedSignalAt = null, error = null }) {
  const status = error ? 'failed' : 'sent'
  return {
    id: stableId('rapidpro_dispatch', [alert.id, mode, recipients, startedAt]),
    provider: 'rapidpro',
    alert_event_id: alert.id,
    status,
    mode,
    message,
    recipients,
    endpoint: request?.url || null,
    request_body: request?.body || null,
    response_status: response?.status || null,
    response_body: responseBody,
    error: error?.message || null,
    queued_at: queuedAt || startedAt,
    sent_at: sentAt || (error ? null : new Date().toISOString()),
    matched_signal_id: matchedSignalId,
    matched_signal_at: matchedSignalAt,
    created_at: startedAt,
    updated_at: new Date().toISOString(),
  }
}

function formatAlertMessage(alert, override) {
  const text = override || alert.message || `${alert.rule_name || 'Lindela alert'} ${alert.metric || ''} ${alert.operator || ''} ${alert.threshold ?? ''}`
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 480)
}

function parseReportText(text) {
  const incident = text.match(/\bincident_[a-f0-9]+\b/i)?.[0]
  const intervention = text.match(/\bintervention_[a-f0-9]+\b/i)?.[0]
  const coords = text.match(/\b(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\b/)
  const needsMatch = text.match(/\bneeds?\s*:\s*([^|;]+)/i)
  const needs = needsMatch
    ? needsMatch[1]
      .replace(/\b(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\b/g, '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    : []
  const summary = text
    .replace(/^report\s+/i, '')
    .replace(/\bincident_[a-f0-9]+\b/ig, '')
    .replace(/\bintervention_[a-f0-9]+\b/ig, '')
    .replace(/\bneeds?\s*:\s*([^|;]+)/ig, '')
    .replace(/\b(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    incident_id: incident || null,
    intervention_id: intervention || null,
    latitude: coords ? Number(coords[1]) : null,
    longitude: coords ? Number(coords[2]) : null,
    needs,
    summary,
  }
}

function splitList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean)
  return String(value).split(',').map((item) => item.trim()).filter(Boolean)
}

function formatUrn(value) {
  const text = String(value).trim()
  if (text.includes(':')) return text
  return `${TEL_PREFIX}${text.startsWith('+') ? text : `+${text}`}`
}

function normalizeSender(value) {
  if (!value) return null
  const text = Array.isArray(value) ? value[0] : String(value)
  return text.startsWith(TEL_PREFIX) ? text.slice(TEL_PREFIX.length) : text
}

async function readResponseBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function bearerToken(value) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

/* ---------------------------------------------------------------------------
 * ENH-26 — two-way SMS: acknowledgement, escalation, delivery tracking.
 *
 * Everything above is one-way. An alert leaves the platform and the platform
 * never learns whether it arrived, was understood, or provoked a reply, which
 * is why "dispatch" here meant "broadcast". This section is the return path.
 *
 * Two things constrain every design decision below, and they pull against each
 * other often enough to be worth stating once:
 *
 *   A responder's silence is not evidence of absence. In a district with one
 *   working phone and a two-hour charge cycle, "no ACK" means nothing. So the
 *   default answer to silence is *not* escalation — it is "awaiting", and the
 *   only thing that produces an escalation is a deadline computed against an
 *   explicitly stated SLA, an unparseable-but-present reply counted as
 *   response, and an escalation that has not already fired for that person.
 *
 *   A delivery record that overstates delivery is worse than none. "sent" means
 *   RapidPro accepted the request, not that a handset received it, and this
 *   module never upgrades `sent` on the strength of an HTTP 200 alone — a
 *   carrier DLR is a separate signal and is recorded separately.
 * ------------------------------------------------------------------------- */

/** Reply verbs, in the order they appear in the instructions we send. */
export const REPLY_VERBS = Object.freeze(['ACK', 'ESCALATE', 'RESOLVED', 'NAK'])

/**
 * Reason codes. A closed set on purpose: an open one lets a typo or a synonym
 * become a category, and a category nobody audits is a category nobody reads.
 * An unrecognised code is preserved as `reason_raw` with `reason_code: null` —
 * recorded, not invented.
 */
export const REPLY_REASON_CODES = Object.freeze([
  'blocked',
  'no_access',
  'need_more_info',
  'in_progress',
  'already_handled',
  'false_alert',
  'unsafe',
  'other',
])

/** Terminal for the acknowledgement SLA: no further escalation is owed. */
const ACKNOWLEDGED_STATES = Object.freeze(['acknowledged', 'resolved', 'escalated_by_responder'])

const DEFAULT_SLA_MINUTES = Object.freeze({ critical: 15, high: 30, medium: 60, low: 120 })
const DEFAULT_SLA_MINUTES_UNKNOWN_SEVERITY = 60

// Anchored at the start and whole-token: "ACK" in a sentence ("the river road is
// blocked, ACK the barrier") is not an acknowledgement, and treating it as one
// would silently cancel a real escalation window. Free text after the verb is
// kept as a note rather than discarded — "ACK need water at Baringo" is the most
// useful thing a CHW will ever send us.
const REPLY_PATTERN = /^\s*[>*\-]?\s*(ACK|ESCALATE|RESOLVED|NAK)\b[\s:|-]*(.*)$/i

/**
 * Parses a structured reply.
 *
 * Returns `verb: null` for anything that is not an anchored verb, and that is a
 * meaningful result rather than a failure: an unrecognised reply is still a
 * reply, and the caller counts it as *someone responded* (see
 * `dueEscalations`) even though it does not close the acknowledgement.
 */
export function parseReplyVerb(text) {
  const raw = String(text ?? '').trim()
  const match = raw.match(REPLY_PATTERN)
  if (!match) return { verb: null, reason_code: null, reason_raw: null, note: raw, recognised: false }

  const verb = match[1].toUpperCase()
  const rest = (match[2] || '').trim()

  // A reason code is a single lowercase token, optionally introduced by
  // "reason:" — anything longer is prose, and reading prose as a code is how
  // "no access to the ford" becomes reason_code "no".
  const codeMatch = rest.match(/^(?:reason\s*[:=]\s*)?([A-Za-z_]+)\b[\s,:-]*(.*)$/)
  const candidate = codeMatch ? codeMatch[1].toLowerCase() : null
  const recognisedCode = candidate && REPLY_REASON_CODES.includes(candidate)
  const note = recognisedCode
    ? (codeMatch?.[2] || '').trim()
    : (codeMatch ? `${candidate}${(codeMatch[2] || '').trim() ? ` ${codeMatch[2]}`.trimEnd() : ''}` : rest)

  return {
    verb,
    reason_code: recognisedCode ? candidate : null,
    // Nothing was consumed as a code when the code was not recognised, so the
    // whole remainder is preserved verbatim. Slicing "knee-deep" down to "knee"
    // would invent a category and lose the hyphen the CHW actually typed.
    reason_raw: recognisedCode ? null : (rest || null),
    note: note || null,
    recognised: true,
  }
}

/**
 * The suffix appended to an outbound alert so the reply grammar is discoverable.
 *
 * A grammar nobody was told about is not a two-way channel, it is a guessing
 * game. Kept short because `formatAlertMessage` truncates at 480 characters and
 * a truncated instruction is no instruction at all.
 */
export function ackInstructions(alert, options = {}, env = process.env) {
  const slaMinutes = ackSlaMinutes(alert.severity, env)
  const code = options.reply_code ? null : stableId('reply', [alert.id, slaMinutes]).slice(-6)
  return ` Reply ${REPLY_VERBS.join('/')} <reason>${code ? ` (code ${code})` : ''}.`
    + ` We escalate if we hear nothing for ${slaMinutes} min.`
}

/** Appends the reply grammar within the 480-character budget `formatAlertMessage` enforces. */
export function withAckInstructions(text, alert, options = {}, env = process.env) {
  const body = String(text || '').replace(/\s+/g, ' ').trim()
  const suffix = ackInstructions(alert, options, env)
  const room = 480 - suffix.length
  return `${body.slice(0, Math.max(0, room))}${suffix}`
}

/**
 * Acknowledgement SLA in minutes, by severity.
 *
 * `RAPIDPRO_ACK_SLA_MINUTES` overrides everything, for deployments where the
 * severity defaults are wrong. Escalation is computed from this number, so an
 * unset SLA is not a neutral default — it is a false-alarm generator, which is
 * why it resolves to an explicit value per severity rather than to nothing.
 */
export function ackSlaMinutes(severity, env = process.env) {
  const override = Number(env.RAPIDPRO_ACK_SLA_MINUTES)
  if (Number.isFinite(override) && override > 0) return Math.round(override)
  const key = String(severity || '').toLowerCase()
  return DEFAULT_SLA_MINUTES[key] ?? DEFAULT_SLA_MINUTES_UNKNOWN_SEVERITY
}

/** Where an escalation goes. Empty is reported as unresolved, never as "paged". */
export function escalationTargets(severity, env = process.env) {
  const explicit = splitList(env[`RAPIDPRO_ESCALATION_URNS_${String(severity || '').toUpperCase()}`] || env.RAPIDPRO_ESCALATION_URNS)
  return explicit.map(formatUrn)
}

/** A dispatch is only a candidate for escalation if the gateway actually took it. */
function dispatchAccepted(dispatch) {
  return dispatch?.status === 'sent' && !dispatch.error && Number(dispatch.response_status || 0) < 400
}

/** Normalises a sender to a comparable form: `tel:+2547…`, `2547…`, `+2547…` all match. */
function senderKey(value) {
  if (!value) return null
  const text = String(value).trim().replace(/^tel:/i, '')
  const digits = text.replace(/[^\d]/g, '')
  return digits ? `+${digits.replace(/^0+/, '')}` || '+0' : null
}

/**
 * Recipients a dispatch named, keeping the ones we cannot key.
 *
 * Dropping an address with no comparable form would make it vanish from the
 * delivery report entirely, and an invisible recipient is indistinguishable
 * from one that was never contacted. It stays, marked `unidentified`, so the
 * report says "we could not track this one" rather than implying a smaller
 * dispatch than actually went out.
 */
function dispatchRecipients(dispatch) {
  return (dispatch?.recipients?.urns || []).map((urn) => ({ urn, key: senderKey(urn) }))
}

/**
 * Correlates a reply to the alert it answers.
 *
 * Explicit ids win, because RapidPro can echo a flow param back and that is
 * exact. Failing that, the sender is matched against the dispatches for that
 * address inside a window. The window is the fragile part — it is bounded so a
 * number reassigned six months later cannot inherit a year-old alert — and it
 * returns `null` rather than a best guess when nothing matches, because a reply
 * attached to the wrong alert closes the wrong SLA.
 */
export function correlateReply(payload = {}, data = null, options = {}) {
  const { windowHours = 24, now = new Date().toISOString() } = options
  const from = normalizeSender(payload.from || payload.urn || payload.contact?.urn || payload.urns?.tel)
  const key = senderKey(from)
  let alertEventId = payload.alert_event_id || null
  let dispatchId = payload.dispatch_id || null

  if (!alertEventId && data && key) {
    const nowMs = Date.parse(now)
    const windowMs = windowHours * 60 * 60 * 1000
    const candidates = (data.rapidpro_dispatches || [])
      .filter((dispatch) => dispatch.created_at && (Number.isNaN(nowMs) || nowMs - Date.parse(dispatch.created_at) <= windowMs))
      .filter((dispatch) => dispatchRecipients(dispatch).some((recipient) => recipient.key === key))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    if (candidates.length) {
      dispatchId = candidates[0].id
      alertEventId = candidates[0].alert_event_id
    }
  }

  return {
    alert_event_id: alertEventId || null,
    dispatch_id: dispatchId || null,
    from: from || null,
    sender_key: key,
    correlated: Boolean(alertEventId),
    correlation_note: alertEventId
      ? null
      : 'no dispatch matched this sender inside the correlation window; the reply is recorded but closes no SLA',
  }
}

/**
 * Idempotency gate for inbound messages (ALERT-06).
 *
 * RapidPro retries a webhook it believes was not acknowledged, and a flow can
 * emit more than one message per answer. Re-processing a retry would either
 * duplicate a field report or re-apply an acknowledgement, and the second is
 * worse than the first: it would restamp `acknowledged_at` and destroy the
 * latency figure an operator is judging the response process on.
 *
 * The id is `stableId('rapidpro_inbound', [source_id, from, text])` — the same
 * shape `parseRapidProFieldReport` uses, so a retry of a reply and a retry of a
 * field report dedupe against each other rather than in isolation.
 */
export function reconcileInbound(data, parsed) {
  const inbound = { ...parsed, id: stableId('rapidpro_inbound', [parsed.source_id, parsed.from, parsed.text]) }
  const existing = (data?.rapidpro_inbound_messages || []).find((message) => message.id === inbound.id)
  if (existing) {
    return { inbound: existing, duplicate: true, applied: false, reason: 'inbound already recorded under this id' }
  }
  return { inbound, duplicate: false, applied: true }
}

/**
 * Acknowledgement state for one recipient of one dispatch.
 *
 * This is the unit an operator reads. It reports what is known, in the product's
 * own idiom: an absence of information is `null` or an explicit
 * `unavailable`, never a value that reads like a measurement. The delivery
 * status stops at `accepted` — the last thing this system can honestly say about
 * a handset is that RapidPro took the message, and a carrier delivery receipt is
 * a separate signal that has not arrived here.
 */
export function recipientStatus(dispatch, recipient, replies = []) {
  const base = {
    urn: recipient.urn,
    dispatch_id: dispatch.id,
    alert_event_id: dispatch.alert_event_id,
    dispatched_at: dispatch.created_at,
    delivery_status: dispatchAccepted(dispatch) ? 'accepted_by_gateway' : 'not_dispatched',
    // RapidPro does not hand back per-recipient delivery receipts through the
    // v2 API this product uses. Recording the absence is the point: a field
    // reading "delivered" would be a claim nobody can support.
    delivery_receipt: null,
    ack_status: 'awaiting',
    ack_at: null,
    verb: null,
    reason_code: null,
    responded_at: null,
    note: null,
  }

  if (!recipient.key) {
    return { ...base, ack_status: 'unidentified', note: 'dispatch carried no recipient identity; this alert cannot be tracked per person' }
  }
  if (!dispatchAccepted(dispatch)) {
    return { ...base, ack_status: 'not_dispatched', note: dispatch.error || 'RapidPro did not accept this dispatch' }
  }

  const dispatchedAtMs = Date.parse(dispatch.created_at)
  const mine = replies
    .filter((reply) => senderKey(reply.from) === recipient.key)
    // A stale inbox row from the same number — the address was reassigned, or a
    // previous month's alert is still in the collection — would otherwise
    // suppress every future escalation for that person, permanently. Silence
    // after a dispatch is what counts, so the reply has to be after it.
    .filter((reply) => {
      const at = Date.parse(reply.received_at || 0)
      return Number.isNaN(dispatchedAtMs) || Number.isNaN(at) || at >= dispatchedAtMs
    })
    .sort((a, b) => Date.parse(a.received_at || 0) - Date.parse(b.received_at || 0))

  // A reply already stamped on the dispatch wins over a rescan: the record of
  // when the operator's phone rang is more authoritative than a recomputation
  // over inbound messages that may since have been retained out.
  const stamped = dispatch.acknowledgements?.[recipient.key] || null

  const recognised = mine.find((reply) => reply.verb)
  const any = mine[0] || null

  if (!any && !stamped) return base

  const source = stamped || {}
  const verb = source.verb ?? recognised?.verb ?? null
  const at = source.ack_at ?? any?.received_at ?? null

  return {
    ...base,
    ack_status: ackStatusForVerb(verb, Boolean(any || source.ack_at)),
    ack_at: at,
    verb: verb,
    reason_code: source.reason_code ?? recognised?.reason_code ?? null,
    responded_at: any?.received_at ?? null,
    // The distinction that keeps false escalations down: a CHW who wrote
    // "on my way" has responded. Failing to recognise the word is a vocabulary
    // problem, and paging their supervisor over it is ours.
    note: verb ? source.note ?? recognised?.note ?? null : 'responded, but without a recognised reply verb; counted as response, not as acknowledgement',
  }
}

function ackStatusForVerb(verb, responded) {
  if (!responded) return 'awaiting'
  if (verb === 'ACK') return 'acknowledged'
  if (verb === 'RESOLVED') return 'resolved'
  if (verb === 'ESCALATE') return 'escalated_by_responder'
  if (verb === 'NAK') return 'rejected'
  return 'responded_unparsed'
}

/** Every recipient of a dispatch, with their state. */
export function recipientStates(dispatch, inbounds = []) {
  const replies = inbounds
    .filter((reply) => !reply.alert_event_id || reply.alert_event_id === dispatch.alert_event_id)
    .map((reply) => ({ ...reply, verb: reply.verb ?? parseReplyVerb(reply.text).verb, received_at: reply.received_at || reply.created_at }))
  return dispatchRecipients(dispatch).map((recipient) => recipientStatus(dispatch, recipient, replies))
}

/**
 * Stamps an acknowledgement onto a dispatch.
 *
 * Idempotent by construction: an existing acknowledgement is not restamped. The
 * moment the phone rang is a fact about the past that does not improve with
 * later evidence, and `mean_response_seconds` is computed from it.
 */
export function applyAcknowledgement(dispatch, reply, options = {}) {
  const { now = new Date().toISOString() } = options
  const key = senderKey(reply.from)
  if (!key) return dispatch
  const existing = dispatch.acknowledgements?.[key]
  if (existing?.ack_at) return dispatch

  return {
    ...dispatch,
    acknowledgements: {
      ...(dispatch.acknowledgements || {}),
      [key]: {
        verb: reply.verb || null,
        reason_code: reply.reason_code ?? null,
        note: reply.note ?? null,
        ack_at: reply.received_at || now,
        reply_id: reply.id || reply.reply_id || null,
        escalated_at: existing?.escalated_at || null,
      },
    },
    updated_at: now,
  }
}

/** Records that an escalation fired, so the same person is never paged twice for one alert. */
export function applyEscalation(dispatch, escalation) {
  const key = senderKey(escalation.recipient || escalation.urn)
  if (!key) return dispatch
  const existing = dispatch.acknowledgements?.[key] || {}
  if (existing.escalated_at) return dispatch
  return {
    ...dispatch,
    acknowledgements: {
      ...(dispatch.acknowledgements || {}),
      [key]: { ...existing, escalated_at: escalation.at, escalated_to: escalation.escalate_to || [] },
    },
    updated_at: escalation.at,
  }
}

/**
 * Escalations that are due at `now`.
 *
 * Pure in `now`, which is what makes it testable without waiting: a test passes
 * a fixed instant and gets a deterministic answer, and the production call
 * passes `new Date()`. There is no timer here and no background job —
 * ADR-009 deliberately keeps scheduling out of the process, so this is a
 * function the operator (or any scheduler they own) calls.
 *
 * The four refusals, each of which is a way this would page someone wrongly:
 *   1. The dispatch must have been accepted. Escalating a message RapidPro
 *      refused would page a supervisor about a gateway outage.
 *   2. Silence is measured from the *earliest* dispatch for the alert. A person
 *      is late relative to the first page, not the fourth.
 *   3. Any reply counts as response, even an unparseable one.
 *   4. A recipient already escalated is not escalated again.
 */
export function dueEscalations(data, options = {}) {
  const { now = new Date().toISOString(), env = process.env } = options
  const nowMs = Date.parse(now)
  const dispatches = data?.rapidpro_dispatches || []
  const inbounds = (data?.rapidpro_inbound_messages || []).map((reply) => ({
    ...reply,
    verb: reply.verb ?? parseReplyVerb(reply.text).verb,
    reason_code: reply.reason_code ?? parseReplyVerb(reply.text).reason_code,
    received_at: reply.received_at || reply.created_at,
  }))

  // First page per alert event, not per dispatch: a rule that fires twice within
  // an hour must not restart the clock on the second page.
  const firstDispatchAt = new Map()
  for (const dispatch of dispatches) {
    if (!dispatch.alert_event_id || !dispatch.created_at) continue
    const at = Date.parse(dispatch.created_at)
    const current = firstDispatchAt.get(dispatch.alert_event_id)
    if (current === undefined || at < current) firstDispatchAt.set(dispatch.alert_event_id, at)
  }

  const severityByEvent = new Map()
  for (const dispatch of dispatches) {
    if (dispatch.alert_event_id && dispatch.severity) severityByEvent.set(dispatch.alert_event_id, dispatch.severity)
  }

  const due = []
  for (const dispatch of dispatches) {
    if (!dispatchAccepted(dispatch)) continue
    const dispatchedAt = firstDispatchAt.get(dispatch.alert_event_id)
    if (dispatchedAt === undefined) continue

    const severity = severityByEvent.get(dispatch.alert_event_id) || dispatch.severity || null
    const slaMinutes = ackSlaMinutes(severity, env)
    const deadline = dispatchedAt + slaMinutes * 60 * 1000
    if (nowMs < deadline) continue

    for (const recipient of dispatchRecipients(dispatch)) {
      const state = recipientStatus(dispatch, recipient, inbounds)
      if (state.ack_status === 'unidentified') continue
      // "awaiting" is the only state that can be escalated. Everything else is
      // either a person responding or a message that never left.
      if (state.ack_status !== 'awaiting') continue
      const stamped = dispatch.acknowledgements?.[recipient.key]
      if (stamped?.escalated_at) continue

      const targets = escalationTargets(severity, env)
      due.push({
        alert_event_id: dispatch.alert_event_id,
        dispatch_id: dispatch.id,
        recipient: recipient.urn,
        dispatched_at: new Date(dispatchedAt).toISOString(),
        deadline_at: new Date(deadline).toISOString(),
        elapsed_ms: nowMs - dispatchedAt,
        sla_minutes: slaMinutes,
        severity: severity || null,
        reason: `no response from ${recipient.urn} within ${slaMinutes} min of dispatch`,
        escalate_to: targets,
        // An escalation with no one to send to is an operator problem, and the
        // record says so rather than implying a human was summoned.
        escalation_target_unresolved: targets.length === 0,
      })
    }
  }
  return due
}

/**
 * The delivery record (ENH-26's "delivery-report endpoint", as data).
 *
 * The rate divides by *identified recipients*, not by dispatch count — a
 * broadcast to 500 with 3 replies is 0.6%, and reporting 300% was ALERT-05.
 * With no recipient identity anywhere the rate is `null`, because a number with
 * no denominator in it is a decoration.
 */
export function deliveryReport(data, options = {}) {
  const { alert_event_id = null, now = new Date().toISOString(), env = process.env } = options
  const dispatches = (data?.rapidpro_dispatches || []).filter((dispatch) => !alert_event_id || dispatch.alert_event_id === alert_event_id)
  const inbounds = data?.rapidpro_inbound_messages || []
  const nowMs = Date.parse(now)

  const recipients = []
  for (const dispatch of dispatches) {
    // A dispatch created after the report instant has told nobody anything yet.
    // Listing it as "awaiting" would invent an obligation nobody had.
    if (Date.parse(dispatch.created_at) > nowMs) continue
    recipients.push(...recipientStates(dispatch, inbounds))
  }

  const counts = {
    recipients: recipients.length,
    acknowledged: recipients.filter((r) => r.ack_status === 'acknowledged').length,
    resolved: recipients.filter((r) => r.ack_status === 'resolved').length,
    escalated_by_responder: recipients.filter((r) => r.ack_status === 'escalated_by_responder').length,
    rejected: recipients.filter((r) => r.ack_status === 'rejected').length,
    responded_unparsed: recipients.filter((r) => r.ack_status === 'responded_unparsed').length,
    awaiting: recipients.filter((r) => r.ack_status === 'awaiting').length,
    unidentified: recipients.filter((r) => r.ack_status === 'unidentified').length,
    not_dispatched: recipients.filter((r) => r.ack_status === 'not_dispatched').length,
  }
  const identifiable = counts.recipients - counts.unidentified
  const responded = identifiable - counts.awaiting

  const severity = dispatches.find((dispatch) => dispatch.severity)?.severity || null
  const due = dueEscalations({ ...data, rapidpro_dispatches: dispatches }, { now, env })
  const raised = recipients.filter((r) => Boolean(dispatchWithAck(data, r.dispatch_id, r.urn)))

  const notes = []
  if (!identifiable) notes.push('no dispatch in scope carries recipient identity, so acknowledgement cannot be tracked per person')
  if (counts.responded_unparsed) notes.push(`${counts.responded_unparsed} recipient(s) replied without a recognised verb; counted as response, not as acknowledgement`)
  if (due.some((item) => item.escalation_target_unresolved)) notes.push('RAPIDPRO_ESCALATION_URNS is unset, so escalations are due but have nowhere to go')

  return {
    alert_event_id: alert_event_id || (dispatches.length === 1 ? dispatches[0].alert_event_id : null),
    generated_at: now,
    severity: severity || null,
    ack_sla_minutes: ackSlaMinutes(severity, env),
    dispatched_at: recipients.length ? recipients.map((r) => r.dispatched_at).sort()[0] : null,
    recipients,
    counts,
    acknowledged_count: counts.acknowledged + counts.resolved,
    ack_rate_pct: identifiable > 0 ? Math.round((responded / identifiable) * 10000) / 100 : null,
    ack_rate_basis: identifiable > 0
      ? `${responded} of ${identifiable} identified recipients responded`
      : 'not computable: no identified recipients',
    escalations_due: due,
    escalations_raised: raised,
    notes,
  }
}

function dispatchWithAck(data, dispatchId, urn) {
  const dispatch = (data?.rapidpro_dispatches || []).find((candidate) => candidate.id === dispatchId)
  return dispatch?.acknowledgements?.[senderKey(urn)]?.escalated_at || null
}

/** The same record as text, for an operator who reads a terminal and not a dashboard. */
export function formatDeliveryReport(report) {
  const lines = []
  lines.push(`Delivery report — ${report.alert_event_id || 'all alerts'}`)
  lines.push(`generated ${report.generated_at}${report.severity ? ` · severity ${report.severity}` : ''} · SLA ${report.ack_sla_minutes} min`)
  lines.push(`dispatched ${report.dispatched_at || 'never'}`)
  lines.push('')
  lines.push(`Recipients: ${report.counts.recipients}  ·  acknowledged ${report.acknowledged_count}  ·  awaiting ${report.counts.awaiting}  ·  responded (unparsed) ${report.counts.responded_unparsed}`)
  lines.push(`Acknowledgement rate: ${report.ack_rate_pct === null ? 'not computable' : `${report.ack_rate_pct}%`} (${report.ack_rate_basis})`)
  lines.push('')
  for (const recipient of report.recipients) {
    const stamp = recipient.ack_at ? ` at ${recipient.ack_at}` : ''
    const reason = recipient.reason_code ? ` reason=${recipient.reason_code}` : ''
    lines.push(`  ${recipient.urn.padEnd(18)} ${recipient.ack_status}${stamp}${reason}`)
    if (recipient.note) lines.push(`  ${' '.repeat(18)} note: ${recipient.note}`)
  }
  if (report.escalations_due.length) {
    lines.push('')
    lines.push(`Escalations due (${report.escalations_due.length}):`)
    for (const item of report.escalations_due) {
      lines.push(`  ${item.recipient} — deadline ${item.deadline_at} elapsed, no response${item.escalation_target_unresolved ? ' — NO ESCALATION TARGET CONFIGURED' : ` → ${item.escalate_to.join(', ')}`}`)
    }
  }
  if (report.escalations_raised.length) {
    lines.push('')
    lines.push('Escalations already raised (not raised again):')
    for (const item of report.escalations_raised) lines.push(`  ${item.urn} — escalated at ${item.ack_at}`)
  }
  if (report.notes.length) {
    lines.push('')
    for (const note of report.notes) lines.push(`NOTE: ${note}`)
  }
  return lines.join('\n')
}

/**
 * Parses an inbound SMS into a reply record.
 *
 * The reply webhook sits behind `verifyRapidProWebhook`, unchanged and
 * unweakened: it fails closed on an absent secret, an unverifiable body
 * signature, or a wrong one. A structured reply verb is attacker-controlled
 * input like any other — the fact that this endpoint closes an SLA is a reason
 * to hold authentication harder, not more loosely, and the correlation below is
 * by address inside a bounded window rather than by "trust the payload's
 * alert_event_id", which a caller could name at will.
 */
export function parseRapidProReply(payload = {}, data = null, options = {}) {
  const { env = process.env, now = new Date().toISOString() } = options
  const text = String(payload.content || payload.text || payload.input?.text || payload.message?.text || '').trim()
  const contact = payload.contact || {}
  const correlation = correlateReply(payload, data, { now, windowHours: Number(env.RAPIDPRO_REPLY_CORRELATION_HOURS) || 24 })
  const parsed = parseReplyVerb(text)
  const sourceId = payload.id || payload.uuid || payload.message?.uuid || payload.run?.uuid || stableId('rapidpro_reply', [correlation.from, text, payload.received_on || now])

  return {
    id: stableId('rapidpro_inbound', [sourceId, correlation.from, text]),
    provider: 'rapidpro',
    direction: 'incoming',
    kind: 'reply',
    source_id: sourceId,
    from: correlation.from,
    contact_uuid: contact.uuid || payload.contact_uuid || null,
    contact_name: contact.name || payload.contact_name || null,
    text,
    verb: parsed.verb,
    reason_code: parsed.reason_code,
    reason_raw: parsed.reason_raw,
    note: parsed.note,
    recognised: parsed.recognised,
    status: 'processed',
    alert_event_id: correlation.alert_event_id,
    dispatch_id: correlation.dispatch_id,
    correlated: correlation.correlated,
    correlation_note: correlation.correlation_note,
    received_at: payload.received_on || payload.created_on || payload.created_at || now,
    created_at: now,
    payload,
  }
}
