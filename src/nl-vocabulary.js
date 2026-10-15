/**
 * R-77 — the query vocabulary, in a leaf module.
 *
 * `WINDOWS`, `SUBJECTS`, `PREDICATES`, `DEFAULT_WINDOW` and
 * `NL_QUERY_VOCABULARY` lived in `src/nl-query.js`, and `src/needle.js`
 * imports them — while `nl-query.js` dynamically imports `needle.js` at
 * `parseQueryWithModel`. That is the fifth cycle in `src/`, and the one no
 * hand list found: it is reachable only through a dynamic import, so a graph
 * built from static from-clauses alone does not see it.
 * `scripts/check-import-cycles.mjs` found it on its first run against the tree.
 *
 * The vocabulary is a leaf by construction: four frozen literals and one
 * projection of them, with no imports of its own. `src/nl-query.js`
 * re-exports all five, so `test/needle.test.js` and any existing importer keep
 * their import path.
 */

// The district slugs the vocabulary projects into its `regions` list.
// `src/districts.js` reaches neither `nl-query.js` nor `needle.js`, so this
// import cannot re-close the cycle this module exists to break.
//
// `ORG_UNITS` / `ORG_UNIT_SYNONYMS` are deliberately **not** imported here.
// They were, briefly, while the extraction was in progress — copied across with
// the rest of the block because the parser's `REGION_TERMS` reads them, but
// `REGION_TERMS` is the parser's own and stayed in `nl-query.js`. Nothing in
// this module reads either name, so both were dead imports the moment the move
// settled, and `test/unused-imports.test.js` said so.
import { KNOWN_DISTRICTS } from './districts.js'

/**
 * The flood-risk score at or above which a district has "crossed the flood
 * threshold".
 *
 * Not an independent number: it is `riskLevel`'s `high` boundary in
 * `src/schema.js`, which is the function the console and the risk records
 * themselves use to name a score. The test asserts the identity
 * (`riskLevel(NL_FLOOD_THRESHOLD_SCORE) === 'high'`) so this constant cannot
 * drift from the classifier it stands for — the failure `src/model-registry.js`
 * describes when a registry retypes a model's own floor.
 *
 * It lives here rather than in `src/nl-query.js` because
 * `NL_QUERY_VOCABULARY` below projects it, and the vocabulary is this leaf.
 * `src/nl-query.js` re-exports it, so its import path is unchanged.
 */
export const NL_FLOOD_THRESHOLD_SCORE = 60

/**
 * The time windows the vocabulary carries, longest phrase first.
 *
 * `days: null` is "all time" — no window filter. A window with no days is not a
 * zero-day window; it is the absence of one, and `inWindow` treats it that way.
 */
export const WINDOWS = Object.freeze([
  Object.freeze({ key: 'today', label: 'today', days: 1, phrases: ['today'] }),
  Object.freeze({ key: 'last_week', label: 'the last 7 days', days: 7, phrases: ['last week', 'past week', 'this week', 'last 7 days', 'past 7 days', 'last seven days'] }),
  Object.freeze({ key: 'last_30_days', label: 'the last 30 days', days: 30, phrases: ['last 30 days', 'past 30 days', 'last month', 'past month', 'last thirty days'] }),
  Object.freeze({ key: 'last_quarter', label: 'the last 90 days', days: 90, phrases: ['last quarter', 'last 90 days', 'past 90 days', 'last three months'] }),
  Object.freeze({ key: 'last_year', label: 'the last 365 days', days: 365, phrases: ['last year', 'past year', 'last 12 months', 'last twelve months'] }),
  Object.freeze({ key: 'all_time', label: 'all time', days: null, phrases: ['all time', 'to date', 'since records began'] }),
])

/**
 * The window a question is read in when it names none.
 *
 * Declared, and stamped `assumed: true` on the parsed query, so the answer says
 * which window it used rather than leaving a reader to guess. The alternative —
 * no window at all — would answer "how many dispatches" over the whole store
 * when the operator meant the week, which is the silent-assumption failure the
 * `?state=` and `?district=` parameters paid for in `src/utils.js`.
 */
export const DEFAULT_WINDOW = 'last_week'

/**
 * The subjects a question can be about, each with the collection it resolves
 * against, the predicate it supports, and how its facts are read off a record.
 *
 * `windowed` says whether a time window scopes the records. The derived *state*
 * collections — a risk score, a trust score, a trained model — hold one value
 * per district and no history, so a window cannot scope them; the answer says
 * the value is the latest stored one. The *event* collections — alerts,
 * dispatches, hazards — carry a timestamp, so a window is a real filter on
 * them.
 */
