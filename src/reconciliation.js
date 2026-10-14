/**
 * ENH-51 — the reconciliation ledger.
 *
 * A published number is a claim, and a claim is only as good as the ability to
 * check it. This module joins the two halves the repository already keeps — the
 * bitemporal history (`src/bitemporal.js`) that remembers what a record used to
 * say, and the provenance layer (`src/provenance.js`) that remembers what a
 * record was computed from — into one question: *did this number change for a
 * reason its inputs can name?*
 *
 * The finding ENH-51 turns into a first-class event already existed as a log
 * line. `src/analytics.js` (ENH-23, `reconcileDerivedNumbers`) writes a row and
 * an `logger.error` when a derived value moved while its input counts stood
 * still. A log line is a thing an operator may see; an event is a thing a donor
 * can be answered on. This ledger is the latter, and it is the substrate for the
 * determinism claim in ENH-76: a number you can reconcile is a number you can
 * replay.
 *
 * ## The distinctions, each of which is a way the ledger could lie
 *
 * - **changed with changed inputs** is not a finding. It is the system working.
 *   A ledger that flags it produces a row on every refresh and is read as noise
 *   by the third week.
 * - **changed with unchanged inputs** is the finding. The value is not a
 *   function of its declared inputs, which is either a bug or an input nobody
 *   declared — a clock, a random seed, a map iteration order. The ledger names
 *   which, because "the number moved" without "and here is what moved it" is the
 *   log line this module replaces.
 * - **unchanged with changed inputs** is the finding people forget. The inputs
 *   moved and the number did not, which usually means the input is not actually
 *   wired in. The ledger reports it, because a silently ignored input is worse
 *   than a silently changed one.
 * - **cannot-trace** — no provenance for the number — is *not* reconciled. This
 *   repository has paid repeatedly for a check that measures nothing reporting
 *   success, so an absent trace is a refusal with a reason, never an agreement.
 *
 * ## Where the undefined-input classification comes from
 *
 * The declared inputs are the key set of `input_counts`, which ENH-23 stamps
 * onto each derived row from the collections it reads. A recompute path can be
 * handed inputs it did not declare — a clock, a seed — and those arrive in
 * `undeclared_inputs` on the observation. When a value moved over unchanged
 * declared inputs, the ledger attributes it to those undeclared inputs by name
 * if any were supplied, and otherwise says the cause is unknown. It does not
 * guess; an attribution nobody can check is the failure mode this module exists
 * to close.
 */

import { createHash } from 'node:crypto'

import { canonicalHash, nowIso, stableId } from './utils.js'
import { NUMERIC_VALUE_FIELDS, derivedKey } from './analytics.js'
import { CHAINED_FIELDS, GENESIS_HASH, chainDigestInput, chainEntry, computeEntryHash } from './audit-chain.js'

/**
 * The ledger's verdict vocabulary, exported so a route or a test iterates it
 * rather than re-typing the four strings. The silent key list is this repo's
 * signature defect and an exported list is the only version of it that cannot
 * rot.
 */
export const RECONCILIATION_OUTCOMES = Object.freeze([
  'reconciled',
  'changed_without_input_change',
  'unchanged_with_input_change',
  'cannot_trace',
])

/**
 * The reasons a number could not be traced. Exported for the same reason as the
 * outcome list: a consumer filters on these, so they are named once.
 *
 *   'no_provenance'   — the number carries no provenance envelope at all.
 *   'incomplete'      — an envelope is present but is missing a load-bearing
 *                       field, so it cannot name the run that produced the
 *                       number. A half-envelope is not a trace.
 *   'missing_inputs'  — the number names no inputs, so there is nothing to
 *                       compare the value against and no reconciliation is
 *                       possible. Distinct from "the inputs did not move":
 *                       that is a measurement, this is its absence.
 *   'no_prior_observation' — the number is present now and was not present
 *                       before, so there is no earlier value to hold it
 *                       against. A first sight is not an untraced number; it is
 *                       a number with no past yet, and `reconcileRun` counts it
 *                       separately for exactly that reason.
 */
export const TRACE_FAILURE_REASONS = Object.freeze(['no_provenance', 'incomplete', 'missing_inputs', 'no_prior_observation'])

