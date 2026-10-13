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

import { spawnSync } from 'node:child_process'
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
 * Archived third-party documents, excluded for the same reason and one more.
 *
 * `docs/research/<slug>/sources/` holds verbatim copies of external documents
 * this repository cites, required by the sources rule so a citation does not
 * rest on a URL that rots. Their relative links point into the *originating*
 * tree — a model card's `assets/banner.svg` lives on HuggingFace, not here — and
 * rewriting them to satisfy this check would falsify the archive, which is worse
 * than the dangling link. The distinction is the one `docs/old-readme.md`
 * already draws: this check governs the repository's own prose, not documents it
 * preserves.
 *
 * Scoped to the `sources/` directory rather than all of `docs/research/`. A
 * research README is this repository's own writing and its links must resolve;
 * only the copies it archives are exempt. An exclusion as wide as
 * `docs/research/**` would silently stop checking every research note written
 * from here on, which is how an exclusion becomes a blind spot.
 */
const isArchivedSource = (relative) => /^docs\/research\/[^/]+\/sources\//.test(relative)

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

/**
 * Is this path excluded from the repository by `.gitignore`?
 *
 * Asked of git rather than reimplemented: a hand-rolled matcher is a second
 * copy of `.gitignore`'s rules and drifts from it. When git is unavailable the
 * answer is "no", because a check that cannot run must not invent failures.
 */
function isIgnored(absolute) {
	const r = spawnSync('git', ['check-ignore', '-q', absolute], { cwd: root })
	return r.status === 0
}

for (const rootEntry of ROOTS) {
	for (const relative of documentsIn(rootEntry)) {
		if (EXCLUDED.has(relative)) continue
		if (isArchivedSource(relative)) continue
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
			} else if (isIgnored(resolved)) {
				// It exists on this workstation and nowhere else. `docs/vision.md`
				// linked four times to an internal tender document that
				// `.gitignore` deliberately keeps out of the repository: every
				// local run passed, and CI failed on a clean checkout, because
				// this check asked the filesystem instead of the repository. A
				// link to a file the repository does not contain is broken for
				// every reader, so it is broken here too.
				broken.push(`${relative} → ${raw} (exists locally but is not in the repository)`)
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