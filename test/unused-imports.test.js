#!/usr/bin/env node
/**
 * An import nobody calls is a claim about a dependency that is not true.
 *
 * Ten of them were here, spread over five files, all of the same shape:
 * `calibrationReport` imported and never called, `pendingForFocalPoint`
 * imported and never called, `WORKFLOW_TYPES`/`WORKFLOW_STATES`/
 * `WORKFLOW_TRANSITIONS`/`resolveDistrict` imported into `server.js` and never
 * read, `stableId` imported into `equity.js` and never called, `toNumber`
 * imported into two files that never call it, `computeEnsembleStats` imported
 * into `analytics.js` and never called.
 *
 * They are cheap and they are not harmless. An import is the only place a
 * reader learns that a module depends on another, so ten of them make the real
 * dependency graph of `server.js` — the file with the most of them — wrong in
 * the reader's head. And an unused import is a linter's job, not a test's;
 * this repository has no linter. So without this file they come straight back
 * the next time a function is renamed on one side of an import line.
 *
 * What it does not do is judge dead code. `computeEnsembleStats` may be the
 * right home for a summary statistic nobody has needed yet, and this test says
 * nothing about that. It checks one thing: if the name is bound, it is used.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Shipped code. `test/` is excluded because a test may bind a name purely to assert its absence. */
const SCANNED = ['src', 'scripts']

function jsFiles(dir) {
	const out = []
	for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
		const rel = path.posix.join(dir, entry.name)
		if (entry.isDirectory()) out.push(...jsFiles(rel))
		else if (entry.name.endsWith('.js')) out.push(rel)
	}
	return out
}

/**
 * Named bindings introduced by `import ... from`, matched across newlines
 * because the project wraps long import lists. A re-export (`export { x } from`)
 * is not an import and is left alone — it is a deliberate second door.
 */
const NAMED_IMPORT = /^[ \t]*import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gm

/** The file with every import statement removed, which is where a use must appear. */
function bodyWithoutImports(source) {
	return source.replace(/^[ \t]*import\s[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
}

/** How many times a name appears as a whole word in the file's non-import text. */
const usesOf = (text, name) => {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return (text.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length
}

/** Every named import in the tree that its own file never mentions again. */
function unusedNamedImports() {
	const dead = []
	for (const dir of SCANNED) {
		for (const file of jsFiles(dir)) {
			const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
			const body = bodyWithoutImports(source)
			for (const [, clause] of source.matchAll(NAMED_IMPORT)) {
				for (const raw of clause.split(',')) {
					const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim()
					if (!name) continue
					if (usesOf(body, name) === 0) dead.push(`${file}: ${name}`)
				}
			}
		}
	}
	return dead
}

describe('every import in shipped code is used', () => {
	it('binds no name it never calls', () => {
		const dead = unusedNamedImports()
		assert.deepEqual(dead, [], `imported and never used:\n  ${dead.join('\n  ')}`)
	})

	it('actually reads the tree, rather than passing on an empty scan', () => {
		// A scanner that matched nothing reports a clean bill of health, which is
		// the same failure as the responsive gate that measured zero controls and
		// passed. The regex has to find real imports in real files.
		const source = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8')
		const bound = [...source.matchAll(NAMED_IMPORT)]
			.flatMap(([, clause]) => clause.split(',').map((n) => n.trim().split(/\s+as\s+/).pop()))
			.filter(Boolean)
		assert.ok(bound.length > 40, `expected server.js to bind dozens of names, found ${bound.length}`)
		assert.ok(bound.includes('refreshAnalytics'), 'and one of them is a real dependency it names in prose above')
	})

	it('finds the files it claims to scan', () => {
		// If SCANNED were mistyped the test above would pass on an empty tree.
		const files = SCANNED.flatMap(jsFiles)
		assert.ok(files.length > 20, `expected a real tree, found ${files.length} files`)
		assert.ok(files.includes('src/server.js'))
		assert.ok(files.includes('src/analytics.js'))
	})

	it('ignores a re-export, which is a second door and not a dead import', () => {
		// `export { x } from './y.js'` binds nothing locally. Treating it as an
		// import would report every re-export in the project as dead.
		const source = "export { clamp, stableId } from './utils.js'\nconst a = 1\n"
		assert.equal(NAMED_IMPORT.test(source), false, 'the import regex does not match it')
		NAMED_IMPORT.lastIndex = 0
		assert.equal(usesOf(bodyWithoutImports(source), 'clamp'), 1,
			'and it survives the strip, so even a body scan would not call it dead')
	})

	it('does not mistake an aliased import for an unused original', () => {
		const source = [
			"import { computeEnsembleStats as stats } from './ensemble.js'",
			'const out = stats(x)',
		].join('\n')
		const bound = [...source.matchAll(NAMED_IMPORT)][0][1].split(',')[0].trim().split(/\s+as\s+/).pop()
		assert.equal(bound, 'stats')
		assert.equal(usesOf(bodyWithoutImports(source), bound), 1)
	})
})
