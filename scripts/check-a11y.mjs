#!/usr/bin/env node
/**
 * Accessibility gate.
 *
 * Why this exists: check-dashboard-browser.mjs drives every surface with
 * element.click() from Runtime.evaluate, which bypasses the entire keyboard
 * path, and it makes zero assertions about accessibility — counted exhaustively
 * across its 890 lines: 0 occurrences of "focus", 0 role=, 0 tabindex, 0
 * scope=, 0 alt, 0 contrast, 0 reduced-motion, 0 zoom, 0 target size. So a page
 * can pass the whole suite while being unusable by keyboard and unreadable at
 * 400% zoom.
 *
 * check-responsive.mjs covers what only exists after layout — overflow, clipped
 * text, SC 2.5.8 target size. It measures geometry. It does not ask whether the
 * page is *navigable*, *named*, or *legible*. That is this file.
 *
 * Per surface it asserts:
 *   1. landmarks   exactly one <h1>, a <main>, a skip link whose href resolves
 *   2. headings    no level skipped going down (h1 -> h3 is a failure)
 *   3. form naming every visible input/select/textarea has a label, aria-label,
 *                  aria-labelledby, or an ancestor <label>
 *   4. images      every <img> has alt (decorative included: alt="")
 *   5. tables      every <th> under <thead> has scope
 *   6. contrast    real WCAG ratios from getComputedStyle, not token names
 *   7. keyboard    first Tab lands on the skip link; focus is always visible
 *   8. reduced motion  no infinite animation runs under prefers-reduced-motion
 *   9. zoom        320px viewport (WCAG 1.4.10 reflow at 400%) has no
 *                  horizontal overflow and no clipped text
 *
 * Usage: node scripts/check-a11y.mjs                 (expects Chrome on :9222)
 *        LINDELA_LITE_CDP=http://127.0.0.1:9333 node scripts/check-a11y.mjs
 */

import { setTimeout as sleep } from 'node:timers/promises'

const CDP = process.env.LINDELA_LITE_CDP || 'http://127.0.0.1:9222'
const BASE = process.env.LINDELA_LITE_BASE || 'http://127.0.0.1:4177'

/** Every surface. A surface never asserted is a surface never checked. */
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
 * Structural and contrast checks need a real, settled render; WCAG 1.4.10 asks
 * for no horizontal scrolling at 320 CSS px, which is exactly a 1280px screen at
 * 400% zoom. check-responsive measures 360/414/768 and misses it.
 */
const ZOOM_VIEWPORT = { width: 320, height: 640 }
const DESKTOP_VIEWPORT = { width: 1440, height: 900 }

/** How many offenders to name per failed check. All are reported in the count. */
const TOP_N = 4

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

/* ==================================================================
   Probes. Each is serialised with toString() and evaluated in the page,
   so none of them may close over this module's scope — a free variable
   throws ReferenceError and every surface fails with a bare "Uncaught".
   check-responsive.mjs records the same trap, and describe() was the
   casualty here on the first pass.
   ================================================================== */

