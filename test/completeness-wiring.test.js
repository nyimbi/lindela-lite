#!/usr/bin/env node
/**
 * ENH-14's other half: the module existed, was tested, and nothing called it.
 *
 * `test/pagination-completeness.test.js` drives `assessPagination`,
 * `recordCap` and `mergeCompleteness` directly and proves the arithmetic is
 * right. It cannot prove the arithmetic is *reached*: a connector that never
 * imports the module passes that suite completely. This file closes the gap by
 * driving `chirpsConnector.ingest` and `gdacsArchiveConnector.ingest` against a
 * stubbed `globalThis.fetch` and asserting on what the connectors return.
 *
 * Nothing here reads a connector's source. Grepping chirps.js for
 * `recordCap(` passes just as happily against a call that never executes, which
 * is the defect this file exists to rule out — the same rule the ingestion
 * wiring suite states and the reason it drove `runIngestion` rather than
 * reading it.
 *
 * Every fixture is built from the shape the connector actually parses: CHIRPS
 * from the `chirps-v2.0.YYYY.MM.DD.tif.gz` hrefs its regex matches, GDACS from
 * the GeoJSON `features` array and the `properties` its filter reads
 * (`eventtype`, `iso3`, `eventid`). A first draft of a fixture elsewhere in this
 * repo used field names the connector did not emit, and every "clean" batch was
 * correctly quarantined.
 *
 * The verdict vocabulary is checked the same way `pagination-completeness` does
 * it: derived from the booleans the connector returned and asserted against the
 * frozen list, so a new verdict cannot appear here undeclared.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { chirpsConnector } from '../src/connectors/chirps.js'
import { gdacsArchiveConnector } from '../src/connectors/gdacs-archive.js'
import { COMPLETENESS_VERDICTS } from '../src/completeness.js'

const THIS_YEAR = new Date().getUTCFullYear()

/** The connector's own vocabulary readback, computed from what it returned. */
function verdictName(verdict) {
  assert.ok(verdict, 'the connector returned no completeness block at all')
  if (verdict.complete === true) return 'complete'
  return verdict.possibly_incomplete === true ? 'possibly_incomplete' : 'incomplete'
}

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * A CHIRPS index. `days` distinct daily hrefs starting at `startISO`, which is
 * what the connector's `FILE_PATTERN` matches; the root listing offers the year
 * directory the connector then walks one level down.
 */
function chirpsIndex({ days = 0, startISO = '2026-01-01', years = ['2026'] } = {}) {
  const listing = (year, count, offset) => Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.parse(startISO) + (offset + i) * 86400000)
    const date = `${year}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`
    return `<a href="chirps-v2.0.${date}.tif.gz">chirps-v2.0.${date}.tif.gz</a>`
  }).join('')
  const root = years.map((y) => `<a href="${y}/">${y}/</a>`).join('')
  // A Response-shaped stub, like the GDACS one below. `fetch` returns a
  // Response; returning the HTML directly left `response.status` undefined and
  // every walk died on "HTTP undefined" before reaching a single file.
  const html = (body) => ({ ok: true, status: 200, text: async () => body })
  return (url) => {
    const target = String(url)
    const year = years.find((y) => target.includes(`/${y}/`))
    if (!year) return html(root)
    // 2026 gets the days it was asked for; earlier years get a couple, so a
    // multi-year walk is a walk with more than one page behind it.
    return html(listing(year, year === years[0] ? days : 2, year === years[0] ? 0 : 300))
  }
}

/**
 * A GDACS archive FeatureCollection.
 *
 * `properties` carries exactly what `recordFromFeature` reads. `iso3: 'KEN'` is
 * inside the default Sub-Saharan Africa country set, so a flood survives the
 * filter; a non-`FL` eventtype is the event the connector drops in process.
 */
function gdacsFeatures(count, { eventtype = 'FL', iso3 = 'KEN' } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    geometry: { coordinates: [35.0, 3.5] },
    properties: {
      eventtype,
      iso3,
      eventid: `${eventtype}-${iso3}-${i}`,
      eventname: `Flood ${i}`,
      alertlevel: 'Green',
      fromdate: '2026-01-02T00:00:00Z',
      todate: '2026-01-09T00:00:00Z',
      // A fill-in zero, which the connector stores as null.
      severitydata: { severity: 0.0, severitytext: 'Magnitude 0.00' },
    },
  }))
}

/** Stub for the GDACS archive: `perWindow(fromDate)` decides each response. */
function gdacsArchive(perWindow) {
  return async (url) => {
    const target = new URL(String(url))
    const from = target.searchParams.get('fromDate')
    const answer = await perWindow(from)
    if (answer instanceof Error) throw answer
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(answer),
    }
  }
}

