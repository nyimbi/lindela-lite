#!/usr/bin/env node
/**
 * The defects that survived the first pass, each with the shape that hid it.
 *
 * Six of the eight below are the same recurring class the codebase has already
 * been bitten by three times — a list or a mapping written in two places, where
 * the two copies agree until someone edits one of them. The value of a shared
 * list is not that it is shorter. It is that the edit has exactly one place to
 * happen, so there is nothing to forget.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { updateAlertEvent } from '../src/alerts.js'
import { renderCapXml } from '../src/cap.js'
import { applyRetention, loadPolicy, redactPii, retentionWindowDays } from '../src/pii.js'
import { counts } from '../src/operations.js'
import { elevationWindowFromTile, lonLatToTile } from '../src/terrain.js'
import { STAC_COLLECTIONS, resolveStacCollection, stacCatalog, stacCollection, ogcFeatureCollection } from '../src/stac.js'
import { toGeoJson, readCoordinate } from '../src/utils.js'

// -------------------------------------------------------------------

describe('a void terrain sample is not sea level', () => {
	// `elevationWindowFromTile` is pure, so none of this needs a network.
	//
	// `elevationFromTile` returns null when *any* of the four corners it
	// interpolates between is nodata — conservative, and correct. So a void
	// region spreads one cell past its own boundary, which means the test has to
	// use a tile with enough valid area to sample from rather than expecting a
	// hard-edged split.
	const ZOOM = 12
	const LAT = 0
	const LON = 0
	const tile = lonLatToTile(LON, LAT, ZOOM)

	const grid = (values) => ({ width: 3, height: 3, grid: new Float64Array(values) })
	const solid = grid([100, 110, 120, 100, 110, 120, 100, 110, 120])
	const withVoid = grid([NaN, NaN, 120, NaN, NaN, 120, NaN, NaN, 120])

	const sample = (decoded) =>
		[...elevationWindowFromTile(decoded, tile, ZOOM, LAT, LON, { radiusDeg: 0.001, size: 3 }).values]

	it('reads a fully covered tile as finite elevations', () => {
		const values = sample(solid)
		assert.equal(values.length, 9)
		assert.ok(values.every(Number.isFinite), 'a covered tile has no void samples to report')
		assert.ok(values.every((v) => v >= 99 && v <= 121), `unexpected range: ${values.join(',')}`)
	})

	it('cannot produce a finite number where the tile has no data', () => {
		const values = sample(withVoid)
		assert.ok(values.every((v) => !Number.isFinite(v)),
			'the window straddles a nodata region; every sample in it is unknown')
	})

	it('reports an absent sample as absent, never as zero', () => {
		// `values[i] = value` where value is null coerces to 0 in a Float64Array,
		// so the old code returned a 3×3 window of sea level. Zero is the one
		// elevation that is never right here: the platform would then compute a
		// local_relief_m of 0 m and call the terrain flat.
		assert.equal(sample(withVoid).filter((v) => v === 0).length, 0)
		assert.equal(sample(solid).filter((v) => v === 0).length, 0)
	})

	it('keeps a partially covered tile honest', () => {
		// 1°×1° window against a 3×3 tile: the sample straddles many pixels, so
		// with any nodata present almost everything is unknown. That is the
		// correct answer, and the number that must never appear is a zero.
		const wide = elevationWindowFromTile(withVoid, tile, ZOOM, LAT, LON, { radiusDeg: 0.5, size: 3 })
		const finite = [...wide.values].filter(Number.isFinite)
		assert.ok(finite.length <= 9)
		assert.equal([...wide.values].filter((v) => v === 0).length, 0)
	})

	it('serialises an absent sample as null rather than NaN', () => {
		// The platform's convention at the HTTP boundary is `null`; JSON.stringify
		// already does this for NaN, which is why the fix needs no special case.
		const json = JSON.parse(JSON.stringify(sample(withVoid)))
		assert.ok(json.every((v) => v === null))
	})
})

// -------------------------------------------------------------------

describe('a patch that says nothing does not overwrite a record', () => {
	const existing = {
		id: 'a1', status: 'open', owner: 'amara', resolution_note: 'bridge reopened',
		false_alert: null,
	}

	it('keeps every field when the patch is empty', () => {
		const next = updateAlertEvent(existing, {})
		assert.equal(next.status, 'open')
		assert.equal(next.owner, 'amara')
		assert.equal(next.resolution_note, 'bridge reopened')
	})

	it('clears an owner when the patch explicitly says null', () => {
		// `||` cannot express this: `null || existing` is the existing value, so
		// an owner could be assigned and never unassigned.
		assert.equal(updateAlertEvent(existing, { owner: null }).owner, null)
	})

	it('clears a resolution note when the patch explicitly says null', () => {
		assert.equal(updateAlertEvent(existing, { resolution_note: null }).resolution_note, null)
	})

	it('still assigns a falsy-but-present owner', () => {
		assert.equal(updateAlertEvent(existing, { owner: '' }).owner, '')
	})

	it('rejects a status that is present but not in the vocabulary', () => {
		// With `||` the empty string fell through to the existing status and the
		// request succeeded, so a typo'd status was silently ignored rather than
		// reported. A rejected status is information; a swallowed one is a
		// caller that believes it changed something.
		assert.throws(() => updateAlertEvent(existing, { status: '' }), /status/i)
	})

	it('transitions to a real status', () => {
		assert.equal(updateAlertEvent(existing, { status: 'resolved' }).status, 'resolved')
	})
})

// -------------------------------------------------------------------

describe('the RapidPro sender number is masked', () => {
	it('masks an inbound `from` the way it masks `phone`', () => {
		const out = redactPii({ from: '+254711111111' })
		assert.equal(out.from, 'xxxx1111')
	})

	it('masks a tel: prefixed number too', () => {
		assert.equal(redactPii({ from: 'tel:+254711111111' }).from, 'tel:xxxx1111')
	})

	it('leaves a string too short to be a number alone', () => {
		// `xxxx+254` would carry the whole input inside the mask, with a prefix
		// claiming it had been redacted.
		assert.equal(redactPii({ from: '+254' }).from, '+254')
	})

	it('does not touch `from` when phone redaction is off', () => {
		assert.equal(redactPii({ from: '+254711111111' }, { redactPhone: false }).from, '+254711111111')
	})
})

// -------------------------------------------------------------------

describe('a retention window is always a number or an explicit refusal', () => {
	it('completes a partial policy with the defaults', async () => {
		// This is the defect. `loadPolicy` returned the parsed file verbatim, so
		// any deployment that set one key got `retentionDays: undefined` for
		// every caller that read the property directly.
		const policy = await loadPolicy()
		assert.equal(typeof policy.retentionDays, 'number')
		assert.ok(policy.retentionDays > 0)
		assert.equal(policy.redactNames, true)
	})

	it('refuses to compute a window from a policy with no valid number', () => {
		// undefined * 86_400_000 is NaN, and `age > NaN` is false for every
		// record in the store — so the retention job expired nothing and reported
		// success, on every run, forever.
		assert.equal(retentionWindowDays({}), null)
		assert.equal(retentionWindowDays({ retentionDays: 0 }), null)
		assert.equal(retentionWindowDays({ retentionDays: -5 }), null)
		assert.equal(retentionWindowDays({ retentionDays: '365' }), null)
	})

	it('accepts a real window', () => {
		assert.equal(retentionWindowDays({ retentionDays: 30 }), 30)
	})

	it('expires records against the window it was given', () => {
		const old = { id: 'r1', created_at: '2020-01-01T00:00:00.000Z' }
		const fresh = { id: 'r2', created_at: new Date().toISOString() }
		const { kept, expired } = applyRetention([old, fresh], 30)
		assert.deepEqual(expired.map((r) => r.id), ['r1'])
		assert.deepEqual(kept.map((r) => r.id), ['r2'])
	})
})

// -------------------------------------------------------------------

describe('the CAP document carries what the renderer accepts', () => {
	it('emits senderName inside <info>, where CAP 1.2 puts it', () => {
		const xml = renderCapXml({ id: 'a1', status: 'open', severity: 'high' }, { senderName: 'County DES' })
		assert.ok(xml.includes('<senderName>County DES</senderName>'))
		// `<senderName>` is not a child of `<alert>` in CAP 1.2. It belongs in
		// `<info>` between `<expires>` and `<headline>`.
		const infoStart = xml.indexOf('<info>')
		assert.ok(xml.indexOf('<senderName>') > infoStart, 'senderName must live inside <info>')
	})

	it('escapes it like any other value', () => {
		const xml = renderCapXml({ id: 'a1', status: 'open' }, { senderName: 'A & B <Ops>' })
		assert.ok(xml.includes('<senderName>A &amp; B &lt;Ops&gt;</senderName>'))
	})

	it('defaults to something', () => {
		assert.ok(renderCapXml({ id: 'a1', status: 'open' }).includes('<senderName>'))
	})
})

// -------------------------------------------------------------------

describe('the STAC collection list is written once', () => {
	const data = {
		hazard_events: [{ id: 'h1', latitude: 1, longitude: 2 }],
		conflict_events: [{ id: 'c1', latitude: 3, longitude: 4 }],
		service_assets: [{ id: 's1', latitude: 5, longitude: 6 }],
		risk_scores: [{ id: 'r1', latitude: 7, longitude: 8 }],
	}

	it('resolves every collection the catalog advertises', () => {
		// The catalog's child links, `stacCollection`'s id check, and two
		// if/else ladders in server.js were four copies of this list. A test that
		// walks the one list and asks each copy the same question is what keeps
		// them from drifting.
		const advertised = stacCatalog('https://x')
			.links.filter((l) => l.rel === 'child')
			.map((l) => l.href.replace('https://x/stac/collections/', ''))

		assert.deepEqual(advertised, STAC_COLLECTIONS.map((c) => c.id))
		for (const id of advertised) {
			assert.ok(resolveStacCollection(data, id) !== null, `${id} is advertised but does not resolve`)
			assert.doesNotThrow(() => stacCollection(id, resolveStacCollection(data, id), 'https://x'))
		}
	})

	it('resolves hazard-events from both hazard and conflict records', () => {
		assert.deepEqual(resolveStacCollection(data, 'hazard-events').map((r) => r.id), ['h1', 'c1'])
	})

	it('returns null for a collection that does not exist', () => {
		assert.equal(resolveStacCollection(data, 'interventions'), null)
	})

	it('resolves an empty list rather than throwing when a collection is absent', () => {
		assert.deepEqual(resolveStacCollection({}, 'service-assets'), [])
	})
})

// -------------------------------------------------------------------

describe('there is one GeoJSON renderer, and it agrees about coordinates', () => {
	it('does not mistake a record with no coordinates for one on the equator', () => {
		// `Number(null)` and `Number('')` are both 0. `Number.isFinite` on the
		// raw value is not the same test as `Number.isFinite(Number(value))`.
		const atNullIsland = readCoordinate(null)
		const atEmpty = readCoordinate('')
		const atBlank = readCoordinate('   ')
		assert.equal(atNullIsland, null)
		assert.equal(atEmpty, null)
		assert.equal(atBlank, null)
		assert.equal(readCoordinate(0), 0, '0° is a place')
	})

	it('accepts a coordinate that arrived as a string', () => {
		assert.equal(readCoordinate('3.12'), 3.12)
		assert.equal(readCoordinate('-1.28'), -1.28)
	})

	it('produces the same features from both renderers', () => {
		const records = [
			{ id: 'a', latitude: 1.5, longitude: 2.5, name: 'here' },
			{ id: 'b', latitude: '3.5', longitude: '4.5', name: 'string coords' },
			{ id: 'c', latitude: null, longitude: null, name: 'no coords' },
			{ id: 'd', latitude: 0, longitude: 0, name: 'null island' },
		]
		const shared = toGeoJson(records).features
		const ogc = ogcFeatureCollection(records).features
		assert.deepEqual(ogc, shared,
			'ogcFeatureCollection re-implemented toGeoJson and disagreed with it about string coordinates')
		assert.deepEqual(shared.map((f) => f.properties.id), ['a', 'b', 'd'],
			'the record with no coordinates is excluded; the one at 0,0 is kept')
	})

	it('reports paging counts from the features it actually returned', () => {
		const ogc = ogcFeatureCollection([{ id: 'a', latitude: 1, longitude: 2 }, { id: 'b' }])
		assert.equal(ogc.numberMatched, 1)
		assert.equal(ogc.numberReturned, 1)
	})
})

// -------------------------------------------------------------------

describe('the operations summary counts what its keys name', () => {
	const base = {
		source_runs: [], ingestion_schedules: [], climate_observations: [],
		hazard_events: [], conflict_events: [], service_assets: [],
		impact_assessments: [], risk_scores: [], data_quality: [], data_lineage: [],
		incidents: [], interventions: [], intervention_tasks: [],
		field_reports: [], response_resources: [], action_logs: [], alert_rules: [],
		alert_events: [], trigger_protocols: [], rapidpro_dispatches: [],
		rapidpro_inbound_messages: [], report_templates: [], reports: [],
		report_distribution_runs: [], report_schedules: [], report_schedule_runs: [],
	}

	const data = {
		...base,
		// One row per hazard, so this list's length is a hazard count.
		population_at_risk: [
			{ hazard_event_id: 'h1', population_at_risk: 1200 },
			{ hazard_event_id: 'h2', population_at_risk: 800 },
		],
		// One row per service type, so this list's length is a schema constant.
		facilities_at_risk: [
			{ service_type: 'health', at_risk_count: 9 },
			{ service_type: 'road', at_risk_count: 14 },
			{ service_type: 'water', at_risk_count: 6 },
		],
	}

	it('names the row counts for what they count', () => {
		const c = counts(data)
		assert.equal(c.population_at_risk_rows, 2)
		assert.equal(c.facilities_at_risk_types, 3)
	})

	it('publishes the figures the panel was reaching for', () => {
		const c = counts(data)
		assert.equal(c.population_at_risk_total, 2000)
		assert.equal(c.facilities_at_risk_total, 29,
			'"facilities at risk" was the number of service types the schema knows, which is a constant')
	})

	it('reports an absent analytics collection as unknown, not as zero', () => {
		const c = counts(base)
		assert.equal(c.population_at_risk_total, null, 'analytics has not run yet is not the same as nothing is at risk')
		assert.equal(c.facilities_at_risk_total, null)
		assert.equal(c.population_at_risk_rows, null)
	})

	it('reports a run that found nothing as zero', () => {
		const c = counts({ ...base, population_at_risk: [], facilities_at_risk: [] })
		assert.equal(c.population_at_risk_total, 0)
		assert.equal(c.facilities_at_risk_total, 0)
	})
})
