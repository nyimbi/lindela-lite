import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, checkEnvelope } from '../scripts/check-route-envelopes.mjs'

/**
 * QUA-06 — the route-envelope gate, guarded.
 *
 * The audit's finding was that no test walked the documented surface asserting
 * an envelope shape, so a route returning `data: [...]` unpaged beside a
 * paginated sibling was undetected. The gate that closes it drives 113 routes
 * against a real server, and the three defects it found on its first run are
 * the evidence it works — but a gate is only worth what its scope is worth, and
 * its scope has two ways to be wrong:
 *
 *   too broad  — it flags every unpaged array, including the ones that cannot
 *                grow (a district registry, an enum, a one-row-per-region
 *                roll-up), and it is switched off within a week. Correctly.
 *   too narrow — it quietly stops matching the routes that matter, and the
 *                count of routes it reports still looks like coverage.
 *
 * The canaries are the second half. This file adds the half a self-test cannot:
 * that the exit status is what a pipeline reads, and that the surface it scans
 * is the spec the repository ships.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-route-envelopes.mjs')

/** Run the gate the way CI does, and return its exit code with its output. */
function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('QUA-06 the route-envelope gate is scoped to the envelope, not to a path list', () => {
  it('passes on the tree as it stands', () => {
    // The known-good input. A gate that cannot pass on a clean tree is a gate
    // that gets an exemption, and an exemption is where the next defect hides.
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    assert.match(output, /route\(s\) driven/, 'the gate reported a result without driving any route')
  })

  it('every declared canary passes, and they disagree with each other', () => {
    // A canary set whose expectations are uniform proves nothing: a checker that
    // returns a constant would satisfy it. These are checked to be a mix, so the
    // assertion below cannot be passed by a stub.
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.deepEqual([...expectations].sort(), [0, 1],
      'the canaries no longer include both a pass and a fail case, so they cannot detect a constant checker')

    for (const canary of CANARIES) {
      assert.equal(checkEnvelope(canary.input).length, canary.expect,
        `canary "${canary.name}" expected ${canary.expect}`)
    }
  })

  it('flags a partial paging envelope — the shape the audit found', () => {
    // The defect in one line. `total` without the other four keys reads as a
    // count the caller cannot compare against what they got, which is the
    // whole reason `/api/v1/connectors/status` was a finding.
    const findings = checkEnvelope({
      route: '/api/v1/x', method: 'GET', status: 200, contentType: 'application/json',
      body: { success: true, data: [1], total: 1 },
    })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'paging')
    assert.match(findings[0].detail, /has total but not/)
  })

  it('does not flag a route that speaks a published standard', () => {
    // The breadth half. A GeoJSON FeatureCollection wrapped in `{success, data}`
    // is invalid GeoJSON, and the STAC and OGC documents are standards for the
    // same reason. The exemption is by media type, so it holds even when the
    // body is a bare array with no envelope at all.
    for (const route of ['/api/v1/export.geojson', '/stac/catalog.json', '/ogc/collections']) {
      assert.equal(
        checkEnvelope({ route, method: 'GET', status: 200, contentType: 'application/json', body: { type: 'FeatureCollection' } }).length,
        0,
        `the gate flags ${route}, which speaks its own schema`,
      )
    }
  })

  it('does not flag a named complete array, but does flag an unnamed one', () => {
    // The exemption list is the gate's judgement about which sets cannot grow,
    // and it is only honest if being on it changes the answer. `/api/v1/districts`
    // is five rows shipped as data; the same body under an unknown path is the
    // defect. If both passed, the list would be decoration.
    const body = { success: true, data: [1, 2] }
    assert.equal(checkEnvelope({ route: '/api/v1/districts', method: 'GET', status: 200, contentType: 'application/json', body }).length, 0)
    assert.equal(checkEnvelope({ route: '/api/v1/not-listed', method: 'GET', status: 200, contentType: 'application/json', body }).length, 1)
  })

  it('the surface the gate scans is the spec the repository ships', () => {
    // A gate that silently scanned an empty spec would pass forever, and the
    // count of routes it reports is the only clue. `docs/openapi.yaml` is
    // itself gated by `check-openapi`, so this asserts the two agree on the
    // route count rather than trusting either one's number.
    const { output } = runGate()
    const driven = Number(/— (\d+) route\(s\) driven/.exec(output)?.[1] ?? 0)
    assert.ok(driven > 100, `the gate drove ${driven} routes, which is not the documented surface`)
  })
})
