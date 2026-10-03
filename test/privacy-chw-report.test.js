import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { redactPii } from '../src/pii.js'

const PHONE = '+254700123456'
const NAME = 'Amina Wanjiru'

/**
 * Boots a server on an empty store, POSTs one CHW field report, and hands back
 * the base url plus the created report. `anonymous` is the caller's per-request
 * opt-out from name redaction; `tel` controls whether the reporter phone is sent
 * with the `tel:` prefix.
 */
async function withChwReport(t, { anonymous = false, tel = true } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-pii-'))
	const store = new JsonStore(path.join(dir, 'store.json'))
	const server = createServer({ store })
	const listener = server.listen(0)
	const baseUrl = `http://localhost:${listener.address().port}`
	t.after(() => listener.close())

	const res = await fetch(`${baseUrl}/api/v1/chw/report`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			category: 'fever',
			description: 'High fever for two days',
			location: { latitude: 3.1167, longitude: 36.8 },
			reporter_phone: tel ? PHONE : PHONE.slice(4),
			reporter_name: NAME,
			anonymous,
		}),
	})
	assert.equal(res.status, 201)
	const created = (await res.json()).data
	return { baseUrl, created, store }
}

/**
 * Every string reachable in a record, so an assertion about "the value must not
 * be here anywhere" cannot be satisfied by a field the assertion did not name.
 */
function values(record) {
	return Object.values(record ?? {}).map((value) => String(value))
}

describe('PRIV-01 — CHW field reports do not store reporter identity in cleartext', () => {
	it('masks the reporter phone on the inbound record', async (t) => {
		const { baseUrl } = await withChwReport(t)

		const res = await fetch(`${baseUrl}/api/v1/rapidpro/inbound`)
		assert.equal(res.status, 200)
		const inbound = (await res.json()).data
		assert.equal(inbound.length, 1)

		const [record] = inbound
		assert.equal(record.event_type, 'field_report')
		// The last four digits are the whole point of masking: enough to
		// recognise your own record in a list, not enough to call anyone.
		assert.equal(record.contact_urn, 'xxxx3456')
		assert.ok(
			!values(record).some((value) => value.includes(PHONE) || value.includes('254700123456')),
			`raw phone survives on the inbound record: ${JSON.stringify(record)}`,
		)
	})

	it('masks the phone with and without the tel: prefix', async (t) => {
		const { store } = await withChwReport(t, { tel: false })
		const { rapidpro_inbound_messages: messages } = await store.read()
		assert.equal(messages.length, 1)
		assert.equal(messages[0].contact_urn, 'xxxx3456')
	})

	it('hashes the reporter name when the CHW reports anonymously', async (t) => {
		const { baseUrl } = await withChwReport(t, { anonymous: true })

		const res = await fetch(`${baseUrl}/api/v1/rapidpro/inbound`)
		const [record] = (await res.json()).data

		assert.ok(record.contact_name.startsWith('sha256:'), `name not hashed: ${record.contact_name}`)
		assert.ok(!record.contact_name.includes(NAME))
		assert.ok(!values(record).some((value) => value.includes(NAME)), JSON.stringify(record))
	})

	it('masks the phone whether or not the CHW asks for anonymity', async (t) => {
		for (const anonymous of [false, true]) {
			const { baseUrl } = await withChwReport(t, { anonymous })

			const res = await fetch(`${baseUrl}/api/v1/rapidpro/inbound`)
			const [record] = (await res.json()).data

			// The phone is masked regardless of `anonymous`. Anonymity is the
			// reporter's to request; whether their number is retained is not.
			assert.equal(record.contact_urn, 'xxxx3456', `anonymous=${anonymous}`)
			assert.ok(
				!values(record).some((value) => value.includes('254700123456')),
				`raw phone survives (anonymous=${anonymous}): ${JSON.stringify(record)}`,
			)
		}
	})

	it('does not leak the phone or the name into export.csv', async (t) => {
		const { baseUrl } = await withChwReport(t, { anonymous: true })

		const res = await fetch(`${baseUrl}/api/v1/export.csv`)
		assert.equal(res.status, 200)
		const csv = await res.text()

		assert.ok(!csv.includes('254700123456'), 'raw phone present in export.csv')
		assert.ok(!csv.includes(NAME), 'raw reporter name present in export.csv')
		assert.ok(csv.includes('xxxx3456'), 'masked phone missing from export.csv')
	})

	it('registers the CHW contact field names in redactPii itself', () => {
		// The bug class here is a field list written at the call site and again
		// inside the redactor; the two drift and the second one wins silently.
		// Pin the redactor's coverage of the CHW inbound names so a field added
		// to the inbound record without a redaction rule fails here.
		const masked = redactPii(
			{ contact_urn: PHONE, contact_name: NAME, reporter_name: NAME },
			{ redactNames: true, redactPhone: true },
		)
		assert.equal(masked.contact_urn, 'xxxx3456')
		assert.ok(!masked.contact_name.includes(NAME))
		assert.ok(!masked.reporter_name.includes(NAME))
	})

	it('leaves a report with no reporter contact empty rather than inventing one', async (t) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-pii-none-'))
		const store = new JsonStore(path.join(dir, 'store.json'))
		const server = createServer({ store })
		const listener = server.listen(0)
		t.after(() => listener.close())
		const baseUrl = `http://localhost:${listener.address().port}`

		const res = await fetch(`${baseUrl}/api/v1/chw/report`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ category: 'fever', description: 'Cough', location: { latitude: 3.1, longitude: 36.8 } }),
		})
		assert.equal(res.status, 201)

		const { rapidpro_inbound_messages: messages } = await store.read()
		assert.equal(messages.length, 1)
		assert.equal(messages[0].contact_urn, '')
		assert.equal(messages[0].contact_name, '')
	})
})