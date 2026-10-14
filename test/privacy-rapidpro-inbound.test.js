import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * The correlated reply is not a special case for privacy.
 *
 * `src/pii.js` has carried a comment naming this file since `from` was added to
 * the masker — "a test asserted the cleartext value back, which made the leak a
 * specification rather than an accident — see `test/privacy-rapidpro-inbound.test.js`"
 * — and the file did not exist. A citation to a guard that was never written
 * reads as coverage in every audit that follows it, which is worse than no
 * citation: it is the one place a reader would have checked.
 *
 * The leak it should have caught: the reply route's *orphan* branch redacts its
 * record and the *correlated* branch did not, so a reply from a responder the
 * platform had actually dispatched to was stored with the sender's number in
 * `from`, the contact's name in `contact_name`, and the whole raw webhook in
 * `payload` — including `contact.name` and `contact.urn`. Readable through
 * `GET /api/v1/rapidpro/inbound` and present in `export.csv`.
 *
 * The direction of the asymmetry is why it survived review: an unrecognised
 * sender is the case someone remembers to redact, because a wrong number is
 * obviously a stranger's data. The correlated reply is the case the platform was
 * built for, and being expected made it look already-handled.
 */

const TOKENS = JSON.stringify([{ token: 'tok-admin', scopes: ['*'] }])
const WEBHOOK_SECRET = 'rapidpro-test-secret'
const PHONE = '+254700000001'
const URN = `tel:${PHONE}`
const CONTACT_NAME = 'Amina Wanjiru'

let listener, base, store, dir, previousTokens, previousSecret

const post = async (path_, body) =>
  fetch(`${base}${path_}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rapidpro-secret': WEBHOOK_SECRET, 'x-api-key': 'tok-admin' },
    body: JSON.stringify(body),
  })

const get = async (path_) => fetch(`${base}${path_}`, { headers: { 'x-api-key': 'tok-admin' } })

before(async () => {
  previousTokens = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = TOKENS
  previousSecret = process.env.RAPIDPRO_WEBHOOK_SECRET
  process.env.RAPIDPRO_WEBHOOK_SECRET = WEBHOOK_SECRET
  delete process.env.RAPIDPRO_API_TOKEN
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lindela-inbound-privacy-'))
  store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({
    alert_events: [],
    rapidpro_dispatches: [],
    rapidpro_inbound_messages: [],
    field_outcomes: [],
    field_reports: [],
    action_logs: [],
  })
  listener = createServer({ store }).listen(0)
  base = `http://localhost:${listener.address().port}`
})

after(async () => {
  listener?.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
  if (previousTokens === undefined) delete process.env.LINDELA_LITE_TOKENS
  else process.env.LINDELA_LITE_TOKENS = previousTokens
  if (previousSecret === undefined) delete process.env.RAPIDPRO_WEBHOOK_SECRET
  else process.env.RAPIDPRO_WEBHOOK_SECRET = previousSecret
})

/**
 * A dispatch to this sender, recent enough to correlate.
 *
 * `created_at` is measured from now rather than fixed: correlation matches
 * inside a window from the present, so a dispatch seeded at a historical date
 * falls outside it and the reply is filed as an orphan — which is the branch
 * that was already redacted, so the test would pass against the leak.
 */
async function seedDispatch() {
  const createdAt = new Date(Date.now() - 30 * 60_000).toISOString()
  await store.merge({
    alert_events: [{
      id: 'alert_priv',
      status: 'open',
      severity: 'high',
      created_at: createdAt,
      approval: { state: 'auto_approved' },
    }],
    rapidpro_dispatches: [{
      id: 'dispatch_priv',
      alert_event_id: 'alert_priv',
      status: 'sent',
      recipients: { urns: [URN] },
      created_at: createdAt,
    }],
  })
}

