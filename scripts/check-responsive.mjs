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

/**
 * Surfaces where "measured nothing" is itself the failure.
 *
 * Every other surface always renders controls, so a zero here would mean the
 * probe broke. The dashboard renders its controls into an SVG that the map code
 * draws — so a data outage, a failed fetch or a refactor that dropped
 * `data-tap-target` all produce the same zero, and the tap-target result cannot
 * be read without it.
 */
const REQUIRE_MEASURED_TARGETS = new Set(['dashboard'])

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
  // How many controls the check actually looked at. Without this the gate is
  // vacuous: a dashboard whose map never rendered, or whose markers lost the
  // `data-tap-target` attribute in a refactor, reports zero undersized targets
  // and passes — indistinguishable from a dashboard where every marker clears
  // the floor. That is the same failure this selector was added to fix, one
  // level up.
  let measured = 0
  for (const el of doc.querySelectorAll(
    'button, input:not([type=hidden]), select, textarea, [data-tap-target]',
  )) {
    if (!shown(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    measured += 1
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

  // Controls cut off at the START edge.
  //
  // Overflow from the start is the one direction a browser will not scroll to:
  // `documentElement.scrollWidth` does not grow, so the overflow figure above
  // reads zero and passes. The console toolbar was doing exactly this — twelve
  // controls at x = -84 inside a 360px viewport, present, focusable, invisible,
  // and reported clean by this gate for as long as it existed. WCAG 2.2 §1.4.10.
  const clippedStart = []
  for (const el of doc.querySelectorAll(
    'button, input:not([type=hidden]), select, textarea, a[href], [data-tap-target], .filter-label',
  )) {
    if (!shown(el)) continue
    // `.visually-hidden` sits at margin:-1px by design and `.skip-link` at
    // top:-100%. Neither is a clipped control; both would fail on every surface
    // forever if they were counted.
    if (el.classList.contains('visually-hidden') || el.closest('[aria-hidden="true"]')) continue
    // A marker inside the map is not a clipped control. The map is a panning
    // surface: the viewBox is scaled to `slice` the element and the operator
    // drags to bring any marker into view, so a mark outside the window right now
    // is reachable by the map's own gesture. Measured against `meet` (which
    // letterboxed instead of cropping) the phone elements cropped horizontally
    // and nine more marks fell outside the window — the gate's job is a control
    // the reader cannot reach at all, and the map's marks are not that.
    if (el.closest('#situationMap')) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (rect.left < -1) {
      clippedStart.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: clsOf(el),
        left: Math.round(rect.left),
      })
    }
  }

  return {
    viewWidth,
    scrollWidth,
    overflow: scrollWidth - viewWidth,
    clippedStart: clippedStart.slice(0, 6),
    clippedStartCount: clippedStart.length,
    overflowing: overflowing.slice(0, 6),
    smallTargets: smallTargets.slice(0, 6),
    smallTargetCount: smallTargets.length,
    measuredTargetCount: measured,
    clipped: clipped.slice(0, 6),
    clippedCount: clipped.length,
  }
}

/**
 * Runs in the page. Are the console's rail tabs still reachable once the page
 * has been scrolled to the bottom?
 *
 * This is the one layout defect in the product that *every* assertion in this
 * file passes while it is happening. The tab strip is not hidden, not clipped
 * and not overflowing: it is laid out at a perfectly legal size, and the page
 * scroller has simply carried it off the top, where `getBoundingClientRect`
 * still reports a healthy width and height. Measured from a real render at
 * 414px: the strip sat at y = -230 with all five tabs past the top edge, and
 * the reader's only way back to another tab was to scroll up and hope.

 * So the check is not "does the strip exist" but "is a tap at the centre of
 * each tab actually delivered to that tab" — `elementFromPoint`, the same
 * question the browser asks on a real tap. That catches the two ways this
 * breaks at once: scrolled out of the viewport (hit test returns null) and
 * covered by the fixed navbar (hit test returns `.l-navbar`, which is what the
 * first screenful did before the strip was pinned below it).
 *
 * Returns null on any surface without a rail, which is most of them.
 */
function collectRailTabs() {
  const doc = document
  const tabs = [...doc.querySelectorAll('.rail-tab')]
  if (tabs.length === 0) return null
  const nav = doc.querySelector('.l-navbar')
  const navBottom = nav ? nav.getBoundingClientRect().bottom : 0
  const atBottom = (() => {
    const scroller = doc.scrollingElement || doc.documentElement
    const max = scroller.scrollHeight - scroller.clientHeight
    if (max > 0) scroller.scrollTop = max
    return Math.round(scroller.scrollTop)
  })()
  const unreachable = tabs.filter((tab) => {
    const r = tab.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return true
    const hit = doc.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2))
    return !(hit && (hit === tab || tab.contains(hit)))
  })
  return {
    tabCount: tabs.length,
    unreachableCount: unreachable.length,
    unreachable: unreachable.map((t) => t.dataset.tab || t.id || 'unnamed').slice(0, 5),
    navBottom: Math.round(navBottom),
    scrolledTo: atBottom,
  }
}

/**
 * How many controls a surface currently has laid out.
 *
 * Deliberately cheap — no geometry, no computed styles — because this runs on
 * every poll of the settle loop, and all it needs to answer is "has this page
 * stopped growing?".
 */
