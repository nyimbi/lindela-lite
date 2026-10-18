/**
 * DATA-14 — a record a backend cannot name is a record one backend stores.
 *
 * The register's claim was "`schema.js` performs no validation … arbitrary
 * shapes are accepted and persisted." Probing every path the entry could mean
 * found that claim half wrong and half worse than stated:
 *
 *   - **The route normalisers are already closed-shape.** `buildCreate`,
 *     `buildUpdate`, `normalizeAlertRule`, `normalizeWebhookSubscription`,
 *     `normalizeIngestionSchedule` and `normalizeTriggerProtocol` each build a
 *     record from an explicit field list, so an unknown key never reaches the
 *     store through them. The entry's "arbitrary shapes are accepted" is false
 *     of the surfaces an operator uses.
 *   - **The CSV upload path carries unknown headers on purpose**, and says so
 *     at `src/upload.js:175`: "an unknown header is still carried through as
 *     its own field rather than dropped on the floor." That is a deliberate
 *     trade — an export headed `District` keeps its district — not a defect.
 *   - **The store accepted records it could not name, and the two backends
 *     disagreed about what that means.** `JsonStore.merge` kept an id-less
 *     record verbatim; `PostgresStore` filters `records.filter((item) =>
 *     item?.id)` out of every write, so the same call succeeded on both
 *     backends and stored nothing on one. That is the ARC-10 divergence class,
 *     and it was not hypothetical: `computePopulationAtRisk`,
 *     `computeFacilitiesAtRisk` and `simulateDisbursement` all emitted rows
 *     with no `id`, so the exposure figures and the parametric payout ledger
 *     were written on a JSON store and silently discarded on the database.
 *
 * The fix has two halves, and this file guards both: producers name their rows
 * (asserted against the producers themselves, not a hand-built fixture), and
 * the store refuses an unnamed row on either backend rather than dropping it on
 * one. The old conformance test could not catch this because it supplied
 * `id: 'par-1'` — a field the real producer never emitted.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { JsonStore, assertRecordsNamed } from '../src/store.js'
import { computeFacilitiesAtRisk, computePopulationAtRisk } from '../src/analytics/impact.js'
import { simulateDisbursement } from '../src/parametric.js'

const hazard = (id, extra = {}) => ({
  id,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  latitude: -1.5,
  longitude: 36.2,
  ...extra,
})

const asset = (id, extra = {}) => ({
  id,
  name: `Facility ${id}`,
  latitude: -1.5,
  longitude: 36.2,
  service_type: 'health',
  population_served: 1200,
  ...extra,
})

describe('DATA-14 — every producer names its rows', () => {
  it('computePopulationAtRisk emits an id on every row', () => {
    const rows = computePopulationAtRisk({
      service_assets: [asset('a-1'), asset('a-2')],
      hazard_events: [hazard('hz-1'), hazard('hz-2')],
    })
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(typeof row.id, 'string')
      assert.ok(row.id, 'a row with an empty id is as nameless as one with none')
    }
    assert.notEqual(rows[0].id, rows[1].id, 'two hazards are two rows, so they are two ids')
  })

  it('computePopulationAtRisk names a hazard that carries no id of its own', () => {
    // A hazard with coordinates but no id still produces a row — `hazardKey`
    // falls back to the position. The row must still be nameable, because the
    // alternative is that the Postgres adapter drops it and the JSON store
    // keeps it, which is the divergence this whole entry is about.
    const rows = computePopulationAtRisk({
      service_assets: [asset('a-1')],
      hazard_events: [{ event_type: 'flood', latitude: -1.5, longitude: 36.2 }],
    })
    assert.equal(rows.length, 1)
    assert.ok(rows[0].id)
    assert.equal(rows[0].hazard_event_id, null, 'an absent hazard id is null, not a fabricated string')
  })

  it('computeFacilitiesAtRisk emits an id on every row', () => {
    const rows = computeFacilitiesAtRisk({
      service_assets: [asset('a-1'), asset('a-2', { service_type: 'water' })],
      hazard_events: [hazard('hz-1')],
    })
    assert.equal(rows.length, 2)
    for (const row of rows) assert.ok(row.id, `${row.service_type} row has no id`)
  })

  it('the ids are stable across two identical runs', () => {
    // A derived collection is replaced wholesale on every refresh. If the id
    // moved between runs, the store would hold a different row for the same
    // figure and every bitemporal history entry would be a false revision.
    const data = { service_assets: [asset('a-1')], hazard_events: [hazard('hz-1')] }
    assert.deepEqual(
      computePopulationAtRisk(data).map((r) => r.id),
      computePopulationAtRisk(data).map((r) => r.id),
    )
    assert.deepEqual(
      computeFacilitiesAtRisk(data).map((r) => r.id),
      computeFacilitiesAtRisk(data).map((r) => r.id),
    )
  })

  it('simulateDisbursement emits both `disbursement_id` and `id`', () => {
    const rule = {
      id: 'rule-1',
      chain: 'polygon-mumbai',
      contract_address: '0xabc',
      disbursement_amount_local_currency: 100,
      currency: 'USD',
      recipient_group_id: 'group-1',
      requires_focal_point_approval: false,
    }
    const result = simulateDisbursement(rule, { triggerValue: 1, context: {} })
    assert.ok(result.disbursement_id, 'the domain name is still the payout identity')
    assert.equal(result.id, result.disbursement_id, 'the store keys on `id`, so it carries the same value')
  })
})

describe('DATA-14 — the store refuses a record it cannot name', () => {
  let dir
  let store

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data14-'))
    store = new JsonStore(path.join(dir, 'store.json'))
    await store.write({})
  })

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const unnamed = [
    ['no id at all', { event_type: 'flood' }],
    ['an empty id', { id: '', event_type: 'flood' }],
    ['a numeric id', { id: 7, event_type: 'flood' }],
    ['a null id', { id: null, event_type: 'flood' }],
  ]

  for (const [label, record] of unnamed) {
    it(`refuses a record with ${label} on merge`, async () => {
      await assert.rejects(
        () => store.merge({ hazard_events: [record] }),
        /Unnamed record/,
        'an id-less record is kept by JSON and dropped by Postgres; the store must refuse rather than diverge',
      )
    })
  }

  it('refuses a record that is not an object at all', async () => {
    // A string reaches `map.set(item.id, …)` as `undefined` and the JSON store
    // writes the string's character indices as fields. Postgres drops it.
    for (const record of ['a string', 42, ['nested'], null]) {
      await assert.rejects(() => store.merge({ hazard_events: [record] }), /Unnamed record/)
    }
  })

  it('refuses an id-less row on replaceCollection', async () => {
    await assert.rejects(
      () => store.replaceCollection('parametric_disbursements', [{ disbursement_id: 'd-1' }]),
      /Unnamed record/,
      'replaceCollection is how the money path writes; it must refuse too',
    )
  })

  it('refuses an id-less row on replaceAnalytics', async () => {
    await assert.rejects(
      () => store.replaceAnalytics({ population_at_risk: [{ hazard_event_id: 'h-1' }] }),
      /Unnamed record/,
      'the derived write is the one that silently discarded the exposure figures',
    )
  })

  it('refuses an id-less row on write', async () => {
    await assert.rejects(() => store.write({ hazard_events: [{ event_type: 'flood' }] }), /Unnamed record/)
  })

  it('still accepts a well-formed write, and stores it', async () => {
    // The control. A guard that refuses everything is not a guard.
    await store.write({})
    await store.merge({ hazard_events: [{ id: 'hz-ok', event_type: 'flood' }] })
    const rows = (await store.read(['hazard_events'])).hazard_events
    assert.deepEqual(rows.map((r) => r.id), ['hz-ok'])
  })

  it('names the collection and the fields, so the fix has an address', async () => {
    await assert.rejects(
      () => store.merge({ climate_observations: [{ observed_at: '2026-10-18T00:00:00Z', metric: 'rain', value: 3 }] }),
      (error) => {
        assert.match(error.message, /climate_observations/)
        assert.match(error.message, /observed_at/)
        assert.match(error.message, /Postgres filters these out/)
        return true
      },
    )
  })

  it('the guard itself is the thing that fires, not a downstream symptom', () => {
    // Called directly, so a refactor that removes a call site from one adapter
    // still leaves this assertion meaningful about the predicate.
    assert.throws(() => assertRecordsNamed({ hazard_events: [{ event_type: 'flood' }] }), /Unnamed record/)
    assert.doesNotThrow(() => assertRecordsNamed({ hazard_events: [{ id: 'hz-1' }] }))
    assert.doesNotThrow(() => assertRecordsNamed({}), 'an empty payload has nothing to name')
    assert.doesNotThrow(() => assertRecordsNamed({ version: 1, updated_at: 'now' }), 'store metadata is not a collection')
  })
})
