#!/usr/bin/env node
/**
 * Prove the surfaces tell the truth when the server is dead.
 *
 * Reproduces HX-03 directly: every request is failed at the network layer with
 * `Fetch.failRequest` / `ConnectionFailed`, so the browser behaves exactly as it
 * does on a dropped link, and the page is then read for what it says.
 *
 * The assertion is about the *words*, not the styling. A surface can pass this
 * by rendering anything so long as it never says "no X" or "nothing here"
 * after a failed fetch — because those are the sentences an operator acts on,
 * and acting on them when they are false is how a district stops being checked.
 *
 * Usage: LINDELA_LITE_CDP=http://127.0.0.1:9333 node scripts/check-dead-server-states.mjs
 */

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'

const CDP = process.env.LINDELA_LITE_CDP || 'http://127.0.0.1:9222'
const BASE = process.env.LINDELA_LITE_BASE || 'http://127.0.0.1:4177'
const SHOTS = process.env.LINDELA_LITE_SHOTS || path.join(import.meta.dirname, '..', 'artifacts', 'dead-server')

/** Sentences that assert the world is empty. Each is a blocker on its own. */
const FALSE_EMPTY = [
  /no pending workflows/i,
  /no active protocols/i,
  /no recent decisions/i,
  /no data available/i,
  /nothing here/i,
  /no recent alerts/i,
  /^no data$/i,
  // Not emptiness but the same class of error: a claim about the server's
  // configuration that a dead socket knows nothing about. A partner who reads
  // "Authentication required" re-issues credentials that were never the problem.
  /authentication is not configured/i,
  /authentication required/i,
  /sign in with your partner credentials/i,
]

/** Sentences that make the failure legible. Any one is enough. */
const HONEST_FAILURE = [
  /could not reach the server/i,
  /has not been checked/i,
  /not an empty list/i,
  /not sent yet/i,
  /connection lost/i,
]

class Session {
  #ws
  #targetId = null
  #id = 0
  #pending = new Map()

  static async open() {
    // A tab of its own. `targets.find(t => t.type === 'page')` takes whichever
    // page the browser lists first, and this browser has thirty: every surface
    // check in this repo runs against the same profile, so claiming a shared
    // tab means being navigated away from mid-render by whoever runs next. The
    // created tab is closed again on the way out, so running these in parallel
    // does not accumulate debris.
    const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
    const page = created
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
        // Only the data plane dies. Failing the document or the module graph
        // too would leave a blank page, which proves nothing about what the
        // surface says when the *server* is gone.
        if (!msg.params.request.url.includes('/api/')) {
          s.send('Fetch.continueRequest', { requestId: msg.params.requestId }).catch(() => {})
          return
        }
        s.send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'ConnectionFailed' })
          .catch(() => {})
        return
      }
      const waiter = s.#pending.get(msg.id)
      if (waiter) {
        s.#pending.delete(msg.id)
        if (msg.error) waiter.reject(new Error(msg.error.message))
        else waiter.resolve(msg.result)
      }
    })
    // The service worker has to be bypassed, or this gate does not test what it
    // claims to test.
    //
    // `Fetch.failRequest` only intercepts the *page's* requests. Every surface
    // here registers a service worker, and the worker fetches on their behalf —
    // so the requests this gate fails never happen, the worker reaches the live
    // server, and the surface gets a truthful answer. Measured before this line
    // existed: with every page request failing, `/portal` returned
    // `auth_configured: false` from a server that was answering, and the gate
    // reported the portal as misreporting a dead server. It was reporting the
    // opposite: the server was not dead.
    await s.send('Network.enable')
    await s.send('Network.setBypassServiceWorker', { bypass: true })
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

// The whole visible body, not a hand-listed set of ids. A list written today
// is a list that goes stale the moment a surface adds a container, and the
// container it misses is exactly the one carrying the lie.
//
// `innerText` and not `textContent`: it excludes `hidden` subtrees, so a
// retracted claim that was hidden rather than deleted is correctly reported as
// retracted. `textContent` would read the hidden copy and fail a correct fix.
const readText = `(() => {
  const ids = [
    'partnerOrg','portalError','portalIdentityError','pendingList','protocolsList',
    'auditList','statusText','alertText','queueStatus',
  ].map((id) => document.getElementById(id)?.innerText).filter(Boolean)
  return ids.join(' | ') + ' || ' + document.body.innerText
})()`

/** Retries must exist wherever the failure is shown, or the state is a dead end. */
const readRetry = `(() => {
  const hosts = ['portalError','portalIdentityError','pendingList','protocolsList','auditList','alertText']
  return hosts.some((id) => {
    const el = document.getElementById(id)
    return !!el?.querySelector?.('button.retry-btn, .retry-btn')
  })
})()`

const PAGES = [
  ['portal', '/portal/'],
  // The CHW alert card is loaded lazily, on the press that opens the reply
  // screen. Checking the landing page would only ever assert about the
  // symptom form, which is exactly what the original finding saw and called a
  // pass.
  ['chw', '/chw/', `document.getElementById('replyAlertBtn')?.click()`],
  ['focal-point', '/focal-point/'],
]

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const s = await Session.open()
  const failures = []

  await s.send('Page.enable')
  await s.send('Runtime.enable')
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })

  for (const [name, route, drive] of PAGES) {
    // Cache bypassed: the service worker serves the previous app.js from disk,
    // and a stale worker would make this check measure last week's fix.
    await s.send('Network.enable')
    await s.send('Network.setCacheDisabled', { cacheDisabled: true })
    await s.send('Page.navigate', { url: `${BASE}${route}?dead-server=${Date.now()}` })
    // Long enough for the slowest surface to have failed every request and
    // rendered. The finding used 6 s; this is the same wait with margin.
    await sleep(7000)
    if (drive) { await s.evaluate(drive); await sleep(4000) }

    const text = (await s.evaluate(readText)) || ''
    const retry = await s.evaluate(readRetry)

    const falseEmpty = FALSE_EMPTY.filter((re) => re.test(text)).map(String)
    const honest = HONEST_FAILURE.some((re) => re.test(text))

    const shot = await s.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(SHOTS, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))

    const problems = []
    if (!honest) problems.push('no honest-failure sentence')
    if (falseEmpty.length) problems.push(`asserted an empty list: ${falseEmpty.join(', ')}`)
    if (!retry) problems.push('no retry control')

    const status = problems.length ? 'FAIL' : 'ok  '
    console.log(`${status} ${name.padEnd(12)} retry=${retry ? 'y' : 'n'}  ${JSON.stringify(text.slice(0, 220))}`)
    console.log(`     ${file}`)
    if (problems.length) failures.push(`${route}: ${problems.join('; ')}`)
  }

  await s.send('Fetch.disable')

  // The tab is ours and was ours; leaving thirty of them behind is how this
  // browser got to thirty in the first place.
  await fetch(`${CDP}/json/close/${s.targetId}`).catch(() => {})
  s.close()

  if (failures.length) {
    console.error(`\n${failures.length} surface(s) misreported a dead server:`)
    for (const f of failures) console.error(`  ${f}`)
    process.exitCode = 1
  } else {
    console.log('\nEvery surface reported the failure instead of an empty list.')
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })