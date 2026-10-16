/**
 * ENH-80 — the federation family: the peer registry, the exchange surface, and
 * the status an operator reads.
 *
 * `src/federation.js` is the exchange and `src/federation-peers.js` is the
 * registry and the peer store. Neither had a caller, which is what "PARTIAL"
 * meant for this entry: a convergence rule that two in-memory stores can satisfy
 * and no deployment can reach. This module is the reach.
 *
 * Five routes, and the split between them is the whole design.
 *
 *   - **`GET /api/v1/federation/status`** is for the operator. It reads the
 *     registry and the last tick's own record of the exchange, and it states
 *     what the exchange *cannot* do as well as what it did. That last part is
 *     the reason the route exists rather than a log line: a sync summary that
 *     lists only what moved reads as a complete account, and it is not one.
 *   - **`GET /api/v1/federation/exchange`** and **`/manifest`** are for a peer
 *     node. They serve this node's syncable collections and the digest over
 *     them, which is what makes the receive-side check possible: a peer that
 *     states what it holds lets the sender notice a read that succeeded and did
 *     not deliver everything.
 *   - **`POST /api/v1/federation/exchange/merge`** is the receiving half. It
 *     applies *this* node's residency policy to what arrived, which is the gate
 *     the sender's policy cannot supply — a record the national node may part
 *     with is not automatically one a district node may keep.
 *   - **`POST /api/v1/federation/sync`** is the operator's "do it now", beside
 *     the scheduled exchange the driver runs.
 *
 * ## Deletion does not propagate, and the status route says so
 *
 * `mergeById` cannot express a removal, there is no tombstone, and inferring a
 * removal from a record's absence would make one node's outage a fleet-wide
 * deletion. So the module declines, and every status response carries that
 * refusal in `deletion` rather than leaving an operator to infer it from a clean
 * summary. This is the same rule the retention route follows: a control that
 * cannot do a thing must say which thing.
 */

import { FEDERATION_PEERS_COLLECTION } from '../store.js'
import {
  DELETION_DOES_NOT_PROPAGATE,
  DERIVED_NOT_SYNCED,
  REGISTRY_NOT_SYNCED,
  SYNCABLE_COLLECTIONS,
  acceptablePayload,
  exchangeManifest,
  mergeInto,
  skippedCollections,
} from '../federation.js'
import { federationNodeName, normalizePeer, runFederationSync } from '../federation-peers.js'
import { loadResidencyPolicy } from '../residency.js'
import { actionLog } from '../operations.js'
import { readRequestJson, collectionPage } from '../utils.js'

/**
 * Which federation route a request is, or null.
 *
 * Pathname only, and literal — `check-openapi.mjs` reads this body, so the five
 * paths are discoverable without a second list to keep in step.
 */
export function matchFederationRoute(pathname) {
  if (pathname === '/api/v1/federation/status') return { kind: 'status' }
  if (pathname === '/api/v1/federation/exchange') return { kind: 'exchange' }
  if (pathname === '/api/v1/federation/exchange/manifest') return { kind: 'manifest' }
  if (pathname === '/api/v1/federation/exchange/merge') return { kind: 'merge' }
  if (pathname === '/api/v1/federation/sync') return { kind: 'sync' }
  if (pathname === '/api/v1/federation/peers') return { kind: 'peers', id: null }
  const peer = pathname.match(/^\/api\/v1\/federation\/peers\/([^/]+)$/)
  if (peer) return { kind: 'peers', id: decodeURIComponent(peer[1]) }
  return null
}

/**
 * The collections this node will not send, grouped by reason.
 *
 * Read from `skippedCollections()` rather than written here, so the status route
 * cannot describe a policy the exchange does not follow. The three reasons are
 * different claims and the route keeps them apart: a derived collection is
 * recomputed by the peer, history is rebuilt from the values, and the registry is
 * local because syncing it would make a peer unremovable. `derived_reason` and
 * `registry_reason` carry the module's own sentences, so a reader is not given a
 * second, shorter explanation of a decision made elsewhere.
 */
