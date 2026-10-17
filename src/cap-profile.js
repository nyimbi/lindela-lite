/**
 * ENH-36 — the CAP 1.2 profile, as a check rather than as an intention.
 *
 * `src/cap.js` renders CAP XML, and every defect it has had was a *shape* defect
 * rather than a wording one: an element emitted out of schema order, a required
 * element omitted, a value outside the enumerated vocabulary, a circle at Null
 * Island. Each was found by a human reading the output, which is the expensive
 * way and the way that stops working the moment the renderer changes.
 *
 * So this module validates a rendered document against the standard's own
 * structure. The authority is the OASIS CAP 1.2 specification, archived at
 * `sources/CAP-v1.2-os.html`; the element order, the required sets and the
 * vocabularies below are transcribed from its element tables, not from memory.
 * A consumer's parser rejects an out-of-order or out-of-vocabulary document, so
 * a validator that agrees with the spec is the difference between a feed GDACS
 * can read and one it silently drops.
 *
 * **What this checks, and what it does not.** It is a *profile* validator: it
 * reads the XML as text and checks structure, order, presence and vocabulary. It
 * does not parse namespaces properly, does not verify the XML signature, and
 * does not check the conditional rules that depend on sibling elements beyond
 * the one CAP states for `ceiling`. That is deliberate — the failure mode this
 * exists for is a renderer emitting the wrong shape, and a full XSD validation
 * would need a validating parser the project does not ship. The limits are
 * stated here so a reader does not take a pass for more than it is.
 *
 * Determinism: nothing here reads a clock or a random source.
 */

import { resolveCapStatus } from './cap.js'

/**
 * The `<alert>` sub-elements, in schema order.
 *
 * Transcribed from the specification's element table. Order is load-bearing in
 * CAP — a sequence, not an all — so an element emitted before one it must
 * follow is a document a conforming parser rejects.
 */
export const ALERT_ORDER = Object.freeze([
  'identifier', 'sender', 'sent', 'status', 'msgType', 'source', 'scope',
  'restriction', 'addresses', 'code', 'note', 'references', 'incidents', 'info',
])

/** The `<info>` sub-elements, in schema order. */
export const INFO_ORDER = Object.freeze([
  'language', 'category', 'event', 'responseType', 'urgency', 'severity',
  'certainty', 'audience', 'eventCode', 'effective', 'onset', 'expires',
  'senderName', 'headline', 'description', 'instruction', 'web', 'contact',
  'parameter', 'resource', 'area',
])

/** The `<area>` sub-elements, in schema order. */
export const AREA_ORDER = Object.freeze([
  'areaDesc', 'polygon', 'circle', 'geocode', 'altitude', 'ceiling',
])

/** Required children of each container. `info` and `area` are optional; the rest are not. */
export const REQUIRED = Object.freeze({
  alert: Object.freeze(['identifier', 'sender', 'sent', 'status', 'msgType', 'scope']),
  info: Object.freeze(['category', 'event', 'urgency', 'severity', 'certainty']),
  area: Object.freeze(['areaDesc']),
})

/**
 * The enumerated vocabularies, from the specification's data dictionaries.
 *
 * `certainty` carries the deprecation the spec states: `Very Likely` is
 * deprecated and "SHOULD be treated as equivalent to 'Likely'". It is accepted
 * here and reported as a warning rather than an error, because a document
 * carrying it is readable and rejecting it would fail a feed that a consumer
 * accepts.
 */
