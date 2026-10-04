import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { esc, sevChip, sevChipHtml, sevClass } from '../public/shared/fmt.js'
import { normalizeParametricRule, MAX_RULE_NAME } from '../src/parametric.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const COMPONENTS = read('../public/components.css')
const STYLES = read('../public/styles.css')
const FMT = read('../public/shared/fmt.js')
const FOCAL_HTML = read('../public/focal-point/index.html')
const FOCAL_JS = read('../public/focal-point/app.js')
const DISTRICTS_HTML = read('../public/districts/index.html')
const PARAMETRIC_HTML = read('../public/parametric/index.html')
const PARAMETRIC_JS = read('../public/parametric/app.js')

// Every file under public/ that renders a severity chip. app.js and districts/*
// are owned by other agents mid-session, so they are read rather than written.
const SURFACES = [
  ['/', read('../public/app.js')],
  ['/portal/', read('../public/portal/app.js')],
  ['/chw/', read('../public/chw/app.js')],
  ['/co/', read('../public/co/app.js')],
  ['/districts/', read('../public/districts/app.js')],
  ['/focal-point/', FOCAL_JS],
  ['/parametric/', read('../public/parametric/app.js')],
  ['/scenarios/', read('../public/scenarios/app.js')],
]

describe('sevClass', () => {
  it('allowlists to the four levels and defaults to medium', () => {
    assert.equal(sevClass('critical'), 'critical')
    assert.equal(sevClass('CRITICAL'), 'critical')
    assert.equal(sevClass('High'), 'high')
    assert.equal(sevClass('low'), 'low')
    // The default is what an unrecognised severity degrades to, on every
    // surface, because there is one function.
    assert.equal(sevClass('catastrophic'), 'medium')
    assert.equal(sevClass(undefined), 'medium')
    assert.equal(sevClass(null), 'medium')
    assert.equal(sevClass(''), 'medium')
  })

  it('cannot be escaped by a severity string containing markup', () => {
    assert.equal(sevClass('" onmouseover="alert(1)'), 'medium')
    assert.equal(sevClass('critical"><script>'), 'medium')
  })
})

describe('sevChip', () => {
  it('emits the one class pair the stylesheet declares', () => {
    // HX-07: this helper used to return `chip chip-<level>`, a spelling no
    // surface's CSS declared until one of them did. The assertion is against
    // the literal the shared stylesheet styles, so the helper cannot drift
    // away from it again without failing.
    assert.equal(sevChip('critical'), 'sev-chip sev-critical')
    assert.equal(sevChip('HIGH'), 'sev-chip sev-high')
    assert.equal(sevChip('nonsense'), 'sev-chip sev-medium')
  })

  it('is what every hand-spelling that survives must equal', () => {
    const surviving = SURFACES.filter(([, src]) => src.includes('sev-chip sev-${'))
    for (const [surface, src] of surviving) {
      assert.ok(
        src.includes('sev-chip sev-${sevClass('),
        `${surface} spells the chip by hand; it should call sevChip()/sevChipHtml() instead`,
      )
    }
  })
})

describe('sevChipHtml', () => {
  it('carries the word as text and as a title', () => {
    assert.equal(
      sevChipHtml('critical'),
      '<span class="sev-chip sev-critical" title="critical">critical</span>',
    )
  })

  it('lower-cases the word, so no surface can render CRITICAL next to critical', () => {
    // The audit measured exactly this: `uppercase` on one surface, `none` on
    // another. The CSS now pins the case; the markup must not reintroduce it.
    assert.match(sevChipHtml('HIGH'), />high</)
    assert.doesNotMatch(sevChipHtml('HIGH'), /HIGH/)
  })

  it('falls back to unknown rather than to an empty chip', () => {
    assert.equal(sevChipHtml(''), '<span class="sev-chip sev-medium" title="unknown">unknown</span>')
  })

  it('escapes the word in both the title and the text', () => {
    const html = sevChipHtml('"><img src=x onerror=alert(1)>')
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /&lt;img/)
  })
})

