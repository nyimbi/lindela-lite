import { AsyncLocalStorage } from 'node:async_hooks'

import { metrics } from './observability.js'

/**
 * ENH-67 — a read that scans the whole store fails its own request, not every
 * other caller's.
 *
 * `readRowBudget` in `store.js` is a process-wide ceiling of 200,000 rows. It
 * stops a runaway allocation, and that is all it does: the number is the same
 * for a route that reads two collections and for a route that reads the whole
 * table, so it cannot tell a well-scoped read from an unscoped one until the
 * unscoped one is already 200,000 rows deep. A route that legitimately reads
 * everything — `refreshAnalytics` does, and by design — shares the ceiling with
 * a route that should not, and raising it to fit the first hands the second
 * more room to hurt the third.
 *
 * This is the other axis. A budget is created *per request*, an allowance sized
 * to what that request is for, and it is spent by the store operations the
 * request issues. A route that reads its slice costs its slice; a route that
 * reaches for the whole store crosses its own allowance and fails, by name,
 * with a sentence an operator can act on — rather than degrading every caller
 * sharing the process behind a database that is now serving a scan nobody
 * asked for.
 *
 * The allowance is per request by construction, not by convention. It lives in
 * an `AsyncLocalStorage`, so two requests in flight at the same instant hold
 * two ledgers and neither can spend the other's. The failure this rules out is
 * the module-global one `observability.js` already paid for: a counter owned by
 * "the process" that turns out to be shared by every server `createServer()`
 * built, so one caller's work shows up in another's number.
 *
 * ## What is measured, and why it is measured rather than estimated
 *
 * Two quantities, both counted from what the store actually did:
 *
 *   - **rows** — the rows a read handed the caller. For `read()` that is the
 *     total length of the collection arrays it returned, counted over the
 *     object the store produced; for `iterateRecords()` it is one per record
 *     yielded, charged as the stream advances so a walk that runs long fails
 *     mid-stream rather than after materialising.
 *   - **queries** — the store operations the request issued, reads and writes
 *     alike. One round trip is one query.
 *
 * Neither is a planner estimate. An `EXPLAIN`-derived row count would be a
 * different mechanism — it needs the SQL, and this module deliberately sits
 * above the store contract both adapters implement. What this counts is the
 * materialisation bound, which is the same quantity `readRowBudget` counts and
 * the same argument: on Postgres the `WHERE` decides it, and on the JSON
 * adapter the file is already resident so the read costs no additional scan.
 * The two adapters agree on what the number means, which is the property the
 * storage design rests on. It is stated here rather than left to be inferred: a
 * *filtered* read returns fewer rows than the planner scanned, and calling this
 * a scan count would be the overclaim this repository spends its length
 * removing.
 *
 * A whole-store read is caught by the row axis without a special case: it
 * materialises every declared row, so its count is the size of the store, and a
 * budget smaller than the store refuses it. That is the honest detection — the
 * cost is the rows, not the shape of the options.
 *
 * ## The honesty rule
 *
 * A budget that measures nothing must fail, not report success. So:
 *
 *   - A cost that is not a finite, non-negative number is a refusal
 *     (`QueryBudgetUnmeasurable`), never a zero. A store that returns something
 *     this module cannot count is a store whose cost is unknown, and an unknown
 *     cost charged as zero is a budget that silently never fires — the
 *     "reconciliation that measures nothing reports clean" failure this
 *     codebase has paid for more than once.
 *   - A read outside any budget is refused too (`QueryBudgetUnscoped`). The
 *     ceiling is per request; a read with no request to charge has no ceiling,
 *     and serving it unmeasured is the same silent pass one step earlier.
 *
 * Both are contract violations rather than capacity answers, so they carry 500
 * and the budget-exceeded refusal carries 503. All three set `expose`, because
 * the sentence is the only thing that tells the caller what to do.
 *
 * ## What a caller does
 *
 *   import { runWithQueryBudget, budgetedStore } from './query-budget.js'
 *
 *   // Once, at construction: the store the routes read through.
 *   const store = budgetedStore(readReplicaStore(primary, { replica }))
 *
 *   // Once per request, around the dispatch. `refreshAnalytics` — which reads
 *   // the whole store on purpose, from the replica — runs under a wide budget;
 *   // an ordinary API route runs under a narrow one.
 *   runWithQueryBudget({ rows: 25_000, queries: 200 }, () => handleApiRequest(store, req, res, url))
 *
 * A route that wants a different allowance passes a different `limits`; the
 * default is deliberately narrow, so a route that forgets is protected rather
 * than trusted.
 */

