import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { KNOWN_DISTRICTS } from './districts.js'

export function stableId(prefix, value) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  return `${prefix}_${hash}`
}

/**
 * Deterministic JSON with object keys sorted at every depth.
 *
 * The previous implementation used `JSON.stringify(filtered, Object.keys(filtered))`.
 * The second argument to JSON.stringify is a property *allowlist* which applies at
 * every level of nesting, so only the top-level keys survived — `metadata` was
 * kept as a key but every key inside it was dropped, and the hash of a record was
 * identical no matter what its metadata said.
 *
 * That is not cosmetic. mergeById skips an incoming record whose payload_hash
 * already exists, so a connector whose metadata changed — a corrected model
 * limit, a flipped episode_declared, a new geolocation note — produced the same
 * hash and the update was silently discarded. Since connector metadata is where
 * the qualifications and provenance live, the one thing that must be able to
 * change is exactly what could not.
 */
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    )
  }
  return value
}

export function canonicalHash(record, ignoreKeys = ['id', 'payload_hash', 'ingested_at', 'generated_at', 'updated_at', 'created_at', 'first_seen_at']) {
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => !ignoreKeys.includes(key))
  )
  return crypto.createHash('sha256').update(JSON.stringify(canonicalise(filtered))).digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Coerce to a finite number, or the fallback.
 *
 * Null, undefined and the empty string must fall back rather than coerce to 0.
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so the previous
 * implementation turned "no value" into a real zero. That is harmless for a
 * threshold and not harmless for a coordinate: a field report whose location was
 * unknown was stored with null latitude and longitude, and the moment anything
 * updated or soft-deleted it through the operational API, the normaliser read
 * those nulls and wrote 0 — putting the report back at Null Island in the Gulf
 * of Guinea. A null is an absence; a zero is a location.
 */
export function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
  if (Array.isArray(value)) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const DEFAULT_LIMIT = 500
export const MAX_LIMIT = 5000

/**
 * A page size from a query string, or a refusal.
 *
 * `Number('abc')` is NaN and `matched.slice(0, NaN)` is `[]`, so `?limit=abc`
 * answered with an empty page that was byte-for-byte what an empty collection
 * looks like — a caller who mistyped a parameter was told there was no data.
 * That is the same silence the `district` and `state` filters used to produce,
 * one layer down: a parameter that cannot be honoured must say so.
 *
 * An absent limit keeps the default, a number is clamped to the ceiling (a
 * raised limit is a request the server is entitled to decline), and a value
 * that is not a number is refused.
 */
export function parseLimit(raw, { fallback = DEFAULT_LIMIT, max = MAX_LIMIT } = {}) {
  // `Number('')` and `Number('   ')` are both 0, which would read as "one
  // record". An empty value is an absent one, the same way it is in `toNumber`.
  const text = raw === null || raw === undefined ? '' : String(raw).trim()
  if (text === '') return fallback
  const value = Number(text)
  if (!Number.isFinite(value)) {
    const error = new Error(`limit must be a number; received ${JSON.stringify(String(raw))}`)
    error.statusCode = 400
    throw error
  }
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

export function parseBbox(value) {
  if (!value) return null
  const parts = String(value).split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('bbox must be west,south,east,north')
  }
  const [west, south, east, north] = parts
  if (west >= east || south >= north) throw new Error('bbox bounds are invalid')
  return { west, south, east, north }
}

export function pointInBbox(item, bbox) {
  if (!bbox) return true
  if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return false
  return item.longitude >= bbox.west && item.longitude <= bbox.east && item.latitude >= bbox.south && item.latitude <= bbox.north
}

/** Whether two west,south,east,north boxes overlap. */
export function boxIntersectsBbox(inner, outer) {
  if (!inner || !outer) return false
  const [w, s, e, n] = [inner.west, inner.south, inner.east, inner.north]
  if (![w, s, e, n].every(Number.isFinite)) return false
  return w <= outer.east && e >= outer.west && s <= outer.north && n >= outer.south
}

