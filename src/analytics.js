import fs from 'node:fs/promises'
import path from 'node:path'
import { riskLevel, severityWeight } from './schema.js'
import { clamp, canonicalHash, haversineKm, stableId, toNumber } from './utils.js'
import { KNOWN_DISTRICTS } from './districts.js'
import { computePopulationAtRisk, computeFacilitiesAtRisk } from './analytics/impact.js'
import { spreadSkillIndex, MIN_ENSEMBLES_FOR_SPREAD_SKILL } from './analytics/ensemble.js'
import { meanMeasured } from '../public/shared/units.js'
import { numericOrNull } from './analytics/numeric.js'
import { compoundHazardScore, MIN_COMPOUND_MONTHS } from './compound-hazard.js'
import { computeRoadAccess } from './road-access.js'
import { logger, metrics } from './observability.js'
import { calibrationByRegion } from './calibration.js'
import { driftReport } from './drift.js'
import { buildProvenance } from './provenance.js'
import { ReconciliationLedger, observationMap, reconcileRun } from './reconciliation.js'

// R-77: the honesty-envelope API (ENH-02/ENH-04) moved to `src/envelope.js`,
// a leaf module with no imports, because `src/calibration.js` and
// `src/drift.js` imported it from here while this file imports both — two
// cycles that resolved only because every use is inside a function body.
//
// The `import` is not redundant with the `export … from` below: a re-export
// binds nothing locally, and this module calls all three at ten sites. Both
// lines are needed — the import for the call sites, the re-export so
// `test/honesty-envelope.test.js` and any other existing importer keeps its
// import path and the export identity is unchanged.
import { ENVELOPE_KINDS, honestyEnvelope, uncertaintyTiers } from './envelope.js'

export { ENVELOPE_KINDS, honestyEnvelope, uncertaintyTiers }

// R-77: the derived-row key moved to `src/derived-key.js`, a leaf module,
// because `src/reconciliation.js` imported it from here while this file
// imports `reconciliation` — the fourth cycle in `src/`, which the R-77 entry
// never named. The import serves this module's own call sites; the re-export
// keeps `src/replay.js` and `src/reconciliation.js` on their existing path.
import { derivedKey, NUMERIC_VALUE_FIELDS, placeOf } from './derived-key.js'

export { derivedKey, NUMERIC_VALUE_FIELDS }

/**
 * Effective sample size for a monthly binary series.
 *
 * `n_eff = n * (1 - r1) / (1 + r1)` for lag-1 autocorrelation `r1`, the
 * standard correction for an AR(1) sample. The trailing 90-day rainfall
 * window makes consecutive months strongly positively correlated, so the raw
 * count is an overcount of independent evidence and an uncorrected interval
 * reads as tighter than the record is.
 *
 * Clamped at 3: below that the correction produces an interval too wide to be
 * read, which is a refusal wearing a number. Returns `null` for a series too
 * short or too constant to estimate `r1` from — a constant series has zero
 * variance and an undefined correlation, not a correlation of zero.
 */
export function effectiveSampleSize(labels) {
  const values = (labels || []).filter((v) => v === 0 || v === 1)
  const n = values.length
  if (n < 4) return null
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  if (!(variance > 0)) return null
  let cov = 0
  for (let i = 1; i < n; i += 1) cov += (values[i] - mean) * (values[i - 1] - mean)
  const r1 = cov / ((n - 1) * variance)
  const corrected = n * (1 - r1) / (1 + r1)
  if (!Number.isFinite(corrected)) return null
  return Math.max(3, Math.min(n, Math.round(corrected * 100) / 100))
}

/**
 * Build the per-region drift inputs `driftReport` expects.
 *
 * It takes an explicit list of regions, each with a reference window and a
 * current window. The split is chronological — the earlier half against the
 * later — because comparing a source against itself calls every input stable,
 * and a monitor that can never fire is a monitor that looks like good news.
 *
 * A region with fewer than four samples produces no windows at all and is left
 * out rather than half-filled: half a window is not a window.
 */
function driftFromStore(data) {
  const MIN_SAMPLES = 4
  const byRegion = new Map()

  for (const row of data.climate_observations || []) {
    // `precipitation_mm`, not `value` — reading a field nothing writes filters
    // every record out and the monitor reports no regions, which reads as
    // "nothing is drifting" rather than "nothing was measured".
    //
    // `Number.isFinite` and not truthiness, because 0 mm is a real measurement
    // and `if (!row.precipitation_mm)` drops every dry month. CHIRPS stores null
    // explicitly when it does not decode a raster, so null and 0 are different
    // facts and only one of them is absent.
    const measured = Number.isFinite(row?.precipitation_mm)
      ? row.precipitation_mm
      : Number.isFinite(row?.temperature_max_c) ? row.temperature_max_c : NaN
    if (!Number.isFinite(measured)) continue
    const region = row.region_name || row.country
    if (!region) continue
    if (!byRegion.has(region)) byRegion.set(region, [])
    byRegion.get(region).push({
      value: measured,
      at: row.observed_at || row.created_at || null,
    })
  }

  const regions = []
  for (const [region, samples] of byRegion) {
    if (samples.length < MIN_SAMPLES) continue
    // Undated samples keep their arrival order; a sort on a null date would
    // scatter them rather than order them.
    const ordered = [...samples].sort((a, b) => {
      const ta = a.at ? Date.parse(a.at) : NaN
      const tb = b.at ? Date.parse(b.at) : NaN
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
      if (Number.isNaN(ta)) return -1
      if (Number.isNaN(tb)) return 1
      return ta - tb
    })
    const half = Math.floor(ordered.length / 2)
    regions.push({
      region,
      referenceSamples: ordered.slice(0, half),
      currentSamples: ordered.slice(ordered.length - half),
    })
  }

  const report = driftReport({ regions })
  // The summary counts belong beside the records, not instead of them: a
  // consumer asking "is Turkana drifting" needs the row, and one asking "is
  // anything drifting" needs the count.
  return report.records.map((record) => ({ ...record, id: `drift_${record.region_name}`, type: 'model_drift', generated_at: report.generated_at }))
}

/**
 * ENH-62 — the content-addressed derived cache.
 *
 * `refreshAnalytics` recomputed all eight derived collections on every run. The
 * eight are not one computation with one input: `model_drift` is a function of
 * the climate series alone, `data_quality` of six ingested collections plus
 * `source_runs`, `region_trust` of alerts and model cards. Keying the whole set
 * on one global digest would skip everything the moment any collection was
 * touched, which is the common case — an ingestion run writes one collection and
 * a refresh that follows it would then redo all eight. So each collection is
 * keyed on the digest of its *own* inputs, and a collection whose inputs stood
 * still is skipped even when a sibling's moved. That per-collection skip is the
 * entire point; a single key would have been a cache that almost never hits.
 *
 * Correctness first, speed second. A stale hit publishes a number computed from
 * inputs that have since changed, which is the one output this platform may not
 * produce. So the rule is fail-open: a collection misses unless its digest is
 * demonstrably reproducible. The digest covers every input the collection
 * reads — enumerated from the module that computes it, not guessed — and the
 * ones it cannot cover are named in `CLOCK_DEPENDENT` so the miss is a decision
 * on the page rather than a hole in a hash.
 *
 * The skip is observable. `refreshAnalytics` returns the collections it
 * recomputed and the ones it skipped, and writes the same list to the log, so a
 * test can assert the skip happened and an operator can watch the cache work.
 * An unreported skip is indistinguishable from a refresh that silently did
 * nothing — the DAT-07 failure mode, where a job reports success while
 * measuring nothing.
 */

/** The collection a cache entry is keyed on: `name`, `inputs` (collections it reads) and a clock-free digest. */
export const DERIVED_INPUTS = Object.freeze([
  {
    name: 'risk_scores',
    // The three risk scorers. `collectRegions` reads all four geometry
    // collections; each scorer then reads a subset by radius. All four are
    // listed because the region set is a function of all four, and a region
    // appearing or moving changes every score on it.
    inputs: ['climate_observations', 'hazard_events', 'conflict_events', 'service_assets'],
  },
  {
    name: 'impact_assessments',
    // Service impacts read the assets and the region scores they borrow from —
    // but those scores are the *freshly computed* ones, not the stored rows. The
    // stored `risk_scores` are the output of the previous refresh and do not move
    // until the swap below, so keying this collection on them would miss a hazard
    // that arrived after the last refresh and had not yet been scored. The inputs
    // are therefore the same four collections the scorers read, plus the assets
    // they score against — which is the same set `risk_scores` names, because
    // `collectRegions` reads the assets too. So the two recompute together, which
    // is correct: an impact is a function of the scores, and the scores are a
    // function of the geometry.
    inputs: ['climate_observations', 'hazard_events', 'conflict_events', 'service_assets'],
  },
  {
    name: 'data_quality',
    inputs: ['climate_observations', 'hazard_events', 'conflict_events', 'service_assets', 'food_security_records', 'disease_observations', 'source_runs'],
  },
  { name: 'population_at_risk', inputs: ['service_assets', 'hazard_events'] },
  { name: 'facilities_at_risk', inputs: ['service_assets', 'hazard_events'] },
  { name: 'road_access', inputs: ['service_assets', 'hazard_events'] },
  // Calibration reads alert outcomes and trained model cards; drift reads the
  // climate series alone. Two inputs and one, and neither is the other's.
  { name: 'region_trust', inputs: ['alert_events', 'flood_probability_models'] },
  { name: 'model_drift', inputs: ['climate_observations'] },
])

/**
 * Collections whose recomputation reads a clock that is not part of the inputs,
 * so the cache must miss rather than hit.
 *
 * `computeRoadAccess` reads `new Date()` and calls `temporalStatus` on it: a
 * hazard that is `active` today is `stale` in eight days, so a stored road
 * access row is a function of wall-clock time as well as of the store. `now` is
 * injectable and `refreshAnalytics` does not inject it, so the value is not
 * reproducible from the inputs the digest covers. Hashing a clock would defeat
 * the cache the moment it mattered — every run produces a different digest, so
 * it would recompute every time and report a hit rate of zero, which is honest
 * but useless. The honest alternative is to say so: this collection always
 * recomputes, and it is named here rather than left as a silent miss.
 *
 * `computeDataQuality` reads `Date.now()` through `freshnessPenaltyFor` and
 * `freshnessLabel`: both feed `confidence` and `freshness`, so a source whose
 * records did not change still loses confidence as its newest record ages past
 * two, fourteen and forty-five days. The store's inputs are identical across
 * those boundaries and the published number is not, so this one is clock-bound
 * for the same reason as road access.
 *
 * The other six are clock-free by construction. They stamp `generated_at` with
 * `new Date()`, but that field is metadata and not a value any of them reads
 * back, and the recomputation itself does not consult the clock.
 */
