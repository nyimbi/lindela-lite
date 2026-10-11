/**
 * ENH-72 — every ranked list states its arithmetic.
 *
 * `viz-explain.js` answers "where did this score come from" for a single record.
 * This answers the sibling question for a *list*: why is this one above that
 * one? A ranking is an argument, and a ranking that does not state its ordering
 * is an assertion — the reader can only take it or leave it, and the one thing
 * they cannot do is disagree with it on the evidence.
 *
 * The failure this prevents is quiet and common. A list ordered by
 * `created_at` looks exactly like a list ordered by severity: both are
 * descending numbers, both are plausible, and nothing on the surface says which
 * one it is. An operator who assumes severity and gets recency makes a
 * different decision than the one the product intended, and no test can catch
 * it because both orderings are correct implementations of *something*.
 *
 * **Why a registry rather than a helper.** The ordering is a property of each
 * list, not of sorting in general, so the honest thing is to declare it per
 * list — including the lists whose ordering carries no meaning and which should
 * say so rather than implying one. A helper that inferred the ordering from the
 * comparator would be a second implementation of the comparator, and the two
 * would drift the moment either changed.
 *
 * **The rule this module follows.** A ranking that uses a quantity the platform
 * cannot measure says so. `expected_loss` is a proxy (see `src/triage.js`), and
 * a list ordered by "newest" is ordered by a clock rather than by importance.
 * Both are legitimate orderings; neither may be presented as the other.
 */

/**
 * Every ranked surface, with the ordering it applies and what that ordering is
 * not entitled to claim.
 *
 * `kind` is how the ordering is produced, and it decides what the explanation
 * can honestly say:
 *
 *   `proxy`     — a real quantity, computed, and named as the proxy it is
 *   `severity`  — a declared vocabulary, ordered by the vocabulary itself
 *   `recency`   — a clock. Legitimate, and carries no information about
 *                 importance, which the `not` field has to say
 *   `priority`  — a fixed rank table, not a computed score
 */
export const RANKINGS = Object.freeze({
  'alert-events/triage': Object.freeze({
    title: 'Open alerts',
    kind: 'proxy',
    ordersBy: 'expected_loss = severity_weight × population_exposed',
    direction: 'descending',
    because: 'acting on the alert with the largest expected loss first is worth more than acting on the newest one',
    not: 'not an expected value: no hazard probability and no cost per person enters it, so it ranks alerts against each other and does not price them',
    gaps: 'an alert whose exposure cannot be measured is ranked after the measured set by severity, with expected_loss null rather than zero',
    source: 'src/triage.js',
  }),
  'risk-scores': Object.freeze({
    title: 'Risk scores',
    kind: 'proxy',
    ordersBy: 'score',
    direction: 'descending',
    because: 'the score is the module\'s own weighted index over the inputs it names in `honesty`',
    not: 'not a probability of the hazard occurring, and not comparable across the flood and climate-conflict types, which weight different inputs',
    gaps: 'a score computed from absent inputs is not distinguished by the ordering; read `honesty.refused` on the record',
    source: 'src/analytics.js',
  }),
  'data-quality': Object.freeze({
    title: 'Source data quality',
    kind: 'proxy',
    ordersBy: 'confidence',
    direction: 'descending',
    because: 'a source whose records carry less of what the platform needs is the one to fix first',
    not: 'not an accuracy measurement of the underlying data — it is a completeness heuristic over geocoding, record count, run status and record age',
    gaps: 'a source with no records at all has no confidence and sorts to the bottom rather than to the top, which is where a missing feed would belong',
    source: 'src/analytics.js',
  }),
  'district-hazards': Object.freeze({
    title: 'Hazards in a district',
    kind: 'severity',
    ordersBy: 'the severity vocabulary (critical, high, medium, low, unknown)',
    direction: 'most severe first',
    because: 'severity is the platform\'s declared grading, and it is what the alert rules threshold against',
    not: 'not a ranking by expected impact: two hazards of the same severity sort together regardless of how many people each one exposes',
    gaps: null,
    source: 'src/districts.js',
  }),
  'district-field-reports': Object.freeze({
    title: 'Field reports in a district',
    kind: 'recency',
    ordersBy: 'the report time, newest first',
    direction: 'descending',
    because: 'the window is capped, and the reports an operator opening the page wants are the recent ones rather than the first thirty inserted',
    not: 'not a ranking by importance. Nothing about a newer report makes it more worth reading; the ordering is a clock and should be read as one',
    gaps: 'a report with no parseable time sorts last, because an unknown time is not a recent one',
    source: 'src/districts.js',
  }),
})

