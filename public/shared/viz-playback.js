// =============================================================
// Lindela Lite — hazard-history playback frames
// =============================================================
// ENH-18. The archive reaches back to GDACS 1985 and ERA5 1981, and every
// surface shows one of those decades as a single current-state map. A flood
// spreading and receding is a temporal event, and a static map cannot show it.
//
// **This module builds the frames, not the scrubber.** A slider is a widget with
// opinions about touch targets and keyboard behaviour, and it belongs to the
// surface that owns the page. What every surface needs identically is the hard
// part: turning a flat list of records into a timeline where each frame carries
// its own counts and its own transitions, such that dragging from frame 4 to
// frame 5 shows the right thing without the caller re-deriving anything.
//
// **The three answers a frame has to give**, all of them returned per frame:
//
// 1. `active` — which records are in effect at this instant, by id, so a caller
//    can highlight a district rather than redraw the map from scratch.
// 2. `counts` — by severity and by kind, because "3 events" is not what an
//    emergency officer is watching for; "2 medium and rising" is.
// 3. `transitions` — what changed since the previous frame: which ids opened,
//    which closed, which escalated. Without this a slider is a slideshow and the
//    reader has to diff consecutive frames themselves to see anything move.
//
// **On bucket boundaries.** `bucket` is a duration key ('day' | 'week' | 'month'
// | 'year' | 'hour'), resolved in **UTC** and floored, not rounded. A hazard
// spanning 23:50–00:10 belongs wholly or not at all to one bucket, and a bucket
// boundary that falls at a local midnight would put the same event in two
// frames on some devices and one on others. `recordsAt` then tests membership by
// the record's own interval rather than by which bucket it was filed under, so a
// long event is *active* in every frame it spans, not only the one it started in.

const BUCKET_MS = Object.freeze({
  hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: null, year: null, decade: null,
})

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse a timestamp to epoch ms, or null. Anything unparseable is not a time.
 *
 * A bare number is only a time if it is epoch seconds or milliseconds. `1985` is
 * a year, not 1.9 seconds after 1970 — and `Number(1985)` being finite is
 * exactly the falsy coercion this repository keeps tripping over, so a 1–4 digit
 * number is deliberately refused and left to `Date.parse`, which reads it as a
 * year. Nothing from 1970 to the present is expressible in four digits as an
 * epoch offset, so the guard costs nothing.
 */