/**
 * Whether a record belongs in a bbox query.
 *
 * A point inside the box qualifies. So does a record the source reported as an
 * *area* overlapping the box, even with no point at all.
 *
 * That second case is not hypothetical. GDACS reports most events as a bounding
 * box, and the connector deliberately withholds a point when the box is
 * regional, because a box centre can be hundreds of km from the event. Filtering
 * on points alone therefore returned nothing for those events: a caller asking
 * "what is in this district" was told there was nothing, for a hazard the source
 * had explicitly placed there as an area.
 */
export function recordInBbox(item, bbox) {
  if (!bbox) return true
  if (pointInBbox(item, bbox)) return true
  return boxIntersectsBbox(parseRecordBbox(item.bbox), bbox)
}

function parseRecordBbox(value) {
  if (!value) return null
  if (Array.isArray(value)) return parseBbox(value.join(','))
  if (typeof value === 'object') return value
  return null
}

/**
 * @param {object} [context] optional `{ data, collection, auth }`. `data`
 *   resolves records that carry no location of their own -- without it a
 *   district filter matches nothing for those collections. `auth` carries the
 *   authenticated principal; a token scoped to a partner organisation sees
 *   only records tagged for it, and a `?partner_org=` in the query is refused
 *   rather than trusted, because a client-supplied parameter is not access
 *   control.
 */
/**
 * The caller's identity, for code that is not handed it.
 *
 * Scoping was an **opt-in third argument** to `filterRecords`/`collectionPage`.
 * Three route handlers did not pass one, and `partnerOrg` then evaluated to
 * `null` and the whole collection came back — a partner token read every
 * organisation's field reports, and one handler's by-id branch did not scope at
 * all, so there was nothing to bypass. `docs/improvements/defects.md` recorded
 * SEC-06 as fixed on the strength of the filter *existing*.
 *
 * Existence is not application. With ~60 call sites passing the argument by
 * hand, one omission is silent, and nothing distinguishes an omitted argument
 * from "this deployment has no partners configured".
 *
 * So the identity travels on the request instead. `filterRecords` still accepts
 * an explicit context — a caller that knows better can override — but the
 * default is now the authenticated caller, and the default is right.
 */
const requestContext = new AsyncLocalStorage()

/** Run `fn` with the caller's identity visible to code that was not handed it. */
export function runWithRequestContext(auth, fn) {
  return requestContext.run({ auth: auth ?? null }, fn)
}

/** The current caller's identity, or null outside a request. */
export function currentRequestAuth() {
  return requestContext.getStore()?.auth ?? null
}

