import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { installBrowserEnv } from './browser-env.mjs'
import {
  determinationFor, submitOutcome, coverageNote, reasonOptions, humanReason, fetchReasons, fetchCoverage,
} from '../public/shared/outcomes.js'

const PUBLIC_ROOT = new URL('../public/', import.meta.url)

// Captured before `installBrowserEnv` swaps in its unref'd stub, so `settle`
// can wait on a timer that actually fires. See the note there.
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

/**
 * SAE-19 — the outcome channel had no way in.
 *
 * The server records a determination, the metric registry counts it, the
 * calibration rollup reports coverage — and before this, nobody could enter one.
 * Every calibration surface stayed at "not estimable" for the reason the whole
 * feature exists to fix, because the only way to record a determination was to
 * know the collection existed.
 *
 * So the tests here are about the *decisions*, not the markup. A dialog that
 * renders is not a dialog that decides correctly, and the decisions are the ones
 * that can go quietly wrong:
 *
 *   - a reason that does not match the determination is a contradiction, not a
 *     judgement, and one filed that way poisons every rollup that counts it;
 *   - a bare verdict with no reason is uncountable, which is the state the API
 *     refuses and the form must refuse too;
 *   - "we could not ask how many have been judged" and "none have been judged"
 *     are different facts, and only one of them may be drawn on screen.
 */

const REASONS = {
  justified: ['hazard_occurred_as_warned', 'action_taken_in_time', 'confirmed_by_ground_report'],
  false: ['sensor_fault', 'threshold_mistuned', 'no_hazard_observed'],
}

describe('SAE-19 — what the dialog offers for an alert', () => {
  it('an alert with nothing recorded is offered the choice', () => {
    const decision = determinationFor({ id: 'alert-1' }, { reasons: REASONS })
    assert.equal(decision.kind, 'offered')
  })

  it('an alert already determined is offered a correction, and says what was recorded', () => {
    const decision = determinationFor({
      id: 'alert-1', false_alert: true, outcome_reason: 'sensor_fault', determined_at: '2024-03-05T00:00:00Z',
    }, { reasons: REASONS })
    assert.equal(decision.kind, 'recorded')
    assert.equal(decision.determination, 'false')
    assert.equal(decision.reason, 'sensor_fault')
    assert.equal(decision.determined_at, '2024-03-05T00:00:00Z')
  })

  it('a row with no id is offered nothing, rather than a form that cannot be sent', () => {
    const decision = determinationFor({}, { reasons: REASONS })
    assert.equal(decision.kind, 'unavailable')
    assert.match(decision.reason, /no alert id/)
  })

  it('the reasons are disjoint, so a justified reason cannot be filed against a false alert', () => {
    // The overlap is what makes the contradiction possible. Two lists that share
    // an entry are two lists that will disagree the first time somebody picks
    // the wrong one.
    const overlap = REASONS.justified.filter((r) => REASONS.false.includes(r))
    assert.deepEqual(overlap, [])
    const decision = determinationFor({ id: 'a' }, { reasons: REASONS })
    assert.equal(decision.reasons.justified.includes('sensor_fault'), false)
    assert.equal(decision.reasons.false.includes('hazard_occurred_as_warned'), false)
  })
})

