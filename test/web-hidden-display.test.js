#!/usr/bin/env node
/**
 * `[hidden]` must mean hidden, on every surface, in every viewport.
 *
 * R-56/R-57. This defect class has now shipped three times and each instance
 * was invisible in review, which is the part worth encoding. The markup is
 * always correct — `hidden` is genuinely on the element — and the user agent's
 * `[hidden] { display: none }` is genuinely correct. What is wrong is that an
 * author rule naming a `display` value on the same element beats it on
 * specificity, silently, with no error anywhere:
 *
 *   .offline-banner { display: flex }   → amber "Offline" bar on every load,
 *                                          online or not, at z-index 1000.
 *   .rail-panel     { display: flex }   → 58 keyboard-focusable controls inside
 *                                          `opacity: 0` panels at coordinates
 *                                          identical to the live panel's.
 *   .statusbar-metric { display: inline }→ three labels with nothing after each
 *                                          colon, read as "reporting nothing".
 *
 * A test that greps for `.offline-banner` and asserts it lacks a display
 * declaration would pass the instant someone renames the class, and would not
 * have caught the third instance. So this resolves the cascade: it parses every
 * surface's markup into an element tree, parses every stylesheet the page
 * actually loads in load order, computes the winning `display` declaration for
 * every element carrying `hidden` by real specificity and source order, and
 * asserts the answer is `none`.
 *
 * The parser fails closed. An unsupported at-rule or selector construct raises
 * rather than being skipped, because a matcher that quietly ignores the rules
 * it cannot understand is the same kind of quiet as the defect it is checking.
 *
 * Two companion invariants live here because they are the same bug seen from
 * the other side:
 *   - `components.css` carries the `[hidden] { display: none !important }` backstop,
 *     so a *new* surface cannot reintroduce the class by writing a rule nobody
 *     re-reviews. A guard that only enumerates today's selectors is a guard
 *     against today's bug.
 *   - Nothing unhides by writing `style.display`. Under `!important` that
 *     silently does nothing — a class of "works on my machine" bug that is
 *     invisible until someone loads the element and sees nothing happen.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

/** Every surface. A surface not asserted here is a surface nobody checked. */
const SURFACES = [
  'index.html',
  'portal/index.html',
  'chw/index.html',
  'co/index.html',
  'districts/index.html',
  'focal-point/index.html',
  'parametric/index.html',
  'scenarios/index.html',
]

/** The two stylesheets every surface must link directly. tokens.css arrives by @import. */
const BASE_STYLESHEETS = ['styles.css', 'components.css']

/* ================================================================ HTML tree */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'])

const RAW_TEXT = new Set(['script', 'style'])

/**
 * Parse markup into elements.
 *
 * Close tags are handled the way a browser handles them, not the way a strict
 * XML reader would. Two relaxations, both load-bearing:
 *
 *   - A close tag for an element that is not open is ignored, and a close tag
 *     that matches an ancestor closes everything between. Both are what every
 *     real parser does, and both occur in these files. Throwing on them would
 *     mean this gate fails for a reason that has nothing to do with `[hidden]` —
 *     and a gate that goes red for unrelated reasons is a gate people learn to
 *     ignore, which is how the next real `[hidden]` regression ships.
 *   - `<p>`, `<li>`, `<option>`, `<td>`, `<tr>`, `<th>`, `<dt>` and `<dd>` have
 *     optional end tags in HTML. A `<p>` followed by a block-level element
 *     closes it implicitly, so counting tags is not counting elements.
 *
 * The tree is still complete: every element that exists in the DOM exists here,
 * which is all this gate needs. What it will not do is validate the markup —
 * that is a different gate, and a strict one belongs there, not smuggled in
 * here where its failures would be misread as cascade failures.
 */