describe('a correlated reply does not store identity in cleartext', () => {
  it('masks the sender on the stored record', async () => {
    await seedDispatch()
    const res = await post('/api/v1/rapidpro/reply', {
      id: 'msg_priv_1',
      from: URN,
      text: 'ACK',
      contact: { name: CONTACT_NAME, urn: URN },
    })
    // Correlated is the point: an orphan is the branch that always redacted.
    assert.equal(res.status, 200)
    assert.equal((await res.json()).correlated, true)

    const inbound = (await store.read({ collections: ['rapidpro_inbound_messages'] })).rapidpro_inbound_messages
    const [record] = inbound.filter((m) => m.id === 'rapidpro_inbound_' || true).slice(-1)
    assert.ok(record, 'the correlated reply was not stored')
    assert.equal(record.from, 'xxxx0001')
    assert.ok(record.contact_name.startsWith('sha256:'), `the contact name was not pseudonymised: ${record.contact_name}`)
    assert.ok(!JSON.stringify(record).includes(PHONE), 'the sender survived in the stored reply')
    assert.ok(!JSON.stringify(record).includes(CONTACT_NAME), 'the contact name survived in the stored reply')
  })

  it('masks it inside the echoed payload too', async () => {
    const res = await post('/api/v1/rapidpro/reply', {
      id: 'msg_priv_2',
      from: URN,
      text: 'ESCALATE no_access',
      contact: { name: CONTACT_NAME, urn: URN },
      urns: [URN],
    })
    assert.equal((await res.json()).correlated, true)
    const inbound = (await store.read({ collections: ['rapidpro_inbound_messages'] })).rapidpro_inbound_messages
    const record = inbound.find((m) => m.source_id === 'msg_priv_2')
    assert.ok(record, 'the second reply was not stored')
    // The nested echo is what a shallow redactor cannot reach: the rules read
    // named keys on the record, and the sender is two levels down here.
    assert.ok(!JSON.stringify(record).includes(PHONE), `the sender survived in the payload: ${JSON.stringify(record.payload)}`)
    assert.ok(!JSON.stringify(record).includes(CONTACT_NAME), 'the contact name survived in the payload')
  })

  it('is not readable through the inbound listing an operator uses', async () => {
    const res = await get('/api/v1/rapidpro/inbound')
    assert.equal(res.status, 200)
    const body = await res.json()
    const serialised = JSON.stringify(body.data)
    assert.ok(!serialised.includes(PHONE), 'the number is readable through GET /rapidpro/inbound')
    assert.ok(!serialised.includes(CONTACT_NAME), 'the name is readable through GET /rapidpro/inbound')
  })

  it('is not readable through the export', async () => {
    const res = await get('/api/v1/export.csv')
    assert.equal(res.status, 200)
    const csv = await res.text()
    // Scoped to what this file guards. The inbound record is what was leaking
    // here; `rapidpro_dispatches` is in the same export and carries the
    // recipient URN in `recipients.urns`, which is a *different* question — the
    // dispatch log is the platform's own record of who it messaged, no redaction
    // runs over it, and asserting on it here would fail for a reason this change
    // does not own and would read as a fix that did not work.
    assert.ok(!csv.includes(CONTACT_NAME), 'the name is in export.csv')
    const inboundRows = csv.split('\n').filter((line) => line.includes('rapidpro_inbound'))
    assert.ok(inboundRows.length, 'the export carried no inbound row, so this proved nothing')
    assert.ok(!inboundRows.some((line) => line.includes(PHONE)), 'the number is in the inbound rows of export.csv')
  })

  it('still keeps the last four digits, which is why the field exists', async () => {
    const inbound = (await store.read({ collections: ['rapidpro_inbound_messages'] })).rapidpro_inbound_messages
    // Masking, not hashing: an operator recognising a reporter who has called
    // before is the whole operational reason `from` is stored at all. A redactor
    // that removed the value entirely would satisfy every assertion above and
    // destroy the field's purpose.
    assert.ok(inbound.every((m) => m.from === 'xxxx0001'), 'the masked form lost the recognisable suffix')
  })
})
