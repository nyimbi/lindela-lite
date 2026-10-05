/**
 * A browser environment for the front end, in one place.
 *
 * R-73/R-74. 19 of 39 modules under `public/` could not be imported by Node,
 * covering 12,053 of 17,988 front-end lines — 67% of the client untestable.
 * The suite's response was source surgery: `chw-wizard-honesty.test.js` strips
 * every `import ` line and `vm.runInContext`s the remainder with a
 * hand-appended probe naming eight private locals. That mitigation was
 * duplicated **7 times**, 2,957 lines of a 32,682-line suite.
 *
 * The duplication is the expensive part, not the technique. Seven copies of a
 * DOM stub drift: one gains a property the code started using, six do not, and
 * the test that fails is whichever happened to be written against the drifted
 * copy. All seven were written against Node 20.
 *
 * Nothing here is clever. The whole problem was that a browser-absolute
 * specifier (`/shared/states.js`) has no meaning to Node's resolver, and
 * `registerHooks` solves that in eight lines — a fact `web-console.test.js`
 * already knew. This file is that eight lines plus the stubs, so the seventh
 * copy is never written.
 *
 * Node 26 note, because it is the reason the existing copies are broken rather
 * than merely duplicated: `navigator` is a **getter-only** global there
 * (`Object.getOwnPropertyDescriptor(globalThis, 'navigator')` has a `get` and
 * no `set`). Assigning `globalThis.navigator = {...}` is a silent no-op in
 * non-strict mode and a `TypeError` in strict mode — and ES modules are always
 * strict. So the assignment that every one of the seven copies performs either
 * does nothing or throws, and neither is reported. `defineNavigator` below
 * replaces the property outright.
 */

import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PUBLIC_ROOT = pathToFileURL(path.join(ROOT, 'public') + path.sep)

/* ================================================== module resolution === */

/**
 * Teach Node to resolve the front end's browser-absolute specifiers.
 *
 * `/shared/foo.js` means "a sibling of the page, in public/". This maps it to
 * the same file on disk. Idempotent, because `registerHooks` replaces rather
 * than stacks — and because several test files load the same modules, a
 * stacking implementation would resolve them differently depending on which
 * test ran first.
 */
