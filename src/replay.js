/**
 * ENH-76: deterministic replay of a captured run, and the comparison that makes
 * it a proof rather than a re-run.
 *
 * `src/capture.js` records the bytes a run fetched. That answers "what did the
 * provider say", which is the half a connector defect needs. It does not answer
 * the other half — "does this published number follow from those bytes" —
 * because a payload capture holds no derivation: the store the run read, the
 * clock it read, and the rows it published are three different things and none
 * of them is in the payload store.
 *
 * So this module adds the envelope and, more importantly, the *verification*.
 * `captureRun` writes the run down: the input snapshot `refreshAnalytics` read,
 * the derived rows it published, the instant it ran, and — unchanged, in
 * `src/capture.js`'s own format — the fetched bodies. `replayRun` re-derives the
 * numbers through the *production* `refreshAnalytics`, against a store adapter
 * holding the captured snapshot, and compares what came out with what was
 * published. Nothing here reimplements the engine: a replay that recomputed the
 * scores by hand would be a second implementation, and two implementations that
 * agree today are the defect this repository keeps finding — VER-03's label that
 * agreed with the monitor by coincidence, the two `gate.py` copies, the
 * four-path collection whose union happened to reproduce the count.
 *
 * ## The comparison is the product
 *
 * A harness that replays and does not verify is a re-run. The verdict is three
 * states, and the whole design is in keeping them apart:
 *
 * - **reproduced** — every published derived record recomputed bit-for-bit.
 * - **diverged** — a number moved. The row names the collection, the record key,
 *   the field path, and both values.
 * - **unverifiable** — an input the capture does not carry. This is *not* a
 *   divergence and it is *not* a pass: an unverifiable collection has no second
 *   side to compare against, and reporting it as reproduced is the "skipped 8,
 *   recomputed 0" bug this repository has shipped before, one layer up. A run
 *   with any unverifiable collection is unverifiable as a whole, and no
 *   computation is attempted, because a replay that reports numbers it could not
 *   have derived is the thing this module exists to refuse.
 *
 * ## Determinism, and what it costs
 *
 * A replay is only evidence if it is deterministic. Everything the computation
 * reads that would otherwise vary is pinned *from the capture*:
 *
 * - **The clock.** `refreshAnalytics` does not accept a `now`; `computeDataQuality`
 *   and `computeRoadAccess` read the wall clock through `freshnessPenaltyFor` and
 *   `temporalStatus`, and `CLOCK_DEPENDENT` names them for exactly that reason.
 *   So `pinClock` installs the captured instant as `Date` for the duration of the
 *   replay and restores the real one in a `finally`. It replaces the *environment*,
 *   not any module under test: the engine is untouched and runs exactly as it
 *   does in production. A capture that does not pin the clock is reported
 *   unverifiable naming `pinned_at` — never replayed against `Date.now()` and
 *   reported as a mismatch the operator cannot explain.
 * - **Ordering.** The input collections are fed in the order the capture holds
 *   them, which is the order the store served them; both adapters sort identically
 *   (`sortRecords`), so a capture taken from a store read replays against the same
 *   region set in the same order. `collectRegions` is order-sensitive — a region's
 *   coordinate is whichever point created the key — so this is pinned, not assumed.
 * - **Randomness.** Nothing in the derivation chain reads an RNG; the ids are
 *   `stableId`, a digest of their inputs. There is no seed to pin because there is
 *   no draw.
 * - **Side effects.** `refreshAnalytics` writes a calibration snapshot to disk
 *   unless `LINDELA_LITE_CALIBRATION_DIR` is `off`. A replay must not write, and a
 *   file write is not part of the number, so the replay suppresses it and restores
 *   the variable afterwards.
 *
 * ## Bit-for-bit, exactly
 *
 * JavaScript numbers are IEEE-754 binary64. Two numbers are equal bit-for-bit iff
 * `Object.is` says so — which is stricter than `===` in both directions that
 * matter: `Object.is(-0, 0)` is `false` (a genuine sign-bit difference) and
 * `Object.is(NaN, NaN)` is `true` (a NaN has no comparable value; the honest
 * engine withholds non-finite numbers through `honestyEnvelope` rather than
 * publishing them). There is no epsilon. A difference in the last digit is a
 * divergence and is reported as one.
 *
 * The record-level claim uses `canonicalHash`, the repository's own deterministic
 * digest — keys sorted at every depth, so two records that differ only in key
 * order hash the same and a re-serialisation is not a false divergence. The digest
 * decides *whether* a record moved; the field walk below names *where*, down to
 * the path, so a divergence is a location rather than a shrug.
 *
 * `input_counts` — what `inputDigestFor` stamped onto every risk and impact row —
 * travels with the value, so a moved number over moved inputs (the inputs
 * changed) is distinguishable from a moved number over unmoved inputs (the engine
 * changed). That is the same distinction `reconcileDerivedNumbers` draws on a live
 * refresh, applied here to a replay.
 */

