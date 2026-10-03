#!/usr/bin/env node
/**
 * A road-access record describes the present, and it was describing the archive.
 *
 * `occurred_at` was carried from the hazard record into the obstruction
 * descriptor and then never read. `computeRoadAccess` matched every hazard in
 * the store against every road, however old, and a 1985 GDACS archive flood
 * closed a road today with the same `access_status`, the same
 * `access_reason: 'Blocked by flood (red)'` and the same confidence as one
 * from this morning. `summarizeRoadAccess` then counted it in
 * `blocked_by_hazard_type` beside live events, so a dashboard could report
 * "cut off by flood: 4" with no way to tell that two of the four had not
 * happened since the second world war.
 *
 * The clock is a parameter because a recency rule that can only be tested by
 * waiting is a rule nobody tests. Every case below is a fixed instant.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeRoadAccess, summarizeRoadAccess } from '../src/road-access.js'

const NOW = new Date('2026-10-03T12:00:00.000Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const ROAD = {
	id: 'r1',
	name: 'Northern corridor',
	service_type: 'road',
	road_class: 'trunk',
	country: 'KE',
	latitude: -1.28,
	longitude: 36.81,
}

const floodAt = (over = {}) => ({
	id: 'h1',
	event_type: 'flood',
	severity: 'red',
	title: 'Flood warning',
	latitude: -1.28,
	longitude: 36.81,
	occurred_at: daysAgo(1),
	...over,
})

const access = (hazards, options = {}) => computeRoadAccess(
	{ service_assets: [ROAD], hazard_events: hazards },
	{ now: NOW, ...options },
)[0]

describe('a hazard blocks a road only while it is happening', () => {
	it('lets a flood from this morning close the road', () => {
		const road = access([floodAt({ occurred_at: daysAgo(1) })])
		assert.equal(road.access_status, 'impassable')
		assert.equal(road.access_basis, 'active')
		assert.equal(road.obstructions[0].temporal_status, 'active')
		assert.equal(road.obstructions[0].age_days, 1)
	})

	it('refuses to let a flood from 1985 close it', () => {
		const road = access([floodAt({ occurred_at: '1985-08-12T00:00:00.000Z' })])
		assert.notEqual(road.access_status, 'impassable',
			'a road-access record describes the present; a thirty-year-old archive entry is not evidence about the present')
		assert.equal(road.obstructions[0].temporal_status, 'stale')
		assert.equal(road.obstructions[0].blocking, false)
	})

	it('keeps the stale event in the record rather than deleting it', () => {
		// Deleting it would make the count on the map unanswerable. It is kept,
		// marked, and excluded from the blocking count.
		const road = access([floodAt({ occurred_at: daysAgo(400) })])
		assert.equal(road.obstructions.length, 1)
		assert.equal(road.obstructions[0].hazard_id, 'h1')
		assert.match(road.access_reason, /too old to describe the present/)
		assert.doesNotMatch(road.access_reason, /Blocked by flood/)
	})

	it('uses a different window for a landslide than for a flood', () => {
		// Standing water recedes in days; a deposit stays on the carriageway
		// until it is cleared. One window for both would be wrong twice.
		const slide = (age) => ({
			id: 'h2', event_type: 'landslide', severity: 'orange',
			title: 'Landslide', latitude: -1.28, longitude: 36.81, occurred_at: daysAgo(age),
		})
		assert.equal(access([slide(20)]).access_status, 'impassable', '20 days: still within the landslide window')
		assert.equal(access([floodAt({ occurred_at: daysAgo(20) })]).access_status, 'restricted',
			'20 days: well past the flood window')
	})

	it('honours an operator override of the window', () => {
		const road = access([floodAt({ occurred_at: daysAgo(30) })], { activeWindowDays: { flood: 90 } })
		assert.equal(road.access_status, 'impassable')
		assert.equal(road.obstructions[0].temporal_status, 'active')
	})

	it('accepts a hazard at exactly the window boundary', () => {
		// A seven-day-old flood on the seventh day is not yet out of window.
		// An off-by-one here would silently drop a real obstruction.
		assert.equal(access([floodAt({ occurred_at: daysAgo(7) })]).obstructions[0].temporal_status, 'active')
		assert.equal(access([floodAt({ occurred_at: daysAgo(7.001) })]).obstructions[0].temporal_status, 'stale')
	})

	it('does not drop a hazard that happened in the future', () => {
		// Flood forecasts are a declared event type and blocking on one is
		// defensible — but the record must not say a road is blocked by
		// something that has not happened yet.
		const road = access([floodAt({ occurred_at: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() })])
		assert.equal(road.access_status, 'impassable')
		assert.equal(road.obstructions[0].temporal_status, 'forecast')
		assert.match(road.access_reason, /Forecast flood/)
	})
})

describe('a missing date is not the same as an old one', () => {
	it('keeps blocking, and says it cannot vouch for the record', () => {
		const road = access([floodAt({ occurred_at: null })])
		assert.equal(road.access_status, 'impassable', 'an undated hazard is not safe to dismiss')
		assert.equal(road.obstructions[0].temporal_status, 'undated')
		assert.equal(road.obstructions[0].age_days, null)
	})

	it('treats an unparseable date as undated rather than as recent', () => {
		const road = access([floodAt({ occurred_at: 'last Tuesday' })])
		assert.equal(road.obstructions[0].temporal_status, 'undated')
		assert.equal(road.access_status, 'impassable')
	})

	it('does not report an absent date as zero days old', () => {
		// `age_days || 0` here would invent a flood that happened today.
		assert.equal(access([floodAt({ occurred_at: undefined })]).obstructions[0].age_days, null)
	})

	it('reports age zero for a hazard that happened at this instant', () => {
		assert.equal(access([floodAt({ occurred_at: NOW.toISOString() })]).obstructions[0].age_days, 0)
	})
})

describe('confidence distinguishes observed-clear from unexamined-clear', () => {
	it('is 100 for a road with no hazard near it at all', () => {
		assert.equal(access([]).confidence, 100)
		assert.equal(access([]).access_basis, 'current')
	})

	it('is lower for a road whose only evidence is undated', () => {
		// A green advisory ~1.7 km off the carriageway: inside the 2 km flood
		// radius so it is recorded, past the 1 km blocking distance so it does
		// not block. The road is reported restricted on the strength of a record
		// that cannot say when it happened.
		const undated = access([floodAt({
			occurred_at: null, severity: 'green', title: 'Advisory', longitude: 36.825,
		})])
		assert.equal(undated.access_status, 'restricted')
		assert.equal(undated.access_basis, 'undated')
		assert.ok(undated.confidence < 100,
			'"passable" beside an unexamined record is not the same claim as "observed clear"')
	})
})

describe('the summary cannot present history as live obstruction', () => {
	const data = {
		service_assets: [ROAD],
		hazard_events: [floodAt({ id: 'live', occurred_at: daysAgo(1) }), floodAt({ id: 'old', occurred_at: daysAgo(900) })],
	}

	it('counts only current obstructions as blocking', () => {
		const summary = summarizeRoadAccess(computeRoadAccess(data, { now: NOW }))
		assert.equal(summary.blocked_by_hazard_type.flood, 1, 'the 1985 event is not a live cut-off')
		assert.equal(summary.impassable, 1)
	})

	it('reports how much of the evidence speaks about the present', () => {
		const summary = summarizeRoadAccess(computeRoadAccess(data, { now: NOW }))
		assert.equal(summary.obstructions_by_temporal_status.active, 1)
		assert.equal(summary.obstructions_by_temporal_status.stale, 1)
	})

	it('reports zero roads rather than dividing by nothing', () => {
		const summary = summarizeRoadAccess([])
		assert.equal(summary.total_roads, 0)
		assert.equal(summary.cut_off_rate_pct, 0)
	})
})