describe('chirps: what the walk found, what it kept, and what it dropped', () => {
  it('reports the pre-cap count that used to reach nobody', async () => {
    const result = await withStubbedFetch(chirpsIndex({ days: 365 }), () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 }))

    assert.equal(result.climate_observations.length, 30, 'the cap still applies')
    assert.equal(result.completeness.counts_found, 365,
      'the 335 dropped daily files are the whole point of the record')
    assert.equal(result.completeness.records_kept, 30)
    assert.equal(result.completeness.capped, true)
    assert.ok(COMPLETENESS_VERDICTS.includes(verdictName(result.completeness)))
    assert.equal(result.completeness.complete, false)
    assert.ok(!result.completeness.possibly_incomplete,
      'a counted shortfall is an answer, not a guess, so it is not the possibly_incomplete tier')
    assert.match(result.completeness.reason, /short by 335/)
  })

  it('says the walk was short on the run record, not only to a direct caller', async () => {
    // `errors` is the one field runIngestion carries from a connector's return
    // value into `source_runs[].errors`, so a verdict returned and never
    // recorded there is the defect this file was written against.
    const result = await withStubbedFetch(chirpsIndex({ days: 365 }), () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 }))

    const line = result.errors.find((e) => /chirps: walk is/.test(e))
    assert.ok(line, `expected a completeness line among ${JSON.stringify(result.errors)}`)
    assert.ok(COMPLETENESS_VERDICTS.includes(line.match(/walk is (\w+)/)[1]))
    assert.match(line, /short by 335/)
  })

  it('stays quiet when nothing was dropped', async () => {
    // The other direction. A guard that condemns healthy data is worse than no
    // guard: operators learn to ignore the signal that would have told them
    // data was lost.
    const result = await withStubbedFetch(chirpsIndex({ days: 12 }), () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 }))

    assert.equal(result.climate_observations.length, 12)
    assert.equal(result.completeness.complete, true)
    assert.equal(result.completeness.possibly_incomplete, false)
    assert.equal(result.completeness.counts_found, 12)
    assert.equal(result.completeness.capped, false)
    assert.equal(result.completeness.cap_reason, null)
    assert.ok(!result.errors.some((e) => /walk is/.test(e)))
  })

  it('reaches the cap exactly on the same day it stops complaining', async () => {
    // The anti-vacuous pair: identical 30 files, one limit that they fill and
    // one that they do not. A completeness block that returned a constant would
    // pass every other assertion in this file and fail here.
    const html = chirpsIndex({ days: 30 })
    const filled = await withStubbedFetch(html, () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0, limit: 30 }))
    const roomy = await withStubbedFetch(html, () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0, limit: 31 }))

    assert.equal(filled.climate_observations.length, roomy.climate_observations.length)
    assert.equal(verdictName(filled.completeness), 'possibly_incomplete',
      'a slice filled to its limit is the shape that means there may have been more')
    assert.equal(verdictName(roomy.completeness), 'complete')
    assert.equal(filled.completeness.capped, true)
    assert.equal(roomy.completeness.capped, false)
  })

  it('counts the files it actually found, over every directory it probed', async () => {
    // 365 in 2026 plus 2 in 2025, walked because the index offers both. A count
    // that ignored the second page would still look plausible.
    const result = await withStubbedFetch(chirpsIndex({ days: 365, years: ['2026', '2025'] }), () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 }))

    assert.equal(result.completeness.pages_fetched, 2)
    assert.equal(result.completeness.counts_found, 367)
    assert.equal(result.completeness.records_kept, 30)
  })

  it('records no count at all when it found nothing, rather than recording zero', async () => {
    // The falsy-zero case, and the reason the module distinguishes them: "we
    // looked and the index was empty" is a finding, and zero found is not the
    // same claim as zero counted.
    const result = await withStubbedFetch(chirpsIndex({ days: 0 }), () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 }))

    assert.equal(result.climate_observations.length, 0)
    assert.equal(result.completeness.counts_found, null)
    assert.notEqual(result.completeness.counts_found, 0)
    assert.ok(result.errors.some((e) => /found no daily files/.test(e)),
      'a directory that probed clean and held nothing is still an error')
  })

  it('puts the verdict on the run rather than on every record', async () => {
    // The design question, asserted rather than argued: no record from a
    // truncated walk is individually suspect, and a flag on each one would let
    // `WHERE possibly_incomplete = false` silently drop a whole quarter of real
    // observations. The accounting lives on the return value.
    const result = await withStubbedFetch(chirpsIndex({ days: 365 }), () =>
      chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 }))

    assert.equal(result.completeness.complete, false)
    assert.ok(result.climate_observations.length > 0)
    for (const observation of result.climate_observations) {
      assert.equal(observation.possibly_incomplete, undefined)
      assert.equal(observation.metadata?.possibly_incomplete, undefined)
      assert.equal(observation.metadata?.completeness, undefined)
    }
  })
})