export const CLOCK_DEPENDENT = Object.freeze(['road_access', 'data_quality'])

/**
 * The `source` a derived number's provenance envelope names.
 *
 * Not a connector id, and deliberately not shaped like one: `source_runs` is
 * keyed by connector, and a derived row attributed to a connector would be
 * indistinguishable from an ingested one in every join that reads that column.
 * The reconciliation ledger only needs the run id and the transform, but a
 * reader of the envelope gets to see that this number was computed rather than
 * fetched.
 */
export const DERIVED_RUN_SOURCE = 'analytics_refresh'

/**
 * What a derived number's run id is a digest of: everything the derived set
 * reads, minus the derived set itself.
 *
 * Computed from `DERIVED_INPUTS` rather than typed out, because a hand-typed
 * list standing for a discoverable set is this repository's most-repeated
 * defect — and here the consequence is silent. A collection added to a scorer
 * and not added here would leave the run id holding while the number moved, so
 * the ledger would report `changed_without_input_change` for a number that did
 * exactly what its inputs said.
 *
 * The subtraction states the definition — a run id is a function of what the
 * refresh *read*, never of what it *wrote* — and it is currently inert: no
 * scorer declares a derived collection as an input. It stays because the
 * definition is the thing being written down, and the moment a scorer does read
 * `risk_scores`, a run id hashed over its own output is not a subtle failure.
 * The test beside this asserts the same rule in both directions, so the two
 * agree by construction rather than by coincidence.
 */
export const RUN_INPUTS = Object.freeze([
  ...new Set(DERIVED_INPUTS.flatMap((entry) => entry.inputs)),
].filter((name) => !DERIVED_INPUTS.some((entry) => entry.name === name)))

/**
 * The code that produced a derived number, for `transform_version`.
 *
 * `buildProvenance` hashes the source text of the functions it is handed, so
 * editing a scorer changes the version it stamps — which is exactly the claim
 * the ledger's `changed_without_input_change` outcome needs to be checkable. It
 * is passed as a thunk list rather than evaluated here so the two scorers stay
 * the ones this module actually calls; a hand-typed version string would be the
 * list-standing-for-a-discoverable-set defect with a hash on it.
 */
const DERIVED_TRANSFORMS = [computeFloodRisk, computeClimateConflictRisk, computeCompoundHazardRisk, computeServiceImpacts]

/**
 * The collections a cached entry's digest was computed over.
 *
 * Read from the declaration rather than the key's own copy so a test can ask
 * "what does the digest cover" without reaching into the cache's internals.
 */
export function derivedInputsFor(name) {
  return DERIVED_INPUTS.find((entry) => entry.name === name)?.inputs || []
}

/** A collection's inputs as a plain object of records, missing collections read as empty. */
function sliceOf(data, collections) {
  const out = {}
  for (const collection of collections) out[collection] = data[collection] || []
  return out
}

/**
 * A stable digest over a collection's inputs, or `null` when they cannot be
 * digested and the collection must therefore miss.
 *
 * `canonicalHash` sorts keys at every depth, so two reads of the same records in
 * a different order hash the same — the store sorts newest-first, and a merge
 * that reorders without changing content must not look like a change. Its
 * `ignoreKeys` default drops `id`, `updated_at`, `created_at`, `generated_at`,
 * `payload_hash` and the rest, but only at the *top level* of what it is handed,
 * and what it is handed here is a map of collection names to arrays. No key of
 * that map is a record stamp, so nothing is actually dropped: every field of
 * every record is covered.
 *
 * That over-coverage is deliberate. A record-level `updated_at` is not always
 * metadata — `computeDataQuality` reads `observed_at || occurred_at ||
 * updated_at || generated_at` for its freshness, and `driftFromStore` reads
 * `observed_at || created_at` for its windows — so stripping per-record stamps to
 * make the digest "stable" would be a digest that ignores an input the collection
 * reads, which is the stale hit this whole design refuses. The cost of covering
 * them is a false *miss* when a re-ingest rewrites a record without changing
 * anything a collection reads; a false miss recomputes and is merely slower,
 * which is the direction the error has to point.
 *
 * The refusal is the other important half. A record that JSON cannot serialise —
 * a cyclic reference, a value a connector left as a `BigInt` or a function —
 * throws in `JSON.stringify` rather than hashing to something. A digest that
 * cannot be computed is not a digest of the empty set: it is an absent
 * measurement, and the collection must miss. Returning `null` here, and treating
 * `null` as a miss, is what keeps an undigestible input from becoming a false
 * hit. The alternative — hashing `String(record)`, or falling back to `'[]'` —
 * would make every undigestible store hash identically and the cache would
 * serve one store's numbers against another's inputs.
 */
function derivedDigest(name, data) {
  try {
    return canonicalHash(sliceOf(data, derivedInputsFor(name)))
  } catch {
    return null
  }
}

/**
 * The id of the run a refresh's derived numbers came from, or `null`.
 *
 * A digest of the collections the refresh *read*, so the id moves when the
 * inputs move and holds when they do not. `null` when they cannot be digested —
 * the same guard, and the same reason, as `derivedDigest` above.
 *
 * Not `INPUT_COUNTS`, which is the obvious set and the wrong one. That set is
 * the counts stamped *on* a derived record for SAE-23 to compare against, so it
 * names the derived collections as inputs — and this refresh stamps every derived
 * row with an envelope before the swap. Hashing them made the run id a function
 * of the *previous* run id: seeded(1) → `743a33e6`, seeded(6) → `32ca17f7`, back
 * to seeded(1) → `062ed804`, three ids for two input states. The ledger reads a
 * moved run id with unchanged inputs as `changed_without_input_change` — "the
 * engine changed" — so it would have reported the engine changing on every
 * refresh, which is the outcome the module exists to distinguish from a real
 * finding. A check that fires always is read as noise by the third week.
 */
function digestOfRun(data) {
  try {
    return stableId('analytics_run', [canonicalHash(sliceOf(data, RUN_INPUTS))])
  } catch {
    return null
  }
}

/**
 * Which collections a refresh must recompute, and which it may reuse.
 *
 * A cache entry is reusable only when the previous digest exists, is not `null`
 * (the undigestible case), and equals the current one. Anything else — no entry,
 * an undigestible input, a changed digest, a clock-dependent collection — is a
 * recompute. There is no partial credit: a collection is recomputed whole or
 * skipped whole.
 *
 * `stored` is the outgoing derived collections, and it is what stops the cache
 * reporting a full skip on a cold cache. A skip is only real when there are rows
 * to reuse; a digest that matches but has no stored rows behind it is a cache
 * entry for a value that is not there, and reusing it would publish nothing where
 * the last run published rows. A missing previous value is therefore a
 * recompute, whatever the digest says — the "skipped 8, recomputed 0" result
 * this repository has shipped before, where a check measured nothing and called
 * it success.
 */
export function planDerivedRefresh(data, cache, stored = {}) {
  const recompute = []
  const skip = []
  for (const { name } of DERIVED_INPUTS) {
    const rows = stored[name]
    if (CLOCK_DEPENDENT.includes(name) || !Array.isArray(rows)) {
      recompute.push(name)
      continue
    }
    // DATA-14. A stored row with no `id` is a row the store cannot name, and
    // `replaceAnalytics` now refuses one rather than writing it to a backend
    // that would silently drop it. Reusing such a row would carry the refusal
    // forward: the skip path hands the previous rows straight back to the
    // write, so a store populated before the producers minted ids would throw
    // on the next refresh and stay un-refreshable.
    //
    // It is the same rule the paragraph above states about a digest with no
    // rows behind it, one field over: a cache entry whose rows are not
    // nameable is a cache entry for a value that cannot be stored, so it is a
    // recompute whatever the digest says. On a store written by the current
    // producers this never fires.
    if (rows.some((row) => !row || typeof row.id !== 'string' || !row.id)) {
      recompute.push(name)
      continue
    }
    const current = derivedDigest(name, data)
    if (current !== null && cache && cache[name] === current) skip.push(name)
    else recompute.push(name)
  }
  return { recompute, skip }
}

/** The fresh digests for the collections just recomputed. Skipped ones keep the digest they had. */
function digestsAfter(plan, data, previousDigests = {}) {
  const out = {}
  for (const { name } of DERIVED_INPUTS) {
    if (plan.recompute.includes(name)) out[name] = derivedDigest(name, data)
    else if (previousDigests[name] !== undefined) out[name] = previousDigests[name]
  }
  return out
}