export const VOCABULARIES = Object.freeze({
  status: Object.freeze(['Actual', 'Exercise', 'System', 'Test', 'Draft']),
  msgType: Object.freeze(['Alert', 'Update', 'Cancel', 'Ack', 'Error']),
  scope: Object.freeze(['Public', 'Restricted', 'Private']),
  category: Object.freeze(['Geo', 'Met', 'Safety', 'Security', 'Rescue', 'Fire', 'Health', 'Env', 'Transport', 'Infra', 'CBRNE', 'Other']),
  urgency: Object.freeze(['Immediate', 'Expected', 'Future', 'Past', 'Unknown']),
  severity: Object.freeze(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']),
  certainty: Object.freeze(['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']),
})

/** The deprecated spellings, accepted with a warning. */
export const DEPRECATED_VALUES = Object.freeze({
  certainty: Object.freeze(['Very Likely']),
})

const CAP_NAMESPACE = 'urn:oasis:names:tc:emergency:cap:1.2'

/** Every element a CAP document may contain, at any depth. */
const KNOWN_ELEMENTS = new Set([...ALERT_ORDER, ...INFO_ORDER, ...AREA_ORDER, 'alert'])

/**
 * The elements a single `<info>` block may contain, and how many times.
 *
 * `category`, `responseType`, `eventCode`, `parameter` and `code` repeat; the
 * rest are single-valued in one block. A repeated single-valued element is a
 * document whose meaning is undefined — a consumer takes the first or the last
 * and the two readers disagree.
 */
const REPEATABLE_IN_INFO = new Set(['category', 'responseType', 'eventCode', 'parameter', 'resource'])
const REPEATABLE_IN_AREA = new Set(['polygon', 'circle', 'geocode'])
const REPEATABLE_IN_ALERT = new Set(['code', 'info', 'references'])

/**
 * Every element in a document, in document order, with its container path.
 *
 * Deliberately a regex over the text rather than a parser: the documents this
 * checks are generated by one function with no CDATA, no processing
 * instructions inside the body and no self-closing elements, and a real parser
 * would be a dependency the project does not have. The trade is stated rather
 * than hidden — a document this cannot read is one it reports as malformed.
 *
 * @returns {{elements: Array<{name: string, value: string, path: string[]}>, malformed: string|null}}
 */
function scan(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return { elements: [], malformed: 'the document is empty' }
  const body = xml.replace(/^<\?xml[^>]*\?>/, '')
  const elements = []
  // An open-element stack, so an element's value is the text between *its own*
  // tags. The first version took the text preceding each open tag, which is the
  // previous element's content plus its closing tag — so `<status>` read
  // `2026-…</sent>` and every vocabulary check failed on a correct document.
  const open = []
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g
  let match
  while ((match = tag.exec(body)) !== null) {
    const [, closing, name, selfClosing] = match
    if (closing) {
      // A close tag must match the *innermost* open element. Matching any open
      // element on the stack — which the first version did — lets `</info>`
      // close past an unclosed `<description>`, so a document missing a closing
      // tag reports itself well-formed and the validator passes it. That is the
      // failure the malformed check exists for.
      const at = open.length - 1
      if (at < 0 || open[at].name !== name) {
        const innermost = at < 0 ? null : open[at].name
        return {
          elements,
          malformed: innermost
            ? `</${name}> closes <${innermost}>, which is still open — <${innermost}> is missing its closing tag`
            : `</${name}> closes an element that was never opened`,
        }
      }
      const frame = open[at]
      // `path` includes the element itself, so the root `<alert>` is recorded at
      // depth 1 and every check below states a depth rather than a depth plus
      // one.
      elements.push({
        name,
        value: body.slice(frame.start, match.index).trim(),
        path: [...open.slice(0, at).map((o) => o.name), name],
        at: frame.at,
      })
      open.length = at
      continue
    }
    if (selfClosing) {
      elements.push({ name, value: '', path: [...open.map((o) => o.name), name], at: tag.lastIndex })
      continue
    }
    open.push({ name, start: tag.lastIndex, at: match.index })
  }
  if (open.length) return { elements, malformed: `<${open[open.length - 1].name}> is never closed` }
  // Back into document order. Elements are *pushed* as they close, so a parent
  // is pushed after its children; the block checks below slice the list by
  // index and need the order a reader sees.
  elements.sort((a, b) => a.at - b.at)
  return { elements, malformed: null }
}

function orderViolation(names, order) {
  let last = -1
  for (const name of names) {
    const at = order.indexOf(name)
    // An element the order does not list is reported by `unknownElement`, not
    // here; skipping it keeps this check about ordering alone.
    if (at < 0) continue
    if (at < last) return { element: name, after: order[last] }
    last = at
  }
  return null
}

/**
 * Validate a rendered CAP 1.2 document against the profile.
 *
 * @param {string} xml the document, as `renderCapXml` produces it
 * @returns {{valid: boolean, errors: string[], warnings: string[], summary: object}}
 */
export function validateCapProfile(xml) {
  const errors = []
  const warnings = []
  const { elements, malformed } = scan(xml)
  if (malformed) return { valid: false, errors: [malformed], warnings, summary: { elements: elements.length } }

  const alert = elements.filter((e) => e.path.length === 1 && e.name === 'alert')
  if (!alert.length) return { valid: false, errors: ['the document has no <alert> element'], warnings, summary: { elements: elements.length } }
  if (alert.length > 1) errors.push(`the document has ${alert.length} <alert> elements; a CAP message is one alert`)

  if (!/xmlns="urn:oasis:names:tc:emergency:cap:1\.2"/.test(xml)) {
    errors.push(`the <alert> does not declare the CAP 1.2 namespace ${CAP_NAMESPACE}`)
  }

  for (const element of elements) {
    if (!KNOWN_ELEMENTS.has(element.name)) {
      errors.push(`<${element.name}> is not a CAP 1.2 element`)
    }
  }

  // Depth 2: a direct child of `<alert>`. Depth 1 is the alert element itself.
  const topLevel = elements.filter((e) => e.path.length === 2).map((e) => e.name)
  for (const required of REQUIRED.alert) {
    if (!topLevel.includes(required)) errors.push(`<alert> is missing the required <${required}>`)
  }
  const orderProblem = orderViolation(topLevel, ALERT_ORDER)
  if (orderProblem) errors.push(`<${orderProblem.element}> appears after <${orderProblem.after}>, which CAP 1.2 orders it before`)

  for (const name of Object.keys(VOCABULARIES)) {
    const found = elements.filter((e) => e.name === name && e.path.length >= 2)
    for (const element of found) {
      if (!element.value) {
        errors.push(`<${name}> is empty; CAP 1.2 requires one of ${VOCABULARIES[name].join(', ')}`)
        continue
      }
      if (VOCABULARIES[name].includes(element.value)) continue
      if ((DEPRECATED_VALUES[name] || []).includes(element.value)) {
        warnings.push(`<${name}> is '${element.value}', which CAP 1.2 deprecates in favour of '${VOCABULARIES[name][0]}'`)
        continue
      }
      errors.push(`<${name}> is '${element.value}', which is not one of ${VOCABULARIES[name].join(', ')}`)
    }
  }

  // `sent` and `expires` must be a date-time. A document whose timestamp is
  // unparseable is one a consumer cannot order against its own clock.
  for (const name of ['sent', 'effective', 'onset', 'expires']) {
    for (const element of elements.filter((e) => e.name === name && e.path.length >= 2)) {
      if (element.value && !Number.isFinite(Date.parse(element.value))) {
        errors.push(`<${name}> is '${element.value}', which is not a date-time CAP 1.2 can read`)
      }
    }
  }

  const infos = elements.filter((e) => e.path.length === 2 && e.name === 'info')
  if (!infos.length) errors.push('<alert> carries no <info> block; CAP 1.2 permits it, but a document without one says nothing')
  let areaCount = 0

  // Each <info> block, validated on its own. The `path` of a direct child of the
  // second info is `['alert','info']` either way, so blocks are separated by
  // their position in document order rather than by path.
  const infoStarts = elements.reduce((acc, e, i) => (e.name === 'info' && e.path.length === 2 ? [...acc, i] : acc), [])
  infoStarts.forEach((start, block) => {
    const end = infoStarts[block + 1] ?? elements.length
    const block_elements = elements.slice(start + 1, end).filter((e) => e.path.length === 3)
    const names = block_elements.map((e) => e.name)

    for (const required of REQUIRED.info) {
      if (!names.includes(required)) errors.push(`<info> ${block + 1} is missing the required <${required}>`)
    }
    const problem = orderViolation(names, INFO_ORDER)
    if (problem) errors.push(`<info> ${block + 1}: <${problem.element}> appears after <${problem.after}>, which CAP 1.2 orders it before`)

    const seen = new Map()
    for (const name of names) {
      seen.set(name, (seen.get(name) || 0) + 1)
    }
    for (const [name, count] of seen) {
      if (count > 1 && !REPEATABLE_IN_INFO.has(name)) {
        errors.push(`<info> ${block + 1} carries <${name}> ${count} times; CAP 1.2 allows it once per block`)
      }
    }
  })

  const areaStarts = elements.reduce((acc, e, i) => (e.name === 'area' && e.path.length === 3 ? [...acc, i] : acc), [])
  areaCount = areaStarts.length
  areaStarts.forEach((start, block) => {
    const end = areaStarts[block + 1] ?? elements.length
    const names = elements.slice(start + 1, end).filter((e) => e.path.length === 4).map((e) => e.name)
    for (const required of REQUIRED.area) {
      if (!names.includes(required)) errors.push(`<area> ${block + 1} is missing the required <${required}>`)
    }
    const problem = orderViolation(names, AREA_ORDER)
    if (problem) errors.push(`<area> ${block + 1}: <${problem.element}> appears after <${problem.after}>, which CAP 1.2 orders it before`)
  })

  // The one conditional rule CAP states explicitly: ceiling MUST NOT be used
  // except in combination with altitude. Checked per <area> block, because the
  // condition is about the siblings of the ceiling, not about the document.
  areaStarts.forEach((start, block) => {
    const end = areaStarts[block + 1] ?? elements.length
    const names = elements.slice(start + 1, end).filter((e) => e.path.length === 4).map((e) => e.name)
    if (names.includes('ceiling') && !names.includes('altitude')) {
      errors.push(`<area> ${block + 1} carries <ceiling> without <altitude>; CAP 1.2 forbids the combination`)
    }
  })

  // Geometry, which is where the renderer's worst defect lived: a circle at
  // (0, 0) is open water off West Africa, and it is *valid* CAP. The profile
  // cannot reject it on the standard's grounds, so it warns — and the district
  // resolution in `cap.js` is what prevents it.
  for (const element of elements.filter((e) => e.name === 'circle')) {
    const parsed = element.value.match(/^(-?[\d.]+),(-?[\d.]+)\s+([\d.]+)$/)
    if (!parsed) {
      errors.push(`<circle> is '${element.value}', which is not 'lat,lon radius'`)
      continue
    }
    const [, lat, lon, radius] = parsed.map(Number)
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`<circle> is centred at ${lat},${lon}, which is not a coordinate`)
    }
    if (!(radius > 0)) errors.push(`<circle> has a radius of ${radius}, which is not an area`)
    if (lat === 0 && lon === 0) {
      warnings.push('<circle> is centred at 0,0 — Null Island. It is valid CAP and it places the alert in the Gulf of Guinea; a missing extent should emit no circle at all')
    }
  }

  for (const element of elements.filter((e) => e.name === 'polygon')) {
    const pairs = element.value.split(/\s+/).filter(Boolean)
    if (pairs.length < 4) {
      errors.push(`<polygon> has ${pairs.length} coordinate pair(s); CAP 1.2 requires at least four`)
      continue
    }
    if (pairs[0] !== pairs[pairs.length - 1]) {
      errors.push('<polygon> is not closed; CAP 1.2 requires the first and last coordinate pair to match')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      elements: elements.length,
      info_blocks: infos.length,
      area_blocks: areaCount,
      categories: elements.filter((e) => e.name === 'category' && e.path.length >= 2).map((e) => e.value),
    },
  }
}