describe('gdacs_archive: a capped quarter is no longer a quiet quarter', () => {
  it('flags the window that came back at the cap and names it', async () => {
    const result = await withStubbedFetch(
      gdacsArchive((from) => ({ features: gdacsFeatures(from.endsWith('-03-31') ? 100 : 12) })),
      () => gdacsArchiveConnector.ingest({ archive_start_year: THIS_YEAR, retries: 0 }))

    const completeness = result.completeness
    assert.ok(completeness, 'the archive walk returned no completeness block')
    assert.equal(completeness.complete, false)
    assert.equal(verdictName(completeness), 'possibly_incomplete')
    assert.deepEqual(completeness.flagged_windows, [`${THIS_YEAR}-Q1`])
    assert.equal(completeness.pages_fetched, completeness.windows_planned)
    assert.equal(completeness.walk_end, 'plan_exhausted')
    // Both pieces of evidence named: the page shape and the cap. Naming one and
    // hiding the other leaves the next reader guessing which limit bit.
    assert.match(completeness.reason, /last page came back exactly full/)
    assert.match(completeness.reason, /source cap was reached/)
    assert.ok(result.errors.some((e) => /gdacs_archive: archive walk is possibly_incomplete/.test(e)))
  })

  it('leaves an uncapped walk alone', async () => {
    const result = await withStubbedFetch(
      gdacsArchive(() => ({ features: gdacsFeatures(24) })),
      () => gdacsArchiveConnector.ingest({ archive_start_year: THIS_YEAR, retries: 0 }))

    assert.equal(result.completeness.complete, true)
    assert.equal(result.completeness.possibly_incomplete, false)
    assert.deepEqual(result.completeness.flagged_windows, [])
    assert.ok(!result.errors.some((e) => /archive walk is/.test(e)),
      'a complete archive must not report as a degraded one')
  })

  it('counts records seen separately from records kept', async () => {
    // Half cyclones, filtered in process: the gap between the two counts is a
    // decision the connector makes, not a shortfall, and collapsing them would
    // make every filtered source look truncated.
    const result = await withStubbedFetch(
      gdacsArchive(() => ({ features: [...gdacsFeatures(10), ...gdacsFeatures(10, { eventtype: 'TC' })] })),
      () => gdacsArchiveConnector.ingest({ archive_start_year: THIS_YEAR, retries: 0 }))

    const windows = result.completeness.windows_planned
    assert.equal(result.completeness.records_seen, 20 * windows)
    assert.equal(result.completeness.records_kept, 10 * windows)
    assert.equal(result.completeness.counts_found, 20 * windows)
    assert.ok(result.completeness.records_seen > result.completeness.records_kept)
  })

  it('treats an unreadable window as worse than a capped one', async () => {
    // A window nobody read leaves an unknown hole. `possibly_incomplete` means
    // "there may have been more behind us"; a failed fetch means we do not know
    // what is there, and the run must not be reported as a guess about it.
    const result = await withStubbedFetch(
      gdacsArchive((from) => (from.endsWith('-03-31') ? new Error('HTTP 503') : { features: gdacsFeatures(12) })),
      () => gdacsArchiveConnector.ingest({ archive_start_year: THIS_YEAR, retries: 0 }))

    const completeness = result.completeness
    assert.equal(verdictName(completeness), 'incomplete')
    assert.equal(completeness.complete, false)
    assert.equal(completeness.possibly_incomplete, false)
    assert.equal(completeness.walk_end, 'plan_abandoned')
    assert.equal(completeness.windows_stopped_before, 1)
    // Every planned window was assessed; not every one came back. Those two
    // numbers are equal only when nothing failed, which is why they are both
    // recorded.
    assert.equal(completeness.pages, completeness.windows_planned)
    assert.equal(completeness.pages_fetched, completeness.windows_planned - 1)
    assert.match(completeness.reason, /was not read/)
    assert.ok(result.errors.some((e) => /HTTP 503/.test(e)))
  })

  it('does not read an empty window as evidence of an empty quarter', async () => {
    // GDACS returning zero features for a window is as likely to be an upstream
    // gap as a quiet quarter, and the walk-around is quarter windows precisely
    // because individual windows are unreliable.
    const result = await withStubbedFetch(
      gdacsArchive((from) => ({ features: gdacsFeatures(from.endsWith('-03-31') ? 0 : 12) })),
      () => gdacsArchiveConnector.ingest({ archive_start_year: THIS_YEAR, retries: 0 }))

    assert.equal(verdictName(result.completeness), 'incomplete')
    assert.ok(result.errors.some((e) => /returned no features/.test(e)))
    assert.ok(result.errors.some((e) => /archive walk is incomplete/.test(e)))
  })

  it('reports a flood the filter kept and a cyclone it dropped', async () => {
    // The fixture has to be the shape the connector emits, or this whole file
    // measures the stub instead of the connector.
    const result = await withStubbedFetch(
      gdacsArchive(() => ({ features: [...gdacsFeatures(2), ...gdacsFeatures(3, { eventtype: 'TC' })] })),
      () => gdacsArchiveConnector.ingest({ archive_start_year: THIS_YEAR, retries: 0 }))

    assert.ok(result.hazard_events.length > 0)
    for (const record of result.hazard_events) {
      assert.equal(record.event_type, 'flood')
      assert.equal(record.severity, null, 'the fill-in zero is not a measurement')
      assert.equal(record.possibly_incomplete, undefined,
        'a record is a complete claim about one event; the walk is the uncertain thing')
    }
  })
})