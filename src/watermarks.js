/**
 * ENH-08: watermarks, incremental fetch, resumable backfill.
 *
 * The defect this exists to stop: `open-meteo-archive` and `open-meteo-flood`
 * mint their record id from a window whose `endDate` defaults to today
 * (`open-meteo-archive.js:73`, `open-meteo-flood.js:81`), and both re-download
 * their entire history on every run. The id therefore changes every day while
 * the bytes behind it do not — roughly 16,000 records per region per day per
 * source, none of it new, re-ingested, re-hashed, and stored beside the copies
 * already there. A 45-year daily series at four pilot regions is about 65,000
 * rows per source; re-downloading it daily is how ingestion runs out of time
 * and out of disk, and how the store accumulates a duplicate history that
 * looks like data.
 *
 * `gdacs_archive` has the same shape one layer down: it walks quarter-by-quarter
 * windows from 1985 on every run, so a crawl that takes an hour re-crawls the
 * same quarters an hour later.
 *
 * The fix is a persisted high-water mark per source. A connector asks
 * `fetchWindow` what range to request instead of assuming today, and the window
 * is derived from the watermark rather than from the clock — so two runs that
 * have nothing new to fetch produce the *same* window, and the id derived from
 * that window stops moving.
 *
 * `now` is injected everywhere. A module that reads the clock itself cannot be
 * tested for a property that is entirely about time, and this one is.
 *
 * ── Wiring contract ────────────────────────────────────────────────────────
 * The consumer (ingestion, which a parallel change owns) needs exactly this:
 *
 *   const state = await store.readWatermarkState()          // or loadWatermarkState()
 *   const wm = readWatermark(state, 'open_meteo_archive')   // entry or null
 *   const win = fetchWindow({
 *     source: 'open_meteo_archive',
 *     watermark: wm,
 *     defaultWindowDays: 45 * 365,
 *     now: new Date(),
 *   })
 *   if (win.skip) return                                    // nothing new; do not fetch
 *   const next = advanceWatermark(state, source, {
 *     cursor: win.endDate,
 *     recordDate: win.endDate,
 *     at: new Date().toISOString(),
 *   })
 *   await store.writeWatermarkState(next)                   // only after the fetch succeeded
 *
 * `advanceWatermark` must be called *after* a successful ingest, not before: a
 * watermark advanced past data that never arrived is a silent hole in the
 * series, and no error anywhere reports it.
 *
 * For a long crawl, wrap each chunk:
 *
 *   let s = beginBackfill(state, source, { from: '1981-01-01', to: '2026-10-01', jobId, at })
 *   for (;;) {
 *     const r = resumeBackfill(s, source)
 *     if (!r) break
 *     await crawl(r.from, r.to)          // the chunk
 *     s = advanceBackfill(s, source, { cursor: r.to })
 *     await store.writeWatermarkState(s) // every chunk, or resumption buys nothing
 *   }
 *   s = completeBackfill(s, source, { at })
 *
 * Every function here is pure: it takes state and returns new state, mutating
 * nothing. `state` is a plain object of `{ [source]: entry }` and is safe to
 * hand straight to `JSON.stringify` for persistence.
 */

/**
 * Sources that carry a watermark.
 *
 * Frozen, and exported, so a consumer iterates this list rather than
 * hard-coding it at the call site — a second hard-coded list is how the two
 * drift, and the drift is silent: an unwatermarked source keeps re-downloading
 * its history and nothing reports it.
 */
export const WATERMARK_SOURCES = Object.freeze([
  'open_meteo_archive',
  'open_meteo_flood',
  'gdacs_archive',
])

/**
 * Where each source's series actually begins.
 *
 * Not decoration. `open-meteo-archive` starts at 1981 and `open-meteo-flood` at
 * 1984 for a reason (CHIRPS/ERA5 coverage and the GloFAS v4 reanalysis start),
 * and a watermark that has drifted before those dates must clamp here rather
 * than walk back to the epoch. The zero watermark is the case that matters: a
 * `last_record_date` of `1970-01-01` is not "we have everything since 1970",
 * it is a cursor that was never written.
 */
