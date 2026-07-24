import crypto from 'node:crypto'
import { stableId } from './utils.js'

const VALID_SOURCES = ['sms', 'web', 'chw']
const VALID_SENTIMENTS = ['positive', 'negative', 'unclear']

function hashUrn(urn) {
  if (!urn) return null
  return crypto.createHash('sha256').update(String(urn)).digest('hex').slice(0, 16)
}

export function normalizeCommunityFeedback(input, existing = null) {
  const now = new Date().toISOString()

  const source = input.source || existing?.source || 'web'
  if (!VALID_SOURCES.includes(source)) {
    throw Object.assign(
      new Error(`source must be one of ${VALID_SOURCES.join(', ')}`),
      { statusCode: 400 }
    )
  }

  const sentiment = input.sentiment || existing?.sentiment || 'unclear'
  if (!VALID_SENTIMENTS.includes(sentiment)) {
    throw Object.assign(
      new Error(`sentiment must be one of ${VALID_SENTIMENTS.join(', ')}`),
      { statusCode: 400 }
    )
  }

  const reporter_urn_hash = input.reporter_urn
    ? hashUrn(input.reporter_urn)
    : (existing?.reporter_urn_hash ?? null)

  const id = existing?.id ||
    stableId('feedback', [input.alert_event_id, input.message, now])

  return {
    id,
    alert_event_id: input.alert_event_id || existing?.alert_event_id || null,
    source,
    reporter_urn_hash,
    sentiment,
    message: input.message || existing?.message || '',
    was_action_taken:
      input.was_action_taken !== undefined
        ? input.was_action_taken
        : (existing?.was_action_taken ?? null),
    created_at: existing?.created_at || now,
    updated_at: now,
    metadata: input.metadata || existing?.metadata || {},
  }
}

// Group feedback by alert_event_id with counts and sentiment distribution
export function feedbackSummaryByAlert(data) {
  const feedback = data.community_feedback || []
  const grouped = new Map()

  for (const item of feedback) {
    const key = item.alert_event_id || '__no_alert__'
    if (!grouped.has(key)) {
      grouped.set(key, {
        alert_event_id: item.alert_event_id || null,
        count: 0,
        sentiment: { positive: 0, negative: 0, unclear: 0 },
        action_taken_count: 0,
      })
    }
    const row = grouped.get(key)
    row.count += 1
    const sKey = VALID_SENTIMENTS.includes(item.sentiment) ? item.sentiment : 'unclear'
    row.sentiment[sKey] += 1
    if (item.was_action_taken === true) row.action_taken_count += 1
  }

  return Array.from(grouped.values())
}
