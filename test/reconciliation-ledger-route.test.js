import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { refreshAnalytics, DERIVED_INPUTS, RUN_INPUTS } from '../src/analytics.js'
import { emptyStore } from '../src/schema.js'
import { verifyChain } from '../src/audit-chain.js'
import { RECONCILIATION_OUTCOMES } from '../src/reconciliation.js'

/**
 * ENH-51 — the ledger has a caller, and the caller is the refresh that produces
 * the numbers it reconciles.
 *
 * The module was complete, tested, and reached by nothing. A ledger nothing
 * writes is a claim rather than a control: every property in its header —
 * four outcomes, the refusal that is never folded into agreement, the
 * hash-chained events — was unobservable through the product.
 *
 * Three things had to hold before wiring it meant anything, and two of them were
 * false when this file was written:
 *
 *   1. a derived number must carry a `_provenance` envelope, because
 *      `reconcileNumber` refuses `no_provenance` before it compares anything;
 *   2. that envelope's run id must be a function of the inputs, not of the clock,
 *      or every refresh is a new run and every pair reconciles;
 *   3. the events must land somewhere the store declares, or `merge` throws on an
 *      undeclared collection.
 *
 * The tests below assert each, and the one that matters most is the negative: a
 * refresh over unchanged inputs must produce *no* events. A ledger that fires on
 * every refresh is read as noise by the third week, which is the failure its own
 * header names.
 */

/**
 * One asset near one hazard, so the risk, impact and road paths all produce rows.
 *
 * `far` adds a hazard in the same district but outside the 250 km scoring radius.
 * That is the only way to move a *declared input* without moving the score it
 * feeds, which is the `unchanged_with_input_change` finding. A hazard added
 * inside the radius moves both and reconciles cleanly.
 */