export function installModuleResolution(publicRoot = PUBLIC_ROOT) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('/shared/')) {
        return { url: new URL(`.${specifier}`, publicRoot).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

/* ============================================================== DOM ==== */

/**
 * An element stub.
 *
 * Returns a fresh object each call because a module that holds a reference to
 * one element and later mutates it must not be able to see another test's
 * mutations — the failure mode of a shared singleton element is a test that
 * passes in isolation and fails in a suite, which is the worst kind.
 */
export function stubElement(tag = 'DIV') {
  const attrs = {}
  return {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)) },
      remove(...c) { c.forEach((x) => this._set.delete(x)) },
      contains(c) { return this._set.has(c) },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : Boolean(force)
        if (on) this._set.add(c); else this._set.delete(c)
        return on
      },
    },
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    options: [],
    selectedIndex: 0,
    childNodes: [],
    children: [],
    length: 0,
    parentNode: null,
    parentElement: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    attrs,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v) },
    removeAttribute: (k) => { delete attrs[k] },
    hasAttribute: (k) => k in attrs,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) {
      const i = this.children.indexOf(c)
      if (i >= 0) this.children.splice(i, 1)
      return c
    },
    insertBefore(c) { this.children.unshift(c); return c },
    replaceChildren() { this.children.length = 0 },
    // `remove()` is called on five surfaces to drop a stale node. A missing
    // stub here surfaces as an unhandled rejection *after* the test ends,
    // which reads as a flake in an unrelated test rather than as a gap in the
    // sandbox.
    remove() {
      const p = this.parentNode
      if (p && Array.isArray(p.children)) {
        const i = p.children.indexOf(this)
        if (i >= 0) p.children.splice(i, 1)
      }
      this.parentNode = null
    },
    prepend(c) { this.children.unshift(c); return c },
    // `append` takes several nodes and a string; `appendChild` takes one node.
    // The console uses both, and a stub with only `appendChild` fails at boot
    // with "append is not a function" from the map legend renderer.
    append(...nodes) {
      for (const n of nodes) {
        this.children.push(typeof n === 'string' ? { textContent: n } : n)
      }
    },
    appendText(t) { this.textContent += t },
    after() {},
    before() {},
    get firstElementChild() { return this.children[0] || null },
    get lastElementChild() { return this.children[this.children.length - 1] || null },
    get childElementCount() { return this.children.length },
    insertRow() {},
    cloneNode: () => stubElement(tag),
    querySelector: (sel) => stubElement(typeof sel === 'string' ? sel.replace(/^[.#]/, '') : 'div'),
    querySelectorAll: () => [],
    closest: () => null,
    matches: () => false,
    contains: () => false,
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    setSelectionRange() {},
    select() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    getClientRects: () => [],
    getBoundingClientRect_: undefined,
  }
}

/* ========================================================== globals ==== */

/**
 * Define a global, replacing any accessor property.
 *
 * `navigator` on Node 26 is getter-only, so a plain assignment cannot set it.
 * This deletes first, which works for both cases: a writable data property is
 * deleted and redefined, and an accessor is removed so the assignment lands.
 * Called with `define: true` it does not even try the assignment.
 */
function defineGlobal(name, value) {
  try {
    delete globalThis[name]
  } catch {
    // A non-configurable property cannot be replaced. Then the existing value
    // stands, and the caller is better served by a failure it can see than by
    // a silent no-op — which is exactly what `globalThis.navigator = x` is on
    // Node 26 and why this function exists.
    if (globalThis[name] === value) return true
    throw new Error(`cannot replace the non-configurable global "${name}"`)
  }
  Object.defineProperty(globalThis, name, {
    value, writable: true, enumerable: false, configurable: true,
  })
  return true
}

/** A `localStorage` that lives in this module, so tests do not leak into each other. */
export function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
}

/**
 * Install window, document and the globals every front-end module touches at
 * import time.
 *
 * Timers are stubbed to no-ops rather than real ones. The console's poll
 * self-reschedules through `setTimeout`, so with a real timer the test file
 * runs until the harness kills it rather than finishing — which looks like a
 * hung suite, not a passing one.
 *
 * @param {{ location?: object, online?: boolean, storage?: object,
 *           elements?: Map<string, object>, respond?: (url: string) => any }} [options]
 */