function epoch(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Math.abs(value) <= 9999 ? null : (Math.abs(value) < 1e11 ? value * 1000 : value)
  }
  const text = String(value).trim()
  if (!text) return null
  if (/^-?\d{1,4}$/.test(text)) return null
  if (/^-?\d{9,}(\.\d+)?$/.test(text)) {
    const n = Number(text)
    return Math.abs(n) < 1e11 ? n * 1000 : n
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Floor `ms` to the start of its bucket, in UTC.
 *
 * Months and years cannot be a fixed number of milliseconds — February is 28
 * days and 29 — so they use `Date.UTC` with the components zeroed. Anything that
 * used a 30-day month would silently misfile every March.
 */
export function bucketStart(ms, bucket = 'day') {
  if (ms === null) return null
  const d = new Date(ms)
  if (bucket === 'hour') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
  if (bucket === 'week') {
    // ISO weeks start Monday. `getUTCDay()` is 0 for Sunday, which is the last
    // day of the previous ISO week, not the first day of this one.
    const day = (d.getUTCDay() + 6) % 7
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  }
  if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  if (bucket === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1)
  if (bucket === 'decade') return Date.UTC(Math.floor(d.getUTCFullYear() / 10) * 10, 0, 1)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** The instant the *next* bucket starts. Same calendar arithmetic as `bucketStart`. */
function nextBucket(ms, bucket) {
  const d = new Date(ms)
  if (bucket === 'hour') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
  if (bucket === 'week') return bucketStart(ms, bucket) + 7 * 86400e3
  if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  if (bucket === 'year') return Date.UTC(d.getUTCFullYear() + 1, 0, 1)
  if (bucket === 'decade') return Date.UTC(d.getUTCFullYear() + 10, 0, 1)
  return ms + 86400e3
}

const startOf = (record) => epoch(record?.start ?? record?.started_at ?? record?.observed_at ?? record?.date ?? record?.event_time)
const explicitEnd = (record) => epoch(record?.end ?? record?.ended_at ?? record?.closed_at)

const endOf = (record) => {
  const explicit = explicitEnd(record)
  if (explicit !== null) return explicit
  const start = startOf(record)
  // An instant with no end is treated as still open rather than as ending at its
  // own start. `end ?? start` would make every ongoing hazard a zero-length
  // event that is never active in any frame — the event would be invisible in a
  // timeline whose whole purpose is showing it.
  return start
}

/** True when the record's interval overlaps `[from, to)`. */
export function recordActive(record, from, to) {
  const s = startOf(record)
  if (s === null) return false
  const e = endOf(record)
  return s < to && e >= from
}

const severityRank = (severity) => {
  const s = String(severity || '').toLowerCase()
  return ['low', 'medium', 'high', 'critical'].indexOf(s)
}

/**
 * Build the frames a slider steps through.
 *
 * `records` is a flat list; each needs a timestamp (`start`, `started_at`,
 * `observed_at`, `date` or `event_time`) and optionally `end`/`ended_at`. `id`,
 * `severity`, `kind`/`type` and `region_name` are read when present and never
 * required — a record with none of them still occupies a frame, because silently
 * dropping it is the failure mode this whole module exists to avoid.
 *
 * Returns `{ frames, bucket, from, to, firstFrameIndex, totalRecords, buckets }`
 * where each frame is:
 *
 * ```
 * {
 *   index, at (ISO), startMs, endMs, label,
 *   active: [{ id, severity, kind, region_name, record }],  // in effect now
 *   opened: [ids],       // became active this frame
 *   closed: [ids],       // stopped being active since the previous frame
 *   escalated: [{ id, from, to }],
 *   unchanged: number,
 *   counts: { total, bySeverity: {...}, byKind: {...} },
 * }
 * ```
 *
 * `frames` never contains an empty bucket. A scrubber that has to step through
 * four frames where nothing happened is a scrubber that spends three quarters of
 * its travel teaching the reader that the data is sparse.
 */
export function buildFrames(records, options = {}) {
  const bucket = String(options.bucket || 'day')
  if (!Object.keys(BUCKET_MS).includes(bucket)) {
    throw new Error(`viz-playback: unknown bucket '${bucket}'. Expected one of ${Object.keys(BUCKET_MS).join(', ')}.`)
  }
  const list = Array.isArray(records) ? records : []
  const timed = list
    .map((record, i) => {
      const startMs = startOf(record)
      if (startMs === null) return null
      const endMs = endOf(record)
      return {
        // A record with no id still needs a stable key, or the transitions
        // cannot be diffed between frames. The index is the fallback and it is
        // stable for a given input list, which is all a caller needs.
        id: String(record?.id ?? `record-${i}`),
        severity: record?.severity ?? null,
        kind: record?.kind ?? record?.type ?? null,
        region_name: record?.region_name ?? null,
        startMs,
        // An open-ended event has to remain active through the last frame, so
        // its effective end is the end of the whole timeline, not its start.
        // The distinction matters: a record carrying an explicit end equal to its
        // start is a zero-length event — real, momentary, one frame — and
        // treating that the same as "no end date" would leave it active for the
        // whole archive.
        endMs: explicitEnd(record) === null ? Infinity : endMs,
        record,
      }
    })
    .filter(Boolean)

  if (!timed.length) {
    return { frames: [], bucket, from: null, to: null, firstFrameIndex: 0, totalRecords: list.length, skipped: list.length }
  }

  const from = options.from !== undefined ? epoch(options.from) : bucketStart(Math.min(...timed.map((r) => r.startMs)), bucket)
  // An open-ended record carries `Infinity`, and `Math.max` with an Infinity in
  // it ends the timeline at Infinity — which then runs the bucket walk to the
  // frame cap. The timeline's extent has to come from the records that actually
  // finished; a still-open event stays active through whatever frames exist.
  const finiteEnds = timed.map((r) => r.endMs).filter((v) => Number.isFinite(v))
  const lastStart = Math.max(...timed.map((r) => r.startMs))
  const to = options.to !== undefined
    ? epoch(options.to)
    : Math.max(finiteEnds.length ? Math.max(...finiteEnds) : lastStart, lastStart)

  // Walk bucket by bucket. Bounded by an explicit cap so a caller who hands in
  // a decade of daily records and forgets to set a bucket gets a few thousand
  // frames rather than a browser hang — and so the cap is a number the caller
  // can see being hit, not a silent truncation.
  const hardCap = num(options.maxFrames) ?? 5000
  const frames = []
  let cursor = bucketStart(from, bucket)
  let previousActive = new Map()
  let truncated = false

  while (cursor <= to && frames.length < hardCap) {
    const end = nextBucket(cursor, bucket)
    const active = timed.filter((r) => r.startMs < end && r.endMs >= cursor)
    const current = new Map(active.map((r) => [r.id, r]))
    if (active.length) {
      const opened = []
      const escalated = []
      let unchanged = 0
      for (const [id, r] of current) {
        const prev = previousActive.get(id)
        if (!prev) {
          opened.push(id)
        } else if (severityRank(r.severity) !== severityRank(prev.severity)) {
          escalated.push({ id, from: prev.severity, to: r.severity })
        } else {
          unchanged += 1
        }
      }
      const closed = [...previousActive.keys()].filter((id) => !current.has(id))
      const bySeverity = {}
      const byKind = {}
      for (const r of active) {
        const sev = String(r.severity || 'unspecified')
        bySeverity[sev] = (bySeverity[sev] || 0) + 1
        const k = String(r.kind || 'unspecified')
        byKind[k] = (byKind[k] || 0) + 1
      }
      frames.push({
        index: frames.length,
        at: new Date(cursor).toISOString(),
        startMs: cursor,
        endMs: end,
        label: frameLabel(cursor, bucket),
        active: active.map((r) => ({ id: r.id, severity: r.severity, kind: r.kind, region_name: r.region_name, record: r.record })),
        opened,
        closed,
        escalated,
        unchanged,
        counts: { total: active.length, bySeverity, byKind },
      })
      previousActive = current
    }
    cursor = end
  }
  if (cursor <= to) truncated = true

  return {
    frames,
    bucket,
    from: new Date(frames.length ? frames[0].startMs : from).toISOString(),
    to: new Date(to).toISOString(),
    firstFrameIndex: 0,
    lastFrameIndex: Math.max(0, frames.length - 1),
    totalRecords: timed.length,
    skipped: list.length - timed.length,
    truncated,
    maxActive: frames.reduce((m, f) => Math.max(m, f.counts.total), 0),
  }
}

/** A short human label for a frame: `1985-01` for a month, `1985-01-04` for a day. */
function frameLabel(ms, bucket) {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  if (bucket === 'year' || bucket === 'decade') return String(y)
  if (bucket === 'month') return `${y}-${m}`
  if (bucket === 'hour') return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}Z`
  return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * What changed between two frames, as one sentence.
 *
 * The slider's own label is a date. A reader scrubbing needs to know whether the
 * frame they landed on is a turning point, and a date does not say. This returns
 * the smallest honest sentence: nil when nothing changed, which is itself worth
 * showing rather than rendering an empty string the caller may drop.
 */
export function frameSummary(timeline, index) {
  const frame = timeline?.frames?.[index]
  if (!frame) return 'No frame at this position'
  if (!frame.opened.length && !frame.closed.length && !frame.escalated.length) {
    return `${frame.label}: ${frame.counts.total} active, unchanged`
  }
  const parts = []
  if (frame.opened.length) parts.push(`${frame.opened.length} began`)
  if (frame.closed.length) parts.push(`${frame.closed.length} ended`)
  if (frame.escalated.length) parts.push(`${frame.escalated.length} changed severity`)
  return `${frame.label}: ${parts.join(', ')} — ${frame.counts.total} active`
}

/**
 * The busiest frame, so a caller can offer "jump to peak" instead of making a
 * reader scrub a decade to find the flood.
 *
 * Ties resolve to the earliest frame: two frames of equal size are not equally
 * interesting, and the earlier one has more of the story after it in view.
 */
export function peakFrame(timeline) {
  let best = null
  for (const frame of timeline?.frames || []) {
    if (!best || frame.counts.total > best.counts.total) best = frame
  }
  return best
}