#!/usr/bin/env node
/**
 * The month × year calendar, and the diverging ramp it needs.
 *
 * Two reasons this file exists.
 *
 * `heatmap` is the third of six chart primitives that were exported, tested and
 * called by nothing. `lineChart` and `stackedBar` are the other two. A primitive
 * nobody renders is a claim; rendering it is what makes it a feature.
 *
 * The signed-value problem it surfaced is the more interesting one. A sequential
 * ramp maps observed min..max onto light..dark, which for a quantity that can be
 * positive or negative puts the boundary between "cold" and "warm" in the middle
 * of whatever range happened to arrive. A −0.1 °C cell then reads as strongly
 * cold beside a −1.4 °C one, and the whole calendar looks like a cold snap. So
 * the ramp is pinned to zero, and the tests below pin that, because the bug is
 * invisible in a screenshot and only a colour assertion catches it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MONTH_LABELS, seasonalCalendar, seasonalCalendarNote } from '../public/shared/seasonal.js'
import { divergingHeatColor, heatmap, heatColor } from '../public/shared/charts.js'

/** An ENSO-shaped series: warm through the year, peaking late. */
function observations(years = [2024, 2025]) {
  const rows = []
  for (const year of years) {
    for (let month = 1; month <= 12; month += 1) {
      // Peaks in Nov–Dec, decays through the following spring.
      const phase = Math.cos(((month - 11) / 12) * 2 * Math.PI)
      rows.push({
        source: 'noaa_enso',
        source_id: `${year}-${String(month).padStart(2, '0')}`,
        value: Math.round(phase * 1000) / 1000,
      })
    }
  }
  return rows
}

describe('the calendar matrix', () => {
  it('lays out twelve months as columns and years as rows', () => {
    const calendar = seasonalCalendar(observations([2024, 2025]))
    assert.equal(calendar.columns.length, 12)
    assert.deepEqual(calendar.columns, [...MONTH_LABELS])
    assert.deepEqual(calendar.rows.map((r) => r.label), ['2024', '2025'])
    for (const row of calendar.rows) assert.equal(row.values.length, 12)
  })

  it('puts a value in the cell its period names, not the cell it lands in', () => {
    const calendar = seasonalCalendar(observations([2024]))
    const [row] = calendar.rows
    assert.equal(row.values[0], observations([2024]).find((o) => o.source_id === '2024-01').value)
    assert.equal(row.values[11], observations([2024]).find((o) => o.source_id === '2024-12').value)
  })

  it('leaves a month that was never ingested as null rather than filling it', () => {
    // The interpolation question. A gap filled from its neighbours produces a
    // number no connector measured, and on a diverging ramp it produces a
    // confident-looking colour too.
    const rows = observations([2025]).filter((o) => o.source_id !== '2025-06')
    const calendar = seasonalCalendar(rows)
    assert.equal(calendar.rows[0].values[5], null)
    assert.equal(calendar.ingestedMonths, 11)
    assert.equal(calendar.requestedMonths, 12)
  })

  it('treats a null value as absent, not as a measured zero', () => {
    // The trap this repository has already fallen into once: Number(null) is 0,
    // so a numeric filter that does not check presence first accepts every null
    // and paints a confident neutral cell.
    const rows = observations([2025]).map((o) => (o.source_id === '2025-06' ? { ...o, value: null } : o))
    const calendar = seasonalCalendar(rows)
    assert.equal(calendar.rows[0].values[5], null, 'a null anomaly is not a 0.00 °C neutral month')
    assert.equal(calendar.ingestedMonths, 11)
  })

  it('rejects an empty string for the same reason', () => {
    const rows = observations([2025]).map((o) => (o.source_id === '2025-06' ? { ...o, value: '' } : o))
    assert.equal(seasonalCalendar(rows).rows[0].values[5], null)
  })

  it('keeps a real zero, because zero degrees of anomaly is a real measurement', () => {
    const rows = [{ source: 'noaa_enso', source_id: '2025-06', value: 0 }]
    const calendar = seasonalCalendar(rows)
    assert.equal(calendar.rows[0].values[5], 0)
    assert.notEqual(calendar.rows[0].values[5], null)
  })

  it('ignores observations from other sources', () => {
    const rows = [
      ...observations([2025]),
      { source: 'open_meteo', source_id: '2025-13', value: 9 },
      { source: 'chirps', source_id: 'nonsense', value: 9 },
    ]
    const calendar = seasonalCalendar(rows)
    assert.equal(calendar.ingestedMonths, 12, 'a 13th month from another source is not in the grid')
  })

  it('rejects an impossible month rather than writing past the row', () => {
    const rows = [{ source: 'noaa_enso', source_id: '2025-13', value: 0.5 }]
    assert.equal(seasonalCalendar(rows), null, 'one impossible period is not a calendar')
  })

  it('returns null when nothing has been ingested', () => {
    // Null rather than an empty grid: a twelve-by-one grid of dashes reads as
    // "no anomaly this year", which is a claim about the Pacific.
    assert.equal(seasonalCalendar([]), null)
    assert.equal(seasonalCalendar(null), null)
  })

  it('sorts years ascending', () => {
    const calendar = seasonalCalendar(observations([2026, 2024, 2025]))
    assert.deepEqual(calendar.rows.map((r) => r.label), ['2024', '2025', '2026'])
  })

  it('reports the span against zero, not against the observed extremes', () => {
    // A series that is only ever warm must still scale symmetrically, or a +0.1
    // cell renders as saturated and a reader sees a severe event.
    const calendar = seasonalCalendar([{ source: 'noaa_enso', source_id: '2025-01', value: 0.2 }])
    assert.equal(calendar.span, 0.2)
  })

  it('never reports a span of zero, which would divide by zero at render time', () => {
    const calendar = seasonalCalendar([
      { source: 'noaa_enso', source_id: '2025-01', value: 0 },
      { source: 'noaa_enso', source_id: '2025-02', value: 0 },
    ])
    assert.ok(calendar.span > 0, 'a flat series still has to render')
  })
})

