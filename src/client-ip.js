/**
 * Client IP handling for inbound request logging and abuse detection.
 *
 * Scope: this only inspects traffic Lindela already receives. It resolves the
 * peer's address from the socket, classifies it, and optionally reads a country
 * code supplied by an operator-controlled reverse proxy. It performs no
 * third-party lookups and holds no GeoIP database.
 *
 * Consequences of that choice, stated plainly:
 * - Address *scope* (loopback, private, CGNAT, public) is computed exactly, offline.
 * - *Country* is not derivable from an address without a GeoIP database. It is
 *   populated only when a trusted edge proxy supplies it via a header. Requests
 *   without one get country: null, not a guess.
 *
 * Trust model: X-Forwarded-For and friends are client-controlled unless a
 * proxy sits in front. Honouring them by default would let any caller forge an
 * address and poison the abuse signal, so they are ignored unless trustProxy is
 * explicitly enabled.
 */

const IPV4_RANGES = [
  // 0.0.0.0/8 is ordered last of the "wider than it looks" prefixes on
  // purpose: it must not shadow 10/8, 100.64/10, 127/8 or 169.254/16.
  { prefix: '10.0.0.0', bits: 8, scope: 'private' },
  { prefix: '100.64.0.0', bits: 10, scope: 'cgnat' },
  { prefix: '127.0.0.0', bits: 8, scope: 'loopback' },
  { prefix: '169.254.0.0', bits: 16, scope: 'link_local' },
  { prefix: '172.16.0.0', bits: 12, scope: 'private' },
  { prefix: '192.0.0.0', bits: 24, scope: 'protocol_assignment' },
  { prefix: '192.0.2.0', bits: 24, scope: 'documentation' },
  { prefix: '192.88.99.0', bits: 24, scope: 'protocol_assignment' },
  { prefix: '192.168.0.0', bits: 16, scope: 'private' },
  { prefix: '198.18.0.0', bits: 15, scope: 'benchmarking' },
  { prefix: '198.51.100.0', bits: 24, scope: 'documentation' },
  { prefix: '203.0.113.0', bits: 24, scope: 'documentation' },
  { prefix: '224.0.0.0', bits: 4, scope: 'multicast' },
  { prefix: '240.0.0.0', bits: 4, scope: 'reserved' },
  { prefix: '0.0.0.0', bits: 8, scope: 'unspecified' },
]

const IPV6_RANGES = [
  { prefix: '::', bits: 128, scope: 'unspecified' },
  { prefix: '::1', bits: 128, scope: 'loopback' },
  { prefix: 'fc00::', bits: 7, scope: 'private' },
  { prefix: 'fe80::', bits: 10, scope: 'link_local' },
  { prefix: 'ff00::', bits: 8, scope: 'multicast' },
  { prefix: '2001:db8::', bits: 32, scope: 'documentation' },
  { prefix: '100::', bits: 64, scope: 'reserved' },
]

// Headers an operator-controlled edge proxy may use to pass the client country.
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-country-code', 'x-geo-country', 'x-appengine-country']

/**
 * Returns true when forwarded-for headers should be believed.
 */
export function trustProxyEnabled(explicit) {
  if (explicit !== undefined) return Boolean(explicit)
  const raw = process.env.LINDELA_LITE_TRUST_PROXY
  if (!raw) return false
  const value = String(raw).trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/**
 * Strips an IPv6 zone index and brackets, and unwraps IPv4-mapped IPv6
 * (::ffff:127.0.0.1), which Node reports for IPv4 peers on dual-stack sockets.
 */
export function normalizeIp(value) {
  if (!value) return null
  let ip = String(value).trim()
  if (!ip) return null

  // [::1]:1234 -> ::1
  if (ip.startsWith('[')) {
    const close = ip.indexOf(']')
    if (close !== -1) ip = ip.slice(1, close)
  }
  // fe80::1%eth0 -> fe80::1
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)

  // ::ffff:203.0.113.5 and ::ffff:cb00:7105 -> the IPv4 address
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped) return mapped[1]
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  }
  return ip.toLowerCase()
}

function ipv4ToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function ipv6ToInt(ip) {
  // Expand :: and any embedded IPv4 tail into eight 16-bit groups.
  let head = ip
  let tailGroups = []
  const embeddedV4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embeddedV4) {
    const v4 = ipv4ToInt(embeddedV4[1])
    if (v4 === null) return null
    head = ip.slice(0, embeddedV4.index).replace(/:$/, '')
    tailGroups = [(v4 >> 16) & 0xffff, v4 & 0xffff]
  }
  const halves = head.split('::')
  if (halves.length > 2) return null
  const headGroups = halves[0] ? halves[0].split(':') : []
  const bodyGroups = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const filler = Array(Math.max(0, 8 - headGroups.length - bodyGroups.length - tailGroups.length)).fill('0')
  const groups = [...headGroups, ...filler, ...bodyGroups, ...tailGroups]
  if (groups.length !== 8) return null
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    value = (value << 16n) | BigInt(parseInt(group, 16))
  }
  return value
}

