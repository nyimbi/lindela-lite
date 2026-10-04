// =============================================================
// Lindela Lite — shareable district view state
// =============================================================
//
// The console has shared its view by URL since `shared/view-state.js`. A
// district officer describing "the one with four open alerts and no assets" had
// no way to send that view, only a screenshot — which ages, crops and lies.
// This is the same mechanism applied to `/districts/`: the text query, the
// attention-only toggle, and the district being looked at.
//
// Pure functions, no DOM, no globals, for the reason `shared/paging.js` and
// `shared/view-state.js` give: view logic that can only be exercised by driving
// a page is view logic nobody has run. `test/districts-view.test.js` runs these
// under `node --test`.
//
// Why this is a second module rather than three more entries in view-state's
// FIELDS. Those fields are the console's: `tab`, `window`, `severity`, `layer`,
// a map transform — and a `selected` that means one alert record, not one
// district. Adding `query`/`attentionOnly` to that list would change what
// `decodeView` accepts on every console URL, so a districts link pasted into the
// console would be half-applied there. The two surfaces have different state and
// different routes; the honest response is a second versioned encoding, not a
// union. What is shared is the discipline:
//
//   - deterministic: the same view always encodes to the same link, or "copy
//     link" copies something the sender did not see;
//   - diff-only: only what differs from the default is written, so a link
//     carries the decision being made rather than a page dump;
//   - versioned: a link that outlives this encoding is reported, not decoded
//     into a confidently wrong view.

export const DISTRICTS_VIEW_VERSION = 'v1'

/** What a districts link with no parameters means. */
export const DISTRICTS_VIEW_DEFAULTS = Object.freeze({
  query: '',
  attentionOnly: false,
  selected: '',
})

/**
 * Fields that encode to the query string, in a fixed order.
 *
 * `selected` is deliberately not among them. `/districts/` routes by hash —
 * `#/baringo` — and a district card's `href` already carries it, so the district
 * has a channel and a query parameter would be a second spelling of one value.
 * Two spellings is two things that can disagree; `districtsShareUrl` writes the
 * district into the fragment and `resolveDistrictsView` reads it from there.
 */
const FIELDS = Object.freeze(['query', 'attentionOnly'])

/** Absent rather than falsy, so `?query=` is distinguishable from no `query`. */
function encodeValue(value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

/**
 * Encode a districts view to a query string.
 *
 * Only what differs from `DISTRICTS_VIEW_DEFAULTS` is written, for the reason
 * `encodeView` gives: a receiver applying every field including the defaults
 * would stop seeing those defaults deliberately in place.
 */
export function encodeDistrictsView(view = {}) {
  const params = new URLSearchParams()
  params.set('v', DISTRICTS_VIEW_VERSION)

  for (const field of FIELDS) {
    const value = encodeValue(view[field])
    if (value === null) continue
    if (view[field] === DISTRICTS_VIEW_DEFAULTS[field]) continue
    // A boolean, not a string: `?attentionOnly=true` would be a second
    // spelling of the same state, and which one a link carried would then be a
    // question about the sender's encoder rather than about the view.
    params.set(field, field === 'attentionOnly' ? (value === 'true' ? '1' : '0') : value)
  }

  return params.toString()
}

/**
 * Decode a query string into a partial districts view.
 *
 * A version this build does not know still decodes the fields it does know — a
 * link from a later build is usually still mostly right — but says so, and
 * anything unrecognised is dropped rather than guessed at. A wrong filter looks
 * like data.
 */
export function decodeDistrictsView(search = '') {
  const params = new URLSearchParams(String(search).replace(/^[?#]/, ''))
  if (!params.toString()) return {}

  const version = params.get('v')
  const view = decodeKnown(params)
  if (version && version !== DISTRICTS_VIEW_VERSION) return { ...view, _fromVersion: version }
  return view
}

function decodeKnown(params) {
  const view = {}
  if (params.has('query')) {
    const value = params.get('query')
    if (value !== '') view.query = value
  }
  if (params.has('attentionOnly')) {
    // Only the affirmative is honoured. `attentionOnly=0` and a missing
    // parameter mean the same thing, and reading `0` as true would invert the
    // one filter a link can get wrong silently.
    if (params.get('attentionOnly') === '1') view.attentionOnly = true
  }
  return view
}

/**
 * The districts defaults with a link's values layered on.
 *
 * The district is read from the hash, because that is the route: a card's href
 * was the link that worked before this module existed, and it must keep
 * working. A hash outranks a stale `?selected`, for the same reason a card
 * click beats a link the reader followed earlier.
 */
export function resolveDistrictsView({ search, hash } = {}) {
  const fromLink = search ? decodeDistrictsView(search) : {}
  const fromHash = String(hash || '').replace(/^[#\/]+/, '')
  const selected = fromHash ? decodeURIComponent(fromHash) : ''
  return { ...DISTRICTS_VIEW_DEFAULTS, ...fromLink, ...(selected ? { selected } : {}) }
}

/** A full shareable URL for a districts view. */
export function districtsShareUrl(view, { origin, pathname = '/districts/' } = {}) {
  const query = encodeDistrictsView(view)
  const selected = encodeValue(view && view.selected)
  const fragment = selected ? `#/${encodeURIComponent(selected)}` : ''
  const base = origin || (typeof location !== 'undefined' ? location.origin : '')
  return `${base}${pathname}${query ? `?${query}` : ''}${fragment}`
}

/**
 * Whether the districts view differs from the default.
 *
 * The copy control shows itself only when there is something to pass on. A copy
 * button on an untouched list invites someone to send a link that says nothing
 * they had not already sent.
 */
export function isDistrictsViewCustom(view = {}) {
  const query = encodeValue(view.query)
  if (query !== null && query !== DISTRICTS_VIEW_DEFAULTS.query) return true
  if (view.attentionOnly === true) return true
  return encodeValue(view.selected) !== null
}