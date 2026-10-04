// Lindela Lite — shared cross-surface navbar

/* Lindela Lite — theme selection (ENH-23), part of the shared navbar rather
   than a module of its own.

   Three themes, one attribute on <html>, and tokens.css does the rest: setting
   data-theme is the whole mechanism, which is why a theme costs a block in the
   token file rather than a pass over eight HTML files.

   FIRST PAINT. The platform preference is resolved by two @media blocks in
   tokens.css with no JavaScript at all; this code only adds the explicit
   override on top. Resolving everything here instead would be a deferred module
   resolving it a frame after the paint — and this file is imported by every
   one of the eight surfaces, which is also why it is here: a ninth request on
   a field connection to carry sixty lines is a worse trade than the bytes.

   SURVIVES lang/dir: initI18n rewrites lang and dir and nothing else, so a
   locale switch cannot clear the theme — a property of the source that
   test/theme-choice.test.js greps every file in public/ to keep true. */

export const THEMES = ['dark', 'light', 'contrast']
export const CHOICES = ['system', 'dark', 'light', 'contrast']
export const STORAGE_KEY = 'lindela-lite-theme'

/** The bar above a standalone window: a literal in eight <head>s, and the one
 *  piece of chrome the token layer cannot repaint. */
export const THEME_COLOR = {
  dark: '#0e1520',
  light: '#f7f8fa',
  contrast: '#000000',
}

/**
 * Which theme a state resolves to. Pure, and the only place precedence lives:
 * a stored choice beats the platform, and "more contrast" beats "light" because
 * it is the more specific thing the user asked for.
 */
export function resolveTheme({ stored, prefersLight = false, prefersContrast = false } = {}) {
  if (stored && stored !== 'system' && THEMES.includes(stored)) return stored
  if (prefersContrast) return 'contrast'
  if (prefersLight) return 'light'
  return 'dark'
}

export function normalizeChoice(value) {
  return CHOICES.includes(value) ? value : 'system'
}

/** localStorage throws rather than returning null in Safari private mode and in
 *  a quota-exhausted origin. A theme switch is a preference; it must never be
 *  what stops a console booting. */
