import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import { stableId, nowIso } from './utils.js'

// Ranges that must never be reachable from a subscriber-supplied webhook target.
// Anything here is either the platform's own infrastructure, a cloud metadata
// service, or a private network on the operator's LAN that no external
// subscriber — partner organisation or not — was ever meant to reach.
const NON_PUBLIC_IPV4 = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // RFC6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local; AWS/GCP metadata lives at 169.254.169.254
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
]

const NON_PUBLIC_IPV6 = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function ipv4Bytes(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return bytes.some((n) => Number.isNaN(n) || n > 255) ? null : bytes
}

function ipv6Bytes(address) {
  // A zone id (%eth0) only ever appears on link-local addresses, which we reject anyway.
  let value = address.toLowerCase().split('%')[0]
  value = value.replace(/\d{1,3}(?:\.\d{1,3}){3}$/, (tail) => {
    const octets = tail.split('.').map(Number)
    if (octets.some((n) => n > 255)) return tail
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    return `${high}:${low}`
  })

  const halves = value.split('::')
  if (halves.length > 2) return null
  const parseHalf = (half) => {
    if (!half) return []
    const groups = []
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      groups.push(parseInt(group, 16))
    }
    return groups
  }

  const head = parseHalf(halves[0])
  const tail = parseHalf(halves.length === 2 ? halves[1] : '')
  if (head === null || tail === null) return null
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null

  const groups = [...head, ...new Array(fill).fill(0), ...tail]
  if (groups.length !== 8) return null
  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff])
}

function addressBytes(address) {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const version = net.isIP(bare)
  if (version === 4) return ipv4Bytes(bare)
  if (version === 6) return ipv6Bytes(bare)
  return null
}

function inCidr(bytes, base, bits) {
  const prefix = addressBytes(base)
  if (!prefix || prefix.length !== bytes.length) return false
  const fullBytes = bits >> 3
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== prefix[i]) return false
  }
  const remainder = bits & 7
  if (remainder) {
    const mask = (0xff << (8 - remainder)) & 0xff
    if ((bytes[fullBytes] & mask) !== (prefix[fullBytes] & mask)) return false
  }
  return true
}

// IPv6 forms that carry an IPv4 address inside them; the embedded address is
// what a packet would actually reach, so that is what gets checked.
function embeddedIpv4(bytes) {
  const zeroes = bytes.slice(0, 12).every((b) => b === 0)
  if (zeroes || (bytes[10] === 0xff && bytes[11] === 0xff)) return bytes.slice(12) // ::/96, ::ffff:0:0/96
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((b) => b === 0)) return bytes.slice(12) // NAT64 64:ff9b::/96
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6) // 6to4 2002::/16
  return null
}

export function isPublicAddress(address) {
  const bytes = addressBytes(address)
  if (!bytes) return false
  if (bytes.length === 4) return !NON_PUBLIC_IPV4.some(([base, bits]) => inCidr(bytes, base, bits))
  const inner = embeddedIpv4(bytes)
  if (inner) return !NON_PUBLIC_IPV4.some(([base, bits]) => inCidr(inner, base, bits))
  return !NON_PUBLIC_IPV6.some(([base, bits]) => inCidr(bytes, base, bits))
}

function parseWebhookUrl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) throw badRequest('url must be an HTTPS or HTTP URL')

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw badRequest('url must be an HTTPS or HTTP URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('url must use the http or https scheme')
  }
  if (parsed.username || parsed.password) {
    throw badRequest('url must not embed credentials')
  }
  return parsed
}

function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

// Structural half of the check: scheme, credentials, and any address literal.
// Used synchronously at subscription time, where DNS has not been consulted yet.
function assertWebhookUrlShape(raw) {
  const parsed = parseWebhookUrl(raw)
  const hostname = stripBrackets(parsed.hostname)
  if (net.isIP(hostname) && !isPublicAddress(hostname)) {
    throw badRequest(`url points at a non-public address: ${hostname}`)
  }
  return parsed
}

// Full check, including DNS. Must run at the point of use as well as at
// registration: a hostname that resolved to a public address when the
// subscription was created can resolve to 127.0.0.1 minutes later.
export async function assertSafeWebhookUrl(raw) {
  const parsed = assertWebhookUrlShape(raw)
  const hostname = stripBrackets(parsed.hostname)

  let addresses
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch {
    throw badRequest(`url host ${hostname} could not be resolved`)
  }
  if (!addresses.length) throw badRequest(`url host ${hostname} could not be resolved`)

  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw badRequest(`url host ${hostname} resolves to a non-public address: ${address}`)
    }
  }
  return parsed.href
}

export function normalizeWebhookSubscription(input, existing = null) {
  const id = input.id || existing?.id || stableId('webhook', [input.url, JSON.stringify(input.events)])
  const url = assertWebhookUrlShape(input.url).href

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

// Globs are matched by scanning, never by compiling a RegExp from caller input.
// Translating `*` to `.*` and escaping everything else still leaves catastrophic
// backtracking reachable — `*a*a*a*a*a*a*a*a*b` is not exponential, but it is
// combinatorial — and a pattern like `(a+)+` becomes a real regex. Only `*` and
// `?` carry meaning here; every other character, metacharacter or not, is literal.
function globMatch(pattern, text) {
  const source = String(pattern)
  const target = String(text)
  let pi = 0
  let ti = 0
  let star = -1
  let resume = 0

  while (ti < target.length) {
    if (pi < source.length && (source[pi] === '?' || source[pi] === target[ti])) {
      pi += 1
      ti += 1
    } else if (pi < source.length && source[pi] === '*') {
      star = pi
      resume = ti
      pi += 1
    } else if (star !== -1) {
      pi = star + 1
      resume += 1
      ti = resume
    } else {
      return false
    }
  }

  while (pi < source.length && source[pi] === '*') pi += 1
  return pi === source.length
}