function skippedForStatus() {
  const all = skippedCollections()
  return {
    derived: all.filter((entry) => entry.reason === 'derived').map((entry) => entry.collection),
    history: all.filter((entry) => entry.reason === 'history').map((entry) => entry.collection),
    registry: all.filter((entry) => entry.reason === 'registry').map((entry) => entry.collection),
    all,
    derived_reason: DERIVED_NOT_SYNCED,
    registry_reason: REGISTRY_NOT_SYNCED,
  }
}

/**
 * The peer rows as an operator reads them.
 *
 * Defensive on read. A row is validated by `normalizePeer` on write, but a route
 * that throws on a hand-edited store file reports the misconfiguration as a 500
 * with no field named — which is the one thing an operator cannot act on.
 *
 * Separate from `federationStatus` because the listing route serves exactly this
 * and nothing else, and the status route's extra read — the last exchange, from
 * the tick's own heartbeat — would otherwise be a collection the listing's
 * manifest does not declare. A manifest that names a collection the route does
 * not read is a wasted read on every request; one that omits a collection the
 * route *does* read is `undefined` and a 500 on PostgreSQL. Neither is worth
 * carrying for a shared helper.
 */
export function peerSummaries(data) {
  const rows = Array.isArray(data?.[FEDERATION_PEERS_COLLECTION]) ? data[FEDERATION_PEERS_COLLECTION] : []
  return rows.map((row) => ({
    id: row?.id ?? null,
    name: row?.name ?? row?.origin ?? '(unnamed peer)',
    origin: row?.origin ?? null,
    direction: row?.direction ?? 'both',
    status: row?.status ?? 'active',
    policy_declared: Boolean(row?.policy && Object.keys(row.policy).length),
    created_at: row?.created_at ?? null,
  }))
}

/**
 * What an operator needs to answer "is federation working, and what is it not
 * doing".
 *
 * Four parts, and the second and fourth are the ones a summary usually omits:
 *
 *   - **the peers**, with their direction and status, so a paused peer is visible
 *     as a decision rather than as a missing row;
 *   - **the last exchange**, read from the tick's own heartbeat record rather
 *     than from a second store the tick would have to keep in step with;
 *   - **what the exchange refuses to carry**, named by reason;
 *   - **`deletion`**, the one limitation that would otherwise look like a bug
 *     the first time an operator removed a record at one node and found it
 *     standing at the other.
 *
 * `configured` and `active` are separate numbers because they answer different
 * questions: a node with three peers and two paused is not a node with one peer,
 * and a status that reported one number could not tell the operator which.
 */
export function federationStatus(data, { node = null, env = process.env } = {}) {
  const peers = peerSummaries(data)
  const heartbeat = Array.isArray(data?.system_heartbeat) ? data.system_heartbeat : []
  const last = heartbeat
    .filter((beat) => Array.isArray(beat?.items))
    .flatMap((beat) => beat.items.filter((item) => item?.id === 'federation').map((item) => ({ at: beat.at, ...item })))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0] || null

  return {
    node: node ?? federationNodeName(env),
    peers,
    configured: peers.length,
    active: peers.filter((peer) => peer.status !== 'paused').length,
    last_exchange: last,
    syncable_collections: SYNCABLE_COLLECTIONS.length,
    skipped: skippedForStatus(),
    deletion: DELETION_DOES_NOT_PROPAGATE,
  }
}

/**
 * Handle one federation route. Returns true when it handled the request.
 *
 * `policy` is injectable so a test drives the receiving gate without writing a
 * policy file, and so a deployment that loads its policy once does not reload it
 * per request.
 */
