// Lindela Lite — shared cross-surface navbar

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
  height: 44px;
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
  margin-inline-start: auto;
}
.l-navbar-locale {
  font-size: var(--text-xs);
  background: transparent;
  color: var(--ink-muted);
  border: 1px solid var(--stroke);
  border-radius: var(--r-sm);
  padding: 2px var(--sp-2);
  cursor: pointer;
}
.l-navbar-locale:hover { color: var(--ink); }
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
  width: 36px;
  height: 36px;
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
  width: 36px;
  height: 36px;
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

function i18nText(key, fallback) {
  if (window.__i18n) return window.__i18n.t(key)
  return fallback
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
  document.body.insertBefore(navbar, document.body.firstChild)
  document.body.classList.add('has-navbar')
}
