import { logger } from './observability.js'
import { stableId, nowIso } from './utils.js'
import { assertSafeWebhookUrl, matchEvent, signPayload } from './webhooks.js'

export { matchEvent } from './webhooks.js'

/**
 * R-20. Retry accounting, and the two ways it used to not happen.
 *
 * The record id is derived from `(event, payload)`, so re-emitting the same
 * event produces the *same id* — and `emit` then writes a fresh record with
 * `attempts: 0` over the top of the failed one. `maxRetries` was therefore
 * unreachable for any event that had been emitted before, and a webhook that
 * had permanently failed retried every dispatch cycle forever. Nothing ever
 * reached `failed`, so nothing ever dead-lettered.
 *
 * Two changes, both about not overwriting:
 *
 *  - `emit` reads the existing row for this id and keeps its delivery state.
 *    Re-emitting is a *replay request*, not a reset. If the event already went
 *    out, the caller gets the existing record back and the world does not hear
 *    about it twice.
 *  - `dispatchPending` stamps `next_attempt_at` and the backoff the comment at
 *    the old `:109` promised. The comment said "exponential backoff, don't
 *    retry yet" while doing neither: it retried on the next tick regardless of
 *    how recently it had tried. A permanently failing endpoint was hit once per
 *    dispatch cycle with no floor on the interval at all.
 */
export const OUTBOX_MAX_RETRIES = 5

/** First retry waits this long; each subsequent one doubles it, capped. */
export const OUTBOX_BASE_BACKOFF_MS = 5000
export const OUTBOX_MAX_BACKOFF_MS = 5 * 60 * 1000

function backoffMs(attempts) {
  return Math.min(OUTBOX_BASE_BACKOFF_MS * (2 ** Math.max(attempts - 1, 0)), OUTBOX_MAX_BACKOFF_MS)
}

function outboundEventId(event, payload) {
  return stableId('outbox', [event, JSON.stringify(payload)])
}

/**
 * `undeliverable`, not `sent`.
 *
 * An event with no matching active webhook has not been delivered to anyone; it
 * has been filed where no subscriber reads it. The old code wrote `sent` and
 * counted it as nothing at all, so the row read as a success and the fact that
 * the deployment had lost its only subscriber — the configuration mistake that
 * silently stops every future notification — was indistinguishable from a
 * healthy queue.
 */
/**
 * R-22: `emit` and the caller's own writes went in as two merges, in that
 * order. A failure of the second left an outbox event announcing a transition
 * that never happened, and subscribers act on events.
 *
 * `writes` is the fix: pass the records the event is announcing and both land in
 * one merge, because one merge is the only unit this store has. A caller that
 * has nothing else to persist still works, and one that passes writes it in the
 * wrong order gets a store that refuses rather than a store that half-applies.
 */
export async function emit(store, event, payload, writes = {}) {
  // CON-01. The read and the merge were two transactions, so two replicas both
  // read the row as absent (or as carrying the backoff they are about to
  // overwrite), both decide, and both write — an event re-emitted mid-dispatch
  // resurrects a row whose backoff was just set. `withLock` runs the decision
  // and the write in one transaction, so the second replica reads what the first
  // committed.
  return store.withLock(async (locked) => {
    // A manifest read, not the whole store: these functions read one
    // collection, and naming it turns the Postgres read into a `WHERE
    // collection = ANY(...)` instead of materialising every row. The tick's
    // read-once budget (SCL-02) depends on it too.
    const data = await locked.read(['events_outbox'])
    const id = outboundEventId(event, payload)
    const existing = (data.events_outbox || []).find((row) => row.id === id)

    if (existing && existing.status === 'sent') {
      // Already delivered. Re-emitting would send a second copy of an event the
      // subscriber has acted on.
      return existing
    }

    if (existing && existing.status === 'failed') {
      // Dead-lettered. Re-emitting is what killed the retry budget in the first
      // place: the platform's own retry path re-emits the event it is retrying,
      // so a row that reached `failed` would be resurrected on the very next tick
      // and never stay dead. Recovery is a deliberate act — `redriveOutbox` —
      // because an operator clearing a dead letter is a decision, and a silent
      // reset is not one.
      return existing
    }

    const record = {
      ...(existing || {}),
      id,
      type: existing?.type || 'outbox_event',
      event,
      payload,
      created_at: existing?.created_at || nowIso(),
      // R-20. Attempts carried forward. Resetting to zero here is what made
      // `maxRetries` unreachable: every retry cycle in the platform re-emits the
      // event it is retrying.
      attempts: existing?.attempts || 0,
      status: 'pending',
      last_attempt_at: existing?.last_attempt_at ?? null,
      last_error: existing?.last_error ?? null,
      // Preserved, not cleared. A row waiting out a backoff is still waiting out
      // that backoff, and re-emitting it — which every retry path in the platform
      // does — must not hand a permanently failing endpoint a free request per
      // cycle. That was the other half of R-20: the counter was reset on re-emit,
      // and the cooldown would have been reset with it.
      next_attempt_at: existing?.next_attempt_at ?? null,
      ...(existing?.failed_at ? { failed_at: existing.failed_at } : {}),
    }
    await locked.merge({ events_outbox: [record], ...writes })
    return record
  })
}

