import { KNOWN_DISTRICTS } from './districts.js'
import { ALERT_EVENT_STATUSES } from './schema.js'
import { orgUnitFor } from './org-units.js'

/**
 * The CAP msgType for each alert lifecycle status.
 *
 * This table was previously the literal `['resolved', 'rejected', 'cancelled']`
 * inline in the renderer. Two of those three words are not in
 * `ALERT_EVENT_STATUSES` (`open` / `acknowledged` / `resolved`) and cannot be
 * stored on an alert event, so the branch that was supposed to retire a
 * rejected alert was unreachable: a rejected alert rendered `<msgType>Alert</msgType>`
 * and kept publishing as live to every national system that pulls this feed.
 *
 * The vocabulary lives in `schema.js` and is not restated here; the map is
 * checked against it below, so a status added to the schema without a
 * classification here fails at import rather than publishing as live by default.
 *
 * `acknowledged` stays an `Alert`, not an `Update`. CAP `Update` asserts that an
 * earlier message with this identifier was superseded by this one; acknowledging
 * an alert changes nothing about the message, and the alert may never have been
 * dispatched, so `Update` would assert a publication history that does not exist.
 */
const CAP_MSG_TYPES = Object.freeze({
  open: 'Alert',
  acknowledged: 'Alert',
  resolved: 'Cancel',
})

for (const status of ALERT_EVENT_STATUSES) {
  if (!Object.hasOwn(CAP_MSG_TYPES, status)) {
    throw new Error(
      `cap.js: alert status '${status}' has no CAP msgType; classify it in CAP_MSG_TYPES`
    )
  }
}

/** CAP 1.2 `scope`: what the sender permits the recipient to do with the message. */
const CAP_SCOPES = Object.freeze(['Public', 'Restricted', 'Private'])

/**
 * Render an alert event as CAP 1.2 XML.
 *
 * This is an interchange format: whatever an external alerting system, EWS
 * gateway or SMS provider reads here is what a community may be told. It was
 * previously almost entirely placeholder content.
 *
 * The generator asked for `headline`, `description`, `event_type`,
 * `latitude`, `longitude`, `radius_km` and `lead_time_days`. An alert event
 * carries none of them — it has `message`, `rule_name`, `metric`, `value`,
 * `threshold`, `operator`, `severity`, `status` and `scope.district` — so every
 * one of those reads fell through to a default. Every alert published as
 * "Hazard Alert / A hazard alert has been issued", and the area was emitted as
 * `<circle>0,0 50</circle>`: a 50 km circle at Null Island in the Gulf of
 * Guinea, for an alert about Bor. It was valid XML in the correct namespace and
 * would have placed every humanitarian alert in this system in open water.
 *
 * The area is now resolved from the alert's district, with that district's own
 * centroid and radius, and the prose says what the geometry is: a disc of that
 * radius around the centroid, not the district's boundary. It said "district
 * extent" while emitting a circle, and the two disagreed — Turkana's 200 km
 * radius covers ~125,000 km² against a county area near 80,000, so a consumer
 * activating on the circle alerts people well outside the district (D30). Real
 * boundary polygons would settle it and the repo ingests none; until they exist,
 * a bounded approximation that says it is one is honest and a boundary claim the
 * geometry does not support is not. Where no district and no coordinates exist,
 * no circle is emitted at all — an absent location is honest, a fabricated one
 * is not.
 */
export function renderCapXml(alertEvent = {}, options = {}) {
  const {
    sender = 'lindela-lite@example.org',
    // `<senderName>` is not a child of `<alert>` in CAP 1.2 — it lives inside
    // `<info>`, between `<expires>` and `<headline>`. It was destructured here
    // and then never emitted, which is the third dead knob in this renderer
    // after `sender` (which does appear) and the pre-fix `scope`: an option a
    // caller can set, which changes nothing.
    senderName = 'Lindela Lite',
    scope: scopeOverride = null,
  } = options

  const identifier = alertEvent.id || `lindela-${Date.now()}`
  const sent = new Date().toISOString()

  // CAP `status` and `msgType` are independent, and both matter to a consumer.
  // `msgType` reflects the alert lifecycle: a withdrawn or resolved alert is
  // still a true message, so it is published as a Cancel that retires the prior
  // Alert by identifier rather than left live. `status` reflects whether a human
  // approved it — see `resolveCapStatus`.
  const status = resolveCapStatus(alertEvent)
  const msgType = resolveMsgType(alertEvent)
  const cancelled = msgType === 'Cancel'
  const scope = resolveScope(scopeOverride)

  const district = resolveDistrict(alertEvent)
  const severity = mapSeverity(alertEvent.severity || 'medium')
  const urgency = computeUrgency(alertEvent.severity)
  const certainty = computeCertainty(alertEvent)
  const category = categorizeEvent(alertEvent)
  const event = escapeXml(eventName(alertEvent))

  const headline = escapeXml(headlineFor(alertEvent, cancelled))
  const description = escapeXml(descriptionFor(alertEvent, district, cancelled))

  const areaDesc = escapeXml(
    district ? `${district.name} district, approximate: a ${district.radius_km} km radius around the centroid` : 'Affected area, extent not established'
  )
  const circle = district
    ? `      <circle>${district.center.lat},${district.center.lon} ${district.radius_km}</circle>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${escapeXml(identifier)}</identifier>
  <sender>${escapeXml(sender)}</sender>
  <sent>${sent}</sent>
  <status>${status}</status>
  <msgType>${msgType}</msgType>
  <scope>${scope}</scope>
  <restriction>${escapeXml(restrictionFor(scope))}</restriction>
  <info>
    <category>${category}</category>
    <event>${event}</event>
    <urgency>${urgency}</urgency>
    <severity>${severity}</severity>
    <certainty>${certainty}</certainty>
    <senderName>${escapeXml(senderName)}</senderName>
    <headline>${headline}</headline>
    <description>${description}</description>
    <area>
      <areaDesc>${areaDesc}</areaDesc>
${circle}
    </area>
  </info>
</alert>`
}