const seeded = (hazardCount = 1, { far = false } = {}) => ({
  service_assets: [
    { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', admin1: 'Turkana', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
    { id: 'c1', name: 'Clinic', service_type: 'health', country: 'KE', admin1: 'Turkana', latitude: 3.11, longitude: 35.61 },
  ],
  hazard_events: [
    ...Array.from({ length: hazardCount }, (_, i) => ({
      id: `h${i}`, event_type: 'flood', severity: 'critical', title: 'Flood',
      latitude: 3.1 + i * 0.001, longitude: 35.6, district: 'Turkana',
    })),
    ...(far ? [{ id: 'h-far', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 10, longitude: 40, district: 'Turkana' }] : []),
  ],
  climate_observations: [
    { id: 'cl1', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 20, observed_at: '2026-01-01T00:00:00.000Z' },
    { id: 'cl2', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 25, observed_at: '2026-02-01T00:00:00.000Z' },
    { id: 'cl3', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 30, observed_at: '2026-03-01T00:00:00.000Z' },
    { id: 'cl4', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 35, observed_at: '2026-04-01T00:00:00.000Z' },
  ],
})

/**
 * A real store holding real records.
 *
 * Not a mock: it implements the same four methods the refresh uses and merges by
 * id the way `JsonStore` does. It exists because the refresh reads the store
 * twice — once for the inputs and once for the outgoing derived rows — and a stub
 * that returned a shared reference would have the swap overwrite the "before"
 * side before it was read, which is the exact ordering the refresh's own comment
 * warns about.
 */
class MemoryStore {
  constructor(initial = emptyStore()) {
    this.state = structuredClone(initial)
  }

  async read() {
    return structuredClone(this.state)
  }

  async merge(partial = {}) {
    for (const [key, records] of Object.entries(partial)) {
      if (!Array.isArray(records)) {
        this.state[key] = records
        continue
      }
      const byId = new Map((this.state[key] || []).map((row) => [row.id, row]))
      for (const record of records) byId.set(record.id, record)
      this.state[key] = [...byId.values()]
    }
    return this.state
  }

  async replaceAnalytics(payload = {}) {
    for (const name of Object.keys(payload)) this.state[name] = payload[name]
    return this.state
  }
}

const events = (store) => store.state.reconciliation_events || []

/** Refresh until the derived set is steady: the first run populates `risk_scores`, which `impact_assessments` reads. */
async function steady(store) {
  await refreshAnalytics(store)
  await refreshAnalytics(store)
  return refreshAnalytics(store)
}

describe('ENH-51 — a derived number is traceable, or the ledger refuses it', () => {
  it('stamps every derived row with an envelope naming the run that produced it', async () => {
    const store = new MemoryStore({ ...emptyStore(), ...seeded() })
    await refreshAnalytics(store)
    const rows = [...(store.state.risk_scores || []), ...(store.state.impact_assessments || [])]
    assert.ok(rows.length > 0, 'the fixture must produce derived rows or the assertion below is vacuous')
    for (const row of rows) {
      assert.ok(row._provenance, `${row.id} carries no envelope, so the ledger can only refuse it`)
      assert.ok(row._provenance.source_run_id, 'an envelope without a run id is the `incomplete` refusal')
      assert.ok(row._provenance.transform_version, 'and without a transform the "the engine changed" outcome is uncheckable')
    }
  })

  it('gives the run an id that is a function of the inputs, not of the clock', async () => {
    // The property that makes the whole thing work. If the run id moved with the
    // clock, two refreshes of the same inputs would be two different runs and
    // every number would come back `reconciled` — a ledger that reports the
    // engine agreeing with itself no matter what moved.
    //
    // The obvious version of this test — refresh twice, compare the ids — cannot
    // fail. `planDerivedRefresh` caches on the input digest, so the second
    // refresh skips `risk_scores` entirely, the row is never recomputed, and the
    // store hands back the first run's envelope. It passes against a clock-based
    // id, which is how it was found. A test that only ever sees one run is not
    // testing the id at all.
    //
    // So: run, move the inputs, move them back. Step 3's digest differs from
    // step 2's, so the row *is* recomputed — and if the id is a pure function of
    // the inputs, step 3 lands on step 1's id. A skip would leave step 2's id
    // there instead, and a clock would leave a third.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await refreshAnalytics(store)
    const one = (store.state.risk_scores || [])[0]?._provenance?.source_run_id
    store.state.hazard_events = seeded(6).hazard_events
    await refreshAnalytics(store)
    const six = (store.state.risk_scores || [])[0]?._provenance?.source_run_id
    store.state.hazard_events = seeded(1).hazard_events
    await refreshAnalytics(store)
    const back = (store.state.risk_scores || [])[0]?._provenance?.source_run_id

    assert.ok(one, 'the first run must stamp an id at all')
    assert.notEqual(one, six, 'the id must move when the inputs move, or it names nothing')
    assert.equal(back, one, 'the same inputs must be the same run; a clock here makes every refresh a new one')
  })

  it('refuses rather than guesses when the inputs cannot be digested', async () => {
    // A BigInt a connector left behind has no digest, so there is no run id, so
    // there is no envelope — and a number with no envelope reconciles to
    // `cannot_trace`, which is the honest answer. An id invented from an
    // undigestible input would be a claim that two such refreshes are the same
    // run.
    const store = new MemoryStore({ ...emptyStore(), ...seeded() })
    store.state.flood_probability_models = [{ id: 'm1', region: 'Turkana', big: 5n }]
    await refreshAnalytics(store)
    const rows = store.state.risk_scores || []
    assert.ok(rows.length > 0, 'the fixture must still produce rows')
    for (const row of rows) {
      assert.equal(row._provenance, undefined, 'an undigestible input must leave the number untraceable, not mislabelled')
    }
  })

  it('digests every input the derived set declares, and none of the derived set itself', () => {
    // The invariant the round-trip test above cannot cover. Driving one
    // collection through a refresh proves the id is reproducible; it says
    // nothing about the twelve collections this fixture never moves, and a
    // collection dropped from the digest leaves the id holding while the number
    // moves — the spurious `changed_without_input_change` again, now for an
    // input nobody thought to test.
    //
    // Two directions, because the set fails in two ways. Too narrow and a real
    // input goes unhashed; too wide and the derived collections come back in and
    // the id feeds on itself.
    const declared = new Set(DERIVED_INPUTS.flatMap((entry) => entry.inputs))
    const derivedNames = new Set(DERIVED_INPUTS.map((entry) => entry.name))
    const digested = new Set(RUN_INPUTS)

    for (const name of declared) {
      if (derivedNames.has(name)) continue
      assert.ok(digested.has(name), `${name} is read by a scorer and is not in the run id, so its movement is invisible`)
    }
    for (const name of RUN_INPUTS) {
      assert.ok(declared.has(name), `${name} is in the run id but nothing declares reading it`)
      assert.ok(!derivedNames.has(name), `${name} is a derived output; hashing it makes the run id a function of the last run`)
    }
    assert.ok(RUN_INPUTS.length > 0, 'an empty set digests to a constant and every refresh is the same run')
  })
})

describe('ENH-51 — the ledger runs inside the refresh, and only reports findings', () => {
  it('reports nothing when the inputs stood still', async () => {
    // The negative case, and the one that decides whether the ledger is read or
    // ignored. Three refreshes of an unchanged store: the first is a first sight
    // of every number, and the next two compare numbers against themselves.
    const store = new MemoryStore({ ...emptyStore(), ...seeded() })
    await steady(store)
    const stored = events(store)
    assert.deepEqual(stored.filter((event) => event.finding).map((event) => event.record_id), [],
      'an unchanged store produced findings, so the ledger is noise')
  })

  it('records a number that held while its inputs moved', async () => {
    // ENH-23's finding, reached through the ledger: the inputs moved and the
    // number did not, which usually means the input is not wired in.
    //
    // The fixture has to produce this deliberately. Adding hazards *inside* the
    // scoring radius moves the score as well as the count, so the outcome is
    // `reconciled` — the system working — and a test built on that asserts the
    // opposite of what it means to. The hazard added here is in the same
    // district and outside the 250 km scoring radius, so the declared input
    // moves and the score cannot.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await steady(store)
    const before = events(store).length
    store.state.hazard_events = seeded(1, { far: true }).hazard_events
    await refreshAnalytics(store)
    const after = events(store)
    assert.ok(after.length > before, 'a moved input must produce at least one event')
    const held = after.filter((event) => event.outcome === 'unchanged_with_input_change')
    assert.ok(held.length > 0, `expected an unchanged_with_input_change event, got ${JSON.stringify(after.map((e) => e.outcome))}`)
    assert.match(held[0].summary, /hazard_events/, 'the event must name the input that moved')
  })

  it('chains every stored event, so the log is tamper-evident rather than merely written', async () => {
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await steady(store)
    store.state.hazard_events = seeded(1, { far: true }).hazard_events
    await refreshAnalytics(store)
    const stored = events(store)
    assert.ok(stored.length > 0, 'the fixture must produce events or the chain assertion is vacuous')
    for (const event of stored) {
      assert.equal(typeof event.entry_hash, 'string', 'an unchained event is a log line, not a ledger')
      assert.equal(typeof event.seq, 'number')
    }
    // `verified` is the recomputation verdict; `anchored` is a separate claim
    // about whether the head was checked against something outside the store,
    // which a store-only test cannot supply. Asserting `anchored` here would be
    // asserting the test's own limitation.
    const verdict = verifyChain(stored)
    assert.equal(verdict.verified, true, `the stored chain must recompute: ${JSON.stringify(verdict.defects)}`)
    assert.equal(verdict.entry_count, stored.length, 'every stored event must be in the chain the verifier walked')
  })

  it('uses only outcomes from the frozen vocabulary', async () => {
    // A ledger that can report an outcome outside its own declaration is a
    // ledger whose aggregate counts silently miss rows. The set is exported so
    // this iterates it rather than re-typing the four strings.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await steady(store)
    store.state.hazard_events = seeded(1, { far: true }).hazard_events
    await refreshAnalytics(store)
    for (const event of events(store)) {
      assert.ok(RECONCILIATION_OUTCOMES.includes(event.outcome),
        `${event.outcome} is not in RECONCILIATION_OUTCOMES`)
    }
  })

  it('does not duplicate an event when the same comparison runs twice', async () => {
    // The event id is `stableId` over the key, the two run ids and the outcome —
    // never the clock — so re-reconciling the same pair merges rather than
    // appending. A ledger that re-reports the same event every refresh is noise
    // by construction.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await steady(store)
    store.state.hazard_events = seeded(1, { far: true }).hazard_events
    await refreshAnalytics(store)
    const first = events(store).length
    await refreshAnalytics(store)
    assert.equal(events(store).length, first,
      'a second refresh of the same pair appended a duplicate event')
  })

  it('stores into a declared collection rather than throwing on merge', async () => {
    // `merge` throws on a key that is not in `SCHEMA`, so an undeclared
    // `reconciliation_events` would take the whole refresh down — and the failure
    // would look like a reconciliation bug rather than a declaration one.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await steady(store)
    store.state.hazard_events = seeded(1, { far: true }).hazard_events
    const result = await refreshAnalytics(store)
    assert.ok(result, 'the refresh must complete')
    assert.ok(Array.isArray(store.state.reconciliation_events),
      'the ledger wrote nowhere, so nothing reconciles in production')
  })
})

/**
 * The impact family, which the ledger could not see at all.
 *
 * Every test above passes with the impact half broken, which is how the three
 * defects below survived: the ledger's own coverage was the risk family, and an
 * impact row was silently excluded from every comparison rather than reported as
 * a refusal. That is the "a check scoped narrower than its jurisdiction reports
 * clean forever" failure, and the fix is tests that fail on the impact half
 * alone.
 */
describe('ENH-51 — an impact assessment is a number the ledger can follow', () => {
  it('keys an impact on its asset, not on the score the asset happens to carry', async () => {
    // The row's id was `stableId('impact', [asset.id, score])` — a function of
    // the value it carries, so a moved score produced a *different row*. The
    // store held both, the ledger saw `no_prior_observation` on each side of
    // every comparison, and nothing that follows a number across a refresh —
    // bitemporal, replay, this ledger — could pair one asset with its own past.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await refreshAnalytics(store)
    const first = new Map((store.state.impact_assessments || []).map((row) => [row.asset_id, row]))
    assert.ok(first.size > 0, 'the fixture must produce impact rows')
    store.state.hazard_events = seeded(6).hazard_events
    await refreshAnalytics(store)
    const rows = store.state.impact_assessments || []
    assert.equal(rows.length, first.size, `a moved score must update each row, not add one: got ${rows.length} for ${first.size} assets`)
    for (const row of rows) {
      assert.equal(row.id, first.get(row.asset_id)?.id, `${row.asset_id} changed identity when its value moved`)
      assert.notEqual(row.impact_score, first.get(row.asset_id)?.impact_score, 'the fixture must actually move the score')
    }
  })

  it('counts an impact row’s declared inputs over a place that exists', async () => {
    // `inputDigestFor(placeOf(row))` resolved to `impact_<hash>` — the row's own
    // id, a name no record in the store carries — so every declared input counted
    // zero. A row whose inputs are all zero reads as "nothing moved" whatever
    // moves, which is a measurement that cannot move.
    //
    // The fixture carries a hazard in another district, because a null place is
    // not a neutral one: `inDistrict` returns true for every record when the
    // district is falsy, so a count asserted without an out-of-district record
    // passes against a row that has no district at all. That is how the first
    // version of this test was blind.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    store.state.hazard_events = [
      ...store.state.hazard_events,
      { id: 'h-elsewhere', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 0.3, longitude: 32.6, district: 'Kampala' },
    ]
    await refreshAnalytics(store)
    const row = (store.state.impact_assessments || [])[0]
    assert.ok(row.input_counts, 'the row must carry the counts its value was computed from')
    const counted = Object.values(row.input_counts).filter((n) => n > 0)
    assert.ok(counted.length > 0, `every declared input counted zero: ${JSON.stringify(row.input_counts)}`)
    assert.equal(row.input_counts.hazard_events, 1, 'only the hazard in the asset’s own district counts; the Kampala one must not')
  })

  it('reports an impact that held while its inputs moved', async () => {
    // The finding, on the family that could not produce one. A hazard added in
    // the same district but outside the scoring radius moves the declared input
    // and cannot move the score, so the row reconciles to
    // `unchanged_with_input_change` rather than silently absent.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await steady(store)
    store.state.hazard_events = seeded(1, { far: true }).hazard_events
    await refreshAnalytics(store)
    const held = events(store).filter((event) => event.collection === 'impact_assessments')
    assert.equal(held.length, 2, `expected one finding per asset, got ${JSON.stringify(events(store).map((e) => [e.collection, e.outcome]))}`)
    for (const event of held) {
      assert.equal(event.outcome, 'unchanged_with_input_change')
      assert.match(event.summary, /hazard_events/, 'the event must name the input that moved')
    }
  })

  it('refuses a number whose scorer returned no value, rather than comparing a sentinel', async () => {
    // `computeCompoundHazardRisk` returns `score: null, level: 'unknown'` when the
    // window is too short. The value picker listed `level` and treated any
    // non-null as the value, so it fell past the null score to the sentinel
    // string — and the ledger reported a *finding* on a number that was never
    // computed, with "the value held at unknown" as the reason. A refusal
    // presented as a movement is the loudest way this module can lie.
    const store = new MemoryStore({ ...emptyStore(), ...seeded(1) })
    await steady(store)
    const compound = (store.state.risk_scores || []).find((row) => row.type === 'compound_hazard_risk')
    assert.ok(compound, 'the fixture must produce a compound row')
    assert.equal(compound.score, null, 'the refusal must be the null score, or this test is about nothing')
    store.state.hazard_events = seeded(1, { far: true }).hazard_events
    await refreshAnalytics(store)
    const about = events(store).filter((event) => /compound_hazard_risk/.test(event.key || ''))
    for (const event of about) {
      assert.notEqual(event.outcome, 'unchanged_with_input_change', `a refused score cannot "hold": ${JSON.stringify(event)}`)
      assert.ok(!/at unknown/.test(event.summary || ''), `a sentinel reached the summary: ${event.summary}`)
    }
  })
})
