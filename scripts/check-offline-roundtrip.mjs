#!/usr/bin/env node
/**
 * Prove the offline queue *delivers*, which is the half that matters.
 *
 * `scripts/check-chw-queue-state.mjs` proves the other half: with the network
 * down a report is stored, the worker is told, and the home screen still says
 * so afterwards. That is the reassuring half, and it is the easy one — a queue
 * that accepts a write and never sends it produces exactly the same evidence.
 *
 * A report that sits on a phone for a week is silent loss wearing the costume of
 * "saved on this phone": the worker was told the truth, the record left their
 * hands, and nobody downstream ever learns it existed. So this drill walks the
 * whole arc and asserts on both ends of it:
 *
 *   1. the server is stopped — not emulated;
 *   2. a cold start with the server gone loads from cache and is the app;
 *   3. a report is filed and acknowledged as stored;
 *   4. the tab is closed and reopened, still without a server, and the report is
 *      still there — "stored" has to survive the app being killed, which on a
 *      phone is what happens every time the worker locks the screen;
 *   5. the server comes back on the same port and the same store, and the queue
 *      drains with nobody touching the app;
 *   6. **the server holds exactly one copy**, counted over HTTP;
 *   7. a report the server permanently rejects is visible and can be discarded.
 *
 * ## Why the server is killed rather than emulated
 *
 * Every attempt to simulate "offline" with CDP interception failed, and the
 * reason is worth recording, because it is the same trap twice.
 *
 * `Fetch.failRequest` only intercepts the *page's* requests. Every surface here
 * registers a service worker, and the worker fetches on the app's behalf — so the
 * requests being failed never happen, the worker reaches the live server, and the
 * report is delivered to a server the drill believes is gone. Measured here: the
 * queue read empty, the toast said "one item is stored on this device", and the
 * server's own record count had gone up by one at that moment.
 *
 * `Network.setBypassServiceWorker` fixes the *page's* side and not the worker's:
 * the worker's internal `fetch` is a separate request, on a separate target, that
 * neither interception nor a page-target bypass reaches.
 *
 * Killing the process is the only simulation that is not a simulation. It is also
 * what a phone with no data experiences — a refused connection rather than a
 * cached answer — so the drill ends up testing the real thing.
 *
 * Usage: LINDELA_LITE_CDP=http://127.0.0.1:9333 node scripts/check-offline-roundtrip.mjs
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CDP = process.env.LINDELA_LITE_CDP || 'http://127.0.0.1:9222'
const PORT = Number(process.env.LINDELA_LITE_PORT || 4187)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = process.env.LINDELA_LITE_SHOTS || path.join(import.meta.dirname, '..', 'artifacts', 'offline-roundtrip')
const SERVER = path.join(import.meta.dirname, '..', 'src', 'server.js')
const STORE = path.join(SHOTS, 'roundtrip-store.json')

/** Wait for a page expression to be truthy, rather than sleeping and hoping. */
async function waitFor(session, expression, { timeoutMs = 20_000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await session.evaluate(`(async () => { try { return ${expression} } catch (e) { return null } })()`)
      if (last) return last
    } catch { /* the page may be navigating */ }
    await sleep(250)
  }
  throw new Error(`timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`)
}

class Session {
  #ws
  #targetId = null
  #id = 0
  #pending = new Map()

  static async open() {
    const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
    if (!created?.webSocketDebuggerUrl) {
      throw new Error('could not open a tab; is Chrome running with --remote-debugging-port?')
    }
    const s = new Session()
    s.#targetId = created.id
    s.#ws = new WebSocket(created.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      s.#ws.addEventListener('open', resolve, { once: true })
      s.#ws.addEventListener('error', reject, { once: true })
    })
    s.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const waiter = s.#pending.get(msg.id)
      if (waiter) {
        s.#pending.delete(msg.id)
        if (msg.error) waiter.reject(new Error(msg.error.message))
        else waiter.resolve(msg.result)
      }
    })
    return s
  }

  get targetId() { return this.#targetId }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate threw')
    return res.result?.value
  }

  async shot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }

  async close() {
    try { await this.send('Page.close') } catch { /* the tab may already be gone */ }
    this.#ws.close()
  }
}

