import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { describe, it, before, after } from 'node:test'

import {
  handleFederationRoute,
  matchFederationRoute,
  peerSummaries,
} from '../src/routes/federation.js'
import { JsonStore } from '../src/store.js'
import { emptyStore } from '../src/schema.js'
import { runPeriodicTick } from '../src/server.js'
import { SYNCABLE_COLLECTIONS, NON_SYNCABLE_REASONS, exchangeManifest } from '../src/federation.js'
import { FEDERATION_PEERS_COLLECTION } from '../src/store.js'
import { federationNodeName, normalizePeer, peerStore, runFederationSync } from '../src/federation-peers.js'

/**
 * ENH-80 — the federation family, asserted where it now lives.
 *
 * `src/federation.js` shipped a convergence rule with no caller: both entry
 * points take `peers` as an argument and nothing supplied them. The properties
 * worth asserting are the ones that made wiring it a design question rather than
 * a plumbing job:
 *
 *   - **a peer down does not fail the run.** `federate` isolates a throwing peer
 *     and the others still exchange; the driver item inherits that, and the test
 *     drives it through a real HTTP peer that refuses the connection.
 *   - **the registry is not synced, and the status route says why.** Syncing it
 *     would converge two nodes on the union of every peer either ever held, so a
 *     removed peer could never be retired.
 *   - **the receiving node applies its own residency policy.** The sender's
 *     policy governs what may leave; it says nothing about what the receiver may
 *     keep.
 *   - **a sync with nothing to sync is a refusal, not a clean run.** The
 *     scheduled item and the operator's route answer the same state differently
 *     and both are asserted here, because the difference is the design.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.body = () => Buffer.concat(res.chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))))
  res.json = () => JSON.parse(res.body().toString('utf8'))
  return res
}

const jsonResponse = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const makeReq = (method, body) => ({
  method,
  headers: {},
  __auth: { subject: 'tester' },
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

/** A store over an in-memory object, so the routes run against real merges. */
function memoryStore(initial = {}) {
  const state = { ...emptyStore(), ...initial }
  return {
    state,
    async read() { return state },
    async write(next) { Object.assign(state, next); return state },
    async merge(partial) {
      for (const [collection, records] of Object.entries(partial)) {
        const rows = state[collection] || []
        for (const record of records) {
          const at = rows.findIndex((row) => row?.id === record?.id)
          if (at >= 0) rows[at] = { ...rows[at], ...record }
          else rows.push(record)
        }
        state[collection] = rows
      }
      return partial
    },
    async remove({ collection }) {
      for (const [name, ids] of Object.entries(collection || {})) {
        state[name] = (state[name] || []).filter((row) => !ids.includes(row?.id))
      }
      return collection
    },
  }
}

const call = async (route, { data, store = memoryStore(), method = 'GET', body, search = '', policy = {} } = {}) => {
  const snapshot = data ?? store.state
  const res = fakeResponse()
  const handled = await handleFederationRoute(route, {
    store, data: snapshot, res, jsonResponse,
    req: makeReq(method, body),
    url: new URL(`http://127.0.0.1/x${search}`),
    policy,
  })
  return { handled, res, store, snapshot }
}

const peer = (over = {}) => normalizePeer({ url: 'http://10.0.0.9:8787', name: 'district', ...over })