export function filterRecords(records, query, context = {}, { unlimited = false } = {}) {
  // An explicit context wins; otherwise the authenticated caller applies. There
  // is no third path in which a partner-scoped token gets the whole store unless
  // the deployment genuinely has no partners configured.
  const auth = context.auth ?? currentRequestAuth()
  const partnerOrg = auth?.partner_org || null
  const claimedOrg = query.get('partner_org')
  if (claimedOrg !== null) {
    // The portal sent this on every request. The server read nothing, so every
    // partner received the whole store while the interface showed the filter
    // as applied. A parameter that looks like isolation must either be the
    // isolation or be refused.
    if (!partnerOrg || claimedOrg !== partnerOrg) {
      const error = new Error(
        partnerOrg
          ? `partner_org=${claimedOrg} does not match this token's organisation`
          : 'partner_org cannot be requested: this token is not scoped to a partner organisation'
      )
      error.statusCode = 403
      throw error
    }
  }
  const districtRelations = buildDistrictRelations(context.data, context.collection, resolveDistrictFilter(query.get('district') || query.get('region')))
  const bbox = parseBbox(query.get('bbox'))
  const country = query.get('country')
  const source = query.get('source')
  const eventType = query.get('event_type')
  const reportType = query.get('report_type') || query.get('type')
  const severity = query.get('severity')
  const status = query.get('status')
  const priority = query.get('priority')
  const incidentId = query.get('incident_id')
  const interventionId = query.get('intervention_id')
  const serviceType = query.get('service_type')
  const owner = query.get('owner')
  // `state` is read by nothing here either, so `?state=focal_point_review`
  // returned every workflow in the collection. The focal-point approval screen
  // asks for exactly that and was handed three instances in `approved`,
  // `dispatched` and `closed` — none of which can be transitioned, so two of
  // every three approvals a focal point was offered returned HTTP 409 with the
  // interface showing no reason why.
  //
  // This is the same silent-ignore as `district` and `region` above: a parameter
  // that looks like a filter must be the filter.
  const workflowState = query.get('state')
  const templateId = query.get('template_id')
  const scheduleId = query.get('schedule_id')
  // `district` and `region` used to be read by nothing here. filterRecords
  // ignores parameters it does not understand, so `?district=Bor` was
  // indistinguishable from no filter at all and returned every record in the
  // collection — cross-district data handed to any caller that asked to be
  // scoped to one district. Both are now real filters.
  const districtFilter = resolveDistrictFilter(query.get('district') || query.get('region'))
  const from = query.get('from') ? Date.parse(query.get('from')) : null
  const to = query.get('to') ? Date.parse(query.get('to')) : null
  const limit = parseLimit(query.get('limit'))

  const matched = (partnerOrg ? records.filter((item) => item?.partner_org === partnerOrg) : records)
    .filter((item) => recordInBbox(item, bbox))
    .filter((item) => !country || item.country === country || item.scope?.country === country)
    .filter((item) => !source || item.source === source || item.source_name === source)
    .filter((item) => !eventType || item.event_type === eventType || item.type === eventType)
    .filter((item) => !reportType || item.report_type === reportType || item.type === reportType)
    .filter((item) => !severity || item.severity === severity || item.risk_level === severity)
    .filter((item) => !status || item.status === status)
    .filter((item) => !workflowState || item.state === workflowState)
    .filter((item) => !priority || item.priority === priority)
    .filter((item) => !incidentId || item.incident_id === incidentId || item.scope?.incident_id === incidentId || item.id === incidentId)
    .filter((item) => !interventionId || item.intervention_id === interventionId || item.scope?.intervention_id === interventionId || item.id === interventionId)
    .filter((item) => !serviceType || item.service_type === serviceType || item.scope?.service_type === serviceType)
    .filter((item) => !owner || item.owner === owner)
    .filter((item) => !templateId || item.template_id === templateId)
    .filter((item) => !scheduleId || item.schedule_id === scheduleId)
    .filter((item) => !districtFilter || recordInDistrict(item, districtFilter, districtRelations))
    .filter((item) => {
      const timestamp = Date.parse(item.observed_at || item.occurred_at || item.event_date || item.generated_at || item.approved_at || item.distributed_at || item.updated_at || item.created_at || '')
      if (!Number.isFinite(timestamp)) return true
      if (from && timestamp < from) return false
      if (to && timestamp > to) return false
      return true
    })
  return unlimited ? matched : matched.slice(0, limit)
}

/**
 * A page, plus the whole matched set it was cut from.
 *
 * Split out from `collectionPage` for the routes that carry a roll-up beside
 * their list — `/food-security`, `/disease-observations`. Those routes used to
 * compute the summary from the *capped page*, which is the same honesty failure
 * `collectionPage` exists to prevent, one layer up: a caller reading `summary`
 * had no way to know it described 500 records rather than 4,517. They need both
 * halves — the page for `data`, the full set for the roll-up — and calling
 * `filterRecords` twice to get them would be a second scan that could disagree
 * with the first.
 *
 * `matched` is not serialised by `collectionPage`; only the two routes that
 * want it read it.
 */
export function matchedAndPage(records, query, context = {}) {
  const matched = filterRecords(records, query, context, { unlimited: true })
  const cursor = decodeCursor(query.get('cursor'))
  const limit = parseLimit(query.get('limit'))

  let start = 0
  if (cursor) {
    const at = matched.findIndex((item) => item?.id === cursor)
    if (at < 0) {
      // Resuming from nothing would silently replay page one while the caller
      // believes it is reading further in. Refusing is the honest answer.
      const error = new Error(
        `cursor does not identify a record in this result set; it may have been deleted, or belong to a different query`,
      )
      error.statusCode = 400
      throw error
    }
    start = at + 1
  }

  const page = matched.slice(start, start + limit)
  const last = page.length ? page[page.length - 1] : null
  const hasMore = start + page.length < matched.length
  return {
    matched,
    returned: page.length,
    limit,
    total: matched.length,
    has_more: hasMore,
    // Only meaningful when there is a following page; a cursor to the end of
    // the set is an invitation to make one more empty request.
    next_cursor: hasMore && last ? encodeCursor(last.id) : null,
    data: page,
  }
}