/* ----------------------------------------------------------- the server */

let child = null

async function startServer() {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      LINDELA_LITE_STORE: STORE,
      LINDELA_LITE_PORT: String(PORT),
      LINDELA_LITE_SCHEDULER_INTERVAL_SECONDS: '3600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch { /* not up yet */ }
    await sleep(200)
  }
  throw new Error('the server did not come up')
}

async function stopServer() {
  if (!child) return
  const dying = child
  child = null
  dying.kill('SIGTERM')
  await sleep(500)
  if (dying.exitCode === null) dying.kill('SIGKILL')
  // Wait for the port to actually refuse, so "the server is gone" is a fact and
  // not a hope: a request that lands during the kill would be delivered to a
  // process the drill has already stopped counting.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(1000) })
      await sleep(150)
    } catch {
      return true
    }
  }
  throw new Error('the server is still answering after SIGTERM')
}

async function serverIsDown() {
  try {
    await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(1200) })
    return false
  } catch {
    return true
  }
}

async function fieldReports() {
  const res = await fetch(`${BASE}/api/v1/field-reports?limit=5000`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

/* ------------------------------------------------------------- the drill */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  // A fresh store every run, so "exactly one copy" counts this run's report
  // rather than every report this machine has ever filed.
  try { fs.unlinkSync(STORE) } catch { /* first run */ }

  const s = await Session.open()
  const failures = []
  const pass = (name, detail = '') => console.log(`  ok   ${name}${detail ? `  — ${detail}` : ''}`)
  const fail = (name, detail) => { console.log(`  FAIL ${name}  — ${detail}`); failures.push(`${name}: ${detail}`) }

  await s.send('Page.enable')
  await s.send('Runtime.enable')
  await s.send('Network.enable')  // A phone, because the queue is a field feature and a desktop viewport would
  // let a layout-only pass read as evidence about a mobile one.
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: 412, height: 915, deviceScaleFactor: 2, mobile: true,
  })

  try {
    console.log('\nstart the server and install the service worker')
    await startServer()
    await s.send('Page.navigate', { url: `${BASE}/chw/?warm=${Date.now()}` })
    await sleep(7000)
    const registered = await s.evaluate(`navigator.serviceWorker.ready.then(() => true).catch(() => false)`)
    if (!registered) fail('the service worker registers', 'navigator.serviceWorker.ready never settled')
    else pass('the service worker registers')

    const persistence = await s.evaluate(`(async () => {
      if (!navigator.storage?.persist) return 'unsupported'
      return (await navigator.storage.persisted()) ? 'granted' : 'not-granted'
    })()`)
    pass('storage persistence', persistence)
    if (persistence !== 'granted') {
      console.log('  note  the browser has not promised not to evict this origin, so a queued report '
        + 'stored through seven days of no use can be deleted (see test/offline-delivery.test.js)')
    }

    // A shared Chrome profile carries a locale between runs, and a catalogue
    // without the queued string renders the key itself — a real localisation gap,
    // and not what this drill measures.
    await s.evaluate(`localStorage.setItem('lindela_lite_locale', 'en')`)

    // Empty the queue too, for the same reason the store is deleted above.
    // IndexedDB belongs to the browser profile, not the run, so a dead letter
    // from an earlier run stays listed: the "permanently rejected" step read
    // `listed=2` and `discarded=1` because a previous run's report was still
    // there, and the count grew with every run. A drill that fails for the state
    // of the machine rather than the state of the code is not measuring the code.
    const cleared = await s.evaluate(`window.lindelaQueue ? window.lindelaQueue.clear().then(() => true).catch(() => false) : true`)
    if (!cleared) console.log('  note  the offline queue could not be cleared before the walk')

    console.log('\nstop the server')
    await stopServer()
    if (await serverIsDown()) pass('the server is gone', 'the port refuses connections')
    else fail('the server is gone', 'it is still answering')

    console.log('\ncold start with no server')
    await s.send('Page.navigate', { url: `${BASE}/chw/?cold=${Date.now()}` })
    await sleep(7000)
    const shell = await s.evaluate(`(() => ({
      isErrorPage: /ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|Chrome Error/.test(document.body.innerText || ''),
      hasWizard: !!document.getElementById('symptomNextBtn') || !!document.querySelector('[data-symptom-who]'),
      chars: (document.body.innerText || '').trim().length,
      title: document.title,
    }))()`)
    if (shell.isErrorPage) fail('a cold start with no server is the app', 'the browser served its error page')
    else if (!shell.hasWizard) fail('a cold start with no server is the app', `the shell rendered ${shell.chars} chars with no wizard`)
    else pass('a cold start with no server is the app', `${shell.chars} chars, "${shell.title}"`)

    // Two honest answers when the server is gone: the request fails, or the
    // worker returns its explicit offline marker. A **200** is the one dishonest
    // answer — that is a cached "the server is healthy", which is exactly what a
    // health check must never say from a cache, and what this drill found.
    const health = await s.evaluate(`fetch('/api/v1/health')
      .then(r => 'status ' + r.status + ' offline=' + r.headers.get('x-lindela-offline'))
      .catch(e => 'threw ' + e.message)`)
    if (/^threw/.test(String(health)) || /offline=1/.test(String(health))) {
      pass('and its data requests fail honestly', String(health))
    } else {
      fail('and its data requests fail honestly',
        `the app got ${health} from a server that is not running — a cached health ` +
        'answer is the one thing this endpoint must never produce')
    }

    const list = await s.evaluate(`fetch('/api/v1/incidents?limit=1')
      .then(r => 'status ' + r.status + ' offline=' + r.headers.get('x-lindela-offline'))
      .catch(e => 'threw ' + e.message)`)
    if (/^threw/.test(String(list)) || /offline=1/.test(String(list)) || /status 503/.test(String(list))) {
      pass('and a cached data endpoint says it is stale', String(list))
    } else {
      console.log(`  note  /api/v1/incidents answered ${list} — a data endpoint may ` +
        'legitimately serve the last known state, provided it is labelled')
    }
    await s.shot('01-cold-offline')

    console.log('\nfile a report with the server down')
    // The walk follows the wizard's own step order — who, type, severity,
    // exposure, duration, location, about-who — and each step asserts the screen
    // it expects is the active one before pressing anything.
    //
    // Two earlier versions of this walk were fiction, and both failed the same
    // way. `showScreen` only toggles a class: a hidden screen's buttons stay
    // bound, so `getElementById('symptomLocationNextBtn').click()` fires whether
    // or not the location screen is showing. The first version pressed the wrong
    // Next and walked *backwards*; the second skipped severity and exposure
    // entirely, leaving `duration_value` null on a field the form marks
    // `required: true` — so the server answered 400, the queue dead-lettered the
    // report, and the drill reported "walked 10 steps" about a wizard that never
    // left the duration screen. Asserting `state.currentScreen` is what makes a
    // step a step rather than a click.
    const WIZARD = [
      [`document.getElementById('reportSymptomBtn').click()`, 'open symptom', 'symptom'],
      [`document.querySelector('[data-symptom-who="child"]').click()`, 'choose who', 'symptom'],
      [`document.getElementById('symptomNextBtn').click()`, 'next after who', 'symptomType'],
      [`document.querySelector('[data-symptom-type="fever"]').click()`, 'choose symptom', 'symptomType'],
      [`document.getElementById('symptomTypeNextBtn').click()`, 'next after symptom', 'symptomSeverity'],
      [`document.getElementById('severityNextBtn').click()`, 'skip danger signs', 'symptomExposure'],
      // The exposure screen refuses to advance with every select empty, so the
      // water source is chosen — it is the one a report without a location still
      // needs, and the guard names it.
      [`(() => {
         const water = document.getElementById('exposeWater')
         if (water) water.value = 'clean'
       })()`, 'choose water source', 'symptomExposure'],
      [`document.getElementById('exposureNextBtn').click()`, 'next after exposure', 'symptomDuration'],
      // The count, not only the unit. `durationValue` is `required: true` in
      // `CHW_SYMPTOM_FORM`, and the duration screen's Next returns early while it
      // is empty — so a walk that sets the unit and moves on submits a report the
      // server refuses.
      [`(() => {
         const v = document.getElementById('durationValue')
         if (v) { v.value = '2'; v.dispatchEvent(new Event('input', { bubbles: true })) }
       })()`, 'type the duration count', 'symptomDuration'],
      [`document.querySelector('[data-symptom-duration="days"]').click()`, 'choose duration unit', 'symptomDuration'],
      [`document.getElementById('symptomDurationNextBtn').click()`, 'next after duration', 'symptomLocation'],
      // Manual coordinates rather than auto-detect: geolocation cannot succeed in
      // a headless browser, and a drill whose location step waits on a permission
      // prompt fails for a reason that has nothing to do with the queue. A real
      // handset takes the auto path, through the same code. "Use this location"
      // is the press that records them — Next only reads `state.symptom.location`
      // and writes `not_answered` when it is still null, so typing without
      // pressing the button is a location nobody recorded.
      [`(() => {
         const lat = document.getElementById('manualLat'); const lon = document.getElementById('manualLon')
         if (lat && lon) { lat.value = '-3.1'; lon.value = '35.6' }
       })()`, 'type a location', 'symptomLocation'],
      [`document.getElementById('useManualLocationBtn').click()`, 'use this location', 'symptomLocation'],
      [`document.getElementById('symptomLocationNextBtn').click()`, 'next after location', 'symptomAboutWho'],
      [`document.getElementById('symptomSubmitBtn').click()`, 'submit', 'home'],
    ]
    const walked = []
    let walkFailed = null
    for (const [press, label, expectScreen] of WIZARD) {
      try {
        await s.evaluate(`(() => { ${press}; return true })()`)
        await sleep(450)
        const now = await s.evaluate(`window.__lindelaChwState?.currentScreen ?? document.querySelector('.screen.active')?.id ?? null`)
        const actual = String(now || '').replace(/Screen$/, '')
        if (expectScreen && actual !== expectScreen) {
          walkFailed = `${label}: expected the ${expectScreen} screen, the app is on ${actual || 'none'}`
          walked.push(`${label} (stuck on ${actual || 'none'})`)
          break
        }
        walked.push(label)
      } catch (error) {
        walkFailed = `${label}: ${String(error.message).slice(0, 80)}`
        walked.push(`${label} (threw)`)
        break
      }
    }
    console.log(`  note  walked ${walked.length} steps: ${walked.join(' → ')}`)
    if (walkFailed) {
      fail('the wizard can be walked to submission', walkFailed)
    } else {
      pass('the wizard can be walked to submission', `${walked.length} steps, ending on the home screen`)
    }

    const stored = await waitFor(s, `window.lindelaQueue?.pendingCount?.().then(n => n > 0)`, {
      timeoutMs: 20_000, label: 'the report to be queued',
    }).then(() => true).catch(() => false)
    if (stored) pass('the report is stored on the device')
    else {
      const state = await s.evaluate(`(async () => ({
        pending: await window.lindelaQueue.pendingCount(),
        rows: await window.lindelaQueue.list(),
        toast: (document.querySelector('[role="status"]')?.innerText || '').slice(0, 100),
      }))()`).catch((e) => ({ error: e.message }))
      fail('the report is stored on the device',
        `pending=${state.pending} rows=${JSON.stringify(state.rows)} toast=${JSON.stringify(state.toast)}`)
    }
    await s.shot('02-queued')

    console.log('\nkill the tab and reopen it, still with no server')
    await s.send('Page.reload')
    await sleep(7000)
    const survived = await s.evaluate(`window.lindelaQueue?.pendingCount?.().then(n => n)`).catch(() => null)
    if (survived > 0) pass('the queued report survives the app being killed', `${survived} still held`)
    else fail('the queued report survives the app being killed', `the queue reports ${survived} after a restart with no server`)
    await s.shot('03-after-restart')

    console.log('\nbring the server back on the same store; nobody touches the app')
    await startServer()
    // Wait for the report to *arrive*, not for the queue to look empty.
    //
    // `pendingCount() === 0` is true whether the report was delivered or thrown
    // away: `pendingCount` filters `failed` records out, so a 4xx dead-letter
    // empties the count exactly as a delivery does. The drill asserted the empty
    // count, read 0 reports over HTTP, and called it "the queue drains" — the one
    // outcome it exists to rule out, wearing the evidence of success.
    const delivered = await waitFor(s, `fetch('${BASE}/api/v1/field-reports?limit=5000')
      .then(r => r.json()).then(b => (b.data || []).length > 0).catch(() => false)`, {
      timeoutMs: 40_000, label: 'the report to reach the server',
    }).then(() => true).catch(() => false)

    const reports = await fieldReports()
    if (reports.length === 1) {
      pass('the server holds exactly one copy', `${reports.length} field report`)
      console.log(`  note  delivered: ${JSON.stringify(reports[0]).slice(0, 220)}`)
    } else {
      const held = await s.evaluate(`(async () => JSON.stringify(await window.lindelaQueue.list({ failed: true })))()`)
        .catch(() => 'unreadable')
      fail('the server holds exactly one copy',
        `the server holds ${reports.length} copies of one report; dead letters: ${String(held).slice(0, 400)}`)
    }
    if (delivered) pass('the queue drains by delivering, not by discarding')
    else fail('the queue drains by delivering, not by discarding', 'nothing reached the server')

    // A second flush must not send a second copy: the idempotency key is what
    // makes a retried drain safe, and this is where that is either true or not.
    await s.evaluate(`window.lindelaQueue?.flush?.()`).catch(() => {})
    await sleep(2500)
    const second = await fieldReports()
    if (second.length === reports.length) pass('a second flush sends nothing')
    else fail('a second flush sends nothing', `the server went from ${reports.length} to ${second.length}`)

    console.log('\na report the server permanently rejects')
    await s.evaluate(`window.lindelaQueue.enqueue('/api/v1/field-reports', {
      method: 'POST', body: { title: 'Roundtrip rejected on purpose', type: 'field_report' },
    }, { what: 'a report the server will refuse' }).catch(e => e)`)
    // Let the drain attempt it, so the record is actually a dead letter rather
    // than a record that has not been tried. The assertion below is about the
    // *failed* state, and an untried record would satisfy a bare length check
    // while proving nothing about what happens after a permanent rejection.
    await sleep(1200)
    const poisoned = await s.evaluate(`(async () => {
      const failed = await window.lindelaQueue.list({ failed: true })
      const mine = failed.find((r) => r.what === 'a report the server will refuse')
      return mine ? { id: mine.id, attempts: mine.attempts, lastError: mine.lastError, failed: mine.failed } : null
    })()`).catch((e) => ({ error: e.message }))
    if (!poisoned || poisoned.error) {
      fail('a permanently rejected report becomes a dead letter',
        `it was not listed as failed: ${JSON.stringify(poisoned)}`)
    } else {
      pass('a permanently rejected report becomes a dead letter',
        `attempts=${poisoned.attempts} lastError=${poisoned.lastError}`)
    }
    // Discard *that* record and assert the store shrank by one, rather than
    // asserting the queue is empty afterwards. The old form compared a raw length
    // against a post-discard length, which is only equal when nothing else is
    // held — so a leftover from an earlier run read as a broken discard.
    const discarded = await s.evaluate(`(async () => {
      const before = await window.lindelaQueue.list()
      const target = before.find((r) => r.what === 'a report the server will refuse')
      if (!target) return { error: 'the rejected report is not listed, so a worker cannot act on it' }
      await window.lindelaQueue.discard(target.id)
      const after = await window.lindelaQueue.list()
      return {
        before: before.length, after: after.length,
        stillThere: after.some((r) => r.id === target.id),
      }
    })()`).catch((e) => ({ error: e.message }))
    if (discarded?.error) {
      fail('it is visible and can be discarded', discarded.error)
    } else if (discarded.stillThere || discarded.after !== discarded.before - 1) {
      fail('it is visible and can be discarded',
        `before=${discarded.before} after=${discarded.after} stillThere=${discarded.stillThere}`)
    } else {
      pass('it is visible and can be discarded', `${discarded.before} → ${discarded.after} records`)
    }
    await s.shot('04-dead-letter')
  } finally {
    await stopServer().catch(() => {})
    await s.close()
  }

  console.log('')
  if (failures.length) {
    console.log(`${failures.length} offline round-trip check(s) failed:`)
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
    return
  }
  console.log('Offline: stored on the device, survived a restart, delivered itself '
    + 'when the server came back, and arrived exactly once.')
}

await main()