/**
 * The CAP msgType for an alert event, from the shared status vocabulary.
 *
 * A missing status means the record predates the lifecycle and is still live.
 * Any other value is compared exactly against `ALERT_EVENT_STATUSES` — not
 * lower-cased, not truthiness-tested — and an unrecognised one throws rather
 * than falling through to `Alert`. Falling through is the defect: a status the
 * renderer does not understand is one it cannot show to be retired, and
 * publishing it as live is the unsafe direction.
 */
function resolveMsgType(alertEvent) {
  const raw = alertEvent?.status
  if (raw === undefined || raw === null) return 'Alert'
  if (!ALERT_EVENT_STATUSES.includes(raw)) {
    throw new Error(
      `alert status must be one of ${ALERT_EVENT_STATUSES.join(', ')}; refusing to render '${raw}' as a live alert`
    )
  }
  return CAP_MSG_TYPES[raw]
}

/**
 * The CAP `status` for an alert event, from whether a human approved it.
 *
 * CAP 1.2 defines `<status>` as the message's actionability, and reserves the
 * value for exactly this case: `Draft` is *"a preliminary template or draft, not
 * actionable in its current form"* (OASIS CAP v1.2, `<status>` code values,
 * archived at `sources/CAP-v1.2-os.html`). The renderer hardcoded `Actual` —
 * *"actionable by all targeted recipients"* — for every alert, so an alert a
 * human had not approved published to a national relay with the platform
 * asserting it was cleared for action. That is the same defect the SMS dispatch
 * path already refuses: `POST /api/v1/rapidpro/alert-events/:id/send` answers a
 * `proposed` alert `409 Alert not approved` (`src/routes/rapidpro.js:145`), and
 * the CAP document is the other way out of the building.
 *
 * The predicate is the dispatch path's, not a second rule: approved means
 * `approved` or `auto_approved`, and an absent approval is `proposed` — the same
 * default `approveAlertEvent` and the dispatch gate both take. A record that
 * predates the approval field is therefore Draft rather than silently cleared.
 */
export function resolveCapStatus(alertEvent) {
  const state = alertEvent?.approval?.state ?? 'proposed'
  return state === 'approved' || state === 'auto_approved' ? 'Actual' : 'Draft'
}

/**
 * The CAP dissemination scope.
 *
 * `scope` in CAP 1.2 is not a label: it tells the recipient whether the message
 * is for unrestricted dissemination, controlled dissemination, or a single
 * recipient. It was a hardcoded `Public` literal, and the `scope` option beside
 * it was never reachable from any caller — `src/server.js` renders with the
 * record alone — so the platform asserted unrestricted dissemination for every
 * alert without ever deciding it.
 *
 * Nothing on an alert event carries a classification. `alertEvent.scope` is
 * `{ district }`, a geographic extent that shares the name and nothing else
 * with this field. Guessing one — the tempting move being `Security` implies
 * `Restricted` — would be worse than the literal: a national system that filters
 * on `Public` would silently drop every conflict alert this platform raises,
 * which is the same class of harm as a resolved alert that never retires. So the
 * default is kept, but it is now asserted rather than implied: the document
 * carries a `<restriction>` saying the message derives from public monitoring
 * data. An alert that does need controlled dissemination says so through the
 * option, and anything outside the CAP vocabulary is rejected instead of being
 * passed to a national system as a misspelt scope.
 */
function resolveScope(scopeOverride) {
  if (scopeOverride === undefined || scopeOverride === null) return 'Public'
  if (!CAP_SCOPES.includes(scopeOverride)) {
    throw new Error(
      `CAP scope must be one of ${CAP_SCOPES.join(', ')}; refusing to render '${scopeOverride}'`
    )
  }
  return scopeOverride
}