/** 1-5: landmarks, heading order, form naming, images, table headers. */
function probeStructure() {
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
      .split(' ').filter(Boolean).slice(0, 2).join('.'),
    sel: el.id ? '#' + el.id : el.tagName.toLowerCase() +
      (String(el.className || '').split(' ').filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') || ''),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
  })

  const out = { h1Count: 0, mainCount: 0, skip: null, headingSkips: [], unnamed: [], imgNoAlt: [], thNoScope: [] }

  const h1s = document.querySelectorAll('h1')
  out.h1Count = h1s.length

  const mains = document.querySelectorAll('main, [role="main"]')
  out.mainCount = mains.length

  // The skip link is only real if its href resolves to something that exists.
  // A skip link pointing at #nothing is worse than none: it looks like the page
  // has one, so nobody checks, and the keyboard user still eats the whole nav.
  const link = document.querySelector('a.skip-link, a[href^="#"]:first-of-type')
  if (!link) out.skip = { present: false, reason: 'no anchor matching .skip-link' }
  else {
    const href = link.getAttribute('href') || ''
    const id = href.startsWith('#') ? href.slice(1) : ''
    const target = id ? document.getElementById(id) : null
    out.skip = {
      present: true,
      href,
      resolves: !!target,
      isFirstTabbable: link === document.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      reason: !id ? `href "${href}" is not a fragment` : target ? '' : `no element with id="${id}"`,
    }
  }

  // Heading order. Only going *down* matters: h2 -> h1 is a document that opens
  // a subsection, which is legal. h1 -> h3 says h2 was lost somewhere.
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((el) => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    if (el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false
    return el.getBoundingClientRect().height > 0
  })
  let prev = 0
  for (const el of headings) {
    const level = Number(el.tagName.slice(1))
    if (prev && level > prev + 1) {
      out.headingSkips.push({ ...describe(el), from: `h${prev}`, to: `h${level}` })
    }
    prev = level
  }

  // Form naming. A control with no accessible name is announced as "edit text"
  // or, worse, skipped entirely — and the field-note under it is read by nobody.
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden') continue
    if (el.closest('[hidden]')) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const named =
      !!el.getAttribute('aria-label') ||
      !!el.getAttribute('aria-labelledby') ||
      (el.id && !!document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
      !!el.closest('label')
    if (!named) out.unnamed.push({ ...describe(el), type: el.type || el.tagName.toLowerCase() })
  }

  for (const img of document.querySelectorAll('img')) {
    if (img.closest('[hidden]')) continue
    if (!img.hasAttribute('alt')) out.imgNoAlt.push({ ...describe(img), src: (img.getAttribute('src') || '').slice(-32) })
  }

  for (const th of document.querySelectorAll('thead th')) {
    if (th.closest('[hidden]')) continue
    if (!th.getAttribute('scope')) out.thNoScope.push(describe(th))
  }

  return out
}

/**
 * 6: contrast. Chrome preserves the colour space of the authored value, so a
 * token declared as oklch() comes back as oklch() (or, on newer builds, as
 * color(srgb ...)). Both are normalised to sRGB here — parsing only rgb() would
 * have reported every dark-theme text node as "unknown" and skipped it.
 */