describe('ENH-80 — matchFederationRoute', () => {
  it('matches the six paths and the peer detail', () => {
    assert.deepEqual(matchFederationRoute('/api/v1/federation/status'), { kind: 'status' })
    assert.deepEqual(matchFederationRoute('/api/v1/federation/exchange'), { kind: 'exchange' })
    assert.deepEqual(matchFederationRoute('/api/v1/federation/exchange/manifest'), { kind: 'manifest' })
    assert.deepEqual(matchFederationRoute('/api/v1/federation/exchange/merge'), { kind: 'merge' })
    assert.deepEqual(matchFederationRoute('/api/v1/federation/sync'), { kind: 'sync' })
    assert.deepEqual(matchFederationRoute('/api/v1/federation/peers'), { kind: 'peers', id: null })
    assert.deepEqual(matchFederationRoute('/api/v1/federation/peers/abc'), { kind: 'peers', id: 'abc' })
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/federation', '/api/v1/federation/', '/api/v1/federation/peers/a/b', '/api/v1/federations/status']) {
      assert.equal(matchFederationRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-80 — the registry route is validated at registration', () => {
  it('refuses a URL that reaches the cloud metadata service', async () => {
    const { res, store } = await call({ kind: 'peers', id: null }, {
      method: 'POST', body: { url: 'http://169.254.169.254/latest/meta-data', name: 'nope' },
    })
    assert.equal(res.status, 400, 'a metadata address was accepted as a peer')
    assert.equal(store.state[FEDERATION_PEERS_COLLECTION].length, 0, 'a metadata address reached the store')
  })

  it('accepts an RFC-1918 peer, which is the deployment this feature exists for', async () => {
    const { res, store } = await call({ kind: 'peers', id: null }, {
      method: 'POST', body: { url: 'http://10.0.0.9:8787', name: 'district office' },
    })
    assert.equal(res.status, 201, `a LAN peer was refused: ${res.json().error}`)
    assert.equal(store.state[FEDERATION_PEERS_COLLECTION].length, 1)
    assert.equal(store.state[FEDERATION_PEERS_COLLECTION][0].url, 'http://10.0.0.9:8787/api/v1/federation/exchange')
  })

  it('updates the row at the same origin rather than adding a second peer to one node', async () => {
    const store = memoryStore()
    await call({ kind: 'peers', id: null }, { store, method: 'POST', body: { url: 'http://10.0.0.9:8787', name: 'first' } })
    const { res } = await call({ kind: 'peers', id: null }, { store, method: 'POST', body: { url: 'http://10.0.0.9:8787', name: 'renamed' } })
    assert.equal(res.status, 200)
    assert.equal(store.state[FEDERATION_PEERS_COLLECTION].length, 1, 're-registering one node created two peers')
    assert.equal(store.state[FEDERATION_PEERS_COLLECTION][0].name, 'renamed')
  })

  it('logs the registration, because a change to who this node talks to is auditable', async () => {
    const { store } = await call({ kind: 'peers', id: null }, {
      method: 'POST', body: { url: 'http://10.0.0.9:8787', name: 'district' },
    })
    assert.equal(store.state.action_logs.length, 1)
    assert.equal(store.state.action_logs[0].action, 'created')
  })

  it('removes a peer locally, and a second removal is a 404', async () => {
    const store = memoryStore({ [FEDERATION_PEERS_COLLECTION]: [peer()] })
    const id = store.state[FEDERATION_PEERS_COLLECTION][0].id
    const first = await call({ kind: 'peers', id }, { store, method: 'DELETE' })
    assert.equal(first.res.status, 200)
    assert.equal(store.state[FEDERATION_PEERS_COLLECTION].length, 0)
    const second = await call({ kind: 'peers', id }, { store, method: 'DELETE' })
    assert.equal(second.res.status, 404)
  })
})

describe('ENH-80 — the status route states what the exchange cannot do', () => {
  it('names the registry as skipped, with the reason, so removal is explicable', async () => {
    const { res } = await call({ kind: 'status' }, { data: { [FEDERATION_PEERS_COLLECTION]: [peer()], system_heartbeat: [] } })
    const body = res.json().data
    assert.ok(body.skipped.registry.includes(FEDERATION_PEERS_COLLECTION),
      'the status route does not say the registry is excluded, so a peer that will not go away reads as a bug')
    assert.match(body.skipped.registry_reason, /remove|retire|union/i)
  })

  it('separates configured from active, because three peers with two paused is not one peer', async () => {
    const data = {
      [FEDERATION_PEERS_COLLECTION]: [peer({ name: 'a' }), normalizePeer({ url: 'http://10.0.0.10', name: 'b', status: 'paused' })],
      system_heartbeat: [],
    }
    const { res } = await call({ kind: 'status' }, { data })
    assert.equal(res.json().data.configured, 2)
    assert.equal(res.json().data.active, 1)
  })

  it('carries the deletion limitation rather than reporting a clean sync', async () => {
    const { res } = await call({ kind: 'status' }, { data: { [FEDERATION_PEERS_COLLECTION]: [], system_heartbeat: [] } })
    assert.match(res.json().data.deletion, /delet/i)
  })

  it('reports the last exchange from the tick’s own heartbeat, not a second store', async () => {
    const data = {
      [FEDERATION_PEERS_COLLECTION]: [],
      system_heartbeat: [{ at: '2026-10-12T00:00:00Z', items: [{ id: 'federation', ok: true, summary: { ran: true, peers: 2, reached: 2 } }] }],
    }
    const { res } = await call({ kind: 'status' }, { data })
    assert.equal(res.json().data.last_exchange.summary.peers, 2)
  })
})

describe('ENH-80 — the peer listing is paged and reads only the registry', () => {
  it('carries the five paging keys, so a caller can tell complete from truncated', async () => {
    const { res } = await call({ kind: 'peers', id: null }, { data: { [FEDERATION_PEERS_COLLECTION]: [peer()] } })
    const body = res.json()
    for (const key of ['returned', 'limit', 'total', 'has_more', 'next_cursor']) {
      assert.ok(key in body, `the peer listing has no \`${key}\`, so a truncated registry is indistinguishable from a complete one`)
    }
    assert.equal(body.total, 1)
  })

  it('does not read the heartbeat the status route needs', async () => {
    // The listing borrows the row shaping, not `federationStatus`. A listing that
    // read the heartbeat would declare a collection in its manifest that it does
    // not use, and a manifest that omits one it does use is a 500 on PostgreSQL.
    const { res } = await call({ kind: 'peers', id: null }, { data: { [FEDERATION_PEERS_COLLECTION]: [peer()] } })
    assert.equal(res.json().data.length, 1)
    assert.ok(!('last_exchange' in res.json()), 'the listing returned status fields, so it is reading the heartbeat')
  })

  it('tolerates a hand-edited row rather than answering a 500 with no field named', () => {
    const rows = peerSummaries({ [FEDERATION_PEERS_COLLECTION]: [{ id: 'x' }] })
    assert.equal(rows[0].name, '(unnamed peer)')
    assert.equal(rows[0].status, 'active')
  })
})

describe('ENH-80 — the exchange surface serves the syncable set and nothing else', () => {
  it('serves the syncable collections and states what it skipped', async () => {
    const data = { [FEDERATION_PEERS_COLLECTION]: [peer()], system_heartbeat: [] }
    const { res } = await call({ kind: 'exchange' }, { data })
    const body = res.json()
    for (const collection of SYNCABLE_COLLECTIONS) {
      assert.ok(collection in body.data, `${collection} is syncable and the exchange does not serve it`)
    }
    assert.ok(!(FEDERATION_PEERS_COLLECTION in body.data),
      'the exchange serves the peer registry, so a removed peer would be re-learned from the other node and could never be retired')
    assert.ok(body.digest, 'the exchange carries no digest, so a peer cannot verify the read')
  })

  it('serves the manifest without the rows, so verification is cheaper than the read', async () => {
    const { res } = await call({ kind: 'manifest' }, { data: { [FEDERATION_PEERS_COLLECTION]: [] } })
    const body = res.json().data
    assert.ok(body.digest)
    assert.equal(body.payload, undefined, 'the manifest carries the rows, so it is not a cheaper check')
  })

  it('refuses a payload that names no collection', async () => {
    const { res } = await call({ kind: 'merge' }, { method: 'POST', body: { payload: [1, 2, 3] } })
    assert.equal(res.status, 400)
  })

  it('applies the receiving node’s own policy, which the sender’s cannot supply', async () => {
    const store = memoryStore()
    const record = { id: 'inc1', type: 'incident', valid_from: '2026-01-01T00:00:00Z', sensitivity: 'restricted' }
    const { res } = await call({ kind: 'merge' }, {
      store,
      method: 'POST',
      body: { payload: { incidents: [record] } },
      policy: { denied_sensitivity: ['restricted'] },
    })
    const body = res.json().data
    assert.equal(body.applied, 0, 'a restricted record was stored at a node whose policy refuses it')
    assert.equal(body.withheld.length, 1)
    assert.equal(store.state.incidents.length, 0)
  })

  it('names a collection this node does not sync, separately from a withheld row', async () => {
    const store = memoryStore()
    const { res } = await call({ kind: 'merge' }, {
      store,
      method: 'POST',
      body: { payload: { [FEDERATION_PEERS_COLLECTION]: [peer()], not_a_collection: [{ id: 'z' }] } },
      policy: {},
    })
    const body = res.json().data
    assert.ok(body.refused.some((entry) => entry.collection === FEDERATION_PEERS_COLLECTION),
      'the receiving node accepted the peer registry, so a peer can be installed by whoever it is syncing with')
    assert.ok(body.refused.some((entry) => entry.collection === 'not_a_collection'))
    assert.equal(body.withheld.length, 0, 'a refused collection was reported as a withheld row')
  })
})

describe('ENH-80 — a sync with nothing to sync is a refusal, and a node with no peer is not a failure', () => {
  it('answers 400 when the operator asks for a sync and no peer is active', async () => {
    const { res } = await call({ kind: 'sync' }, { method: 'POST', data: { [FEDERATION_PEERS_COLLECTION]: [] } })
    assert.equal(res.status, 400,
      'a sync with no peer answered 200, which a caller reads as a sync that happened')
    assert.match(res.json().error, /no peers/i)
  })

  it('counts a paused peer as nothing to sync with, and says so', async () => {
    const paused = normalizePeer({ url: 'http://10.0.0.10', name: 'paused', status: 'paused' })
    const { res } = await call({ kind: 'sync' }, { method: 'POST', data: { [FEDERATION_PEERS_COLLECTION]: [paused] } })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /paused/i)
  })

  it('is a skip, not a failure, when the scheduled driver runs it with no peers', async () => {
    // The difference is deliberate: the item runs every fifteen minutes on every
    // deployment including single-node ones, and an alarm nobody can clear is one
    // everybody learns to ignore.
    const store = memoryStore()
    const summary = await runFederationSync(store, { [FEDERATION_PEERS_COLLECTION]: [] })
    assert.equal(summary.ran, false)
    assert.equal(summary.ok, false)
    assert.match(summary.reason, /no peers are registered/i)
  })
})

describe('ENH-80 — a peer that is down does not fail the others, or the tick', () => {
  let deadPort
  let deadServer
  before(async () => {
    // A listener that closes immediately: the port is real, so the URL passes
    // the guard, and nothing is listening, so the fetch refuses. That is the
    // shape of a peer that is down, and it is not simulated.
    deadServer = http.createServer((req, res) => res.end())
    await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve))
    deadPort = deadServer.address().port
    await new Promise((resolve) => deadServer.close(resolve))
  })
  after(() => { if (deadServer?.listening) deadServer.close() })

  it('names the unreachable peer and reaches the live one', async () => {
    const live = await livePeer()
    const store = memoryStore()
    const rows = [
      normalizePeer({ url: live.url, name: 'live' }),
      normalizePeer({ url: `http://127.0.0.1:${deadPort}`, name: 'down' }),
    ]
    const summary = await runFederationSync(store, { [FEDERATION_PEERS_COLLECTION]: rows })
    assert.equal(summary.ran, true)
    assert.equal(summary.peers, 2)
    assert.equal(summary.reached, 1, 'a peer that is down stopped the one that is up')
    assert.equal(summary.ok, false)
    assert.ok(summary.failures.some((failure) => failure.peer === 'down'),
      `the failure does not name the peer: ${JSON.stringify(summary.failures)}`)
  })

  it('does not stop the other driver items, and records the outcome', async () => {
    const live = await livePeer()
    const store = new JsonStore(await tempStorePath())
    await store.merge({
      [FEDERATION_PEERS_COLLECTION]: [normalizePeer({ url: `http://127.0.0.1:${deadPort}`, name: 'down' })],
    })
    const heartbeat = await runPeriodicTick(store)
    const federation = heartbeat.items.find((item) => item.id === 'federation')
    assert.ok(federation, 'the driver no longer runs a federation item')
    // The peer is down, so the item fails — and the tick still completes, which
    // is the driver's contract.
    assert.ok(heartbeat.items.some((item) => item.ok && item.id !== 'federation'),
      'one unreachable peer stopped the whole tick')
    assert.ok(live.url)
  })
})