/** How the scope above is worded in the document, so it is stated not implied. */
function restrictionFor(scope) {
  if (scope === 'Restricted') {
    return 'Restricted dissemination: not for unrestricted publication. Confirm the recipient before onward distribution.'
  }
  if (scope === 'Private') {
    return 'Private dissemination: addressed to a single named recipient and not for onward distribution.'
  }
  return 'No dissemination restriction. Derived by Lindela Lite from public monitoring data; verify before acting.'
}

/**
 * The alert's district, if it names one we have a real extent for.
 *
 * Resolved through the administrative registry (CAP-03) rather than by a
 * second lookup written here. The copy this replaces compared the name
 * case-insensitively and consulted no synonym table, so a CAP message for a
 * `moroto` alert found no extent and published with no area — the same gap that
 * made the Karamoja district page read zero. One registry, one vocabulary.
 */
function resolveDistrict(alertEvent) {
  const named = alertEvent?.scope?.district || alertEvent?.district || null
  if (!named) return null
  const unit = orgUnitFor(named)
  if (!unit || !unit.slug) return null
  return KNOWN_DISTRICTS.find((d) => d.slug === unit.slug) || null
}

/** What the alert is, from the fields an alert event actually carries. */
function eventName(alertEvent) {
  // Hazard events carry `event_type`; alert events carry `metric` and
  // `rule_name`. Both are matched so the generator works for either shape.
  const metric = String(alertEvent.metric || '')
  const rule = String(alertEvent.rule_name || '')
  const type = String(alertEvent.event_type || '')
  const text = `${metric} ${rule} ${type}`
  if (/flood|precip|rain/i.test(text)) return 'Flood'
  if (/fire|burn/i.test(text)) return 'Wildfire'
  if (/heat|temperature|temp/i.test(text)) return 'Extreme heat'
  if (/conflict|violence|attack/i.test(text)) return 'Conflict'
  if (/disease|fever|case/i.test(text)) return 'Disease'
  if (/earthquake|quake|seismic/i.test(text)) return 'Earthquake'
  if (rule) return rule
  return 'Hazard alert'
}

function headlineFor(alertEvent, cancelled) {
  const message = String(alertEvent.message || '').trim()
  const base = message
    ? (message.length > 200 ? `${message.slice(0, 197)}...` : message)
    : (alertEvent.event_type ? String(alertEvent.event_type) : eventName(alertEvent))
  // A Cancel whose headline reads as the original warning is read as a
  // warning by anything that keys on text, which is most of what receives this
  // feed. The message is still sent rather than suppressed — CAP Cancel retires
  // a prior Alert by identifier, and dropping it would leave the downstream
  // system holding the live alert indefinitely.
  return cancelled ? `CANCELLED: ${base}` : base
}

function descriptionFor(alertEvent, district, cancelled) {
  const parts = []
  if (cancelled) parts.push('This alert is cancelled and is no longer in effect.')
  const rule = alertEvent.rule_name ? `Rule: ${alertEvent.rule_name}.` : null
  if (rule) parts.push(rule)
  if (alertEvent.metric) {
    const v = alertEvent.value
    const t = alertEvent.threshold
    const op = alertEvent.operator || '>='
    parts.push(`Trigger: ${alertEvent.metric} ${v ?? '—'} ${op} ${t ?? '—'}.`)
  }
  // Says "approximate" and gives the geometry's own parameters rather than
  // calling the disc an extent: the circle is a centroid and a radius, and a
  // reader deciding whether to activate on it needs to know that, because for
  // Turkana the disc is half again the county's area (D30).
  if (district) parts.push(`Area: ${district.name} district, approximate — a ${district.radius_km} km radius around the centroid, not the district boundary.`)
  else parts.push('Area: extent not established for this alert; no coordinates are asserted.')
  if (alertEvent.false_alert === true) parts.push('Reviewed outcome: recorded as a false alarm.')
  else if (alertEvent.false_alert === false) parts.push('Reviewed outcome: recorded as a warranted alert.')
  else if (alertEvent.false_alert === null && cancelled) {
    parts.push('Reviewed outcome: not determined.')
  }
  parts.push('Generated by Lindela Lite from public monitoring data; not an official forecast.')
  return parts.join(' ')
}

/**
 * Urgency from severity.
 *
 * It previously read `lead_time_days`, which no alert event carries, so every
 * alert published as `Immediate` — including a `low` severity observation.
 */
function computeUrgency(severity) {
  const normalized = String(severity || '').toLowerCase()
  if (normalized === 'critical' || normalized === 'extreme') return 'Immediate'
  if (normalized === 'high' || normalized === 'severe') return 'Expected'
  if (normalized === 'low' || normalized === 'minor') return 'Future'
  return 'Expected'
}

function computeCertainty(alertEvent) {
  const confidence = Number(alertEvent.confidence)
  if (!Number.isFinite(confidence)) return 'Likely'
  if (confidence >= 80) return 'Observed'
  if (confidence >= 50) return 'Likely'
  return 'Possible'
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
  const eventType = String(
    alertEvent.event_type || alertEvent.rule_name || alertEvent.metric || eventName(alertEvent)
  ).toLowerCase()
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