/**
 * The default allowance, and the shape a caller overrides.
 *
 * `rows` is under the 39,715 records the system audit measured in the store, so
 * an unscoped `read()` crosses it while a scoped one does not. `queries` is
 * generous: a request that issues two hundred round trips is already a defect,
 * and the axis exists so that a route that reads many small slices cannot
 * substitute quantity for the row bound.
 */
export const DEFAULT_QUERY_BUDGET = Object.freeze({ rows: 25_000, queries: 200 })

/**
 * The configured allowance, or the default.
 *
 * A non-numeric or non-positive setting is the default, the same direction
 * `readRowBudget()` falls: a nonsense value must not become an unbounded
 * budget. `LINDELA_LITE_QUERY_BUDGET_ROWS=0` reads as "unset", not as "no
 * limit", which is the falsy-zero trap this codebase has hit before.
 */
export function queryBudgetLimits(env = process.env) {
  const rows = Number(env.LINDELA_LITE_QUERY_BUDGET_ROWS)
  const queries = Number(env.LINDELA_LITE_QUERY_BUDGET_QUERIES)
  return {
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_QUERY_BUDGET.rows,
    queries: Number.isFinite(queries) && queries > 0 ? Math.floor(queries) : DEFAULT_QUERY_BUDGET.queries,
  }
}

/**
 * Raised when a request has spent more than its allowance.
 *
 * 503, not 500: this is a capacity answer — the request asked for more than the
 * deployment will give one caller — and `expose` carries the sentence to the
 * caller, who is the only one who can narrow the request.
 */
export class QueryBudgetExceeded extends Error {
  constructor(kind, spent, limit, { operation = null } = {}) {
    super(`this request has ${kind === 'rows' ? 'read' : 'issued'} ${spent} ${kind} over its ${limit}-${kind} budget${operation ? ` at ${operation}()` : ''}; the budget is per request, so the cost stays with this one and does not degrade every other caller — narrow the read to the collections it needs or raise the budget for this route`)
    this.name = 'QueryBudgetExceeded'
    this.statusCode = 503
    this.expose = true
    this.kind = kind
    this.spent = spent
    this.limit = limit
    this.operation = operation
  }
}

/**
 * Raised when a cost cannot be measured, or a read has no request to charge.
 *
 * 500, because both are contract violations rather than capacity answers: the
 * store returned a shape this module cannot count, or a read ran outside
 * `runWithQueryBudget`. The alternative — charging zero — is the failure the
 * header describes, so this refuses instead.
 */
export class QueryBudgetUnmeasurable extends Error {
  constructor(operation, detail) {
    super(`the query budget cannot measure ${operation}(): ${detail}. A cost this budget cannot count is refused rather than charged as zero, because a budget that measures nothing reports success on every read it was meant to catch`)
    this.name = 'QueryBudgetUnmeasurable'
    this.statusCode = 500
    this.expose = true
    this.operation = operation
  }
}

/** Raised when a metered operation runs with no request budget in scope. */
export class QueryBudgetUnscoped extends Error {
  constructor(operation) {
    super(`${operation}() was called with no query budget in scope. The budget is per request, so it must be established with runWithQueryBudget() around the dispatch; a read with no request to charge has no ceiling and is refused rather than served unmeasured`)
    this.name = 'QueryBudgetUnscoped'
    this.statusCode = 500
    this.expose = true
    this.operation = operation
  }
}

const budgetContext = new AsyncLocalStorage()

/** True when `value` is a finite, non-negative number — the only measurable cost. */
const measurable = (value) => Number.isFinite(value) && value >= 0