export async function handleFederationRoute(route, { store, data, req, res, url, jsonResponse, policy = null, env = process.env } = {}) {
  const residency = policy || await loadResidencyPolicy()

  if (route.kind === 'status') {
    if (req.method !== 'GET') return methodNotAllowed(res, jsonResponse, 'GET')
    jsonResponse(res, 200, { success: true, data: federationStatus(data, { env }) })
    return true
  }

  if (route.kind === 'exchange') {
    if (req.method !== 'GET') return methodNotAllowed(res, jsonResponse, 'GET')
    const payload = {}
    for (const collection of SYNCABLE_COLLECTIONS) {
      payload[collection] = Array.isArray(data?.[collection]) ? data[collection] : []
    }
    // The manifest's own shape, with the collections at the top level, so a peer
    // reads one document rather than two requests that could disagree. `digest`
    // is computed over `payload` by the same `exchangeManifest` a local exchange
    // uses, which is what makes the peer's verification check this node's answer
    // rather than a second implementation of it.
    const manifest = exchangeManifest(payload, { node: federationNodeName(env) })
    jsonResponse(res, 200, {
      success: true,
      node: manifest.node,
      digest: manifest.digest,
      collections: manifest.collections,
      skipped: manifest.skipped,
      data: payload,
    })
    return true
  }

  if (route.kind === 'manifest') {
    if (req.method !== 'GET') return methodNotAllowed(res, jsonResponse, 'GET')
    const payload = {}
    for (const collection of SYNCABLE_COLLECTIONS) {
      payload[collection] = Array.isArray(data?.[collection]) ? data[collection] : []
    }
    const manifest = exchangeManifest(payload, { node: federationNodeName(env) })
    // `payload` is deliberately absent: this route exists so a peer can check a
    // read *without* re-reading, and a manifest carrying the rows would make the
    // two requests the same size for no gain.
    const { payload: _rows, ...rest } = manifest
    jsonResponse(res, 200, { success: true, data: rest })
    return true
  }

  if (route.kind === 'merge') {
    if (req.method !== 'POST') return methodNotAllowed(res, jsonResponse, 'POST')
    let body
    try {
      body = await readRequestJson(req)
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
      return true
    }
    const offered = body?.payload ?? body?.data ?? {}
    if (!offered || typeof offered !== 'object' || Array.isArray(offered)) {
      jsonResponse(res, 400, {
        success: false,
        error: 'payload must be an object keyed by collection: the exchange sends collections, and an array here names no collection to write',
      })
      return true
    }
    // The receiving node's own residency gate. See `acceptablePayload`.
    const { payload, withheld, refused } = acceptablePayload(offered, residency)
    const result = await mergeInto(store, data, payload)
    jsonResponse(res, 200, {
      success: true,
      data: {
        applied: result.applied,
        conflicts: result.conflicts,
        // Both lists travel. A merge that stored three of forty rows and said
        // nothing is indistinguishable from one that stored three, and the two
        // reasons a row did not land — this node's residency law, or a collection
        // this node does not carry — are different findings.
        withheld,
        refused,
      },
    })
    return true
  }

  if (route.kind === 'peers') {
    // The registry is the one part of this family that is ordinary CRUD, and it
    // is here rather than beside the webhook family because a peer is not a
    // subscription: the exchange fetches it through the federation protocol and
    // nothing else about the row is meaningful.
    if (req.method === 'GET' && !route.id) {
      // Paged like every other listing. A registry is small today and a paging
      // envelope is what makes "this is all of them" a claim the response can
      // carry; `ARRAY_IS_COMPLETE` would say the same thing by fiat, and a
      // registry is exactly the set that grows.
      jsonResponse(res, 200, {
        success: true,
        ...collectionPage(peerSummaries(data), url.searchParams, {
          auth: req.__auth, data, collection: FEDERATION_PEERS_COLLECTION,
        }),
      })
      return true
    }
    if (req.method === 'POST' && !route.id) {
      let body
      try {
        body = await readRequestJson(req)
      } catch (error) {
        jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
        return true
      }
      try {
        const { record, log, created } = await registerPeer(store, data, body, {
          actor: body?.actor, subject: req.__auth?.subject,
        })
        jsonResponse(res, created ? 201 : 200, { success: true, data: record, action_log: log })
      } catch (error) {
        jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
      }
      return true
    }
    if (req.method === 'DELETE' && route.id) {
      const removed = await removePeer(store, data, route.id, { subject: req.__auth?.subject })
      if (!removed) {
        jsonResponse(res, 404, { success: false, error: 'Peer not found' })
        return true
      }
      jsonResponse(res, 200, { success: true, data: removed.record, action_log: removed.log })
      return true
    }
    jsonResponse(res, 405, { success: false, error: 'Method not allowed: the peer registry is GET, POST and DELETE' })
    return true
  }

  if (route.kind === 'sync') {
    if (req.method !== 'POST') return methodNotAllowed(res, jsonResponse, 'POST')
    const summary = await runFederationSync(store, data, { policy: residency, env })
    if (!summary.ran) {
      // The operator asked for an exchange and there is nothing to exchange with.
      // The scheduled item treats this as a normal state and reports it as
      // skipped; an explicit request is a different question with a different
      // honest answer, because a caller who asked for a sync and got a 200 would
      // read it as a sync that happened.
      jsonResponse(res, 400, {
        success: false,
        error: summary.reason,
        configured: summary.configured,
      })
      return true
    }
    jsonResponse(res, summary.ok ? 200 : 502, {
      success: summary.ok,
      data: summary,
      // A summary that lists only what moved reads as a complete account of the
      // exchange. It is not one, and the refusal travels with it.
      deletion: DELETION_DOES_NOT_PROPAGATE,
      ...(summary.ok ? {} : { error: summary.reason }),
    })
    return true
  }

  jsonResponse(res, 404, { success: false, error: 'Unknown federation route' })
  return true
}