export async function refreshAnalytics(store) {
  const data = await store.read()
  // One read, taken before the swap. `replaceAnalytics` overwrites the derived
  // collections, so both the plan (which needs the outgoing digests) and the
  // reconciliation's "before" side (which needs the outgoing rows) have to be
  // decided from the pre-swap snapshot. Reading the store again after the swap
  // would compare the new rows against themselves.
  const plan = planDerivedRefresh(data, cacheFor(store), data)
  const previousDigests = cacheFor(store)
  const previousValues = await readDerived(store, ['risk_scores', 'impact_assessments'], data)
  const computed = {}
  // Computed on demand rather than all eight unconditionally, so a skipped
  // collection is genuinely not recomputed. `region_trust` borrows the freshly
  // computed `risk_scores` because its measured rate prefers them to the stored
  // ones — the same value either way when `risk_scores` was itself skipped, since
  // a skip means the inputs behind both are identical.
  const need = (name) => plan.recompute.includes(name)
  if (need('risk_scores')) {
    computed.risk_scores = [
      ...computeFloodRisk(data),
      ...computeClimateConflictRisk(data),
      // ENH-56. The joint score, stored beside the two marginals rather than
      // instead of them: a compound score answers a question neither asks, and
      // replacing one of them with it would lose the marginal.
      ...computeCompoundHazardRisk(data),
    ]
  }
  if (need('impact_assessments')) computed.impact_assessments = computeServiceImpacts(data, computed.risk_scores || data.risk_scores || [])
  if (need('data_quality')) computed.data_quality = computeDataQuality(data)
  if (need('population_at_risk')) computed.population_at_risk = computePopulationAtRisk(data)
  if (need('facilities_at_risk')) computed.facilities_at_risk = computeFacilitiesAtRisk(data)
  if (need('road_access')) computed.road_access = computeRoadAccess(data)
  // Calibration and drift are computed on every refresh and stored like the rest
  // of the derived set, so a region's stale trust score is replaced rather than
  // accumulating under evidence that has since moved.
  if (need('region_trust')) computed.region_trust = calibrationByRegion({ ...data, risk_scores: computed.risk_scores || data.risk_scores || [] })
  if (need('model_drift')) computed.model_drift = driftFromStore(data)
  // SAE-23. The counts a value was computed from travel *with the value*, so
  // the next refresh has two real sides to compare: the number that was stored
  // and the counts it was stored from. Without them the only available
  // comparison is a number against itself, which is a check that cannot fail.
  //
  // Stamped before the swap, so what the store held is what the comparison reads.
  for (const record of computed.risk_scores || []) record.input_counts = inputDigestFor(placeOf(record), data)
  // The row's own district, via `districtOf`, and not `placeOf` — see that
  // function for why an identity and a place are not the same field.
  for (const record of computed.impact_assessments || []) record.input_counts = inputDigestFor(districtOf(record), data)

  // ENH-51. A derived number carries the envelope that names the run which
  // produced it, for the same reason an ingested record does: the reconciliation
  // ledger traces on `_provenance`, and a number with none is refused as
  // `cannot_trace: no_provenance` rather than compared. Without this the ledger
  // would run on every refresh and report nothing but refusals — a check that
  // measures nothing, wearing the shape of a clean result.
  //
  // The run id is a digest of the *inputs* this refresh computed from, not a
  // clock. The refresh is a pure function of its inputs — `planDerivedRefresh`
  // already depends on that — so two refreshes over identical inputs are the
  // same run as far as reconciliation is concerned, and a re-run of an unchanged
  // store reconciles rather than reporting a spurious "changed with changed
  // inputs". A clock here would make every refresh a new run and every pair
  // would come back `reconciled`, which is the false negative the ledger exists
  // to prevent.
  //
  // `derivedDigest`'s guard, for `derivedDigest`'s reason: an input that cannot
  // be digested (a cycle, a BigInt) has no digest, and a run id computed from one
  // would be a claim that two undigestible refreshes are the same run. When
  // there is no id there is no envelope, the number refuses as untraceable, and
  // that is the honest answer rather than a guessed attribution.
  const derivedRunId = digestOfRun(data)
  const derivedRows = [
    ...(computed.risk_scores || []).map((record) => ['risk_scores', record]),
    ...(computed.impact_assessments || []).map((record) => ['impact_assessments', record]),
  ]
  if (derivedRows.length) {
    const envelopes = derivedRunId
      ? buildProvenance({
        sourceRun: { id: derivedRunId, source: DERIVED_RUN_SOURCE },
        connector: { id: DERIVED_RUN_SOURCE },
        records: derivedRows.map(([, record]) => record),
        // No URL: a derived number is fetched from nowhere, and `null` says that
        // rather than naming the store it was read out of. `retrieved_at` is the
        // run id rather than a timestamp for the reason above — it has to be a
        // function of the inputs or the envelope is not.
        retrieval: { url: null, retrieved_at: derivedRunId },
        transform: DERIVED_TRANSFORMS,
      })
      : []
    derivedRows.forEach(([, record], index) => {
      if (envelopes[index]) record._provenance = envelopes[index]
    })
  }

  // The skipped collections keep the rows the store already holds — `data` is the
  // pre-swap snapshot — so a skip is a genuine no-op rather than a recompute whose
  // result is thrown away.
  const payload = { ...computed }
  for (const name of plan.skip) payload[name] = data[name] || []

  await store.replaceAnalytics(payload)
  // Only the recomputed half is reconciled: a skipped collection's rows are
  // identical to what the store held, so comparing them would report "nothing
  // moved" for a collection nothing measured. The reconciliation is for values
  // that moved, and a skip is the case where they could not have.
  const reconciliation = await reconcileDerivedNumbers(store, data, { previous: previousValues, now: new Date().toISOString() })
  // ENH-51. SAE-23's reconciliation answers "did a value move by more than the
  // band"; the ledger answers the narrower "did it move at all, and if its
  // inputs held, what moved it". Both are written, because they are different
  // questions with different bands and a caller reading one is not reading the
  // other. The ledger's events go to `reconciliation_events` rather than into
  // `unexpected_changes`, which SAE-23 owns and whose shape its readers depend
  // on.
  const ledger = await reconcileRefresh(store, { before: previousValues, after: payload, now: new Date().toISOString() })
  rememberDigests(store, digestsAfter(plan, data, previousDigests))

  // Persist calibration snapshot (best-effort, don't fail refresh)
  //
  // R-50. "Best-effort" means the refresh does not fail when the snapshot
  // cannot be written. It does not mean the failure is invisible, and that is
  // what `catch { }` made it: a full disk, a `data/calibration` that lost its
  // write bit, a path that is a file where a directory was expected — each left
  // a stale `latest.json` and no log line, no counter, no field. An operator
  // reading a three-week-old snapshot had no way to learn it was three weeks
  // old. Tolerating a failure is a decision; being unable to observe it is a
  // defect, and only the first is intentional here.
  if (process.env.LINDELA_LITE_CALIBRATION_DIR !== 'off' && process.env.NODE_ENV !== 'test') {
    const calibDir = path.resolve(process.env.LINDELA_LITE_CALIBRATION_DIR || 'data/calibration')
    try {
      await fs.mkdir(calibDir, { recursive: true })
      await fs.writeFile(path.join(calibDir, 'latest.json'), JSON.stringify({ risk_scores: payload.risk_scores, data_quality: payload.data_quality, generated_at: new Date().toISOString() }, null, 2))
    } catch (error) {
      // Reported, not rethrown: the refresh succeeded and its payload is
      // returned below. `error.code` rather than the message, because the code
      // is the stable half (`ENOSPC`, `EACCES`, `ENOTDIR`) and the message
      // carries the path, which varies per deployment.
      metrics.counter('calibration_snapshot_write_failed_total', { code: error?.code || 'unknown' })
      logger.warn('calibration_snapshot_write_failed', { dir: calibDir, code: error?.code || null, error: String(error?.message || error) })
    }
  }

  logger.debug('derived_cache', { recomputed: plan.recompute, skipped: plan.skip })

  return {
    ...payload,
    recomputed: [...plan.recompute],
    skipped: [...plan.skip],
    unexpected_changes: reconciliation.rows.length,
  }
}

/**
 * The digests the last refresh on this store instance left.
 *
 * In-memory, keyed by store identity, and that is a deliberate choice over
 * persisting them. A persisted cache would survive a restart and let the first
 * refresh after a deploy skip, but it would also need a place to live — a
 * `derived_digests` collection in the store's own declaration — and it would
 * serve a digest computed by a *previous build* against inputs the current build
 * reads differently. The digest covers inputs, not the code that reads them, so
 * a cache that outlives the process that filled it can hit across a changed
 * engine: exactly the stale hit this design refuses. An in-memory cache cannot
 * outlive its process, so a deploy always misses and always recomputes, and the
 * first run on a fresh instance is honest about being a first run.
 *
 * A `WeakMap` rather than a `Map`, so a discarded store does not keep its digest
 * alive. The key is the store object, so two stores in one process — two
 * deployments, or a test's scratch store — never read each other's cache.
 *
 * The digest itself is recomputed from a fresh read on every refresh, so a
 * "hit" means the inputs are *currently* identical, not that they were when the
 * entry was written. Nothing is trusted from the cache except the fact that the
 * last run's inputs hashed to the same value as this run's.
 */
const DERIVED_CACHE = new WeakMap()

function cacheFor(store) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) return {}
  let cache = DERIVED_CACHE.get(store)
  if (!cache) {
    cache = {}
    DERIVED_CACHE.set(store, cache)
  }
  return cache
}

/** Record the digests this refresh computed, for the next one to compare against. */
function rememberDigests(store, digests) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) return
  DERIVED_CACHE.set(store, { ...digests })
}

/**
 * The outgoing derived values, keyed for comparison.
 *
 * A store that has never computed them has no previous values, which is not a
 * change — it is a first run. Returning an empty map is what makes the
 * reconciliation say "nothing moved", rather than reporting every district as an
 * unexplained change on a fresh deployment.
 */
async function readDerived(store, collections, snapshot = null) {
  if (typeof store.read !== 'function') return new Map()
  // The caller may hand in a snapshot it already holds. `refreshAnalytics` does,
  // because the outgoing rows have to be captured *before* the swap, and reading
  // the store again after it would compare the new rows against themselves.
  const read = snapshot || await store.read()
  const out = new Map()
  for (const collection of collections) {
    for (const record of read[collection] || []) {
      // The whole outgoing record, not just its value: the input counts it was
      // computed from are on it, and they are the other side of the comparison.
      out.set(derivedKey(collection, record), { collection, record, value: comparableValue(record) })
    }
  }
  return out
}

/**
 * The number a reconciliation compares: the score, or null when there is none.
 *
 * The list was `score, risk_score, value, level, impact_level`, and two of those
 * five were wrong in a way no test could see:
 *
 *   - `level` and `impact_level` are *labels*. A risk row carries `score` and
 *     `risk_level`, so it compared on the score; an impact row carries
 *     `impact_score` and `impact_level`, so it fell through to the label and
 *     compared `'medium'` against `'medium'`. A service impact whose score moved
 *     from 54 to 55 inside one band was reported as holding while its inputs
 *     moved — the ledger's own `unchanged_with_input_change` finding, produced by
 *     the comparison rather than found by it.
 *   - a refusal is not a value. `computeCompoundHazardRisk` returns
 *     `score: null, level: 'unknown'` when the window is too short, so the row
 *     fell past the null score to the sentinel string and reconciled as
 *     `'unknown'` — a *finding*, on a number that was never computed. A refusal
 *     reported as a movement is the loudest way this module can lie.
 *
 * So: the numeric field each family actually publishes, and nothing else. A
 * record with no numeric field returns null, which `reconcileNumber` turns into
 * `missing_inputs` — an honest refusal rather than a comparison of two strings.
 */