/**
 * The stable permalink for an alert's CAP feed entry.
 *
 * ENH-36's second half. `GET /api/v1/alert-events/<id>.cap` returns a document
 * whose `<identifier>` is the alert id, but nothing gave a consumer a URL to
 * cite — and GDACS and FEWS NET are consumed by *citing the feed*, not by
 * polling a search endpoint. So an alert gets a permalink that is derived from
 * its identifier alone: the same alert always yields the same URL, and the URL
 * is stable across restarts, replicas and re-renders, which a `Date.now()`-based
 * identifier is not.
 *
 * The path is percent-encoded, because an alert id is free text and an id with a
 * slash in it would otherwise name a different route.
 */
export function capPermalink(alertEvent, { baseUrl = '' } = {}) {
  const id = alertEvent?.id
  if (!id) throw new Error('capPermalink needs an alert id; an alert with none has no permalink to mint')
  const path = `/api/v1/alert-events/${encodeURIComponent(String(id))}.cap`
  return baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path
}

/**
 * The Atom feed document over a set of alerts.
 *
 * A feed, not a listing: a consumer polls it and dedupes on `<id>`, which is the
 * alert's own identifier rather than anything minted here. The `<updated>` is
 * the newest alert's `updated_at` and is `null` for an empty feed rather than
 * `now` — an empty feed that claims to have just changed makes every poller
 * re-read it forever, and a timestamp on nothing is the fabricated-value defect
 * in a new place.
 */