import { verifyChain } from './audit-chain.js'
import { DERIVED_INPUTS, derivedKey, refreshAnalytics } from './analytics.js'
import { REPLAY_ORIGIN, parseCaptures, serialiseCaptures } from './capture.js'
import { DERIVED_COLLECTIONS } from './store.js'
import { canonicalHash } from './utils.js'

/** The document a run capture is, so a foreign JSON file is refused rather than guessed at. */
export const RUN_CAPTURE_FORMAT = 'lindela-run-capture'
export const RUN_CAPTURE_VERSION = 1

/** The three outcomes, frozen and exhaustive: a verdict can only be a member. */
export const REPLAY_VERDICTS = Object.freeze(['reproduced', 'diverged', 'unverifiable'])

/**
 * The collections a capture must carry for a replay to be possible.
 *
 * Read from `DERIVED_INPUTS` — the declaration the engine itself is keyed on —
 * rather than a hand-kept list, so a collection added to a scorer's inputs cannot
 * go missing from the replay's requirement without both moving together. This is
 * the list the silent-drop bug class lives in: a check that names its own set of
 * inputs drifts from the computation the moment the computation changes.
 */
export const REQUIRED_INPUTS = Object.freeze(
  [...new Set(DERIVED_INPUTS.flatMap((entry) => entry.inputs))].sort(),
)

/**
 * Thrown when a document cannot be replayed *at all* — it is not a run capture,
 * or its inputs are absent in a way that leaves nothing to replay.
 *
 * Distinct from the `unverifiable` verdict, which is a capture that *is* a run
 * capture and is missing one named input. A refusal here is "this is not the
 * thing you think it is"; the verdict there is "this is the thing, and here is
 * the piece it does not carry". Collapsing the two would either throw away the
 * detail an operator needs or return a verdict object for a file that is not a
 * capture.
 */