function comparableValue(record) {
  for (const field of NUMERIC_VALUE_FIELDS) {
    const value = record[field]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * SAE-23 — "this number changed and nobody knows why" has to be answerable.
 *
 * `replaceAnalytics` swaps eight collections wholesale, so a change in the
 * engine, or a source that quietly stops contributing, moves every district's
 * numbers at once and leaves no trace. The repository already has
 * `payload_hash`, `data_lineage` and per-record provenance — every primitive
 * except the cross-check, which is the one that would notice.
 *
 * So: for every district whose value moved while its *input counts* did not,
 * write a row naming the region, both values, and the inputs that did not
 * change. A moved value over moved inputs is ordinary; a moved value over
 * unmoved inputs is the engine, and this is the only place that says so.
 *
 * The band is deliberately wide. A reconciliation that fires on rounding
 * trains operators to ignore it, and an ignored signal is worse than none: a
 * narrow band here would produce a row on nearly every refresh and the row would
 * be read as noise by the third week.
 */
export const UNEXPECTED_CHANGE_BAND = 0.05

/** The input counts a district's derived value is a function of. */
const INPUT_COUNTS = [
  'hazard_events', 'conflict_events', 'climate_observations', 'field_reports',
  'service_assets', 'road_access', 'flood_probability_models', 'data_quality',
  'incident_records', 'food_security_records', 'disease_observations',
  'impact_assessments', 'response_resources',
]

/**
 * What a derived record is *about*.
 *
 * The derived rows are keyed on a grid cell (`region_name: "3,36"`) rather than
 * a district name, and the two risk families — flood and climate-conflict —
 * produce one row each for the same cell. So identity is the cell *and* the
 * kind: a flood score moving while a conflict score does not is one district's
 * number, and collapsing them into a single key would compare two different
 * quantities and call the difference an anomaly.
 */
// R-77: placeOf/derivedKey/NUMERIC_VALUE_FIELDS moved to `src/derived-key.js`,
// a leaf module, because `src/reconciliation.js` imported them from here
// while this file imports `reconciliation` — the fourth cycle in `src/`,
// which the R-77 entry never named. Re-exported so src/replay.js and
// src/reconciliation.js keep their import path and the export identity is
// unchanged. `districtOf` stays here: it is used only here.

/**
 * The district a record's inputs are counted over.
 *
 * Separate from `placeOf` because the two answer different questions and only
 * coincided while every derived row carried a `region_name`. Identity has to be
 * stable under a value change (hence `asset_id` for an impact); the input count
 * has to name somewhere records actually live (hence the district). For an
 * impact row the asset's `admin1` is the second and the asset id is the first,
 * and using one for the other is how the counts came back all zero.
 */
function districtOf(record) {
  // No `record.id` fallback, deliberately, though `placeOf` has one. An id is
  // not a district: falling back to it is what made every impact row's inputs
  // count zero, and a branch that re-creates the bug is not a safety net.
  return record.district || record.region || record.region_name || null
}

export function inputDigestFor(district, data) {
  const counts = {}
  for (const name of INPUT_COUNTS) {
    const records = data[name] || []
    counts[name] = Array.isArray(records)
      ? records.filter((record) => inDistrict(record, district)).length
      : 0
  }
  return counts
}

function inDistrict(record, district) {
  if (!district) return true
  if (record.district) return record.district === district
  if (record.country && district.includes(record.country)) return true
  return false
}

export async function reconcileDerivedNumbers(store, data, { previous, now = new Date().toISOString(), band = UNEXPECTED_CHANGE_BAND } = {}) {
  const before = previous || new Map()
  const rows = []
  for (const [collection, records] of Object.entries({
    risk_scores: data.risk_scores || [],
    impact_assessments: data.impact_assessments || [],
  })) {
    for (const record of records) {
      const key = derivedKey(collection, record)
      const was = before.get(key)
      if (!was) continue
      const nowValue = comparableValue(record)
      const wasValue = was.value
      if (nowValue === null || wasValue === null) continue
      const delta = typeof nowValue === 'number' && typeof wasValue === 'number'
        ? Math.abs(nowValue - wasValue)
        : (nowValue === wasValue ? 0 : Infinity)
      const relative = typeof nowValue === 'number' && nowValue !== 0
        ? delta / Math.abs(nowValue)
        : delta
      if (!(relative > band)) continue

      const district = placeOf(record)
      const after = record.input_counts || null
      const beforeCounts = was.record.input_counts || null
      if (after && beforeCounts && JSON.stringify(beforeCounts) === JSON.stringify(after)) {
        rows.push({
          id: `unexpected_${collection}_${String(district).replace(/[^a-z0-9]+/gi, '-')}`,
          type: 'unexpected_change',
          collection,
          district,
          value_before: wasValue,
          value_after: nowValue,
          relative_change: Number(relative.toFixed(6)),
          // The inputs, stated as counts, and the fact that they did not move.
          // "Inputs unchanged" is the whole claim; the reader's first question is
          // always "what changed then?", and this is the answer.
          input_counts: after,
          inputs_unchanged: true,
          observed_at: now,
        })
      }
    }
  }
  if (rows.length) {
    await store.merge({ unexpected_changes: rows })
    for (const row of rows) {
      logger.error('derived_value_moved_without_input_change', {
        collection: row.collection,
        district: row.district,
        before: row.value_before,
        after: row.value_after,
      })
    }
  }
  return { rows }
}

/**
 * ENH-51 — the reconciliation ledger, run over one refresh.
 *
 * SAE-23 asks whether a number moved by more than a band over unchanged input
 * *counts*. This asks the four-way question the ledger exists for, and the two
 * are not the same question: a value that moved by a hair is a finding here and
 * is deliberately below SAE-23's band, and a number that could not be traced at
 * all is a refusal here and is invisible there. Both are written because both
 * are read.
 *
 * `before` is the pre-swap derived map `readDerived` built, and `after` is the
 * payload about to be stored — already carrying the `_provenance` envelope this
 * refresh stamped on it. A refresh that recomputed nothing reconciles nothing,
 * and says so with `measured: 0` rather than reporting a clean ledger, which is
 * the distinction the module's own header is built on.
 *
 * The events are chained before they are stored, so the collection holds the
 * same hash-chained rows `ReconciliationLedger` produces in memory. Re-merging a
 * pair produces the same ids — `toEvent` keys on the run pair and the outcome,
 * never on the clock — so a second refresh of an unchanged store updates the
 * events rather than appending a second copy of them.
 */
async function reconcileRefresh(store, { before, after, now }) {
  if (typeof store.merge !== 'function') return { measured: 0, events: [], skipped: 'store cannot merge' }
  const prior = before instanceof Map ? before : observationMap(before || {})
  const current = observationMap(after || {})
  // A collection the refresh did not recompute is absent from `payload`, so its
  // rows are absent from `current` too — and a number that is not in `current` is
  // not compared. That is the honest outcome: nothing was measured about it, and
  // inventing a comparison against the stored row would reconcile a number
  // against itself.
  const report = reconcileRun({ before: prior, after: current, now, includeReconciled: false })
  if (!report.events.length) return { ...report, stored: 0 }
  const ledger = new ReconciliationLedger()
  const chained = ledger.append(report.events)
  await store.merge({ reconciliation_events: chained })
  return { ...report, stored: chained.length }
}

export function computeFloodRisk(data, options = {}) {
  const regions = collectRegions(data, options)
  // Injected for the same reason `computeRoadAccess` injects it: a recency rule
  // whose clock is read inside the loop cannot be tested at a chosen age.
  const now = options.now ?? new Date()
  const recencyDays = options.hazardRecencyDays ?? DEFAULT_HAZARD_RECENCY_DAYS
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    const inRadius = nearby(data.hazard_events.filter((event) => /flood|storm|disaster/i.test(event.event_type)), region, 250)
    // DATA-04. The radius selects *where*; this selects *when*. Without it the
    // hazard term was a function of how much archive had been ingested, so
    // backfilling `gdacs-archive` raised every covered district's score with no
    // change in conditions.
    const { current: hazards, stale, undated } = splitByRecency(inRadius, now, recencyDays)

    // Bias-corrected value, else the deterministic point value.
    //
    // This used to prefer ensemble p90 over the point value. Those percentiles
    // were synthesized from the same point value by an invented spread, so
    // preferring them meant scoring against an inflated number — at a reported
    // probability of 10%, p90 was about 1.9x the observed precipitation. A
    // percentile is only preferred when a real probabilistic forecast supplied
    // it, which is now identified by `ensemble_source`.
    // ENH-47. Each reading keeps the record it came from, because the record is
    // what declares the period. `precipitation_mm` is written into
    // `climate_observations` by `src/connectors/open-meteo.js` twice: once from
    // the API's `current` block, which is the preceding **15 minutes**, and once
    // from its `daily` block, which is the **whole-day total**. Same dimension,
    // same scale, same field name — so no dimension check and no scale check can
    // see the problem, and the mean below blended them. A 3 mm quarter-hour
    // beside a 40 mm day published as "21.5 mm", a number describing no period
    // at all, and the flood score was computed from it.
    const precipValues = climate.map((item) => {
      if (Number.isFinite(item.bias_corrected_precipitation_mm)) return { ...item, precipitation_mm: Number(item.bias_corrected_precipitation_mm) }
      if (item.ensemble_source === 'open_meteo_ensemble' && Number.isFinite(item.ensemble_p90)) {
        return { ...item, precipitation_mm: Number(item.ensemble_p90) }
      }
      // A missing reading is unknown, not zero. `|| 0` made an absent
      // precipitation record look like a measured dry spell, which lowers the
      // score — the worst direction for an absent input.
      return { ...item, precipitation_mm: Number.isFinite(item.precipitation_mm) ? Number(item.precipitation_mm) : null }
    })
    const usablePrecip = precipValues.filter((item) => item.precipitation_mm !== null)
    const missingPrecip = precipValues.length - usablePrecip.length
    // The mean of the readings, not their sum — and within one period.
    //
    // Every observation here is a *point* total: `nearby` collects each station
    // within 125 km, and each reports the rainfall at its own location. Adding
    // them adds the same storm once per station, so the score rose with sensor
    // density — five stations reporting 20 mm scored 3x one station reporting
    // the identical 20 mm, and a coordinator pre-positioned assets in the
    // well-instrumented district while starving the identical under-instrumented
    // one. The score was a map of where the stations are. A spatial mean is the
    // quantity the term is named for.
    //
    // `meanMeasured` enforces the period axis the name could not: when the
    // in-scope readings state two different declared periods it takes the mean
    // over the larger group and reports `mixed`, so the payload can say the
    // input was mixed rather than publishing a blend as a measurement.
    const rainfallMean = meanMeasured(usablePrecip, 'precipitation_mm')
    const precipitation = rainfallMean.mean
    // Only a percentile from a genuine probabilistic forecast counts as ensemble
    // coverage. Percentiles previously synthesized from a point value would
    // otherwise always satisfy this and report uncertainty the data does not have.
    const hasEnsemble = climate.some((c) => c.ensemble_source === 'open_meteo_ensemble' && Number.isFinite(c.ensemble_p90))
    // How wide the ensemble is relative to its own value — a coefficient of
    // variation, and the one number here that comes from the forecast's own
    // members rather than from input coverage. It is null below the reporting
    // floor (`MIN_ENSEMBLES_FOR_SPREAD_SKILL`), and null is the honest answer:
    // a relative spread from one or two ensembles describes the sample, not the
    // uncertainty. Surfaced beside the sensitivity band so a reader can see that
    // the two are different quantities — the band is coverage-driven, this is
    // member-driven, and only this one is a property of the forecast.
    const spreadSkill = spreadSkillIndex(climate)
    const hasBiasCorrection = climate.some((c) => Number.isFinite(c.bias_corrected_precipitation_mm))

    // Same rule for probability: an absent forecast is not a 0% chance of rain.
    const probabilities = climate
      .map((item) => (Number.isFinite(item.precipitation_probability_pct) ? Number(item.precipitation_probability_pct) : null))
      .filter((v) => v !== null)
    const missingProbability = climate.length - probabilities.length
    const maxProbability = probabilities.length ? Math.max(0, ...probabilities) : null
    const hazardPressure = hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 30, 0)
    // An absent probability contributes nothing, and the score says so.
    //
    // `(maxProbability ?? 0) * 0.35` folded a missing forecast in as a 0% chance
    // of rain, which is the opposite of what the comment above it promises: a
    // district whose forecast feed dropped scored identically to one with a
    // genuine dry forecast and lower than one with a wet forecast, so an outage
    // read as lower risk. Omitting the term arithmetically is the same number —
    // the fix is that the omission is now named on the payload, with its
    // direction, so a consumer cannot read the shortfall as a finding. Dividing
    // the remaining terms by their weight sum would change the scale of every
    // published score, which is a decision for the aggregation-kind registry
    // (ENH-46) and a domain read, not a silent edit here.
    const probabilityTermOmitted = maxProbability === null
    const score = clamp(Math.round((precipitation ?? 0) * 1.5 + (maxProbability ?? 0) * 0.35 + hazardPressure), 0, 100)
    // Confidence counts readings actually used, not records present. A region
    // whose observations arrived without precipitation gets a lower confidence,
    // so an absent input lowers how sure the score is rather than lowering the
    // score — which is the only safe direction for missing data.
    const confidence = confidenceScore([
      { count: usablePrecip.length, weight: 45 },
      { count: hazards.length, weight: 40 },
      { count: probabilities.length, weight: 15 },
    ])

    // Sensitivity band around the point score, NOT a probabilistic interval.
    //
    // These fields were originally named score_p10/p50/p90, which reads as
    // quantiles of a calibrated predictive distribution. They are not. The
    // width is a fixed function of the input-coverage confidence score, so a
    // well-populated region returns p10 == p50 == p90 with interval_width 0,
    // which presents as "no uncertainty" when it means "enough inputs to
    // compute a point score". Renamed to state what they are; the values and
    // the p10/p50/p90 aliases are unchanged so existing consumers and stored
    // records keep working.
    const halfWidth = Math.round((100 - confidence) * 0.4)
    const score_p50 = score
    const score_p10 = clamp(score - halfWidth, 0, 100)
    const score_p90 = clamp(score + halfWidth, 0, 100)
    const interval_width = score_p90 - score_p10

    // One timestamp for the record and its envelope. Two `new Date()` calls a
    // microsecond apart would let a consumer diff the two and conclude the
    // evidence was gathered after the score it explains.
    const generated_at = new Date().toISOString()

    const drivers = {
      // The mean of the in-scope readings. Named `precipitation_mm` for
      // compatibility with stored records and existing consumers; the basis
      // string below says "mean" so a reader is not left to guess which of the
      // two it is.
      precipitation_mm: precipitation === null ? null : Math.round(precipitation * 10) / 10,
      precipitation_probability_pct: maxProbability,
      // Exposed so a caller can see how much of the input was missing rather than
      // inferring completeness from a plausible-looking total.
      climate_observations_in_scope: climate.length,
      precipitation_readings_used: usablePrecip.length,
      missing_precipitation_records: missingPrecip,
      missing_probability_records: missingProbability,
      // ENH-47. The period the mean is over, and whether the in-scope readings
      // disagreed about it. `mixed: true` means the input blended a 15-minute
      // snapshot with a daily total and the mean below is over the larger group
      // — a reader must be able to see that rather than take a number that
      // describes no period for a measurement.
      precipitation_period: rainfallMean.period,
      precipitation_period_mixed: rainfallMean.mixed,
      precipitation_by_period: rainfallMean.by_period,
      // DATA-04. The count the pressure term is computed over — in radius *and*
      // inside the recency window. The name is unchanged so existing consumers
      // keep their field; what it counts is now stated rather than implied.
      flood_hazard_events: hazards.length,
      // How much in-radius evidence was set aside as history, and how much of
      // what was kept cannot say when it happened. A count alone cannot
      // distinguish a quiet district from one whose archive has not been
      // backfilled — the direction this defect failed in.
      flood_hazard_events_stale: stale.length,
      flood_hazard_events_undated: undated,
      hazard_recency_days: recencyDays,
      // A score computed without the probability term is a different quantity
      // from one computed with it, and the difference is 0.35 of weight in the
      // unsafe direction. Named so it cannot be read as a dry forecast.
      probability_term_omitted: probabilityTermOmitted,
    }
    if (hasBiasCorrection) drivers.bias_corrected = true
    if (hasEnsemble) drivers.ensemble_used = true

    return {
      id: stableId('risk', ['flood', region.key]),
      type: 'flood_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      // Truthful names for what these are.
      sensitivity_low: score_p10,
      sensitivity_mid: score_p50,
      sensitivity_high: score_p90,
      sensitivity_width: interval_width,
      // Retained aliases for existing consumers and stored records.
      score_p10,
      score_p50,
      score_p90,
      interval_width,
      calibrated_uncertainty: false,
      // Member-derived, unlike the band above it. `ensemble_spread_index` is a
      // relative spread (mean member stddev / mean member median) over the
      // in-scope ensemble forecasts; `ensemble_spread_basis` says how many went
      // into it, and both are null when the floor was not met. A consumer that
      // wants "how uncertain is this input" wants this field, not
      // `sensitivity_width`, and the two are named so the choice is visible.
      ensemble_spread_index: spreadSkill,
      ensemble_spread_basis: spreadSkill === null ? 0 : climate.filter((c) => c.ensemble_source === 'open_meteo_ensemble').length,
      ensemble_spread_floor: MIN_ENSEMBLES_FOR_SPREAD_SKILL,
      risk_level: riskLevel(score),
      confidence,
      generated_at,
      drivers,
      methodology: `Transparent baseline: precipitation forecast + flood/storm/disaster alerts within 250 km and ${recencyDays} days near exposed locations.`,
      // The band travels beside the tiers rather than inside them. It is a
      // function of input coverage (see ADR-004) and calling it a sampling tier
      // would say it measures the outcome rate when it measures neither.
      uncertainty: uncertaintyTiers({
        coverage: [
          'any hydrological transformation of rainfall to flood extent or depth — none is modelled here',
          'gauge observation error, and the ERA5 tail-dryness bias documented in the basis document',
          'reporting bias: a hazard that occurred and was never reported contributes nothing to the hazard pressure term',
          'the sensitivity band above, which is drawn from input coverage and is not a predictive interval',
        ],
      }),
      honesty: honestyEnvelope('flood_risk_score', {
        value: score,
        basis: {
          description: `mean precipitation across in-scope observations x 1.5 + max rain probability x 0.35 + sum of severity-weighted flood/storm/disaster alerts within 250 km and ${recencyDays} days, over ${climate.length} climate observation(s) and ${hazards.length} current hazard event(s)`,
          sample: {
            climate_observations_in_scope: climate.length,
            missing_precipitation_records: missingPrecip,
            flood_hazard_events: hazards.length,
            flood_hazard_events_stale: stale.length,
            flood_hazard_events_undated: undated,
          },
        },
        notIncluded: [
          'any hydrological model: rainfall-to-flood extent, depth and duration are not modelled',
          'the sensitivity band, which reflects input coverage rather than a calibrated outcome distribution',
        ],
        evidence: { retrieved_at: generated_at },
        refused: missingPrecip || missingProbability
          ? [`${missingPrecip} of ${climate.length} in-scope climate observations and ${missingProbability} probability forecasts contributed nothing to this score, so a low score here may mean missing data rather than low risk`]
          : [],
      }),
      limits: [
        'Point score from input data, with a sensitivity band driven by input coverage, not a calibrated predictive distribution.',
        'A zero band means inputs were sufficient, not that the outcome is certain.',
        missingPrecip || missingProbability
          ? `Incomplete input: ${missingPrecip} of ${climate.length} in-scope climate observation(s) carry no precipitation reading and ${missingProbability} carry no probability forecast. Those contribute nothing to the score, so a low score here may reflect missing data rather than low risk.`
          : 'All in-scope climate observations carried a precipitation reading.',
        probabilityTermOmitted
          ? 'No in-scope observation carried a probability forecast, so the rain-probability term contributed nothing. That omission lowers this score by up to 35 points, so a low score here may be a missing forecast rather than a dry one.'
          : null,
        'Rainfall intensity/duration to flood probability is not modelled: that needs an agreed hydrological model basis and a validated record.',
        // DATA-04. The window is the claim's scope, so it travels with the
        // number rather than sitting in a constant a reader has to find.
        `Hazard pressure counts alerts within ${recencyDays} days: ${stale.length} in-radius alert(s) older than that were set aside as history, so a district with a long archive scores on its current weather rather than on how much history was ingested.${undated ? ` ${undated} counted alert(s) carry no usable date and are kept — unknown age is not old age, but the record cannot vouch for them.` : ''}`,
      ].filter(Boolean).join(' '),
    }
  })
}