function probeContrast() {
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
      .split(' ').filter(Boolean).slice(0, 2).join('.'),
    sel: el.id ? '#' + el.id : el.tagName.toLowerCase() +
      (String(el.className || '').split(' ').filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') || ''),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
  })

  /* --- colour normalisation ------------------------------------ */

  // oklch -> oklab -> linear sRGB -> gamma sRGB. The matrices are the ones
  // published with OKLab (Björn Ottosson); they are exact, not an approximation.
  function oklchToSrgb(L, C, H) {
    const h = (H * Math.PI) / 180
    const a = C * Math.cos(h)
    const b = C * Math.sin(h)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.291485548 * b
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ]
    return rgb.map((c) => {
      c = Math.max(0, Math.min(1, c))
      return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
    })
  }

  const num = (tok, scale) => (tok.endsWith('%') ? parseFloat(tok) / 100 : parseFloat(tok) / scale)

  /** Returns [r,g,b] 0..1 plus alpha, or null if the syntax is not one we know. */
  function parseColor(value) {
    if (!value) return null
    const v = value.trim().toLowerCase()
    if (v === 'transparent') return [0, 0, 0, 0]
    let m
    if ((m = v.match(/^rgba?\(([^)]+)\)$/))) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat)
      if (parts.length < 3 || parts.some(Number.isNaN)) return null
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.length > 3 ? parts[3] : 1]
    }
    if ((m = v.match(/^oklch\(([^)]+)\)$/))) {
      const p = m[1].split(/[\s/]+/).filter(Boolean)
      const Lraw = p[0]
      // Authored as a percentage or as 0..1; both appear in computed values.
      const L = Lraw.endsWith('%') ? parseFloat(Lraw) / 100 : parseFloat(Lraw)
      const C = p[1] && (p[1].endsWith('%') ? parseFloat(p[1]) / 100 : parseFloat(p[1]))
      const H = p[2] ? parseFloat(p[2]) : 0
      const alpha = p[3] == null ? 1 : (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]))
      if (Number.isNaN(L) || Number.isNaN(C) || Number.isNaN(H)) return null
      const rgb = oklchToSrgb(L, C, H)
      return [rgb[0], rgb[1], rgb[2], alpha]
    }
    if ((m = v.match(/^color\(srgb\s+([^)]+)\)$/))) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat)
      if (p.length < 3 || p.some(Number.isNaN)) return null
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
    }
    if ((m = v.match(/^oklab\(([^)]+)\)$/))) {
      // Not used by this product's token layer, but Chrome will hand one back
      // the moment a surface authors a colour directly in oklab.
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat)
      const L = p[0]
      const C = Math.hypot(p[1], p[2])
      const H = (Math.atan2(p[2], p[1]) * 180) / Math.PI
      const alpha = p[3] == null ? 1 : p[3]
      if (Number.isNaN(L)) return null
      return [...oklchToSrgb(L, C, H), alpha]
    }
    return null
  }

  const chan = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const luminance = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
  const ratio = (a, b) => {
    const l1 = luminance(a), l2 = luminance(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }

  const over = (fg, bg) => {
    const a = fg[3]
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]
  }

  /**
   * Effective background. Walks ancestors collecting semi-transparent layers
   * until it reaches an opaque one, then composites top-down. A straight
   * "first non-transparent ancestor" answers with the right hex for an opaque
   * panel and the wrong ratio for .notice-warn, whose fill is a 12% mix over
   * --bg — two layers that both have to be applied.
   */
  function effectiveBackground(el) {
    const layers = []
    let node = el
    while (node && node !== document.documentElement.parentNode) {
      const c = parseColor(getComputedStyle(node).backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
      node = node.parentElement
    }
    let base = [1, 1, 1, 1] // white paper under everything; nothing here is transparent to the root
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base)
    return base
  }

  /* --- collection ---------------------------------------------- */

  const failures = []
  let checked = 0

  const isVisuallyHidden = (el) => {
    // .visually-hidden and .skip-link are off-screen but painted 1x1 with a
    // clip. They are not text a sighted user reads, so WCAG 1.4.3 does not
    // apply to them and measuring them produced a permanent false failure.
    const s = getComputedStyle(el)
    if (s.clipPath && s.clipPath !== 'none') return true
    const r = el.getBoundingClientRect()
    return r.width <= 2 && r.height <= 2
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const el = node.parentElement
    if (!el) continue
    if (el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    if (style.opacity === '0') continue
    if (isVisuallyHidden(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue

    const fg = parseColor(style.color)
    if (!fg || fg[3] === 0) continue // transparent text is not a contrast failure
    const bg = effectiveBackground(el)
    const r = fg[3] < 1 ? ratio(over(fg, bg), bg) : ratio(fg, bg)

    const size = parseFloat(style.fontSize)
    const weight = parseInt(style.fontWeight, 10) || 400
    // WCAG 1.4.3 "large text" is 18.66px bold or 24px regular. The floor is 3:1.
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const floor = large ? 3 : 4.5

    checked += 1
    if (r < floor) {
      failures.push({
        ...describe(el),
        ratio: Math.round(r * 100) / 100,
        floor,
        font: `${Math.round(size)}px${weight >= 700 ? ' bold' : ''}`,
        fg: style.color,
        bg: `rgb(${bg.slice(0, 3).map((c) => Math.round(c * 255)).join(' ')})`,
        text,
      })
    }
  }

  failures.sort((a, b) => a.ratio - b.ratio)
  return { failures: failures.slice(0, 4), count: failures.length, checked }
}

/** 7: focus must be visible on whatever has it. */
function probeFocus() {
  const el = document.activeElement
  if (!el || el === document.body) return { focused: null }
  const s = getComputedStyle(el)
  const outlineVisible = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
  const shadowVisible = s.boxShadow && s.boxShadow !== 'none'
  const cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2)
  return {
    focused: {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: cls.join('.'),
      sel: el.id ? '#' + el.id : el.tagName.toLowerCase() + cls.map((c) => '.' + c).join(''),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    },
    outlineWidth: s.outlineWidth,
    outlineStyle: s.outlineStyle,
    boxShadow: s.boxShadow === 'none' ? '' : s.boxShadow,
    visible: outlineVisible || shadowVisible,
  }
}

/**
 * 8: reduced motion.
 *
 * Two probes, because neither alone is honest.
 *
 * document.getAnimations() sees everything including animations started from
 * app.js, and it is the obvious choice — except it returns an empty array on a
 * page whose computed animation-name is demonstrably "skeleton-sweep" and
 * infinite. Verified: on a backgrounded or freshly-navigated tab Chrome has not
 * necessarily instantiated the CSSAnimation yet, so the probe passes vacuously
 * on exactly the surfaces most likely to violate. That is an unverified
 * assertion dressed as a check.
 *
 * getComputedStyle is the reliable half: it has already applied the
 * prefers-reduced-motion media query by the time we read it, so "this element
 * is still set to animate forever" is answered directly. It cannot see the Web
 * Animations API, so the getAnimations() scan runs alongside it rather than
 * instead of it.
 */
function probeMotion() {
  const describeEl = (el) => {
    const cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2)
    return { sel: el.id ? '#' + el.id : el.tagName.toLowerCase() + cls.map((c) => '.' + c).join('') }
  }

  const running = []
  let scanned = 0
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el)
    const names = (s.animationName || '').split(',').map((n) => n.trim())
    if (!names.length || (names.length === 1 && names[0] === 'none')) continue
    const iters = s.animationIterationCount.split(',').map((n) => n.trim())
    const states = s.animationPlayState.split(',').map((n) => n.trim())
    const durs = s.animationDuration.split(',').map((n) => n.trim())
    names.forEach((name, i) => {
      if (!name || name === 'none') return
      scanned += 1
      const iteration = iters[i] ?? iters[0] ?? '1'
      const duration = durs[i] ?? durs[0] ?? '0s'
      // An infinite iteration count with no duration never advances, so it is
      // not motion. A paused animation is not motion either.
      if (iteration !== 'infinite') return
      if (duration === '0s') return
      if (states[i] === 'paused') return
      running.push({ name, ...describeEl(el), source: 'css' })
    })
  }

  const seen = new Set(running.map((r) => r.sel))
  for (const a of document.getAnimations()) {
    const timing = a.effect && a.effect.getComputedTiming()
    if (!timing) continue
    const infinite = timing.iterations === Infinity || String(timing.iterations) === 'Infinity'
    if (!infinite || a.playState !== 'running') continue
    const target = a.effect.target
    if (!target || !target.tagName) continue
    const d = describeEl(target)
    if (seen.has(d.sel)) continue
    running.push({ name: a.animationName || 'web-animations', ...d, source: 'waapi' })
  }

  return { scanned, total: document.getAnimations().length, running: running.slice(0, 4), count: running.length }
}