export class ReplayRefusalError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`)
    this.name = 'ReplayRefusalError'
    this.reason = reason
    this.detail = detail
  }
}

/**
 * Run `fn` with `Date` pinned to `instant`, then restore the real `Date`.
 *
 * The pin is installed as `globalThis.Date` for the duration and removed in a
 * `finally`, so a throw inside `fn` still leaves the process with a working clock.
 * That makes the window a global mutation, and it is safe here for the reason it
 * is a deliberate choice: `node --test` runs one file per process and its tests
 * sequentially, so nothing else in this process reads the clock while the pin is
 * installed. A concurrent reader would see the pinned instant, which is why this
 * is a scoped function and not a module-level switch — the blast radius is one
 * awaited call.
 *
 * `new Date()` (no arguments) returns the pinned instant; `new Date(value)` and
 * `Date.parse` behave exactly as they always did, because the engine parses
 * captured timestamps and a pin that broke parsing would refuse good captures.
 */
export async function pinClock(instant, fn) {
  const Real = Date
  const epoch = epochMs(instant)
  if (epoch === null) {
    throw new ReplayRefusalError('unpinnable_clock', `cannot pin the clock to ${JSON.stringify(instant)}; a replay needs a Date, an epoch ms, or an ISO-8601 string`)
  }
  class PinnedDate extends Real {
    constructor(...args) {
      if (args.length === 0) super(epoch)
      else super(...args)
    }

    static now() {
      return epoch
    }
  }
  // The statics a caller reaches for without thinking. A subclass inherits them,
  // but naming them keeps the intent readable and survives a refactor that stops
  // extending `Date`.
  PinnedDate.parse = Real.parse
  PinnedDate.UTC = Real.UTC
  globalThis.Date = PinnedDate
  try {
    return await fn()
  } finally {
    globalThis.Date = Real
  }
}

/**
 * Write a run down as a capture.
 *
 * `inputs` is the store snapshot `refreshAnalytics` read — the pre-swap read, so
 * the derived collections it carries are the ones that were *stored*, not the ones
 * the run produced. `published` is what the run produced, keyed by collection.
 * `now` is the instant the run used, and it is required: a capture that does not
 * pin its clock is one this module will refuse to replay, so it refuses to write
 * one either.
 *
 * `payloads` is the raw fetched bodies, and it is passed through `src/capture.js`'s
 * own serialiser — the run capture does not invent a second byte format, it
 * carries the existing one. `chain` is the action-log entries the run wrote and
 * the head published elsewhere; it is the anchor that makes a clean replay
 * evidence rather than an internal-consistency check.
 */
export function captureRun({ inputs, published, now, payloads = null, chain = null, note = null } = {}) {
  requireRecord(inputs, 'inputs')
  requireRecord(published, 'published')
  const pinnedAt = requireInstant(now, 'now')

  let payloadDocument = null
  if (payloads !== null && payloads !== undefined) {
    payloadDocument = typeof payloads === 'string' ? payloads : serialiseCaptures(payloads)
    // Verified at write time, not only at replay: a capture that carries a payload
    // store whose bodies do not match their hashes is evidence that is already
    // corrupt, and finding that out when someone needs the replay is too late.
    parseCaptures(payloadDocument)
  }

  let chainDocument = null
  if (chain !== null && chain !== undefined) {
    if (!Array.isArray(chain.entries)) {
      throw new ReplayRefusalError('malformed_chain', 'a capture chain needs an entries array; the head alone cannot be walked')
    }
    chainDocument = Object.freeze({
      entries: Object.freeze(chain.entries.map((entry) => Object.freeze({ ...entry }))),
      head: chain.head ?? null,
    })
  }

  return Object.freeze({
    format: RUN_CAPTURE_FORMAT,
    version: RUN_CAPTURE_VERSION,
    pinned_at: pinnedAt,
    inputs: Object.freeze({ ...inputs }),
    published: Object.freeze({ ...published }),
    payloads: payloadDocument,
    chain: chainDocument,
    note: note ?? null,
    provenance: Object.freeze({
      origin: REPLAY_ORIGIN,
      is_live_observation: false,
      note:
        'A captured run is a recording. The numbers replayed from it are re-derived, not '
        + 'observed, and must never be presented as live observations.',
    }),
  })
}

export function serialiseRunCapture(capture) {
  return JSON.stringify(capture)
}

/**
 * Read a run capture back, refusing anything that is not one.
 *
 * A JSON file that parses but is not a run capture is the worst input this module
 * can receive: every field it needs reads as absent, and a harness that defaulted
 * its way through would report a verdict about a document it never understood.
 */
export function parseRunCapture(serialised) {
  let parsed
  try {
    parsed = JSON.parse(typeof serialised === 'string' ? serialised : String(serialised))
  } catch (error) {
    throw new ReplayRefusalError('not_a_run_capture', `the document is not JSON: ${error.message}`)
  }
  if (parsed?.format !== RUN_CAPTURE_FORMAT) {
    throw new ReplayRefusalError('not_a_run_capture', `expected format ${JSON.stringify(RUN_CAPTURE_FORMAT)}, found ${JSON.stringify(parsed?.format ?? null)}`)
  }
  return parsed
}

/**
 * Replay a captured run and compare the result against what was published.
 *
 * Returns the verdict object described in the module header. Never returns
 * `reproduced` for a run it could not fully replay, and never replays against a
 * clock it was not given.
 */
export async function replayRun(capture) {
  const run = normaliseCapture(capture)
  const unverifiable = []

  // The clock first, because it is the pin the whole replay rests on. A capture
  // without it is not replayed at all — see the header on why "unverifiable"
  // must not become "replayed against Date.now()".
  const epoch = epochMs(run.pinned_at)
  if (epoch === null) {
    unverifiable.push(refusal('missing_pin', `the capture does not pin the clock (pinned_at is ${JSON.stringify(run.pinned_at)}); the run reads the clock through freshness and temporal rules, so a replay without this pin would report a mismatch nobody can explain`, 'pinned_at'))
  }

  if (run.payloads !== null && run.payloads !== undefined) {
    try {
      parseCaptures(run.payloads)
    } catch (error) {
      unverifiable.push(refusal('payload_store_corrupt', `the capture's payload store does not read back: ${error.message}`, 'payloads'))
    }
  }

  const chain = run.chain ? checkChain(run.chain) : null
  if (chain && !chain.verified) {
    const types = chain.defects.filter((defect) => defect.severity === 'fatal').map((defect) => defect.type)
    unverifiable.push(refusal('chain_broken', `the capture's audit chain does not recompute (${types.join(', ') || 'unspecified defect'}); the recording has been edited, so its inputs cannot be trusted`, 'chain'))
  }

  for (const name of REQUIRED_INPUTS) {
    if (!Object.hasOwn(run.inputs, name)) {
      unverifiable.push(refusal('missing_input', `the capture carries no ${name} collection, which the derivation reads; a number replayed without it would be computed from an input set the run did not use`, name))
    }
  }
  for (const name of DERIVED_COLLECTIONS) {
    if (!Object.hasOwn(run.published, name)) {
      unverifiable.push(refusal('missing_published', `the capture carries no published ${name} rows, so there is no second side to compare a replay against`, name))
    }
  }

  if (unverifiable.length) {
    return buildVerdict('unverifiable', unverifiable, {
      run,
      chain,
      collections: [],
      diverged: [],
      digests: { published: null, replayed: null },
      reason: `${unverifiable.length} input${unverifiable.length === 1 ? '' : 's'} the capture does not carry — no number is reported as reproduced from an incomplete capture`,
    })
  }

  // The store the engine reads is the captured snapshot, nothing else. It is a
  // fresh object per replay, so the module-level derived cache is cold and every
  // collection recomputes rather than being served a digest from another run.
  const store = new CapturedStore(run.inputs)
  let replayed
  try {
    replayed = await withoutCalibrationWrites(() => pinClock(run.pinned_at, () => refreshAnalytics(store)))
  } catch (error) {
    return buildVerdict('unverifiable', [
      refusal('replay_failed', `the engine threw while replaying the capture: ${error.message}`, null),
    ], {
      run,
      chain,
      collections: [],
      diverged: [],
      digests: { published: null, replayed: null },
      reason: 'the replay did not complete, so nothing was verified',
    })
  }

  const replayedPayload = pickDerived(replayed)
  const comparison = compareDerived(run.published, replayedPayload)
  const digests = {
    published: canonicalHash(pickDerived(run.published)),
    replayed: canonicalHash(replayedPayload),
  }

  if (comparison.diverged.length) {
    return buildVerdict('diverged', [], {
      run,
      chain,
      collections: comparison.collections,
      diverged: comparison.diverged,
      digests,
      reason: `${comparison.diverged.length} field${comparison.diverged.length === 1 ? '' : 's'} moved across ${new Set(comparison.diverged.map((row) => row.key)).size} record(s)`,
    })
  }

  const matched = comparison.collections.reduce((sum, entry) => sum + entry.matched, 0)
  return buildVerdict('reproduced', [], {
    run,
    chain,
    collections: comparison.collections,
    diverged: [],
    digests,
    reason: `every published derived number recomputed bit-for-bit (${matched} record(s) across ${comparison.collections.length} collections)`,
  })
}

