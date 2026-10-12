/**
 * ENH-71 — the console surface for `shared/intent.js`.
 *
 * `intent.js` is the decision — which controls a (role, intent) pair shows and
 * why each hidden one is hidden. This is the surface: a picker that sets the
 * intent, the header that states the decision, and the list of hidden controls
 * with their reasons. The picker is the only thing that may hide a control; with
 * none chosen, `decideSurface` shows everything and the header says so.
 *
 * **Why this is a module of its own, and reached through `lazy()`.** The
 * first-load budget is 229.5 KB of a 230.0 KB ceiling — 0.5 KB of headroom — and
 * `scripts/check-budget.mjs` walks only the static `from '…'`/`import '…'` graph
 * from `index.html`. A renderer written into `app.js` lands on that graph and
 * fails the gate; the same renderer reached through `lazy()` does not. So the
 * decision *and* the renderer both stay off the first load, and the console pays
 * a single `lazy()` line for the feature.
 *
 * The stylesheet is injected here rather than linked from `index.html` for the
 * same reason: a `<link>` in the entry document is a first-load asset, and a
 * `<style>` this module writes is not. CSP permits it — `style-src` carries
 * `'unsafe-inline'` (see `src/server.js`).
 *
 * Pure DOM, no globals beyond the ones the console already owns.
 */
import { decideSurface, INTENT_OPTIONS } from './intent.js'
import { esc as escapeHtml } from './fmt.js'

/**
 * The element the picker carries, held as a constant.
 *
 * `test/lite.test.js` reads every id-lookup literal in `app.js` as a claim that
 * `index.html` declares that id; the picker is built here, into the host the
 * console declares, so naming it in a constant keeps that contract honest.
 */
export const INTENT_SELECT_ID = 'intentSelect'

const STYLE_ID = 'intent-bar-style'

const CSS = `
.intent-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-1) var(--sp-3);
  padding: var(--sp-1) var(--sp-3);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--stroke);
  font-size: var(--text-xs);
}
.intent-control { display: flex; align-items: baseline; gap: var(--sp-2); flex-shrink: 0; }
.intent-control select { width: auto; min-width: 0; max-width: 14rem; font-size: var(--text-xs); }
.intent-header { color: var(--ink-muted); min-width: 0; margin: 0; }
.intent-hidden { flex: 1 1 100%; margin: 0; padding: 0; list-style: none; color: var(--ink-muted); }
.intent-hidden li { padding: 1px 0; }
.intent-hidden .intent-only-route { color: var(--ink); }
`

/** Inject the stylesheet once, into the document head. */
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head?.appendChild(style)
}

/**
 * Render the intent control into `host`.
 *
 * @param {object} host          the `#intentBar` section the console declares
 * @param {{ role: string, intent: string|null, onChange: (intent: string|null) => void }} options
 */
export function renderIntentBar(host, { role, intent, onChange }) {
  if (!host) return
  ensureStyles()
  const decision = decideSurface(role, intent)

  const options = [
    `<option value=""${intent ? '' : ' selected'}>No intent — show everything</option>`,
    ...INTENT_OPTIONS.map(({ key, label }) =>
      `<option value="${escapeHtml(key)}"${intent === key ? ' selected' : ''}>${escapeHtml(label)}</option>`),
  ].join('')

  // Every hidden control is named with its reason, and an only-route one carries
  // the way back. A control that vanishes with no explanation is the dead end
  // this feature exists to remove.
  const hidden = decision.hidden.length
    ? `<ul class="intent-hidden">${decision.hidden.map((h) =>
      `<li class="${h.onlyRoute ? 'intent-only-route' : ''}"><strong>${escapeHtml(h.control)}</strong> — ${escapeHtml(h.reason)}</li>`).join('')}</ul>`
    : ''

  host.innerHTML = `
    <div class="intent-control">
      <label for="${INTENT_SELECT_ID}">Intent</label>
      <select id="${INTENT_SELECT_ID}" aria-label="Console intent">${options}</select>
    </div>
    <p class="intent-header" id="intentHeader" role="status" aria-live="polite">${escapeHtml(decision.header)}</p>
    ${hidden}`

  host.querySelector(`#${INTENT_SELECT_ID}`)?.addEventListener('change', (event) => {
    // The empty value is the absent intent, not a falsy mistake: an operator
    // returning to "show everything" must be able to, and `decideSurface` reads
    // the empty string as no intent chosen.
    onChange(event.target.value || null)
  })
}

/**
 * Mount the intent bar and keep it in step with the picker.
 *
 * The console calls this once, through `lazy()`, so it pays one line for the
 * feature and this renderer stays off the first-load budget. The host is
 * injected rather than declared in `index.html` for the same reason: a section
 * in the entry document is a first-load byte, and one this module creates is
 * not. It lands after the command band, before `#main`.
 *
 * This module owns the intent state — `role` is the console's audience,
 * `intent` is absent until the operator picks one — so there is no second copy
 * of the intent for the console to keep in sync, and the console needs no
 * intent fields of its own.
 *
 * @param {string} [hostId] the host's id; defaults to `intentBar`.
 */
export function mountConsoleIntent(hostId = 'intentBar') {
  let host = document.getElementById(hostId)
  if (!host) {
    host = document.createElement('section')
    host.id = hostId
    host.className = 'intent-bar'
    host.setAttribute('aria-label', 'Console intent')
    const main = document.getElementById('main')
    if (main?.parentNode) main.parentNode.insertBefore(host, main)
    else document.body?.appendChild(host)
  }
  const state = { role: 'operator', intent: null }
  const render = () => {
    try {
      renderIntentBar(host, {
        role: state.role,
        intent: state.intent,
        onChange: (intent) => { state.intent = intent; render() },
      })
    } catch (err) {
      console.error('Intent bar failed to render', err)
    }
  }
  render()
}

