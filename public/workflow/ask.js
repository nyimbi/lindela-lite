/**
 * ENH-68 — the console surface for the grounded natural-language query.
 *
 * `POST /api/v1/ask` answers a question over the store and refuses when it
 * cannot ground one. This is the box that asks it. The route is the feature; the
 * panel exists so the operator can reach it without a curl.
 *
 * **Why this is a module reached through `lazy()`, and creates its own host.**
 * The first-load budget is 229.9 KB of a 230.0 KB ceiling — 0.1 KB of headroom —
 * and `scripts/check-budget.mjs` walks only the static `from '…'`/`import '…'`
 * graph from `index.html`. A panel declared in `index.html`, a `<link>` in the
 * entry document, or a static import in `app.js` all cost bytes against that
 * headroom; a `lazy()` call site and a host this module creates cost none. So
 * the console pays one line for the feature, and the markup and the stylesheet
 * are built here rather than shipped in the entry document. Same reasoning as
 * `shared/intent-console.js`.
 *
 * **A refusal renders as an answer.** The route returns a refusal as a 200
 * carrying a `reason`, because a question the layer cannot ground is a fact
 * about the data. The panel shows that reason in the status line rather than a
 * red error, and it names when the parse was model-assisted (`proposed_by`),
 * because a reader must be able to tell a deterministic answer from a widened
 * one.
 *
 * Pure DOM and one `apiFetch`. It reads the console's own API-key field and
 * holds no state of its own.
 */
import { apiFetch } from '/shared/runtime.js'
import { esc as escapeHtml } from '/shared/fmt.js'

const STYLE_ID = 'ask-panel-style'
const HOST_ID = 'askPanel'

const CSS = `
.ask-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--stroke);
}
.ask-row { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
.ask-row label { display: flex; align-items: baseline; gap: var(--sp-2); flex: 1 1 20rem; min-width: 0; }
.ask-row input[type="search"] { flex: 1 1 auto; min-width: 0; font-size: var(--text-sm); }
.ask-answer { color: var(--ink-muted); margin: 0; }
.ask-answer.is-answered { color: var(--ink); }
.ask-source { color: var(--ink-faint); font-size: var(--text-xs); }
`

/** Inject the stylesheet once, into the document head. */
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head?.appendChild(style)
}

/** The console's own key field, read on every call so a key set elsewhere is used. */
function authHeaders() {
  const key = document.getElementById('apiKeyInput')?.value?.trim()
  return key ? { 'x-api-key': key } : {}
}

/** Render one answer or refusal into the status region. */
export function renderAnswer(host, answer) {
  if (!host) return
  if (!answer) {
    host.textContent = ''
    host.className = 'ask-answer'
    return
  }
  const answered = answer.status === 'answered'
  host.className = answered ? 'ask-answer is-answered' : 'ask-answer'
  const text = answered ? answer.text : (answer.reason || 'The question could not be grounded.')
  // The source is named only when it differs from the default, so the common
  // case reads as a plain answer and the model-assisted one is marked.
  const source = answer.query?.proposed_by === 'needle'
    ? ' <span class="ask-source">(parse widened by the local model; every figure audited against the store)</span>'
    : ''
  host.innerHTML = `${escapeHtml(text)}${source}`
}

/**
 * Mount the ask panel and wire its form.
 *
 * The host is injected rather than declared in `index.html`, so nothing lands on
 * the first-load graph. It sits after the intent bar, before `#main`.
 */
export function mountAskPanel(hostId = HOST_ID) {
  if (typeof document === 'undefined') return null
  ensureStyles()

  let host = document.getElementById(hostId)
  if (!host) {
    host = document.createElement('section')
    host.id = hostId
    host.className = 'ask-panel'
    host.setAttribute('aria-label', 'Ask a question')
    const main = document.getElementById('main')
    if (main?.parentNode) main.parentNode.insertBefore(host, main)
    else document.body?.appendChild(host)
  }

  host.innerHTML = `
    <form class="ask-row" id="askForm">
      <label for="askQuestion"><span>Ask</span>
        <input type="search" id="askQuestion" autocomplete="off"
               placeholder="Which districts crossed the flood threshold and have no dispatch?">
      </label>
      <button type="submit" class="btn" id="askSubmit">Ask</button>
    </form>
    <p class="ask-answer" id="askAnswer" role="status" aria-live="polite"></p>`

  const form = host.querySelector('#askForm')
  const input = host.querySelector('#askQuestion')
  const submit = host.querySelector('#askSubmit')
  const answerEl = host.querySelector('#askAnswer')

  form?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const question = input?.value?.trim()
    if (!question) return
    submit.disabled = true
    answerEl.className = 'ask-answer'
    answerEl.textContent = 'Reading the store…'
    try {
      const body = await apiFetch('/api/v1/ask', {
        method: 'POST',
        body: { question },
        headers: authHeaders(),
      })
      renderAnswer(answerEl, body?.answer)
    } catch (error) {
      answerEl.className = 'ask-answer'
      answerEl.textContent = `Could not ask: ${error.message}`
    } finally {
      submit.disabled = false
    }
  })

  return host
}
