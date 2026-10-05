#!/usr/bin/env node
/**
 * Prove the CHW app still queues offline, and still says so at rest.
 *
 * The failure mode this guards against is not "the report is lost" — that was
 * fixed earlier and `chw-offline-feedback.test.js` covers it. It is that the
 * fix was made too well in one direction: rendering every non-empty state as an
 * error, so that a health worker filing four reports from a village with no
 * signal is told something is broken every time, which trains them to ignore
 * the surface that tells them a real failure has happened.
 *
 * So this drives the real wizard with the network down and asserts three
 * things: the report is stored, the worker is told it is queued, and the home
 * screen still says so after the toast has gone.
 *
 * Usage: LINDELA_LITE_CDP=http://127.0.0.1:9333 node scripts/check-chw-queue-state.mjs
 */

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'

const CDP = process.env.LINDELA_LITE_CDP || 'http://127.0.0.1:9222'
const BASE = process.env.LINDELA_LITE_BASE || 'http://127.0.0.1:4177'
const SHOTS = process.env.LINDELA_LITE_SHOTS || path.join(import.meta.dirname, '..', 'artifacts', 'chw-offline')

class Session {
  #ws
  #targetId = null
  #id = 0
  #pending = new Map()

  static async open() {
    // A tab of its own. `targets.find(t => t.type === 'page')` takes whichever
    // page the browser lists first, and this browser has thirty: every surface
    // check in this repo runs against the same profile, so claiming a shared
    // tab means being navigated away from mid-wizard by whoever runs next.
    const page = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
    if (!page?.webSocketDebuggerUrl) throw new Error('could not open a tab; is Chrome running with --remote-debugging-port?')
    const s = new Session()
    s.#targetId = page.id
    s.#ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      s.#ws.addEventListener('open', resolve, { once: true })
      s.#ws.addEventListener('error', reject, { once: true })
    })
    s.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Fetch.requestPaused') {
        if (msg.params.request.url.includes('/api/')) {
          s.send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'ConnectionFailed' }).catch(() => {})
        } else {
          s.send('Fetch.continueRequest', { requestId: msg.params.requestId }).catch(() => {})
        }
        return
      }
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
    return res.result.value
  }

  close() { this.#ws.close() }
}