/**
 * Compare two derived payloads, bit-for-bit, and name where they differ.
 *
 * Exported because the comparison is the product: it is the half a caller can
 * exercise without a capture, and it is the half a test should pin directly.
 *
 * Records are matched in two passes, because one identity rule cannot do both
 * jobs here:
 *
 * 1. **By digest.** Two records whose `canonicalHash` is equal are the same
 *    record with the same values, whatever order they arrived in. This pass is
 *    order-independent and collision-safe, and it is what makes a re-serialisation
 *    with a different key order or a differently-ordered region set reproduce
 *    rather than diverge.
 * 2. **By `derivedKey`**, for whatever the digest pass did not match — a record
 *    that moved. The key is the repository's own identity rule, and pairing on it
 *    is what lets the field walk name `score` rather than reporting the whole
 *    record as gone. It is only trusted when the key is unique on both sides:
 *    `derivedKey` is the *reconciliation* key, built for `risk_scores` and
 *    `impact_assessments`, and it returns a degenerate key for a collection whose
 *    records carry none of the place fields (`facilities_at_risk` rows resolve to
 *    `facilities_at_risk:score:null`). Two such records share one key, and pairing
 *    them by it would diff the wrong pair and call an unchanged record diverged —
 *    so a colliding key falls back to a record-level report, which is honest about
 *    not knowing which row moved.
 *
 * A record present on one side and absent on the other is a divergence, not a
 * skip: a row that vanished is the loudest move there is.
 */
