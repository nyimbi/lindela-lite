import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { normalizeAlertRule } from '../src/alerts.js'
import { emptyStore } from '../src/schema.js'
import { evaluateAndPersistAlerts } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { emitMany } from '../src/outbox.js'

/**
 * CON-04 — an alert storm was O(raised × N).
 *
 * `evaluateAndPersistAlerts` persisted the alerts in one merge and then called
 * `emit` once per raised alert. `emit` reads the whole store to find one outbox
 * row and merges once to write it, so 200 raised alerts were 200 sequential
 * whole-store reads and 200 merges, on the request path and on the periodic
 * tick, for work that is O(1) per alert.
 *
 * The defect is invisible in the result — the same rows land either way — so the
 * seam is the read, counted. A merge is counted too, because on PostgreSQL each
 * one is its own transaction.
 */

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-alert-emit-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** A store that counts reads and merges, and excludes those inside a mutation. */
function counting(store) {
  const counts = { reads: 0, merges: 0 }
  let mutating = false
  return {
    counts,
    store: new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'read') {
          return async (options) => {
            if (!mutating) counts.reads += 1
            return target.read(options)
          }
        }
        if (prop === 'merge') {
          return async (partial) => {
            counts.merges += 1
            mutating = true
            try {
              return await target.merge(partial)
            } finally {
              mutating = false
            }
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }
}

/**
 * `n` active rules that all fire against the same context.
 *
 * Distinct names, so each normalises to a distinct id and each raises its own
 * alert — one rule cannot raise two.
 */
const rules = (n) => Array.from({ length: n }, (_, i) => normalizeAlertRule({
  name: `Storm rule ${i + 1}`,
  metric: 'counts.hazard_events',
  operator: '>=',
  threshold: 1,
  severity: 'high',
}))

/**
 * Three hazard events, which is what the rules threshold on.
 *
 * `evaluateAndPersistAlerts` builds its own context from the data rather than
 * taking one — the counts have to be in the store, not passed alongside it.
 */
const dataWith = (n) => ({
  ...emptyStore(),
  alert_rules: rules(n),
  hazard_events: Array.from({ length: 3 }, (_, i) => ({
    id: `h${i + 1}`, event_type: 'flood', severity: 'moderate', observed_at: '2026-01-01T00:00:00.000Z',
  })),
})

describe('CON-04 — an alert storm does not fan out one store round-trip per alert', () => {
  it('reads the store a bounded number of times for twenty raised alerts', async () => {
    await withStore(async (raw) => {
      const { store, counts } = counting(raw)
      const result = await evaluateAndPersistAlerts(store, dataWith(20))
      assert.equal(result.raised.length, 20, 'the fixture must actually raise twenty alerts')
      // One read for the persist path's own lookups plus one for the emit batch.
      // The per-alert loop read once per alert: twenty.
      assert.ok(counts.reads <= 3,
        `twenty raised alerts cost ${counts.reads} whole-store reads; the fan-out is per-alert again`)
    })
  })

  it('writes every alert and every outbox row, so the batch is not a silent drop', async () => {
    await withStore(async (raw) => {
      await evaluateAndPersistAlerts(raw, dataWith(20))
      const after = await raw.read()
      assert.equal(after.alert_events.length, 20)
      const pending = after.events_outbox.filter((row) => row.event === 'alert_event.created')
      assert.equal(pending.length, 20, 'every raised alert must have its own outbox row')
      assert.equal(new Set(pending.map((row) => row.id)).size, 20, 'the rows must be distinct, not one overwritten')
    })
  })

  it('still carries the alert itself in the same commit as its event', async () => {
    // `emit`'s `writes` argument exists so a caller can put the record and the
    // event in one merge. The batch keeps that property — it is the reason the
    // fan-out could not simply be replaced by "merge the alerts, then merge the
    // events".
    await withStore(async (raw) => {
      const alert = { id: 'a-1', type: 'alert_event', status: 'open', created_at: new Date().toISOString() }
      await emitMany(raw, [{ event: 'alert_event.created', payload: alert, writes: { alert_events: [alert] } }])
      const after = await raw.read()
      assert.equal(after.alert_events.length, 1)
      assert.equal(after.events_outbox.length, 1)
    })
  })

  it('does not resurrect a dead letter, and does not re-send a delivered one', async () => {
    // The two short-circuits `emit` has, kept per item in the batch. A batch that
    // dropped them would re-pend a dead letter on every tick and never let it
    // stay dead — the R-20 failure, reintroduced one level up.
    await withStore(async (raw) => {
      // The ids are derived from `(event, payload)` — `stableId('outbox', …)` —
      // so the fixtures are created by emitting and then having their delivery
      // state set, rather than by inventing an id the lookup would never match.
      const [dead, sent] = await emitMany(raw, [
        { event: 'x', payload: { id: 1 } },
        { event: 'y', payload: { id: 2 } },
      ])
      await raw.merge({
        events_outbox: [
          { ...dead, status: 'failed', attempts: 5, failed_at: '2026-01-01T00:00:00Z' },
          { ...sent, status: 'sent', attempts: 1 },
        ],
      })

      const result = await emitMany(raw, [
        { event: 'x', payload: { id: 1 } },
        { event: 'y', payload: { id: 2 } },
      ])
      assert.equal(result[0].status, 'failed', 'a dead letter was resurrected')
      assert.equal(result[1].status, 'sent', 'a delivered event was re-pended')

      const after = await raw.read()
      assert.equal(after.events_outbox.find((row) => row.id === dead.id).status, 'failed')
      assert.equal(after.events_outbox.find((row) => row.id === sent.id).status, 'sent')
      assert.deepEqual(after.events_outbox.find((row) => row.id === dead.id).payload, { id: 1 })
    })
  })

  it('carries attempts and backoff forward for a pending row, as emit does', async () => {
    await withStore(async (raw) => {
      const waiting = {
        id: undefined, event: 'z', payload: { id: 3 }, status: 'pending', attempts: 2,
        next_attempt_at: '2099-01-01T00:00:00Z', last_error: 'connection refused',
      }
      // Get the real id by emitting once, then write the delivery state onto it.
      const [first] = await emitMany(raw, [{ event: waiting.event, payload: waiting.payload }])
      await raw.merge({ events_outbox: [{ ...first, attempts: 2, next_attempt_at: waiting.next_attempt_at, last_error: waiting.last_error }] })

      const [again] = await emitMany(raw, [{ event: waiting.event, payload: waiting.payload }])
      assert.equal(again.attempts, 2, 're-emitting reset the retry counter, which is what made maxRetries unreachable')
      assert.equal(again.next_attempt_at, waiting.next_attempt_at, 'the cooldown was cleared by a re-emit')
      assert.equal(again.last_error, 'connection refused')
    })
  })

  it('merges the writes of every item in the batch, not just the last', async () => {
    await withStore(async (raw) => {
      await emitMany(raw, [
        { event: 'e1', payload: { id: 1 }, writes: { reports: [{ id: 'r1' }] } },
        { event: 'e2', payload: { id: 2 }, writes: { reports: [{ id: 'r2' }] } },
      ])
      const after = await raw.read()
      assert.deepEqual(after.reports.map((r) => r.id).sort(), ['r1', 'r2'])
    })
  })
})