export const SUBJECTS = Object.freeze({
  flood_risk: Object.freeze({
    label: 'flood risk',
    collection: 'risk_scores',
    filter: (r) => r.type === 'flood_risk',
    phrases: ['flood threshold', 'flood risk', 'flood score', 'risk score', 'flood-risk', 'risk'],
    windowed: false,
    valueField: 'score',
    factsOf: (r) => [['score', r.score], ['risk_level', r.risk_level], ['confidence', r.confidence]],
  }),
  flood_probability: Object.freeze({
    label: 'flood probability',
    collection: 'flood_probability_models',
    filter: null,
    phrases: ['flood probability', 'flood model', 'probability model', 'flood-probability'],
    windowed: false,
    valueField: null,
    model: 'flood_probability',
    factsOf: (r) => [
      ['validated_months', r.folds?.validated_months],
      ['skill_over_base_rate', r.folds?.skill_over_base_rate],
      ['months_kept', r.months_kept],
    ],
  }),
  population_at_risk: Object.freeze({
    label: 'population at risk',
    collection: 'population_at_risk',
    filter: null,
    phrases: ['population at risk', 'people at risk', 'population exposed', 'exposed population'],
    windowed: false,
    valueField: null,
    factsOf: (r) => [['population_at_risk', r.population_at_risk], ['service_assets_affected', r.service_assets_affected]],
  }),
  alerts: Object.freeze({
    label: 'open alerts',
    collection: 'alert_events',
    filter: (r) => r.status === 'open',
    phrases: ['open alerts', 'alerts', 'alert', 'warnings', 'warning'],
    windowed: true,
    valueField: null,
    factsOf: (r) => [['severity', r.severity], ['metric', r.metric], ['value', r.value]],
  }),
  dispatches: Object.freeze({
    label: 'dispatches',
    collection: 'rapidpro_dispatches',
    filter: null,
    phrases: ['dispatches', 'dispatch', 'warnings sent', 'messages sent'],
    windowed: true,
    valueField: null,
    factsOf: (r) => [['status', r.status]],
  }),
  trust: Object.freeze({
    label: 'region trust',
    collection: 'region_trust',
    filter: null,
    phrases: ['trust score', 'trust', 'calibration', 'reliability'],
    windowed: false,
    valueField: null,
    factsOf: (r) => [['trust_score', r.trust_score], ['false_alert_rate', r.false_alert_rate]],
  }),
  hazards: Object.freeze({
    label: 'hazard events',
    collection: 'hazard_events',
    filter: null,
    phrases: ['hazard events', 'hazards', 'hazard', 'flood events'],
    windowed: true,
    valueField: null,
    factsOf: (r) => [['event_type', r.event_type], ['severity', r.severity]],
  }),
})

/**
 * The predicates the vocabulary carries.
 *
 * `above_threshold` is a filter on the subject's own value and is only
 * meaningful for a subject that has one (`valueField`) — asking for a threshold
 * on a subject with no threshold is an unknown field, and is refused rather
 * than answered against a field that does not exist.
 *
 * `no_dispatch` is a *join*: it keeps the districts with no dispatch in the
 * window, which is the second half of the entry's example question.
 */
export const PREDICATES = Object.freeze({
  above_threshold: Object.freeze({
    phrases: ['crossed the threshold', 'above the flood threshold', 'above the threshold', 'above threshold', 'crossed', 'crosses', 'exceeds', 'exceed', 'breaches', 'breached'],
  }),
  no_dispatch: Object.freeze({
    phrases: ['no dispatch', 'without dispatch', 'not dispatched', 'undispatched', 'no warning sent', 'no message sent'],
  }),
})


/** The vocabulary, as a value a surface can render or a test can iterate. */
export const NL_QUERY_VOCABULARY = Object.freeze({
  subjects: Object.freeze(Object.keys(SUBJECTS)),
  predicates: Object.freeze(Object.keys(PREDICATES)),
  windows: Object.freeze(WINDOWS.map((w) => w.key)),
  regions: Object.freeze(KNOWN_DISTRICTS.map((d) => d.slug)),
  default_window: DEFAULT_WINDOW,
  flood_threshold_score: NL_FLOOD_THRESHOLD_SCORE,
})