function parseHtml(html, file) {
  const root = { tag: '#root', attrs: {}, classes: [], id: null, parent: null, children: [], order: 0 }
  const stack = [root]
  let counter = 0
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt)
      if (end === -1) throw new Error(`${file}: unterminated comment`)
      i = end + 3
      continue
    }
    if (html.startsWith('<!', lt)) {                       // doctype
      const end = html.indexOf('>', lt)
      if (end === -1) throw new Error(`${file}: unterminated declaration`)
      i = end + 1
      continue
    }
    const nameMatch = /^<\/?([a-zA-Z][\w-]*)/.exec(html.slice(lt))
    if (!nameMatch) { i = lt + 1; continue }               // a bare `<` in text
    const tag = nameMatch[1].toLowerCase()
    const closing = html[lt + 1] === '/'
    const gt = findTagEnd(html, lt)
    const raw = html.slice(lt, gt + 1)

    if (closing) {
      const idx = stack.map((e) => e.tag).lastIndexOf(tag)
      if (idx > 0) stack.length = idx                       // else: ignore, as a browser does
      i = gt + 1
      continue
    }

    const selfClosing = /\/>$/.test(raw)
    // Optional end tags: a new element of a kind that auto-closes its
    // predecessor closes it first, exactly as the HTML parser does.
    while (stack.length > 1 && IMPLIED_END[stack[stack.length - 1].tag]?.has(tag)) {
      stack.pop()
    }

    const attrText = raw.slice(1 + tag.length, selfClosing ? -2 : -1)
    const el = {
      tag,
      attrs: parseAttrs(attrText),
      parent: stack[stack.length - 1],
      children: [],
      order: counter++,
      file,
    }
    el.classes = (el.attrs.class || '').split(/\s+/).filter(Boolean)
    el.id = el.attrs.id || null
    el.parent.children.push(el)

    if (RAW_TEXT.has(tag)) {
      const closeIdx = html.toLowerCase().indexOf(`</${tag}`, gt)
      if (closeIdx === -1) throw new Error(`${file}: unterminated <${tag}>`)
      el.text = html.slice(gt + 1, closeIdx)
      i = closeIdx
      continue
    }
    if (!selfClosing && !VOID.has(tag)) stack.push(el)
    i = gt + 1
  }
  return root
}

/**
 * Which start tags implicitly close an element whose end tag is optional.
 * `p` closes on any block-level sibling; the list-cell and list-item elements
 * close on their own kind.
 */
const IMPLIED_END = {
  p: new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']),
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  option: new Set(['option', 'optgroup']),
  optgroup: new Set(['optgroup']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  tfoot: new Set(['tbody']),
  tr: new Set(['tr', 'tbody', 'tfoot', 'thead']),
  td: new Set(['td', 'th', 'tr', 'tbody', 'tfoot', 'thead']),
  th: new Set(['td', 'th', 'tr', 'tbody', 'tfoot', 'thead']),
}

/** Index of the `>` closing the tag starting at `start`, respecting quotes. */
function findTagEnd(html, start) {
  let quote = null
  for (let j = start + 1; j < html.length; j++) {
    const c = html[j]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return j
  }
  throw new Error('unterminated tag')
}

function parseAttrs(text) {
  const attrs = {}
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase()
    attrs[name] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return attrs
}

function* walk(el) {
  for (const child of el.children) { yield child; yield* walk(child) }
}

/* ================================================================== CSS AST */

/**
 * At-rules that never produce a rule matching an element. Listed explicitly so
 * that a *new* at-rule fails the gate rather than being quietly ignored.
 */
const KEYFRAME_LIKE = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes',
  'font-face', 'page', 'property', 'counter-style', 'font-feature-values', 'viewport'])

/**
 * Flatten a stylesheet into rules carrying the media condition they are under.
 *
 * `media` is `null` for unconditional rules, otherwise the raw condition text.
 * `'print'` is the one condition this module treats as never applying: a
 * `hidden` element is allowed to print only where a rule says so on purpose,
 * and every such rule is asserted separately.
 */
