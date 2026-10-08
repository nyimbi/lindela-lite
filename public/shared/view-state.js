// =============================================================
// Lindela Lite — shareable view state
// =============================================================
//
// Deciding an argument by link instead of by screenshot. An operator sends a
// focal point the exact view they are describing; the recipient opens it and
// sees the same filters, the same extent and the same selected record.
//
// Pure functions, no DOM, no globals — so it is testable without a browser and
// usable by every surface, not just the console. This is the same reasoning as
// `shared/paging.js`: view logic that can only be exercised by driving a page
// is view logic nobody has run.
//
// A URL is a claim about what someone was looking at. Two rules follow:
// the encoding is deterministic, so the same view always produces the same link
// (otherwise "copy link" copies something the sender did not see); and it is
// versioned, so a link that outlives the encoding does not decode into a
// confidently wrong view.

export const VIEW_STATE_VERSION = 'v1'

/**
 * The state worth sharing, per surface role.
 *
 * `operator` is the console. The others are what each audience arrives
 * expecting to be looking at, so opening a shared link does not overwrite
 * someone's role default with a stranger's filter set.
 */
export const ROLE_DEFAULTS = Object.freeze({
  operator:    { tab: 'alerts', window: '7d', layer: 'risk' },
  'focal-point': { tab: 'alerts', window: '30d', layer: 'risk' },
  analyst:     { tab: 'equity', window: '30d', layer: 'impact' },
  co:          { tab: 'kpi', window: '30d', layer: 'reach' },
  district:    { tab: 'situation', window: '7d', layer: 'risk' },
  partner:     { tab: 'risk', window: 'all', layer: 'risk' },
  chw:         { tab: 'home', window: '7d', layer: 'none' },
})

/** Fields that encode to the URL, in a fixed order. */
const FIELDS = Object.freeze([
  'tab', 'window', 'severity', 'source', 'asset', 'layer',
  'focus', 'selected', 'assetType', 'chart',
])