export function computeClimateConflictRisk(data, options = {}) {
  const regions = collectRegions(data, options)
  // Same clock and same window as the flood scorer above. The two are separate
  // parameters rather than one shared option because they answer different
  // questions — but the *rule* is one rule, which is why it is one helper.
  const now = options.now ?? new Date()
  const recencyDays = options.hazardRecencyDays ?? DEFAULT_HAZARD_RECENCY_DAYS
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    // DATA-04's second instance, found by the same argument ENH-45 used for
    // VER-01: the flood scorer was fixed and this one, in the same module,
    // summed the same collection the same way. An archived earthquake counted
    // toward present climate-conflict risk exactly as a live one did.
    const inRadius = nearby(data.hazard_events, region, 250)
    const { current: hazards, stale, undated } = splitByRecency(inRadius, now, recencyDays)
    const conflicts = nearby(data.conflict_events, region, 125)
    const serviceAssets = nearby(data.service_assets, region, 75)
    // The mean of the readings, not their sum — the same defect VER-01 fixed in
    // the flood scorer, live here until ENH-45's gate found it.
    //
    // `nearby` collects every climate observation within 125 km and each one is
    // a *point* total, so adding them added the same storm once per station and
    // this term measured sensor density rather than rainfall. That the flood
    // path was fixed and this one was not is the argument for a registry rather
    // than a third fix: the two lines sat in the same module.
    //
    // The registry says `precipitation_mm` is intensive along the space axis
    // and extensive along time; this is the space axis.
    //
    // The presence check is spelled out rather than left to `Number.isFinite(
    // Number(…))`, which is `true` for `null` — `Number(null)` is 0 — and would
    // therefore read every CHIRPS raster listing as a measured dry day. That
    // coercion is the first version of this guard and it looked like it worked;
    // `test/climate-coverage-honesty.test.js:124` exists because of it, and it
    // caught this exact regression when the mean was written.
    // ENH-47. Same period axis as the flood scorer above, and the same reason:
    // the records carry the field, the records declare the period, and a mean
    // over two declared periods describes neither. `rainfall` keeps the records
    // so `meanMeasured` can read each one's period.
    const rainfall = climate
      .filter((item) => item.precipitation_mm !== null
        && item.precipitation_mm !== undefined
        && item.precipitation_mm !== '')
      .map((item) => ({ ...item, precipitation_mm: Number(item.precipitation_mm) }))
      .filter((item) => Number.isFinite(item.precipitation_mm))
    const rainfallMean = meanMeasured(rainfall, 'precipitation_mm')
    const meanRainfall = rainfallMean.mean ?? 0
    // The cap stays where it was. The term's scale is unchanged for a region
    // with one station, and a region with many now reads the weather rather
    // than the count — which is the point, and is why the *value* of a score
    // can move. A change in what a published number means is recorded here
    // rather than made silently.
    const climatePressure = Math.min(35, meanRainfall)
    // How many climate observations actually carried a rainfall number. Every
    // CHIRPS record has `precipitation_mm: null` by construction — the connector
    // reports which rasters exist, not what fell — and open-meteo-flood does the
    // same. Counting them in the confidence vector gave a region full climate
    // coverage credit for observations that contributed nothing to the score
    // above, and `confidence` is what the p10/p90 band is drawn from.
    const climateWithRainfall = rainfall.length
    const hazardPressure = Math.min(25, hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 12, 0))
    // `Number(event.fatalities || 0)` is a presence check that passes for every
    // absence. `''`, `'  '`, `false`, `[]` and `null` all coerce to 0 and are the
    // right answer for them — a conflict event with no death toll recorded is not
    // a zero-toll event, but 0 is what the term contributes either way. What it
    // does *not* survive is text that is not a number at all: `Number('12 dead')`
    // is NaN, `Math.min(30, NaN)` is NaN, and the whole district's score, its
    // p10/p90 band and `honesty.value` became NaN — which `JSON.stringify`
    // renders as `null` on the wire and `riskLevel(NaN)` grades `low`. A licensed
    // ACLED export with one malformed fatalities cell published a district as
    // "low climate-conflict risk" with a null score, and the service-impact
    // scorer downstream of it copied the NaN onto every asset in radius.
    //
    // Absent and unparseable are both "no toll recorded", so both contribute the
    // 4-point base and neither can poison the sum.
    const conflictPressure = Math.min(30, conflicts.reduce(
      (sum, event) => sum + 4 + (numericOrNull(event.fatalities) ?? 0) * 0.8,
      0,
    ))
    const servicePressure = Math.min(10, serviceAssets.length * 1.5)
    const score = clamp(Math.round(climatePressure + hazardPressure + conflictPressure + servicePressure), 0, 100)
    const confidence = confidenceScore([
      { count: climateWithRainfall, weight: 30 },
      { count: hazards.length, weight: 25 },
      { count: conflicts.length, weight: 30 },
      { count: serviceAssets.length, weight: 15 },
    ])

    // Sensitivity band, not a probabilistic interval. See the note in
    // computeFloodRisk: the width reflects input coverage, not uncertainty.
    const halfWidth = Math.round((100 - confidence) * 0.4)
    const score_p50 = score
    const score_p10 = clamp(score - halfWidth, 0, 100)
    const score_p90 = clamp(score + halfWidth, 0, 100)
    const interval_width = score_p90 - score_p10
    const generated_at = new Date().toISOString()

    return {
      id: stableId('risk', ['climate_conflict', region.key]),
      type: 'climate_conflict_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      sensitivity_low: score_p10,
      sensitivity_mid: score_p50,
      sensitivity_high: score_p90,
      sensitivity_width: interval_width,
      score_p10,
      score_p50,
      score_p90,
      interval_width,
      calibrated_uncertainty: false,
      risk_level: riskLevel(score),
      confidence,
      generated_at,
      drivers: {
        climate_observations: climate.length,
        hazard_events: hazards.length,
        // DATA-04, same naming as the flood scorer.
        hazard_events_stale: stale.length,
        hazard_events_undated: undated,
        hazard_recency_days: recencyDays,
        conflict_events: conflicts.length,
        nearby_service_assets: serviceAssets.length,
      },
      methodology: `Transparent baseline: climate stress + hazard pressure (within ${recencyDays} days) + user-supplied or licensed conflict events + exposed service assets.`,
      limits: `Weighted sum of input counts and severities, with a sensitivity band driven by input coverage rather than a calibrated predictive distribution. A zero band means inputs were sufficient, not that the outcome is certain. Hazard pressure counts alerts within ${recencyDays} days: ${stale.length} in-radius alert(s) older than that were set aside as history, so an archive backfill does not raise a present-tense score.${undated ? ` ${undated} counted alert(s) carry no usable date and are kept, because unknown age is not old age.` : ''}`,
      uncertainty: uncertaintyTiers({
        coverage: [
          'the causal direction between climate stress and conflict: both are counted, neither is claimed to cause the other',
          'conflict-event coverage, which follows reporting access and is not uniform across the region set',
          'the sensitivity band above, which is drawn from input coverage and is not a predictive interval',
        ],
      }),
      honesty: honestyEnvelope('climate_conflict_risk_score', {
        value: score,
        basis: {
          description: `climate stress (max 35) + hazard pressure (max 25) + conflict pressure (max 30) + exposed service assets (max 10), from ${climateWithRainfall} of ${climate.length} climate observation(s) carrying rainfall, ${hazards.length} current hazard event(s) within ${recencyDays} days, ${conflicts.length} conflict event(s), ${serviceAssets.length} nearby asset(s)`,
          sample: {
            climate_observations_with_rainfall: climateWithRainfall,
            climate_observations_in_scope: climate.length,
            hazard_events: hazards.length,
            hazard_events_stale: stale.length,
            hazard_events_undated: undated,
            conflict_events: conflicts.length,
            nearby_service_assets: serviceAssets.length,
          },
        },
        notIncluded: [
          'a causal claim linking climate stress to conflict; both terms are counted side by side and no mechanism is modelled',
          'demographic attribution: the score says nothing about which population is exposed',
          'the sensitivity band, which reflects input coverage rather than a calibrated outcome distribution',
        ],
        evidence: { retrieved_at: generated_at },
        refused: climate.length > climateWithRainfall
          ? [`${climate.length - climateWithRainfall} of ${climate.length} in-scope climate observations carry no rainfall figure and contributed nothing to the climate term`]
          : [],
      }),
    }
  })
}