/**
 * A collection response that can say how much it is not showing you.
 *
 * `filterRecords` alone answered "here are up to `limit` records" with nothing
 * about what else exists, so a caller could not distinguish an empty collection
 * from a truncated one. Every consumer that wanted to show a count had to
 * re-derive it by fetching with a raised limit, which is a second full scan
 * and a second chance to disagree with the first.
 *
 * `total` is what matched the filters, `returned` is what this page carries,
 * and `has_more` says whether asking again is worth it.
 */
export function collectionPage(records, query, context = {}) {
  const { matched, ...page } = matchedAndPage(records, query, context)
  return page
}

/**
 * Idempotency keys for mutating requests.
 *
 * In-process, with a TTL, and deliberately so: this deployment is one process
 * against one store, so the memory of an in-flight retry is the whole of the
 * problem. A retry that arrives inside the window gets the original response
 * back rather than a second incident. A retry that arrives after it gets a
 * fresh write, which is the honest behaviour -- the guarantee is bounded, and
 * the bound is reported in the header rather than implied.
 */
export function createIdempotencyStore({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 1000 } = {}) {
  const entries = new Map()

  return {
    /**
     * `undefined` means "no key, proceed". An object is the recorded outcome,
     * either `{ replay: true, status, body }` from a previous attempt or
     * `{ commit: fn }` to run and then record.
     */
    lookup(key, fingerprint) {
      if (!key) return undefined
      const hit = entries.get(key)
      if (!hit) return undefined
      if (hit.expiresAt <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      // A claim with no outcome yet. `run` records only after the work, so this
      // state means the attempt is in flight — `claim()` is what resolves it,
      // and a caller that reaches `lookup` must not read the absent outcome as
      // an empty replay.
      if (hit.pending) {
        return { inFlight: true, promise: hit.pending }
      }
      // Refresh insertion order so the eviction below is least-recently-used.
      entries.delete(key)
      entries.set(key, hit)
      // The same key with a different body is a client bug, and replaying
      // would answer with a receipt for work that was never done -- the caller
      // would read an import count describing a batch they did not send.
      if (fingerprint && hit.fingerprint && fingerprint !== hit.fingerprint) {
        return { conflict: true, status: 409, body: { success: false, error: 'Idempotency-Key was already used with a different request body' } }
      }
      return { replay: true, status: hit.status, body: hit.body }
    },

    /**
     * Claim a key before the work runs, not after it finishes.
     *
     * The store used to record an outcome only once the handler had returned, so
     * two concurrent requests with the same key both found `entries` empty and
     * both executed. The window was the **full duration of the handler**, which
     * for `POST /api/v1/ingest/run-due` is the slowest thing the service does:
     * a client that timed out and retried re-ran the entire ingestion.
     *
     * The claim is a promise stored under the key. The second request awaits it
     * and answers with the first's outcome; it does not execute anything. A
     * failure clears the claim rather than wedging the key for its whole TTL,
     * so a crashed request is retryable immediately.
     */
    claim(key, fingerprint) {
      if (!key) return { proceed: true }
      const hit = entries.get(key)
      if (hit) {
        if (hit.pending) {
          if (fingerprint && hit.fingerprint && fingerprint !== hit.fingerprint) {
            return { conflict: true, status: 409, body: { success: false, error: 'Idempotency-Key is in flight with a different request body' } }
          }
          // Refresh insertion order so eviction below is least-recently-used.
          entries.delete(key)
          entries.set(key, hit)
          return { inFlight: true, promise: hit.pending }
        }
        // A completed entry, same key, **different body**. The key names a
        // request; replaying here would answer with a receipt for work that was
        // never sent — an import count describing a batch the caller did not
        // send. This check used to live in `lookup` and was lost when the server
        // moved to `claim`, which is the kind of gap that only shows up as a
        // 409 going missing.
        if (fingerprint && hit.fingerprint && fingerprint !== hit.fingerprint) {
          return { conflict: true, status: 409, body: { success: false, error: 'Idempotency-Key was already used with a different request body' } }
        }
        // Refresh insertion order so the eviction below is least-recently-used.
        entries.delete(key)
        entries.set(key, hit)
        return { proceed: false, status: hit.status, body: hit.body }
      }
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value)
      let settle
      const pending = new Promise((resolve) => { settle = resolve })
      // Nothing awaits `pending` until a second request arrives, so it must not
      // surface as an unhandled rejection when the first request finishes.
      pending.catch(() => {})
      entries.set(key, { pending, fingerprint, expiresAt: Date.now() + ttlMs, settle })
      return { proceed: true, claim: true }
    },

    /**
     * Settle a claim with the outcome, so a concurrent caller can answer.
     *
     * Records the outcome whether or not a claim preceded it. `run()` without a
     * `claim()` is a legitimate path — it is how a caller that knows the work is
     * already serialized records its result — and requiring the claim made that
     * path a silent no-op, so the store ended up empty and every entry
     * immediately "forgotten".
     */
    settle(key, status, body, fingerprint) {
      if (!key) return
      const hit = entries.get(key)
      if (hit?.pending) {
        entries.delete(key)
        if (hit.settle) hit.settle({ status, body })
      } else if (hit) {
        entries.delete(key)
      }
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value)
      entries.set(key, { status, body, fingerprint, expiresAt: Date.now() + ttlMs })
    },

    /** Release a claim without recording an outcome, so the key is retryable. */
    release(key) {
      if (!key) return
      const hit = entries.get(key)
      if (!hit || !hit.pending) return
      entries.delete(key)
      if (hit.settle) hit.settle({ error: new Error('idempotent attempt failed') })
    },

    async run(key, status, fn, fingerprint) {
      if (!key) return await fn()
      const outcome = await fn()
      this.settle(key, status, outcome, fingerprint)
      return outcome
    },

    get size() {
      return entries.size
    },
  }
}

