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

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * `registerHooks` is a Node 22.15 API, and `engines` says `>=20` because that is
 * what the *server* needs — `src/` never imports it. The tests do, so a
 * developer on Node 20 running `npm test` used to get
 * `SyntaxError: The requested module 'node:module' does not provide an export
 * named 'registerHooks'`, which names a module rather than a version and reads
 * like a broken checkout. The import is dynamic so this can say what is
 * actually wrong.
 *
 * Not expressed as `devEngines` in package.json: that would also be read by
 * `npm ci --omit=dev` in the Dockerfile, which builds on node:20 on purpose,
 * and a test-toolchain requirement must not be able to fail a production build.
 */
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 15)) {
  throw new Error(
    `the test harness needs Node 22.15+ (running ${process.versions.node}); `
    + 'the server itself still runs on Node 20 — see "engines" in package.json',
  )
}
const { registerHooks } = await import('node:module')

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
      // Every *root-relative* specifier a front-end module uses, not a list of
      // the directories that happened to exist when this was written. The
      // console and the CHW app lazy-load `/workflow/*.js` and `/panels/*.js`
      // the same way they import `/shared/*.js`, and an allow-list of three
      // prefixes made a test fail with ERR_MODULE_NOT_FOUND for a module that
      // exists — which reads as a missing file rather than as a gap in the
      // harness.
      //
      // The allow-list cost more than one confusing failure. `/action-rail.js`
      // sits at the root of `public/`, so it resolved nowhere; `lazy()` deletes
      // its cache entry on rejection and retries, so every poll tick re-imported
      // it and logged a stack. The suite still passed — the failure was caught
      // and reported as a dead panel — so the only symptom was a test file that
      // ran for two minutes and 200,000 error lines nobody read.
      //
      // Resolving against the filesystem rather than a prefix list is the fix
      // that cannot go stale: a specifier that names a file under `public/` is
      // that file, whatever directory it is in.
      if (specifier.startsWith('/') && !specifier.startsWith('//')) {
        const candidate = new URL(`.${specifier}`, publicRoot)
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true }
        }
        // A root-relative specifier with no file behind it is left to Node, so
        // the error names the missing module rather than this resolver.
      }
      return nextResolve(specifier, context)
    },
  })
}

/* ============================================================== DOM ==== */

/**
 * The elements a shallow scan of an `innerHTML` string can see.
 *
 * Not a parser and not trying to be: it reads start tags and their attributes,
 * which is exactly the surface the console's delegated handlers select on
 * (`[data-action]`, `[data-i18n]`, `.rail-tab`). It deliberately does *not*
 * model nesting, text nodes or the DOM tree — a half-DOM that answers nesting
 * questions wrongly is worse than one that answers none, because the test then
 * asserts against the stub's idea of structure rather than the console's.
 */
function scanHtml(html) {
  const out = []
  for (const [, tag, attrsText] of String(html).matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\/?>/g)) {
    const el = stubElement(tag)
    for (const [, name, value] of attrsText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      const lower = name.toLowerCase()
      if (lower === 'id' || lower === 'class' || lower.startsWith('data-')) {
        // The camelCase key the DOM uses, so `el.dataset.action` reads what the
        // console writes as `data-action`.
        const key = lower.startsWith('data-')
          ? lower.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          : lower
        el.dataset[key] = value ?? ''
      }
      if (lower === 'id') el.id = value ?? ''
      el.setAttribute(lower, value ?? '')
    }
    out.push(el)
  }
  return out
}

/**
 * Whether a scanned element matches a selector, for the shapes this codebase
 * uses: `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`, and comma-separated
 * unions of those.
 *
 * Anything else returns **false rather than throwing**, deliberately: a stub
 * that throws on a selector the real DOM understands turns a passing test into
 * a failing one for a reason that is about the harness. A selector this cannot
 * evaluate matches nothing — the same answer the old always-empty stub gave —
 * so nothing regresses, and a test needing a richer selector fails on its own
 * assertion rather than on the sandbox.
 */
