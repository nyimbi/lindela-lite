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
    // The two symptom confirmations pass the noun differently — one positionally
    // to queueReport, one as `what:` — so both forms are counted.
    assert.equal(source.match(/'symptom report'/g)?.length, 2,
      'only the two symptom-path confirmations may describe a symptom report')
    assert.equal(source.match(/what: 'symptom report'/g)?.length, 1,
      'and only one of them names it through the toast template')
    assert.equal(source.match(/'incident report'/g)?.length, 2,
      'both incident confirmations name an incident — one queued, one sent')
    assert.ok(!/chw\.report_sent[^\n]*symptom report/.test(source.slice(source.indexOf('incidentSubmitBtn'))),
      'no confirmation after the incident button may describe a symptom')
  })
})
