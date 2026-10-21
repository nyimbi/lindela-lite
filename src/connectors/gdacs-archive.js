import { fetchWithRetry } from './http.js'
import { createBudget } from '../rate-limit.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { DEFAULT_COUNTRIES } from './ipc-hdx.js'
import { assessPagination, completenessVerdictName, mergeCompleteness } from '../completeness.js'
import { advanceWatermark, readWatermark } from '../watermarks.js'

/**
 * GDACS historical flood events, from the event-search archive API.
 *
 * Verified live on 2026-10-02 at:
 *   https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?fromDate=2019-01-01&toDate=2019-03-31
 *
 * This is what makes flood-probability training possible at all. The live
 * `gdacs` RSS feed reaches back weeks; rainfall-to-flood models need *decades*
 * of pairs. The archive goes back to at least 2019 as queried windows and is
 * paginated: a full-range query (1985 → present) returns only the most recent
 * ~100 events, so the connector walks quarter-by-quarter windows, each of
 * which is small enough to return whole (2019 = 87 events across types).
 *
 * Two live behaviours shape this code, both probed on 2026-10-02:
 * 1. The `eventtype` query parameter is accepted and ignored — a
 *    `eventtype=FL` query returns droughts, cyclones and earthquakes too. The
 *    filter runs in this process. Guessing that the upstream filter works
 *    would be harmless one quarter and silently wrong the next; a filter that
 *    works is one you can see.
 * 2. Flood events carry `severitydata: {severity: 0.0, 'Magnitude 0.00'}` — a
 *    fill-in zero, not a measurement. It is stored as null. A zero would read
 *    downstream as "quantified, small", and it is neither.
 *
 * The event point is GDACS's *representative* coordinate for a basin-wide
 * flood, not an observed location. It is stored with that caveat in the
 * metadata, because downstream matching (districts by radius) needs a point,
 * but nothing here may suggest the flood happened precisely there.
 *
 * Quarter windows are not a workaround that always works. GDACS caps a query at
 * ~100 results, and a capped quarter and a genuinely quiet quarter return the
 * same 100 rows, so walking quarters only helps if a capped one is visible
 * afterwards. Every window is now assessed on its own shape and the windows are
 * merged into one verdict — the run says which windows hit the cap instead of
 * dropping the distinction between "GDACS had nothing there" and "GDACS stopped
 * telling us at 100".
 *
 * There is no upstream total to check against. Probed live on 2026-10-03, the
 * archive answers with a bare GeoJSON FeatureCollection (`type`, `features`,
 * `bbox`) and no count anywhere in it, so every verdict here rests on page
 * shape and the ~100 cap. That is the `possibly_incomplete` tier and not the
 * `incomplete` one, and the distinction is honest rather than a limitation to
 * paper over: a counted shortfall is an answer, a full window is a guess.
 */

const ARCHIVE_ROOT = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH'

/** The id this connector ingests under, and the key its watermark is stored at. */
const SOURCE = 'gdacs_archive'

/** GDACS' own per-query result cap. The verdict depends on knowing its value. */
const WINDOW_CAP = 100