/**
 * ENH-56 — the joint risk of flood and conflict meeting in one region.
 *
 * The two independent scorers answer "how wet" and "how tense" separately, and a
 * planner combining them by adding or maximising assumes they are independent.
 * This is the same two hazards over the same region, counted jointly over
 * calendar months, with the lift over independence stated. See
 * `src/compound-hazard.js` for why the dependence is empirical and what the
 * module refuses to do when the record is too thin.
 *
 * It is deliberately a *separate* risk type rather than folded into either
 * scorer: a compound score answers a question neither of them asks, and
 * replacing one of them with it would lose the marginal a reader may want.
 */
export function computeCompoundHazardRisk(data, options = {}) {
  const regions = collectRegions(data, options)
  const generated_at = new Date().toISOString()
  return regions.map((region) => {
    // Both hazards within the same radius, so "the region had a flood-month and
    // a conflict-month" is about one place rather than two ends of a country.
    const hazards = nearby(data.hazard_events, region, 250)
    const conflicts = nearby(data.conflict_events, region, 125)
    const result = compoundHazardScore({ hazardEvents: hazards, conflictEvents: conflicts, region: region.name })
    return {
      id: stableId('risk', ['compound_hazard_risk', region.key]),
      type: 'compound_hazard_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score: result.score,
      level: result.level,
      generated_at,
      drivers: {
        flood_months: result.contingency.flood_months,
        conflict_months: result.contingency.conflict_months,
        both_months: result.contingency.both_months,
        months_of_record: result.contingency.months,
        lift_over_independence: result.contingency.lift,
      },
      honesty: honestyEnvelope('compound_hazard_risk', {
        value: result.score,
        basis: result.basis || {
          description: `a joint rate needs at least ${MIN_COMPOUND_MONTHS} months of record in this region`,
          sample: { months_of_record: result.contingency.months },
        },
        refused: result.reason ? [result.reason] : [],
        notIncluded: [
          'a fitted dependence model — the joint rate is counted, not estimated, so it carries no probabilistic interval',
          'consecutive months treated as independent draws; they share a season, so the window is stated rather than assumed representative',
        ],
        evidence: { retrieved_at: generated_at },
      }),
    }
  })
}

