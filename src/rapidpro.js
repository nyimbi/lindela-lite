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
        response_count: 0,
        response_rate_pct: 0,
        first_response_at: null,
        mean_response_seconds: 0,
      }
    }
    result[alertEventId].dispatched_count++
  }

  for (const inbound of inbounds) {
    const alertEventId = inbound.alert_event_id
    if (!alertEventId || !result[alertEventId]) continue
    result[alertEventId].response_count++
    if (!result[alertEventId].first_response_at || new Date(inbound.created_at) < new Date(result[alertEventId].first_response_at)) {
      result[alertEventId].first_response_at = inbound.created_at
    }
  }

  for (const alertEventId in result) {
    const metrics = result[alertEventId]
    if (metrics.dispatched_count > 0) {
      metrics.response_rate_pct = Math.round((metrics.response_count / metrics.dispatched_count) * 10000) / 100
    }
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
