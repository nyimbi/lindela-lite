import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
 */
export function callers(modulePath, root) {
  const stem = path.basename(modulePath, path.extname(modulePath))
  const pattern = `(from|import\\(|lazy\\(|require\\()\\s*['"][^'"]*${stem}(\\.js)?['"]`
  const r = spawnSync('rg', ['-l', '--glob', '!node_modules', '--glob', '!test/**', '-e', pattern, '.'],
    { encoding: 'utf8', cwd: root })
  if (r.status === 1) return []            // no matches is a real answer, not a failure
  if (r.status !== 0) throw new Error(`rg failed (${r.status}): ${r.stderr}`)
  return r.stdout.split('\n').filter(Boolean)
    .map((f) => f.replace(/^\.\//, ''))
    .filter((f) => f !== modulePath && !f.startsWith('test/'))
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
    for (const ref of i.evidence) {
      const file = ref.replace(/:\d+(-\d+)?$/, '')
      if (/^(src|public\/shared)\/[\w-]+\.js$/.test(file) && callers(file, root).length === 0) {
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
