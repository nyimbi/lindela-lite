// =============================================================
// Lindela Lite — ENH-18 wiring: stepping through the hazard archive
// =============================================================
// The console draws the current situation and, beside it, a dot for every hazard
// in the archive. Nothing connects the two: a reader cannot ask "what was on the
// map a month ago". This is that — a time stepper over the records the console
// already holds, using `buildFrames` to bucket them and `frameSummary` to say
// what changed between one frame and the next. `peakFrame` is what makes it
// usable: a decade of frames is a scrubber nobody completes, so the busiest one
// is one click away.
//
// **Frame control only.** This reads the store and moves a highlight; it fetches
// nothing new and changes no number. A stepper that silently re-queried the API
// per frame would turn a control into a load test on a field connection.
//
// Statically imported by `app.js` through `lazy()` — see `wire-uncertainty.js`
// for why a dynamic import is free in the first-load budget.

import { buildFrames, frameSummary, peakFrame } from '/shared/viz-playback.js'
import { barChart } from '/shared/charts.js'
import { esc } from '/shared/fmt.js'

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }

/**
 * Normalise a store record into the shape `buildFrames` buckets.
 *
 * The two sources use different time field names — GDACS writes `occurred_at`,
 * an alert event `created_at` — and `buildFrames` reads a fixed list that
 * contains neither. Renaming here rather than in the module keeps the one place
 * that decides "what time is this record" in the console, where the answer is
 * visible.
 *
 * An alert has a duration and a hazard event does not, so alerts get an explicit
 * `end` and hazards keep the module's open-ended handling: a hazard with no end
 * stays active through the rest of the timeline rather than vanishing after the
 * minute it was filed.
 */
function normalise(record, kind) {
  const at = record?.occurred_at ?? record?.created_at ?? record?.started_at ?? record?.observed_at ?? record?.event_time ?? null
  const region = record?.region_name
    || record?.country
    || record?.scope?.district
    || (Array.isArray(record?.scope?.regions) ? record.scope.regions[0] : null)
    || null
  return {
    id: record?.id ?? `${kind}:${at}:${region ?? ''}`,
    severity: record?.severity ?? null,
    kind,
    region_name: region,
    start: at,
    end: kind === 'alert' ? (record?.updated_at ?? record?.created_at ?? null) : null,
    label: record?.title ?? record?.rule_name ?? record?.message ?? null,
  }
}

/** A short label for one record, so the frame list is readable. */
function labelOf(entry) {
  const text = String(entry.label ?? entry.id ?? '').trim().replace(/\s+/g, ' ')
  return text.length > 72 ? `${text.slice(0, 71)}…` : text
}

/**
 * Give a `charts.js` drawing a name.
 *
 * `charts.js` marks every classic chart `role="presentation" aria-hidden="true"`.
 * That is a contract, not an oversight: the library's rule is that the caller
 * supplies the accessible equivalent — the `.table` field, or prose beside it.
 * This panel ships neither, because a 36-bar timeline whose every cell is also
 * listed in a table nobody opens is a table with a chart bolted on. So the
 * drawing is re-labelled here instead, using what the caller already knows about
 * the data. The replacement is scoped to the opening `<svg>` tag: the same string
 * appears nowhere inside the body, and an svg with two `<title>` elements names
 * itself with the first and leaves the second unannounced.
 */
function nameChart(svg, title, desc) {
  return String(svg).replace(/^<svg([^>]*)>/, (_match, attrs) => `<svg${attrs
    .replace(/\s*role="presentation"/, '')
    .replace(/\s*aria-hidden="true"/, '')
    .replace(/\s*focusable="false"/, '')}>`
    + `<title>${esc(title)}</title><desc>${esc(desc)}</desc>`)
}

/**
 * The busiest-frame jump button's own state.
 *
 * Disabled rather than hidden when every frame is empty: a control that appears
 * only on some data teaches an operator that the archive is sometimes
 * scrubbable and sometimes not, which is not what is happening.
 */
function setPeakEnabled(button, peak) {
  if (!button) return
  const usable = Boolean(peak) && peak.counts.total > 0
  button.disabled = !usable
  button.textContent = usable
    ? `Jump to peak (${peak.label}, ${peak.counts.total} active)`
    : 'Jump to peak'
}