export function computeServiceImpacts(data, riskScores) {
  const floodRisks = riskScores.filter((risk) => risk.type === 'flood_risk')
  const conflictRisks = riskScores.filter((risk) => risk.type === 'climate_conflict_risk')
  const assessments = []
  for (const asset of data.service_assets) {
    const assetPoint = { latitude: asset.latitude, longitude: asset.longitude }
    const nearestFlood = nearest(floodRisks, assetPoint)
    const nearestConflict = nearest(conflictRisks, assetPoint)
    // A borrowed score is read the same way the asset's own numbers are: a
    // number, or nothing. `nearestFlood.item.score` passed straight into the
    // weighted sum, so an unreadable upstream score — `undefined`, `NaN`, a
    // string that is not a number — made `score` NaN, `JSON.stringify` published
    // it as `null`, `riskLevel(NaN)` graded the asset `low`, and
    // `recommendedActions` returned nothing. Every asset within 150 km of one bad
    // region score lost its assessment.
    //
    // Unreadable is not the same as zero, and the row must not say it is: the
    // `*_in_radius` flags and the honesty envelope's `refused` list carry the
    // difference, because a genuine 0 from a nearby region and a score nobody
    // could read both contribute 0 to the arithmetic and only one of them is a
    // finding.
    const floodInRadius = Boolean(nearestFlood && nearestFlood.distance_km <= 150)
    const conflictInRadius = Boolean(nearestConflict && nearestConflict.distance_km <= 150)
    const floodBorrowed = floodInRadius ? numericOrNull(nearestFlood.item.score) : null
    const conflictBorrowed = conflictInRadius ? numericOrNull(nearestConflict.item.score) : null
    const floodScore = floodBorrowed ?? 0
    const conflictScore = conflictBorrowed ?? 0
    const score = clamp(Math.round(floodScore * 0.55 + conflictScore * 0.45), 0, 100)
    // Only the regions actually inside the borrowing radius have a confidence to
    // report. `|| 0` turned an absent reading into "certain the risk is zero",
    // and a hazard nobody scored read as the most confident statement on the
    // record. Weights renormalise over the terms that contributed, so an asset
    // with flood cover and no conflict cover reports the flood confidence rather
    // than that number halved. No contributor at all is null, not 0.
    const contributors = [
      { weight: 0.55, confidence: nearestFlood && nearestFlood.distance_km <= 150 ? toNumber(nearestFlood.item.confidence) : null },
      { weight: 0.45, confidence: nearestConflict && nearestConflict.distance_km <= 150 ? toNumber(nearestConflict.item.confidence) : null },
    ].filter((term) => term.confidence !== null)
    const contributorWeight = contributors.reduce((sum, term) => sum + term.weight, 0)
    const confidence = contributorWeight > 0
      ? Math.round(contributors.reduce((sum, term) => sum + term.confidence * term.weight, 0) / contributorWeight)
      : null
    const generated_at = new Date().toISOString()
    assessments.push({
      // Keyed on the asset, not on the score. `stableId('impact', [asset.id, score])`
      // made the id a function of the value it carries, so a moved score produced
      // a *different row* rather than an update: the store held both, the ledger
      // saw a first sight on each side of every comparison and could never
      // reconcile the family, and nothing that joins an impact to its history —
      // bitemporal, replay, the reconciliation ledger — could follow one asset
      // across a refresh. An identity that changes when the number does is not an
      // identity.
      id: stableId('impact', [asset.id]),
      asset_id: asset.id,
      asset_name: asset.name,
      service_type: asset.service_type,
      country: asset.country,
      // The asset's own district, carried so the row's declared inputs can be
      // counted over somewhere that exists. Without it the count is taken over
      // `impact_<hash>` — a name no record in the store carries — and every input
      // reads zero, which is a measurement that cannot move.
      district: asset.admin1 || asset.district || null,
      latitude: asset.latitude,
      longitude: asset.longitude,
      impact_score: score,
      impact_level: riskLevel(score),
      confidence,
      generated_at,
      drivers: {
        nearest_flood_risk: nearestFlood?.item?.region_name || null,
        nearest_climate_conflict_risk: nearestConflict?.item?.region_name || null,
        // Distance to the region the score was borrowed from, and whether that
        // region was inside the 150 km borrowing radius. A zero contribution
        // from a hazard score is either "no nearby risk" or "the nearest region
        // is too far to borrow from", and those read identically above.
        nearest_flood_risk_km: nearestFlood ? Math.round(nearestFlood.distance_km * 10) / 10 : null,
        nearest_conflict_risk_km: nearestConflict ? Math.round(nearestConflict.distance_km * 10) / 10 : null,
        flood_risk_in_radius: floodInRadius,
        conflict_risk_in_radius: conflictInRadius,
        // A region inside the radius whose score could not be read. Without this
        // the asset's zero contribution is indistinguishable from a region that
        // scored a genuine zero, and the envelope's `refused` list names it in
        // words so the difference survives the wire.
        flood_risk_unreadable: floodInRadius && floodBorrowed === null,
        conflict_risk_unreadable: conflictInRadius && conflictBorrowed === null,
      },
      recommended_actions: recommendedActions(asset.service_type, score),
      uncertainty: uncertaintyTiers({
        coverage: [
          'service continuity itself: nothing here observes roads, staffing, stock or whether a service is actually running',
          'the number of people affected — the asset carries no served population on this record',
          'timing: a score is a snapshot, and the hazard it points at has no duration attached',
        ],
      }),
      honesty: honestyEnvelope('service_impact_score', {
        value: score,
        basis: {
          description: `nearest flood_risk score x 0.55 + nearest climate_conflict_risk score x 0.45, each borrowed only from a region within 150 km of the asset`,
          sample: {
            flood_risk_region: nearestFlood?.item?.region_name || null,
            flood_risk_km: nearestFlood ? Math.round(nearestFlood.distance_km * 10) / 10 : null,
            conflict_risk_region: nearestConflict?.item?.region_name || null,
            conflict_risk_km: nearestConflict ? Math.round(nearestConflict.distance_km * 10) / 10 : null,
          },
        },
        notIncluded: [
          'any observation of the service: no asset condition, no road passability, no stock level',
          'population served, which lives on the asset record and is not folded into this score',
          'the sensitivity bands of the borrowed region scores, which are not propagated here',
        ],
        evidence: { retrieved_at: generated_at },
        refused: [
          ...(nearestFlood && nearestFlood.distance_km > 150
            ? [`the nearest flood risk region is ${Math.round(nearestFlood.distance_km)} km away, beyond the 150 km borrowing radius, so its score contributed 0 rather than a small amount`]
            : []),
          ...(nearestConflict && nearestConflict.distance_km > 150
            ? [`the nearest climate-conflict region is ${Math.round(nearestConflict.distance_km)} km away, beyond the 150 km borrowing radius, so its score contributed 0 rather than a small amount`]
            : []),
          ...(floodInRadius && floodBorrowed === null
            ? [`the nearest flood risk region is ${Math.round(nearestFlood.distance_km)} km away but its score is not a number, so it contributed 0 as an unreadable input rather than as a measured zero`]
            : []),
          ...(conflictInRadius && conflictBorrowed === null
            ? [`the nearest climate-conflict region is ${Math.round(nearestConflict.distance_km)} km away but its score is not a number, so it contributed 0 as an unreadable input rather than as a measured zero`]
            : []),
          ...(nearestFlood || nearestConflict ? [] : ['no scored region lies within 150 km of this asset, so the score is 0 for lack of nearby evidence rather than for lack of risk']),
        ],
      }),
    })
  }
  return assessments
}

/**
 * A mean that survives the units it is given.
 *
 * `Math.round(sum / n)` over a 0-1 quantity returns 0 or 1 and nothing else, so
 * a source whose model reports 0.82 confidence reported a mean of 1, and one
 * reporting 0.4 reported 0 — the number was not imprecise, it was meaningless.
 * Rounded to two decimals it is readable; `null` when there was nothing to
 * average, because no mean is not a mean of zero.
 */
const mean2dp = (sum, count) => (count > 0 ? Math.round((sum / count) * 100) / 100 : null)

/** The same mean as a 0-100 percentage, for display beside other percentages. */
const asPct = (value) => (value === null ? null : Math.round(value * 100))

export function calibrationReport(data) {
  const byType = new Map()
  for (const score of data.risk_scores || []) {
    const type = score.type
    if (!byType.has(type)) {
      byType.set(type, {
        type,
        count: 0,
        total_score: 0,
        total_confidence: 0,
        total_interval_width: 0,
        // A separate divisor per quantity, because the three do not always
        // arrive together. A record can carry a score and no model confidence,
        // and averaging its absence in as a zero reported a confident model as
        // a mediocre one — the same defect `computeDataQuality` fixed one
        // function down, where the mean is now taken over the rows that carry
        // the value and the count is published beside it.
        scored_count: 0,
        confident_count: 0,
        interval_count: 0,
      })
    }
    const item = byType.get(type)
    item.count += 1
    const value = numericOrNull(score.score)
    const confidence = numericOrNull(score.confidence)
    const intervalWidth = numericOrNull(score.interval_width)
    if (value !== null) { item.total_score += value; item.scored_count += 1 }
    if (confidence !== null) { item.total_confidence += confidence; item.confident_count += 1 }
    if (intervalWidth !== null) { item.total_interval_width += intervalWidth; item.interval_count += 1 }
  }

  return [...byType.values()].map((item) => ({
    type: item.type,
    count: item.count,
    // Each mean is over the records that carry that quantity, and each carries
    // its own count so a reader can tell 0.8 over four records from 0.8 over
    // one. A mean of nothing is null, not zero.
    mean_score: item.scored_count > 0 ? Math.round(item.total_score / item.scored_count) : null,
    scored_count: item.scored_count,
    // Record confidence and interval width are 0-1 and 0-100 respectively;
    // rounding a 0-1 mean to an integer left it able to hold only 0 or 1.
    mean_confidence: mean2dp(item.total_confidence, item.confident_count),
    mean_confidence_pct: asPct(mean2dp(item.total_confidence, item.confident_count)),
    confident_count: item.confident_count,
    mean_interval_width: mean2dp(item.total_interval_width, item.interval_count),
    interval_count: item.interval_count,
    brier_score: null,
    uncertainty: uncertaintyTiers({
      coverage: [
        'skill of the underlying model: these are averages of stored records, not a validation',
        'the variance between regions — two regions with the same mean can differ entirely',
        'the districts that were not scored at all, because the risk surface is bounded to the operational area',
      ],
    }),
    honesty: honestyEnvelope('calibration_summary', {
      // The same divisor the printed mean uses. These were both `item.count`,
      // so the envelope's `value` disagreed with the `mean_score` beside it on
      // any type holding a record with no score.
      value: item.scored_count > 0 ? Math.round(item.total_score / item.scored_count) : null,
      basis: {
        description: `arithmetic mean over ${item.scored_count} scored ${item.type} record(s) of ${item.count} stored`,
        sample: { records_averaged: item.scored_count, records_stored: item.count, record_type: item.type },
      },
      notIncluded: [
        'any comparison against observed outcomes; brier_score stays null because nothing joins these records to what happened',
        'the spread across regions behind the mean',
      ],
      refused: [
        'brier_score is withheld: this summary reads stored scores and has no outcome labels to score them against, and a null is not a poor score, it is an absent measurement',
      ],
    }),
  }))
}