export function readStoredChoice(storage) {
  try {
    return normalizeChoice(storage && storage.getItem(STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function writeStoredChoice(storage, choice) {
  const value = normalizeChoice(choice)
  try {
    if (!storage) return value
    if (value === 'system') storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, value)
  } catch {
    // The theme still applies for this page view.
  }
  return value
}

export function platformPreferences(win) {
  if (!win || typeof win.matchMedia !== 'function') return { prefersLight: false, prefersContrast: false }
  return {
    prefersLight: !!win.matchMedia('(prefers-color-scheme: light)').matches,
    prefersContrast: !!win.matchMedia('(prefers-contrast: more)').matches,
  }
}

/** Apply a choice. `null` means "system", i.e. no attribute: a real state, not a
 *  no-op, because it hands the decision back to the media queries. */
export function applyChoice(doc, choice, win) {
  const normalised = normalizeChoice(choice)
  const root = doc && doc.documentElement
  if (!root) return null

  if (normalised === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', normalised)

  const meta = doc.querySelector('meta[name="theme-color"]')
  if (meta) {
    const theme = resolveTheme({ stored: normalised, ...platformPreferences(win) })
    meta.setAttribute('content', THEME_COLOR[theme] || THEME_COLOR.dark)
  }
  return normalised === 'system' ? null : normalised
}

/**
 * The preference control, mounted twice — in the bar and in the hamburger
 * dialog — with a media query so exactly one is laid out. In the bar it is
 * hidden below 720px because the bar already holds the brand, the language
 * picker and the hamburger within about ten pixels of a 320px viewport, and a
 * third select is a guaranteed scrollbar on the display this product is used
 * on.
 */
export function mountThemeControl(container, { doc = globalThis.document, win = globalThis } = {}) {
  if (!container || !doc || container.querySelector('.l-theme-select')) return null

  const select = doc.createElement('select')
  select.className = 'l-theme-select'
  // Named rather than labelled-by-a-<label>: the bar has no room for one, and
  // check-a11y.mjs fails an unnamed control on all eight surfaces.
  select.setAttribute('aria-label', 'Colour theme')

  for (const [value, text] of [
    ['system', 'Theme: system'],
    ['dark', 'Theme: dark'],
    ['light', 'Theme: light'],
    ['contrast', 'Theme: high contrast'],
  ]) {
    const option = doc.createElement('option')
    option.value = value
    option.textContent = text
    select.appendChild(option)
  }

  select.value = readStoredChoice(win.localStorage)
  select.addEventListener('change', () => {
    writeStoredChoice(win.localStorage, select.value)
    applyChoice(doc, select.value, win)
  })

  container.appendChild(select)
  return select
}

/** Resolve, persist and follow. Exported so a test can drive it against a stub. */
export function initTheme({ doc = globalThis.document, win = globalThis } = {}) {
  const stored = readStoredChoice(win.localStorage)
  applyChoice(doc, stored, win)

  // While no choice has been made, keep following the platform — and do so by
  // leaving the attribute absent rather than by pinning a resolved theme, since
  // an explicit attribute outranks the media queries in tokens.css and would
  // strand the user in the theme they were on at sunset.
  if (typeof win.matchMedia === 'function') {
    for (const query of ['(prefers-color-scheme: light)', '(prefers-contrast: more)']) {
      const list = win.matchMedia(query)
      if (typeof list.addEventListener !== 'function') continue
      list.addEventListener('change', () => {
        if (normalizeChoice(readStoredChoice(win.localStorage)) === 'system') applyChoice(doc, 'system', win)
      })
    }
  }
  return stored
}

// Guarded so the module can be imported under Node, which is how the tests read
// it. Importing this file is the whole registration: shared/navbar.js imports
// it and every surface imports the navbar, so no surface opts in and none can
// forget to.
if (typeof document !== 'undefined' && typeof window !== 'undefined') initTheme()
const SURFACES = [
  { path: '/', key: 'nav.ops', label: 'Ops' },
  { path: '/focal-point', key: 'nav.focal_point', label: 'Focal Point' },
  { path: '/chw', key: 'nav.chw', label: 'CHW' },
  { path: '/portal', key: 'nav.portal', label: 'Portal' },
  { path: '/co', key: 'nav.co', label: 'CO' },
  { path: '/scenarios', key: 'nav.scenarios', label: 'Scenarios' },
  { path: '/parametric', key: 'nav.parametric', label: 'Parametric' },
  { path: '/districts', key: 'nav.districts', label: 'Districts' },
]

const NAVBAR_CSS = `
.l-navbar {
  position: fixed;
  top: 0;
  inset-inline: 0;
  /* inset-inline: 0 alone does not bound a fixed flex container: its items
     default to min-width:auto, so at 360px the bar sized itself to 389px of
     brand + locale + hamburger and pushed a horizontal scrollbar onto the
     whole document. */
  min-width: 0;
  max-width: 100vw;
  overflow: hidden;
  height: var(--size-topbar);
  z-index: 999;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--stroke);
  display: flex;
  align-items: center;
  padding: 0 var(--sp-4);
  gap: var(--sp-2);
  font-size: var(--text-sm);
}
.l-navbar-brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--ink);
  text-decoration: none;
  font-weight: 600;
  flex-shrink: 0;
  min-width: 0;
  margin-inline-end: var(--sp-3);
}
.l-navbar-links {
  display: flex;
  align-items: center;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
}
.l-navbar-links::-webkit-scrollbar { display: none; }
.l-navbar-links a {
  display: block;
  padding: 0 var(--sp-3);
  height: 30px;
  line-height: 30px;
  border-radius: var(--r-sm);
  color: var(--ink-muted);
  text-decoration: none;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.l-navbar-links a:hover {
  background: var(--surface-hover);
  color: var(--ink);
}
.l-navbar-links a[aria-current='page'] {
  background: var(--surface);
  color: var(--ink);
}
.l-navbar-end {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-shrink: 0;
  min-width: 0;
  margin-inline-start: auto;
}
.l-navbar-locale {
  font-size: var(--text-xs);
  background: transparent;
  color: var(--ink-muted);
  border: 1px solid var(--stroke);
  border-radius: var(--r-sm);
  padding: 2px var(--sp-2);
  min-width: 0;
  max-width: 8rem;
  cursor: pointer;
}
.l-navbar-locale:hover { color: var(--ink); }
/* Styled exactly as the language control: a bespoke size would need its own
   target-size measurement. Hidden in the bar below 720px, where the hamburger
   dialog carries it — at 320px the bar has ten pixels of slack and this select
   is 130 of them. */
.l-theme-select {
  font-size: var(--text-xs);
  background: transparent;
  color: var(--ink-muted);
  border: 1px solid var(--stroke);
  border-radius: var(--r-sm);
  padding: 2px var(--sp-2);
  min-width: 0;
  max-width: 8.5rem;
  cursor: pointer;
}
.l-theme-select:hover { color: var(--ink); }
.l-navbar .l-theme-select { display: none; }
@media (min-width: 721px) { .l-navbar .l-theme-select { display: block; } }
.l-navbar-dialog .l-theme-select { display: block; width: 100%; margin-block-end: var(--sp-2); }
.l-conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
  flex-shrink: 0;
}
.l-conn-dot.offline { background: var(--sev-high); }
.l-hamburger {
  display: none;
  align-items: center;
  justify-content: center;
  width: var(--tap-target-min);
  height: var(--tap-target-min);
  background: none;
  border: none;
  color: var(--ink-muted);
  cursor: pointer;
  border-radius: var(--r-sm);
  padding: 0;
}
.l-hamburger:hover { background: var(--surface-hover); color: var(--ink); }
.l-navbar-dialog:not([open]) { display: none; }
.l-navbar-dialog[open] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--bg-elevated);
  border: none;
  padding: var(--sp-4);
  width: 100%;
  max-width: 100%;
  height: 100%;
  max-height: 100%;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.l-navbar-dialog::backdrop { background: oklch(0% 0 0 / 0.5); }
.l-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-4);
}
.l-dialog-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--tap-target-min);
  height: var(--tap-target-min);
  background: none;
  border: none;
  color: var(--ink-muted);
  cursor: pointer;
  border-radius: var(--r-sm);
  font-size: 1.25rem;
  line-height: 1;
}
.l-dialog-close:hover { background: var(--surface-hover); color: var(--ink); }
.l-navbar-dialog a {
  display: block;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r);
  color: var(--ink-muted);
  text-decoration: none;
  font-size: var(--text-body);
}
.l-navbar-dialog a:hover { background: var(--surface-hover); color: var(--ink); }
.l-navbar-dialog a[aria-current='page'] { background: var(--surface); color: var(--ink); }
body.has-navbar { padding-top: 44px; }
@media (max-width: 720px) {
  .l-navbar-links { display: none; }
  .l-hamburger { display: flex; }
}
@media (prefers-reduced-motion: reduce) {
  .l-navbar-links a { transition: none; }
}
[dir='rtl'] .l-navbar { flex-direction: row-reverse; }
[dir='rtl'] .l-navbar-brand { flex-direction: row-reverse; }
[dir='rtl'] .l-navbar-end { margin-inline-start: unset; margin-inline-end: auto; }
`

/**
 * A label in the reader's language, or in English — never the key.
 *
 * `window.__i18n.t()` returns its argument when the catalogue does not carry
 * it, and an empty catalogue carries nothing. So a nav mounted before
 * `initI18n` resolved rendered `nav.ops`, `nav.focal_point`, `nav.chw` in the
 * bar across every surface that raced it, and stayed that way: `applyI18n()`
 * had already run, so nothing came back to repair it. The bar is the one piece
 * of chrome a translator is guaranteed to be handed verbatim, so a key leaking
 * into it is not a cosmetic defect.
 *
 * The surface still has to await its catalogue — see `mountNavbar` — because a
 * fallback renders English, and English is the wrong answer to a reader who
 * asked for Swahili. This only guarantees the failure mode is legible.
 */
function i18nText(key, fallback) {
  const catalog = window.__i18n && window.__i18n.catalog
  return (catalog && catalog[key]) || fallback
}

function isActive(activePath, surfacePath) {
  if (surfacePath === '/') return activePath === '/'
  return activePath === surfacePath || activePath.startsWith(surfacePath + '/')
}

export function renderNavbar({ activePath = '/', locales, currentLocale, onLocaleChange } = {}) {
  const nav = document.createElement('nav')
  nav.className = 'l-navbar'
  nav.setAttribute('role', 'navigation')
  nav.setAttribute('aria-label', 'Surfaces')

  // Brand
  const brand = document.createElement('a')
  brand.href = '/'
  brand.className = 'l-navbar-brand'
  brand.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3" fill="currentColor"/>' +
    '<circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5"/>' +
    '<circle cx="12" cy="12" r="11" stroke="currentColor" stroke-width="1" fill="none" opacity="0.25"/>' +
    '</svg>'
  const wordmark = document.createElement('span')
  wordmark.textContent = 'Lindela'
  brand.appendChild(wordmark)
  nav.appendChild(brand)

  // Surface links (desktop)
  const ul = document.createElement('ul')
  ul.className = 'l-navbar-links'
  for (const s of SURFACES) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = s.path
    a.textContent = i18nText(s.key, s.label)
    a.setAttribute('data-i18n', s.key)
    if (isActive(activePath, s.path)) a.setAttribute('aria-current', 'page')
    li.appendChild(a)
    ul.appendChild(li)
  }
  nav.appendChild(ul)

  // End: optional locale switcher + connection dot
  const end = document.createElement('div')
  end.className = 'l-navbar-end'

  if (locales && locales.length > 0 && typeof onLocaleChange === 'function') {
    const sel = document.createElement('select')
    sel.className = 'l-navbar-locale'
    sel.setAttribute('aria-label', 'Language')
    for (const loc of locales) {
      const opt = document.createElement('option')
      opt.value = loc.value
      opt.textContent = loc.label
      if (loc.value === currentLocale) opt.selected = true
      sel.appendChild(opt)
    }
    sel.addEventListener('change', () => onLocaleChange(sel.value))
    end.appendChild(sel)
  }

  const dot = document.createElement('span')
  dot.className = 'l-conn-dot' + (navigator.onLine ? '' : ' offline')
  dot.setAttribute('aria-hidden', 'true')
  window.addEventListener('online', () => dot.classList.remove('offline'))
  window.addEventListener('offline', () => dot.classList.add('offline'))
  end.appendChild(dot)
  mountThemeControl(end)
  nav.appendChild(end)

  // Hamburger (mobile only, visible via CSS)
  const hamburger = document.createElement('button')
  hamburger.className = 'l-hamburger'
  hamburger.type = 'button'
  hamburger.setAttribute('aria-label', i18nText('nav.menu', 'Menu'))
  hamburger.setAttribute('data-i18n-title', 'nav.menu')
  hamburger.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">' +
    '<line x1="2" y1="4.5" x2="16" y2="4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<line x1="2" y1="9" x2="16" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<line x1="2" y1="13.5" x2="16" y2="13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>'
  nav.appendChild(hamburger)

  // Mobile full-screen dialog
  const dialog = document.createElement('dialog')
  dialog.className = 'l-navbar-dialog'
  dialog.setAttribute('aria-label', 'Navigation menu')

  const dHeader = document.createElement('div')
  dHeader.className = 'l-dialog-header'
  const dTitle = document.createElement('span')
  dTitle.textContent = 'Lindela'
  dTitle.style.fontWeight = '600'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'l-dialog-close'
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close menu')
  closeBtn.textContent = '×'
  dHeader.appendChild(dTitle)
  dHeader.appendChild(closeBtn)
  dialog.appendChild(dHeader)

  // The dialog is the only place the theme control is laid out below 720px.
  mountThemeControl(dialog)

  for (const s of SURFACES) {
    const a = document.createElement('a')
    a.href = s.path
    a.textContent = i18nText(s.key, s.label)
    a.setAttribute('data-i18n', s.key)
    if (isActive(activePath, s.path)) a.setAttribute('aria-current', 'page')
    dialog.appendChild(a)
  }

  document.body.appendChild(dialog)

  hamburger.addEventListener('click', () => dialog.showModal())
  closeBtn.addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close() })

  return nav
}

let _styleInjected = false

export function mountNavbar(options = {}) {
  // Idempotent: skip if already mounted
  if (document.querySelector('.l-navbar')) return

  if (!_styleInjected) {
    const style = document.createElement('style')
    style.id = 'lindela-navbar-styles'
    style.textContent = NAVBAR_CSS
    document.head.appendChild(style)
    _styleInjected = true
  }

  const navbar = renderNavbar(options)
  // Insert after the skip link rather than as the body's first child.
  //
  // The navbar lands above a statically-authored <a class="skip-link">, so the
  // first Tab press focused the brand link instead. That defeats the skip link
  // on every surface at once — WCAG 2.4.1 (Bypass Blocks), the requirement the
  // link exists to satisfy, silently broken by an insertion order.
  const skipLink = document.querySelector('.skip-link')
  if (skipLink && skipLink.parentNode === document.body) {
    document.body.insertBefore(navbar, skipLink.nextSibling)
  } else {
    document.body.insertBefore(navbar, document.body.firstChild)
  }
  document.body.classList.add('has-navbar')
}
