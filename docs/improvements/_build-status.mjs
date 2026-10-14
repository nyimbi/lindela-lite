import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Everything below the tables used to be prose typed into this file: a frozen
// October paragraph that kept asserting "exported, tested and called by nothing"
// long after the call sites landed, and kept naming guard tests that had been
// renamed. The ledger said one thing and the narrative another. So the narrative
// is computed from the ledger, and the ledger is checked against the tree on
// every run. A claim that cannot be derived does not appear.

const MARK = { shipped: 'shipped', partial: 'partial', 'not started': '**not started**' }
/** A pipe inside a cell ends the cell. ENH-06's title contains three of them. */
const cell = (text) => String(text).replace(/\|/g, '\\|')
const num = (id) => Number(id.replace('ENH-', ''))
const groupOf = (id) => {
  const n = num(id)
  return n <= 5 ? 'A' : n <= 15 ? 'B' : n <= 24 ? 'C' : n <= 28 ? 'D' : 'E'
}
const TITLES = {
  A: 'Trust: make the honesty reach the payload',
  B: 'Ingestion fidelity, quality, timeliness',
  C: 'Visualization depth',
  D: 'Response and delivery',
  E: 'Platform foundations',
}

// --- verification against the tree -------------------------------------------

/** A `path:line` or `path:from-to` reference is good when the file exists and is that long. */
export function verifyRef(ref, root) {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(ref)
  const file = m ? m[1] : ref
  const abs = path.join(root, file)
  if (!fs.existsSync(abs)) return { ok: false, why: 'file missing' }
  if (m) {
    const to = Number(m[3] || m[2])
    const lines = fs.readFileSync(abs, 'utf8').split('\n').length
    if (to > lines) return { ok: false, why: `line ${to} past end of file (${lines})` }
  }
  return { ok: true }
}

/**
 * Production importers of a module. The tree reaches shared modules three ways —
 * a static `from '…'`, a dynamic `import('…')`, and `app.js`'s `lazy('/shared/x.js')`
 * helper, which names the file as a string — so a scanner that only knows `from`
 * reports lazily-loaded modules as uncalled. `.` is passed explicitly: with a
 * piped stdin and no path, rg reads stdin instead of the tree.
 *
 * A caller is a file whose specifier **resolves to this module**, not one whose
 * specifier happens to end in the same basename. The pattern used to be built
 * from the stem alone, and that produced two kinds of false positive with the
 * same failure direction — over-reporting callers, which hides the "Built,
 * tested, called by nothing" finding the section exists to raise:
 *
 *   - `[^'"]*` immediately before the stem let it match the *tail* of a longer
 *     name: `source-agreement.js` counted for `agreement.js`,
 *     `basemap-tiles.js` for `tiles.js`, `org-units.js` for `units.js`.
 *   - Anchoring the prefix fixed that but not the second: the stem still matched
 *     a *different file with the same basename*. `src/routes/upload.js` and
 *     `src/upload.js` are different modules, and so are `src/forms.js` and
 *     `public/shared/forms.js`; 44 callers were reported that way.
 *
 * So the specifier is captured and **resolved** — relative to the importing file,
 * or as a public-root path — and the candidate is a caller only when the resolved
 * path is this module.
 */