describe('severity is declared in exactly one place', () => {
  // CSS-only change, so these assert against the source rather than a rendered
  // page. That is the right trade here: the defect was four declarations in
  // four files, and a source assertion is what fails when a fifth appears. The
  // browser measurement of the result is the evidence, not the gate.
  it('styles.css declares no severity chip of its own', () => {
    for (const sel of ['.sev-chip {', '.sev-critical {', '.sev-high', '.sev-medium {', '.sev-low {', '.sev-unknown {']) {
      assert.ok(!STYLES.includes(sel), `styles.css still declares ${sel}; severity lives in components.css now`)
    }
  })

  it('components.css covers every spelling, prefixed to outrank per-surface copies', () => {
    for (const sel of [
      'body .sev-chip',
      'body .severity-chip',
      'body .chip-critical',
      'body .chip-high',
      'body .chip-medium',
      'body .chip-low',
    ]) {
      assert.ok(COMPONENTS.includes(`${sel }`) || COMPONENTS.includes(`${sel},`) || COMPONENTS.includes(`${sel}{`) || COMPONENTS.includes(`${sel}::`), `components.css does not cover ${sel}`)
    }
  })

  it('pins one case and one radius for the chip', () => {
    const block = COMPONENTS.slice(COMPONENTS.indexOf('body .sev-chip,'))
    assert.match(block.slice(0, 700), /text-transform: none;/, 'the chip case must be pinned once')
    assert.match(block.slice(0, 700), /border-radius: var\(--r-sm\);/, 'the chip radius must be pinned once')
  })

  it('tints every level at one strength and inks it with body ink', () => {
    // Only the fill strength is pinned here. The hatch gradients use a
    // different, deliberately lower strength (28%) because they are a texture
    // laid over the fill, not the fill itself — conflating the two would make
    // this assertion pass for the wrong reason.
    const fills = COMPONENTS.match(/background: color-mix\(in oklch, var\(--sev-[a-z]+\) \d+%, transparent\);/g) || []
    assert.ok(fills.length >= 4, `expected a fill for each severity level, got ${fills.length}`)
    const strengths = new Set(fills.map((t) => t.match(/(\d+)%/)[1]))
    assert.deepEqual([...strengths], ['22'], `severity fills disagree: ${[...strengths].join(', ')}`)
    // The foreground is body ink, never the hue itself: the raw hue at 12px
    // lands between 2.2:1 and 3.2:1, three of four under the 4.5:1 AA floor.
    assert.equal((COMPONENTS.match(/--sev-[a-z]+\) \d+%, transparent\);\s*\n?\s*box-shadow/g) || []).length, 4)
    assert.ok(!COMPONENTS.includes('color: var(--sev-'), 'no severity chip may ink itself with the hue')
  })

  it('focal-point no longer declares its own severity chip', () => {
    // It rendered `HIGH` in a 12px pill where the console rendered `high` in a
    // 3px one. The block is gone; the class pair it produced is gone with it.
    assert.ok(!FOCAL_HTML.includes('.severity-critical'), 'focal-point still declares .severity-critical')
    assert.ok(!FOCAL_HTML.includes('border-radius: 12px'), 'focal-point still declares the 12px pill')
    assert.ok(!FOCAL_JS.includes('severity-${'), 'focal-point still builds its own severity class')
    assert.ok(FOCAL_JS.includes('sevChipHtml'), 'focal-point should render through sevChipHtml')
  })

  it('outranks the per-surface copies that are owned elsewhere this session', () => {
    // districts/ still declares `text-transform: uppercase` and a 3px radius on
    // `.chip` in its own inline <style>, and that file belongs to another agent
    // right now. Specificity, not load order, is what settles it: `body .chip-critical`
    // is (0,1,1) against the page's (0,1,0), so the shared rule wins even
    // though the inline block is later in the document. The page's copy is the
    // record of what to delete when that file is next opened.
    assert.match(DISTRICTS_HTML, /\.chip \{[\s\S]*?text-transform: uppercase;/, 'expected the districts copy this outranks to still be present')
    assert.ok(COMPONENTS.includes('body .chip-critical,'), 'the outranking rule must exist')
    // And it must actually outrank: `body` plus the class beats the class alone.
    assert.ok(!COMPONENTS.includes('\n.sev-chip,') && !COMPONENTS.includes('\n.chip-critical,'),
      'an unprefixed selector would lose to the per-surface copy on specificity')
  })
})