function inRange(intValue, prefix, bits, isV6) {
  const base = isV6 ? ipv6ToInt(prefix) : ipv4ToInt(prefix)
  if (base === null || intValue === null) return false
  if (bits === 0) return true
  const width = isV6 ? 128n : 32n
  const shift = width - BigInt(bits)
  const mask = ((1n << BigInt(bits)) - 1n) << shift
  const limit = 1n << width
  return intValue < limit && ((intValue >> shift) & mask) === ((base >> shift) & mask)
}

/**
 * Classifies an address into a scope. Exact and offline.
 * Returns 'public' for globally routable addresses.
 */
export function classifyIp(value) {
  const ip = normalizeIp(value)
  if (!ip) return { ip: null, version: null, scope: 'unknown' }

  const isV6 = ip.includes(':')
  const intValue = isV6 ? ipv6ToInt(ip) : ipv4ToInt(ip)
  if (intValue === null) {
    return { ip, version: isV6 ? 6 : 4, scope: 'unparseable' }
  }

  const ranges = isV6 ? IPV6_RANGES : IPV4_RANGES
  for (const range of ranges) {
    if (inRange(intValue, range.prefix, range.bits, isV6)) {
      return { ip, version: isV6 ? 6 : 4, scope: range.scope }
    }
  }
  return { ip, version: isV6 ? 6 : 4, scope: 'public' }
}

/** Scopes that never represent a real remote client. */
const NON_CLIENT_SCOPES = new Set([
  'loopback', 'private', 'link_local', 'unspecified', 'cgnat', 'documentation',
  'benchmarking', 'protocol_assignment', 'reserved', 'multicast', 'unknown', 'unparseable',
])

export function isRoutableScope(scope) {
  return scope === 'public'
}

/**
 * Reads a client country from edge-proxy headers. Returns null when absent,
 * when the header is a placeholder, or when the proxy is not trusted.
 */
export function countryFromHeaders(headers = {}, { trustProxy = false } = {}) {
  if (!trustProxy) return null
  for (const name of COUNTRY_HEADERS) {
    const value = headers[name]
    if (!value) continue
    const code = String(value).trim().toUpperCase()
    // Cloudflare sends XX when it cannot geolocate, and T1 for Tor.
    if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') continue
    return code
  }
  return null
}

/**
 * Truncates an address for logging so a full identifier is not written to disk.
 * IPv4 keeps the first three octets; IPv6 keeps the first three groups.
 * Pass full: true to log the complete address.
 */
export function truncateIp(value, { full = false } = {}) {
  const ip = normalizeIp(value)
  if (!ip || full) return ip

  if (!ip.includes(':')) {
    const parts = ip.split('.')
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip
  }
  const groups = ip.split(':').filter(Boolean)
  if (groups.length <= 3) return ip
  return `${groups.slice(0, 3).join(':')}::/48`
}

/**
 * Resolves and classifies the peer for an inbound request.
 *
 * Only reads X-Forwarded-For when trustProxy is set, and takes the
 * right-most entry, which is the one the trusted proxy actually observed.
 */
export function describeClient(req, options = {}) {
  const trustProxy = options.trustProxy ?? trustProxyEnabled(options.trustProxy)
  const raw = trustProxy
    ? rightmostForwarded(req.headers?.['x-forwarded-for'])
    : null
  const address = raw || req.socket?.remoteAddress || null
  const classified = classifyIp(address)
  const country = countryFromHeaders(req.headers || {}, { trustProxy })

  return {
    ip: classified.ip,
    truncated: truncateIp(address, { full: options.fullIp }),
    scope: classified.scope,
    version: classified.version,
    country,
    routable: isRoutableScope(classified.scope),
    source: raw ? 'forwarded' : 'socket',
    trusted_proxy: trustProxy,
  }
}

function rightmostForwarded(value) {
  if (!value) return null
  const parts = String(value).split(',').map((part) => part.trim()).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
}

/**
 * A stable, non-reversible handle for correlating repeat requests from one
 * address in memory without persisting the address itself. Intended for rate
 * limiting; not suitable for identifying a person.
 */
export function clientKey(value) {
  const ip = normalizeIp(value)
  if (!ip) return 'unknown'
  return classifyIp(ip).scope === 'public' ? `pub:${ip}` : `local:${classifyIp(ip).scope}`
}