export function compareDerived(published, replayed) {
  const collections = []
  const diverged = []
  for (const name of DERIVED_COLLECTIONS) {
    const left = Array.isArray(published?.[name]) ? published[name] : []
    const right = Array.isArray(replayed?.[name]) ? replayed[name] : []

    const pool = new Map()
    for (const record of right) {
      const hash = canonicalHash(record)
      if (!pool.has(hash)) pool.set(hash, [])
      pool.get(hash).push(record)
    }

    const pairs = []
    const unmatchedLeft = []
    for (const record of left) {
      const bucket = pool.get(canonicalHash(record))
      if (bucket && bucket.length) pairs.push([record, bucket.pop()])
      else unmatchedLeft.push(record)
    }
    const unmatchedRight = []
    for (const bucket of pool.values()) unmatchedRight.push(...bucket)

    // Second pass: pair the leftovers on `derivedKey`, but only where the key
    // identifies exactly one record on each side. A record that moved is not in
    // the digest pool on either side, and pairing it here is what lets the field
    // walk name `score` rather than reporting the whole record as gone. The key
    // is only trusted when it is unique: `derivedKey` is the *reconciliation* key,
    // built for `risk_scores` and `impact_assessments`, and it returns a
    // degenerate key for a collection whose records carry none of the place fields
    // (`facilities_at_risk` rows resolve to `facilities_at_risk:score:null`). Two
    // such records share one key, and pairing them by it would diff the wrong pair
    // and call an unchanged record diverged — so a colliding key is left unpaired
    // and reported whole, which is honest about not knowing which row moved.
    const byKeyLeft = groupByKey(name, unmatchedLeft)
    const byKeyRight = groupByKey(name, unmatchedRight)
    for (const [key, leftRecords] of byKeyLeft) {
      const rightRecords = byKeyRight.get(key)
      if (rightRecords && leftRecords.length === 1 && rightRecords.length === 1) {
        byKeyRight.delete(key)
        pairs.push([leftRecords[0], rightRecords[0]])
      }
    }

    // Every pair is walked, including the ones the digest matched. The digest is
    // the *pairing* rule, not the verdict: `canonicalHash` serialises through
    // `JSON.stringify`, which renders `-0` as `0` and a non-finite as `null`, so
    // two records that differ only in a sign bit or a NaN would match at the
    // digest and the difference would never be reported. The walk below uses
    // `Object.is` and is the thing the bit-for-bit claim actually rests on.
    let matched = 0
    for (const [leftRecord, rightRecord] of pairs) {
      const out = []
      diff(name, derivedKey(name, leftRecord), '', leftRecord, rightRecord, out)
      if (out.length) {
        attachInputCounts(out, leftRecord, rightRecord)
        diverged.push(...out)
      } else {
        matched += 1
      }
    }
    // Whatever pairing did not happen is a record present on one side and absent
    // on the other — reported whole.
    for (const records of byKeyLeft.values()) {
      for (const record of records) {
        if (pairs.some(([leftRecord]) => leftRecord === record)) continue
        diverged.push({ collection: name, key: derivedKey(name, record), path: '(record)', published: 'present', replayed: 'absent', missing: 'replayed', input_counts: null })
      }
    }
    for (const records of byKeyRight.values()) {
      for (const record of records) {
        if (pairs.some(([, rightRecord]) => rightRecord === record)) continue
        diverged.push({ collection: name, key: derivedKey(name, record), path: '(record)', published: 'absent', replayed: 'present', missing: 'published', input_counts: null })
      }
    }

    collections.push({ name, published: left.length, replayed: right.length, matched })
  }
  return { collections, diverged }
}

