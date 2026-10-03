/**
 * ENH-06 — freshness SLAs by cadence.
 *
 * The repo has four clocks judging the same feeds and they disagree. A source
 * was `stale` when one `stale_after_minutes` window passed, `degraded` when it
 * returned fewer than `minimum_records: 1`, `aging` when a connector-local
 * year count drifted, and `fresh` when none of those fired. The result is the
 * failure ENH-06 names: a working food-security pipeline and a dead one can
 * report the same string, so the signal trains operators to ignore it.
 *
 * The two errors that make the old clock useless are both about *time*:
 *
 *  - One window for every source. WHO GHO publishes national annual
 *    aggregates; judging it by a two-week clock calls a correct year of
 *    silence a failure. CHIRPS publishes daily rasters and genuinely is broken
 *    after a week of silence. Same verdict vocabulary, opposite facts.
 *
 *  - `minimum_records: 1` for every source. For an event feed, zero new events
 *    is the news, not a fault. But the ingestion path appends
 *    "Expected at least 1 records" and flips the run to `degraded`, which reads
 *    identically to a feed that returned a login page. Quiet and broken were
 *    not merely conflated — they were the same value.
 *
 * So each source carries a publication cadence, and each verdict names the
 * number that produced it.
 *
 * ── For whoever wires this in ───────────────────────────────────────────────
 *
 *   import { FRESHNESS_VERDICTS, freshnessReport, verdictFor } from '../src/freshness.js'
 *
 *  - `freshnessReport({ sourceRuns, now })` takes `data.source_runs` newest
 *    first, which is the order `ingestionStatus()` already assumes, and returns
 *    one entry per `SOURCE_IDS` member — including the ones with no runs at
 *    all. Do not iterate the runs; a source that stopped running would drop
 *    itself out of the report, which is precisely the source you are looking
 *    for. `policies` defaults to `SOURCE_POLICIES` and is overridable.
 *  - The verdict vocabulary is `FRESHNESS_VERDICTS`. It is exported so callers
 *    iterate one list instead of hand-maintaining a second copy at the far end
 *    of a request handler, which is the silent-key-list bug this repo has hit
 *    twice already.
 *  - This vocabulary does not include `sourceHealth()`'s `fresh`/`degraded`/
 *    `failed`. Do not blend the two in one response body: `fresh` means "not
 *    stale" and `ok` means "delivered data", and a UI that renders both will
 *    keep the old ambiguity in a new coat.
 *  - `cadence_days: null` means the source has no deadline — the on-demand
 *    backfills and the upload connectors. It can still be `broken`, and it can
 *    never be `stale` just for being quiet.
 *
 * Pure: no store, no clock, no network. Every timestamp arrives as an argument.
 */

import { SOURCE_IDS } from './schema.js'
import { SOURCE_POLICIES } from './ingestion.js'
import { toNumber } from './utils.js'

/**
 * The five verdicts, in the order a triage reader wants them: healthy first,
 * wrong last.
 *
 * `quiet` sits second deliberately. It is the verdict the old code had no way
 * to express, and it is the one an operator needs to be able to *not* be paged
 * about.
 */
export const FRESHNESS_VERDICTS = Object.freeze([
  'ok',
  'quiet',
  'stale',
  'broken',
  'never_run',
])

function cadence(cadence_days, min_expected_delta) {
  return Object.freeze({ cadence_days, min_expected_delta })
}

/**
 * Publication cadence in days, and the smallest number of new records that
 * counts as "data arrived".
 *
 * Cadence is about *publication*, not about how often we poll. The two differ
 * by two orders of magnitude and conflating them is what produced the false
 * alarms: `interval_minutes` says when we ask, `cadence_days` says when the
 * publisher is expected to have something new for us.
 *
 * `who_gho` and `ipc_hdx` carry the reasoning `SOURCE_POLICIES` already
 * states — IPC classifications arrive per analysis month and HDX republishes
 * them promptly, so a daily poll beats the feed; WHO publishes yearly, so its
 * window is long, and a national-annual figure is "stale" here only when
 * something breaks rather than week to week. The WHO number below takes the
 * two-calendar-years-of-lag line `who-gho.js` already draws between an
 * "aging" and a "stale" series, added to one annual publication cycle.
 *
 * `noaa_enso` is the same argument in miniature: CPC publishes the Niño 3.4
 * anomaly monthly, and the repo polls it twice a day. Ten days of silence is
 * correct news.
 *
 * `min_expected_delta` is a count, not a truthiness test. Zero is a real
 * observation for an event feed and a legitimate outcome for an on-demand
 * backfill that has already stored everything it was asked for.
 */