export function renderCapFeed(alerts = [], { baseUrl = '', title = 'Lindela Lite CAP alerts', self = null, updated = null } = {}) {
  const rows = (alerts || []).filter((a) => a && a.id)
  const newest = updated || rows.map((a) => a.updated_at || a.created_at).filter(Boolean).sort().pop() || null
  const entries = rows.map((alert) => {
    const link = capPermalink(alert, { baseUrl })
    const when = alert.updated_at || alert.created_at || null
    // The entry carries the approval state, because the feed is where a poller
    // decides what to act on and the linked document is a second request away.
    // A `Draft` alert is not actionable (CAP 1.2 `<status>`), so its title says
    // so — the same treatment `CANCELLED:` gets in `renderCapXml`, and for the
    // same reason: anything that keys on the text must not read a draft as a
    // live warning. It stays in the feed rather than being dropped, because a
    // consumer that dedupes on `<id>` would otherwise keep the last version it
    // saw and never learn the alert was never approved.
    const draft = resolveCapStatus(alert) === 'Draft'
    const title = String(alert.message || alert.rule_name || alert.id)
    return `  <entry>
    <id>${escapeXml(String(alert.id))}</id>
    <title>${escapeXml(draft ? `DRAFT (not approved): ${title}` : title)}</title>
    <link rel="alternate" type="application/cap+xml" href="${escapeXml(link)}"/>
${when ? `    <updated>${escapeXml(String(when))}</updated>\n` : ''}    <summary>${escapeXml(String(alert.rule_name || alert.metric || 'Alert'))}</summary>
  </entry>`
  }).join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(title)}</title>
${newest ? `  <updated>${escapeXml(String(newest))}</updated>\n` : ''}${self ? `  <link rel="self" href="${escapeXml(self)}"/>\n` : ''}${entries}
</feed>`
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
