import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Every guide at the top of `docs/` is reachable from `docs/README.md`.
 *
 * `docs/README.md` is the entry point for the documentation set — a reader who
 * lands in `docs/` reads it and believes they have seen what is there. It is
 * hand-maintained while the set it describes is not, which is the drift class
 * this repository keeps re-finding: the index listed twenty-one guides while
 * thirty-one existed, and nothing failed, because an index that omits a page
 * renders perfectly.
 *
 * `scripts/validate.mjs` carries a hand-typed `requiredLink` list for the same
 * index, so the two can disagree — that list is a floor, not the set. This test
 * measures the set: the tracked files under `docs/` that are not in a
 * subdirectory (a subdirectory with its own `README.md` owns its own index).
 *
 * Scope is deliberate. Only top-level `docs/*.md` is asserted: `docs/plans/`,
 * `docs/research/`, `docs/security/` and `docs/ux-improvements/` have no index
 * of their own and are reached from the top-level guides that cite them, so a
 * blanket "every tracked doc must be indexed" rule would fail for reasons an
 * author editing a research note cannot act on — and a gate that fails that way
 * teaches people to bypass it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Tracked docs directly under `docs/`, as paths relative to `docs/`.
 *
 * Read from git, not the filesystem: a guide that exists locally but is
 * gitignored (`docs/demo-playbook.md`, `docs/u*-requirements-traceability.md`)
 * is not a page a reader of the repository has, and linking it would be the
 * opposite error — a link that resolves locally and lies to everyone else.
 */
function trackedTopLevelDocs() {
  const out = execFileSync('git', ['ls-files', 'docs/'], { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter((p) => /^docs\/[^/]+\.md$/.test(p))
    .map((p) => p.slice('docs/'.length))
    .filter((name) => name !== 'README.md')
}

/**
 * Docs that are deliberately not indexed, each with the reason.
 *
 * `old-readme.md` is an archival snapshot of the pre-rewrite README, kept for
 * history; `scripts/check-doc-links.mjs` already excludes it by name for the
 * same reason. Indexing it would present an obsolete document as current.
 */
const EXEMPT = new Map([
  ['old-readme.md', 'archival snapshot of the pre-rewrite README, kept for history'],
])

describe('the docs index', () => {
  it('links every top-level guide, or exempts it in writing', () => {
    const index = readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8')
    const docs = trackedTopLevelDocs()

    // Canary for the walk: if the git invocation or the filter stops matching,
    // `docs` is empty and the loop below asserts nothing.
    assert.ok(docs.length > 20,
      `found only ${docs.length} top-level docs under docs/ — the git walk or the filter is wrong, not the tree`)

    const missing = []
    for (const name of docs) {
      if (EXEMPT.has(name)) continue
      // Match the link target however it is spelled: `](name.md)` or `](name.md#anchor)`.
      const linked = new RegExp(`\\]\\(${name.replace(/\./g, '\\.')}(#[^)]*)?\\)`).test(index)
      if (!linked) missing.push(name)
    }

    assert.deepEqual(missing, [],
      `docs/README.md does not link: ${missing.join(', ')} — add a line for each, ` +
      `or add it to EXEMPT in this test with the reason it is deliberately unindexed`)

    // An exemption for a file that no longer exists is dead weight, and it hides
    // the next real omission behind a stale allowance.
    for (const name of EXEMPT.keys()) {
      assert.ok(docs.includes(name),
        `EXEMPT names ${name}, which is not a tracked top-level doc — remove the exemption`)
    }
  })

  it('links only docs that are in the repository', () => {
    // The other direction. A link to a gitignored file resolves on the author's
    // machine and 404s for every reader — which is how `unicef-requirements-
    // traceability.md` and `demo-playbook.md` nearly entered this index.
    const index = readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8')
    const tracked = new Set(trackedTopLevelDocs())
    const subdirs = new Set(
      execFileSync('git', ['ls-files', 'docs/'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean).map((p) => p.slice('docs/'.length)),
    )
    const offenders = []
    for (const m of index.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)) {
      const target = m[1]
      if (target.includes('/')) continue // a subdirectory link; the doc-links gate walks those
      if (target === 'README.md') continue
      if (!tracked.has(target) && !subdirs.has(target)) offenders.push(target)
    }
    assert.deepEqual(offenders, [],
      `docs/README.md links ${offenders.join(', ')}, which ${offenders.length === 1 ? 'is' : 'are'} not in the repository`)
  })
})
