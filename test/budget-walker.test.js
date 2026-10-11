#!/usr/bin/env node
/**
 * ENH-33 — the first-load walker follows both spellings of an import.
 *
 * `scripts/check-budget.mjs` measured the console's first load by walking the
 * module graph from `index.html`. It matched `from '/shared/x.js'` and not
 * `from './x.js'` — and the relative form is how *every* module inside
 * `public/shared/` names its neighbour. So the walk stopped at the first
 * relative hop and the total was an under-count that read as a measurement:
 * `runtime.js` → `./fmt.js`, `map-frame.js` → `./basemap.js`, `secret.js` →
 * `./native.js` and three more were never in it.
 *
 * The consequence was not a cosmetic error. The tree has been 9.0 KB over the
 * 216 KB ceiling since before ENH-33, and the gate reported 210.7 KB with 5.3 KB
 * of headroom throughout — so the debt the ceiling's own comment was written to
 * collect had already been spent, invisibly. This is the same failure as the
 * internal-link checker that matched `href="/…"` only, and it is why the fix is
 * asserted rather than trusted: a walker that misses one spelling of a
 * reference loses coverage without failing.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts', 'check-budget.mjs')

/**
 * Run the gate and return its stdout, whether it exited 0 or 1.
 *
 * The planted canary puts the tree over budget on purpose, so the gate exits
 * non-zero and `execFileSync` throws — with the output we need on the error.
 * Reading only the success path made the canary fail for the wrong reason.
 */
function gateOutput() {
  try {
    return execFileSync(process.execPath, [GATE], { encoding: 'utf8' })
  } catch (error) {
    if (typeof error.stdout === 'string') return error.stdout
    throw error
  }
}

/** The asset list the gate prints, as filenames. */
function measuredAssets() {
  return gateOutput().split('\n')
    .map((line) => line.match(/^\s{2}(\S+\.(?:js|css|json))\s/))
    .filter(Boolean)
    .map((match) => match[1])
}

describe('ENH-33 — the first-load walker follows relative imports', () => {
  it('includes modules reached only through a relative specifier', () => {
    // Each of these is imported by a module already in the graph, with a `./`
    // specifier. Under the old walker none of them appeared, and the total was
    // 14.3 KB low because of it.
    const assets = measuredAssets()
    for (const rel of [
      'shared/org-units.js', // basemap.js → ./org-units.js  (ENH-33)
      'shared/fmt.js', // runtime.js → ./fmt.js
      'shared/native.js', // secret.js → ./native.js
      'shared/queue-core.js', // runtime.js → ./queue-core.js
      'shared/submission-id.js', // runtime.js → ./submission-id.js
    ]) {
      assert.ok(assets.includes(rel), `${rel} is on the first-load path but the walker did not see it`)
    }
  })

  it('measures a planted relative-only dependency', () => {
    // The canary. A file reached only by a relative import must change the
    // total; if it does not, the walker is blind to that spelling again and
    // every reading it produces is fiction.
    const dep = path.join(ROOT, 'public', 'shared', '__budget_canary.js')
    const importer = path.join(ROOT, 'public', 'shared', 'basemap.js')
    const before = fs.readFileSync(importer, 'utf8')
    const target = "import { ORG_UNITS } from './org-units.js'"
    assert.ok(before.includes(target), 'canary target not found — the patch would be a no-op')
    // Incompressible body, so the gzipped delta is unambiguous.
    let seed = 1
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    const body = Array.from({ length: 400 }, (_, i) => `export const K${i} = "${rand().toString(36)}${rand().toString(36)}"`).join('\n')
    const rawOf = () => {
      const m = gateOutput().match(/\((\d[\d.]+) KB raw\)/)
      return m ? Number(m[1]) : null
    }
    const baseline = rawOf()
    try {
      fs.writeFileSync(dep, `${body}\n`)
      fs.writeFileSync(importer, before.replace(target, `${target}\nimport './__budget_canary.js'`))
      const withDep = rawOf()
      assert.ok(withDep > baseline, `a relative-only dependency did not move the total (${baseline} -> ${withDep})`)
    } finally {
      fs.writeFileSync(importer, before)
      fs.rmSync(dep, { force: true })
    }
    assert.equal(rawOf(), baseline, 'the tree was not restored')
  })
})