/** The declaration for a ranked surface, or null when none is registered. */
export function rankingFor(key) {
  return RANKINGS[key] || null
}

/**
 * The explanation a ranked surface attaches to its payload.
 *
 * A surface with no registered ordering gets an honest null with a reason
 * rather than an invented one: "this list does not say why it is ordered" is a
 * true statement about it, and a fabricated rationale would be the exact defect
 * this module exists to prevent.
 */
export function explainRanking(key, { entries = null, extra = {} } = {}) {
  const rule = rankingFor(key)
  if (!rule) {
    return {
      key,
      known: false,
      reason: 'No ordering is registered for this list, so it does not state why one entry is above another. An ordering nobody declared is an ordering nobody can disagree with on the evidence.',
      ...extra,
    }
  }
  return {
    key,
    known: true,
    title: rule.title,
    kind: rule.kind,
    orders_by: rule.ordersBy,
    direction: rule.direction,
    because: rule.because,
    not: rule.not,
    gaps: rule.gaps,
    source: rule.source,
    // The entries the ordering was applied to, so a reader can check the claim
    // against the list rather than taking it on faith. Omitted when the caller
    // does not pass them, rather than defaulted to an empty array that would
    // read as "the list was empty".
    ...(Array.isArray(entries) ? { entry_count: entries.length } : {}),
    ...extra,
  }
}

/**
 * Whether a list is in the order it claims, from a key extractor.
 *
 * The ordering declaration is prose, and prose cannot be checked — so this is
 * the machine-checkable half: a surface that says it is descending by
 * `expected_loss` can be held to it. Returns `null` for a list of fewer than
 * two entries, where an ordering is not a claim anyone can test.
 */
export function isOrderedBy(entries, key, { direction = 'descending' } = {}) {
  if (!Array.isArray(entries) || entries.length < 2) return null
  const values = entries.map((entry) => comparable(typeof key === 'function' ? key(entry) : entry?.[key]))
  const measuredAt = []
  values.forEach((value, index) => { if (value !== null) measuredAt.push(index) })
  // The measured subsequence must be monotone in the declared direction ...
  for (let i = 1; i < measuredAt.length; i += 1) {
    const before = values[measuredAt[i - 1]]
    const after = values[measuredAt[i]]
    if (direction === 'descending' ? after > before : after < before) return false
  }
  // ... and every unmeasured value must sit after the last measured one. A null
  // is not a low value, so anywhere earlier is the list claiming it is more
  // important than a measured entry. A list with nothing measured has no such
  // claim to violate, which is why that case passes rather than refusing.
  const firstUnmeasuredAt = values.indexOf(null)
  const lastMeasuredAt = measuredAt[measuredAt.length - 1]
  if (firstUnmeasuredAt !== -1 && lastMeasuredAt !== undefined && firstUnmeasuredAt < lastMeasuredAt) return false
  return true
}

/**
 * A value reduced to the scalar it is ordered by, or null when it has none.
 *
 * A number is its own comparable. A string is one only when it parses as a
 * time — the recency orderings (`district-field-reports`) are over timestamps,
 * and without this the module could not check the very case its header uses to
 * motivate it: a list ordered by `created_at` looks exactly like one ordered by
 * severity, and only one of them is a claim about importance. Anything else —
 * a missing field, a non-date string, a boolean — is unmeasured, which is the
 * honest answer for a value the ordering has no purchase on.
 */
function comparable(value) {
  if (Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return null
}