/**
 * The bucket the archive is stepped in.
 *
 * Daily is the useful unit for "what happened this week" and useless for "what
 * happened this year": a decade of daily frames is ten thousand stops, most of
 * them identical, and the reader stops before the second month. The span decides,
 * not a constant, so an archive that grows past the threshold changes granularity
 * instead of quietly becoming unscrubbable.
 */
function bucketFor(records, requested) {
  if (requested) return requested
  const times = records
    .map((r) => Date.parse(r?.start ?? ''))
    .filter((ms) => Number.isFinite(ms))
  if (times.length < 2) return 'day'
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400e3
  if (spanDays > 400) return 'month'
  if (spanDays > 90) return 'week'
  return 'day'
}

/**
 * Build the playback against a set of hosts and records.
 *
 * Returns a handle whose `step` moves the frame. The console keeps the handle
 * so a refresh can re-point it at a new timeline without rebuilding the DOM, and
 * so the stepper's listeners are attached exactly once.
 */
export function createPlayback({ step, summary, chart, peak }, records, options = {}) {
  const list = (records || []).filter(Boolean)
  const timeline = buildFrames(list, { bucket: bucketFor(list, options.bucket) })

  if (!timeline.frames.length) {
    if (step) { step.disabled = true; step.max = '0'; step.value = '0' }
    if (chart) chart.innerHTML = ''
    if (summary) {
      summary.textContent = list.length
        ? `${list.length} record(s) carry no timestamp this stepper can bucket, so there is no timeline to step through.`
        : 'No hazard records in the store yet, so there is no timeline to step through.'
    }
    setPeakEnabled(peak, null)
    return { timeline, step: () => {} }
  }

  // The archive as one bar per frame: the shape of the history before the reader
  // commits to a position in it. Every frame holds at least one record
  // (`buildFrames` drops empty buckets), so a flat row here means a genuinely
  // steady archive rather than a series with holes the chart swallowed.
  //
  // The chart draws the most recent slice, not the whole archive: past a few
  // dozen frames the axis labels overlap into an unreadable stripe, and an
  // unreadable chart is worse than a bounded one that says what it left out. The
  // stepper still spans everything.
  if (chart) {
    const MAX_BARS = 48
    const from = Math.max(0, timeline.frames.length - MAX_BARS)
    const shown = timeline.frames.slice(from)
    const labelStride = Math.max(1, Math.ceil(shown.length / 4))
    // Most hazard feeds report no end date, and `buildFrames` deliberately keeps
    // such a record active for the rest of the timeline rather than dropping it
    // after the minute it was filed. So the series rises as the archive
    // accumulates instead of rising and falling like a weather record. Saying so
    // is the difference between a reader seeing "the archive got busier" and one
    // seeing "floods are getting worse".
    const openEnded = list.filter((r) => r?.end === null || r?.end === undefined).length
    const openEndedNote = openEnded
      ? `${openEnded} of ${list.length} records carry no end date and stay active for the rest of the timeline, so a rising count is the archive accumulating, not a worsening situation.`
      : `${list.length} records carry an end date, so each frame's count is the situation at that moment.`
    const drawn = barChart({
      // `barChart` draws a tick label for every category, and 36 date labels at
      // 480 units wide overlap into a single unreadable stripe. Blanking all but
      // every Nth label — and never the last — thins the axis without touching
      // the library or dropping a bar.
      labels: shown.map((f, i) => (i % labelStride === 0 || i === shown.length - 1 ? f.label : '')),
      series: [{ name: 'Active records', values: shown.map((f) => f.counts.total), color: 'var(--brand)' }],
      title: 'Records active per frame across the hazard archive',
      xLabel: 'Frame',
      format: (v) => String(Math.round(v)),
      caption: `Active hazard and alert records per ${timeline.bucket}, across ${timeline.frames.length} frames.`,
      empty: 'No frames to draw',
    }, { height: 130, pad: { bottom: 46, left: 40 } })
    chart.innerHTML = nameChart(
      drawn.svg,
      'Records active per frame across the hazard archive',
      `Active hazard and alert records per ${timeline.bucket}, for the ${shown.length} most recent of `
      + `${timeline.frames.length} frames, from ${shown[0].label} to ${shown[shown.length - 1].label}. `
      + `The busiest frame holds ${Math.max(0, ...shown.map((f) => f.counts.total))} active records.`
      + ` ${openEndedNote}`
      + ' The stepper below reaches every frame, including the ones this chart leaves out.')
      + `<p class="chart-panel-note">${esc(openEndedNote)}</p>`
      + (from > 0
      ? `<p class="chart-panel-note">The chart shows the ${shown.length} most recent of ${timeline.frames.length} frames; the stepper reaches all of them.</p>`
      : '')
  }

  const peakFrameAt = peakFrame(timeline)
  // The console repaints every thirty seconds. Without carrying the frame
  // across the rebuild, a reader who had stepped to March would be thrown back
  // to the first frame mid-sentence by a poll that changed nothing they were
  // looking at.
  let index = Math.min(Math.max(options.startIndex ?? timeline.firstFrameIndex, timeline.firstFrameIndex), timeline.lastFrameIndex)

  const paint = () => {
    const frame = timeline.frames[index]
    if (!frame) return
    if (step) {
      step.value = String(index)
      // The value a screen reader reads for a slider is the number, which on a
      // date axis means "47". The date has to be in the accessible name.
      step.setAttribute('aria-valuetext', `${frame.label}, ${frame.counts.total} active`)
    }
    if (summary) {
      const ranked = [...frame.active]
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
        .slice(0, 6)
      const severities = Object.entries(frame.counts.bySeverity)
        .sort((a, b) => b[1] - a[1])
        .map(([sev, n]) => `${n} ${sev}`)
        .join(', ')
      summary.innerHTML = `${esc(frameSummary(timeline, index))}`
        + `${severities ? ` — ${esc(severities)}` : ''}`
        + `<br /><span class="chart-panel-note">${timeline.truncated ? 'The archive extends past this window; the walk stopped at the module’s frame cap. ' : ''}`
        + `${timeline.skipped} record(s) had no usable timestamp and are not in any frame.</span>`
        + (ranked.length
          ? `<div class="chart-table"><table class="data-alt"><caption>Most severe records active in this frame</caption>`
            + '<thead><tr><th scope="col">Severity</th><th scope="col">Region</th><th scope="col">Record</th></tr></thead><tbody>'
            + ranked.map((r) => `<tr><td>${esc(r.severity || 'unspecified')}</td>`
              + `<td>${esc(r.region_name || '—')}</td>`
              + `<td>${esc(labelOf(r))}</td></tr>`).join('')
            + '</tbody></table></div>'
          : '')
    }
  }

  if (step) {
    step.disabled = false
    step.min = String(timeline.firstFrameIndex)
    step.max = String(timeline.lastFrameIndex)
    step.step = '1'
    step.setAttribute('aria-valuemin', String(timeline.firstFrameIndex))
    step.setAttribute('aria-valuemax', String(timeline.lastFrameIndex))
    step.setAttribute('aria-label', `Frame within the hazard archive, ${timeline.bucket} buckets, ${timeline.frames.length} frames from ${timeline.frames[0].label} to ${timeline.frames[timeline.frames.length - 1].label}`)
    step.oninput = () => { index = Number(step.value) || 0; paint() }
  }
  if (peak) {
    peak.onclick = () => {
      const target = peakFrame(timeline)
      if (!target) return
      index = target.index
      paint()
    }
  }
  setPeakEnabled(peak, peakFrameAt)
  paint()

  return {
    timeline,
    step: (to) => { index = Math.max(timeline.firstFrameIndex, Math.min(timeline.lastFrameIndex, to)); paint() },
  }
}

/**
 * Both record sources, normalised.
 *
 * Split out from `createPlayback` so the console does not have to know that a
 * hazard event and an alert event spell their timestamps differently.
 */
export function playbackRecords({ hazards = [], alerts = [] }) {
  return [
    ...hazards.map((r) => normalise(r, 'hazard')),
    ...alerts.map((r) => normalise(r, 'alert')),
  ]
}