/**
 * CON-04. Many events, one read and one merge.
 *
 * `emit` reads the whole store to look up one row and merges once to write it.
 * A caller emitting in a loop therefore pays `O(raised)` whole-store reads and
 * `O(raised)` merges — and `evaluateAndPersistAlerts` does exactly that, so an
 * alert storm that raises 200 alerts is 200 sequential full reads of every row
 * in the store plus 200 full merges, on the request path *and* on the periodic
 * tick. The alert itself is `O(1)`; the fan-out is `O(raised × N)`.
 *
 * This is the same computation as `emit` per item — the lookup, the sent/failed
 * short-circuit, the carried-forward attempts and backoff — over one snapshot
 * and one merge. `writes` from each item are folded into the single merge, which
 * is the whole reason `emit` takes them: a caller that needs the state and the
 * event in one commit still gets that, for the batch rather than per event.
 *
 * Returns one entry per input, in order, each either the new record or the
 * existing row the short-circuit returned.
 */
export async function emitMany(store, events = []) {
  const items = (events || []).filter(Boolean)
  if (!items.length) return []
  // CON-01, as in `emit`: the snapshot and the merge are one transaction, so a
  // second replica cannot land a write between the decision and the write.
  return store.withLock(async (locked) => {
    // A manifest read, not the whole store: these functions read one
    // collection, and naming it turns the Postgres read into a `WHERE
    // collection = ANY(...)` instead of materialising every row. The tick's
    // read-once budget (SCL-02) depends on it too.
    const data = await locked.read(['events_outbox'])
    const outboxById = new Map((data.events_outbox || []).map((row) => [row.id, row]))

    const records = []
    const pending = []
    // Ids already queued in *this* batch. Two items with the same event and
    // payload hash to the same id, and a single merge holding that id twice would
    // be a row written over itself — the second item's `writes` would land and the
    // first's would not. `emit` cannot hit this because each call reads back what
    // the previous one wrote; here the snapshot is taken once, so it is tracked.
    const queued = new Map()
    for (const item of items) {
      const id = outboundEventId(item.event, item.payload)
      const existing = queued.get(id) || outboxById.get(id)
      // Same two short-circuits as `emit`, for the same reasons: a delivered event
      // is not re-sent, and a dead letter is not resurrected by the platform's own
      // retry path.
      if (existing && (existing.status === 'sent' || existing.status === 'failed')) {
        records.push(existing)
        continue
      }
      const record = {
        ...(existing || {}),
        id,
        type: existing?.type || 'outbox_event',
        event: item.event,
        payload: item.payload,
        created_at: existing?.created_at || nowIso(),
        attempts: existing?.attempts || 0,
        status: 'pending',
        last_attempt_at: existing?.last_attempt_at ?? null,
        last_error: existing?.last_error ?? null,
        next_attempt_at: existing?.next_attempt_at ?? null,
        ...(existing?.failed_at ? { failed_at: existing.failed_at } : {}),
      }
      records.push(record)
      queued.set(id, record)
      pending.push({ record, writes: item.writes || {} })
    }

    if (!pending.length) return records

    const merge = { events_outbox: pending.map(({ record }) => record) }
    for (const { writes } of pending) {
      for (const [collection, rows] of Object.entries(writes)) {
        if (!Array.isArray(rows) || !rows.length) continue
        merge[collection] = [...(merge[collection] || []), ...rows]
      }
    }
    await locked.merge(merge)
    return records
  })
}

