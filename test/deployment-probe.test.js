import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { collectionsForRequest } from '../src/route-manifests.js'
import { isPublicPath } from '../src/auth.js'

/**
 * R-33 — the deployment probe must not be the load generator.
 *
 * `Dockerfile`'s `HEALTHCHECK` and the `app` healthcheck in `docker-compose.yml`
 * both curled `/api/v1/health` every 30 seconds, and `/api/v1/health` reads the
 * store to report `counts` and the pipeline verdict. `collectionsForRequest`
 * returns `null` for it — a whole-store read — because `counts()` needs 38 of
 * the 65 collections, which on the demo store is 97.8% of the bytes and on
 * Postgres is tens of megabytes of row bodies.
 *
 * So the most-polled request in the deployment, one that no person ever reads
 * the answer to, materialised nearly the whole store on a fixed 30-second clock,
 * forever. `/api/v1/ready` was written for exactly this caller: one scoped read
 * of the two collections its rollups need, behind a 2000 ms timeout, answering
 * `503` — not `500` — when the store cannot be read.
 *
 * These assertions read the deployment files as text and judge the route each
 * `curl` asks for. They are deliberately about the *path*, not about the file:
 * a future probe added to either file is judged by the same rule.
 */

const ROOT = new URL('..', import.meta.url)
const DOCKERFILE = readFileSync(new URL('Dockerfile', ROOT), 'utf8')
const COMPOSE = readFileSync(new URL('docker-compose.yml', ROOT), 'utf8')

/** Every `/api/v1/…` path a `curl` in the given text asks for. */
function probedPaths(text) {
  return [...text.matchAll(/curl\s+[^\n]*?(\/api\/v1\/[\w./-]*)/g)].map((match) => match[1])
}

describe('R-33 — the deployment probe reads a route, not the whole store', () => {
  it('finds the probe paths it is about to judge', () => {
    // A scan that finds nothing passes every assertion below for the wrong
    // reason. The first draft of the RSC gate did exactly this.
    assert.ok(probedPaths(DOCKERFILE).length >= 1,
      'no `curl … /api/v1/…` found in Dockerfile; the scan is blind')
    assert.ok(probedPaths(COMPOSE).length >= 1,
      'no `curl … /api/v1/…` found in docker-compose.yml; the scan is blind')
  })

  it('does not point any probe at a route that materialises the whole store', () => {
    for (const [file, text] of [['Dockerfile', DOCKERFILE], ['docker-compose.yml', COMPOSE]]) {
      for (const path of probedPaths(text)) {
        assert.notEqual(collectionsForRequest('GET', path), null,
          `${file} probes ${path}, which reads every collection on a fixed clock`)
      }
    }
  })

  it('points the container healthcheck at the readiness route', () => {
    // The specific route, not merely "some scoped one": readiness is the
    // endpoint whose whole purpose is to be polled and to fail closed when the
    // store is unreachable.
    const probed = probedPaths(DOCKERFILE)
    assert.ok(probed.includes('/api/v1/ready'),
      `Dockerfile HEALTHCHECK must probe /api/v1/ready; it probes ${probed.join(', ') || 'nothing'}`)
    const composeProbed = probedPaths(COMPOSE)
    assert.ok(composeProbed.includes('/api/v1/ready'),
      `the compose app healthcheck must probe /api/v1/ready; it probes ${composeProbed.join(', ') || 'nothing'}`)
  })

  it('probes only routes reachable without a token', () => {
    // A probe that 401s is a probe that reports every instance unhealthy the
    // moment auth is turned on.
    for (const path of [...probedPaths(DOCKERFILE), ...probedPaths(COMPOSE)]) {
      assert.ok(isPublicPath(path, {}),
        `${path} is probed by the container but is not public; the probe would 401`)
    }
  })

  it('still answers when the store cannot be read — which is why it is not /health', () => {
    // The property that makes `/health` unusable as this probe, asserted rather
    // than left in a comment: `/health` needs the store, so it cannot answer the
    // question "is the process up" when the store is the thing that is down.
    assert.equal(collectionsForRequest('GET', '/api/v1/health'), null,
      '/health no longer reads the whole store — this test, and the reason the probe avoids it, are both stale')
    assert.notEqual(collectionsForRequest('GET', '/api/v1/ready'), null,
      '/ready must stay a scoped read; a whole-store readiness probe is the defect it replaced')
  })
})
