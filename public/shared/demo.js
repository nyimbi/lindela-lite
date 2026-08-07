// Lindela Lite — guided demo director
// Activate with ?demo=1 on any surface. Right arrow advances, left arrow
// steps back, Escape exits. Step index survives cross-surface navigation
// via sessionStorage.

const STEPS = [
  {
    path: '/',
    tab: null,
    highlight: '#workflowOverview',
    title: 'Multi-source ingest',
    narration: 'Climate feeds, community reports, structured field data across the pilot regions.',
  },
  {
    path: '/',
    tab: 'alerts',
    highlight: '#panel-alerts',
    title: 'Rule-based alerting',
    narration: 'Role-based access. Send is gated when severity is high.',
  },
  {
    path: '/districts',
    highlight: '.district-list, .districts-grid, main',
    title: 'District drill-down',
    narration: 'Every pilot district is a first-class page.',
  },
  {
    path: '/districts#/turkana',
    title: 'Turkana overview',
    narration: 'Live counts, situation map, operations, signal and response.',
  },
  {
    path: '/focal-point',
    title: 'Focal-point approval',
    narration: 'Pre-authorised triggers wait here for district signature.',
  },
  {
    path: '/chw',
    title: 'CHW mobile-web',
    narration: 'Offline-first, feature-phone parity, seven languages.',
  },
  {
    path: '/co',
    highlight: '.trend-section, .kpi-grid, main',
    title: 'CO dashboard + trend',
    narration: 'Quarterly KPIs matched to UNICEF bid indicators. Twelve-month trend and quarter-over-quarter.',
  },
]

const STORAGE_KEY = 'lindela-demo-step'
const QUERY_KEY = 'demo'
const DEMO_MODE_KEY = 'lindela-demo-active'

function isDemoActive() {
  const url = new URL(window.location.href)
  if (url.searchParams.get(QUERY_KEY) === '1') {
    sessionStorage.setItem(DEMO_MODE_KEY, '1')
    return true
  }
  return sessionStorage.getItem(DEMO_MODE_KEY) === '1'
}

function currentStepIndex() {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 && n < STEPS.length ? n : 0
}

function setStepIndex(n) {
  sessionStorage.setItem(STORAGE_KEY, String(n))
}

function currentPathAndHash() {
  return window.location.pathname + window.location.hash
}

function stepPathAndHash(step) {
  return step.path
}