/**
 * Rows a `read()` handed the caller, or a refusal.
 *
 * Counted over the arrays of the object the store returned, which is the shape
 * both adapters produce (`emptyStore()`'s collections). A non-object — `null`,
 * `undefined`, a bare number — is a store that did not report what it read, so
 * it is unmeasurable rather than empty. An empty object is a genuine zero: a
 * store with no rows read is a store whose read cost nothing.
 */
export function measureRead(result, operation = 'read') {
  if (!result || typeof result !== 'object') {
    throw new QueryBudgetUnmeasurable(operation, `the store returned ${result === null ? 'null' : typeof result} where a store object was expected`)
  }
  let rows = 0
  for (const value of Object.values(result)) {
    if (Array.isArray(value)) rows += value.length
  }
  return rows
}

/**
 * One request's ledger.
 *
 * Pure state plus two methods; no timer, no I/O. `charge` is the only way in,
 * so there is exactly one place that decides what an over-budget read does.
 */
export function createQueryBudget(limits = queryBudgetLimits()) {
  const max = {
    rows: Number.isFinite(limits?.rows) && limits.rows > 0 ? Math.floor(limits.rows) : DEFAULT_QUERY_BUDGET.rows,
    queries: Number.isFinite(limits?.queries) && limits.queries > 0 ? Math.floor(limits.queries) : DEFAULT_QUERY_BUDGET.queries,
  }
  const spent = { rows: 0, queries: 0 }
  const ledger = {
    limits: max,
    spent: () => ({ ...spent }),
    remaining: () => ({ rows: Math.max(0, max.rows - spent.rows), queries: Math.max(0, max.queries - spent.queries) }),
    /**
     * Add a measured cost and refuse if it crosses the allowance.
     *
     * Rows are checked before queries, because the row axis is the one a
     * whole-store scan crosses and the one whose refusal is more useful to
     * report when both would fire.
     */
    charge({ operation = 'store', rows = 0, queries = 0 } = {}) {
      for (const [kind, amount] of [['rows', rows], ['queries', queries]]) {
        if (!measurable(amount)) {
          metrics.counter('query_budget_refused_total', { reason: 'unmeasurable' })
          throw new QueryBudgetUnmeasurable(operation, `its ${kind} cost is ${amount}`)
        }
      }
      spent.rows += rows
      spent.queries += queries
      if (spent.rows > max.rows) {
        metrics.counter('query_budget_refused_total', { reason: 'rows' })
        throw new QueryBudgetExceeded('rows', spent.rows, max.rows, { operation })
      }
      if (spent.queries > max.queries) {
        metrics.counter('query_budget_refused_total', { reason: 'queries' })
        throw new QueryBudgetExceeded('queries', spent.queries, max.queries, { operation })
      }
      return ledger
    },
  }
  return ledger
}

/**
 * Run `fn` with `limits` as the budget every metered store operation charges.
 *
 * The dynamic extent is the request: everything `fn` awaits sees the same
 * ledger, and a second `runWithQueryBudget` nested inside starts a fresh one
 * rather than adding to the outer. `limits` may be a plain `{ rows, queries }`
 * or a ledger from `createQueryBudget`, so a caller that wants to inspect the
 * spend afterwards can build the ledger itself.
 */
export function runWithQueryBudget(limits, fn) {
  const ledger = typeof limits?.charge === 'function' ? limits : createQueryBudget(limits)
  return budgetContext.run(ledger, fn)
}

/** The budget for the request in flight, or null outside one. */
export function currentQueryBudget() {
  return budgetContext.getStore() ?? null
}

function requireLedger(operation) {
  const ledger = currentQueryBudget()
  if (!ledger) {
    metrics.counter('query_budget_refused_total', { reason: 'unscoped' })
    throw new QueryBudgetUnscoped(operation)
  }
  return ledger
}

/**
 * The locked handle, metered the same way the unlocked store is.
 *
 * A read inside `withLock` is a store operation like any other and must be
 * charged to the request that issued it; leaving it unmetered would make the
 * lock a door out of the budget.
 */
