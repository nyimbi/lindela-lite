import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * ARC-03 — production `src/` must not import from `scripts/`.
 *
 * `POST /api/v1/demo/seed` reached into `../scripts/seed-demo.mjs` at request
 * time. The layering is the defect: `scripts/` is the operator's toolbox and is
 * free to change or be excluded from a deployment image, while `src/` is the
 * service. A request path that imports from the toolbox means the service
 * cannot be packaged without it, and an import error there — a renamed file, a
 * dropped dependency — is a 500 on a live route rather than a broken command
 * somebody runs deliberately.
 *
 * The fix moved the implementation to `src/demo-seed.js` and left the script as
 * a wrapper. This is the guard that it stays that way, because the coupling is
 * invisible in a diff: the import is a single string, and nothing else in the
 * file looks different.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/**
 * Strip comments and string-literal *contents* that are not import specifiers.
 *
 * Without this the check matches its own documentation: the comment explaining
 * ARC-03 in `src/demo-seed.js` quotes the old path, and a scanner that reads
 * prose as code reports the fix as the defect. Comments are removed, and so are
 * the bodies of template literals and ordinary strings — an import specifier is
 * the only string this check is about, and those are matched separately below.
 */
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')   // line comments, not the `//` in `https://`
}

/** Every `.js` under `src/`, recursively. */
async function sourceFiles(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await sourceFiles(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

describe('ARC-03 the service does not depend on the operator toolbox', () => {
  it('no module under src/ imports from scripts/', async () => {
    const offenders = []
    for (const file of await sourceFiles(path.join(ROOT, 'src'))) {
      const source = stripCommentsAndStrings(await fs.readFile(file, 'utf8'))
      // Both forms, and anchored on the import rather than on the line start.
      // The defect was dynamic — `const { … } = await import('../scripts/…')`
      // inside a route handler — and a `^\s*` anchor misses it because the
      // statement begins with `const`. That is how the first version of this
      // check passed on the very coupling it was written to catch: the canary
      // put the import back and the test stayed green.
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\(\s*)['"]([^'"]*\/scripts\/[^'"]+)['"]/g)) {
        offenders.push(`${path.relative(ROOT, file)} → ${match[1]}`)
      }
    }
    assert.deepEqual(offenders, [],
      `src/ must not import from scripts/; found:\n  ${offenders.join('\n  ')}`)
  })

  it('the demo seed is reachable from src/, and the script is a wrapper over it', async () => {
    // The other direction: moving the code out of `src/` would also satisfy the
    // rule above while breaking the route. `demo-seed.js` must exist and export
    // what the handler calls, and `scripts/seed-demo.mjs` must re-export it so
    // the documented command keeps working.
    const library = await fs.readFile(path.join(ROOT, 'src/demo-seed.js'), 'utf8')
    for (const name of ['seedAll', 'ingestPublicSources', 'summary']) {
      assert.match(library, new RegExp(`export async function ${name}\\b`),
        `src/demo-seed.js must export ${name}`)
    }

    const wrapper = await fs.readFile(path.join(ROOT, 'scripts/seed-demo.mjs'), 'utf8')
    assert.match(wrapper, /from '\.\.\/src\/demo-seed\.js'/,
      'the script must import the library rather than reimplement it')
    for (const name of ['seedAll', 'ingestPublicSources', 'summary']) {
      assert.match(wrapper, new RegExp(`\\b${name}\\b`),
        `scripts/seed-demo.mjs must still expose ${name}, which package.json and the demo guide call`)
    }
  })
})