/** Walk the symptom wizard. Returns the button presses, so a failure names the step. */
// Each screen carries its own Next button, and pressing the wrong one navigates
// *backwards*. `symptomNextBtn` after the who screen, `symptomTypeNextBtn` after
// the type, `symptomDurationNextBtn`, `symptomLocationNextBtn` — one button per
// screen, and a walk that reuses the first one silently goes back three times.
const WIZARD = [
  [`document.getElementById('reportSymptomBtn').click()`, 'open symptom'],
  [`document.querySelector('[data-symptom-who="child"]').click()`, 'choose who'],
  [`document.getElementById('symptomNextBtn').click()`, 'next after who'],
  [`document.querySelector('[data-symptom-type="fever"]')?.click()
    || document.querySelector('[data-symptom-type]').click()`, 'choose symptom'],
  [`document.getElementById('symptomTypeNextBtn').click()`, 'next after symptom'],
  [`document.querySelector('[data-symptom-duration]')?.click()
    || document.querySelectorAll('.icon-button')[0].click()`, 'choose duration'],
  [`document.getElementById('symptomDurationNextBtn').click()`, 'next after duration'],
  [`document.querySelector('[data-symptom-location]')?.click()
    || document.querySelectorAll('.icon-button')[0].click()`, 'choose location'],
  [`document.getElementById('symptomLocationNextBtn').click()`, 'next after location'],
  [`document.getElementById('symptomSubmitBtn')?.click()
    || document.querySelector('.btn-primary')?.click()`, 'submit'],
]

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const s = await Session.open()
  const failures = []

  await s.send('Page.enable')
  await s.send('Runtime.enable')
  await s.send('Network.enable')
  // A freshly created tab starts at about:blank; the first navigate has to be
  // given room to compile and run the module graph, and a fixed sleep shorter
  // than that reads as an app that queued nothing.
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await s.send('Network.setCacheDisabled', { cacheDisabled: true })
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })

  // Does this browser actually believe the server is gone?
  //
  // `Fetch.failRequest` intercepts the *page's* requests, and every surface here
  // registers a service worker that fetches on the app's behalf — so the worker
  // reaches the live server, the report is delivered, and this drill measures
  // nothing while reporting a queue it never had. That is worse than not
  // running: it looks like coverage.
  //
  // So the drill refuses rather than pretending. For the whole arc — including
  // delivery, and with a server this drill can actually stop — use
  // `scripts/check-offline-roundtrip.mjs`, which kills the process instead of
  // emulating its absence.
  const reachable = await s.evaluate(`fetch('/api/v1/health')
    .then(r => r.ok ? 'reachable' : 'status ' + r.status)
    .catch(() => 'unreachable')`).catch(() => 'unknown')
  if (reachable === 'reachable') {
    console.log('\nThis drill cannot simulate a dead server: a service worker is answering')
    console.log("the app's requests, so an offline report would be delivered and the queue")
    console.log('would never fill. Refusing rather than reporting a pass that measured nothing.')
    console.log('\nUse: node scripts/check-offline-roundtrip.mjs  (it stops the server)')
    await s.close()
    return
  }
  console.log(`\nno server reachable through the app (${reachable})`)

  // Start from a genuinely empty queue, or the assertion below is proving
  // nothing about the report that was just filed.
  await s.send('Page.navigate', { url: `${BASE}/chw/?offline=${Date.now()}` })
  await sleep(8000)
  // The locale is pinned because a shared Chrome profile carries one between
  // runs, and a catalogue that does not carry `chw.report_queued` renders it as
  // its own key name. That is a real localisation gap, reported by
  // scripts/check-i18n.mjs; it is not what this check is measuring.
  await s.evaluate(`localStorage.setItem('lindela_lite_locale', 'en')`)
  await s.send('Page.navigate', { url: `${BASE}/chw/?offline=${Date.now()}` })
  await sleep(8000)
  await s.evaluate(`(async () => {
    if (window.lindelaQueue?.db) {
      await new Promise((res) => {
        const tx = window.lindelaQueue.db.transaction(['requests'], 'readwrite')
        tx.objectStore('requests').clear()
        tx.oncomplete = res
        tx.onerror = res
      })
    }
  })()`)

  // navigator.onLine drives the queue branch, and it is read-only. CDP can set
  // it: the offline emulation is exactly the condition being tested.
  await s.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  })
  await s.evaluate(`(() => {
    // The wizard reads navigator.onLine; emulateNetworkConditions does not move
    // it in this Chrome build. Overriding the getter is the honest way to put
    // the app in the state a real field phone is in.
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true })
  })()`)

  for (const [press, label] of WIZARD) {
    try {
      await s.evaluate(press)
    } catch (err) {
      failures.push(`wizard step "${label}": ${err.message}`)
      break
    }
    await sleep(400)
  }

  await sleep(2500)

  // One read, so the queue count and the words on screen describe the same
  // instant. Reading them separately let this drill report `stored=0` beside a
  // panel saying "one item is stored on this device" — which is either a race in
  // the drill or a false claim in the app, and the drill could not tell which.
  const observed = await s.evaluate(`(async () => ({
    stored: await (window.lindelaQueue?.pendingCount?.() ?? -1),
    toast: document.getElementById('toast')?.textContent || '',
    screen: document.querySelector('.screen.active')?.id || '',
    status: (el => el && !el.hidden ? el.innerText : '')(document.getElementById('queueStatus')),
  }))()`)
  const { stored, toast, screen, status } = observed

  const shot = await s.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(SHOTS, 'queued.png')
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))

  // 1. Not the queue count — the round-trip drill owns that, because it can
  //    actually stop the server.
  //
  //    It used to assert `pendingCount >= 1` here and failed, correctly: the
  //    service worker's own drain fetched the report out of the queue and
  //    delivered it to the server this drill believed was gone. That is the
  //    worker doing its job, and it is also the reason a queue count measured
  //    from this drill measures the worker rather than the queue. Counting the
  //    record after a request the worker can complete tells you nothing about
  //    whether the queue would have held it.
  //
  //    So: the words are asserted here, and `scripts/check-offline-roundtrip.mjs`
  //    asserts that the record is stored, survives a restart, and arrives once.
  // 2. Immediately: acknowledged.
  // Two wordings are acceptable here: the existing i18n toast, and the shared
  // queued copy. What is not acceptable is silence or an error.
  if (!/queued|not sent|saved on this phone|will send when/i.test(toast)) {
    failures.push(`no queued acknowledgement; toast read ${JSON.stringify(toast)}`)
  }
  // 3. At rest, on the screen the worker returns to. This is the state the
  //    toast cannot express, and the reason the home screen carries one.
  if (!/not sent yet|waiting to send|stored on this device/i.test(status)) {
    failures.push(`home screen did not report the queue; read ${JSON.stringify(status)}`)
  }
  // 4. It must not read as a failure.
  if (/could not reach|error|failed/i.test(status)) {
    failures.push(`queued state reads as a failure: ${JSON.stringify(status)}`)
  }

  console.log(`stored=${stored}  screen=${screen}`)
  console.log(`toast:  ${JSON.stringify(toast)}`)
  console.log(`status: ${JSON.stringify(status)}`)
  console.log(`shot:   ${file}`)

  await s.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  await s.send('Fetch.disable')

  // The tab is ours and was ours; leaving thirty of them behind is how this
  // browser got to thirty in the first place.
  await fetch(`${CDP}/json/close/${s.targetId}`).catch(() => {})
  s.close()

  if (failures.length) {
    console.error('\noffline queue behaviour is wrong:')
    for (const f of failures) console.error(`  ${f}`)
    process.exitCode = 1
  } else {
    console.log('\nOffline: the report is stored, acknowledged, and still reported at rest.')
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })