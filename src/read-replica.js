import { metrics, logger } from './observability.js'

/**
 * ENH-67 — one store object, reads on the replica and writes on the primary.
 *
 * The analytical reads this platform is asked for — `refreshAnalytics` over the
 * whole store, the `filterRecords` scans behind the console, the `/ready` probe
 * a load balancer issues every few seconds — are exactly the reads that compete
 * with a write for the same connection and the same table. Pointing them at a
 * streaming replica costs nothing in correctness (a replica lags the primary,
 * and an analytical read a few seconds stale is the normal contract) and takes
 * them off the connection the next field report needs.
 *
 * The reason this is a wrapper and not a convention is the failure mode. If a
 * caller holds two store objects and remembers which is which, then one
 * forgotten call site sends a write to the replica — and the replica rejects
 * writes, or worse, in a future topology where it does not, the write lands
 * where nothing reads it and the record is gone with no error. The other
 * direction is quieter: a read that meant to go to the replica stays on the
 * primary, and nothing is wrong except the load, which is the thing nobody
 * measures. A single object that classifies by method removes both: there is
 * nothing to remember, so there is nothing to forget.
 *
 * ## The routing rule
 *
 * A **read** is `read()` or `iterateRecords()` — the two methods that
 * materialise rows for a caller and do not change what the store holds. Every
 * other method, including `ensureSchema()`, `close()` and the whole write
 * surface, goes to the **primary**. The classification is by what the method
 * does to the store, and it is fixed here rather than taken from the caller: a
 * caller-supplied override is how a read ends up on the primary under a name
 * nobody classified, which is the load problem arriving by a different door.
 *
 * A read method the replica does not implement falls back to the primary and
 * says so in the log. That is a fact about the deployment — a store double in a
 * test, a replica driver that has not implemented streaming — and serving it
 * from the primary is the safe direction; the alternative is a read that fails
 * because the *replica* is incomplete.
 *
 * ## What happens when the replica is unreachable
 *
 * The choice is between falling back to the primary and failing the read, and
 * they answer different questions. Falling back keeps the request working and
 * puts the load back on the primary — which is where it was before this module
 * existed, so the deployment is no worse than it was without a replica, and an
 * analytical read during a replica outage is still answered. Failing the read
 * is the choice to *protect* the primary: the whole point of the split is that
 * the primary serves writes, and a fallback under replica failure is precisely
 * the moment every analytical read in the fleet arrives on it at once — the
 * thundering herd that turns a replica outage into a primary outage.
 *
 * This module defaults to **fallback**, because the correctness argument is the
 * one that must not be left to a configuration: a read served from the primary
 * returns the same rows a read served from the replica would, so the fallback
 * cannot produce a wrong answer, only a slower one. A deployment that has sized
 * its primary for writes alone and would rather refuse than absorb the herd
 * passes `onReplicaFailure: 'fail'` and gets a refusal that names the replica.
 * The fallback is never silent: it is counted (`read_replica_fallback_total`)
 * and logged, because an operator watching a replica degrade needs to see the
 * primary taking the load back before it falls over.
 *
 * The **write** side has no such choice. A write that cannot reach the primary
 * throws; it is never retried against the replica and never swallowed. A write
 * reaching the replica is the silent divergence this module exists to prevent,
 * and there is no version of it that is correct.
 *
 * ## When no replica is configured
 *
 * `readReplicaStore(primary)` with no replica returns the primary unchanged —
 * the same object, not a wrapper — so a deployment that has not stood up a
 * replica runs exactly the code it ran before this module existed, with no
 * indirection to get wrong. `readReplicaStore(primary, { replica: null })` does
 * the same. A caller can test `replicaConfigured()` to report which mode it is
 * in rather than inferring it.
 *
 * ## What a caller does
 *
 *   import { readReplicaStore } from './read-replica.js'
 *
 *   const store = readReplicaStore(primaryStore, { replica: replicaStore })
 *
 *   // `store` now has the primary's interface. `store.read(...)` reaches the
 *   // replica; `store.merge(...)`, `store.write(...)`, `store.withLock(...)`
 *   // reach the primary. Nothing else in the route changes.
 *
 * The replica is expected to be a store with the same contract — a
 * `PostgresStore` opened against the replica's connection string, or a
 * `JsonStore` for a test. This module does not open the connection; that is
 * `storage.js`'s job, and keeping the two apart is what lets the routing be
 * tested against a store double rather than a second cluster.
 */

/** The methods that read, and therefore reach the replica. */
const READ_METHODS = Object.freeze(['read', 'iterateRecords'])

/**
 * Every function the object exposes, walking the prototype chain.
 *
 * Class methods live on the prototype and are non-enumerable, so
 * `Object.keys()` sees none of them; this walks up from the instance and keeps
 * each name that reads as a function. Deduplicated, so an override higher in
 * the chain is forwarded once.
 */
function methodNames(store) {
  const names = new Set()
  for (let object = store; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) {
      if (name === 'constructor') continue
      if (typeof store[name] === 'function') names.add(name)
    }
  }
  return names
}

/** True when a usable replica was configured for this wrapper. */
export function replicaConfigured(store) {
  return Boolean(store?.__readReplica?.replica)
}