export function parseCsv(text) {
  if (!text || !String(text).trim()) return []
  const rows = []
  let field = ''
  let row = []
  let quoted = false
  const input = String(text).replace(/\r\n/g, '\n')
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    const next = input[i + 1]
    if (char === '"' && quoted && next === '"') {
      field += '"'
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if (char === '\n' && !quoted) {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [headers = [], ...dataRows] = rows.filter((candidate) => candidate.some((cell) => String(cell).trim()))
  return dataRows.map((cells) => Object.fromEntries(headers.map((header, index) => [header.trim(), cells[index]?.trim() ?? ''])))
}

export function toCsv(records) {
  const flatRecords = records.map((record) => flattenRecord(record))
  const headers = [...new Set(flatRecords.flatMap((record) => Object.keys(record)))].sort()
  // Headers are record keys, and a record key is still data: any field name a
  // connector invents ends up on this line. Escape it like a value — a key
  // holding a comma would otherwise shift every column to its right by one.
  const lines = [headers.map((header) => csvEscape(header)).join(',')]
  for (const record of flatRecords) {
    lines.push(headers.map((header) => csvEscape(record[header])).join(','))
  }
  return `${lines.join('\n')}\n`
}

function flattenRecord(record, prefix = '') {
  const flat = {}
  for (const [key, value] of Object.entries(record || {})) {
    const nextKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flat, flattenRecord(value, nextKey))
    } else {
      flat[nextKey] = Array.isArray(value) ? JSON.stringify(value) : value
    }
  }
  return flat
}