export const CADENCE_DAYS = Object.freeze({
  open_meteo: cadence(1, 1),
  gdacs: cadence(1, 1),
  glofas: cadence(1, 1),
  chirps: cadence(1, 1),
  nasa_firms: cadence(1, 1),
  usgs_earthquake: cadence(1, 1),
  noaa_enso: cadence(35, 1),
  ipc_hdx: cadence(30, 1),
  who_gho: cadence(730, 1),
  // The historical backfills run on demand, never on a schedule, and are not
  // stale for being quiet: a full gdacs_archive walk is a paginated crawl of
  // forty years. Zero new records from one of these usually means the archive
  // is already stocked, which is the outcome we wanted.
  gdacs_archive: cadence(null, 0),
  open_meteo_archive: cadence(null, 0),
  open_meteo_flood: cadence(null, 0),
  // Uploads arrive when a person uploads them. There is no publisher to be
  // overdue against.
  service_assets: cadence(null, 0),
  acled_csv: cadence(null, 0),
  conflict_csv: cadence(null, 0),
  // DHIS2 is a scaffold that stays inert until base_url and api_token are set,
  // and it carries minimum_records: 0. Judging an unconfigured integration
  // against a clock produces noise that trains people to ignore the signal.
  dhis2: cadence(null, 0),
})

/**
 * The record-count failure `runIngestion` appends when a run comes back under
 * `minimum_records`. Anchored so it cannot swallow a connector's own errors:
 * "Expected at least 1 records for chirps" is a quiet week, "ETIMEDOUT" is not.
 */
const COUNT_SHORTFALL = /^Expected at least \d+ records for \S+/u

/**
 * ENH-07 will attach assertion failures to a run. They are read here in both
 * the top-level and `diagnostics` positions so that shipping the assertion map
 * needs no edit to this file — a tripped assertion is `broken` on sight, with
 * no argument about which window it should be judged against.
 */
function assertionFailures(run) {
  const direct = run?.assertions_failed ?? run?.diagnostics?.assertions_failed
  if (Array.isArray(direct)) return direct.length
  return toNumber(direct, 0)
}

function runFailed(run) {
  return run?.status === 'failed' || run?.status === 'error'
}

/**
 * Whether the run proves the source was reached and answered.
 *
 * A `degraded` run whose only complaint is the record count counts as an
 * answer: the fetch worked, the parse worked, the publisher had nothing new.
 * That distinction is the whole item — `runIngestion` folds both into one
 * status string and this is where they come apart again.
 */
function runReachedSource(run) {
  if (!run || runFailed(run)) return false
  if (assertionFailures(run) > 0) return false
  const errors = Array.isArray(run.errors) ? run.errors : []
  return errors.every((error) => COUNT_SHORTFALL.test(String(error || '')))
}

function countShortfall(run) {
  const errors = Array.isArray(run?.errors) ? run.errors : []
  return errors.find((error) => COUNT_SHORTFALL.test(String(error || ''))) || null
}

/**
 * Connector errors that are not the record-count complaint.
 *
 * `runIngestion` puts both in one `errors` array and one `degraded` status, so
 * the split has to happen here: the count complaint means the feed was read
 * and had nothing new, anything else means the feed was not read at all.
 */
function connectorErrors(run) {
  const errors = Array.isArray(run?.errors) ? run.errors : []
  return errors.filter((error) => !COUNT_SHORTFALL.test(String(error || '')))
}

