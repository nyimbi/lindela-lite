import { stableId, nowIso } from './utils.js'

export async function emit(store, event, payload) {
  const data = await store.read()
  const record = {
    id: stableId('outbox', [event, JSON.stringify(payload)]),
    event,
    payload,
    created_at: nowIso(),
    attempts: 0,
    status: 'pending',
    last_attempt_at: null,
    last_error: null,
  }
  await store.merge({ events_outbox: [record] })
  return record
}

export async function dispatchPending(store, options = {}) {
  const { webhooks = [], maxBatch = 50, timeoutMs = 5000 } = options
  const data = await store.read()
  const pending = (data.events_outbox || []).filter((e) => e.status === 'pending').slice(0, maxBatch)

  const updates = []
  let dispatched = 0
  let failed = 0

  for (const outboxEvent of pending) {
    const matchedWebhooks = webhooks.filter((w) =>
      w.status === 'active' && matchEvent(w, outboxEvent.event)
    )

    if (!matchedWebhooks.length) {
      updates.push({ ...outboxEvent, status: 'sent', last_attempt_at: nowIso() })
      continue
    }

    let successCount = 0

    for (const webhook of matchedWebhooks) {
      try {
        const body = JSON.stringify({
          event: outboxEvent.event,
          payload: outboxEvent.payload,
          sent_at: nowIso(),
        })

        const headers = {
          'content-type': 'application/json',
          ...(webhook.headers || {}),
        }

        if (webhook.secret) {
          headers['x-signature'] = signPayload(webhook.secret, body)
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (response.ok) {
          successCount += 1
        }
      } catch (error) {
        // Swallow individual webhook errors; retry in next cycle
      }
    }

    const isSuccess = successCount > 0
    const nextAttempts = outboxEvent.attempts + 1
    const maxRetries = 5

    if (isSuccess || nextAttempts >= maxRetries) {
      updates.push({
        ...outboxEvent,
        status: isSuccess ? 'sent' : 'failed',
        attempts: nextAttempts,
        last_attempt_at: nowIso(),
      })
      if (isSuccess) dispatched += 1
      else failed += 1
    } else {
      // Exponential backoff: don't retry yet, will retry in next dispatch cycle
      updates.push({
        ...outboxEvent,
        attempts: nextAttempts,
        last_attempt_at: nowIso(),
      })
    }
  }

  if (updates.length) {
    await store.merge({ events_outbox: updates })
  }

  return { dispatched, failed }
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

function globMatch(pattern, text) {
  const regex = new RegExp(
    `^${pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  )
  return regex.test(text)
}
