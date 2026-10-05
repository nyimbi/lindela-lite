import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A report filed with no signal must be saved, and must say so.
 *
 * This is the one defect the UX audit found that cost a health worker their
 * work. `enqueue` awaited `navigator.serviceWorker.ready` with no timeout, and
 * on a device whose worker is not yet controlling the page — which is every
 * device, offline, before the first claim — `ready` never settles. The IndexedDB
 * write committed, the caller's `await` never returned, no toast fired and the
 * screen never advanced. The button press did nothing at all, and the field team
 * had no way to know.
 *
 * Verified in a real browser with the network emulated off: the report now
 * saves, the toast reads "incident report saved on this phone", and the screen
 * returns home. These assertions guard the two properties that fix rests on.
 *
 * The module is browser-only, so the assertions read its source rather than
 * executing it — which would normally be the wrong trade. Here it is defensible
 * because both properties are about the shape of the code and not about a value,
 * and because the browser run is the behavioural evidence.
 */

const root = path.join(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

describe('an offline report is saved and says so', () => {
  it('does not let the save wait on Background Sync registration', () => {
    const source = read('public/shared/runtime.js')
    const enqueue = source.slice(source.indexOf('async enqueue('), source.indexOf('async pendingCount('))

    assert.ok(enqueue.includes('return { queued: true, id }'),
      'enqueue must report that it queued, so a caller can distinguish saved from failed')

    assert.ok(/Promise\.race/.test(enqueue),
      'the `await navigator.serviceWorker.ready` must be raced against something')
    assert.ok(/setTimeout\(resolve,\s*\d+\)/.test(enqueue),
      'that something must be a timeout: `ready` never settles when no worker is ' +
      'controlling the page, which is exactly the offline case this exists for')
  })

  it('names what was actually filed', () => {
    // Every confirmation on the field app is the only feedback a health worker
    // gets. All of them were copied from the symptom path, so an incident and a
    // reply each confirmed themselves as a symptom report.
    const source = read('public/chw/app.js')
    const en = JSON.parse(read('public/i18n/en.json'))

    assert.ok(en['chw.reply_sent'],
      'a reply needs its own confirmation; borrowing the report one calls it a symptom')
    // The invariant is "one sentence per noun per outcome" — queued, sent and
    // failed each name what was actually filed, and nothing else does.
    //
    // This used to assert the exact number of `what: 'symptom report'`
    // literals, which pinned the *call-site style* rather than the property:
    // routing all three submissions through `submitOrQueue(path, body, {what})`
    // is correct and changed the count. The count that means something is the
    // per-noun total.
    assert.equal(source.match(/'symptom report'/g)?.length, 3,
      'only the three symptom-path sentences may describe a symptom report')
    assert.equal(source.match(/'incident report'/g)?.length, 3,
      'all three incident sentences name an incident — queued, sent, failed')
    assert.equal(source.match(/submitOrQueue\('\/api\/v1\/chw\/report', body, \{ what: 'symptom report' \}\)/g)?.length, 1,
      'the symptom submission names itself when it queues')
    assert.equal(source.match(/submitOrQueue\('\/api\/v1\/chw\/report', body, \{ what: 'incident report' \}\)/g)?.length, 1,
      'and so does the incident submission')
    assert.equal(source.match(/reportSendFailure\(error, 'incident report'\)/g)?.length, 1,
      'the incident failure sentence must name an incident')
    assert.equal(source.match(/reportSendFailure\(error, 'reply'\)/g)?.length, 1,
      'and the reply failure sentence must not borrow either noun')
    assert.ok(!/chw\.report_sent[^\n]*symptom report/.test(source.slice(source.indexOf('incidentSubmitBtn'))),
      'no confirmation after the incident button may describe a symptom')
  })
})