function report(kind, detail = {}) {
  metrics.counter('read_replica_route_total', { kind })
  if (kind === 'fallback') {
    logger.warn('read_replica_fallback', {
      message: 'the replica did not answer a read; it was served from the primary, which is the pre-replica behaviour and is counted here so the load is visible',
      ...detail,
    })
  }
}

/**
 * A store whose reads reach `replica` and whose writes reach `primary`.
 *
 * `onReplicaFailure` is `'fallback'` (default) or `'fail'`; anything else is
 * rejected rather than defaulted, because a typo in a setting that decides
 * whether an outage is absorbed or refused is a typo nobody would find. The
 * returned object carries `replica` and `replicaState()` so a caller can report
 * the mode — `/ready` and a test both want to, and inferring it from a failed
 * read is not a report.
 */
export function readReplicaStore(primary, { replica = null, onReplicaFailure = 'fallback' } = {}) {
  if (!primary || typeof primary !== 'object') throw new Error('readReplicaStore requires a primary store')
  // Degrade to the primary with no behaviour change: the same object, so a
  // deployment without a replica has no wrapper in its call path at all.
  if (!replica) return primary
  if (onReplicaFailure !== 'fallback' && onReplicaFailure !== 'fail') {
    throw new Error(`readReplicaStore: onReplicaFailure must be 'fallback' or 'fail', not ${JSON.stringify(onReplicaFailure)}`)
  }

  const state = { fallbacks: 0, lastFallback: null }
  const replicaAnswers = (method) => typeof replica[method] === 'function'

  /** The primary's method, or a clear error that it is absent. */
  const fromPrimary = async (method, ...args) => {
    if (typeof primary[method] !== 'function') throw new Error(`the primary store implements no ${method}()`)
    return primary[method](...args)
  }

  const onFailure = (method, error) => {
    state.fallbacks += 1
    state.lastFallback = { method, at: new Date().toISOString(), error: String(error?.message || error) }
    if (onReplicaFailure === 'fail') {
      report('refused', { method })
      const refusal = new Error(`the read replica did not answer ${method}() and this deployment refuses rather than falling back to the primary: ${error?.message || error}`)
      refusal.name = 'ReadReplicaUnavailable'
      refusal.statusCode = 503
      refusal.expose = true
      throw refusal
    }
    report('fallback', { method, error: String(error?.message || error) })
  }

  const read = async (options = {}) => {
    if (!replicaAnswers('read')) {
      report('primary', { method: 'read', reason: 'replica-implements-no-read' })
      return fromPrimary('read', options)
    }
    try {
      const result = await replica.read(options)
      report('replica', { method: 'read' })
      return result
    } catch (error) {
      onFailure('read', error)
      return fromPrimary('read', options)
    }
  }

  const iterateRecords = async function* (options = {}, iteration = {}) {
    const target = replicaAnswers('iterateRecords') ? replica : null
    if (!target) {
      report('primary', { method: 'iterateRecords', reason: 'replica-implements-no-iterateRecords' })
      if (typeof primary.iterateRecords !== 'function') throw new Error('the primary store implements no iterateRecords()')
      yield* primary.iterateRecords(options, iteration)
      return
    }
    // The fallback is safe only *before* the first record. Once a record is out,
    // the consumer has half a stream and re-running the walk from the primary
    // would either duplicate what it already saw or skip what it has not; so an
    // error after the first yield propagates. Stated here rather than discovered
    // by a consumer that silently got the same rows twice.
    let yielded = false
    try {
      for await (const record of target.iterateRecords(options, iteration)) {
        if (!yielded) {
          yielded = true
          report('replica', { method: 'iterateRecords' })
        }
        yield record
      }
      // A walk that returned no records still came from the replica, and saying
      // so once keeps the routing visible for the empty case.
      if (!yielded) report('replica', { method: 'iterateRecords' })
    } catch (error) {
      if (yielded) throw error
      onFailure('iterateRecords', error)
      if (typeof primary.iterateRecords !== 'function') throw new Error('the primary store implements no iterateRecords()')
      yield* primary.iterateRecords(options, iteration)
    }
  }

  const wrapper = {
    read,
    iterateRecords,
    // The mode, so a caller reports it rather than inferring it. `mode` is the
    // primary's, because that is the adapter writes and schema changes run on.
    get mode() { return primary.mode },
    get readRowBudget() { return primary.readRowBudget },
    get replica() { return replica },
    replicaState: () => ({ configured: true, on_failure: onReplicaFailure, fallbacks: state.fallbacks, last_fallback: state.lastFallback }),
  }

  // Everything else on the primary, bound and forwarded. Enumerated from the
  // primary rather than listed here, so a store method added later is reachable
  // through the wrapper without an edit to this file — a hardcoded list is a
  // method that silently goes missing the next time the store grows one. The
  // read methods are the only exclusion, which is the whole routing rule: what
  // is not `read` or `iterateRecords` goes to the primary.
  for (const name of methodNames(primary)) {
    if (READ_METHODS.includes(name)) continue
    if (name in wrapper) continue
    wrapper[name] = primary[name].bind(primary)
  }

  // A marker so `replicaConfigured()` answers without a read, and so a wrapper
  // of a wrapper is recognisable rather than wrapped twice.
  Object.defineProperty(wrapper, '__readReplica', { value: { replica, primary, onFailure: onReplicaFailure }, enumerable: false })
  return wrapper
}

/** The read methods this module classifies, exported so a test can assert the set. */
export { READ_METHODS }