export function installBrowserEnv(options = {}) {
  const {
    location = {
      hash: '', search: '', href: 'http://localhost/',
      origin: 'http://localhost', pathname: '/', protocol: 'http:',
      host: 'localhost', hostname: 'localhost', port: '',
    },
    online = true,
    storage = makeStorage(),
    elements = new Map(),
    respond,
  } = options

  installModuleResolution()

  const byId = elements
  const getElementById = (id) => {
    if (!byId.has(id)) byId.set(id, stubElement())
    return byId.get(id)
  }

  const documentElement = stubElement('html')
  const body = stubElement('body')

  defineGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    location,
    document: undefined,                       // set below
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout, clearTimeout,
    setInterval, clearInterval,
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    scrollTo() {},
    open: () => null,
    location2: undefined,
  })

  defineGlobal('document', {
    getElementById,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    createElement: (tag) => stubElement(tag),
    createElementNS: (_ns, tag) => stubElement(tag),
    createTextNode: (t) => ({ textContent: t }),
    createDocumentFragment: () => stubElement('#fragment'),
    documentElement,
    body,
    head: stubElement('head'),
    scrollingElement: documentElement,
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    title: '',
    addEventListener() {},
    removeEventListener() {},
    fonts: { ready: Promise.resolve() },
    execCommand: () => true,
  })
  globalThis.window.document = globalThis.document

  defineGlobal('location', location)
  defineGlobal('localStorage', storage)
  defineGlobal('sessionStorage', makeStorage())

  // The one that breaks on Node 26 if assigned plainly. `userAgent` is read by
  // the offline path; `onLine` by `initOfflineBanner` and the queue.
  defineGlobal('navigator', {
    userAgent: 'node-test',
    language: 'en-GB',
    languages: ['en-GB'],
    onLine: online,
    hardwareConcurrency: 4,
    // `register()` resolves to a registration object, not undefined:
    // `initServiceWorker` reads `reg.scope` off the result, so a bare
    // `async () => undefined` throws a TypeError that surfaces as a console
    // message rather than as a test failure — a silent stub gap.
    serviceWorker: {
      register: async () => ({
        scope: 'http://localhost/',
        active: { state: 'activated', postMessage() {}, addEventListener() {} },
        waiting: null,
        installing: null,
        update: async () => undefined,
        unregister: async () => true,
        addEventListener() {},
        removeEventListener() {},
      }),
      addEventListener() {},
      removeEventListener() {},
      getRegistration: async () => undefined,
      ready: Promise.resolve(undefined),
      controller: null,
    },
    sendBeacon: () => true,
    clipboard: { writeText: async () => undefined, readText: async () => '' },
  })

  // `IntersectionObserver` / `ResizeObserver` / `MutationObserver` are
  // constructed at import time by the map and chart modules. Node has none of
  // them, and constructing an undefined global is a ReferenceError that stops
  // the module loading — so a stub with the methods the code actually calls.
  for (const name of ['IntersectionObserver', 'ResizeObserver', 'MutationObserver']) {
    defineGlobal(name, class {
      constructor(cb) { this.cb = cb }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    })
  }

  defineGlobal('requestAnimationFrame', (fn) => { setTimeout(fn, 0); return 0 })
  defineGlobal('cancelAnimationFrame', () => {})
  defineGlobal('CustomEvent', class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail }
  })
  defineGlobal('Event', class { constructor(type) { this.type = type } })
  defineGlobal('AbortController', globalThis.AbortController || class {
    constructor() { this.signal = { aborted: false, addEventListener() {} } }
    abort() { this.signal.aborted = true }
  })
  defineGlobal('indexedDB', undefined)
  defineGlobal('caches', undefined)

  defineGlobal('fetch', async (url) => {
    if (respond) {
      const custom = respond(String(url))
      if (custom !== undefined) {
        return {
          ok: custom.ok !== false,
          status: custom.status ?? 200,
          headers: { get: () => null },
          json: async () => custom.body,
          text: async () => (typeof custom.body === 'string' ? custom.body : JSON.stringify(custom.body ?? {})),
        }
      }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, data: [] }),
      text: async () => '',
    }
  })

  // The console's poll self-reschedules; a real timer never lets the test file
  // finish. Stubbed rather than tracked so a module that clears its own timers
  // behaves the same as one that does not.
  defineGlobal('setInterval', () => 0)
  // Captured *before* the globals are replaced. Naming these later would
  // resolve `setTimeout` to the stub installed two lines below, and the stub
  // calls itself — which is a stack overflow at import time, reported as
  // "Maximum call stack size exceeded" against browser-env.mjs with no hint
  // that the environment is the cause. It is the single most confusing failure
  // this file can produce, so the capture is explicit.
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis)

  defineGlobal('clearInterval', () => {})
  defineGlobal('setTimeout', (fn, ms) => {
    // Real timers still run — a module that awaits a resolved promise needs
    // them — but the delay is clamped, so a 30-second poll cannot keep the
    // test process alive for 30 seconds.
    if (typeof fn !== 'function') return 0
    return realSetTimeout(fn, 0)
  })
  defineGlobal('clearTimeout', (id) => realClearTimeout(id))

  return { byId, location, storage }
}

/**
 * Import a front-end module with the environment installed.
 *
 * @param {string} rel  e.g. 'app.js' or 'co/app.js'
 * @param {object} [options] passed to `installBrowserEnv`
 */
export async function importFrontEnd(rel, options = {}) {
  installBrowserEnv(options)
  return import(pathToFileURL(path.join(ROOT, 'public', rel)).href)
}