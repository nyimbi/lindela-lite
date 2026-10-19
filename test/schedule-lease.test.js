import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { JsonStore } from '../src/store.js'
import {
	normalizeIngestionSchedule,
	runDueIngestionSchedules,
	scheduleLeaseIsHeld,
} from '../src/ingestion.js'

/**
 * A due schedule can only be claimed once per tick.
 *
 * Measured before this existed: two ticks handed the same snapshot over one due
 * schedule each ran it — two fetches, two `source_runs` rows for one interval.
 * The duplicate is not harmless. `run-due` is what a sidecar POSTs, and a
 * sidecar that retries a request it timed out on, or two replicas behind one
 * ingress, is exactly the arrival pattern that produces it. Everything
 * downstream — the trailing-median assertion, the watermark round-trip, the
 * dedup hash — then absorbs a second run that should never have happened.
 *
 * The claim is a read-modify-write, so it is taken under `withLock` where the
 * store has one. It is deliberately *not* held for the run: on Postgres that
 * lock is the advisory lock every writer in the platform queues behind, and an
 * ingestion is minutes.
 */

function scratchStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-lease-'))
	return new JsonStore(path.join(dir, 'store.json'))
}

/** A due schedule over a connector that needs no network. */
function dueSchedule(over = {}) {
	return normalizeIngestionSchedule({
		source: 'conflict_csv',
		status: 'active',
		interval_minutes: 60,
		timeout_ms: 5000,
		retries: 0,
		next_run_at: '2026-01-01T00:00:00.000Z',
		default_options: {
			conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n'
				+ '2026-01-02,scheduled_ingest,3.12,35.62,KE,0,Lease probe event\n',
		},
		...over,
	})
}

describe('a due schedule is claimed once per tick', () => {
	it('runs the schedule for the first tick that claims it', async () => {
		const store = scratchStore()
		await store.merge({ ingestion_schedules: [dueSchedule()] })
		const result = await runDueIngestionSchedules(store, await store.read())
		assert.equal(result.schedules.length, 1)
		assert.equal(result.source_runs.length, 1)
	})

	it('refuses the second of two ticks handed the same snapshot', async () => {
		// Both ticks read before either writes — the shape a sidecar retry and a
		// second replica produce. The second is holding a snapshot in which the
		// schedule is still due, so it must re-read the claim rather than trust
		// what it was handed. The fixture's due time is one minute ago rather
		// than a year, because a schedule ten months behind is *still due* after
		// one run — catch-up is correct there, and a test that used it would be
		// asserting the wrong property.
		const store = scratchStore()
		const due = new Date(Date.now() - 60_000).toISOString()
		await store.merge({ ingestion_schedules: [dueSchedule({ next_run_at: due })] })
		const snapshot = await store.read()
		const first = await runDueIngestionSchedules(store, snapshot)
		const second = await runDueIngestionSchedules(store, snapshot)
		assert.equal(first.schedules.length, 1)
		assert.equal(second.schedules.length, 0, 'the same interval ran twice')
		const after = await store.read()
		assert.equal(after.source_runs.length, 1, 'one interval wrote two run rows')
	})

	it('skips a schedule another tick is running', async () => {
		// The window the claim actually covers: the run is minutes long, and a
		// second tick arriving inside it finds the schedule due and a live claim
		// on it.
		const store = scratchStore()
		const due = new Date(Date.now() - 60_000).toISOString()
		const live = new Date(Date.now() + 10 * 60_000).toISOString()
		await store.merge({
			ingestion_schedules: [dueSchedule({ next_run_at: due, lease_owner: 'tick-other', lease_until: live })],
		})
		const result = await runDueIngestionSchedules(store, await store.read())
		assert.equal(result.schedules.length, 0, 'a schedule already being run was started again')
		assert.equal((await store.read()).source_runs.length, 0)
	})

	it('releases the claim when the run finishes', async () => {
		// A schedule left holding a live claim would be skipped by the next tick
		// even though nothing is running — a lease that is never released is a
		// schedule that runs once and then stops.
		const store = scratchStore()
		await store.merge({ ingestion_schedules: [dueSchedule()] })
		await runDueIngestionSchedules(store, await store.read())
		const after = await store.read()
		const schedule = after.ingestion_schedules[0]
		assert.equal(schedule.lease_owner, null)
		assert.equal(schedule.lease_until, null)
	})

	it('runs again on the next due interval', async () => {
		// The control for the release: a claim that outlived its run would pass
		// the two tests above and fail this one.
		const store = scratchStore()
		await store.merge({ ingestion_schedules: [dueSchedule()] })
		const first = await runDueIngestionSchedules(store, await store.read())
		const advanced = (await store.read()).ingestion_schedules[0]
		const second = await runDueIngestionSchedules(store, await store.read(), { now: advanced.next_run_at })
		assert.equal(first.schedules.length, 1)
		assert.equal(second.schedules.length, 1)
	})
})

describe('a claim expires, and an expired one is nobody\'s', () => {
	it('holds while the claim is live and frees it after', () => {
		const at = new Date('2026-10-19T12:00:00.000Z')
		assert.equal(scheduleLeaseIsHeld({ lease_until: '2026-10-19T12:10:00.000Z' }, at), true)
		assert.equal(scheduleLeaseIsHeld({ lease_until: '2026-10-19T11:59:00.000Z' }, at), false)
	})

	it('treats an absent or unreadable claim as no claim', () => {
		// A tick that died mid-run leaves `lease_until` behind; a claim that
		// cannot be read must not block the schedule for ever. Both directions
		// are asserted, because "always free" would also pass the expiry test.
		const at = new Date('2026-10-19T12:00:00.000Z')
		assert.equal(scheduleLeaseIsHeld({}, at), false)
		assert.equal(scheduleLeaseIsHeld({ lease_until: 'not-a-date' }, at), false)
		assert.equal(scheduleLeaseIsHeld({ lease_until: '2026-10-19T12:10:00.000Z' }, at), true)
	})

	it('takes over a schedule whose claim expired', async () => {
		const store = scratchStore()
		const stale = dueSchedule({ lease_owner: 'tick-dead', lease_until: '2026-01-01T00:05:00.000Z' })
		await store.merge({ ingestion_schedules: [stale] })
		const result = await runDueIngestionSchedules(store, await store.read(), { now: '2026-01-01T01:00:00.000Z' })
		assert.equal(result.schedules.length, 1, 'an expired claim blocked the schedule')
	})
})