/**
 * A spreadsheet evaluates a cell whose first character is `=`, `+`, `-` or `@`,
 * and before it decides it discards leading tabs, carriage returns, newlines,
 * ordinary spaces and other C0 control characters. So `^=` is not the test:
 * "\t=1+1" and "  =cmd|'/c calc'!A1" both execute, and a check that only looked
 * at the literal first character would wave both through. Quoting the field is
 * no defence at all — Excel parses the content of a quoted cell exactly as it
 * parses an unquoted one; the tab-prefix and space-prefix variants are the
 * standard bypass of quoting-as-protection. The only prefix these applications
 * agree on is the apostrophe, which forces the cell to text.
 *
 * The cost is deliberate and visible: a CSV read by a machine parser — pandas,
 * R, `cut` — now sees `'=cmd...` and `'=foo` rather than the value. The value
 * is still there, one byte earlier in the row, and Excel hides the apostrophe
 * on open. Truncating or stripping the payload instead would silently rewrite
 * what a health worker wrote, and this export is also the archive people check
 * against the source record.
 *
 * Numbers are exempt, and must be. `-3.12` is a longitude, `+254700000000` is a
 * phone number, `-0.5e3` is an elevation delta; escaping them would turn every
 * numeric column of the widest read in the product into a string, which is a
 * worse failure than the one being fixed. A bare numeric literal is not a
 * formula in any of these applications — it has no operator in it to evaluate.
 * The exemption requires the number to be the whole unprefixed cell: a tab or
 * space before it is exactly the shape this function exists to distrust.
 */
function neutraliseFormula(text) {
  const probe = text.replace(/^[\s\u0000-\u001f]+/, '')
  if (!/^[=+\-@]/.test(probe)) return text
  if (probe === text && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return text
  return `'${text}`
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = neutraliseFormula(String(value))
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

/**
 * A coordinate as a number, or null when it is not one.
 *
 * The guard has to rule absence out before it asks about the number.
 * `Number.isFinite(Number(x))` looks like it does both and does neither:
 * `Number(null)` and `Number('')` are both 0, so a record on the equator and a
 * record with no coordinates at all are the same point. Whitespace is trimmed
 * for the same reason — `Number('  ')` is 0 as well.
 *
 * This is why `toGeoJson` filters on `readCoordinate` rather than on
 * `Number.isFinite(item.latitude)`: a coordinate that arrived as the string
 * `"3.12"` is a real coordinate, and the STAC path has always accepted it.
 */
export function readCoordinate(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Fields a spatial catalogue must not carry, whatever collection it is asked
 * about.
 *
 * STAC and OGC are interoperability surfaces: the whole point of them is that
 * a record goes out to a client that did not ask us which fields it may have.
 * So the question is not "is this collection sensitive today" — the three
 * exposed today are hazards, service assets and risk scores, and none of them
 * carries a person — but "what happens when someone adds a collection that
 * does". The previous answer was: every field, including the free-text message
 * and the reporter hash, because the renderer spread the whole record.
 *
 * A denylist rather than an allowlist, deliberately. An allowlist would be
 * safer still and would also mean a new collection renders as a list of nulls
 * until someone remembers it, which is how interoperability surfaces rot: the
 * response is well-formed, so nothing complains. This list is about the fields
 * that identify a person or a secret, which do not get added to a hazard
 * catalogue by accident.
 */
const NEVER_PUBLISHED = new Set([
  'latitude', 'longitude',
  'reporter_urn_hash', 'reporter', 'reporter_name',
  'message', 'notes', 'note', 'comment', 'comments', 'description_detail',
  'phone', 'phone_number', 'email', 'contact', 'contact_details',
  'api_key', 'token', 'secret', 'password', 'authorization',
])

/**
 * The record's fields minus the coordinates (carried as geometry) and the ones
 * above. Case-insensitive, because a connector that names a field `Message`
 * leaks exactly as much as one that names it `message`.
 */
export function publicProperties(record) {
  return Object.fromEntries(
    Object.entries(record || {}).filter(([key]) => !NEVER_PUBLISHED.has(key.toLowerCase()))
  )
}

export function toGeoJson(records) {
  return {
    type: 'FeatureCollection',
    features: records
      .map((item) => ({ item, lat: readCoordinate(item.latitude), lon: readCoordinate(item.longitude) }))
      .filter(({ lat, lon }) => lat !== null && lon !== null)
      .map(({ item, lat, lon }) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lon, lat],
        },
        properties: publicProperties(item),
      })),
  }
}

/**
 * A JSON response that can be revalidated.
 *
 * The static-asset path already computed ETags; the API did not, so every poll
 * from every open dashboard transferred the full payload to be told nothing had
 * changed. The console redraws on a 30-second timer, which is twelve-plus
 * endpoints re-downloading unchanged data per minute per user.
 *
 * `no-store` is deliberately dropped in favour of `no-cache` + an ETag: the
 * response must not be cached without revalidation, and it must be
 * revalidatable. `304` carries no body, which is the entire point.
 */