/** 9: reflow at 320px. Same facts check-responsive measures, at the width WCAG asks for. */
function probeZoom() {
  const doc = document
  const viewWidth = doc.documentElement.clientWidth
  const scrollWidth = doc.documentElement.scrollWidth
  const describe = (el) => {
    const cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2)
    return {
      sel: el.id ? '#' + el.id : el.tagName.toLowerCase() + cls.map((c) => '.' + c).join(''),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }
  }
  const shown = (el) => {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }
  const overflowing = []
  for (const el of doc.querySelectorAll('body *')) {
    if (getComputedStyle(el).position === 'fixed') continue
    if (!shown(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (rect.right > viewWidth + 1) {
      overflowing.push({ ...describe(el), right: Math.round(rect.right) })
    }
  }
  const clipped = []
  for (const el of doc.querySelectorAll('td, th, .chip, .badge, kbd, .btn, .nav-link')) {
    if (!shown(el)) continue
    const style = getComputedStyle(el)
    if (style.overflow !== 'hidden' && style.textOverflow !== 'ellipsis') continue
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) clipped.push(describe(el))
  }
  return {
    viewWidth,
    overflow: scrollWidth - viewWidth,
    overflowing: overflowing.slice(0, 4),
    overflowCount: overflowing.length,
    clipped: clipped.slice(0, 4),
    clippedCount: clipped.length,
  }
}