function meteredLocked(locked, ledger) {
  return {
    async read(options) {
      const result = await locked.read(options)
      ledger.charge({ operation: 'withLock.read', rows: measureRead(result, 'withLock.read'), queries: 1 })
      return result
    },
    async readOne(collection, id) {
      const result = await locked.readOne(collection, id)
      // One row, or none. `null` is a row that is not there, which is a real
      // zero; the cost is still the query.
      ledger.charge({ operation: 'withLock.readOne', rows: result ? 1 : 0, queries: 1 })
      return result
    },
    async merge(partial) {
      const result = await locked.merge(partial)
      ledger.charge({ operation: 'withLock.merge', queries: 1 })
      return result
    },
    async remove(doomed) {
      const result = await locked.remove(doomed)
      ledger.charge({ operation: 'withLock.remove', queries: 1 })
      return result
    },
  }
}

/**
 * A store that charges every operation to the request's budget.
 *
 * One object, the same interface as the store it wraps, so a caller holds it
 * where it held the store and cannot forget to meter. Reads are measured by
 * what they returned; writes and schema operations are one query each. Every
 * other method is discovered from the store and charged as a single query, so a
 * store method added later is metered without an edit here — the safe
 * direction, since an uncharged operation is an unbounded one.
 */
export function budgetedStore(store) {
  if (!store || typeof store !== 'object') throw new QueryBudgetUnmeasurable('budgetedStore', 'it was given no store')
  const forward = (operation, method) => async (...args) => {
    const ledger = requireLedger(operation)
    const result = await method(...args)
    ledger.charge({ operation, queries: 1 })
    return result
  }

  const read = async (options = {}) => {
    const ledger = requireLedger('read')
    if (typeof store.read !== 'function') throw new QueryBudgetUnmeasurable('read', 'the store implements no read() to measure')
    const result = await store.read(options)
    ledger.charge({ operation: 'read', rows: measureRead(result, 'read'), queries: 1 })
    return result
  }

  const iterateRecords = async function* (options = {}, iteration = {}) {
    const ledger = requireLedger('iterateRecords')
    if (typeof store.iterateRecords !== 'function') throw new QueryBudgetUnmeasurable('iterateRecords', 'the store implements no iterateRecords() to measure')
    const source = store.iterateRecords(options, iteration)
    if (!source || (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')) {
      throw new QueryBudgetUnmeasurable('iterateRecords', 'the store returned no iterable to walk')
    }
    ledger.charge({ operation: 'iterateRecords', queries: 1 })
    // Charged per record as the walk advances. A stream that crosses the budget
    // fails at the record that crossed it, before the consumer holds the rest —
    // which is the whole reason a stream exists rather than a materialising read.
    for await (const record of source) {
      ledger.charge({ operation: 'iterateRecords', rows: 1 })
      yield record
    }
  }

  const withLock = async (fn) => {
    const ledger = requireLedger('withLock')
    if (typeof store.withLock !== 'function') throw new QueryBudgetUnmeasurable('withLock', 'the store implements no withLock()')
    const result = await store.withLock((locked) => fn(meteredLocked(locked, ledger)))
    ledger.charge({ operation: 'withLock', queries: 1 })
    return result
  }

  const wrapper = {
    read,
    iterateRecords,
    withLock,
    get mode() { return store.mode },
    get readRowBudget() { return store.readRowBudget },
  }

  // Every remaining method the store exposes, charged as one query each.
  // Enumerated from the store rather than listed here, so a store method added
  // later is metered without an edit to this file; the methods above are the
  // ones whose cost is not simply "one query" and are excluded so the generic
  // wrapper does not overwrite them.
  for (const name of methodNames(store)) {
    if (name in wrapper) continue
    wrapper[name] = forward(name, store[name].bind(store))
  }

  return wrapper
}

/**
 * Every function the object exposes, walking the prototype chain.
 *
 * Class methods are non-enumerable and live on the prototype, so
 * `Object.keys()` sees none of them; this walks up from the instance and keeps
 * each name that reads as a function.
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