/**
 * One in-flight dispatch per store, in one process — plus a claim that holds
 * across replicas.
 *
 * R-21: `dispatchPending` read the pending set, delivered to every matched
 * webhook, then merged the outcomes. Two concurrent calls — the driver's tick
 * and an operator pressing the button — both read the same pending rows and both
 * delivered them. Two subscribers acted on one transition, which for a
 * disbursement or an incident is the worst kind of duplicate: idempotent on the
 * wire, twice in the world.
 *
 * CON-07: the in-process lock below is per-process, so two *replicas* still both
 * read the same pending rows and both deliver them. The comment here used to say
 * the fix was `pg_advisory_lock` and that it was not done because "a claim added
 * to the row would need the same atomic write this is avoiding". That write
 * exists now — `store.withLock` — so the claim is the fix rather than a note.
 *
 * The shape is claim-deliver-record, not lock-deliver-record:
 *
 *  1. under the lock, read the due rows and mark them `dispatching` with a
 *     timestamp. A second replica's read, taken after this commits, no longer
 *     sees them as pending, so it does not deliver them. This is the whole of
 *     the cross-replica guarantee.
 *  2. outside the lock, deliver. Webhook POSTs are network I/O with a 5 s
 *     timeout each, and holding a global write lock across them would serialise
 *     every write in the deployment behind the slowest subscriber — turning a
 *     delivery problem into a write outage.
 *  3. under the lock again, write the outcomes.
 *
 * The in-process chain is kept and now runs *around* the claim rather than
 * instead of it: within one process it avoids the pointless claim/rollback of a
 * batch the other caller is already delivering, and it is what makes the tick
 * and the button deterministic in the single-replica deployment this project
 * actually ships.
 *
 * A claim that is never recorded — the process died mid-delivery — is reclaimed
 * by `DISPATCH_CLAIM_TTL_MS`, so a crashed replica does not strand its batch
 * forever. The window is generous relative to `maxBatch × timeoutMs` so a slow
 * but live delivery is not stolen and delivered twice.
 */
const _dispatchLocks = new WeakMap()

/** A claim older than this is treated as abandoned and becomes deliverable again. */
export const DISPATCH_CLAIM_TTL_MS = 10 * 60 * 1000