export function jsonResponse(res, status, body, headers = {}, req = res?.req || null) {
  const payload = JSON.stringify(body)
  // Vary on the credential, so no cache between here and the browser — the
  // service worker's Cache API included — may serve one caller's body to
  // another. It is the shared-device case: a district phone handed to the next
  // health worker, the worker offline, the previous worker's districts served
  // from cache for a week because the detail bucket has a 7-day TTL.
  //
  // Both credential headers are named because both are accepted (auth.js reads
  // `authorization` and falls back to `x-api-key`); a Vary naming only one of
  // them protects the path nobody uses.
  const outgoing = {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
    vary: headers.vary || headers.Vary || 'authorization, x-api-key',
  }

  if (status === 200 && req && !headers.etag && !headers.ETag) {
    const etag = etagFor(payload)
    outgoing.etag = etag
    outgoing['cache-control'] = 'no-cache'
    const tags = ifNoneMatch(req)
    if (tags.includes('*') || tags.includes(etag)) {
      // The 304 carries the same Vary as the 200 it stands in for. A 304
      // without it is the leak with extra steps: a cache stores the
      // revalidation under no vary condition at all.
      res.writeHead(304, { etag, 'cache-control': 'no-cache', vary: outgoing.vary })
      res.end()
      return
    }
  }
  if (!outgoing['cache-control']) outgoing['cache-control'] = 'no-store'
  // Idempotency replay needs the body that was actually sent. Captured here,
  // where every response passes, rather than at the call sites.
  if (res.__capture) {
    try {
      res.__capture(status, JSON.parse(payload))
    } catch {
      // A non-JSON body is not replayable; the first attempt still succeeded.
    }
  }
  res.writeHead(status, outgoing)
  res.end(payload)
}

/**
 * `If-None-Match` per RFC 9110: a list of tags, `*`, or weak tags.
 *
 * Weak comparison is correct here: the tag identifies the representation, and
 * a byte-identical body serialised twice must match regardless of how either
 * side chose to label its strength.
 */
function ifNoneMatch(req) {
  const header = req?.headers?.['if-none-match']
  if (!header) return []
  const raw = String(header).trim()
  if (raw === '*') return ['*']
  return raw.split(',').map((entry) => entry.trim().replace(/^W\//, ''))
}

function etagFor(payload) {
  return `"${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)}"`
}

export function encodeCursor(id) {
  if (!id) return null
  return Buffer.from(String(id), 'utf8').toString('base64url')
}

export function decodeCursor(raw) {
  if (!raw) return null
  try {
    return Buffer.from(String(raw), 'base64url').toString('utf8')
  } catch {
    return null
  }
}

const DEFAULT_MAX_BODY_BYTES = Number(process.env.LINDELA_LITE_MAX_BODY_BYTES || 5 * 1024 * 1024)

/**
 * Buffers the request body once and caches it on `req.__rawBody`.
 *
 * A webhook signature covers the exact bytes sent, so verification has to
 * happen after buffering but before anything interprets the body. Draining the
 * stream twice yields nothing the second time — the chunks are gone — which is
 * why this caches and why readRequestJson() reuses it.
 */
export async function readRawBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  if (req.__rawBody !== undefined) return req.__rawBody

  // Check Content-Length first so an oversized upload is rejected before it is
  // buffered. This is advisory: it can lie, so the streaming check below is
  // the authoritative one.
  const declaredLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw Object.assign(
      new Error(`Request body too large: ${declaredLength} bytes exceeds limit of ${maxBytes}`),
      { statusCode: 413 }
    )
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      throw Object.assign(
        new Error(`Request body too large: exceeds limit of ${maxBytes} bytes`),
        { statusCode: 413 }
      )
    }
    chunks.push(chunk)
  }

  req.__rawBody = Buffer.concat(chunks).toString('utf8')
  return req.__rawBody
}

export async function readRequestJson(req, options = {}) {
  const raw = await readRawBody(req, options)
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 })
  }
}