async function connectorIngest(options = {}) {
  const hazard_events = []
  const errors = []
  const startYear = Number.isFinite(options.archive_start_year)
    ? Number(options.archive_start_year)
    : 1985
  const thisQuarter = quarterOf(new Date())
  // Today, as the clamp for the current quarter's end. The walk asks for the
  // whole quarter and the archive answers with what it has, but the cursor may
  // not claim days the clock has not reached.
  const todayIso = new Date().toISOString().slice(0, 10)
  const countries = optionCountrySet(options)

  // SAE-27. The walk resumes from the stored cursor rather than from
  // `archive_start_year`. It was listed in `WATERMARK_SOURCES` and read no
  // watermark at all, so the declaration and the behaviour disagreed and
  // nothing compared them: every run re-walked 1985 → now, 168 requests to
  // rediscover that nothing had changed.
  //
  // The cursor is quarter-granular because the walk is. A date cursor would
  // land mid-quarter and the next run would re-request a quarter it had already
  // read — the same daily-id churn `open-meteo-archive` had, one level up.
  //
  // `archive_start_year` still applies as the *floor*: it says where this
  // operator's archive begins, and a stored cursor from an earlier run only
  // moves the walk forward from there.
  const state = options.watermark_state && typeof options.watermark_state === 'object'
    ? options.watermark_state
    : {}
  const storedCursor = readWatermark(state, SOURCE)
  const cursorDay = newestCursorDay(storedCursor)
  const resumeFrom = nextQuarterAfter(cursorDay, thisQuarter)
  // A cursor past the current quarter is ahead of the clock — a bad write, a
  // clock skew, a state copied off a later deployment. Reported rather than
  // skipped: skipping it silently is how the archive stops being walked at all
  // and nothing says so. `cursor-ahead-of-now` is the same word `fetchWindow`
  // uses, and `runIngestion` deliberately does *not* exempt it from the record
  // floor — it is a state an operator has to correct.
  if (resumeFrom && quarterIndex(resumeFrom.year, resumeFrom.quarter) > quarterIndex(thisQuarter.year, thisQuarter.quarter)) {
    return {
      hazard_events,
      errors: [`gdacs_archive: watermark cursor ${fromCursorDay(cursorDay)} is past the current quarter `
        + `(${thisQuarter.year}-Q${thisQuarter.quarter}); the walk was skipped and the cursor needs correcting`],
      watermark_state: state,
      watermark: {
        source: SOURCE,
        mode: 'empty',
        reason: 'cursor-ahead-of-now',
        as_of: fromCursorDay(cursorDay),
        windows: 0,
      },
    }
  }

  // One entry per planned window, in order. The walk's verdict is merged from
  // these at the end: a crawl needs one answer, not a verdict per page.
  const windowVerdicts = []
  const flaggedWindows = []
  let windowsPlanned = 0
  let pagesFetched = 0
  let recordsSeen = 0
  // The end of the newest quarter that read clean. The cursor lands here and
  // nowhere else: a cursor that advances past a failed window declares that
  // quarter complete, so it is never requested again and nothing reports the
  // hole. `null` means nothing completed and the stored cursor stands.
  let completedThrough = null
  // Set the first time a window is not read — a failed fetch, an empty answer,
  // or a budget stop. The walk keeps going, but the cursor may not move past a
  // gap: a cursor that steps over an unread quarter declares it complete, so it
  // is never requested again and nothing reports the hole. Everything after the
  // gap is still read and still stored; it just does not earn a cursor.
  let gapSeen = false
  // The start of the first window this run actually opened, so the run record
  // says what it covered rather than only where it ended.
  let firstWindowStart = null

  // ENH-11 / ING-06. A deadline for the *source*, where `timeout_ms` bounds one
  // request. This walk is 1985→now quarter by quarter; with two retries each
  // that is up to 168 × 3 attempts, and at 30s apiece it reaches ~4.2 hours
  // while every individual call is a healthy one. The per-attempt timeout is
  // correct and cannot see the sum, so the budget is spent across the walk and
  // checked before each window: the run stops while it can still say why,
  // rather than being reaped by a socket that outlives the process.
  //
  // Absent `budget_ms` the connector walks unbounded, exactly as before — the
  // budget is a declared policy and this connector does not invent one.
  const budgetMs = Number(options.budget_ms)
  const budget = Number.isFinite(budgetMs) && budgetMs > 0
    ? createBudget({ totalMs: budgetMs, name: 'gdacs_archive' })
    : null
  // Windows that the deadline cut off, so the verdict can distinguish "the walk
  // finished" from "the walk was stopped" — a truncated crawl reported as
  // complete is the silence this file exists to remove.
  let windowsSkippedByBudget = 0
  // Quarters the cursor already covered, so the run can say how much of the
  // archive it did not look at. This is the scope of the batch: `windows_planned`
  // is what this run actually asked for, and the two together are what a count
  // comparison against a previous run needs in order to compare like with like.
  let windowsSkippedByCursor = 0

  for (let year = startYear; year <= thisQuarter.year; year += 1) {
    // The current quarter is only complete up to today, but partial is fine —
    // the archive answers with what it has for the window.
    const lastQuarter = year === thisQuarter.year ? thisQuarter.quarter : 4
    for (let q = 1; q <= lastQuarter; q += 1) {
      const label = `${year}-Q${q}`
      // Skipped, not counted as planned: a quarter the cursor already covers is
      // not part of this run's walk, and counting it would make
      // `walk_end: 'plan_abandoned'` fire on every resumed run — reporting a
      // correct resume as a truncated crawl.
      if (resumeFrom && quarterIndex(year, q) < quarterIndex(resumeFrom.year, resumeFrom.quarter)) {
        windowsSkippedByCursor += 1
        continue
      }
      windowsPlanned += 1
      // Checked before the request, not after: the budget bounds what the walk
      // *starts*, so a window that would run past the deadline is not opened at
      // all. `issue()` counts even when it denies, so `windowsSkippedByBudget`
      // is the number of windows the deadline took, and `windows_planned`
      // already counted them.
      if (budget) {
        const spent = budget.issue()
        if (!spent.allowed) {
          windowsSkippedByBudget += 1
          gapSeen = true
          // Recorded as its own verdict rather than left out, so the merge
          // cannot read the gap as a quiet quarter. Same reasoning as the
          // failed-window branch below: an unread window is unknown, not zero.
          windowVerdicts.push({
            complete: false,
            possibly_incomplete: false,
            reason: `window ${label} was not read (${spent.reason}); nothing behind it was counted`,
            counts_found: null,
          })
          continue
        }
      }
      try {
        const window = quarterRange(year, q)
        if (firstWindowStart === null) firstWindowStart = window.from
        const text = await fetchWithRetry(`${ARCHIVE_ROOT}?fromDate=${window.from}&toDate=${window.to}`, {
          timeoutMs: options.timeout_ms || 30000,
          retries: options.retries ?? 2,
          parse: 'text',
          source: options.source,
        })
        let payload
        try { payload = JSON.parse(text) } catch {
          throw new Error(`GDACS archive ${window.from}..${window.to} did not return JSON`)
        }
        pagesFetched += 1
        const features = Array.isArray(payload?.features) ? payload.features : []
        recordsSeen += features.length

        // A window that came back full is the shape that means GDACS stopped
        // answering at its cap. Probed live 2026-10-03: the payload is a bare
        // FeatureCollection with no total, so there is nothing to check that
        // against and the cap plus the page shape are the whole of the evidence.
        const verdict = assessPagination({
          pagesFetched: 1,
          recordsSeen: features.length,
          providerTotal: null,
          pageSize: WINDOW_CAP,
          cappedAt: WINDOW_CAP,
          lastPageFull: features.length >= WINDOW_CAP,
        })
        windowVerdicts.push(verdict)
        if (!verdict.complete) flaggedWindows.push(label)

        if (!features.length) {
          errors.push(`gdacs_archive: window ${window.from}..${window.to} returned no features`)
          gapSeen = true
          // Recorded as `incomplete` rather than left out: a window that read as
          // empty may be a quiet quarter or an empty answer, and mergeCompleteness
          // treats an entry that claims nothing as the worst case rather than
          // letting a gap read as evidence of a whole crawl.
          windowVerdicts.push({
            complete: false,
            possibly_incomplete: false,
            reason: `window ${label} returned no features, which is not evidence that the quarter was empty`,
            counts_found: 0,
          })
          continue
        }
        for (const feature of features) {
          const record = recordFromFeature(feature, countries)
          if (record) hazard_events.push(record)
        }
        // The quarter read clean. `completedThrough` holds the end of the
        // newest such quarter, so a later failure does not rewind it and an
        // earlier failure does not block it.
        //
        // Clamped to today, because the current quarter is only complete up to
        // the clock: recording its calendar end would claim coverage of days
        // that have not happened, and the next run would read that cursor as
        // ahead of now and refuse to walk.
        //
        // Only while no gap has been seen. After one, everything read is still
        // stored but nothing earns a cursor, so the next run resumes at the
        // quarter after the gap rather than after the last quarter read.
        if (!gapSeen) completedThrough = window.to > todayIso ? todayIso : window.to
      } catch (error) {
        errors.push(`gdacs_archive: window ${year}-Q${q}: ${error.message}`)
        gapSeen = true
        // The window was never read, so whatever GDACS holds for it is unknown —
        // not zero. Merged as incomplete, which outranks the full-page guess a
        // successful window would have contributed.
        windowVerdicts.push({
          complete: false,
          possibly_incomplete: false,
          reason: `window ${label} was not read (${error.message}); nothing behind it was counted`,
          counts_found: null,
        })
      }
    }
  }

  const merged = mergeCompleteness(windowVerdicts)
  const completeness = {
    ...merged,
    // `merged.pages` counts every assessed window, failed ones included; this
    // counts only the windows that actually came back. They differ whenever a
    // fetch failed, which is exactly when the difference matters.
    pages_fetched: pagesFetched,
    windows_planned: windowsPlanned,
    records_seen: recordsSeen,
    // Fewer than records_seen by design: the flood and country filters drop
    // events on purpose, so this gap is a decision and not a shortfall.
    records_kept: hazard_events.length,
    // The walk ends when the planned quarters run out. It is never the cap that
    // ends it — GDACS caps a window and the connector moves to the next one
    // unaware — so "stopped early" here means a window was abandoned unread,
    // not that we chose to quit.
    walk_end: pagesFetched === windowsPlanned ? 'plan_exhausted' : 'plan_abandoned',
    windows_stopped_before: windowsPlanned - pagesFetched,
    flagged_windows: flaggedWindows,
    cap: WINDOW_CAP,
    provider_total: null,
    // ENH-11. Whether a deadline was in force at all, and what it took. `null`
    // for the budget when the policy declares none, so a reader can tell an
    // unbounded walk from a bounded one that finished inside its budget —
    // reporting `0 windows skipped` for both would be the same silence.
    budget_ms: budget ? budget.totalMs : null,
    windows_skipped_by_budget: windowsSkippedByBudget,
    budget_exhausted: budget ? budget.isExhausted() : false,
  }

  if (!completeness.complete) {
    // The verdict also travels in `errors` because that is the one channel
    // runIngestion carries into the source run's record; a run that returns a
    // verdict nobody stores is the defect this file was written to remove.
    errors.push(`gdacs_archive: archive walk is ${completenessVerdictName(merged)} — ${merged.reason}`)
  }

  if (windowsSkippedByBudget > 0) {
    // Named separately from the completeness verdict. A budget stop and a failed
    // fetch both leave windows unread, and they are not the same fact: one says
    // GDACS stopped answering, the other says we chose to stop asking. The
    // operator's next move differs — retry with a longer budget, or investigate
    // the provider — so the run has to say which one happened.
    errors.push(
      `gdacs_archive: budget_exhausted — wall-clock budget of ${budget.totalMs}ms ran out with `
      + `${windowsSkippedByBudget} of ${windowsPlanned} windows unread`,
    )
  }

  if (!hazard_events.length && !errors.some((e) => /window/.test(e))) {
    errors.push('gdacs_archive: no flood events retained across the archive')
  }

  // The cursor moves only over quarters that read clean, and only forward. A
  // run that read nothing (a budget stop on the first window, a first window
  // that failed) keeps the position it was seeded with rather than resetting
  // it, which is the same rule `open-meteo-archive` follows.
  let nextState = state
  if (completedThrough) {
    nextState = advanceWatermark(state, SOURCE, {
      cursor: completedThrough,
      recordDate: completedThrough,
      at: new Date().toISOString(),
    })
  }

  return {
    hazard_events,
    errors,
    completeness,
    watermark_state: nextState,
    watermark: {
      source: SOURCE,
      mode: 'backfill',
      // `resumed-walk` means the cursor took work off this run, not merely that
      // something completed. The first run of an archive completes plenty and
      // resumes nothing, and calling that a resume would make the reason
      // useless as a way to tell the two apart — which is what the count
      // assertion reads it for.
      reason: !completedThrough ? 'nothing-completed' : (windowsSkippedByCursor > 0 ? 'resumed-walk' : 'full-walk'),
      as_of: completedThrough ? fromCursorDay(toDayNumberSafe(completedThrough)) : null,
      windows: pagesFetched,
      windows_skipped_by_cursor: windowsSkippedByCursor,
      start_date: firstWindowStart,
      end_date: completedThrough,
    },
  }
}