function stepMatchesCurrent(step) {
  const [wantPath, wantHash] = step.path.split('#')
  if (window.location.pathname !== wantPath) return false
  if (wantHash) {
    return window.location.hash.replace(/^#/, '') === wantHash
  }
  return true
}

function navigateToStep(step) {
  const target = stepPathAndHash(step)
  const [pathPart] = target.split('#')
  if (window.location.pathname !== pathPart) {
    const sep = target.includes('?') ? '&' : (target.includes('#') ? '__q__' : '?')
    let url
    if (target.includes('#')) {
      const [p, h] = target.split('#')
      url = `${p}?${QUERY_KEY}=1#${h}`
    } else {
      url = `${target}?${QUERY_KEY}=1`
    }
    window.location.href = url
    return
  }
  if (step.path.includes('#')) {
    const hash = step.path.split('#')[1]
    if (window.location.hash.replace(/^#/, '') !== hash) {
      window.location.hash = hash
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  }
}

function activateTabIfNeeded(step) {
  if (!step.tab) return
  const btn = document.querySelector(`[data-tab="${step.tab}"]`)
  if (btn && typeof btn.click === 'function') btn.click()
}

function applyHighlight(step) {
  document.querySelectorAll('.l-demo-highlight').forEach((el) => el.classList.remove('l-demo-highlight'))
  if (!step.highlight) return
  const selector = step.highlight
  const first = document.querySelector(selector.split(',')[0].trim())
  if (!first) return
  first.classList.add('l-demo-highlight')
  try {
    first.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  } catch (_) { /* no-op */ }
}

function renderOverlay() {
  const idx = currentStepIndex()
  const step = STEPS[idx]
  let overlay = document.getElementById('l-demo-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'l-demo-overlay'
    overlay.className = 'l-demo-overlay'
    overlay.innerHTML = `
      <div class="l-demo-inner">
        <div class="l-demo-counter"></div>
        <div class="l-demo-title"></div>
        <div class="l-demo-narration"></div>
        <div class="l-demo-hint">← prev &nbsp;·&nbsp; → next &nbsp;·&nbsp; Esc exit</div>
      </div>
    `
    document.body.appendChild(overlay)
  }
  overlay.querySelector('.l-demo-counter').textContent = `Step ${idx + 1} of ${STEPS.length}`
  overlay.querySelector('.l-demo-title').textContent = step.title
  overlay.querySelector('.l-demo-narration').textContent = step.narration
}

function removeOverlay() {
  const overlay = document.getElementById('l-demo-overlay')
  if (overlay) overlay.remove()
  document.querySelectorAll('.l-demo-highlight').forEach((el) => el.classList.remove('l-demo-highlight'))
}

function exitDemo() {
  sessionStorage.removeItem(STORAGE_KEY)
  sessionStorage.removeItem(DEMO_MODE_KEY)
  removeOverlay()
  const url = new URL(window.location.href)
  url.searchParams.delete(QUERY_KEY)
  window.history.replaceState({}, '', url.toString())
}

function advance(delta) {
  const idx = currentStepIndex()
  const next = idx + delta
  if (next < 0 || next >= STEPS.length) return
  setStepIndex(next)
  const step = STEPS[next]
  if (stepMatchesCurrent(step)) {
    renderOverlay()
    activateTabIfNeeded(step)
    setTimeout(() => applyHighlight(step), 200)
  } else {
    navigateToStep(step)
  }
}

function onKey(e) {
  if (e.key === 'ArrowRight') { e.preventDefault(); advance(1) }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); advance(-1) }
  else if (e.key === 'Escape') { e.preventDefault(); exitDemo() }
}

function injectStyles() {
  if (document.getElementById('l-demo-styles')) return
  const style = document.createElement('style')
  style.id = 'l-demo-styles'
  style.textContent = `
    .l-demo-overlay {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2000;
      max-width: 640px;
      min-width: 320px;
      background: var(--bg-elevated, #111);
      color: var(--ink, #fff);
      border: 1px solid var(--brand, #26a69a);
      border-radius: 10px;
      padding: 14px 18px;
      box-shadow: 0 8px 32px oklch(0% 0 0 / 0.5);
      font-family: var(--font-sans, system-ui);
      font-size: 14px;
      animation: l-demo-fade-in 200ms ease-out;
    }
    @keyframes l-demo-fade-in {
      from { opacity: 0; transform: translate(-50%, 8px); }
      to   { opacity: 1; transform: translate(-50%, 0); }
    }
    .l-demo-counter {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--brand, #26a69a);
      font-weight: 600;
      margin-bottom: 4px;
    }
    .l-demo-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--ink, #fff);
      margin-bottom: 4px;
    }
    .l-demo-narration {
      font-size: 13px;
      color: var(--ink-muted, #aaa);
      line-height: 1.4;
      margin-bottom: 8px;
    }
    .l-demo-hint {
      font-size: 11px;
      color: var(--ink-faint, #666);
      font-family: var(--font-mono, ui-monospace);
    }
    .l-demo-highlight {
      outline: 2px solid var(--brand, #26a69a) !important;
      outline-offset: 4px;
      border-radius: 6px;
      transition: outline-color 200ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .l-demo-overlay { animation: none; }
      .l-demo-highlight { transition: none; }
    }
  `
  document.head.appendChild(style)
}

function bootstrap() {
  if (!isDemoActive()) return
  injectStyles()
  const idx = currentStepIndex()
  const step = STEPS[idx]

  // If URL doesn't match the current step (user landed on ?demo=1 for the
  // first time), align: land on the matching step or reset to 0.
  if (!stepMatchesCurrent(step)) {
    const matchIdx = STEPS.findIndex(stepMatchesCurrent)
    if (matchIdx >= 0) {
      setStepIndex(matchIdx)
    } else {
      setStepIndex(0)
      if (currentPathAndHash() !== '/') {
        navigateToStep(STEPS[0])
        return
      }
    }
  }

  renderOverlay()
  const active = STEPS[currentStepIndex()]
  setTimeout(() => activateTabIfNeeded(active), 100)
  setTimeout(() => applyHighlight(active), 400)
  window.addEventListener('keydown', onKey)
  window.addEventListener('hashchange', () => {
    const i = STEPS.findIndex(stepMatchesCurrent)
    if (i >= 0 && i !== currentStepIndex()) {
      setStepIndex(i)
      renderOverlay()
      const s = STEPS[i]
      setTimeout(() => activateTabIfNeeded(s), 100)
      setTimeout(() => applyHighlight(s), 400)
    }
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap)
} else {
  bootstrap()
}
