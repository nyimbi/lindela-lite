/**
 * ENH-80 — the peer registry, and the store a peer is.
 *
 * `src/federation.js` is the exchange: given two stores it converges them, and it
 * was complete, tested and imported by nothing because both entry points take
 * `peers` as an argument and nothing supplied them. This module is the supply.
 *
 * Two things, and they are separate on purpose.
 *
 * **The registry** is a declared collection (`federation_peers`), so the rows
 * live in the store the node already has, the routes read them through the same
 * `data` a listing does, and there is no second configuration file to keep in
 * step with the store. `normalizePeer` validates and normalises a row, and it
 * names `assertConnectorUrl` for the URL — the same guard the DHIS2 connector
 * uses, with the same jurisdiction: the metadata ranges are refused and RFC-1918
 * is permitted, because a peer node in a district office is on the operator's own
 * LAN and a guard that refused it would refuse the deployment this feature exists
 * for.
 *
 * **The peer store** is what `assertPeer` wants: an object with `read`, `merge`
 * and `exchangeManifest`. It talks to another node's federation surface through
 * `fetchWithRetry`, so a peer is reached the same way any other upstream is —
 * the same retry, timeout and error shaping — rather than through a second fetch
 * path that would drift from it.
 *
 * ## Two gates, not one
 *
 * The exchange applies the *sending* node's residency policy, which is right:
 * the policy that governs what may leave is the one at the node the bytes leave.
 * It is not sufficient on its own. The node they arrive at has its own policy,
 * and a record this node may send is not automatically a record that node may
 * keep — so the receiving surface applies its own policy again before it stores
 * anything, and reports what it refused. One gate at the sender would make the
 * receiving node's residency law a property of whoever configured the sender.
 */

import { fetchWithRetry } from './connectors/http.js'
import { SYNCABLE_COLLECTIONS, exchangeManifest, federate } from './federation.js'
import { assertConnectorUrl } from './webhooks.js'
import { nowIso, stableId } from './utils.js'

/**
 * The path a peer's exchange surface lives at, on the peer.
 *
 * A constant rather than a per-peer setting. A peer row that chose its own path
 * would make the URL's meaning a property of a remote deployment, and an operator
 * comparing two rows could not tell whether a difference between them was a
 * different node or a different protocol. One protocol, one path — and it is what
 * lets the guard at registration be a guard on the only URL this store fetches.
 */
export const PEER_API_PATH = '/api/v1/federation/exchange'

const PEER_TIMEOUT_MS = Number(process.env.LINDELA_LITE_FEDERATION_TIMEOUT_MS) > 0
  ? Number(process.env.LINDELA_LITE_FEDERATION_TIMEOUT_MS)
  : 20_000

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/** This node's name, as a peer sees it. Reported, never used as a key. */
export function federationNodeName(env = process.env) {
  return String(env.LINDELA_LITE_NODE_NAME || '').trim() || null
}

/**
 * A peer row, validated and normalised.
 *
 * `assertConnectorUrl` is the guard and it is named rather than described, so
 * `check-outbound-fetch` reads it on this site: the URL here is caller-supplied
 * on write — an operator POSTs a peer — and the server will later fetch it. That
 * is the VUL-01 shape, and the answer is the one the DHIS2 connector gives. It is
 * deliberately *not* `assertSafeWebhookUrl`: that guard refuses RFC-1918, which
 * would refuse a peer on the operator's own network, and a guard scoped wider
 * than its jurisdiction is one an operator routes around.
 *
 * The URL is normalised to its origin plus the fixed exchange path, so a stored
 * peer cannot carry a path of its own. Credentials embedded in a URL are refused
 * by `assertConnectorUrl` (through `parseWebhookUrl`), which matters more here
 * than for a webhook: a peer URL is written into the store and then read back by
 * the status route of every node that lists it.
 *
 * The id is derived from the **origin**, so re-registering the same address under
 * a new display name updates the row rather than creating a second peer to the
 * same node — which would run the same exchange twice per tick.
 */