/**
 * The quarter after the one a cursor sits at the end of.
 *
 * `last_cursor` is the last day of the last quarter that read clean, so the
 * next quarter to request begins the day after it. A cursor that is not the end
 * of a quarter — one written by an earlier date-granular wave, or hand-edited —
 * is moved to the next quarter boundary rather than trusted, because
 * re-requesting part of a quarter is cheap and skipping part of one is a hole.
 */
function nextQuarterAfter(cursorDay, thisQuarter) {
  if (cursorDay === null) return null
  const date = new Date(cursorDay * 86400000)
  const year = date.getUTCFullYear()
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1
  const endOfQuarter = quarterRange(year, quarter).to
  const atEnd = fromCursorDay(cursorDay) === endOfQuarter
  if (atEnd) return quarter === 4 ? { year: year + 1, quarter: 1 } : { year, quarter: quarter + 1 }
  // Mid-quarter: the cursor covers part of it, and the rest has not been read.
  return { year, quarter }
}

/** A cursor entry's newest day, as a day number, or null. */
function newestCursorDay(entry) {
  return toDayNumberSafe(entry?.last_cursor) ?? toDayNumberSafe(entry?.last_record_date)
}

function toDayNumberSafe(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(t) ? t / 86400000 : null
}

function fromCursorDay(day) {
  return day === null ? null : new Date(day * 86400000).toISOString().slice(0, 10)
}