/** Values that are absent rather than falsy, so `?layer=` is distinguishable. */
function encodeValue(value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

// The interactive handlers clamp scale to this range (`app.js` pan/zoom); a
// link is held to the same bounds so a hand-edited URL cannot push the scene
// somewhere the UI itself would never put it.
export const MAP_SCALE_MIN = 0.3
export const MAP_SCALE_MAX = 10
// translate() offsets are in viewBox units on an 800×500 scene; anything this
// far out puts every layer — basemap tiles included — off-canvas.
export const MAP_TRANSLATE_MAX = 2000

/**
 * A `map=x,y,scale` triple is trusted only as far as the UI's own limits. Any
 * out-of-range part voids the whole triple rather than being repaired piecemeal:
 * a wrong frame is worse than no frame — it looks like data, and worse, it
 * re-encodes itself into every link copied from the corrupted view. Scale alone
 * is clamped, because a slightly eager zoom is recoverable where a lost scene
 * is not.
 */
export function sanitizeMapTransform(map) {
  if (!map || typeof map !== 'object') return null
  const { x, y, scale } = map
  for (const n of [x, y, scale]) {
    if (n !== undefined && !Number.isFinite(n)) return null
  }
  if ((x !== undefined && Math.abs(x) > MAP_TRANSLATE_MAX) ||
      (y !== undefined && Math.abs(y) > MAP_TRANSLATE_MAX)) return null
  const out = {}
  if (x !== undefined) out.x = x
  if (y !== undefined) out.y = y
  if (scale !== undefined) out.scale = Math.min(MAP_SCALE_MAX, Math.max(MAP_SCALE_MIN, scale))
  return Object.keys(out).length ? out : null
}

/**
 * Encode a view to a query string.
 *
 * Only fields that differ from the role's default are written. A link should
 * carry the decision being made, not a full page dump: a receiver applying
 * every field including the defaults will stop seeing changes the role defaults
 * make deliberately.
 */
export function encodeView(view = {}, { role = 'operator' } = {}) {
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.operator
  const params = new URLSearchParams()
  params.set('v', VIEW_STATE_VERSION)

  for (const field of FIELDS) {
    const value = encodeValue(view[field])
    if (value === null) continue
    if (defaults[field] !== undefined && defaults[field] === view[field]) continue
    params.set(field, value)
  }

  // The map transform only earns a place in a link when it is not the identity:
  // a shared view of a panned map is the whole point, but `x=0&y=0&s=1` in every
  // link is noise.
  const { x, y, scale } = view.map || {}
  if (Number.isFinite(x) || Number.isFinite(y) || Number.isFinite(scale)) {
    const parts = []
    if (Number.isFinite(x) && x !== 0) parts.push(round(x, 3))
    if (Number.isFinite(y) && y !== 0) parts.push(round(y, 3))
    if (Number.isFinite(scale) && scale !== 1) parts.push(round(scale, 4))
    if (parts.length) params.set('map', parts.join(','))
  }

  return params.toString()
}

/** Round for a stable encoding: 0.1 + 0.2 must not become two different links. */
function round(n, places) {
  const factor = 10 ** places
  return String(Math.round(n * factor) / factor)
}

/**
 * Decode a query string into a partial view.
 *
 * A link written by a later version, or by hand, yields only the fields it
 * named. Anything unrecognised is dropped rather than guessed at, because a
 * wrong filter is worse than no filter — it looks like data.
 */
export function decodeView(search = '') {
  const params = new URLSearchParams(String(search).replace(/^[?#]/, ''))
  if (!params.toString()) return {}

  const version = params.get('v')
  if (version && version !== VIEW_STATE_VERSION) {
    // A newer encoder wrote this. The known fields still decode; anything it
    // added is dropped rather than interpreted with this version's meaning.
    const known = decodeKnown(params)
    return { ...known, _fromVersion: version }
  }
  return decodeKnown(params)
}

function decodeKnown(params) {
  const view = {}
  for (const field of FIELDS) {
    if (params.has(field)) {
      const value = params.get(field)
      if (value !== '') view[field] = value
    }
  }

  const map = params.get('map')
  if (map) {
    // Every segment must be a finite number: a triple with a garbage part is a
    // corrupted claim, not a partial one, and corrupted claims are dropped
    // whole rather than guessed at.
    const parts = map.split(',').map(Number)
    if (parts.length <= 3 && parts.every((n) => Number.isFinite(n))) {
      const [x, y, scale] = parts
      const sane = sanitizeMapTransform({
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(scale !== undefined ? { scale } : {}),
      })
      if (sane) view.map = sane
    }
  }
  return view
}

/**
 * A role's default view with `override` layered on.
 *
 * Named view comes last, not first, so a link cannot quietly reset a role
 * default — it can only narrow it.
 */
export function resolveView({ search, role = 'operator', view } = {}) {
  const base = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.operator
  const fromLink = search ? decodeView(search) : {}
  const named = view || {}
  return { ...base, ...named, ...fromLink }
}

/** A full shareable URL for the current view. */
export function shareUrl(view, { role = 'operator', origin, pathname = '/' } = {}) {
  const query = encodeView(view, { role })
  const base = origin || (typeof location !== 'undefined' ? location.origin : '')
  return `${base}${pathname}${query ? `?${query}` : ''}`
}

/**
 * Whether the current view differs from the role default.
 *
 * The share control shows itself only when there is something to share. A share
 * button on an untouched default view invites people to send a link that says
 * nothing.
 */
export function isCustom(view = {}, { role = 'operator' } = {}) {
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.operator
  // Over the view's fields, not the defaults'. Iterating the defaults misses
  // every field that has no default — which is `severity`, `source` and most of
  // the rest, so a filtered console would never offer to share the filter.
  return Object.entries(view).some(([field, candidate]) => {
    if (field === 'map') {
      const t = candidate || {}
      return t.x !== 0 || t.y !== 0 || (t.scale !== undefined && t.scale !== 1)
    }
    if (candidate === undefined || candidate === null || candidate === '') return false
    return defaults[field] !== candidate
  })
}