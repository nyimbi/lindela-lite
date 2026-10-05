import { fetchWithRetry } from './http.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { DEFAULT_COUNTRIES } from './ipc-hdx.js'
import { assessPagination, completenessVerdictName, mergeCompleteness } from '../completeness.js'

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

/** GDACS' own per-query result cap. The verdict depends on knowing its value. */
const WINDOW_CAP = 100


async function connectorIngest(options = {}) {
  const hazard_events = []
  const errors = []
  const startYear = Number.isFinite(options.archive_start_year)
    ? Number(options.archive_start_year)
    : 1985
  const thisQuarter = quarterOf(new Date())
  const countries = optionCountrySet(options)

  // One entry per planned window, in order. The walk's verdict is merged from
  // these at the end: a crawl needs one answer, not a verdict per page.
  const windowVerdicts = []
  const flaggedWindows = []
  let windowsPlanned = 0
  let pagesFetched = 0
  let recordsSeen = 0

  for (let year = startYear; year <= thisQuarter.year; year += 1) {
    // The current quarter is only complete up to today, but partial is fine —
    // the archive answers with what it has for the window.
    const lastQuarter = year === thisQuarter.year ? thisQuarter.quarter : 4
    for (let q = 1; q <= lastQuarter; q += 1) {
      const label = `${year}-Q${q}`
      windowsPlanned += 1
      try {
        const window = quarterRange(year, q)
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
      } catch (error) {
        errors.push(`gdacs_archive: window ${year}-Q${q}: ${error.message}`)
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
  }

  if (!completeness.complete) {
    // The verdict also travels in `errors` because that is the one channel
    // runIngestion carries into the source run's record; a run that returns a
    // verdict nobody stores is the defect this file was written to remove.
    errors.push(`gdacs_archive: archive walk is ${completenessVerdictName(merged)} — ${merged.reason}`)
  }

  if (!hazard_events.length && !errors.some((e) => /window/.test(e))) {
    errors.push('gdacs_archive: no flood events retained across the archive')
  }
  return { hazard_events, errors, completeness }
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
    },
    outputSchema: {
      hazard_events: 'flood archive events; severity null (GDACS publishes a fill-in zero for floods)',
      completeness: '{complete, possibly_incomplete, reason, counts_found, pages_fetched, windows_planned, records_seen, records_kept, walk_end, flagged_windows}; one verdict for the whole archive walk',
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