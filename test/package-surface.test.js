import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import * as entry from '../src/index.js'

/**
 * ARC-12 — `package.json`'s `main` is a public API surface, and nothing checked it.
 *
 * `src/index.js` is what `import '@lindela/lite'` resolves to, and no file in
 * the repository imported it. That is not automatically wrong — an entry point
 * is for consumers outside the repo — but an entry point that nothing imports
 * and nothing tests is a surface that can break without anyone noticing, and
 * this one had: it re-exported `normalizeReportTemplate` and friends by name,
 * so renaming any of them was a breaking change to a published API that no
 * test would catch.
 *
 * The two properties worth asserting are the ones a consumer depends on: the
 * module loads at all, and every name it exports resolves to a real value.
 * A named export whose source module stopped exporting it is a *load-time*
 * failure in ESM, which means the package is unusable rather than degraded —
 * worth a test precisely because nothing else in the suite would run it.
 */
describe('ARC-12 — the package entry point is a surface, and it loads', () => {
  it('exports a non-empty set of values, not only types', () => {
    const names = Object.keys(entry)
    assert.ok(names.length > 0, 'src/index.js exported nothing')
    // A `export { x } from` whose module dropped `x` throws at import time, so
    // reaching this line already proves every name resolved. What is left to
    // check is that they are values a caller can use.
    const undefinedExports = names.filter((name) => entry[name] === undefined)
    assert.deepEqual(undefinedExports, [],
      'these names resolve to undefined, which a consumer cannot call')
  })

  it('exposes the two store adapters a consumer chooses between', () => {
    // The package's central promise: one contract, two backends. A consumer
    // importing the package has to be able to name both, and the conformance
    // suite is the guarantee that they behave alike.
    assert.equal(typeof entry.JsonStore, 'function')
    assert.equal(typeof entry.PostgresStore, 'function')
    assert.equal(typeof entry.createStoreFromEnv, 'function')
  })

  it('exposes ingestion and analytics, the two things an embedding app drives', () => {
    assert.equal(typeof entry.runIngestion, 'function')
    assert.equal(typeof entry.refreshAnalytics, 'function')
    assert.equal(typeof entry.computeFloodRisk, 'function')
  })

  it('is the module `main` names, so the declaration and the file agree', () => {
    // `main` pointing at a file that does not exist, or at a different file,
    // is the kind of drift a package-level test catches and nothing else does.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(pkg.main, 'src/index.js',
      'package.json main and the file this test imports have to be the same entry point')
  })
})
