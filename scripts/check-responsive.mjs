#!/usr/bin/env node
/**
 * Responsive + layout regression gate.
 *
 * The existing dashboard browser check asserts that content is *present*. It
 * pinned itself to 1440x900 and drove everything with element.click(), so a
 * page could pass it while being unusable: the parametric Disbursement History
 * table lost its last column off the right edge, and the CHW app clipped its
 * own buttons at phone width. Both were invisible to every assertion in the
 * suite, because the content was in the document and absent from the screen.
 *
 * This checks the things that only exist once something has been laid out:
 * horizontal overflow, clipped text, and tap-target size. One tab per viewport,
 * measured against a real render.
 *
 * Usage: node scripts/check-responsive.mjs            (expects Chrome on :9222)
 *        LINDELA_LITE_CDP=http://127.0.0.1:9333 node scripts/check-responsive.mjs
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CDP = process.env.LINDELA_LITE_CDP || 'http://127.0.0.1:9222'
const BASE = process.env.LINDELA_LITE_BASE || 'http://127.0.0.1:4177'

/** Every surface. A surface never measured is a surface never checked. */
const PAGES = [
  ['dashboard', '/'],
  ['portal', '/portal/'],
  ['chw', '/chw/'],
  ['co', '/co/'],
  ['districts', '/districts/'],
  ['focal-point', '/focal-point/'],
  ['parametric', '/parametric/'],
  ['scenarios', '/scenarios/'],
]

/**
 * Viewports. 360 is the commonest low-end Android width in the field, 414 an
 * iPhone, 768 a tablet. The existing gate measured one viewport at 1440.
 */
const VIEWPORTS = [
  { name: 'phone-sm', width: 360, height: 740 },
  { name: 'phone', width: 414, height: 896 },
  { name: 'tablet', width: 768, height: 1024 },
]

/**
 * WCAG 2.2 SC 2.5.8 Target Size (Minimum) is 24x24 CSS px — that is the bar
 * this gate enforces. The product also declares a stricter `--tap-target-min`
 * of 44px for primary actions, which SC 2.5.5 sets at AAA; styles.css applies
 * that automatically on coarse pointers. Failing the gate below 24 is an
 * accessibility defect; failing it below 44 is a field-usability one, so the
 * two are reported separately rather than conflated.
 */
const MIN_TAP = 24

class Session {
  #ws
  #id = 0
  #pending = new Map()