describe('the note under the calendar', () => {
  it('counts months above and below the advisory threshold', () => {
    const calendar = seasonalCalendar([
      { source: 'noaa_enso', source_id: '2025-01', value: 0.9 },
      { source: 'noaa_enso', source_id: '2025-02', value: -0.9 },
      { source: 'noaa_enso', source_id: '2025-03', value: 0.1 },
    ])
    const note = seasonalCalendarNote(calendar)
    assert.match(note, /1 at or above the \+0\.5 °C advisory threshold/)
    assert.match(note, /1 at or below −0\.5 °C/)
    assert.match(note, /9 not ingested/)
  })

  it('says what a cell is a departure from', () => {
    // The clause that stops the calendar being read as a second opinion on the
    // base period: it is NOAA's anomaly, not this platform's median.
    assert.match(seasonalCalendarNote(seasonalCalendar(observations([2025]))), /CPC base/)
  })

  it('reports not-ingested rather than drawing an empty grid', () => {
    assert.match(seasonalCalendarNote(null), /has not been ingested/)
  })
})

describe('the diverging ramp', () => {
  it('paints either side of the pivot differently', () => {
    const warm = divergingHeatColor(1, 0, 2)
    const cold = divergingHeatColor(-1, 0, 2)
    assert.notEqual(warm, cold)
    assert.match(warm, /--brand/)
    assert.match(cold, /--cold/)
  })

  it('gives equal magnitudes equal strength, whatever the sign', () => {
    // The property a single sequential ramp cannot have: it would need the two
    // extremes to be symmetric about the pivot, which they generally are not.
    assert.equal(divergingHeatColor(-1.4, 0, 2), divergingHeatColor(1.4, 0, 2).replace('brand', 'cold'))
    assert.match(divergingHeatColor(-1.4, 0, 2), /70%/)
  })

  it('leaves the pivot as plain surface, so neutral is visible as neutral', () => {
    assert.match(divergingHeatColor(0, 0, 2), /0%/)
  })

  it('clamps rather than emitting an invalid colour for a value outside the span', () => {
    assert.match(divergingHeatColor(99, 0, 2), /100%/)
    assert.doesNotThrow(() => divergingHeatColor(99, 0, 2))
  })

  it('draws nothing for a value it cannot read', () => {
    assert.equal(divergingHeatColor(null, 0, 2), 'none')
    assert.equal(divergingHeatColor(undefined, 0, 2), 'none')
  })
})

describe('heatmap honours the diverging option', () => {
  const data = {
    columns: ['Jan', 'Feb'],
    rows: [
      { label: '2025', values: [-1.5, 0.1] },
      { label: '2026', values: [1.4, 0.0] },
    ],
    title: 'test',
  }

  it('renders by default with the sequential ramp, unchanged', () => {
    // The existing 50 chart tests already pin this, but the option was added to
    // a shipped primitive, so the default is asserted here too rather than
    // relying on a reader of the diff to notice.
    const chart = heatmap(data)
    assert.match(chart.svg, /--brand/)
    assert.doesNotMatch(chart.svg, /--cold/)
  })

  it('renders the cold cell with the cool token when diverging', () => {
    const chart = heatmap(data, { diverging: true })
    assert.match(chart.svg, /--cold/)
    assert.match(chart.svg, /--brand/)
  })

  it('does not let a near-zero warm cell look like the cold extreme', () => {
    // The defect this option exists for, asserted on the output rather than on
    // the option's presence.
    const sequential = heatmap(data)
    const diverging = heatmap(data, { diverging: true })
    assert.notEqual(sequential.svg, diverging.svg)

    // The property, not a magic number: the near-zero warm cell must be
    // unmistakably weaker than the cold extreme. Asserting a literal intensity
    // here pinned the ramp to whatever arithmetic it happened to use on this
    // fixture and broke when the span calculation was corrected.
    const pct = (css) => Number(/(\d+)%/.exec(css)?.[1] ?? -1)

    // The fixture's span is max|v| = 1.5, so +0.1 sits at ~7% and -1.5 at 100%.
    // The claim under test is that the weak warm departure and the cold extreme
    // do not read as the same magnitude — asserted on the two cells, not on the
    // strongest warm cell in the grid, which is a different value entirely.
    const weakWarm = pct(divergingHeatColor(0.1, 0, 1.5))
    const coldExtreme = pct(divergingHeatColor(-1.5, 0, 1.5))
    assert.ok(weakWarm >= 0 && weakWarm < 20, `a near-zero warm cell must stay faint, got ${weakWarm}%`)
    assert.ok(coldExtreme >= 90, `the cold extreme must read as extreme, got ${coldExtreme}%`)

    assert.match(diverging.svg, /--brand\)/, 'the warm side of the ramp is drawn')
    assert.match(diverging.svg, /--cold\)/, 'the cool side of the ramp is drawn')
  })

  it('keeps a gap a gap under either ramp', () => {
    const withGap = { ...data, rows: [{ label: '2025', values: [null, 0.1] }] }
    for (const options of [{}, { diverging: true }]) {
      const chart = heatmap(withGap, options)
      assert.match(chart.svg, /chart-cell-missing/)
      assert.equal(chart.missing, 1)
    }
  })

  it('labels the colour range symmetrically about the pivot', () => {
    const chart = heatmap(data, { diverging: true, format: (v) => v.toFixed(1) })
    // The caption under the grid must not claim a range the ramp does not use.
    assert.match(chart.svg, /-1\.5 – 1\.5/)
  })

  it('still returns the sequential helper unchanged for its other callers', () => {
    assert.match(heatColor(0.5), /--brand\) 50%/)
    assert.equal(heatColor(null), heatColor(0))
  })
})