function methodNotAllowed(res, jsonResponse, allowed) {
  jsonResponse(res, 405, { success: false, error: `Method not allowed: this route is ${allowed}` }, { allow: allowed })
  return true
}

/**
 * Register a peer, or update the one at the same origin.
 *
 * Kept out of the route module's dispatch because it is also what a test and a
 * future CLI call, and because the action log is part of the operation: a peer
 * added without a log entry is a change to what this node talks to that the audit
 * trail cannot see.
 */
export async function registerPeer(store, data, body, { actor = 'operator', subject = null } = {}) {
  const rows = Array.isArray(data?.[FEDERATION_PEERS_COLLECTION]) ? data[FEDERATION_PEERS_COLLECTION] : []
  const byId = body?.id ? rows.find((row) => row.id === body.id) : null
  // Normalise once to learn the id the row will carry, then look for a row that
  // already has it. `normalizePeer` derives the id from the origin, so
  // re-registering the same address under a new name lands on the same id — and
  // without this second lookup the response would say `201 created` for a row
  // the store upserts in place. The status code is what an operator reads to
  // decide whether they now have two peers to one node.
  const provisional = normalizePeer(body, byId)
  const byOrigin = byId || rows.find((row) => row.id === provisional.id) || null
  const record = byOrigin === byId ? provisional : normalizePeer(body, byOrigin)
  const log = actionLog(FEDERATION_PEERS_COLLECTION, byOrigin ? 'updated' : 'created', record, actor, subject)
  await store.merge({ [FEDERATION_PEERS_COLLECTION]: [record], action_logs: [log] })
  return { record, log, created: !byOrigin }
}

/** Remove a peer. Local by design: absence does not propagate, and must not. */
export async function removePeer(store, data, id, { actor = 'operator', subject = null } = {}) {
  const rows = Array.isArray(data?.[FEDERATION_PEERS_COLLECTION]) ? data[FEDERATION_PEERS_COLLECTION] : []
  const existing = rows.find((row) => row.id === id)
  if (!existing) return null
  const log = actionLog(FEDERATION_PEERS_COLLECTION, 'deleted', existing, actor, subject)
  await store.remove({ collection: { [FEDERATION_PEERS_COLLECTION]: [id] } })
  await store.merge({ action_logs: [log] })
  return { record: existing, log }
}