  static async open() {
    const targets = await (await fetch(`${CDP}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('no page target; is Chrome running with --remote-debugging-port?')
    const s = new Session()
    s.#ws = new WebSocket(page.webSocketDebuggerUrl)
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

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.#ws.close()
  }
}

/**
 * Runs in the page. Returns the layout facts that only exist after render.
 *
 * Kept as one self-contained expression so it survives `Runtime.evaluate`
 * intact. It must reference nothing from this module's scope — a free variable
 * here throws ReferenceError in the page, and the first version of this probe
 * referenced MIN_TAP that way and failed every viewport with a bare "Uncaught".
 * Same class of trap check-dashboard-browser.mjs documents, where a stray
 * backslash made a regex match nothing and the assertion passed vacuously.
 */
function collect(minTap) {
  const doc = document
  const viewWidth = doc.documentElement.clientWidth
  const scrollWidth = doc.documentElement.scrollWidth
  const clsOf = (el) => String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
    .split(' ').filter(Boolean).slice(0, 2).join('.')
  const shown = (el) => {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  // Elements extending past the right edge of the viewport.
  const overflowing = []
  for (const el of doc.querySelectorAll('body *')) {
    const style = getComputedStyle(el)
    if (style.position === 'fixed') continue
    if (!shown(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (rect.right > viewWidth + 1) {
      overflowing.push({
        tag: el.tagName.toLowerCase(),
        cls: clsOf(el),
        right: Math.round(rect.right),
        text: (el.textContent || '').trim().slice(0, 48),
      })
    }
  }

  // Interactive controls below the tap-target floor.
  //
  // The selector originally listed only HTML form controls, which is why every
  // map marker on the situation map could be five CSS pixels across and CI
  // stayed green: SVG shapes were never queried at all. `[data-tap-target]` is
  // the console's own opt-in for "this SVG element is a control", so adding it
  // measures the map without guessing at SVG semantics.
  const smallTargets = []
  for (const el of doc.querySelectorAll(
    'button, input:not([type=hidden]), select, textarea, [data-tap-target]',
  )) {
    if (!shown(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (rect.height < minTap - 1 || rect.width < minTap - 1) {
      smallTargets.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: clsOf(el),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
      })
    }
  }

  // Text visually truncated by its own box — content in the document, absent
  // from the screen.
  const clipped = []
  for (const el of doc.querySelectorAll('td, th, .chip, .badge, kbd, .btn, .nav-link')) {
    if (!shown(el)) continue
    const style = getComputedStyle(el)
    if (style.overflow !== 'hidden' && style.textOverflow !== 'ellipsis') continue
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      clipped.push({
        tag: el.tagName.toLowerCase(),
        cls: clsOf(el),
        text: (el.textContent || '').trim().slice(0, 48),
      })
    }
  }

  return {
    viewWidth,
    scrollWidth,
    overflow: scrollWidth - viewWidth,
    overflowing: overflowing.slice(0, 6),
    smallTargets: smallTargets.slice(0, 6),
    smallTargetCount: smallTargets.length,
    clipped: clipped.slice(0, 6),
    clippedCount: clipped.length,
  }
}

async function main() {
  const session = await Session.open()
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Network.enable')
  // The service worker answers from its own cache. Left in place, the gate
  // measures whatever build was cached first — which is exactly how a stale
  // stylesheet can keep passing a check that no longer reflects the source.
  // check-dashboard-browser.mjs hit the same trap and clears both.
  await session.send('Network.clearBrowserCache')
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  await session.send('Page.navigate', { url: BASE + '/' })
  await sleep(500)
  await session.send('Runtime.evaluate', {
    expression: `(async () => {
      if (navigator.serviceWorker) {
        for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      }
      if (window.caches) for (const key of await caches.keys()) await caches.delete(key);
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  await sleep(500)

  const failures = []
  let checks = 0

  for (const [name, path] of PAGES) {
    for (const vp of VIEWPORTS) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.width < 700,
      })
      await session.send('Page.navigate', { url: BASE + path })
      // Long enough for the surfaces that fetch on load, short enough that the
      // whole sweep stays a CI-length task.
      await sleep(2500)

      // MIN_TAP is injected rather than re-declared inside collect(): the first
      // version of this probe hardcoded 44 in the page copy and 24 here, and
      // the gate kept reporting 24px controls as failures. One source of truth.
      const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
        expression: `(${collect.toString()})(${JSON.stringify(MIN_TAP)})`,
        returnByValue: true,
        awaitPromise: false,
      })

      checks += 1
      if (exceptionDetails || !result.value) {
        failures.push(`${name} @ ${vp.name}: probe failed — ${exceptionDetails?.text || 'no result'}`)
        continue
      }

      const r = result.value
      const label = `${name} @ ${vp.name} (${vp.width}px)`

      if (r.overflow > 1) {
        const worst = r.overflowing.map((o) => `${o.tag}.${o.cls}→${o.right}px`).join(', ') || 'unknown'
        failures.push(`${label}: horizontal overflow ${r.overflow}px — ${worst}`)
      }
      if (r.clippedCount > 0) {
        failures.push(
          `${label}: ${r.clippedCount} element(s) clipped — ` +
          r.clipped.map((c) => `${c.tag}.${c.cls} "${c.text}"`).join('; ')
        )
      }
      if (r.smallTargetCount > 0) {
        failures.push(
          `${label}: ${r.smallTargetCount} control(s) below ${MIN_TAP}px — ` +
          r.smallTargets.map((t) => `${t.tag}#${t.id}.${t.cls} ${t.width}x${t.height}px`).join(', ')
        )
      }

      const ok = r.overflow <= 1 && r.clippedCount === 0 && r.smallTargetCount === 0
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n`)

      // Capture through CDP rather than `chrome --headless --screenshot`.
      // That flag sizes the *window*, not the layout viewport, so the capture is
      // cropped to the requested width while the page laid out wider — which
      // renders a correct page as one with content running off the edge. The
      // audit doc records the same class of mistake: headless Chrome's default
      // is 756x469, which is a tablet width, so every mobile assertion ran
      // against a layout no field device sees.
      if (process.env.LINDELA_LITE_SHOTS) {
        const shot = await session.send('Page.captureScreenshot', { format: 'png' })
        if (shot?.data) {
          const { writeFile, mkdir } = await import('node:fs/promises')
          await mkdir(process.env.LINDELA_LITE_SHOTS, { recursive: true })
          await writeFile(
            `${process.env.LINDELA_LITE_SHOTS}/${name}-${vp.name}.png`,
            Buffer.from(shot.data, 'base64')
          )
        }
      }
    }
  }

  session.close()

  if (failures.length) {
    console.error('\nLayout failures:\n' + failures.map((f) => `  - ${f}`).join('\n'))
    process.exit(1)
  }
  console.log(`\nAll ${checks} surface/viewport combinations laid out cleanly.`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})