/** Quarters as a single increasing integer, so two of them compare. */
function quarterIndex(year, quarter) {
  return year * 4 + (quarter - 1)
}

function quarterOf(date) {
  return { year: date.getUTCFullYear(), quarter: Math.floor(date.getUTCMonth() / 3) + 1 }
}

function quarterRange(year, q) {
  const fromMonth = (q - 1) * 3
  const toMonth = q * 3 - 1
  const last = new Date(Date.UTC(year, toMonth + 1, 0))
  return {
    from: `${year}-${String(fromMonth + 1).padStart(2, '0')}-01`,
    to: `${year}-${String(toMonth + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`,
  }
}

function optionCountrySet(options) {
  if (options.countries === 'all') return null
  const list = Array.isArray(options.countries) && options.countries.length
    ? options.countries
    : DEFAULT_COUNTRIES
  return new Set(list.map((c) => String(c).trim().toUpperCase()).filter(Boolean))
}

function recordFromFeature(feature, countries) {
  if (!feature || typeof feature !== 'object') return null
  const props = feature.properties || {}
  if (props.eventtype !== 'FL') return null
  const iso = String(props.iso3 || '').toUpperCase()
  if (countries && !countries.has(iso)) return null
  const coords = feature.geometry?.coordinates || []
  const latitude = Number(coords[1])
  const longitude = Number(coords[0])
  // An alert level is GDACS's own graded flag and is kept verbatim; the
  // severity number is a fill-in zero for floods and is not mapped.
  const severityText = props.severitydata?.severitytext || ''
  const severityNumeric = Number(props.severitydata?.severity)
  return {
    id: stableId('hazard', ['gdacs_archive', props.eventid || props.glide || props.fromdate, iso]),
    source: 'gdacs_archive',
    source_id: `gdacs:fl:${props.eventid}`,
    event_type: 'flood',
    // Flood severitydata is a placeholder ("Magnitude 0.00"), not a
    // measurement: null beats a fake 0 km2.
    severity: severityNumeric > 0 ? severityNumeric : null,
    title: props.eventname || `Flood in ${props.country || iso || 'unknown country'}`,
    description: null,
    occurred_at: props.fromdate ? new Date(props.fromdate).toISOString() : null,
    source_url: props.url || 'https://www.gdacs.org/',
    country: iso,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    bbox: null,
    affected_population: null,
    metadata: {
      provider: 'GDACS (Global Disaster Alert and Coordination System) archive',
      archive_note: 'Historical archive event, not a live alert. GDACS publishes flood severity as a fill-in zero, so severity is null here.',
      geolocation_note: 'Point is GDACS representative coordinate for the event, not an observed flood location.',
      severity_data_text: severityText,
      alert_level: props.alertlevel || null,
      glide: props.glide || null,
      valid_to: props.todate ? new Date(props.todate).toISOString() : null,
      attribution: 'GDACS via the Joint Research Centre of the European Commission',
      model_limit: 'Archive event record: existence and timing of a reported flood, not its extent or depth',
      fetched_at: new Date().toISOString(),
    },
  }
}