export function haversineKm(a, b) {
  const earthRadiusKm = 6371
  const dLat = radians(b.latitude - a.latitude)
  const dLon = radians(b.longitude - a.longitude)
  const lat1 = radians(a.latitude)
  const lat2 = radians(b.latitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h))
}

function radians(value) {
  return value * Math.PI / 180
}

/**
 * Resolve a `district` or `region` filter value to a known district.
 *
 * An unknown value is returned as-is so `recordInDistrict` can match nothing,
 * rather than being dropped and silently ignored the way it was before: a
 * misspelled district should return nothing, not everything.
 */
export function resolveDistrictFilter(value) {
  if (value === null || value === undefined || value === '') return null
  const key = String(value).trim().toLowerCase()
  if (!key) return null
  const known = KNOWN_DISTRICTS.find(
    (d) => d.slug === key || d.name.toLowerCase() === key,
  )
  return known || { slug: key, name: value, center: null, radius_km: null, unknown: true }
}

/**
 * Does this record belong to the district?
 *
 * Matched on an explicit label where the record has one, otherwise spatially
 * against the district extent. A record with neither is not in the district —
 * the same rule the report scope uses, so an API filter and a report cannot
 * disagree about what is in Turkana.
 */
export function recordInDistrict(item, district, relations = null) {
  if (!district) return true
  const labels = [district.slug, district.name, String(district.name).toLowerCase()]
  const named = [item.district, item.region, item.region_name, item.admin1, item.scope?.district]
  for (const value of named) {
    if (typeof value !== 'string') continue
    if (labels.some((label) => label && label.toLowerCase() === value.toLowerCase())) return true
  }
  // Multi-value labels, e.g. an event covering "Turkana, Bor".
  for (const value of named) {
    if (typeof value !== 'string') continue
    const parts = value.split(/[,;/]/).map((part) => part.trim().toLowerCase())
    if (parts.some((part) => labels.some((label) => label && label.toLowerCase() === part))) return true
  }
  if (district.center && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
    const distance = haversineKm(
      { latitude: district.center.lat, longitude: district.center.lon },
      { latitude: item.latitude, longitude: item.longitude },
    )
    return distance <= district.radius_km
  }
  // Interventions, their tasks and alert dispatches carry no coordinates and no
  // district field. Filtered directly they match nothing, so every district
  // reported no activity while interventions were attached to it — which reads
  // as a finding rather than as an absence of data. They are reached through the
  // record that does carry a location, the same way `districtOverview` does it,
  // so the list endpoints and the district overview cannot disagree.
  if (relations) {
    for (const key of DISTRICT_RELATION_KEYS) {
      const relatedId = item[key]
      if (!relatedId) continue
      const state = relations.get(relatedId)
      if (state === true) return true
      if (state === false) return false
    }
  }
  return false
}

const DISTRICT_RELATION_KEYS = ['incident_id', 'intervention_id', 'alert_event_id']

/**
 * Collections whose records carry no location of their own, and the chain of
 * collections to attribute them through, nearest first. Interventions hang off
 * an incident; their tasks hang off the intervention; dispatches hang off the
 * alert event.
 */
const DISTRICT_PARENT_CHAINS = {
  interventions: ['incidents', 'interventions'],
  intervention_tasks: ['incidents', 'interventions', 'intervention_tasks'],
  rapidpro_dispatches: ['alert_events', 'rapidpro_dispatches'],
  rapidpro_inbound_messages: ['alert_events', 'rapidpro_inbound_messages'],
}

/**
 * Map each record id in the chain's last collection to whether it falls in the
 * district, so children with no location of their own are attributed through the
 * nearest ancestor that has one.
 */
function buildDistrictRelations(data, collection, district) {
  const chain = DISTRICT_PARENT_CHAINS[collection]
  if (!data || !district || !chain) return null
  // Every level but the last. The last entry is the collection being filtered,
  // and its records are attributed by looking their parent id up in the map
  // returned here — so returning that level's own map would key intervention ids
  // where incident ids are looked for, and every lookup would miss.
  let relations = null
  for (const name of chain.slice(0, -1)) {
    const next = new Map()
    for (const record of data[name] || []) {
      if (!record?.id) continue
      next.set(record.id, recordInDistrict(record, district, relations))
    }
    relations = next
  }
  return relations
}