export function callers(modulePath, root) {
  const stem = path.basename(modulePath, path.extname(modulePath)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:from|import\\(|lazy\\(|require\\()\\s*['"]([^'"]*)${stem}(\\.js)?['"]`, 'g')
  const found = []
  for (const file of walkFiles(root)) {
    if (file === modulePath || file.startsWith('test/')) continue
    // A file the walk listed can be gone by the time it is read. `node --test`
    // runs files in parallel workers, and `test/budget-walker.test.js` plants a
    // canary module under `public/shared/` and removes it in a `finally` — so
    // this read raced a delete and crashed the whole generator with ENOENT.
    // A vanished file is not a caller; it is not a finding either. Skipping it
    // is right for a scan whose subject is *content*, and it keeps a transient
    // write in another worker from failing a build that has nothing to do with it.
    let text
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    // `lastIndex` is state on a `/g` regex; reset it so a file is not skipped
    // because a previous iteration left the cursor mid-string.
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (resolvesTo(match[1], stem, file, modulePath)) { found.push(file); break }
    }
  }
  return found
}

/**
 * Does a specifier resolve to the module being asked about?
 *
 * The specifier's directory part is the capture; the basename is `stem`. A
 * relative specifier resolves against the importing file's directory, which is
 * what makes `./forms.js` from `src/routes/chw.js` a different module than
 * `./forms.js` from `src/sms-grammar.js`. A root-absolute specifier resolves
 * against the served root, so `/shared/forms.js` names `public/shared/forms.js`
 * and never `src/forms.js`. Anything else — a bare package name — cannot name a
 * file in this tree.
 *
 * `public/` is the served root, so a `/…` specifier resolves there from any
 * file; `lazy('/shared/x.js')` in `public/app.js` is the case that matters,
 * since the helper names the file as a string the browser resolves.
 */
function resolvesTo(dirPart, stem, importer, modulePath) {
  const specifier = `${dirPart}${stem}.js`
  let resolved
  if (specifier.startsWith('/')) resolved = path.join('public', specifier)
  else if (specifier.startsWith('.')) resolved = path.join(path.dirname(importer), specifier)
  else return false
  return path.normalize(resolved) === path.normalize(modulePath)
}

/**
 * Every tracked file under `root`, as paths relative to it.
 *
 * `rg` was the original implementation and it worked, but only where ripgrep is
 * installed — on the GitHub runner the whole generator died `rg failed (null)`,
 * so `status.md` could not be regenerated and its currency test failed for a
 * reason that had nothing to do with the ledger. A tree walk is not a search
 * engine; this one is.
 *
 * It reproduces the two behaviours the call relied on: `.gitignore` is honoured
 * (so `node_modules/`, `data/` and the internal tender documents stay out), and
 * dot-directories are skipped as `rg` skips hidden paths. Directories are pruned
 * rather than filtered after the fact, so a vendored tree is never descended.
 */
function walkFiles(root) {
  const ignore = gitignorePatterns(root)
  const found = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip rather than fail the whole build
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.name.startsWith('.')) continue
      if (ignore.some((re) => re.test(childRel) || re.test(`${childRel}/`))) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, childRel)
      else if (entry.isFile()) found.push(childRel)
    }
  }
  walk(root, '')
  return found.sort()
}

/** `.gitignore` patterns as anchored regexes. Enough for this tree's rules. */
function gitignorePatterns(root) {
  const file = path.join(root, '.gitignore')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => {
      const bare = line.replace(/^\//, '').replace(/\/$/, '')
      const escaped = bare.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
      // A pattern with no slash matches at any depth, which is how git reads it.
      return bare.includes('/') ? new RegExp(`^${escaped}$`) : new RegExp(`(^|/)${escaped}$`)
    })
}

/**
 * The markdown, and what the tree said while building it. `write: false` returns
 * the same string without touching the file, which is how test/enhancement-status
 * asserts the committed status.md is current.
 */
export function buildStatus({ root = process.cwd(), write = true } = {}) {
  const items = []
  for (const g of ['a', 'b', 'c', 'de']) {
    items.push(...JSON.parse(fs.readFileSync(path.join(root, `docs/improvements/_status-${g}.json`), 'utf8')).items)
  }
  items.sort((x, y) => num(x.id) - num(y.id))

  const brokenRefs = []
  const unguarded = []
  const uncalled = []
  for (const i of items) {
    for (const ref of i.evidence) {
      const v = verifyRef(ref, root)
      if (!v.ok) brokenRefs.push(`${i.id} \`${ref}\` — ${v.why}`)
    }
    const guards = i.guarded_by ? i.guarded_by.split(', ') : []
    if (!guards.length) unguarded.push(i.id)
    for (const g of guards) {
      const v = verifyRef(g, root)
      if (!v.ok) brokenRefs.push(`${i.id} guard \`${g}\` — ${v.why}`)
    }
    // A module named in the evidence that nothing outside test/ imports is the
    // "built, tested, called by nothing" shape — measured here, not asserted.
    //
    // The pattern used to be `[\w-]+\.js$`, one directory level, so every nested
    // module was skipped — 61 of them under `src/` alone. `src/analytics/ensemble.js`
    // is evidence for ENH-21 and has no production caller, and this check could
    // not see it: a hand-typed pattern standing for a discoverable set, in the
    // one place whose whole job is to notice that. Nested modules are now in
    // jurisdiction, and `.+` rather than `[\w-]+` admits the `/`.
    // A module can be cited more than once (a `path:line` per interesting site),
    // and it is one finding however many times it is named — the same file listed
    // twice reads as two dead modules.
    const seenUncalled = new Set()
    for (const ref of i.evidence) {
      const file = ref.replace(/:\d+(-\d+)?$/, '')
      if (seenUncalled.has(file)) continue
      if (/^(src|public\/shared)\/.+\.js$/.test(file) && callers(file, root).length === 0) {
        seenUncalled.add(file)
        uncalled.push(`${i.id} \`${file}\``)
      }
    }
  }

  const out = []
  const counts = { shipped: 0, partial: 0, 'not started': 0 }
  for (const g of ['A', 'B', 'C', 'D', 'E']) {
    out.push(`## Group ${g} — ${TITLES[g]}`, '')
    out.push('| | Enhancement | Status | Guarded by |')
    out.push('|---|---|---|---|')
    for (const i of items.filter((x) => groupOf(x.id) === g)) {
      counts[i.status] += 1
      const guard = i.guarded_by ? i.guarded_by.split(', ').map((t) => `\`${t}\``).join(', ') : '—'
      out.push(`| ${i.id} | ${cell(i.title)} | ${MARK[i.status]} | ${guard} |`)
    }
    out.push('')
  }

  const open = items.filter((x) => x.status !== 'shipped')
  if (open.length) {
    out.push('---', '', '## What each open item is missing', '')
    for (const i of open) {
      out.push(`### ${i.id} — ${i.title}`, '')
      out.push(`**${i.status}.** ${i.detail}`, '')
      if (i.evidence.length) {
        out.push('Evidence:', '')
        for (const e of i.evidence) out.push(`- \`${e}\``)
        out.push('')
      }
    }
  }

  out.push('---', '', '## Verification', '')
  out.push(
    'Every `path:line` above and every guard filename is resolved against the tree when',
    'this file is generated; a claim that cannot be checked is not written. What the',
    'current tree says:',
    '',
    `- **${items.length} items**, each with evidence and a status.`,
    `- **${brokenRefs.length} broken reference${brokenRefs.length === 1 ? '' : 's'}** among the ${items.reduce((n, i) => n + i.evidence.length, 0)} evidence paths and guard names.`,
    `- **${uncalled.length} module${uncalled.length === 1 ? '' : 's'} named here with no production caller.**`,
    `- **${unguarded.length} item${unguarded.length === 1 ? '' : 's'} naming no guard test.**`,
    '',
  )

  if (brokenRefs.length) {
    out.push('### Broken references', '')
    out.push('A path or guard name here does not resolve. Fix the ledger, not this file.', '')
    for (const b of brokenRefs) out.push(`- ${b}`)
    out.push('')
  }
  if (uncalled.length) {
    out.push('### Built, tested, called by nothing', '')
    out.push(
      'The module is in the tree and has tests, but nothing outside `test/` imports it.',
      'The status of the item it belongs to should say so — an exported function with no',
      'call site is not shipped.',
      '',
    )
    for (const u of uncalled) out.push(`- ${u}`)
    out.push('')
  }
  if (unguarded.length) {
    out.push('### Naming no guard test', '')
    for (const u of unguarded) out.push(`- ${u}`)
    out.push('')
  }

  const header = [
    '# Enhancement status',
    '',
    'What has actually shipped, verified against the tree rather than against the commit log.',
    'Regenerate with `node docs/improvements/_build-status.mjs` after editing any',
    '`_status-*.json`.',
    '',
    `**${counts.shipped} shipped, ${counts.partial} partial, ${counts['not started']} not started,** of ${items.length}.`,
    '',
    'A status is **partial** when some of the described change is in the tree and the rest is',
    'not, and the detail says which is which. An exported function with no call site is not',
    'shipped.',
    '',
    '---',
    '',
  ]
  const markdown = `${header.join('\n')}${out.join('\n')}\n`
  if (write) fs.writeFileSync(path.join(root, 'docs/improvements/status.md'), markdown)
  return { markdown, counts, brokenRefs, uncalled, unguarded, items }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { counts, brokenRefs } = buildStatus()
  console.log(counts)
  if (brokenRefs.length) {
    console.error(`\n${brokenRefs.length} broken reference(s):`)
    for (const b of brokenRefs) console.error(`  ${b}`)
    // A ledger naming a file that does not exist is worse than a ledger with no
    // guard column: it reads as verified. Fail so the drift is fixed, not shipped.
    process.exitCode = 1
  }
}
