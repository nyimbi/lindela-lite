#!/usr/bin/env node
/**
 * Documentation links are checked, not assumed.
 *
 * `scripts/validate.mjs` tests a hand-written list of required sections in
 * eight named documents. It never followed a link. So the ADRs table in
 * `docs/architecture/decisions/README.md` could list twelve records while six
 * of the files did not exist, and `validate.mjs` exited 0 — which it did, on
 * 2026-10-03, for a table whose missing rows were the six decisions a new
 * contributor most wants to read.
 *
 * A dangling link in documentation is not cosmetic. It asserts that a thing
 * exists, it is the first thing a reader follows, and unlike a broken build it
 * fails silently: the document still renders, still reads well, and still
 * lies.
 *
 * What is checked: relative markdown links to a path, with the anchor and any
 * `?query` stripped, resolved against the containing file. External URLs,
 * bare fragments and mailto: are ignored — this is a filesystem question, not
 * a network one, and a checker that needs the network is a checker that gets
 * skipped.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Documentation an agent is likely to be sent to by a link. */
const ROOTS = ['README.md', 'CHANGELOG.md', 'llms.txt', 'docs']

/**
 * Files walked but not link-checked. `docs/old-readme.md` is an archival
 * snapshot of the pre-rewrite README: its relative links describe the tree as
 * it stood when it was archived, and "fixing" them would rewrite history to
 * look like the current docs. Nothing links to it as a source of truth.
 */
const EXCLUDED = new Set(['docs/old-readme.md'])

/**
 * Markdown link and bare reference. Skips fenced code, where a bracket is a
 * character rather than a link — a doc about CSV or JSON is full of them, and
 * a checker that trips over an example is a checker people disable.
 */
function stripFences(text) {
	return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

function documentsIn(relative) {
	const target = path.join(root, relative)
	if (!fs.existsSync(target)) return []
	if (fs.statSync(target).isFile()) return [relative]
	if (!relative.startsWith('docs')) return []
	const found = []
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const child = path.join(dir, entry.name)
			if (entry.isDirectory()) walk(child)
			else if (entry.name.endsWith('.md')) found.push(path.relative(root, child))
		}
	}
	walk(target)
	return found
}

const broken = []
let checked = 0

for (const rootEntry of ROOTS) {
	for (const relative of documentsIn(rootEntry)) {
		if (EXCLUDED.has(relative)) continue
		const file = path.join(root, relative)
		const text = stripFences(fs.readFileSync(file, 'utf8'))
		const links = [
			...text.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g),
			...text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm),
		]
		for (const [, raw] of links) {
			if (/^[a-z]+:/i.test(raw)) continue
			if (raw.startsWith('#')) continue
			// The fragment and the query are addressing *within* a file. Whether
			// the anchor exists is a different question and a much noisier one;
			// this check answers the one that silently loses a file.
			const target = raw.split('#')[0].split('?')[0]
			if (!target) continue
			checked += 1
			const resolved = path.resolve(path.dirname(file), target)
			if (!fs.existsSync(resolved)) {
				broken.push(`${relative} → ${raw}`)
			}
		}
	}
}

if (broken.length) {
	console.error(`${broken.length} documentation link(s) point at something that does not exist:`)
	for (const entry of broken) console.error(`  ${entry}`)
	console.error('\nA link that resolves to nothing is a claim that something exists. It renders,')
	console.error('it reads well, and it lies — which is why nothing notices until a reader follows it.')
	process.exit(1)
}

console.log(`doc links ok — ${checked} relative link(s) resolve`)