/**
 * The envelope fields a trace requires, in the order they are checked.
 *
 * A proper subset of `PROVENANCE_FIELDS` in `src/provenance.js`, and the subset
 * is the point: `retrieval_url`, `upstream_id` and `upstream_id_state` describe
 * *where the record came from*, which is ENH-15's question. This module asks
 * *what produced the number*, and the answer needs the run and the transform —
 * `source_run_id` names the run, `transform_version` names the code, and
 * `payload_hash` is what lets two observations of the same record be told apart.
 * Requiring the rest would refuse to trace a number whose provenance is complete
 * for this question, which is a false refusal and the direction that matters.
 */
const TRACE_FIELDS = Object.freeze(['source_run_id', 'payload_hash', 'transform_version'])

/**
 * The value a published number carries, read through the field list
 * `analytics.js` exports, so "the value" means the same thing on both sides of a
 * comparison. It used to be a second copy of that list — same five entries, one
 * of them a label — which is a drift waiting for whichever module gained a
 * family first.
 */
function valueOf(record) {
  for (const field of NUMERIC_VALUE_FIELDS) {
    const value = record?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * The key a published number is compared under.
 *
 * `derivedKey` from `src/analytics.js`, not a spelling local to this module. The
 * reconciliation in ENH-23 already keys derived rows on `collection:type:place`,
 * and a ledger that keyed them differently would compare a flood score against a
 * conflict score for the same grid cell and call the difference a finding —
 * exactly the collapse ENH-23's comment warns against. One key function,
 * imported, so the two cannot drift.
 */
export function publishedKey(collection, record) {
  return derivedKey(collection, record)
}

/**
 * One side of a comparison: the value, the inputs it was computed from, and the
 * provenance that names the run.
 *
 * Accepts either a raw observation (`{collection, record, input_counts?,
 * provenance?, undeclared_inputs?}`) or one this module already built, and is
 * therefore idempotent — an observation returned from `observationMap` can be
 * fed straight back in without being rebuilt or losing its value.
 *
 * `input_counts` is taken from the record's own `input_counts` when the caller
 * did not supply one, because that is where ENH-23 stamps it. The inputs are
 * hashed to a digest rather than compared by identity: two count maps that agree
 * field for field are the same inputs however they were spelled, and one digest
 * is one comparable value to store in the event.
 *
 * Provenance is read from `provenance`, else from the record's own
 * `_provenance`, which is where `buildProvenance` tells callers to attach it.
 */
function toObservation(side) {
  if (!side) return null
  // Already an observation: it carries a key and a computed digest, so
  // rebuilding it would only recompute what is already there.
  if (side.key !== undefined && side.inputs_digest !== undefined) return side

  const record = side.record ?? side
  const inputs = side.input_counts !== undefined && side.input_counts !== null
    ? side.input_counts
    : record?.input_counts ?? null
  // An explicit `provenance: null` means "this number has none" and must not
  // fall through to the record's own `_provenance`; `??` alone cannot tell that
  // apart from the key being absent, so presence is checked directly.
  const declared = Object.hasOwn(side, 'provenance') ? side.provenance : undefined
  const provenance = declared !== undefined ? declared : (record?._provenance ?? null)
  return {
    key: side.key ?? publishedKey(side.collection, record),
    collection: side.collection,
    record,
    value: valueOf(record),
    inputs,
    inputs_digest: inputs ? canonicalHash(inputs) : null,
    input_fields: inputs ? Object.keys(inputs).sort() : [],
    provenance,
    source_run_id: side.source_run_id ?? provenance?.source_run_id ?? null,
    retrieved_at: side.retrieved_at ?? provenance?.retrieved_at ?? null,
    undeclared_inputs: Array.isArray(side.undeclared_inputs) ? side.undeclared_inputs : [],
  }
}

/**
 * Whether two observations of a number differ in a way that is a finding.
 *
 * Returns the comparison, not a verdict, so the caller decides the outcome and
 * the ledger has one place that classifies. A `null` value on either side is a
 * real state — the number could not be read — and is reported as incomparable
 * rather than as a change, because a comparison against nothing is not a
 * measurement.
 */
function compareValues(before, after) {
  const a = before.value
  const b = after.value
  if (a === null || b === null) return { comparable: false, changed: null, delta: null }
  if (typeof a === 'number' && typeof b === 'number') {
    // `!==`, not a band. The band belongs to ENH-23's anomaly detector, which
    // fires on a *material* move. The ledger answers the narrower question "did
    // it change at all", and a band here would let a value move by a hair over
    // unchanged inputs and report reconciled, which is the false negative this
    // module exists to prevent.
    return { comparable: true, changed: a !== b, delta: b - a }
  }
  return { comparable: true, changed: a !== b, delta: null }
}

/**
 * Reconcile a number against a prior observation of itself.
 *
 * @param {object} options
 * @param {object} options.before the earlier observation. Without it there is
 *   nothing to compare, and the result is `cannot_trace` rather than agreement.
 * @param {object} options.after the later observation.
 * @param {string} [options.now] the observation time, stamped on the event.
 * @returns {object} `{outcome, finding, reconciled, changed, inputs_changed,
 *   attributable_to?, reason?, before, after, trace, observed_at}`
 */
export function reconcileNumber({ before, after, now = nowIso() } = {}) {
  const prior = toObservation(before)
  const current = toObservation(after)

  // No prior observation is not a reconciled number. It is the first sight of
  // one, and calling that agreement is the "check that measures nothing" this
  // repository has shipped before.
  if (!prior) return refusal('no_prior_observation', { now, current })

  // Both sides must trace. The event names the run that produced each value, so
  // a half-written envelope on either side is not a trace — and the *prior* side
  // is the one easy to forget, because the number a caller is asking about is
  // the current one.
  const traceAfter = traceFor(current)
  if (!traceAfter.traced) return refusal(traceAfter.reason, { now, before: prior, current, trace: traceAfter })
  const traceBefore = traceFor(prior)
  if (!traceBefore.traced) return refusal(traceBefore.reason, { now, before: prior, current, trace: traceBefore })
  const trace = traceAfter
  if (!prior.inputs || !current?.inputs) {
    // Provenance names the run, but the number names no inputs, so there is
    // nothing to hold the value against. An absent measurement, not a match.
    return refusal('missing_inputs', { now, before: prior, current, trace })
  }

  const inputsChanged = prior.inputs_digest !== current.inputs_digest
  const { comparable, changed, delta } = compareValues(prior, current)
  if (!comparable) return refusal('missing_inputs', { now, before: prior, current, trace })

  const base = { before: prior, after: current, trace, observed_at: now, delta }

  // 1. Changed with changed inputs. The system working; not a finding.
  if (changed && inputsChanged) {
    return { ...base, outcome: 'reconciled', finding: false, reconciled: true, changed: true, inputs_changed: true }
  }

  // 2. Unchanged with changed inputs. The finding people forget: the inputs
  // moved and the number did not, which usually means the input is not wired in.
  if (!changed && inputsChanged) {
    const inputs = inputDigestChanges(prior, current)
    return {
      ...base,
      outcome: 'unchanged_with_input_change',
      finding: true,
      reconciled: false,
      changed: false,
      inputs_changed: true,
      inputs,
      reason: `the value held at ${current.value} while ${inputs.length} declared input(s) moved: ${inputs.join(', ')}`,
    }
  }

  // 3. Changed with unchanged inputs. The engine, or an input nobody declared.
  if (changed && !inputsChanged) {
    const undeclared = undeclaredInputs(prior, current)
    return {
      ...base,
      outcome: 'changed_without_input_change',
      finding: true,
      reconciled: false,
      changed: true,
      inputs_changed: false,
      attributable_to: undeclared,
      cause: undeclared.length ? 'undeclared_input' : 'unknown',
      reason: undeclared.length
        ? `the value moved from ${prior.value} to ${current.value} while every declared input held, and the run declared ${undeclared.join(', ')} as an input it does not record`
        : `the value moved from ${prior.value} to ${current.value} while every declared input held, and no undeclared input was named`,
    }
  }

  // 4. Unchanged with unchanged inputs. Ordinary, and the only case where
  // "reconciled" means the number did exactly what its inputs said.
  return { ...base, outcome: 'reconciled', finding: false, reconciled: true, changed: false, inputs_changed: false }
}

function refusal(reason, { now, before = null, current = null, trace = null }) {
  return {
    outcome: 'cannot_trace',
    finding: false,
    // Named explicitly, because this is the field a caller is most likely to
    // read as a boolean and get backwards. cannot_trace is not reconciled.
    reconciled: false,
    reason_code: reason,
    trace,
    before,
    after: current,
    observed_at: now,
  }
}

/**
 * Whether an observation can name the run that produced the number.
 *
 * Two failures, and they are different claims: no envelope at all is a fact
 * about the record; an envelope missing `source_run_id` is a fact about the
 * provenance that was written. Both refuse, and the reason says which.
 */
function traceFor(observation) {
  const envelope = observation?.provenance
  if (!envelope || typeof envelope !== 'object') {
    return { traced: false, reason: 'no_provenance', source_run_id: null, transform_version: null }
  }
  const missing = TRACE_FIELDS.filter((field) => envelope[field] === undefined || envelope[field] === null || envelope[field] === '')
  if (missing.length) {
    return {
      traced: false,
      reason: 'incomplete',
      missing,
      source_run_id: envelope.source_run_id ?? null,
      transform_version: envelope.transform_version ?? null,
    }
  }
  return {
    traced: true,
    reason: null,
    source_run_id: envelope.source_run_id,
    transform_version: envelope.transform_version,
    payload_hash: envelope.payload_hash,
    connector_id: envelope.connector_id ?? null,
    retrieved_at: envelope.retrieved_at ?? null,
  }
}

/** The declared input fields whose counts moved, by name. */
function inputDigestChanges(before, after) {
  const fields = new Set([...before.input_fields, ...after.input_fields])
  const moved = []
  for (const field of fields) {
    if ((before.inputs?.[field] ?? null) !== (after.inputs?.[field] ?? null)) moved.push(field)
  }
  return moved.sort()
}

/**
 * Inputs the run declared but did not record, taken from `undeclared_inputs`.
 *
 * The list is a caller claim — a clock, a seed, a map order — and the ledger
 * names it rather than inventing one. An empty list is the honest answer when
 * the caller named nothing, and it classifies the cause as unknown rather than
 * as "no undeclared input", which would be a claim the ledger cannot support.
 */
function undeclaredInputs(before, after) {
  const named = new Set()
  for (const side of [before, after]) {
    for (const item of side?.undeclared_inputs || []) {
      if (typeof item === 'string' && item) named.add(item)
    }
  }
  return [...named].sort()
}

/**
 * Every number in a set of derived rows, keyed for comparison.
 *
 * Takes the same `{risk_scores, impact_assessments}` shape `refreshAnalytics`
 * builds, plus any other collection the caller names. Returns a Map keyed by
 * `publishedKey`, so two runs' maps compare key-for-key.
 */
export function observationMap(collections = {}) {
  const map = new Map()
  for (const [collection, rows] of Object.entries(collections)) {
    if (!Array.isArray(rows)) continue
    for (const record of rows) {
      map.set(publishedKey(collection, record), toObservation({ collection, record }))
    }
  }
  return map
}

/**
 * Reconcile a whole run against the one before it.
 *
 * Returns one result per number present in the current run, plus a
 * `cannot_trace` result for every number that carries no provenance or no
 * inputs. The distinction between "nothing to report" and "nothing was
 * measured" is the whole point: `measured` counts the numbers actually
 * compared, and a run that compared none reports `measured: 0` rather than a
 * clean bill of health.
 *
 * @param {object} options
 * @param {Map|object} options.before the previous run's observations, from
 *   `observationMap` or an equivalent Map.
 * @param {Map|object} options.after the current run's observations.
 * @param {string} [options.now]
 * @param {boolean} [options.includeReconciled] keep the non-findings in `events`
 *   as well. Default false — the events are the findings, and a caller that
 *   wants the full ledger asks for it.
 */
export function reconcileRun({ before, after, now = nowIso(), includeReconciled = false } = {}) {
  const prior = asMap(before)
  const current = asMap(after)
  const results = []
  const events = []
  let measured = 0

  for (const [key, observation] of current) {
    const result = reconcileNumber({ before: prior.get(key) ?? null, after: observation, now })
    results.push(result)
    if (result.outcome !== 'cannot_trace') measured += 1
    if (result.finding || includeReconciled) events.push(toEvent(result, key))
  }

  return {
    results,
    events,
    measured,
    // Untraced and first-sight are different facts and are reported apart. A
    // first-sight number is traceable; it simply has no past in this pair. A
    // number that is neither is the refusal ENH-51 is about.
    untraced: results.filter((result) => result.outcome === 'cannot_trace' && result.reason_code !== 'no_prior_observation').length,
    first_sight: results.filter((result) => result.reason_code === 'no_prior_observation').length,
    findings: events.filter((event) => event.finding).length,
    outcomes: tally(results),
    observed_at: now,
  }
}

/** A Map, or an object of collections turned into one. */
function asMap(input) {
  if (input instanceof Map) return input
  return observationMap(input || {})
}

function tally(results) {
  const counts = Object.fromEntries(RECONCILIATION_OUTCOMES.map((outcome) => [outcome, 0]))
  for (const result of results) counts[result.outcome] = (counts[result.outcome] || 0) + 1
  return counts
}

/**
 * A reconciliation result as a stored event.
 *
 * The event is what ENH-51 asks for: the log line in `analytics.js` becomes a
 * row with a stable id, both values, the run that produced the later one, and
 * the reason it is a finding. The id is `stableId` over the key, the two run ids
 * and the outcome — *not* over the clock — so re-reconciling the same pair
 * produces the same id and a merge updates rather than duplicates. A
 * reconciliation that re-reports the same event every refresh is noise by
 * construction.
 */
export function toEvent(result, key) {
  const before = result.before
  const after = result.after
  return {
    id: stableId('recon', [key, before?.source_run_id ?? null, after?.source_run_id ?? null, result.outcome]),
    type: 'reconciliation_event',
    key,
    collection: after?.collection ?? before?.collection ?? null,
    outcome: result.outcome,
    finding: Boolean(result.finding),
    value_before: before?.value ?? null,
    value_after: after?.value ?? null,
    delta: result.delta ?? null,
    inputs_changed: result.inputs_changed ?? null,
    input_fields: after?.input_fields ?? before?.input_fields ?? [],
    inputs: after?.inputs ?? null,
    attributable_to: result.attributable_to ?? [],
    cause: result.cause ?? null,
    reason_code: result.reason_code ?? null,
    reason: result.reason ?? null,
    run_before: before?.source_run_id ?? null,
    run_after: after?.source_run_id ?? null,
    transform_version: after?.provenance?.transform_version ?? before?.provenance?.transform_version ?? null,
    observed_at: result.observed_at,
  }
}

/**
 * The ledger: an append-only, hash-chained log of reconciliation events.
 *
 * Tamper-evidence here is the same property `src/audit-chain.js` gives
 * `action_logs`, and it is built on the same core — `chainEntry` and
 * `computeEntryHash` — rather than a second implementation. A ledger whose
 * events could be edited after the fact would be a log that says what we wish
 * had happened, which is the failure the audit chain exists to prevent one
 * collection over.
 *
 * The chain reuses `CHAINED_FIELDS`, so a `reconciliation_event` maps onto the
 * chained field list without a new field list to drift: the `key` is the
 * `record_id`, the collection is the collection, the outcome is the `action`,
 * and the reconciliation result rides in `metadata`. The event's own `id` is not
 * a chained field — the chain commits to `record_id`, which is the key, so two
 * events for the same number and the same run pair are the same claim.
 */
export class ReconciliationLedger {
  #events
  #head

  constructor({ events = [] } = {}) {
    this.#events = [...events]
    this.#head = headOf(this.#events)
  }

  /** The events, oldest first. A copy, so a caller cannot edit the log in place. */
  get events() {
    return [...this.#events]
  }

  get head() {
    return this.#head
  }

  get size() {
    return this.#events.length
  }

  /**
   * Append reconciliation results. Only findings are chained by default — a
   * ledger that records every unchanged number is a second copy of the derived
   * set, and the events a reader trusts are the ones that mean something.
   */
  append(results = [], { includeReconciled = false } = {}) {
    const appended = []
    for (const result of results) {
      if (!result.finding && !includeReconciled) continue
      const event = result.type === 'reconciliation_event' ? result : toEvent(result, result.key || result.after?.key)
      const entry = this.#chain(event)
      this.#events.push(entry)
      appended.push(entry)
    }
    return appended
  }

  #chain(event) {
    const record = {
      id: event.id,
      collection: event.collection || 'reconciliation_events',
      record_id: event.key,
      action: event.outcome,
      actor: 'reconciliation_ledger',
      subject: null,
      summary: event.reason || `${event.outcome} ${event.key}`,
      created_at: event.observed_at,
      metadata: {
        value_before: event.value_before,
        value_after: event.value_after,
        inputs_changed: event.inputs_changed,
        attributable_to: event.attributable_to,
        cause: event.cause,
        run_before: event.run_before,
        run_after: event.run_after,
        transform_version: event.transform_version,
      },
    }
    const entry = chainEntry(record, this.#head)
    this.#head = { seq: entry.seq, hash: entry.entry_hash }
    // The reconciliation payload travels beside the chained fields, so a reader
    // gets the whole event back without recomputing it from the chained subset.
    return { ...event, ...entry }
  }

  /**
   * Re-verify the chain by recomputation.
   *
   * Recomputes each entry's hash from its own content and carries the
   * *recomputed* value forward, never trusting a stored `prev_hash` — the rule
   * `verifyChainWith` follows, applied here over the chained field list the
   * audit core already names. `expectedHead`, when supplied, is the out-of-band
   * anchor: the one thing an attacker who re-chained the whole log cannot reach.
   */
  verify({ expectedHead = null } = {}) {
    const defects = []
    let running = GENESIS_HASH
    let recomputedHead = null
    let seq = 0
    for (const entry of this.#events) {
      const expected = computeEntryHash(entry, running)
      if (entry.entry_hash !== expected) {
        defects.push({ type: 'entry_hash_mismatch', severity: 'fatal', seq: entry.seq ?? null, detail: 'entry content does not hash to its recorded entry_hash — the event was edited' })
      }
      if (entry.prev_hash !== running) {
        defects.push({ type: 'prev_hash_mismatch', severity: 'fatal', seq: entry.seq ?? null, detail: 'prev_hash does not match the recomputed hash of the preceding entry' })
      }
      if (entry.seq !== seq + 1) {
        defects.push({ type: 'seq_gap', severity: 'fatal', seq: entry.seq ?? null, detail: `expected seq ${seq + 1}, found ${entry.seq} — an event was removed or reordered` })
      }
      seq = Number.isFinite(entry.seq) ? entry.seq : seq
      running = expected
      recomputedHead = expected
    }
    if (expectedHead !== null && expectedHead !== undefined && expectedHead !== recomputedHead) {
      defects.push({ type: 'head_mismatch', severity: 'fatal', detail: 'recomputed head does not match the published head — the ledger was rewritten' })
    }
    return {
      verified: defects.every((defect) => defect.severity !== 'fatal'),
      anchored: expectedHead !== null && expectedHead !== undefined,
      entry_count: this.#events.length,
      head: recomputedHead,
      defects,
    }
  }
}

/** The head of an existing event list, recomputed rather than trusted. */
function headOf(events) {
  let running = GENESIS_HASH
  let seq = 0
  for (const entry of events) {
    running = computeEntryHash(entry, running)
    seq = Number.isFinite(entry.seq) ? entry.seq : seq
  }
  return { seq, hash: running }
}

/** The chained field list, re-exported so a consumer reads the ledger's fields from one place. */
export { CHAINED_FIELDS }

/** A SHA-256 digest of an entry's preimage, for a caller that wants one without a chain. */
export function ledgerDigest(entry, prevHash = GENESIS_HASH) {
  return createHash('sha256').update(chainDigestInput(entry, prevHash)).digest('hex')
}