function matchesSelector(el, sel) {
  return String(sel).split(',').some((part) => {
    const attr = part.trim().match(/^\[([\w:-]+)(?:([~^$*|]?=)"([^"]*)")?\]$/)
    if (attr) {
      const [, name, op, value] = attr
      const actual = name.toLowerCase().startsWith('data-')
        ? el.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
        : el.getAttribute(name.toLowerCase())
      if (op === undefined) return actual !== null && actual !== undefined
      return op === '=' ? actual === value : false
    }
    const m = part.trim().match(/^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?(?:#([\w-]+))?$/)
    if (!m) return false
    const [, tag, cls, id] = m
    if (!tag && !cls && !id) return false
    if (tag && el.tagName !== tag.toUpperCase()) return false
    if (cls && !el.classList.contains(cls)) return false
    if (id && el.id !== id) return false
    return true
  })
}

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
    // A real `CSSStyleDeclaration`, to the extent the console uses one.
    // `style: {}` meant every property assignment worked (a plain object takes
    // any key) and `setProperty` — the one method `applyMapTransform` calls —
    // threw. That threw inside `renderMap`, so the boot `refresh` aborted
    // before it reached the alert rail, and the wiring tests that wanted to
    // observe the rail's pager had to read `app.js` as text instead. A stub
    // that is missing one method is not a smaller stub; it is a different
    // program, and the tests written against it measure the stub.
    style: {
      _props: {},
      setProperty(name, value) { this._props[name] = String(value) },
      getPropertyValue(name) { return this._props[name] ?? '' },
      removeProperty(name) { const had = this._props[name]; delete this._props[name]; return had ?? '' },
    },
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
    // A file input's `files` is a FileList, and the field app reads
    // `$('incidentPhoto').files[0]` before every incident submission. A stub
    // without it is not a smaller stub: it throws inside the handler, so the
    // submission never reaches the queue and the test that wanted to observe the
    // queued record sees the app crash instead.
    files: [],
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
    // Listeners are *recorded*, not dropped. A no-op `addEventListener` makes
    // every delegated control undrivable, and the tests written against it
    // assert on the handler's source text instead of its effect — which is the
    // exact substitution this harness exists to remove. Recording costs nothing
    // for a module that only registers, and lets a test fire the click a
    // person would.
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type)
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    dispatchEvent: () => true,
    // The click handlers a test can drive. `fire(el, 'click', event)` in the
    // test is the caller; this is only the storage. A method, not an arrow —
    // an arrow in an object literal has no `this` to read `_listeners` from.
    listeners(type) { return (this._listeners.get(type) || []).slice() },
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
    // A deferred panel arrives through `insertAdjacentHTML`, and without it the
    // dialog surfaces cannot be opened at all — which is why their tests read
    // `app.js` as text. The ids in the inserted markup are handed to the
    // environment so `getElementById` finds them, exactly as the browser does;
    // the parse is deliberately shallow, because this stub is not a DOM and a
    // half-DOM that answers the wrong questions is worse than one that answers
    // none. `_onInsertHtml` is set by `installBrowserEnv`.
    insertAdjacentHTML(_position, html) {
      if (typeof this._onInsertHtml === 'function') this._onInsertHtml(String(html))
      this.innerHTML += String(html)
    },
    showModal() { this.open = true },
    close() {
      this.open = false
      for (const fn of this.listeners('close')) fn({ type: 'close', target: this })
    },
    open: false,
    cloneNode: () => stubElement(tag),
    /**
     * A scanned node when the element's markup has been set through
     * `innerHTML`, and a permissive stand-in otherwise.
     *
     * The fallback is not a convenience. This element's real children may live
     * in an `index.html` the harness never loads, so "the scan found nothing"
     * is *not* evidence that the selector matches nothing — and returning null
     * on that evidence makes every module-level `querySelector('.dialog-close')
     * .addEventListener(...)` throw at import. That is what happened to
     * `focal-point/app.js`, and the module-importability test caught it, which
     * is the test doing its job on the harness rather than on the console.
     */
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? stubElement(String(sel).replace(/^[.#]/, '')) },
    /**
     * The scan is cached against the `innerHTML` it was made from, because a
     * DOM returns the *same* nodes for the same markup and the console relies
     * on that: `renderAlertsPanel` selects `[data-action]` and attaches a
     * handler to each button, and the test then selects the same button to
     * fire it. Without the cache those are two different objects, the handler
     * lives on a node nobody can reach, and the test reports a decorative
     * button. Keyed on the markup so a re-render invalidates it for free.
     */
    querySelectorAll(sel) {
      if (this._scanFor !== this.innerHTML) {
        this._scanFor = this.innerHTML
        this._scan = scanHtml(this.innerHTML)
      }
      return this._scan.filter((el) => matchesSelector(el, sel))
    },
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
 * Define a global, replacing any accessor property, and return a function that
 * puts back whatever was there.
 *
 * `navigator` on Node 26 is getter-only, so a plain assignment cannot set it.
 * This deletes first, which works for both cases: a writable data property is
 * deleted and redefined, and an accessor is removed so the assignment lands.
 *
 * The restore matters as much as the install. A test file that installs an
 * environment and never removes it leaves the suite's remaining files running
 * against a stub DOM, which shows up as an unrelated test failing rather than
 * as a leak here.
 */
function defineGlobal(name, value) {
  // Every name this function replaces is recorded while an install is in
  // progress, so the restore below is built from what was actually defined
  // rather than from a list kept by hand beside it — a list that would drift the
  // first time someone added a global and forgot the second place.
  if (_recording) _recording.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
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

/** The descriptors `defineGlobal` is replacing, while an install is running. */
let _recording = null

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
 *           elements?: Map<string, object>, respond?: (url: string, init?: object) => any,
 *           document?: object, window?: object, navigator?: object,
 *           indexedDB?: object }} [options]
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
    // A caller with its own DOM — a test that needs a real element tree rather
    // than the id-keyed stub — supplies it here. The wizard's own tests build
    // one, because `showScreen` walks `.screen` nodes and a stub that answers
    // `querySelectorAll` with `[]` cannot tell a handler that hides the previous
    // screen from one that does not.
    document: documentOverride,
    window: windowOverride,
    navigator: navigatorOverride,
    // The offline queue is opened through `window.indexedDB`, falling back to
    // the global — IndexedDB belongs to a browsing context, not to a process, so
    // a worker has only the second and a page has both. A test that installs a
    // double has to be able to put it where the code looks, or every queue test
    // reports "this browser has no storage available" while the store sits on a
    // window the harness replaced a line later.
    indexedDB: indexedDBOverride,
  } = options

  installModuleResolution()
  const previous = new Map()
  _recording = previous

  const byId = elements
  const getElementById = (id) => {
    if (!byId.has(id)) byId.set(id, stubElement())
    return byId.get(id)
  }

  const documentElement = stubElement('html')
  const body = stubElement('body')
  // Deferred markup lands on `document.body`, and the dialog's controls are
  // reached by id afterwards. Registering the ids the insert declares is what
  // lets `loadOutcomeTemplate` wire its buttons to elements that exist — the
  // same reason the browser needs the markup in the document, not in a string.
  body._onInsertHtml = (html) => {
    for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
      if (!byId.has(id)) byId.set(id, stubElement())
    }
  }

  const win = windowOverride ?? {
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
  }
  // Merged rather than assigned only when absent: a caller who passes both a
  // window and an `indexedDB` double means the double, and a window stub with an
  // `indexedDB` of its own wins otherwise — the caller's option silently ignored
  // and the queue reading a different store than the test holds a reference to.
  if (indexedDBOverride) win.indexedDB = indexedDBOverride
  defineGlobal('window', win)

  defineGlobal('document', documentOverride ?? {
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
  defineGlobal('navigator', navigatorOverride ?? {
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

  // `init` carries what was sent. A responder that only sees the URL cannot
  // answer a question about the request body, and a test that needs the body
  // then has to read it off a stub the module was never given.
  defineGlobal('fetch', async (url, init) => {
    if (respond) {
      const custom = respond(String(url), init)
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
  /**
   * Timers, with the caller's delay preserved and the handle unreferenced.
   *
   * The delay used to be clamped to 0, which is not a smaller version of the
   * real delay — it is a different program. `schedulePoll` re-arms itself from
   * inside its own callback, so a 30-second poll clamped to 0 is a busy loop:
   * measured on `paging-scope-wiring.test.js`, one boot produced 206,246
   * "Action rail failed to render" stacks in 120 seconds, and the suite still
   * reported a pass because the failure was caught and logged as a dead panel.
   * A test that is green while spinning at 1,700 requests a second is measuring
   * the stub, not the console.
   *
   * Dropping delayed timers instead fixes the spin and breaks a different
   * thing: a test that awaits `setTimeout(resolve, 50)` never resolves, and the
   * whole file dies on an unsettled top-level await.
   *
   * So the delay is passed through and the handle is unreferenced. `unref` is
   * the exact tool for the two properties wanted at once — the timer still
   * fires if the loop is alive for other work, and it never *keeps* the loop
   * alive. That is what stops a 30-second poll outliving its test, which is the
   * problem the clamp was reaching for. Verified rather than assumed: an
   * unref'd zero-delay timer fires after a `setImmediate`, so deferring a
   * render this way still paints.
   */
  defineGlobal('setTimeout', (fn, ms) => {
    if (typeof fn !== 'function') return 0
    const handle = realSetTimeout(fn, Number(ms) || 0)
    handle?.unref?.()
    return handle
  })
  defineGlobal('clearTimeout', (id) => realClearTimeout(id))

  _recording = null

  /**
   * Put the host's globals back.
   *
   * Without this a test that installs an environment leaves the rest of the
   * suite — and every file that runs after it in the same process — looking at a
   * stub DOM, which fails as an unrelated test rather than as a leak here.
   */
  const restore = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
    previous.clear()
  }

  // `getElementById` is returned as well as `byId`, because it is the same
  // function the document uses and a test that creates an element the app has
  // not reached yet must land in the map the app reads from. Rebuilding it from
  // `byId` in each test is how the two drift.
  return { byId, getElementById, location, storage, restore }
}

/**
 * Import a front-end module with the environment installed.
 *
 * @param {string} rel  e.g. 'app.js' or 'co/app.js'
 * @param {object} [options] passed to `installBrowserEnv`, plus `fresh` and `env`
 */
export async function importFrontEnd(rel, options = {}) {
  // A caller that needs the environment's own handles — its `getElementById`, so
  // it can seed an element the app has not reached for yet — installs once and
  // passes the result back here. Installing a second time from the same options
  // is what this argument exists to prevent: two installs make two element maps,
  // the module captures its `toast` from the second, and the test reads `undefined`
  // off the first while every global it can see looks right. The failure is a
  // control that reports nothing, which reads as the app's bug rather than as
  // the harness's.
  const { fresh = false, env: installed, ...env } = options
  if (!installed) installBrowserEnv(env)
  const url = pathToFileURL(path.join(ROOT, 'public', rel))
  // ESM caches by URL, and every surface module carries top-level state — the
  // wizard's own `state`, `activeForm` and step list among them. A test that
  // boots twice in one file would otherwise measure the first boot's module, so
  // `fresh` gives each boot its own URL. It is the same file on disk; only the
  // cache key differs.
  if (fresh) url.searchParams.set('boot', String((bootCount += 1)))
  return import(url.href)
}

let bootCount = 0