export function normalizePeer(input = {}, existing = null) {
  const raw = String(input.url ?? '').trim()
  if (!raw) {
    throw badRequest('url is required: a peer is an address this node exchanges with')
  }
  const parsed = assertConnectorUrl(raw)

  const name = String(input.name ?? existing?.name ?? '').trim()
  if (!name) {
    throw badRequest('name is required: it is how this peer is named in every exchange result')
  }

  const direction = input.direction ?? existing?.direction ?? 'both'
  if (!['both', 'out', 'in'].includes(direction)) {
    throw badRequest(`direction must be one of both, out, in; received ${JSON.stringify(direction)}`)
  }

  const policy = input.policy ?? existing?.policy ?? {}
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw badRequest('policy must be an object: it is this peer\'s residency policy, and anything else would refuse every record with no field to point at')
  }

  const status = ['active', 'paused'].includes(input.status)
    ? input.status
    : (existing?.status || 'active')

  return {
    id: input.id || existing?.id || stableId('peer', [parsed.origin]),
    name,
    // Origin plus the fixed path. `origin` travels beside it so a route can show
    // an operator the address without the protocol suffix, and so a row's path
    // being wrong is visible rather than implied.
    url: `${parsed.origin}${PEER_API_PATH}`,
    origin: parsed.origin,
    direction,
    policy,
    status,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  }
}

/**
 * The active peers of a store read, ready for `federate`.
 *
 * Paused peers are dropped here rather than skipped inside the exchange, so the
 * count `federate` reports is the number of peers it was actually given. A paused
 * peer left in the list would make "3 peers, 1 reached" and "2 peers, 2 reached"
 * the same summary with the same `ok`, and the operator's question — is anything
 * failing — would have a different answer depending on which reading they took.
 *
 * A row that `assertPeer` would refuse is passed through rather than filtered:
 * `federate` catches that per peer and names it in `failures`, which is a visible
 * misconfiguration. Filtering here would make a malformed row silently absent —
 * the same failure as a peer that was never registered.
 */
export function peersForExchange(rows = []) {
  return (rows || [])
    .filter((row) => row && row.status !== 'paused')
    .map((row) => peerStore(row))
}

/**
 * A peer as a store: `read`, `merge` and `exchangeManifest`.
 *
 * The three methods are the whole of what `exchangeWith` calls, and each is one
 * request against the peer's federation surface. `assertPeer` requires `read` and
 * `merge`; `exchangeManifest` is optional and this one implements it, which is
 * what makes the receive-side digest check possible — a peer that states what it
 * holds lets the exchange catch a read that succeeded but did not deliver
 * everything, the failure a throw cannot report because nothing threw.
 *
 * **The URL is built from the stored origin, never from an argument.** A caller
 * cannot aim this store at a path it did not register, which is what keeps the
 * `assertConnectorUrl` call at registration meaningful rather than decorative.
 */