function runTimestampMs(run) {
  const value = run?.completed_at || run?.started_at || null
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toMs(value, fallback = null) {
  if (value instanceof Date) return value.getTime()
  // A bare epoch number is a normal `now`. Date.parse would coerce it to a
  // string, return NaN, and quietly fall through to the wall clock — which is
  // the one input this module is not allowed to read.
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function days(count) {
  return `${count} day${count === 1 ? '' : 's'}`
}

function pluralRecords(count) {
  return `${count} record${count === 1 ? '' : 's'}`
}

/**
 * The cadence policy for a source, resolved against its ingestion policy.
 *
 * A source is only ever `stale` if it is both scheduled and has a cadence.
 * `interval_minutes: 0` and `interval_minutes: null` are the repo's markers for
 * "run on demand", and a null cadence is the mark for "nobody publishes on a
 * schedule here". Either one disables the deadline; neither disables `broken`.
 */
export function resolveCadence(source, policy = {}) {
  const entry = CADENCE_DAYS[source] || {}
  const cadence_days = toNumber(entry.cadence_days, null)
  const interval_minutes = toNumber(policy.interval_minutes, null)
  const scheduled = cadence_days !== null && interval_minutes !== null && interval_minutes > 0
  return {
    cadence_days,
    min_expected_delta: toNumber(entry.min_expected_delta, 0),
    scheduled,
  }
}

/**
 * How many records the recent runs actually delivered.
 *
 * Accepts a number, an array of counts, or a per-collection map. An array is
 * read as "the most recent counts, any order" and the best one wins, because a
 * single run that delivered is proof the feed works and assuming the caller's
 * ordering is a way to be wrong quietly.
 *
 * Returns null when nothing in the input carried a count — an absence, which is
 * not the same as zero and is never reported as zero.
 */
function newRecordCount(recentRecordCounts, lastRun) {
  const fromCounts = (value) => {
    if (value === null || value === undefined) return null
    if (Array.isArray(value)) {
      const numbers = value.map((entry) => toNumber(entry, null)).filter((entry) => entry !== null)
      return numbers.length ? Math.max(...numbers) : null
    }
    if (typeof value === 'object') {
      const numbers = Object.values(value).map((entry) => toNumber(entry, null)).filter((entry) => entry !== null)
      return numbers.length ? numbers.reduce((sum, entry) => sum + entry, 0) : null
    }
    return toNumber(value, null)
  }

  const fromCountsInput = fromCounts(recentRecordCounts)
  if (fromCountsInput !== null) return fromCountsInput
  return toNumber(lastRun?.records_processed, null)
}

/**
 * The verdict for one source, with the reason that produced it.
 *
 * `lastRun` is the most recent run row, `lastSuccessRun` the most recent run
 * that returned without failing. Both take the shape `runIngestion` writes:
 * `{ source, status, started_at, completed_at, records_processed, errors }`.
 *
 * Precedence, and the reasoning for it:
 *
 *   never_run → broken → stale → ok | quiet
 *
 * A source that has never run cannot be stale, whatever the calendar says. A
 * source that failed was *reached* and did not answer, which is a different
 * fact from one that was never asked. Overdue then decides, because a success
 * older than the cadence is the definition of late no matter what the run
 * itself contained. Only inside the deadline does the record count split the
 * remaining two verdicts — which is where `quiet` earns its place: nothing new,
 * and nothing expected yet.
 *
 * The deadline is strict: age exactly equal to the cadence is on time. A source
 * polled every hour against a one-day cadence should not be called stale at
 * 24.0 hours, and rounding either way makes the boundary untestable.
 */
export function explainVerdict({
  source,
  policy = {},
  lastRun = null,
  lastSuccessRun = null,
  recentRecordCounts = null,
  now = Date.now(),
} = {}) {
  const { cadence_days, min_expected_delta, scheduled } = resolveCadence(source, policy)
  const nowMs = toMs(now, Date.now())
  const records = newRecordCount(recentRecordCounts, lastRun)
  const deadline = scheduled ? `cadence ${days(cadence_days)}` : 'on-demand, no cadence deadline'

  // The anchor is the most recent proof the source answered. A run that only
  // tripped the record-count check still answers, so it can hold the clock —
  // that is what stops a quiet event feed from aging into `stale` purely
  // because nothing happened to happen.
  const anchor = lastSuccessRun || (runReachedSource(lastRun) ? lastRun : null)
  const anchorMs = runTimestampMs(anchor)
  const ageDays = anchorMs === null ? null : (nowMs - anchorMs) / 86400000

  const base = {
    source,
    verdict: 'never_run',
    reason: '',
    cadence_days,
    min_expected_delta,
    scheduled,
    last_success_at: anchorMs === null ? null : new Date(anchorMs).toISOString(),
    age_days: ageDays === null ? null : round2(ageDays),
    records_last_run: records,
  }

  if (!lastRun && !lastSuccessRun) {
    return {
      ...base,
      verdict: 'never_run',
      reason: `no run on record (${deadline}); nothing has ever been measured here`,
    }
  }

  if (runFailed(lastRun)) {
    const firstError = Array.isArray(lastRun?.errors) ? lastRun.errors[0] : null
    return {
      ...base,
      verdict: 'broken',
      reason: `last run failed${base.last_success_at ? ` ${base.last_success_at}` : ''}`
        + `${firstError ? `: ${firstError}` : ''}`
        + ` — the source was reached and did not answer`,
    }
  }

  const tripped = assertionFailures(lastRun)
  if (tripped > 0) {
    return {
      ...base,
      verdict: 'broken',
      reason: `last run tripped ${tripped} assertion${tripped === 1 ? '' : 's'}`
        + `${base.last_success_at ? ` ${base.last_success_at}` : ''}`
        + ' — the source answered with something that fails its own contract',
    }
  }

  const realErrors = connectorErrors(lastRun)
  if (realErrors.length > 0) {
    return {
      ...base,
      verdict: 'broken',
      reason: `last run reported ${pluralRecords(realErrors.length)} it did not recover from`
        + `${base.last_success_at ? ` ${base.last_success_at}` : ''}`
        + `: ${realErrors[0]} — the source was not read`,
    }
  }

  if (scheduled && ageDays !== null && ageDays > cadence_days) {
    return {
      ...base,
      verdict: 'stale',
      reason: `last success ${round2(ageDays)} days ago, ${deadline}, no success since`
        + `${records === null ? '' : `, ${pluralRecords(records)} in the last run`}`
        + ' — overdue',
    }
  }

  // `ok` means data arrived. Zero is not an arrival, whatever the floor is:
  // an on-demand backfill that found nothing new has not succeeded at
  // producing data, it has told us the archive is already stocked, and that is
  // a different sentence to read at 3am.
  if (records !== null && records > 0 && records >= min_expected_delta) {
    return {
      ...base,
      verdict: 'ok',
      reason: `last success ${ageDays === null ? 'never' : `${round2(ageDays)} days ago`}, ${deadline},`
        + ` ${pluralRecords(records)} — data arrived on schedule`,
    }
  }

  // Zero records is an observation with a meaning, not the absence of one. It
  // says the fetch worked and the publisher had nothing for us, and it is
  // reported as exactly that — never as a failed run, and never as `ok` with
  // a zero attached where a reader has to notice the zero.
  const shortfall = countShortfall(lastRun)
  const zeroReason = records === null
    ? 'the run reported no record count'
    : records === 0
      ? '0 records — nothing new, and nothing is due yet'
      : records < min_expected_delta
        ? `${pluralRecords(records)}, under the ${min_expected_delta} expected for this source`
        : `${pluralRecords(records)} — nothing new, and nothing is due yet`
  return {
    ...base,
    verdict: 'quiet',
    reason: `last success ${ageDays === null ? 'never' : `${round2(ageDays)} days ago`}, ${deadline}, ${zeroReason}`
      + `${shortfall ? ` (ingestion flagged: ${shortfall})` : ''}`,
  }
}

/**
 * The verdict string alone, for callers that only need to colour a row.
 */
export function verdictFor(input = {}) {
  return explainVerdict(input).verdict
}

/**
 * One entry per `SOURCE_IDS` member, in `SOURCE_IDS` order.
 *
 * Driven off the id list rather than off the runs, so a source that has not
 * run in a month is still on the page. Reporting only the sources that happen
 * to have runs would delete the failure from the report.
 *
 * `sourceRuns` is `data.source_runs`, newest first, the order
 * `ingestionStatus()` already relies on.
 */
export function freshnessReport({ sourceRuns = [], policies = SOURCE_POLICIES, now = Date.now() } = {}) {
  const runs = Array.isArray(sourceRuns) ? sourceRuns : []
  return SOURCE_IDS.map((source) => {
    const sourceRunsForSource = runs.filter((run) => run?.source === source)
    const lastRun = sourceRunsForSource[0] || null
    const lastSuccessRun = sourceRunsForSource.find((run) => run?.status === 'success') || null
    const recentRecordCounts = sourceRunsForSource.slice(0, 3).map((run) => run?.records_processed)
    return explainVerdict({
      source,
      policy: policies[source] || {},
      lastRun,
      lastSuccessRun,
      // Only fall back to the run's own count when the caller supplied no
      // counts at all; three explicit nulls must not silently become the
      // single last value.
      recentRecordCounts: recentRecordCounts.some((count) => toNumber(count, null) !== null)
        ? recentRecordCounts
        : null,
      now,
    })
  })
}