/** Records grouped by `derivedKey`, each group in a stable order. */
function groupByKey(collection, records) {
  const byKey = new Map()
  for (const record of [...records].sort((a, b) => canonicalHash(a).localeCompare(canonicalHash(b)))) {
    const key = derivedKey(collection, record)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(record)
  }
  return byKey
}

/** The derived collections out of a `refreshAnalytics` result, and nothing else. */
function pickDerived(payload) {
  const out = {}
  for (const name of DERIVED_COLLECTIONS) out[name] = payload?.[name] || []
  return out
}

/**
 * The store a replay reads from.
 *
 * `read()` answers the captured snapshot; `replaceAnalytics` and `merge` record
 * what the engine wrote and hand back a new state, exactly as `JsonStore` does —
 * so the snapshot a caller captured before the run is not mutated by the replay
 * that reads it. This is not a mock of the engine: the engine is the real
 * `refreshAnalytics`. It is the *input side* of a replay, and the only thing it
 * does is answer with the captured bytes.
 */
class CapturedStore {
  constructor(snapshot) {
    this.snapshot = snapshot
    this.written = null
    this.merges = []
  }

  async read() {
    return this.snapshot
  }

  async replaceAnalytics(payload = {}) {
    const next = { ...this.snapshot }
    for (const name of DERIVED_COLLECTIONS) next[name] = payload[name] || []
    this.written = next
    this.snapshot = next
    return next
  }

  async merge(partial = {}) {
    this.merges.push(partial)
    return this.snapshot
  }
}

/** Run `fn` with the calibration snapshot write suppressed, restoring the variable after. */
async function withoutCalibrationWrites(fn) {
  const previous = process.env.LINDELA_LITE_CALIBRATION_DIR
  process.env.LINDELA_LITE_CALIBRATION_DIR = 'off'
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.LINDELA_LITE_CALIBRATION_DIR
    else process.env.LINDELA_LITE_CALIBRATION_DIR = previous
  }
}

/**
 * Walk two values and record every leaf that differs, by path.
 *
 * Objects recurse over the union of their keys (sorted, so the report is stable),
 * arrays element-wise over the longer of the two, and everything else is compared
 * with `Object.is` — bit-for-bit, no epsilon. A key or index present on one side
 * only is a divergence at that path with `missing` naming the side that lacks it,
 * because "the field is gone" is a move and must not read as "the field matched".
 */