export function peerStore(row) {
  const base = String(row?.url || '').replace(/\/+$/, '')
  const name = row?.name || row?.origin || 'peer'

  const call = (suffix, init = {}) => fetchWithRetry(`${base}${suffix}`, {
    parse: 'json',
    retries: 1,
    timeoutMs: PEER_TIMEOUT_MS,
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

  return {
    name,
    origin: row?.origin || null,

    /** The peer's syncable collections, as it serves them. */
    async read() {
      const body = await call('')
      const data = body?.data ?? body ?? {}
      const out = {}
      for (const collection of SYNCABLE_COLLECTIONS) {
        out[collection] = Array.isArray(data[collection]) ? data[collection] : []
      }
      return out
    },

    /** The records this node may move to the peer, merged by the peer's own rule. */
    async merge(partial) {
      const payload = {}
      for (const collection of SYNCABLE_COLLECTIONS) {
        if (Array.isArray(partial?.[collection])) payload[collection] = partial[collection]
      }
      if (!Object.keys(payload).length) return { applied: 0 }
      const body = await call('/merge', { body: { payload } })
      return body?.data ?? { applied: 0 }
    },

    /** What the peer says it holds, so the exchange can verify the read. */
    async exchangeManifest() {
      const body = await call('/manifest')
      return body?.data ?? body ?? {}
    },
  }
}

/**
 * This node's own manifest, for its federation surface and its status route.
 *
 * `exchangeManifest` is imported rather than reimplemented, so the digest a peer
 * checks against is computed by the same code that computes the digest this node
 * checks a peer against. Two implementations of one hash is a check that agrees
 * with itself and with nothing else.
 */
export function localManifest(data, node = null) {
  return exchangeManifest(data, { node })
}

/**
 * One federated exchange over this node's registered peers.
 *
 * The one function the scheduled driver item and `POST /api/v1/federation/sync`
 * both call, so the thing that runs on a timer and the thing an operator
 * triggers by hand cannot diverge — a divergence that would make "it works when
 * I press the button" a true sentence about a feature that does not work.
 *
 * ## A node with no peers is `ran: false`, not `ok: false`
 *
 * `federate` refuses an empty peer list, and it is right to: `{ peers: 0, ok:
 * true }` is a measurement of nothing reported as health. But that refusal is
 * about an *exchange that was attempted*, and a node that has registered no peer
 * has not attempted one. The two need different answers, because the scheduled
 * item runs every fifteen minutes on every deployment including the ones that
 * will never federate: a driver item that failed forever on a single-node
 * deployment is an alarm nobody can clear, and an alarm nobody can clear is one
 * everybody learns to ignore.
 *
 * So this separates them. `ran: false` with a reason means "there was nothing to
 * do", and the driver records it as a skip; `ran: true, ok: false` means an
 * exchange was attempted and failed, which is the thing worth waking up for. The
 * route turns `ran: false` into a 400 for the opposite reason: a caller who
 * asked for a sync and got a 200 would read it as a sync that happened.
 *
 * ## Every peer is independent
 *
 * `federate` already isolates a peer that throws — the others still exchange and
 * the summary names which one failed — and this adds nothing to that. What it
 * adds is the policy: each peer's row may carry its own residency policy, and a
 * run with three peers applies each peer's own. A single policy for the run is
 * the fallback, which is what a node with one policy configured wants.
 */
export async function runFederationSync(store, data, { policy = null, env = process.env, direction = null } = {}) {
  const rows = Array.isArray(data?.federation_peers) ? data.federation_peers : []
  const active = rows.filter((row) => row && row.status !== 'paused')
  if (!active.length) {
    return {
      ran: false,
      ok: false,
      node: federationNodeName(env),
      configured: rows.length,
      reason: rows.length
        ? `every registered peer is paused (${rows.length} configured, 0 active), so there is nothing to exchange with`
        : 'no peers are registered, so there is nothing to exchange with',
    }
  }

  // Per peer, because a peer row may carry its own policy and `federate` takes
  // one for the whole run. A run of one peer — the common case — is one call
  // with that peer's policy or the node's.
  const results = []
  for (const row of active) {
    const peerPolicy = row.policy && Object.keys(row.policy).length ? row.policy : policy
    const summary = await federate(store, [peerStore(row)], {
      policy: peerPolicy,
      node: federationNodeName(env),
      direction: direction || row.direction || 'both',
    })
    results.push(summary)
  }

  const failures = results.flatMap((summary) => summary.failures)
  const reached = results.filter((summary) => summary.ok).length
  const summary = {
    ran: true,
    ok: failures.length === 0 && reached === results.length,
    node: federationNodeName(env),
    configured: rows.length,
    active: active.length,
    peers: active.length,
    reached,
    sent: results.reduce((sum, one) => sum + (one.sent || 0), 0),
    applied: results.reduce((sum, one) => sum + (one.applied || 0), 0),
    withheld: results.reduce((sum, one) => sum + (one.withheld || 0), 0),
    conflicts: results.reduce((sum, one) => sum + (one.conflicts || 0), 0),
    failures,
    results,
  }
  if (!summary.ok) {
    summary.reason = `${active.length - reached} of ${active.length} peer exchange(s) did not complete: ${failures.map((f) => `${f.peer}/${f.side}: ${f.error}`).join('; ')}`
  }
  return summary
}
