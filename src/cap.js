export function renderCapXml(alertEvent, options = {}) {
  const {
    sender = 'lindela-lite@example.org',
    senderName = 'Lindela Lite',
    area = 'Affected Region',
    defaults = {},
  } = options

  const identifier = alertEvent.id || `lindela-${Date.now()}`
  const sent = new Date().toISOString()
  const status = 'Actual'
  const msgType = 'Alert'
  const scope = 'Public'

  const urgency = computeUrgency(alertEvent.lead_time_days)
  const severity = mapSeverity(alertEvent.severity || defaults.severity || 'medium')
  const certainty = alertEvent.confidence ? 'Observed' : (alertEvent.confidence > 70 ? 'Likely' : 'Possible')
  const category = categorizeEvent(alertEvent)

  const headline = escapeXml(alertEvent.headline || alertEvent.event_type || 'Hazard Alert')
  const description = escapeXml(
    alertEvent.description || alertEvent.event_type || 'A hazard alert has been issued.'
  )

  const lat = Number(alertEvent.latitude || 0)
  const lon = Number(alertEvent.longitude || 0)
  const radius = Number(alertEvent.radius_km || 50)

  const areaDesc = escapeXml(area || 'Affected Area')

  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${escapeXml(identifier)}</identifier>
  <sender>${escapeXml(sender)}</sender>
  <sent>${sent}</sent>
  <status>${status}</status>
  <msgType>${msgType}</msgType>
  <scope>${scope}</scope>
  <info>
    <category>${category}</category>
    <event>${escapeXml(alertEvent.event_type || 'Hazard')}</event>
    <urgency>${urgency}</urgency>
    <severity>${severity}</severity>
    <certainty>${certainty}</certainty>
    <headline>${headline}</headline>
    <description>${description}</description>
    <area>
      <areaDesc>${areaDesc}</areaDesc>
      <circle>${lat},${lon} ${radius}</circle>
    </area>
  </info>
</alert>`
}

function computeUrgency(leadTimeDays) {
  const days = Number(leadTimeDays)
  if (!Number.isFinite(days) || days <= 0) return 'Immediate'
  if (days <= 2) return 'Expected'
  return 'Future'
}

function mapSeverity(severity) {
  const normalized = String(severity || '').toLowerCase()
  if (normalized === 'critical' || normalized === 'extreme') return 'Extreme'
  if (normalized === 'high' || normalized === 'severe') return 'Severe'
  if (normalized === 'medium' || normalized === 'moderate') return 'Moderate'
  if (normalized === 'low' || normalized === 'minor') return 'Minor'
  return 'Moderate'
}

function categorizeEvent(alertEvent) {
  const eventType = String(alertEvent.event_type || '').toLowerCase()
  if (/flood|storm|cyclone|hurricane|typhoon/i.test(eventType)) return 'Met'
  if (/fire|wildfire|volcanic/i.test(eventType)) return 'Safety'
  if (/conflict|violence|attack/i.test(eventType)) return 'Security'
  if (/earthquake|tsunami/i.test(eventType)) return 'Geo'
  return 'Safety'
}

function escapeXml(text) {
  if (!text) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