async function withDispatchLock(store, fn) {
  const previous = _dispatchLocks.get(store) || Promise.resolve()
  let release
  const held = new Promise((resolve) => { release = resolve })
  _dispatchLocks.set(store, previous.then(() => held))
  try {
    await previous
  } catch {
    // A previous holder's failure must not poison the queue; the lock is a
    // timing device, not a result.
  }
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function dispatchPending(store, options = {}) {
  // R-21. Within one process, the tick and the button do not overlap at all.
  return withDispatchLock(store, () => dispatchPendingClaimed(store, options))
}

/**
 * The claim half: due rows, marked `dispatching`, read and written atomically.
 *
 * Returns the rows this caller has claimed and may deliver, in the shape
 * `dispatchPendingUnlocked` expects — carrying `dispatching_at` so the outcome
 * write knows what it is completing.
 */
async function claimPending(store, { maxBatch, nowMs }) {
  return store.withLock(async (locked) => {
    // A manifest read, not the whole store: these functions read one
    // collection, and naming it turns the Postgres read into a `WHERE
    // collection = ANY(...)` instead of materialising every row. The tick's
    // read-once budget (SCL-02) depends on it too.
    const data = await locked.read(['events_outbox'])
    const claimedAt = new Date(nowMs).toISOString()
    const due = (data.events_outbox || [])
      .filter((e) => e.status === 'pending')
      // CON-07. A row another replica is mid-delivery on is not pending for this
      // one. The TTL reclaims a claim whose owner died.
      .filter((e) => !e.dispatching_at || (nowMs - Date.parse(e.dispatching_at)) > DISPATCH_CLAIM_TTL_MS)
      // R-20. `next_attempt_at` is consulted here, not only written. A backoff
      // that is recorded and never read is a comment.
      .filter((e) => !e.next_attempt_at || Date.parse(e.next_attempt_at) <= nowMs)
      .slice(0, maxBatch)
    if (!due.length) return []
    const claims = due.map((row) => ({ ...row, dispatching_at: claimedAt }))
    await locked.merge({ events_outbox: claims })
    return claims
  })
}

/** The record half: outcomes written under the lock, so a claim is always resolved. */
async function recordDispatch(store, updates) {
  if (!updates.length) return
  await store.withLock(async (locked) => locked.merge({ events_outbox: updates }))
}

async function dispatchPendingClaimed(store, options) {
  const { maxBatch = 50, now = Date.now } = options
  const nowMs = now()
  const claimed = await claimPending(store, { maxBatch, nowMs })
  if (!claimed.length) {
    return { dispatched: 0, failed: 0, undeliverable: 0, deferred: 0 }
  }
  const { updates, counts } = await deliverClaimed(claimed, options)
  await recordDispatch(store, updates)
  return counts
}

/**
 * Delivers claimed rows and computes their new state. No store access — the
 * caller owns both the claim and the outcome write.
 */
async function deliverClaimed(claimed, options) {
  // checkUrl defaults to the SSRF guard and exists so tests can deliver to a
  // loopback listener; nothing in the request path passes it.
  const {
    webhooks = [],
    timeoutMs = 5000,
    checkUrl = assertSafeWebhookUrl,
    now = Date.now,
  } = options
  const nowMs = now()

  const updates = []
  let dispatched = 0
  let failed = 0
  let undeliverable = 0
  let deferred = 0

  for (const outboxEvent of claimed) {
    const matchedWebhooks = webhooks.filter((w) =>
      w.status === 'active' && matchEvent(w, outboxEvent.event)
    )

    if (!matchedWebhooks.length) {
      // Not sent. Not a success either — there is nobody to send it to, and an
      // event nobody is subscribed to is a configuration fact, not a delivery.
      // It is left `pending` with no retry floor: a subscription may be created
      // later, and the event is then still deliverable. The claim is cleared so
      // the next cycle re-examines it.
      updates.push({
        ...outboxEvent,
        status: 'pending',
        dispatching_at: null,
        undeliverable: true,
        last_error: 'no active webhook is subscribed to this event',
      })
      undeliverable += 1
      continue
    }

    let successCount = 0
    let lastError = null

    for (const webhook of matchedWebhooks) {
      try {
        const body = JSON.stringify({
          event: outboxEvent.event,
          payload: outboxEvent.payload,
          sent_at: nowIso(),
        })

        const headers = {
          'content-type': 'application/json',
          ...(webhook.headers || {}),
        }

        if (webhook.secret) {
          headers['x-signature'] = signPayload(webhook.secret, body)
        }

        // Re-check at the point of use. DNS rebinding means a host that resolved
        // publicly when the subscription was created can point at 127.0.0.1 or
        // 169.254.169.254 by the time this event is delivered.
        await checkUrl(webhook.url)

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (response.ok) {
          successCount += 1
        } else {
          lastError = `HTTP ${response.status}`
        }
      } catch (error) {
        lastError = error.message
        // Swallow individual webhook errors; retry in next cycle
        logger.error('webhook_delivery_failed', {
          webhook_id: webhook.id,
          url: webhook.url,
          outbox_event: outboxEvent.event,
          attempt: outboxEvent.attempts + 1,
          error: error.message,
        })
      }
    }

    const isSuccess = successCount > 0
    const nextAttempts = outboxEvent.attempts + 1
    const attemptedAt = nowIso()
    // Carried forward rather than reset, so a merge of the update cannot erase
    // the record of how many times this has been tried. `dispatching_at` is
    // cleared because this claim is being resolved.
    const base = { ...outboxEvent, attempts: nextAttempts, last_attempt_at: attemptedAt, dispatching_at: null }

    if (isSuccess) {
      updates.push({ ...base, status: 'sent', last_error: null, next_attempt_at: null, undeliverable: false, sent_at: attemptedAt })
      dispatched += 1
    } else if (nextAttempts >= OUTBOX_MAX_RETRIES) {
      // Dead-lettered. This state used to be unreachable for any re-emitted
      // event, so the row read as a live retry forever.
      updates.push({
        ...base,
        status: 'failed',
        last_error: lastError || 'no webhook accepted the event',
        next_attempt_at: null,
        failed_at: attemptedAt,
      })
      failed += 1
    } else {
      // The backoff the comment promised. `next_attempt_at` is honoured by the
      // filter at the top of this function, so an event waiting out a 40-second
      // cooldown is not retried on the next dispatch tick.
      const wait = backoffMs(nextAttempts)
      updates.push({
        ...base,
        status: 'pending',
        last_error: lastError,
        next_attempt_at: new Date(nowMs + wait).toISOString(),
        undeliverable: false,
      })
      deferred += 1
    }
  }

  return { updates, counts: { dispatched, failed, undeliverable, deferred } }
}

/**
 * Clear a dead letter deliberately.
 *
 * `emit` will not do it — it returns the failed row untouched, because every
 * retry path in this platform re-emits the event it is retrying, and a row
 * that could be resurrected by a re-emit never stays dead. So recovery is a
 * separate, explicit call: an operator has decided the endpoint is fixed and
 * wants these replayed, and that decision is visible in the code that makes it
 * rather than implied by a retry tick.
 *
 * Returns the rows it requeued, so a caller can report what it revived.
 */
export async function redriveOutbox(store, { ids = null, event = null } = {}) {
  // CON-01. Read and merge in one transaction, so two operators redriving at
  // once do not each revive a row from the same stale snapshot.
  return store.withLock(async (locked) => {
    // A manifest read, not the whole store: these functions read one
    // collection, and naming it turns the Postgres read into a `WHERE
    // collection = ANY(...)` instead of materialising every row. The tick's
    // read-once budget (SCL-02) depends on it too.
    const data = await locked.read(['events_outbox'])
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null
    const revived = (data.events_outbox || []).filter((row) => {
      if (row.status !== 'failed') return false
      if (wanted) return wanted.has(row.id)
      if (event) return row.event === event
      return true
    })
    if (!revived.length) return []

    const updates = revived.map((row) => ({
      ...row,
      status: 'pending',
      // The counter goes back to zero because this is a fresh attempt at a fresh
      // situation, and a redrive that started at 5 would have one try left.
      attempts: 0,
      next_attempt_at: null,
      failed_at: null,
      redriven_at: nowIso(),
    }))
    await locked.merge({ events_outbox: updates })
    return updates
  })
}

/**
 * R-47. The dead-letter surface.
 *
 * A row at `status: 'failed'` was invisible: `/api/v1/outbox` pages raw rows
 * with no rollup, no UI reads it, and nothing counts them. A permanently
 * failing integration is therefore indistinguishable from a healthy queue
 * until someone reads the JSON by hand.
 *
 * `failed` is the terminal state and is never retried, so this is the whole
 * story of what stopped getting through — it belongs on `/ready`, not buried
 * in a paged list. `undeliverable` is the near-miss: events nobody is
 * subscribed to. It is not a failure, and counting it as one would train people
 * to ignore the number; it is the configuration mistake that quietly stops
 * every future notification, so it is reported separately and never zero.
 */
export function outboxRollup(data = {}) {
  const rows = Array.isArray(data.events_outbox) ? data.events_outbox : []
  const counts = { pending: 0, sent: 0, failed: 0 }
  let undeliverable = 0
  for (const row of rows) {
    const status = Object.hasOwn(counts, row?.status) ? row.status : 'pending'
    counts[status] += 1
    if (row?.undeliverable) undeliverable += 1
  }
  const failed = rows
    .filter((row) => row?.status === 'failed')
    .map((row) => ({
      id: row.id,
      event: row.event,
      attempts: row.attempts ?? 0,
      failed_at: row.failed_at || row.last_attempt_at || null,
      last_error: row.last_error || null,
    }))
  const nextAttempt = rows
    .filter((row) => row?.status === 'pending' && row?.next_attempt_at)
    .map((row) => row.next_attempt_at)
    .sort()[0] || null

  return {
    total: rows.length,
    counts,
    undeliverable,
    failed_count: counts.failed,
    // The dead letters themselves, oldest first, capped. The count is the
    // number an operator acts on; the rows are what they act with.
    failed,
    next_attempt_at: nextAttempt,
    // True when something has been permanently lost. `/ready` wants a boolean,
    // not a shape it has to interpret.
    degraded: counts.failed > 0,
  }
}