/* ================================================================== */

const call = async (session, fn, ...args) => {
  const res = await session.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`,
    returnByValue: true,
    // The service-worker teardown is async; without this it returns a pending
    // Promise, returnByValue serialises it as {}, and the caches survive.
    awaitPromise: true,
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'probe threw')
  }
  return res.result.value
}

const top = (rows, fmt) => rows.slice(0, TOP_N).map(fmt).join('; ')

async function main() {
  const session = await Session.open()
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Network.enable')

  // Retire the service worker and drop both caches first.
  //
  // public/sw.js serves app.js cache-first. Left in place, this gate measures
  // whatever bundle was cached first — a deliberate break in a surface's HTML
  // still reports PASS. check-dashboard-browser.mjs documents losing several
  // debugging cycles to exactly this. Verified by the negative control.
  await session.send('Network.clearBrowserCache')
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  await session.send('Page.navigate', { url: BASE + '/' })
  await sleep(600)
  await call(session, async function () {
    if (navigator.serviceWorker) {
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister()
    }
    if (window.caches) for (const key of await caches.keys()) await caches.delete(key)
    return true
  })

  const results = new Map(PAGES.map(([n]) => [n, {}]))

  for (const [name, path] of PAGES) {
    const r = results.get(name)
    const file = `public${path}index.html`

    /* --- structural + contrast, desktop ---------------------- */
    await session.send('Emulation.setDeviceMetricsOverride', {
      ...DESKTOP_VIEWPORT, deviceScaleFactor: 1, mobile: false,
    })
    await session.send('Page.navigate', { url: BASE + path })
    await sleep(2000)

    const s = await call(session, probeStructure)

    r.h1 = { pass: s.h1Count === 1, detail: s.h1Count === 1 ? '1 <h1>' : `${s.h1Count} <h1> elements` }
    r.main = { pass: s.mainCount >= 1, detail: `${s.mainCount} <main>` }
    r.skip = {
      pass: s.skip.present && s.skip.resolves && s.skip.isFirstTabbable,
      detail: !s.skip.present ? 'no skip link'
        : !s.skip.resolves ? `skip href="${s.skip.href}" → ${s.skip.reason}`
        : !s.skip.isFirstTabbable ? `skip href="${s.skip.href}" resolves but is not the first tabbable element`
        : `href="${s.skip.href}" resolves and is first`,
    }
    r.headings = {
      pass: s.headingSkips.length === 0,
      detail: s.headingSkips.length === 0
        ? 'no skipped levels'
        : top(s.headingSkips, (h) => `${h.from}→${h.to} at "${h.text}"`),
    }
    r.forms = {
      pass: s.unnamed.length === 0,
      detail: s.unnamed.length === 0 ? `${file}: all controls named`
        : top(s.unnamed, (u) => `${u.sel} (${u.type}) has no label/aria-label`),
    }
    r.images = {
      pass: s.imgNoAlt.length === 0,
      detail: s.imgNoAlt.length === 0 ? `${file}: every <img> has alt`
        : top(s.imgNoAlt, (i) => `${i.sel} src=…${i.src}`),
    }
    r.tables = {
      pass: s.thNoScope.length === 0,
      detail: s.thNoScope.length === 0 ? `${file}: every thead <th> has scope`
        : top(s.thNoScope, (t) => `${t.sel} "${t.text}"`),
    }

    const c = await call(session, probeContrast)
    r.contrast = {
      pass: c.count === 0,
      detail: c.count === 0
        ? `${c.checked} text nodes, min ratio ≥ 4.5:1`
        : `${c.count}/${c.checked} below floor — ` +
          top(c.failures, (f) => `${f.sel} ${f.ratio}:1 (needs ${f.floor}:1, ${f.font}, ${f.fg} on ${f.bg}) "${f.text}"`),
    }

    /* --- keyboard ------------------------------------------- */
    // A real key event through the input domain, not el.focus(): the whole point
    // is that :focus-visible only matches for keyboard interaction, and a
    // synthetic focus() would report a ring that a real tab would not draw.
    await call(session, function () {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
      window.scrollTo(0, 0)
      return true
    })
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', nativeVirtualKeyCode: 9 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', nativeVirtualKeyCode: 9 })
    await sleep(120)

    const f1 = await call(session, probeFocus)
    const isSkip = f1.focused && (f1.focused.cls.includes('skip-link') || f1.focused.sel === 'a')
    r.firstTab = {
      pass: !!f1.focused && isSkip,
      detail: !f1.focused ? 'Tab moved focus nowhere (document.body still active)'
        : isSkip ? `${f1.focused.sel} "${f1.focused.text}"` : `${f1.focused.sel} "${f1.focused.text}" — not the skip link`,
    }
    r.focusVisible = {
      pass: !!f1.focused && f1.visible,
      detail: !f1.focused ? 'no focused element'
        : f1.visible ? `outline ${f1.outlineWidth} ${f1.outlineStyle}` + (f1.boxShadow ? ' + ring' : '')
        : `${f1.focused.sel}: outline ${f1.outlineWidth} ${f1.outlineStyle}, box-shadow none — focus is invisible`,
    }

    /* --- reduced motion -------------------------------------- */
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await session.send('Page.navigate', { url: BASE + path })
    await sleep(2000)
    const m = await call(session, probeMotion)
    r.reducedMotion = {
      pass: m.count === 0,
      detail: m.count === 0
        ? `no infinite animation under reduce (${m.scanned} declared, ${m.total} live)`
        : `${m.count} infinite — ` + top(m.running, (a) => `${a.name} on ${a.sel} [${a.source}]`),
    }
    await session.send('Emulation.setEmulatedMedia', { features: [] })

    /* --- reflow / zoom --------------------------------------- */
    await session.send('Emulation.setDeviceMetricsOverride', {
      ...ZOOM_VIEWPORT, deviceScaleFactor: 1, mobile: true,
    })
    await session.send('Page.navigate', { url: BASE + path })
    await sleep(2000)
    const z = await call(session, probeZoom)
    r.zoom = {
      pass: z.overflow <= 1 && z.clippedCount === 0,
      detail: z.overflow > 1
        ? `${z.overflow}px horizontal overflow at ${z.viewWidth}px — ` + top(z.overflowing, (o) => `${o.sel}→${o.right}px`)
        : z.clippedCount > 0
          ? `${z.clippedCount} clipped — ` + top(z.clipped, (t) => `${t.sel} "${t.text}"`)
          : `no overflow, no clipping at ${z.viewWidth}px`,
    }
    await session.send('Emulation.clearDeviceMetricsOverride')
  }

  session.close()

  /* --- table ---------------------------------------------------- */
  const CHECKS = ['h1', 'main', 'skip', 'headings', 'forms', 'images', 'tables', 'contrast', 'firstTab', 'focusVisible', 'reducedMotion', 'zoom']
  const HEAD = ['h1', 'main', 'skip', 'head', 'form', 'img', 'th', 'contr', 'tab1', 'focus', 'motion', 'zoom']

  console.log(`\n${'surface'.padEnd(12)} ${HEAD.map((h) => h.padEnd(7)).join('')}`)
  console.log('─'.repeat(12 + 7 * CHECKS.length))

  let pass = 0, fail = 0
  const failures = []
  for (const [name] of PAGES) {
    const r = results.get(name)
    let line = name.padEnd(12)
    for (const key of CHECKS) {
      const c = r[key]
      if (!c) { line += '—'.padEnd(7); continue }
      if (c.pass) { pass++; line += `${'PASS'.padEnd(7)}` } else { fail++; line += `${'FAIL'.padEnd(7)}`; failures.push({ surface: name, key, detail: c.detail }) }
    }
    console.log(line)
  }

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} assertions across ${PAGES.length} surfaces.`)

  if (failures.length) {
    console.error('\nFailures:\n' + failures.map((f) => `  - [${f.surface}] ${f.key}: ${f.detail}`).join('\n'))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})