function diff(collection, key, path, published, replayed, out) {
  if (Object.is(published, replayed)) return
  const publishedObject = published !== null && typeof published === 'object'
  const replayedObject = replayed !== null && typeof replayed === 'object'

  if (publishedObject && replayedObject && Array.isArray(published) && Array.isArray(replayed)) {
    const length = Math.max(published.length, replayed.length)
    for (let index = 0; index < length; index += 1) {
      diff(collection, key, `${path}[${index}]`, published[index], replayed[index], out)
    }
    return
  }
  if (publishedObject && replayedObject) {
    const fields = [...new Set([...Object.keys(published), ...Object.keys(replayed)])].sort()
    for (const field of fields) {
      diff(collection, key, path ? `${path}.${field}` : field, published[field], replayed[field], out)
    }
    return
  }

  out.push({
    collection,
    key,
    path: path || '(record)',
    published: leaf(published),
    replayed: leaf(replayed),
    missing: published === undefined ? 'published' : replayed === undefined ? 'replayed' : null,
    input_counts: null,
  })
}

/** A leaf as it should appear in a report: the scalar, or a bounded descriptor of a structure. */
function leaf(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  return Array.isArray(value) ? { array: value.length } : { object: Object.keys(value).sort() }
}

/**
 * Attach the input counts to every divergence on a record that carries them.
 *
 * A number that moved is half a finding; the other half is whether the inputs
 * behind it moved too. `moved` names the collections whose in-district count
 * changed, which is the difference between "the source data changed" and "the
 * engine changed under unchanged inputs" — the distinction `reconcileDerivedNumbers`
 * draws on a live refresh, applied to a replay.
 */
function attachInputCounts(entries, publishedRecord, replayedRecord) {
  const before = publishedRecord?.input_counts
  const after = replayedRecord?.input_counts
  if (!before || !after) return
  const moved = Object.keys(before).filter((name) => before[name] !== after[name]).sort()
  for (const entry of entries) entry.input_counts = { published: before, replayed: after, moved }
}

function checkChain(chain) {
  const entries = Array.isArray(chain.entries) ? chain.entries : []
  const expectedHead = typeof chain.head === 'string' ? chain.head : null
  return verifyChain(entries, { expectedHead })
}

function buildVerdict(verdict, unverifiable, { run, chain, collections, diverged, digests, reason }) {
  return {
    verdict,
    reason,
    format: RUN_CAPTURE_FORMAT,
    pins: { pinned_at: run.pinned_at },
    collections,
    diverged,
    unverifiable,
    chain: chain
      ? {
        verified: chain.verified,
        anchored: chain.anchored,
        head: chain.head,
        entry_count: chain.entry_count,
        defects: chain.defects.map((defect) => ({ type: defect.type, severity: defect.severity })),
      }
      : null,
    digests,
    provenance: Object.freeze({
      origin: REPLAY_ORIGIN,
      is_live_observation: false,
      note: 'Replayed from a captured run, not measured live. A reproduced number is a re-derivation, not an observation.',
    }),
  }
}

function refusal(reason, detail, collection) {
  return { reason, detail, collection: collection ?? null }
}

function normaliseCapture(capture) {
  const run = typeof capture === 'string' ? parseRunCapture(capture) : capture
  if (!run || typeof run !== 'object') {
    throw new ReplayRefusalError('not_a_run_capture', 'a replay needs a run capture object or its serialised form')
  }
  if (run.format !== RUN_CAPTURE_FORMAT) {
    throw new ReplayRefusalError('not_a_run_capture', `expected format ${JSON.stringify(RUN_CAPTURE_FORMAT)}, found ${JSON.stringify(run.format ?? null)}`)
  }
  requireRecord(run.inputs, 'inputs')
  requireRecord(run.published, 'published')
  return run
}

function requireRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplayRefusalError('not_a_run_capture', `a run capture needs a ${name} object, got ${JSON.stringify(value ?? null)}`)
  }
  return value
}

function requireInstant(value, name) {
  const epoch = epochMs(value)
  if (epoch === null) {
    throw new ReplayRefusalError('unpinnable_clock', `${name} must be a Date, an epoch ms, or an ISO-8601 string, got ${JSON.stringify(value ?? null)}`)
  }
  return new Date(epoch).toISOString()
}

/** Epoch ms for a Date | number | ISO string, or null when unusable. */
function epochMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}