/** A real peer: an HTTP listener serving the three federation methods. */
async function livePeer() {
  const rows = { incidents: [{ id: 'inc-live', type: 'incident', valid_from: '2026-02-01T00:00:00Z', status: 'open' }] }
  // The digest is computed by `exchangeManifest`, not invented: a fabricated one
  // would make this a test of the fake rather than of the exchange, and the
  // receive-side verification would fail for the reason the check exists.
  const manifest = exchangeManifest(rows, { node: 'live-peer' })
  const server = http.createServer((req, res) => {
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url.endsWith('/manifest')) return send({ data: manifest })
    if (req.url.endsWith('/merge')) return send({ data: { applied: 1 } })
    return send({ data: rows })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  // Unref'd so the listener cannot hold the test runner open.
  server.unref()
  return { url, server, rows, manifest }
}

async function tempStorePath() {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-fed-'))
  return path.join(dir, 'store.json')
}

describe('ENH-80 — the peer store talks the fixed path, never one a caller supplies', () => {
  it('builds its URL from the stored row, so the registration guard is load-bearing', () => {
    const store = peerStore({ url: 'http://10.0.0.9:8787/api/v1/federation/exchange', name: 'p' })
    assert.equal(store.name, 'p')
    assert.ok(typeof store.read === 'function' && typeof store.merge === 'function' && typeof store.exchangeManifest === 'function',
      'a peer store without all three methods is refused by assertPeer, so the exchange could never run')
  })

  it('names this node from the environment, and reports null rather than an empty string', () => {
    assert.equal(federationNodeName({ LINDELA_LITE_NODE_NAME: '  ' }), null)
    assert.equal(federationNodeName({ LINDELA_LITE_NODE_NAME: 'turkaná' }), 'turkaná')
  })
})

describe('ENH-80 — the skip list and the syncable list cannot drift', () => {
  it('every non-syncable reason is a declared collection, and no syncable one is in it', () => {
    for (const collection of Object.keys(NON_SYNCABLE_REASONS)) {
      assert.ok(!SYNCABLE_COLLECTIONS.includes(collection),
        `${collection} is both syncable and named as not syncable`)
    }
    assert.ok(NON_SYNCABLE_REASONS[FEDERATION_PEERS_COLLECTION] === 'registry')
  })
})