export function computeDataQuality(data) {
  const collections = {
    climate_observations: data.climate_observations,
    hazard_events: data.hazard_events,
    conflict_events: data.conflict_events,
    service_assets: data.service_assets,
    food_security_records: data.food_security_records,
    disease_observations: data.disease_observations,
  }
  const bySource = new Map()
  for (const [collection, records] of Object.entries(collections)) {
    for (const record of records || []) {
      const source = record.source || 'operator'
      if (!bySource.has(source)) {
        bySource.set(source, {
          id: `quality_${source}`,
          source,
          records_by_collection: {},
          total_records: 0,
          geocoded_records: 0,
          latest_record_at: null,
          confidence_sum: 0,
          confidence_count: 0,
        })
      }
      const quality = bySource.get(source)
      quality.records_by_collection[collection] = (quality.records_by_collection[collection] || 0) + 1
      quality.total_records += 1
      // Only computed records carry a model confidence. Raw source rows do not,
      // and counting their absence as zero would drag the mean down for a source
      // whose model has not run.
      if (Number.isFinite(record.confidence)) {
        quality.confidence_sum += record.confidence
        quality.confidence_count += 1
      }
      if (Number.isFinite(record.latitude) && Number.isFinite(record.longitude)) quality.geocoded_records += 1
      quality.latest_record_at = latestDate(quality.latest_record_at, record.observed_at || record.occurred_at || record.updated_at || record.generated_at)
    }
  }

  for (const run of data.source_runs || []) {
    const source = run.source || 'unknown'
    if (!bySource.has(source)) {
      bySource.set(source, {
        id: `quality_${source}`,
        source,
        records_by_collection: {},
        total_records: 0,
        geocoded_records: 0,
        latest_record_at: null,
        confidence_sum: 0,
        confidence_count: 0,
      })
    }
    const quality = bySource.get(source)
    quality.last_run_status = run.status
    quality.last_run_at = latestDate(quality.last_run_at, run.completed_at)
    quality.error_count = (quality.error_count || 0) + (run.errors?.length || 0)
  }

  return [...bySource.values()].map((quality) => {
    const geocodeCoverage = quality.total_records ? quality.geocoded_records / quality.total_records : 0
    const runPenalty = quality.last_run_status === 'failed' ? 35 : quality.last_run_status === 'degraded' ? 15 : 0
    const freshnessPenalty = freshnessPenaltyFor(quality.latest_record_at || quality.last_run_at)
    const confidence = clamp(Math.round(geocodeCoverage * 55 + Math.min(quality.total_records, 25) * 1.8 - runPenalty - freshnessPenalty), 0, 100)
    const updated_at = new Date().toISOString()
    // Null, not zero, when no record carried a confidence. `confidence_sum` was
    // initialised and read here but never incremented anywhere, so this divided
    // zero by the record count and reported 0 for every source — a confident
    // "we have no confidence in any of this" for sources whose models were
    // simply not part of this pass.
    const mean_confidence = mean2dp(quality.confidence_sum, quality.confidence_count)
    return {
      ...quality,
      geocode_coverage_pct: Math.round(geocodeCoverage * 100),
      // Beside `confidence` and `geocode_coverage_pct`, both 0-100, a bare
      // 0-1 fraction invites the reader to compare it with the wrong scale.
      mean_confidence_pct: asPct(mean_confidence),
      freshness: freshnessLabel(quality.latest_record_at || quality.last_run_at),
      confidence,
      mean_confidence,
      updated_at,
      uncertainty: uncertaintyTiers({
        coverage: [
          'accuracy: nothing here compares a source against ground truth, only against itself',
          'correctness of the values: a source can be perfectly geocoded, fresh and wrong',
          'representativeness: a source that reports only severe events scores as complete',
          'cross-source agreement, which is measured elsewhere rather than here',
        ],
      }),
      honesty: honestyEnvelope('data_quality_confidence', {
        value: confidence,
        basis: {
          description: `geocode coverage x 55 + min(records, 25) x 1.8 - run penalty (${runPenalty}) - freshness penalty (${freshnessPenalty}), clamped 0-100`,
          sample: {
            total_records: quality.total_records,
            geocoded_records: quality.geocoded_records,
            records_with_a_model_confidence: quality.confidence_count,
          },
        },
        notIncluded: [
          'any check of whether the reported values are correct — this is a completeness and hygiene score',
          'agreement with other sources covering the same period',
          'whether the source\'s own upstream pipeline failed silently and reported no rows at all',
        ],
        evidence: { retrieved_at: updated_at },
        refused: quality.confidence_count === 0
          ? ['no record from this source carried a model confidence, so mean_confidence is null rather than 0']
          : [],
      }),
    }
  }).sort((a, b) => b.confidence - a.confidence)
}

/**
 * Regions to score.
 *
 * Every record with coordinates used to become a region, so a global alert feed
 * defined the analytical surface: after a live GDACS pull the console computed
 * risk for 87 regions across 25 countries, 82 of them outside the area the
 * platform operates in. The risk surface then said nothing about the five
 * pilot districts, because it was 94% other places.
 *
 * Regions are now bounded to the operational area, using the same anchor the
 * map framing uses. Records outside it are still ingested, still stored, and
 * still drawn on the map — they simply do not generate risk scores for an
 * operator who is not working there.
 *
 * `options.scope` can widen or narrow this. With no scope, the Horn of Africa
 * pilot area is used.
 */
const RISK_SCOPE = Object.freeze({
  minLat: -6,
  maxLat: 15,
  minLon: 27,
  maxLon: 52,
  marginDeg: 6,
})

function inRiskScope(point, scope) {
  return point.latitude >= scope.minLat - scope.marginDeg
    && point.latitude <= scope.maxLat + scope.marginDeg
    && point.longitude >= scope.minLon - scope.marginDeg
    && point.longitude <= scope.maxLon + scope.marginDeg
}

function collectRegions(data, options = {}) {
  const scope = options.scope || RISK_SCOPE
  const points = [
    ...data.climate_observations,
    ...data.hazard_events,
    ...data.conflict_events,
    ...data.service_assets,
  ].filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
    .filter((item) => inRiskScope(item, scope))

  const byKey = new Map()
  for (const point of points) {
    // Group by the district the point falls in, falling back to a half-degree
    // cell (~55 km) where no district claims it.
    //
    // The key used to be `${Math.round(lat)}:${Math.round(lon)}` — a 1°x1° bucket
    // about 111 km on a side. Two counties 100 km apart collapsed into one region
    // whose coordinate was whichever point arrived first, and a district
    // straddling a boundary split into two half-regions each scored against part
    // of its data. `resolveDistrict` already carries the curated centroids and
    // radii; the fallback cell is a half-degree because that is the finest
    // bucket that still groups a cluster of stations around one town.
    // `KNOWN_DISTRICTS` centres are `{lat, lon}`; `haversineKm` reads
    // `.latitude`/`.longitude`, so the centre is normalised rather than passed
    // through. Handing it the raw centre yields NaN and every point silently
    // falls through to the fallback cell.
    // The nearest district whose radius covers the point, not the first one in
    // the list. The radii overlap — Turkana's and Karamoja's 200 km circles
    // share a wide band, and the district page already reports 17 of 34 assets
    // falling inside both — so "first match" handed a point to whichever district
    // happened to be declared first, which is arbitrary. Nearest is a rule a
    // reader can predict.
    //
    // `KNOWN_DISTRICTS` centres are `{lat, lon}`; `haversineKm` reads
    // `.latitude`/`.longitude`, so the centre is normalised rather than passed
    // through. Handing it the raw centre yields NaN and every point silently
    // falls through to the fallback cell.
    let known = null
    let knownKm = Infinity
    for (const district of KNOWN_DISTRICTS) {
      const km = haversineKm({ latitude: district.center.lat, longitude: district.center.lon }, point)
      if (km <= district.radius_km && km < knownKm) {
        known = district
        knownKm = km
      }
    }
    const roundedLat = Math.round(point.latitude * 2) / 2
    const roundedLon = Math.round(point.longitude * 2) / 2
    const key = known
      ? `district:${known.slug}`
      : `${point.country || 'unknown'}:${roundedLat}:${roundedLon}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: known
          ? known.name
          : (point.region_name || point.admin1 || point.country || `${roundedLat},${roundedLon}`),
        country: known ? known.country : (point.country || null),
        latitude: point.latitude,
        longitude: point.longitude,
      })
    }
  }
  return [...byKey.values()]
}

function nearby(records, point, radiusKm) {
  return records.filter((record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude) && haversineKm(point, record) <= radiusKm)
}

/**
 * How long a hazard alert speaks about *current* risk.
 *
 * DATA-04. `hazards` used to be every flood/storm/disaster alert within 250 km
 * whatever its date, so the hazard term measured how much history had been
 * ingested rather than what the weather was doing. `gdacs-archive` backfills
 * historical floods; importing it raised every covered district toward 100 with
 * no change in conditions, and four 2019 floods scored exactly what four from
 * this week scored. A risk score is a statement about now, so an alert older
 * than its window is evidence about the district's history, not its present.
 *
 * Seven days is `road-access.js`'s flood window, for the same physical reason
 * it states there: standing water recedes within days. The window is a
 * parameter rather than a literal so the rule can be tested without waiting for
 * time to pass — the same argument `computeRoadAccess` makes for `options.now`.
 */
const DEFAULT_HAZARD_RECENCY_DAYS = 7

/**
 * Split hazards into the ones that speak about the present and the ones that do
 * not. Returns `{ current, stale, undated }`.
 *
 * `current` is what a present-tense score may count. `stale` is history — still
 * evidence about the district, no longer evidence about now, and counted so the
 * record can say how much of its input it set aside.
 *
 * `undated` records are *inside* `current`, deliberately. An absent or
 * unparseable date is unknown age, not old age, and `road-access.js` already
 * settled this direction: an undated hazard is not safe to dismiss. Dropping it
 * would lower the score on missing evidence, which is the one direction a risk
 * score must not fail. It is returned separately so the payload can name how
 * many of its inputs carry no date, rather than presenting an unknown-age record
 * as a current one without saying so.
 *
 * A future-dated alert is a forecast, and a forecast is about the present, so
 * `ageDays <= windowDays` keeps it.
 */
function splitByRecency(hazards, now, windowDays) {
  const current = []
  const stale = []
  let undated = 0
  for (const hazard of hazards) {
    const occurred = hazard.occurred_at ? Date.parse(hazard.occurred_at) : NaN
    if (!Number.isFinite(occurred)) {
      current.push(hazard)
      undated += 1
      continue
    }
    if ((now.getTime() - occurred) / 86_400_000 <= windowDays) current.push(hazard)
    else stale.push(hazard)
  }
  return { current, stale, undated }
}

function nearest(records, point) {
  let best = null
  for (const item of records) {
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue
    const distance_km = haversineKm(point, item)
    if (!best || distance_km < best.distance_km) best = { item, distance_km }
  }
  return best
}

function recommendedActions(serviceType, score) {
  if (score >= 80) return [`Activate continuity plan for ${serviceType}`, 'Validate access routes', 'Pre-position contingency supplies']
  if (score >= 60) return [`Monitor ${serviceType} service continuity`, 'Confirm backup providers', 'Review flood and security access constraints']
  if (score >= 35) return ['Maintain routine monitoring', 'Check source freshness before operational decisions']
  return ['No immediate action beyond periodic monitoring']
}

function confidenceScore(parts) {
  return clamp(Math.round(parts.reduce((sum, part) => sum + (part.count > 0 ? part.weight : 0), 0)), 0, 100)
}

function latestDate(current, candidate) {
  if (!candidate) return current || null
  if (!current) return new Date(candidate).toISOString()
  const currentMs = Date.parse(current)
  const candidateMs = Date.parse(candidate)
  if (!Number.isFinite(candidateMs)) return current
  return candidateMs > currentMs ? new Date(candidateMs).toISOString() : current
}

function freshnessPenaltyFor(value) {
  if (!value) return 30
  const ageDays = (Date.now() - Date.parse(value)) / 86400000
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0
  if (ageDays <= 2) return 0
  if (ageDays <= 14) return 10
  if (ageDays <= 45) return 20
  return 30
}

function freshnessLabel(value) {
  if (!value) return 'unknown'
  const ageDays = (Date.now() - Date.parse(value)) / 86400000
  if (!Number.isFinite(ageDays) || ageDays < 0) return 'current'
  if (ageDays <= 2) return 'current'
  if (ageDays <= 14) return 'recent'
  if (ageDays <= 45) return 'stale'
  return 'expired'
}
