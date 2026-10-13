import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * ENH-68 — the console panel for `POST /api/v1/ask`, asserted on its source.
 *
 * The panel is DOM wiring and this repository runs no DOM in Node, so the
 * assertions are about the two things that break silently: the input must carry
 * an accessible name (the `check-a11y` `forms` rule), and the module must stay
 * off the first-load graph (the budget rule). Both are properties of the file,
 * and reading the file is what proves them.
 */

const root = process.cwd()
const panel = readFileSync(path.join(root, 'public/workflow/ask.js'), 'utf8')
const app = readFileSync(path.join(root, 'public/app.js'), 'utf8')

describe('the ask panel (ENH-68)', () => {
  it('names the search input, so the a11y form rule holds once it is shown', () => {
    // The gate skips [hidden] elements, and this panel builds itself visible —
    // so the input is checked the moment the module mounts. A `label[for]` or an
    // ancestor <label> is the name; the placeholder is not.
    assert.match(panel, /<input[^>]*type="search"[^>]*id="askQuestion"/)
    assert.match(panel, /<label[^>]*for="askQuestion"/)
  })

  it('renders the answer into a polite live region', () => {
    assert.match(panel, /role="status"[^>]*aria-live="polite"/)
  })

  it('reaches the route the server serves', () => {
    // check-client-endpoints reads this literal against the served surface.
    assert.match(panel, /'\/api\/v1\/ask'/)
  })

  it('is mounted through lazy(), so it stays off the first-load graph', () => {
    // A static import in app.js lands the module on the measured graph and costs
    // the budget real bytes against 0.1 KB of headroom. The lazy() call site is
    // the whole cost.
    assert.match(app, /lazy\('\/workflow\/ask\.js'\)/)
    assert.doesNotMatch(app, /^import .*\/workflow\/ask\.js'/m)
  })
})
