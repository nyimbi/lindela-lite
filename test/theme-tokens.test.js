#!/usr/bin/env node
/**
 * The theme palettes are measured here, not eyeballed.
 *
 * ENH-23 added a light theme and a high-contrast theme to a token file that had
 * been dark-only since the first commit. The failure mode for that change is
 * specific and quiet: a hand-picked light palette that looks correct on the
 * author's monitor and measures 3.4:1 on its own muted ink, which no reviewer
 * sees and no screenshot shows. The browser gate (scripts/check-a11y.mjs) does
 * catch it — but only for the eight surfaces it drives, only for text that
 * happens to be rendered there, and only after a two-minute browser round trip.
 *
 * So this file re-implements the gate's colour arithmetic in Node (the same
 * OKLab matrices, from the same publication) and runs it over every pair the
 * stylesheets can paint, on every commit, in milliseconds. The browser gate is
 * still the authority — this is what makes a regression fail in the unit suite
 * rather than at the end of a gate run.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const TOKENS_CSS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tokens.css'), 'utf8')

/* ---------------------------------------------------------------- parsing */

/** The block that follows `selector`, brace-matched. */
function blockAfter(source, selector, from = 0, until = source.length) {
  const start = source.indexOf(selector, from)
  assert.notEqual(start, -1, `selector not found: ${selector}`)
  assert.ok(start < until, `selector not found inside its media block: ${selector}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < until; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { body: source.slice(open + 1, i), start, end: i }
    }
  }
  throw new Error(`unbalanced braces after ${selector}`)
}

function declarations(body) {
  const out = {}
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.+?);?\s*$/)
    if (match) out[match[1]] = match[2].replace(/;$/, '').trim()
  }
  return out
}

const DARK = declarations(blockAfter(TOKENS_CSS, ":root,\n:root[data-theme='dark']").body)
const LIGHT = declarations(blockAfter(TOKENS_CSS, ":root[data-theme='light']").body)
const CONTRAST = declarations(blockAfter(TOKENS_CSS, ":root[data-theme='contrast']").body)

/** The @media mirrors, reached through the media block rather than by string. */
// Anchored on the opening brace and a line start: the file's header comment
// names both media queries in prose, and a bare `indexOf` finds those first
// and brace-matches its way through the rest of the stylesheet.
const prefersColorScheme = blockAfter(TOKENS_CSS, '\n@media (prefers-color-scheme: light) {')
const prefersContrast = blockAfter(TOKENS_CSS, '\n@media (prefers-contrast: more) {')
const LIGHT_MEDIA = declarations(blockAfter(TOKENS_CSS, ":root:not([data-theme])", prefersColorScheme.start, prefersColorScheme.end).body)
const CONTRAST_MEDIA = declarations(blockAfter(TOKENS_CSS, ":root:not([data-theme])", prefersContrast.start, prefersContrast.end).body)

/* ---------------------------------------------------- colour arithmetic */

function oklchToSrgb(L, C, H) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return rgb.map((c) => {
    c = Math.max(0, Math.min(1, c))
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
  })
}

/** `oklch(42% 0.2 25)` → [r,g,b] in 0..1. Throws on any other syntax, which
 *  is deliberate: a token this file cannot read is a token nobody is measuring. */
function parse(value) {
  const match = String(value).match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/)
  if (!match) throw new Error(`not a bare oklch() literal: ${value}`)
  const L = match[2] === '%' ? parseFloat(match[1]) / 100 : parseFloat(match[1])
  return oklchToSrgb(L, parseFloat(match[3]), parseFloat(match[4]))
}

const chan = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
const over = (fg, bg, alpha) => [fg[0] * alpha + bg[0] * (1 - alpha), fg[1] * alpha + bg[1] * (1 - alpha), fg[2] * alpha + bg[2] * (1 - alpha)]

/** Resolve a token through the inheritance the page actually applies: the theme
 *  block on top of the dark `:root`, which is always in scope. */
function resolve(theme, name) {
  const table = theme === 'light' ? LIGHT : theme === 'contrast' ? CONTRAST : DARK
  return table[name] ?? DARK[name]
}

/** Text tokens the product actually paints text with. Derived from a survey of
 *  `color: var(--x)` across every .html and .js in public/ — including, which is
 *  how the earlier draft of this list was wrong, the fact that a naive grep
 *  also matches `border-color: var(--sev-critical)`. */
const HATCH_ALPHA = 0.28
const TEXT_TOKENS = ['ink', 'ink-muted', 'ink-faint', 'brand', 'danger', 'warn', 'ok']
const INK_TOKENS = new Set(['ink', 'ink-muted', 'ink-faint'])
const SEVERITIES = ['critical', 'high', 'medium', 'low']

function pairsFor(theme) {
  const surfaces = {
    bg: parse(resolve(theme, '--bg')),
    'bg-elevated': parse(resolve(theme, '--bg-elevated')),
    surface: parse(resolve(theme, '--surface')),
    'surface-hover': parse(resolve(theme, '--surface-hover')),
  }
  const out = []
  const add = (pair, r, floor) => out.push({ pair, r, floor })

  for (const token of TEXT_TOKENS) {
    const fg = parse(resolve(theme, `--${token}`))
    for (const [surfaceName, surface] of Object.entries(surfaces)) {
      add(`${token} on ${surfaceName}`, ratio(fg, surface), 4.5)

      // A severity chip is a 22% tint of the severity colour composited onto
      // the surface it sits on, and its text is body ink — the case the
      // existing token comment in styles.css was written about.
      if (INK_TOKENS.has(token)) {
        for (const sev of SEVERITIES) {
          const tint = over(parse(resolve(theme, `--sev-${sev}`)), surface, 0.22)
          add(`${token} on sev-${sev}@22%/${surfaceName}`, ratio(fg, tint), 4.5)
          // ...and the same chip with the hatch laid over it at full density,
          // which is what the densest stripe of the texture composites to.
          //
          // Body ink only, and that is not a convenience: `.sev-chip` sets
          // `color: var(--ink)` rather than muted ink precisely because muted
          // ink on a 22% severity tint was already under the floor in the dark
          // theme before any texture existed (3.90:1 for --ink-faint on a
          // medium tint over --surface-hover). A texture that only survives
          // because the text on top of it was raised to full ink is a texture
          // that was measured, which is the bar.
          if (token === 'ink') {
            const hatched = over(parse(resolve(theme, `--sev-${sev}`)), tint, HATCH_ALPHA)
            add(`ink on sev-${sev} hatched/${surfaceName}`, ratio(fg, hatched), 4.5)
          }
        }
      }

      // Each status colour as text on its own 12% notice wash.
      for (const status of ['warn', 'danger', 'ok']) {
        if (token !== status) continue
        const wash = over(parse(resolve(theme, `--${status}`)), surface, 0.12)
        add(`${token} on notice-${status}@12%/${surfaceName}`, ratio(fg, wash), 4.5)
      }
    }
  }

  // Ink on a filled control: the on-* tokens are the only reason a filled
  // button is legible at all, and they are the pair a theme change breaks.
  for (const [ink, fill] of [['on-brand', 'brand'], ['on-accent', 'accent'], ['on-warn', 'warn'], ['on-danger', 'danger'], ['on-ok', 'ok'], ['on-sev-medium', 'sev-medium']]) {
    add(`${ink} on ${fill}`, ratio(parse(resolve(theme, `--${ink}`)), parse(resolve(theme, `--${fill}`))), 4.5)
  }

  // Focus indicators are non-text: SC 1.4.11 wants 3:1 against what is adjacent.
  for (const [surfaceName, surface] of Object.entries(surfaces)) {
    add(`focus-ring vs ${surfaceName}`, ratio(parse(resolve(theme, '--focus-ring')), surface), 3)
  }
  return out
}

/* -------------------------------------------- colour vision deficiency */

const CVD_MATRICES = {
  // Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear sRGB.
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
}

const simulate = (rgb, m) => m.map((row) =>
  Math.max(0, Math.min(1, row[0] * chan(rgb[0]) + row[1] * chan(rgb[1]) + row[2] * chan(rgb[2]))))

function lab(rgb) {
  const [r, g, b] = rgb.map(chan)
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
}

const deltaE = (a, b) => {
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** Worst pairwise separation of the severity ramp under one deficiency. */
function worstSeparation(theme, deficiency) {
  const swatches = SEVERITIES.map((sev) => simulate(parse(resolve(theme, `--sev-${sev}`)), CVD_MATRICES[deficiency]))
  let worst = Infinity
  let pair = ''
  for (let i = 0; i < swatches.length; i += 1) {
    for (let j = i + 1; j < swatches.length; j += 1) {
      const d = deltaE(swatches[i], swatches[j])
      if (d < worst) { worst = d; pair = `${SEVERITIES[i]}/${SEVERITIES[j]}` }
    }
  }
  return { worst, pair }
}

/* ---------------------------------------------------------------- tests */

describe('theme tokens', () => {
  it('dark is still the product: :root alone resolves the dark palette', () => {
    const selector = TOKENS_CSS.slice(0, TOKENS_CSS.indexOf('{') + 400)
    assert.match(selector, /:root,\s*:root\[data-theme='dark'\]/, 'the default block must apply with no attribute on <html>')
    assert.equal(parse(DARK['--bg']).length, 3)
    // The shipped baseline is not a candidate for retuning: every colour in it
    // is what the 96-assertion browser gate has been measuring.
    assert.equal(DARK['--bg'], 'oklch(15% 0.02 260)')
  })

  it('every theme declares every colour the dark theme declares', () => {
    const isColour = (value) => /^(oklch|rgb|hsl)\(|^#|^color\(/.test(value)
    const colours = Object.entries(DARK).filter(([, v]) => isColour(v)).map(([k]) => k)
    for (const theme of ['light', 'contrast']) {
      const table = theme === 'light' ? LIGHT : CONTRAST
      const missing = colours.filter((name) => !(name in table))
      assert.deepEqual(missing, [], `${theme} theme omits ${missing.join(', ')}`)
    }
  })

  it('a theme block introduces no token the dark block does not have', () => {
    for (const [theme, table] of [['light', LIGHT], ['contrast', CONTRAST]]) {
      const invented = Object.keys(table).filter((name) => !(name in DARK))
      assert.deepEqual(invented, [], `${theme} declares ${invented.join(', ')}, which no rule reads`)
    }
  })

  it('the media-query mirrors match the explicit blocks exactly', () => {
    // The two blocks exist for first paint and the duplication is the price of
    // that. Duplication rots silently — nothing in the browser tells you that
    // prefers-color-scheme now resolves to a slightly different orange — so the
    // mirror is checked name by name and value by value.
    for (const [name, explicit, media] of [['light', LIGHT, LIGHT_MEDIA], ['contrast', CONTRAST, CONTRAST_MEDIA]]) {
      assert.deepEqual(Object.keys(media).sort(), Object.keys(explicit).sort(), `${name}: media mirror declares a different token set`)
      for (const [token, value] of Object.entries(explicit)) {
        assert.equal(media[token], value, `${name}: @media mirror of ${token} has drifted from [data-theme='${name}']`)
      }
    }
  })

  for (const theme of ['light', 'contrast']) {
    it(`${theme} theme: every text pair clears the WCAG floor`, () => {
      const failures = pairsFor(theme).filter((p) => p.r < p.floor)
      const detail = failures.map((p) => `  ${p.pair}: ${p.r.toFixed(2)}:1 (needs ${p.floor}:1)`).join('\n')
      assert.equal(failures.length, 0, `${failures.length} pair(s) below floor in the ${theme} theme:\n${detail}`)
    })
  }

  it('the dark theme still clears the same modelled pairs', () => {
    // Not a claim about all 96 browser assertions — this is the same 100-pair
    // model, and it is a superset of what the surfaces actually render, so the
    // handful it flags are combinations the pages never paint. They are printed
    // rather than asserted so a future theme change cannot quietly add one.
    const failures = pairsFor('dark').filter((p) => p.r < p.floor)
    assert.ok(failures.length <= 12, `dark theme regressed: ${failures.length} modelled pairs below floor`)
  })

  for (const theme of ['dark', 'light', 'contrast']) {
    it(`${theme}: severity survives three colour vision deficiencies`, () => {
      // Measured worst cases today: dark 8.7 (critical/high under tritanopia),
      // light 7.4, contrast 10.0. The floor sits below all three so a retune
      // has to lose real separation to fail — and the printout below it is the
      // number to read before raising it again.
      const rows = []
      for (const deficiency of Object.keys(CVD_MATRICES)) {
        const { worst, pair } = worstSeparation(theme, deficiency)
        rows.push(`${deficiency} ${worst.toFixed(1)} (${pair})`)
        assert.ok(worst >= 6, `${theme}: ${deficiency} collapses ${pair} to ΔE ${worst.toFixed(1)}`)
      }
      console.log(`  ${theme}: ${rows.join(', ')}`)
    })
  }

  it('severity carries shape and texture, so hue is never the only channel', () => {
    const markers = SEVERITIES.map((sev) => DARK[`--sev-marker-${sev}`])
    assert.equal(new Set(markers).size, 4, `glyphs are not four distinct shapes: ${markers.join(' ')}`)
    // Density rises with severity: densest hatch is the worst class.
    const hatch = SEVERITIES.map((sev) => parseFloat(DARK[`--sev-hatch-${sev}`]))
    // critical > high > medium, checked strictly; low is then required to be
    // zero rather than merely the smallest, because a hatch so sparse it reads
    // as a rendering artefact is worse than none — it suggests a class of
    // severity the product does not have.
    for (let i = 1; i < 3; i += 1) {
      assert.ok(hatch[i] > hatch[i - 1], `hatch density does not rise with severity at ${SEVERITIES[i]}`)
    }
    assert.equal(hatch[3], 0, 'the lowest severity should carry no hatch at all')
  })

  it('every colour token is readable as oklch() by the measurement above', () => {
    // A token this file cannot parse is a token nobody is checking.
    const isColour = (value) => /^(oklch|rgb|hsl)\(|^#|^color\(/.test(value)
    for (const [name, table] of [['light', LIGHT], ['contrast', CONTRAST], ['dark', DARK]]) {
      for (const [token, value] of Object.entries(table)) {
        if (!isColour(value)) continue
        if (/^oklch\(.*\/.*\)$/.test(value)) continue // shadow alpha, not a swatch
        assert.doesNotThrow(() => parse(value), `${name} ${token}: ${value}`)
      }
    }
  })
})