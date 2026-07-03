import crypto from 'node:crypto'
import { stableId, nowIso } from './utils.js'

export function normalizeWebhookSubscription(input, existing = null) {
  const id = input.id || existing?.id || stableId('webhook', [input.url, JSON.stringify(input.events)])
  const url = String(input.url || '').trim()
  if (!url || !url.startsWith('http')) {
    throw Object.assign(new Error('url must be an HTTPS or HTTP URL'), { statusCode: 400 })
  }

  const events = Array.isArray(input.events) ? input.events : []
  if (!events.length) {
    throw Object.assign(new Error('events must be a non-empty array of glob patterns'), { statusCode: 400 })
  }

  const status = ['active', 'paused'].includes(input.status) ? input.status : 'active'
  const headers = typeof input.headers === 'object' ? input.headers : {}
  const secret = input.secret ? String(input.secret) : null

  return {
    id,
    url,
    events,
    headers,
    secret,
    status,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  }
}

export function matchEvent(subscription, eventName) {
  const patterns = subscription.events || []
  if (!patterns.length) return false

  for (const pattern of patterns) {
    if (globMatch(pattern, eventName)) {
      return true
    }
  }
  return false
}

export function signPayload(secret, body) {
  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(body)
  return hmac.digest('hex')
}

function globMatch(pattern, text) {
  const regex = new RegExp(
    `^${pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  )
  return regex.test(text)
}