describe('every surface renders the same severity chip', () => {
  it('no surface spells a severity class outside the helper', () => {
    // districts/ is exempt and says so: it is owned by another agent this
    // session, and its markup keeps `chip chip-<level>`. What is asserted
    // instead is that the shared stylesheet declares that spelling to the same
    // box as every other, so the two render identically even though only one
    // of the files can be edited today.
    const banned = [/'severity-\$\{/, /`severity-/, /chip chip-\$\{/, /'chip chip-/, /`chip chip-/]
    for (const [surface, src] of SURFACES) {
      if (surface === '/districts/') {
        assert.match(src, /class="chip chip-\$\{/, 'expected the districts spelling this outranks')
        continue
      }
      for (const re of banned) {
        assert.ok(!re.test(src), `${surface} spells severity by hand (${re})`)
      }
    }
  })

  it('fmt.js no longer hands out a class the stylesheet does not declare', () => {
    assert.ok(!/return `chip chip-/.test(FMT), 'sevChip must not return the chip- spelling')
  })
})

describe('HX-14 — a long value is clamped and stays reachable', () => {
  it('the clamp utility exists in the shared layer with min-width: 0', () => {
    assert.match(COMPONENTS, /\.clamp-2,/)
    assert.match(COMPONENTS, /\.clamp-2 \{ -webkit-line-clamp: 2; \}/)
    // min-width:0 is what makes a clamp work inside a flex or grid child.
    // Without it the item sizes to min-content and the clamp never engages.
    const clamp = COMPONENTS.slice(COMPONENTS.indexOf('.clamp-2,'), COMPONENTS.indexOf('.clamp-2 {'))
    assert.match(clamp, /min-width: 0;/)
    assert.match(clamp, /-webkit-box-orient: vertical;/)
  })

  it('the rule name is clamped and carries the full value in a title', () => {
    // A clamp that does not also keep the value is not a clamp, it is a
    // deletion. `title=` is the mechanism the console already uses on alert
    // rule names, where `truncate()` shortens the visible text.
    assert.match(PARAMETRIC_JS, /class="rule-name clamp-2" title="\$\{esc\(r\.name\)\}"/)
  })

  it('the rule name is given a shrinkable flex basis, or the clamp has no width', () => {
    assert.match(COMPONENTS, /\.rule-head > \.rule-name \{/)
    const block = COMPONENTS.slice(COMPONENTS.indexOf('.rule-head > .rule-name {'))
    assert.match(block.slice(0, 120), /min-width: 0;/)
    assert.match(block.slice(0, 120), /flex: 1 1 12rem;/)
  })

  it('the form input and the server agree on one ceiling', () => {
    assert.match(PARAMETRIC_HTML, /id="ruleName"[^>]*maxlength="120"/s)
    assert.equal(MAX_RULE_NAME, 120)
  })

  it('the server refuses an over-long name with a status that means failure', () => {
    const base = { chain: 'ethereum-sepolia', currency: 'USD' }
    assert.doesNotThrow(() => normalizeParametricRule({ ...base, name: 'x'.repeat(120) }))
    assert.throws(
      () => normalizeParametricRule({ ...base, name: 'x'.repeat(121) }),
      (e) => e.statusCode === 400,
      'a 121-character name must be a 400, not a 201',
    )
    // The audit measured 500 characters. That must not survive either.
    assert.throws(() => normalizeParametricRule({ ...base, name: 'x'.repeat(500) }), /at most 120/)
  })

  it('a name at the ceiling is stored whole, not silently trimmed', () => {
    const name = 'F'.repeat(MAX_RULE_NAME)
    assert.equal(normalizeParametricRule({ chain: 'ethereum-sepolia', currency: 'USD', name }).name, name)
  })
})

describe('esc is still the only escape path', () => {
  it('a rule name is escaped in text and title alike', () => {
    const rule = { id: 'r1', name: '<script>alert(1)</script>', chain: 'ethereum-sepolia', status: 'draft' }
    const card = PARAMETRIC_JS
    assert.ok(card.includes('title="${esc(r.name)}"'))
    assert.ok(card.includes('>${esc(r.name)}<'))
    assert.equal(esc(rule.name).includes('<script>'), false)
  })
})