describe('SAE-19 — a determination cannot be filed without a reason', () => {
  it('refuses a bare verdict', async () => {
    const result = await submitOutcome({ alertId: 'a1', determination: 'false', determinedBy: 'me' }, { post: async () => ({ success: true }) })
    assert.equal(result.ok, false)
    assert.match(result.error, /reason/)
  })

  it('refuses a determination that is neither', async () => {
    const result = await submitOutcome({ alertId: 'a1', determination: 'probably', reason: 'sensor_fault', determinedBy: 'me' }, { post: async () => ({ success: true }) })
    assert.equal(result.ok, false)
    assert.match(result.error, /justified/)
  })

  it('refuses an anonymous determination', async () => {
    const result = await submitOutcome({ alertId: 'a1', determination: 'false', reason: 'sensor_fault' }, { post: async () => ({ success: true }) })
    assert.equal(result.ok, false)
    assert.match(result.error, /who determined it/)
  })

  it('posts the determination with the reason and the owner', async () => {
    let posted = null
    const result = await submitOutcome({
      alertId: 'a1', determination: 'false', reason: 'sensor_fault', determinedBy: 'focal_point_mbeya', note: 'Reading traced to a faulty sensor',
    }, {
      post: async (path, body) => {
        posted = { path, body }
        return { success: true, data: { id: 'outcome-1' } }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(posted.path, '/api/v1/alert-events/a1/outcome')
    assert.equal(posted.body.reason, 'sensor_fault')
    assert.equal(posted.body.determined_by, 'focal_point_mbeya')
    assert.equal(posted.body.note, 'Reading traced to a faulty sensor')
  })

  it('will not post without a poster, rather than posting unauthenticated', async () => {
    await assert.rejects(
      submitOutcome({ alertId: 'a1', determination: 'false', reason: 'sensor_fault', determinedBy: 'me' }),
      /needs a `post` function/,
      'a silent default poster would file determinations with no auth header and no way to tell',
    )
  })

  it('reports the server\'s refusal instead of pretending it worked', async () => {
    const result = await submitOutcome(
      { alertId: 'a1', determination: 'false', reason: 'because', determinedBy: 'me' },
      { post: async () => ({ success: false, error: 'reason must be one of sensor_fault…' }) },
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /sensor_fault/)
  })
})

describe('SAE-19 — the coverage line says what it knows', () => {
  it('says plainly that nothing has been judged', () => {
    const note = coverageNote({ alerts: 400, determined: 0, false_alerts: 0, justified: 0 })
    assert.match(note, /coverage_none/)
    assert.match(note, /400/)
  })

  it('states the counts a rate would be computed from', () => {
    const note = coverageNote({ alerts: 400, determined: 12, false_alerts: 2, justified: 10 })
    assert.match(note, /12/)
    assert.match(note, /400/)
    assert.match(note, /3/)  // 3% of the alerts judged
  })

  it('says nothing at all when the tally could not be fetched', () => {
    assert.equal(coverageNote(null), '')
    assert.equal(coverageNote(undefined), '')
  })
})

describe('SAE-19 — the surface is reachable and the reason catalogue comes from one place', () => {
  // QUA-02. This block read `app.js` as text and asserted on the shape of the
  // code — `assert.match(APP, /data-action="outcome"/)`. Every one of those
  // passes when the string exists in a dead branch and fails when a rename
  // touches it, which is backwards. The rail is drivable through the real boot
  // (see the harness note in `test/browser-env.mjs`), so what is asserted now
  // is the markup the rail actually renders for a determined and an
  // undetermined alert, and the requests the console actually makes.

  const rows = () => ([
    { id: 'alert-open', status: 'pending', severity: 'high' },
    {
      id: 'alert-judged', status: 'pending', severity: 'high',
      false_alert: true, outcome_reason: 'sensor_fault', determined_at: '2024-03-05T00:00:00Z',
    },
  ])

  /**
   * Boot the console against a stub store and return what it rendered.
   *
   * A fresh specifier per call: ESM caches by URL, and two scenarios sharing one
   * `app.js` URL would run the second against the first's module state. The
   * module's top-level `await refresh({ first: true })` means the import
   * resolving is the boot having finished, renders included.
   */
  /**
   * Let a click handler's own awaits drain.
   *
   * Every delegated handler here is synchronous and returns nothing, so there
   * is no promise to await through it. Two macrotask turns is enough for the
   * `loadTemplate` fetch and the `fetchReasons` fetch the dialog performs
   * before it renders — both are `await`ed inside the handler, so the option
   * list is written by the time this resolves.
   *
   * **Real timers, not the environment's stub.** `installBrowserEnv` replaces
   * `setTimeout` with one that `unref`s the handle so a 30-second poll cannot
   * outlive its test. An unref'd timer does not keep the loop alive, so when
   * nothing else is pending the timer never fires and this promise never
   * resolves — which is exactly what the loop does at the end of a test file.
   * Node 26's runner holds the loop open through it; Node 22's does not, so
   * these tests passed on the laptop and failed on every CI push with
   * "Promise resolution is still pending but the event loop has already
   * resolved". Captured before the stub is installed, as
   * `alert-card-authorisation.test.js` already does.
   */
  const settle = () => new Promise((r) => realSetTimeout(r, 0)).then(() => new Promise((r) => realSetTimeout(r, 0)))

  let boots = 0
  async function boot({ alerts = rows(), coverage, reasons } = {}) {
    boots += 1
    const elements = new Map()
    const fetched = []
    installBrowserEnv({
      elements,
      respond: (url) => {
        fetched.push(String(url))
        if (url.includes('/api/v1/alert-events')) {
          return { body: { success: true, data: alerts, returned: alerts.length, limit: 200, total: alerts.length, has_more: false, next_cursor: null } }
        }
        if (url.includes('/api/v1/alert-outcomes/reasons')) {
          return reasons === undefined ? undefined : { body: { success: true, data: { reasons } } }
        }
        if (url.includes('/api/v1/alert-outcomes/tally') || url.includes('/api/v1/alert-outcomes/coverage')) {
          return coverage === undefined ? undefined : { body: { success: true, data: coverage } }
        }
        if (url.includes('/api/v1/health')) return { body: { success: true, data: { storage: { mode: 'json' } } } }
        return undefined
      },
    })
    await import(new URL(`app.js?outcome=${boots}`, PUBLIC_ROOT).href)
    return { elements, fetched, rail: elements.get('alertsList')?.innerHTML || '' }
  }

  it('every alert row carries a determination control', async () => {
    const { rail } = await boot()
    const controls = (rail.match(/data-action="outcome"/g) || []).length
    assert.equal(controls, 2,
      'the rail renders two alert rows and offers no way to say whether either was justified — '
      + 'the channel exists and nobody can post to it')
  })

  it('the control says what it will do, per row', async () => {
    // A label is a claim about the action, and the two rows need different ones:
    // an undetermined alert offers a judgement, a determined one opens a
    // correction. One label for both is a control that describes the wrong act.
    const { rail } = await boot()
    assert.match(rail, /Was this justified\?/, 'an undetermined row must offer the judgement')
    assert.match(rail, /Change determination/, 'a determined row must offer the correction')
  })

  it('the dialog exists in a deferred template, with both determinations and a reason select', () => {
    // In a deferred template, not in index.html: eight controls at boot is eight
    // controls a console on a field connection pays for, to open a dialog about
    // once a week. `test/web-deferred-panels.test.js` owns the ceiling. This is
    // a structural fact about where markup lives, not about program text, so
    // reading the two files is the right instrument.
    const template = readFileSync(new URL('../public/panels/outcome.html', import.meta.url), 'utf8')
    const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    for (const id of ['outcomeDialog', 'outcomeReason', 'outcomeDeterminedBy', 'outcomeSubmit']) {
      assert.ok(template.includes(`id="${id}"`), `#${id} is missing from the deferred dialog`)
      assert.ok(!index.includes(`id="${id}"`), `#${id} is back inline in index.html; that is the first-load cost the deferral removed`)
    }
    assert.match(template, /name="outcomeDetermination"[^>]*value="justified"|value="justified"[^>]*name="outcomeDetermination"/)
    assert.match(template, /value="false"/)
  })

  it('the deferred dialog is precached, because offline is when it is needed', async () => {
    // A worker who has just received an alert is often offline. A dialog that
    // will not open without a connection is the outcome channel closed on the
    // devices it exists for. Asserted on the worker's own exported list rather
    // than on its source text — the list is the thing that ships.
    const { BOOTSTRAP_ASSETS } = await import('../public/sw.js')
    assert.ok(BOOTSTRAP_ASSETS.includes('/panels/outcome.html'),
      'the determination dialog is deferred and not precached, so it cannot open offline')
  })

  it('its wiring cannot be module-level, because the markup is not there yet', async () => {
    // A listener attached to an element that does not exist is a control that
    // silently does nothing, and the symptom is an operator who cannot judge an
    // alert and no error anywhere.
    //
    // Observed rather than grepped: the boot must not have fetched the dialog's
    // markup (it is deferred, so nothing at load time touches it), and the
    // submit element it would bind to must not exist until the dialog is opened.
    const { fetched, elements } = await boot()
    assert.ok(!fetched.some((u) => u.includes('/panels/outcome.html')),
      'the outcome dialog was fetched at boot; that is the first-load cost the deferral removed')
    assert.equal(elements.get('outcomeSubmit'), undefined,
      'a module-level listener on deferred markup attaches to nothing — the markup must not be present at load')
  })

  it('both coverage sentences exist in English, or the line renders a key', async () => {
    // A gate that catches a missing `data-i18n` key cannot see a template
    // literal, so the one string on this panel that no locale could reach was
    // invisible to it. The keys are checked, and then the fallback is *driven*:
    // a locale with no translation must still read as English rather than as an
    // identifier.
    const en = JSON.parse(readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'))
    for (const key of ['outcome.coverage_none', 'outcome.coverage_some']) {
      assert.ok(typeof en[key] === 'string' && en[key].length > 0,
        `${key} is missing from en.json, so the coverage line renders the key itself`)
    }
    // A tally the console can fetch, rendered through the real coverage line.
    const { elements } = await boot({ coverage: { alerts: 400, determined: 12, false_alerts: 2, justified: 10 } })
    const host = elements.get('alertsOutcomeCoverage')
    assert.equal(host.hidden, false, 'the coverage line stayed hidden with a tally in hand')
    assert.match(host.textContent, /12/, 'the determined count must appear')
    assert.match(host.textContent, /400/, 'and the denominator')
  })

  it('the reason list is fetched, never a second copy in the client', async () => {
    // A client-side copy of the reasons is a second definition of what a false
    // alert is. The console must ask the server for them — and *use* the answer,
    // which is the half a grep for `fetchReasons()` cannot see. The dialog is
    // opened the way an operator opens it: by clicking the row's control, which
    // is the delegated handler `renderAlertsPanel` attaches.
    const { elements, fetched } = await boot({
      reasons: { justified: ['server_side_justification'], false: ['server_side_falsity'] },
    })
    const rail = elements.get('alertsList')
    const button = rail.querySelectorAll('[data-action]')
      .find((b) => b.dataset.action === 'outcome' && b.dataset.id === 'alert-open')
    assert.ok(button, 'the undetermined row rendered no outcome control, so nothing opens the dialog')
    const [click] = button.listeners('click')
    assert.ok(click, 'the control carries no click handler — the button is decorative')
    // The handler reads `e.currentTarget.dataset`, so the target is the button.
    // It is not `async` and returns nothing — a click handler that returned a
    // promise the browser ignored is how every one of these is written — so the
    // dialog's own awaits are drained rather than awaited through the handler.
    click({ currentTarget: button })
    await settle()

    assert.ok(fetched.some((u) => u.includes('/api/v1/alert-outcomes/reasons')),
      'the reason catalogue was never requested, so the client is carrying its own copy')
    const options = elements.get('outcomeReason')?.innerHTML || ''
    assert.match(options, /server_side_justification/,
      'the catalogue was fetched and then discarded — the dialog still renders the client copy')
  })

  it('the coverage line has a host, and it is hidden until the tally answers', async () => {
    // The host is markup; that it exists is a structural fact.
    const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    assert.ok(index.includes('id="alertsOutcomeCoverage"'))

    // And the behaviour: with the tally unanswerable the line must stay blank.
    // "0 of 0 determined" is a claim nobody made.
    const { elements } = await boot()
    const host = elements.get('alertsOutcomeCoverage')
    assert.equal(host.hidden, true, 'an unanswerable tally must leave the line hidden')
    assert.equal(host.textContent, '', 'and blank; "0 of 0 determined" is a claim nobody made')
  })

  it('the reason ids read as words in the dropdown', () => {
    // `sensor_fault` in a list of choices is a bug report to nobody.
    assert.match(humanReason('sensor_fault'), /sensor/i)
    assert.notEqual(humanReason('no_hazard_observed'), 'no_hazard_observed')
    const options = reasonOptions(REASONS.false)
    assert.match(options, /value="sensor_fault"/)
    assert.match(options, /value="no_hazard_observed"/)
  })

  it('a determined alert marks its row, and an undetermined one does not', async () => {
    // A badge on every un-reviewed alert turns the rail into a wall of hedges and
    // an operator learns to skip it. The unknown is stated once, in aggregate.
    const { rail } = await boot()
    const badges = (rail.match(/filter-scope-note"><span class="status-pill/g) || []).length
    assert.equal(badges, 1, 'exactly the determined row carries a badge; the undetermined one must not')
    assert.match(rail, /status-pill status-false/, 'and the badge states which way it was determined')
  })
})

describe('SAE-19 — the fetches degrade without lying', () => {
  it('an unreachable reason catalogue falls back rather than offering nothing', async () => {
    const reasons = await fetchReasons({ fetchImpl: async () => { throw new Error('offline') } })
    assert.ok(reasons.justified.length > 0 && reasons.false.length > 0,
      'a dead catalogue must not leave the dialog with an empty dropdown')
  })

  it('an unreachable tally is null, not zero', async () => {
    assert.equal(await fetchCoverage({ fetchImpl: async () => { throw new Error('offline') } }), null)
    assert.equal(await fetchCoverage({ fetchImpl: async () => ({ ok: false, status: 503 }) }), null)
  })

  it('a tally that answers is passed through', async () => {
    const tally = await fetchCoverage({
      fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, data: { alerts: 4, determined: 1 } }) }),
    })
    assert.equal(tally.determined, 1)
  })

  /**
   * The regression that motivated this block, and the reason it drives the real
   * default rather than an injected stub.
   *
   * `apiFetch` returns a *parsed body* and throws on a non-ok status. Both
   * functions read `payload.ok` and `await payload.json()` — Response accessors
   * — so on every real call `payload.ok` was `undefined`, `fetchCoverage`
   * returned null, and `fetchReasons` fell through to the client's own copy.
   * Every test above injects a Response-shaped `fetchImpl`, so the stub matched
   * the caller and not the default, and the defect was invisible.
   *
   * These three call the functions with no seam at all, so they exercise
   * `apiFetch` exactly as `app.js` does.
   */
  describe('through the real apiFetch, not a Response-shaped stub', () => {
    const withServer = async (bodyFor) => {
      installBrowserEnv({
        respond: (url) => {
          const body = bodyFor(String(url))
          return body === undefined ? undefined : { body }
        },
      })
    }

    it('the coverage line reads a body apiFetch actually returns', async () => {
      await withServer((url) => (url.includes('/tally')
        ? { success: true, data: { alerts: 400, determined: 12, false_alerts: 2, justified: 10 } }
        : undefined))
      const tally = await fetchCoverage()
      assert.ok(tally, 'fetchCoverage returned null against a server that answered — the line would never render')
      assert.equal(tally.alerts, 400)
      assert.equal(tally.determined, 12)
    })

    it('the reason catalogue comes from the server, not the client copy', async () => {
      await withServer((url) => (url.includes('/reasons')
        ? { success: true, data: { reasons: { justified: ['server_side_reason'], false: ['server_false'] } } }
        : undefined))
      const reasons = await fetchReasons()
      assert.deepEqual(reasons.justified, ['server_side_reason'],
        'the client fell back to its own copy — a second definition of what a false alert is')
    })

    it('a server error still degrades rather than throwing', async () => {
      // `apiFetch` throws on a non-ok status; the catch is what makes the tally
      // cosmetic rather than fatal.
      installBrowserEnv({ respond: () => ({ ok: false, status: 503, body: { success: false } }) })
      assert.equal(await fetchCoverage(), null)
      assert.ok((await fetchReasons()).justified.length > 0)
    })
  })
})