export const spec = defineConnector({
  id: 'gdacs_archive',
  description: 'GDACS historical flood events (archive search, 1985 onward), backfill source for flood-probability training',
  schema: {
    requestSchema: {
      archive_start_year: 'number (default 1985)',
      countries: "array of ISO3 codes to keep (default: Sub-Saharan Africa); 'all' for every country",
      timeout_ms: 'number (default 30000)',
      retries: 'number (default 2)',
      budget_ms: 'number — wall-clock deadline for the whole walk (default: from SOURCE_POLICIES); absent walks unbounded',
    },
    outputSchema: {
      hazard_events: 'flood archive events; severity null (GDACS publishes a fill-in zero for floods)',
      completeness: '{complete, possibly_incomplete, reason, counts_found, pages_fetched, windows_planned, records_seen, records_kept, walk_end, flagged_windows, budget_ms, windows_skipped_by_budget, budget_exhausted}; one verdict for the whole archive walk',
    },
  },
  defaults: {
    timeout_ms: 30000,
    retry: { max: 2, backoffMs: 1000 },
  },
  source: 'GDACS archive, Joint Research Centre of the European Commission',
  license: 'GDACS data: free re-use with attribution, per JRC terms',
  ingest: connectorIngest,
})

export const gdacsArchiveConnector = spec