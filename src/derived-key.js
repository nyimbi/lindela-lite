/**
 * R-77 — the derived-row key, in a leaf module.
 *
 * `placeOf`, `derivedKey` and `NUMERIC_VALUE_FIELDS` lived in
 * `src/analytics.js` and were imported back by `src/reconciliation.js:52`,
 * which `analytics.js` imports in turn — the fourth import cycle in `src/`
 * and the one the R-77 entry never named (it listed three). The same class, so
 * the same fix: these are pure functions over a record and a list of field
 * names, with no imports of their own, so a leaf module costs nothing.
 *
 * `districtOf` stays in `analytics.js` — it is used only there, and the two
 * answer different questions. See the comment beside `placeOf` for why, and
 * note that the first draft of this leaf moved it anyway: a move is the set of
 * bindings whose *readers* moved with them, not a contiguous range of lines.
 *
 * `src/analytics.js` re-exports all three, so `src/replay.js`,
 * `src/reconciliation.js` and any existing importer keep working unchanged.
 */
/**
 * The place a record is about.
 *
 * `asset_id` sits before `id` because an impact row's `id` is
 * `stableId('impact', [asset.id, score])` — it *contains the score*, so the id
 * is a different string every time the score moves. Keying on it made a changed
 * impact indistinguishable from a brand-new one: the ledger saw
 * `no_prior_observation` on both sides of every comparison and could never
 * reconcile the family at all. It also made `inputDigestFor` count records in a
 * district named `impact_7efd5b04…`, which no record carries, so every declared
 * input came back zero and the row claimed nothing had moved whatever did.
 *
 * The asset id is stable across a score change, which is what a key needs to be.
 * A row with neither still falls back to `id`, and a collection whose records
 * carry no place at all keys degenerately — which `replay.js` already handles by
 * refusing to pair on a colliding key rather than mispairing.
 */
// Exported so `src/analytics.js` shares this copy rather than keeping a second
// one: it uses `placeOf` directly at two sites, and two copies of an identity
// function is the drift this module was created to stop. Not re-exported from
// `analytics.js`, so the public surface of that module is unchanged.
export function placeOf(record) {
  return record.region || record.region_name || record.asset_id || record.district || record.id || null
}

/**
 * The district a record's inputs are counted over.
 *
 * Separate from `placeOf` because the two answer different questions and only
 * coincided while every derived row carried a `region_name`. Identity has to be
 * stable under a value change (hence `asset_id` for an impact); the input count
 * has to name somewhere records actually live (hence the district). For an
 * impact row the asset's `admin1` is the second and the asset id is the first,
 * and using one for the other is how the counts came back all zero.
 *
 * It lives in `src/analytics.js`, not here, and this comment is where it is
 * documented because `placeOf` is its other half. It has exactly one reader —
 * `refreshAnalytics`'s impact branch — and that reader is in the module it
 * stayed in, so moving it here would export a name nothing outside reads. The
 * first draft of this leaf swept it in with the contiguous block; the move is
 * the set of bindings whose *readers* moved, not a range of lines, and
 * `districtOf`'s reader did not move.
 */

export function derivedKey(collection, record) {
  return `${collection}:${record.type || 'score'}:${placeOf(record)}`
}

/**
 * The numeric fields a derived row may publish its value under, most specific
 * first.
 *
 * Exported because `src/reconciliation.js` compares the same rows and had its own
 * copy of this list — the same five entries, one of them a label, drifting the
 * moment either module gained a family. `derivedKey` is already shared between
 * the two for exactly this reason; this is the second half of the same argument,
 * and a caller that picked a different field would key a number one way and
 * compare it another.
 *
 * Numeric only. A label is not a value: `impact_level: 'medium'` is a band, and
 * comparing bands reports a score that moved 54 → 55 as holding. The sentinel
 * `'unknown'` a refusal carries is the same mistake with a worse consequence —
 * it makes a number that was never computed look like a number that moved.
 */
export const NUMERIC_VALUE_FIELDS = Object.freeze(['score', 'risk_score', 'impact_score', 'value'])