export const SERIES_FLOOR = Object.freeze({
  open_meteo_archive: '1981-01-01',
  open_meteo_flood: '1984-01-01',
})

const DAY_MS = 86400000

/**
 * A calendar day as an integer, in UTC. Strict: '2026-02-30' is rejected rather
 * than rolled into March, because a silently-shifted cursor is a silently
 * shifted window, and a silently shifted window is a silently duplicated fetch.
 */
function toDayNumber(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / DAY_MS
  }
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const t = Date.UTC(year, month - 1, day)
  const back = new Date(t)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  return t / DAY_MS
}

function fromDayNumber(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function assertDay(value, label) {
  const day = toDayNumber(value)
  if (day === null) throw new TypeError(`${label} must be a UTC date (YYYY-MM-DD or Date), got ${JSON.stringify(value)}`)
  return day
}

/** An empty state. Exported so a caller does not invent a second shape. */
export function createWatermarkState() {
  return {}
}

/**
 * The watermark entry for one source, or null if it has never run.
 *
 * null and a zeroed entry are different answers and the difference is the whole
 * point: null means "no idea, fetch the series", a zeroed entry means "we wrote
 * a cursor that means nothing", which is a different repair.
 */
/**
 * R-52 — the watermark state is recoverable and invisible.
 *
 * Every source's high-water mark is written on every successful run, and a
 * backfill that died three weeks ago is fully recoverable from it: the store
 * knows exactly how far each source got. There was no route, no page and no
 * export for it, so the only way to find out where a backfill stopped was to
 * read the JSON file.
 *
 * This is the projection. It answers the question an operator actually has —
 * "how far did each source get, and when did it last move" — and it answers it
 * in the terms ingestion uses, so the numbers can be compared against a run's own
 * report rather than reinterpreted.
 */
/**
 * How many intervals of lateness count as a stopped pipeline, rather than a
 * late run. Two, because one missed run is ordinary — a provider hiccup, a
 * deploy — and three would mean a nightly job survives a weekend of trouble
 * without being called.
 */
const STALE_FACTOR = 2

/** Sources with a declared cadence, as minutes between runs. */
const SOURCE_CADENCE = Object.freeze({
  open_meteo: { interval_minutes: 180 },
  gdacs: { interval_minutes: 60 },
  glofas: { interval_minutes: 180 },
  chirps: { interval_minutes: 720 },
  nasa_firms: { interval_minutes: 360 },
  usgs_earthquake: { interval_minutes: 60 },
  noaa_enso: { interval_minutes: 360 },
  ipc_hdx: { interval_minutes: 1440 },
  who_gho: { interval_minutes: 1440 },
  open_meteo_archive: { interval_minutes: 1440 },
  open_meteo_flood: { interval_minutes: 1440 },
  gdacs_archive: { interval_minutes: 1440 },
})

export function describeWatermarkState(state, { now = new Date() } = {}) {
  const sources = state && typeof state === 'object' ? Object.keys(state).sort() : []
  const rows = sources.map((source) => {
    const entry = readWatermark(state, source) || {}
    const covered = newestCoveredDay(entry)
    const policy = SOURCE_CADENCE[source] || null
    const cadenceDays = policy?.interval_minutes ? policy.interval_minutes / 1440 : null
    const ageDays = covered === null ? null : Math.max(0, Math.floor((now.getTime() / DAY_MS) - covered))
    return {
      source,
      // ISO day, or null. `null` is not zero and not today: a source that has
      // never completed a run has covered nothing, and reporting a day for it
      // would read as "it is up to date as of…" on the one source it is not.
      covered_through: covered === null ? null : fromDayNumber(covered),
      cursor: entry.last_cursor ?? null,
      last_success_at: entry.last_success_at ?? null,
      in_progress: entry.in_progress ?? null,
      // Age is the point. A watermark three weeks old on a source with a daily
      // schedule is a dead pipeline, and the date alone makes an operator do the
      // arithmetic against a schedule they have to remember.
      age_days: ageDays,
      // Whether that age is a problem is the source's own cadence, not a global
      // threshold: `gdacs` runs hourly and `chirps` daily, and a watermark four
      // hours old means something different for each.
      //
      // Measured against the source's declared interval with a factor of two, so
      // a single missed run is a late run and two are a stopped pipeline. A
      // source with no declared cadence is only ever "never completed" — a
      // threshold invented here would be a number nobody chose.
      stale: covered === null
        || (cadenceDays !== null && ageDays > cadenceDays * STALE_FACTOR),
      // The cadence it was judged against, or null when the source declares none.
      // Rounded to two places, because a cadence is a schedule and 0.041666666 is
      // not one anybody reads.
      cadence_days: cadenceDays === null ? null : Math.round(cadenceDays * 100) / 100,
      interval_minutes: policy?.interval_minutes ?? null,
    }
  })
  return {
    sources: rows,
    with_watermark: rows.filter((r) => r.covered_through !== null).length,
    never_completed: rows.filter((r) => r.covered_through === null).map((r) => r.source),
  }
}

export function readWatermark(state, source) {
  if (!state || typeof state !== 'object') return null
  const entry = state[source]
  if (!entry || typeof entry !== 'object') return null
  return entry
}

/**
 * The high-water mark: the newest date a successful run has ingested.
 *
 * Prefers `last_record_date` (newest data covered) and falls back to
 * `last_cursor` (where ingestion resumes) for states written by an earlier
 * wave that only set one of them.
 */
export function newestCoveredDay(entry) {
  if (!entry) return null
  const fromRecord = toDayNumber(entry.last_record_date)
  const fromCursor = toDayNumber(entry.last_cursor)
  if (fromRecord === null) return fromCursor
  if (fromCursor === null) return fromRecord
  return Math.max(fromRecord, fromCursor)
}

/**
 * The date range a connector should actually request.
 *
 * With a watermark, `endDate` stops defaulting to today and the window is
 * derived from the mark instead. That is the id-stability fix: the id is
 * `stableId('climate', [source, region, startDate, endDate])`, so a window whose
 * end slides with the clock mints a fresh id every day, and against a 45-year
 * archive that is ~16,000 records per region per day per source — all of them a
 * re-hash of bytes the store already holds. Pin the window to the watermark and
 * an empty fetch is empty, so its id never gets computed at all.
 *
 * Three outcomes, all reported rather than inferred:
 *
 * - no watermark at all -> the full series, from `SERIES_FLOOR` where known;
 * - a usable cursor -> only what is new, `[cursor + 1, today]`;
 * - a cursor we cannot use -> a stated fallback window, never an inverted one.
 *
 * `days` is inclusive of both ends; 0 with `skip: true` means "make no request".
 * A skipped window carries `startDate`/`endDate` of null rather than an inverted
 * pair, because `new URL(...).searchParams.set('start_date', '2026-10-07')` with
 * an end date of `2026-10-06` is a request that goes out and comes back empty
 * and looks like a source outage.
 */
export function fetchWindow({ source, watermark, defaultWindowDays, now }) {
  assertDay(now, 'now')
  const today = toDayNumber(now)

  const days = Number(defaultWindowDays)
  if (!Number.isFinite(days) || days <= 0) {
    throw new TypeError(`defaultWindowDays must be a positive number, got ${JSON.stringify(defaultWindowDays)}`)
  }
  const lookback = Math.floor(days)

  // How far back a *junk* cursor is allowed to reach. Deliberately not the
  // series start — see the two absent-vs-zero branches below.
  const floorDay = toDayNumber(SERIES_FLOOR[source])
  const windowStart = Math.max(today - lookback, floorDay ?? today - lookback)

  // `watermark` arrives as an entry (what readWatermark returns), not as a
  // whole state — a connector has one source in hand and no business holding
  // the others.
  const entry = watermark && typeof watermark === 'object' ? watermark : null
  const cursor = newestCoveredDay(entry)

  // --- no usable cursor ----------------------------------------------------
  // Two situations that must not collapse into one window. Absent means never
  // run, so fetch the series from its floor. Present-but-unusable means a
  // cursor was written and means nothing; that gets the conservative lookback
  // window instead, because trusting a junk cursor to the floor is how a
  // half-initialised state turns into a 45-year download on the next run. With
  // a lookback as long as the series the two coincide, which is exactly when
  // the distinction costs nothing and stops mattering.
  if (cursor === null) {
    return window(source, entry ? windowStart : (floorDay ?? windowStart), today, {
      mode: 'full',
      reason: entry ? 'cursor-unusable' : 'no-watermark',
      asOf: null,
    })
  }

  // --- a cursor we can use ---------------------------------------------------
  if (cursor < windowStart) {
    // Before the window start. Clamp forward to it. Walking back from here would
    // be the zero-watermark bug in its purest form: a `1970-01-01` cursor read
    // as "fetch everything since 1970", which for a source whose series starts
    // in 1981 is five decades of requests for six years of data.
    return window(source, windowStart, today, {
      mode: 'fallback',
      reason: 'cursor-before-window-start',
      asOf: fromDayNumber(cursor),
    })
  }

  if (cursor > today) {
    // Ahead of the clock. Clock skew, a bad write, a watermark copied off a
    // later deployment. Fetching "backwards" would either return nothing or
    // return the whole history again, and neither is worth the risk. Report the
    // skip; an operator can correct the cursor.
    return window(source, null, null, {
      mode: 'empty',
      reason: 'cursor-ahead-of-now',
      asOf: fromDayNumber(cursor),
    })
  }

  const start = cursor + 1
  if (start > today) {
    // Caught up. Derived entirely from the watermark, so two runs on two
    // consecutive days produce byte-identical windows — which is the property
    // that stops the daily id churn.
    return window(source, null, null, {
      mode: 'empty',
      reason: 'caught-up',
      asOf: fromDayNumber(cursor),
    })
  }

  return window(source, start, today, {
    mode: 'incremental',
    reason: 'new-data',
    asOf: fromDayNumber(cursor),
  })
}

function window(source, startDay, endDay, { mode, reason, asOf }) {
  const skip = startDay === null || endDay === null
  return {
    source,
    startDate: skip ? null : fromDayNumber(startDay),
    endDate: skip ? null : fromDayNumber(endDay),
    days: skip ? 0 : endDay - startDay + 1,
    skip,
    mode,
    reason,
    asOf,
  }
}

/**
 * Move a source's high-water mark forward after a successful ingest.
 *
 * Forward only. A run that somehow reports an *older* record date than the
 * watermark already holds — a backfill completing, a stale replica answering —
 * must not drag the mark back, because the next incremental fetch would then
 * re-request everything in between and the duplicate-history problem returns
 * with extra steps. The newer date wins and the older one is discarded.
 *
 * `at` is the success timestamp; `cursor` is where a resume would continue.
 * `in_progress` is preserved untouched: advancing the mark is not the same
 * event as finishing a backfill.
 */
export function advanceWatermark(state, source, { cursor, recordDate, at } = {}) {
  const base = state && typeof state === 'object' ? state : {}
  const entry = readWatermark(base, source) || {}
  const current = newestCoveredDay(entry)
  const next = newestCoveredDay({ last_record_date: recordDate, last_cursor: cursor })

  const merged = {
    ...entry,
    last_success_at: at === undefined ? entry.last_success_at ?? null : at,
  }
  if (next !== null && (current === null || next > current)) {
    merged.last_record_date = fromDayNumber(next)
    merged.last_cursor = fromDayNumber(next)
  } else {
    // Keep whatever was there. Writing null over a good cursor would reset a
    // working source to "never run".
    if (merged.last_record_date === undefined) merged.last_record_date = entry.last_record_date ?? null
    if (merged.last_cursor === undefined) merged.last_cursor = entry.last_cursor ?? null
  }
  if (!('in_progress' in merged)) merged.in_progress = null

  return { ...base, [source]: merged }
}

/**
 * Open a backfill over a fixed historical range.
 *
 * The cursor starts *before* the first chunk rather than on it, so an
 * interrupted crawl resumes at the first un-ingested date instead of repeating
 * the chunk it was midway through.
 */
export function beginBackfill(state, source, { from, to, jobId, at } = {}) {
  const base = state && typeof state === 'object' ? state : {}
  const fromDay = assertDay(from, 'from')
  const toDay = assertDay(to, 'to')
  if (toDay < fromDay) {
    throw new RangeError(`backfill range is inverted: ${from} .. ${to}`)
  }
  const entry = readWatermark(base, source) || {}
  return {
    ...base,
    [source]: {
      ...entry,
      in_progress: {
        job_id: jobId === undefined ? null : jobId,
        from: fromDayNumber(fromDay),
        to: fromDayNumber(toDay),
        cursor: null, // last completed date; null means "nothing done yet"
        chunks_done: 0,
        started_at: at === undefined ? null : at,
      },
    },
  }
}

/**
 * Advance a backfill past one completed chunk.
 *
 * Forward only, same rule as the watermark: a chunk that reports an earlier
 * date than the cursor already has is ignored rather than rewinding the crawl.
 * The count still increments, so a re-reported chunk shows up in the numbers
 * even though it does not rewind the range.
 */
export function advanceBackfill(state, source, { cursor, at } = {}) {
  const base = state && typeof state === 'object' ? state : {}
  const entry = readWatermark(base, source)
  if (!entry || !entry.in_progress) {
    throw new Error(`no backfill in progress for ${source}`)
  }
  const job = entry.in_progress
  const cursorDay = assertDay(cursor, 'cursor')
  if (cursorDay > toDayNumber(job.to)) {
    throw new RangeError(`backfill cursor ${cursor} is past the end of the range (${job.to})`)
  }
  const prev = toDayNumber(job.cursor)
  const forward = prev === null || cursorDay > prev

  return {
    ...base,
    [source]: {
      ...entry,
      in_progress: {
        ...job,
        cursor: forward ? fromDayNumber(cursorDay) : job.cursor,
        chunks_done: (job.chunks_done || 0) + 1,
        last_chunk_at: at === undefined ? null : at,
      },
    },
  }
}

/**
 * Finish a backfill: clear the job and lift the mark to the end of the range.
 *
 * The mark only moves forward. A backfill over old history must not drag the
 * incremental cursor back to 1981 and make the next run re-fetch everything
 * after it.
 */
export function completeBackfill(state, source, { at } = {}) {
  const base = state && typeof state === 'object' ? state : {}
  const entry = readWatermark(base, source)
  if (!entry || !entry.in_progress) {
    throw new Error(`no backfill in progress for ${source}`)
  }
  const job = entry.in_progress
  const advanced = advanceWatermark(base, source, {
    cursor: job.to,
    recordDate: job.to,
    at: at === undefined ? null : at,
  })
  const next = readWatermark(advanced, source)
  return {
    ...advanced,
    [source]: { ...next, in_progress: null, last_backfill: { ...job, completed_at: at === undefined ? null : at } },
  }
}

/**
 * Abandon a backfill that failed in a way we know about.
 *
 * `in_progress` is cleared, because a job that has stopped is not in progress
 * and reporting it as such makes a dead crawl look live. The cursor is copied
 * to `last_backfill` so the next attempt resumes rather than restarts — the
 * difference between the two is the whole point of a resumable backfill.
 *
 * The success mark is untouched. A failure is not a success with extra steps.
 *
 * Note the asymmetry with a crash: a process that dies mid-crawl never calls
 * this, so its `in_progress` survives and `resumeBackfill` picks it up directly.
 */
export function failBackfill(state, source, { at, error } = {}) {
  const base = state && typeof state === 'object' ? state : {}
  const entry = readWatermark(base, source)
  if (!entry || !entry.in_progress) {
    throw new Error(`no backfill in progress for ${source}`)
  }
  const job = entry.in_progress
  return {
    ...base,
    [source]: {
      ...entry,
      in_progress: null,
      last_failure: {
        job_id: job.job_id,
        at: at === undefined ? null : at,
        error: error === undefined ? null : String(error),
      },
      last_backfill: { ...job, failed_at: at === undefined ? null : at },
    },
  }
}

/**
 * The range still to crawl, or null if there is nothing outstanding.
 *
 * Checks `in_progress` first, then a failed job's `last_backfill` — a failure
 * clears the in-flight marker but leaves the cursor, so an explicit retry and a
 * crash recovery take the same path. After a crash `in_progress` is still set
 * and its cursor is the last chunk that finished.
 */
export function resumeBackfill(state, source) {
  const entry = readWatermark(state, source)
  if (!entry) return null
  const job = entry.in_progress || resumeableJob(entry.last_backfill)
  if (!job) return null

  const fromDay = toDayNumber(job.from)
  const toDay = toDayNumber(job.to)
  if (fromDay === null || toDay === null) return null

  const cursorDay = toDayNumber(job.cursor)
  const done = cursorDay === null ? 0 : Math.max(0, Math.min(cursorDay, toDay) - fromDay + 1)
  const total = toDay - fromDay + 1
  if (done >= total) return null

  return {
    jobId: job.job_id ?? null,
    // The first chunk starts at `from`; after that it starts one past the last
    // completed chunk, so a resumed crawl does not re-request work it finished.
    from: fromDayNumber(cursorDay === null ? fromDay : cursorDay + 1),
    to: fromDayNumber(toDay),
    cursor: job.cursor ?? null,
    chunksDone: job.chunks_done || 0,
    daysRemaining: total - done,
  }
}

function resumeableJob(last) {
  if (!last || typeof last !== 'object') return null
  const cursor = toDayNumber(last.cursor)
  const to = toDayNumber(last.to)
  if (cursor === null || to === null) return null
  if (cursor >= to) return null
  return last
}

/**
 * How far a backfill has got.
 *
 * `started` means progress has been *observed* at least once — a chunk has come
 * back and moved the cursor. A crawl that was opened a moment ago and has not
 * completed its first chunk has not been measured, and reports `started: false`
 * with `ratio: null`.
 *
 * Not 0. This is the repo's rule about vacuous truth applied to a number: 0
 * means "measured, and the answer is none of it", which is exactly what a crawl
 * stalled on its first chunk also looks like. Those two want opposite responses
 * — start one, or kill the hung one — and a shared number cannot carry both.
 *
 * As a consequence `ratio: 0` is not a value this function ever returns: a crawl
 * that has done nothing has not been measured, and a crawl that has measured
 * something has done something.
 *
 * For the same reason a zero-length range reports the unstarted shape rather
 * than 1: there was nothing to measure.
 */
export function backfillProgress(state, source) {
  const unstarted = {
    started: false,
    jobId: null,
    total: null,
    done: null,
    remaining: null,
    ratio: null,
  }
  const entry = readWatermark(state, source)
  if (!entry) return unstarted
  const job = entry.in_progress || resumeableJob(entry.last_backfill)
  if (!job) return unstarted

  const fromDay = toDayNumber(job.from)
  const toDay = toDayNumber(job.to)
  if (fromDay === null || toDay === null) return unstarted

  const total = toDay - fromDay + 1
  if (total <= 0) return unstarted

  const cursorDay = toDayNumber(job.cursor)
  const done = cursorDay === null ? 0 : Math.max(0, Math.min(cursorDay, toDay) - fromDay + 1)
  if (done <= 0) return unstarted

  const remaining = total - done

  return {
    started: true,
    jobId: job.job_id ?? null,
    total,
    done,
    remaining,
    ratio: done / total,
  }
}