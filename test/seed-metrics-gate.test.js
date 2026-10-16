import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = 'scripts/check-seed-metrics.mjs'

/**
 * `run-gates.mjs` spawns each gate bare, so a gate's `--self-test` canaries are
 * dead unless something drives them. This is that driver, and it asserts both
 * directions: the canaries pass, and the gate itself is clean on the tree.
 *
 * The second assertion is the one with content. A gate that exits 0 on a tree
 * with an undeclared dead metric name is a gate whose green means nothing, and
 * the first version of any such check is the version that has never been
 * watched fail — so the exit code is asserted, not merely observed.
 */
describe('check-seed-metrics', () => {
	it('passes its own canaries', async () => {
		const { stdout } = await run('node', [GATE, '--self-test'], { cwd: ROOT })
		assert.match(stdout, /all canaries passed/)
		// A self-test whose expectations are uniform is satisfied by a constant
		// checker; the gate refuses that, and this asserts it refused.
		assert.doesNotMatch(stdout, /expectations are uniform/)
	})

	it('is clean on the tree as it stands', async () => {
		const { stdout } = await run('node', [GATE], { cwd: ROOT })
		assert.match(stdout, /seed metrics: clean/)
		assert.match(stdout, /are declared dead in DEAD_SEED_METRICS/)
	})

	it('reports the dead set it measured, so a reader can see the size', async () => {
		const { stdout } = await run('node', [GATE], { cwd: ROOT })
		// The measurement is the finding. If the seed's vocabulary is ever
		// revived, this line changes and the assertion below fails on purpose —
		// the register's figure then has to be re-measured rather than assumed.
		assert.match(stdout, /28 metric-bearing row\(s\) across 4 collection\(s\)/)
		assert.match(stdout, /0 metric name\(s\) resolve; 5 are declared dead/)
	})
})