function countControls() {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  return [...document.querySelectorAll(
    'button, input:not([type=hidden]), select, textarea, [data-tap-target]',
  )].filter(visible).length
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

  // Every surface, every viewport, in both directions.
    //
    // RTL was not measured at all, and it could not have been caught by adding it
    // to VIEWPORTS: the console declares `[dir="rtl"] .console-layout` outside any
    // media query, which outranks a class inside the 800px breakpoint, so an
    // Arabic phone kept the desktop two-column grid and 66 controls sat past the
    // left edge. `scrollWidth` equalled `clientWidth` throughout, so the overflow
    // assertion was satisfied by a layout that was entirely wrong. Direction is a
    // dimension of this gate for the same reason width is: a mirrored layout is a
    // different layout, and it is not derived from the LTR one by the browser.
    for (const [name, path] of PAGES) {
      for (const dir of ['ltr', 'rtl']) {
      for (const vp of VIEWPORTS) {
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width,
          height: vp.height,
          deviceScaleFactor: 1,
          mobile: vp.width < 700,
        })
        await session.send('Page.navigate', { url: BASE + path })
        // Set after navigation: the surfaces apply `dir` themselves from the
        // locale, so setting it before the page loads is overwritten. This is
        // applied as the document settles, in `measure`.


        // Wait for the surface to settle rather than sleeping a fixed 2500ms.
        //
        // A fixed sleep made the whole gate timing-dependent, and it failed
        // silently in the direction that hides defects: a surface whose content
        // had not arrived yet reported *zero* controls, which reads exactly like
        // a surface where every control clears the floor. focal-point's rule form
        // (21px inputs, below the 24px floor) passed on one run and failed on the
        // next with no code change between them.
        //
        // Settling is: poll the same probe, and stop when the count of measured
        // controls has stopped changing. The cap is generous because a surface
        // that never settles must be reported, not waited on forever.
        let settled = 0
        let previous = -1
        for (let attempt = 0; attempt < 40 && settled < 3; attempt += 1) {
          await sleep(250)
          const probe = await session.send('Runtime.evaluate', {
            // Force the direction on every poll, after the page has run: the
            // surfaces set `dir` themselves from the selected locale, so anything
            // set before navigation is overwritten by the first render.
            expression: `(() => { document.documentElement.setAttribute('dir', ${JSON.stringify(dir)}); return (${countControls.toString()})(); })()`,
            returnByValue: true,
            awaitPromise: false,
          })
          const count = probe.result?.value ?? 0
          settled = count === previous && count > 0 ? settled + 1 : 0
          previous = count
        }

        // MIN_TAP is injected rather than re-declared inside collect(): the first
        // version of this probe hardcoded 44 in the page copy and 24 here, and
        // the gate kept reporting 24px controls as failures. One source of truth.
        const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
          expression: `(() => { document.documentElement.setAttribute('dir', ${JSON.stringify(dir)}); return (${collect.toString()})(${JSON.stringify(MIN_TAP)}); })()`,
          returnByValue: true,
          awaitPromise: false,
        })

        checks += 1
        if (exceptionDetails || !result.value) {
          failures.push(`${name} @ ${vp.name}: probe failed — ${exceptionDetails?.text || 'no result'}`)
          continue
        }

        const r = result.value
        const label = `${name} @ ${vp.name} (${vp.width}px) ${dir}`

        if (r.overflow > 1) {
          const worst = r.overflowing.map((o) => `${o.tag}.${o.cls}→${o.right}px`).join(', ') || 'unknown'
          failures.push(`${label}: horizontal overflow ${r.overflow}px — ${worst}`)
        }
        if (r.clippedStartCount > 0) {
          const worst = r.clippedStart.map((o) => `${o.tag}#${o.id}.${o.cls} at ${o.left}px`).join(', ') || 'unknown'
          failures.push(
            `${label}: ${r.clippedStartCount} control(s) off the start edge — ${worst}. `
            + 'A browser will not scroll to overflow from the start, so scrollWidth cannot see this.',
          )
        }
        if (r.clippedCount > 0) {
          failures.push(
            `${label}: ${r.clippedCount} element(s) clipped — ` +
            r.clipped.map((c) => `${c.tag}.${c.cls} "${c.text}"`).join('; ')
          )
        }
        if (REQUIRE_MEASURED_TARGETS.has(name) && r.measuredTargetCount === 0) {
          // The dashboard is the only surface with SVG controls the gate is
          // asserting on, so it is the only one where "found nothing" is a defect
          // rather than an honest report.
          failures.push(
            `${label}: no controls were measured — the tap-target check passed on nothing. `
            + 'Either the surface rendered empty or its controls lost data-tap-target.',
          )
        }
        if (r.smallTargetCount > 0) {
          failures.push(
            `${label}: ${r.smallTargetCount} control(s) below ${MIN_TAP}px — ` +
            r.smallTargets.map((t) => `${t.tag}#${t.id}.${t.cls} ${t.width}x${t.height}px`).join(', ')
          )
        }

        // The rail tabs, at the bottom of the page. Runs after `collect`, which
        // is the only probe that leaves the page scrolled where it found it.
        const railProbe = await session.send('Runtime.evaluate', {
          expression: `(() => { document.documentElement.setAttribute('dir', ${JSON.stringify(dir)}); return (${collectRailTabs.toString()})(); })()`,
          returnByValue: true,
          awaitPromise: false,
        })
        const rail = railProbe.result?.value
        if (rail && rail.unreachableCount > 0) {
          failures.push(
            `${label}: ${rail.unreachableCount} of ${rail.tabCount} rail tab(s) unreachable with the page scrolled to the bottom ` +
            `(${rail.unreachable.join(', ')}) — the strip is off-screen or under the navbar, so the reader cannot switch tabs. `
            + `scrollTop was ${rail.scrolledTo}, navbar bottom ${rail.navBottom}px.`,
          )
        }

        const ok = r.overflow <= 1 && r.clippedStartCount === 0 && r.clippedCount === 0 && r.smallTargetCount === 0
          && !(rail && rail.unreachableCount > 0)
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