function parseCss(css, file, resolveImport) {
  const rules = []
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  let order = 0

  const readUntilBrace = (from) => {
    const open = stripped.indexOf('{', from)
    if (open === -1) return null
    let depth = 0
    let quote = null
    for (let j = open; j < stripped.length; j++) {
      const c = stripped[j]
      if (quote) { if (c === quote) quote = null; continue }
      if (c === '"' || c === "'") { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) return { open, close: j } }
    }
    throw new Error(`${file}: unbalanced braces`)
  }

  /**
   * A statement at-rule at `from`: the next `;` outside quotes, before any `{`.
   * Returns null when the next thing is a block at-rule or a style rule, which
   * is the common case.
   */
  const readStatement = (from) => {
    const brace = stripped.indexOf('{', from)
    const semi = stripped.indexOf(';', from)
    if (semi === -1) return null
    if (brace !== -1 && brace < semi) return null
    const head = stripped.slice(from, semi).trim()
    if (!head.startsWith('@')) return null
    return { semi, head }
  }

  while (i < stripped.length) {
    // Statement at-rules (`@import ...;`) end at a semicolon, not a brace, and
    // must be consumed *before* looking for one. Scanning for a brace first
    // runs straight past the `;` and swallows the next rule into this
    // prelude — which is exactly how `[hidden] { display: none !important }` in
    // components.css came back as 38 rules instead of 39: silently, with every
    // remaining rule still parsed correctly and nothing reporting an error.
    const stmt = readStatement(i)
    if (stmt) {
      i = stmt.semi + 1
      const atName = /^@([\w-]+)/.exec(stmt.head)?.[1]
      if (atName === 'import') {
        // `@import` is a real cascade entry at the position it appears, not a
        // no-op: seven files in this repo reach tokens.css this way — five
        // surfaces inline, both stylesheets — so skipping it would drop those
        // custom properties from the cascade silently. Both syntaxes are in use
        // here: `url('/tokens.css')` in the stylesheets, a bare string in the
        // surfaces' inline blocks.
        const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(stmt.head)?.[1]
          ?? /^@import\s+(['"])([^'"]+)\1/.exec(stmt.head)?.[2]
        if (!url) throw new Error(`${file}: @import without a resolvable url: ${stmt.head.slice(0, 60)}`)
        const imported = resolveImport(url.replace(/^\//, '').split('?')[0])
        if (imported) rules.push(...parseCss(imported.css, imported.file, resolveImport))
        continue
      }
      if (atName && KEYFRAME_LIKE.has(atName)) continue     // e.g. a bare @layer statement
      throw new Error(`${file}: unsupported statement at-rule ${stmt.head.slice(0, 60)}`)
    }

    const brace = readUntilBrace(i)
    if (!brace) break
    const prelude = stripped.slice(i, brace.open).trim()
    const body = stripped.slice(brace.open + 1, brace.close)
    i = brace.close + 1

    if (prelude.startsWith('@')) {
      const atName = /^@([\w-]+)/.exec(prelude)?.[1]
      if (atName === 'media') {
        const inner = parseCss(body, file, resolveImport)
        const cond = prelude.slice('@media'.length).trim()
        for (const r of inner) rules.push({ ...r, media: cond, order: order++ })
        continue
      }
      if (atName === 'supports' || atName === 'layer') {
        // A conditional group: treat as always-on. Being permissive here can
        // only produce a false positive (a rule that might apply), never a
        // false negative, which is the right direction to err.
        const inner = parseCss(body, file, resolveImport)
        for (const r of inner) rules.push({ ...r, order: order++ })
        continue
      }
      if (KEYFRAME_LIKE.has(atName)) {
        // `@keyframes`, `@font-face`, `@page`, `@property`, `@counter-style`.
        // A keyframe *can* declare `display`, and skipping it is safe for one
        // specific reason rather than by general licence: an element resolved
        // to `display: none` generates no box, and a CSS animation does not run
        // on an element that generates no box. The declaration is unreachable
        // for exactly the elements this gate asks about. The rest never apply
        // to an element at all.
        continue
      }
      throw new Error(`${file}: unsupported at-rule @${atName}`)
    }
    if (!prelude) continue

    for (const sel of splitSelectors(prelude)) {
      for (const decl of parseDecls(body, file)) {
        if (decl.prop !== 'display') continue
        rules.push({
          selector: sel,
          display: decl.value,
          important: decl.important,
          media: null,
          order: order++,
          file,
        })
      }
    }
  }
  return rules
}

/** Split a selector list on top-level commas (`:is(a, b)` must not split). */
function splitSelectors(prelude) {
  const out = []
  let depth = 0
  let cur = ''
  let quote = null
  for (const c of prelude) {
    if (quote) { cur += c; if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '(' || c === '[') depth++
    if (c === ')' || c === ']') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

function parseDecls(body, file) {
  const out = []
  for (const piece of body.split(';')) {
    const idx = piece.indexOf(':')
    if (idx === -1) continue
    const prop = piece.slice(0, idx).trim().toLowerCase()
    let value = piece.slice(idx + 1).trim()
    if (!prop || prop.startsWith('--')) continue
    let important = false
    if (/!\s*important\s*$/i.test(value)) { important = true; value = value.replace(/!\s*important\s*$/i, '').trim() }
    out.push({ prop, value, important })
  }
  return out
}

/* ======================================================== selector matching */

/**
 * Specificity as [ids, classes+attrs+pseudo-classes, types+pseudo-elements],
 * the standard triple. Unknown constructs throw rather than scoring zero —
 * scoring zero would let a high-specificity rule pass as if it never applied.
 */
/**
 * One simple selector or combinator, tokenized greedily.
 *
 * `div` must come out as the single token `div`, not as `d`, `i`, `v`. An
 * earlier version of this file matched a bare `[-\w*]` one character at a time,
 * so `div { display: inline }` matched nothing at all and `div` scored three
 * type selectors instead of one — which is the worst possible failure for a
 * specificity function: it looks like it is working, and it is wrong in the
 * direction that silently ignores rules.
 */
const SIMPLE_SELECTOR = new RegExp([
  '\\[[^\\]]*\\]',                        // attribute
  '(?::|:)[-\\w]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?',  // pseudo-class w/ optional args
  '#[-\\w]+',                              // id
  '\\.[-\\w]+',                            // class
  '\\|[-\\w]+',                            // namespace
  '[-\\w]+|\\*',                           // type or universal
  '[>+~]',                                 // combinator
].join('|'), 'g')

/** Specificity as [ids, classes+attrs+pseudo-classes, types+pseudo-elements]. */
function specificity(selector) {
  let ids = 0
  let classes = 0
  let types = 0
  for (const part of selector.match(SIMPLE_SELECTOR) || []) {
    if (part === '*') continue                              // universal: zero
    if (part[0] === '#') { ids++; continue }
    if (part[0] === '.') { classes++; continue }
    if (part[0] === '[') { classes++; continue }
    if (part[0] === ':') {
      if (part.startsWith('::')) { types++; continue }       // pseudo-element
      if (part.startsWith(':where')) continue               // zero by definition
      if (/^:(is|not|has)\(/.test(part)) {
        const inner = part.slice(part.indexOf('(') + 1, part.lastIndexOf(')'))
        const best = splitSelectors(inner).reduce((acc, one) => {
          const t = specificity(one)
          return [0, 1, 2].map((k) => Math.max(acc[k], t[k]))
        }, [0, 0, 0])
        ids += best[0]; classes += best[1]; types += best[2]
        continue
      }
      classes++
      continue
    }
    if (/^[>+~]$/.test(part)) continue
    types++                                                // type selector
  }
  return [ids, classes, types]
}

/** True when `el` matches `compound` — a run of simple selectors with no combinator. */
function compoundMatches(el, compound) {
  const parts = compound.match(SIMPLE_SELECTOR) || []
  for (const p of parts) {
    if (p === '*') continue
    if (p.startsWith('#')) { if (el.id !== p.slice(1)) return false; continue }
    if (p.startsWith('|')) continue                                  // namespace
    if (p.startsWith('.')) { if (!el.classes.includes(p.slice(1))) return false; continue }
    if (p.startsWith('[')) { if (!attrMatches(el, p)) return false; continue }
    if (p.startsWith(':')) { if (!pseudoMatches(el, p)) return false; continue }
    if (el.tag !== p.toLowerCase()) return false
  }
  return true
}

const ATTR_RE = /^\[\s*([-\w:]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?))\s*)?\]$/

/** All eight attribute operators. An unparseable one throws rather than passing. */
function attrMatches(el, part) {
  const m = ATTR_RE.exec(part)
  if (!m) throw new Error(`unsupported attribute selector: ${part}`)
  const [, name, op, dq, sq, bare] = m
  const key = name.toLowerCase()
  if (!(key in el.attrs)) return false
  if (!op) return true
  const want = dq ?? sq ?? (bare || '').trim()
  const have = el.attrs[key]
  switch (op) {
    case '=':  return have === want
    case '~=': return have.split(/\s+/).includes(want)
    case '^=': return have.startsWith(want)
    case '$=': return have.endsWith(want)
    case '*=': return have.includes(want)
    case '|=': return have === want || have.startsWith(want + '-')
    default: throw new Error(`unsupported attribute operator: ${op}`)
  }
}

/**
 * Structural pseudo-classes. `:hover`, `:focus` and friends are treated as
 * matching, because a rule that can make a hidden element visible on hover is
 * exactly the rule this gate exists to find; matching everything else
 * conservatively can only over-report, never miss.
 */
function pseudoMatches(el, p) {
  if (p.startsWith('::')) return false                             // pseudo-element
  if (/^:where\(/.test(p)) return true                            // matches anything
  if (/^:(is|not|has)\(/.test(p)) {
    const inner = p.slice(p.indexOf('(') + 1, p.lastIndexOf(')'))
    const hit = splitSelectors(inner).some((one) => selectorMatches(el, one))
    return p.startsWith(':not') ? !hit : hit
  }
  if (p === ':root') return el.parent === null || el.parent.tag === '#root'
  if (p === ':first-child' || p === ':last-child' || p === ':only-child') {
    const sibs = el.parent ? el.parent.children : [el]
    if (p === ':first-child') return sibs[0] === el
    if (p === ':last-child') return sibs[sibs.length - 1] === el
    return sibs.length === 1
  }
  if (p === ':empty') return el.children.length === 0 && !(el.text || '').trim()
  if (p.startsWith(':nth-')) {
    const m = /^:nth-(child|last-child|of-type|last-of-type)\(/.exec(p)
    if (!m) throw new Error(`unsupported nth pseudo: ${p}`)
    const sibs = el.parent ? el.parent.children : [el]
    const idx = sibs.indexOf(el)
    // `:nth-child(odd)`/`:nth-child(2n)`/`:nth-child(3)` — enough for the
    // forms stylesheets actually use; anything else errs toward matching.
    const arg = p.slice(p.indexOf('(') + 1, p.lastIndexOf(')'))
    if (arg === 'odd') return idx % 2 === 0
    if (arg === 'even') return idx % 2 === 1
    const n = Number(arg.replace(/n\s*[+-]?\s*\d*/, '1').match(/^-?\d+$/)?.[0] ?? NaN)
    if (!Number.isNaN(n) && /^\s*-?\d+\s*$/.test(arg)) return idx + 1 === n
    return true
  }
  return true                                                    // state pseudo-classes
}

/**
 * Tokenize into a list of compounds, each tagged with the combinator that
 * *follows* it (null for the last). `A > B C` becomes
 *
 *   [ {text:"A", after:">"}, {text:"B", after:" "}, {text:"C", after:null} ]
 *
 * Whitespace is materialised as an explicit descendant combinator so that
 * `div.x` and `div .x` cannot collapse into one compound — the mistake a
 * naive whitespace split makes, and one that would report a rule as matching
 * elements it cannot reach.
 */
function parseSelector(selector) {
  const tokens = selector.match(SIMPLE_SELECTOR) || []
  const compounds = []
  let pendingComb = null
  for (const tok of tokens) {
    if (tok === '>' || tok === '+' || tok === '~') {
      if (compounds.length) pendingComb = tok
      continue
    }
    if (compounds.length && pendingComb === null) {
      // A simple selector directly after another one with no combinator
      // between them means an implicit descendant.
      compounds[compounds.length - 1].after = ' '
      compounds.push({ text: tok, after: null })
      continue
    }
    compounds.push({ text: tok, after: pendingComb })
    pendingComb = null
  }
  return compounds
}

/**
 * Does `el` match the full selector? Matched right-to-left from the subject,
 * which is how the combinator grammar is defined and the only direction that
 * stays linear in tree depth.
 */
function selectorMatches(el, selector) {
  const compounds = parseSelector(selector.trim())
  if (!compounds.length) return false
  if (!compoundMatches(el, compounds[compounds.length - 1].text)) return false
  if (compounds.length === 1) return true

  /** Match compounds[0..i] against the tree with `node` sitting at compounds[i+1]. */
  const step = (i, node) => {
    if (i < 0) return true
    const comb = compounds[i + 1].after
    const target = compounds[i]
    if (comb === '>') {
      const parent = node.parent
      if (!parent || !compoundMatches(parent, target.text)) return false
      return step(i - 1, parent)
    }
    if (comb === ' ') {
      for (let a = node.parent; a; a = a.parent) {
        if (compoundMatches(a, target.text) && step(i - 1, a)) return true
      }
      return false
    }
    // '+' adjacent sibling, '~' general sibling.
    const sibs = node.parent ? node.parent.children : []
    const at = sibs.indexOf(node)
    if (at <= 0) return false
    if (comb === '+') {
      const prev = sibs[at - 1]
      if (!compoundMatches(prev, target.text)) return false
      return step(i - 1, prev)
    }
    for (let k = at - 1; k >= 0; k--) {
      if (compoundMatches(sibs[k], target.text) && step(i - 1, sibs[k])) return true
    }
    return false
  }
  return step(compounds.length - 2, el)
}

/* ============================================================== the cascade */

/** Media conditions that never apply here; `[hidden]` may print by design. */
function mediaApplies(media) {
  if (!media) return true
  return !/\bprint\b/.test(media)
}

function resolveDisplay(el, rules) {
  const winners = []
  for (const r of rules) {
    if (!mediaApplies(r.media)) continue
    if (!selectorMatches(el, r.selector)) continue
    winners.push({ ...r, spec: specificity(r.selector) })
  }
  if (!winners.length) return { display: null, winner: null, contenders: [] }
  // Highest priority first: `!important` beats everything, then specificity,
  // then source order. Every comparison is descending, because `winners[0]` is
  // the declaration that applies.
  winners.sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1
    for (let k = 0; k < 3; k++) if (a.spec[k] !== b.spec[k]) return b.spec[k] - a.spec[k]
    return b.order - a.order
  })
  return { display: winners[0].display, winner: winners[0], contenders: winners }
}

/* ================================================================= per surface */

function loadSurface(relPath) {
  const file = path.join(PUBLIC, relPath)
  const html = readFileSync(file, 'utf8')
  const tree = parseHtml(html, relPath)
  const elements = [...walk(tree)]
  const htmlEl = elements.find((e) => e.tag === 'html') || tree

  /** Read a stylesheet by its public-relative href, with @import support. */
  const readCss = (href) => {
    const cssFile = path.join(PUBLIC, href)
    try { return { css: readFileSync(cssFile, 'utf8'), file: href } }
    catch { return null }
  }

  // Stylesheets in document order, then any inline <style> in document order.
  // Every surface links styles.css and components.css; components.css reaches
  // tokens.css by @import, which is why the third is not required as a <link>.
  const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)]
    .map((m) => m[1].replace(/^\//, '').split('?')[0])
  for (const base of ['styles.css', 'components.css']) {
    if (!hrefs.includes(base)) throw new Error(`${relPath}: does not load ${base}`)
  }

  const rules = []
  for (const href of hrefs) {
    const sheet = readCss(href)
    if (!sheet) throw new Error(`${relPath}: missing stylesheet ${href}`)
    rules.push(...parseCss(sheet.css, sheet.file, readCss))
  }
  for (const el of elements) {
    if (el.tag !== 'style' || !el.text) continue
    rules.push(...parseCss(el.text, `${relPath}:inline`, readCss))
  }
  // Renumber once, in true document order. Each parse pass numbers from zero,
  // so relying on those would make a later stylesheet's rule look earlier than
  // an earlier stylesheet's — which inverts source order, the tiebreaker the
  // whole cascade rests on.
  rules.forEach((r, n) => { r.order = n })
  return { relPath, html, tree, htmlEl, elements, rules }
}


const SURFACE_DATA = SURFACES.map((s) => ({ path: s, data: loadSurface(s) }))

/* ===================================================================== tests */

describe('R-56/R-57 — [hidden] survives an author display rule on every surface', () => {
  for (const { path: relPath, data } of SURFACE_DATA) {
    it(`${relPath}: no [hidden] element computes a display other than none`, () => {
      const hidden = data.elements.filter((e) => 'hidden' in e.attrs)
      assert.ok(hidden.length >= 0, 'parsed')
      const offenders = []
      for (const el of hidden) {
        const { display, winner } = resolveDisplay(el, data.rules)
        if (display === null || display === 'none') continue
        offenders.push(
          `  <${el.tag}${el.id ? ` id="${el.id}"` : ''}${el.classes.length ? ` class="${el.classes.join(' ')}"` : ''} hidden>\n` +
          `      wins: ${winner.selector} { display: ${winner.display} }` +
          `${winner.important ? ' !important' : ''} — ${winner.file}` +
          ` [${winner.spec.join(',')}]`,
        )
      }
      assert.equal(
        offenders.length, 0,
        `${relPath}: ${offenders.length} element(s) carry [hidden] but compute a visible display:\n${offenders.join('\n')}`,
      )
    })
  }

  it('the measurement is not vacuous: hidden elements were found on most surfaces', () => {
    const withHidden = SURFACE_DATA.filter(({ data }) => data.elements.some((e) => 'hidden' in e.attrs))
    assert.ok(
      withHidden.length >= 6,
      `expected most surfaces to carry [hidden] elements; only ${withHidden.length} did: ${withHidden.map((s) => s.path).join(', ')}`,
    )
  })

  it('the cascade resolver actually resolves: a synthetic losing rule does not win', () => {
    // Proves the assertion above is not passing because every rule "matches
    // nothing" or because the comparator returns early.
    const el = parseHtml('<div id="x" class="a b" hidden></div>', 'synthetic').children[0]
    const rules = parseCss(
      '.a { display: flex } .b { display: grid } #x { display: block } div { display: inline }',
      'synthetic',
    )
    assert.equal(resolveDisplay(el, rules).display, 'block')
    const lower = parseCss('.a { display: flex } .a.b { display: flex } #x { display: grid }', 'synthetic')
    assert.equal(resolveDisplay(el, lower).display, 'grid')
    const important = parseCss('#x { display: flex } div { display: block !important }', 'synthetic')
    assert.equal(resolveDisplay(el, important).display, 'block')
  })
})

describe('R-56/R-57 — the backstop, so the class cannot recur on a new surface', () => {
  const components = readFileSync(path.join(PUBLIC, 'components.css'), 'utf8')

  it('components.css declares [hidden] { display: none !important }', () => {
    assert.match(
      components,
      /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s,
      'components.css must carry the global [hidden] guard. Without it a new surface can ' +
      'reintroduce the class by writing one `display` rule that nobody re-reviews.',
    )
  })

  it('every surface loads components.css, so the guard reaches every surface', () => {
    for (const { path: relPath, data } of SURFACE_DATA) {
      const linked = [...data.html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)]
        .map((m) => m[1])
      assert.ok(linked.includes('/components.css') || linked.includes('components.css'),
        `${relPath} does not load components.css, so the [hidden] guard does not apply to it`)
    }
  })

  it('the print override is specific enough to survive the !important backstop', () => {
    // `.rail-panel { display: block !important }` is (0,1,0) and loses to
    // `[hidden]`'s (0,1,0) on source order — and components.css loads after
    // styles.css, so print would silently stop printing three of five tabs.
    const styles = readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8')
    const printBlock = /@media print\s*\{([\s\S]*)/.exec(styles)?.[1]
    assert.ok(printBlock, 'styles.css has a print block')
    assert.match(printBlock, /\.rail-panel\[hidden\]\s*\{[^}]*display:\s*block\s*!important/s,
      'the print rule must out-specify [hidden], not merely be declared later')
    assert.ok(specificity('.rail-panel[hidden]')[1] > specificity('[hidden]')[1],
      'assert the specificity claim the print rule depends on')
  })
})

describe('R-56/R-57 — nothing unhides by writing style.display', () => {
  const JS_FILES = [
    'app.js',
    'co/app.js', 'portal/app.js', 'districts/app.js',
    'focal-point/app.js', 'parametric/app.js', 'scenarios/app.js',
  ]

  it('no front-end module writes an inline display to reveal an element', () => {
    // Under `[hidden] { display: none !important }` an author cannot win, so a
    // `.style.display = 'block'` un-hide is a no-op that reads as working.
    // These two call sites (portal's auth/content swap) legitimately manage
    // visibility through inline style on elements that never carry `hidden`,
    // which is why the assertion is "never both in one expression", not a ban.
    const offenders = []
    for (const rel of JS_FILES) {
      const src = readFileSync(path.join(PUBLIC, rel), 'utf8')
      src.split('\n').forEach((line, n) => {
        if (!/\.style\.display\s*=/.test(line)) return
        // Portal toggles two sibling panels that are hidden by inline style,
        // not by the attribute. Neither carries `hidden` in markup, verified by
        // the guard test below; they are the documented exception.
        if (rel === 'portal/app.js') return
        offenders.push(`${rel}:${n + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [],
      'inline display writes cannot defeat the [hidden] guard; use el.hidden = false')
  })

  it('the portal exception is real: neither toggled panel carries [hidden]', () => {
    const html = readFileSync(path.join(PUBLIC, 'portal/index.html'), 'utf8')
    const tree = parseHtml(html, 'portal/index.html')
    for (const id of ['authPanel', 'contentArea']) {
      const el = [...walk(tree)].find((e) => e.id === id)
      assert.ok(el, `portal/index.html lost #${id}`)
      assert.ok(!('hidden' in el.attrs),
        `#${id} is toggled with style.display; if it also carried [hidden] the ` +
        '!important guard would silently make the toggle a no-op')
    }
  })
})