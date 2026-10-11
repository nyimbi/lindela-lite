#!/usr/bin/env node
/**
 * ENH-78 — the outbound-fetch spec.
 *
 * VUL-01 was a CRITICAL SSRF on one path: `POST /api/v1/reports/:id/distribute`
 * fetched `channel.url` from the request body with no guard. The fix added a
 * guard at that one site. The *class* — a URL the server fetches whose origin is
 * the caller — is what keeps recurring, and a guard at one of N paths is the
 * 19-of-27-paths failure this repository keeps finding.
 *
 * Two halves, and neither is sufficient alone:
 *
 *   1. `scripts/check-outbound-fetch.mjs` is the regression spec over the class.
 *      It cannot know whether a URL is caller-supplied, so it asserts the thing
 *      that decides whether the SSRF tests could ever cover the next path: every
 *      `fetch(` in `src/` is either guarded, or marked with a reason. The
 *      canaries below are what keep it honest — including the ones that plant a
 *      defect in the real tree and require the gate to fail, because exit 0 from
 *      a gate nobody has watched fail is not evidence.
 *   2. `assertConnectorUrl` is the guard the connector sites name. Its
 *      jurisdiction is the point: it refuses the metadata ranges and *permits*
 *      RFC-1918, because a self-hosted DHIS2 instance or field gateway on the
 *      operator LAN is a normal deployment and a guard that refused it would be
 *      scoped wider than its jurisdiction.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { assertConnectorUrl, assertSafeOutboundUrl } from '../src/webhooks.js'
import { CANARIES, scanSource, scanTree } from '../scripts/check-outbound-fetch.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts', 'check-outbound-fetch.mjs')

const refuses = (fn, url) => {
  let error = null
  try { fn(url) } catch (thrown) { error = thrown }
  assert.ok(error, `${url} was not refused`)
  assert.equal(error.statusCode, 400, `${url} was refused without a 400`)
  return error.message
}

const accepts = (fn, url) => {
  assert.doesNotThrow(() => fn(url), `${url} was refused but should be permitted`)
}

describe('ENH-78 — assertConnectorUrl refuses only what no connector instance can be', () => {
  it('refuses the cloud metadata addresses, which are the privilege jump', () => {
    // `request.base_url` is caller-supplied. Left unguarded, an operator who can
    // configure a connector reads the host's own IAM credentials.
    assert.match(refuses(assertConnectorUrl, 'http://169.254.169.254/latest/meta-data/'), /link-local/)
    assert.match(refuses(assertConnectorUrl, 'http://100.100.100.200/latest/meta-data/'), /Alibaba/)
    assert.match(refuses(assertConnectorUrl, 'http://metadata.google.internal/computeMetadata/v1/'), /metadata/)
  })

  it('permits RFC-1918, loopback and unique-local — the whole point of the split', () => {
    // This is what separates it from `assertSafeOutboundUrl`, which refuses all
    // of these. A DHIS2 instance or IoT gateway is routinely self-hosted here,
    // and refusing them would break real deployments and teach operators to
    // disable the check.
    for (const url of [
      'http://10.1.2.3:8080/api/dataValueSets',
      'http://192.168.1.10/gateway/readings',
      'http://172.16.0.5/kobo',
      'http://127.0.0.1:8080/api',
      'http://[fd00::1]:8080/api',
      'https://dhis2.health.go.ke/api',
    ]) accepts(assertConnectorUrl, url)
  })

  it('is strictly narrower than the webhook guard — the difference asserted, not assumed', () => {
    // If this ever stops holding, the two guards have collapsed into one and the
    // connector exception was a fiction.
    const lan = 'http://192.168.1.10/gateway'
    accepts(assertConnectorUrl, lan)
    assert.match(refuses(assertSafeOutboundUrl, lan), /non-public/)
  })

  it('still refuses a URL that is not http(s), or that embeds credentials', () => {
    assert.match(refuses(assertConnectorUrl, 'file:///etc/passwd'), /http or https/)
    assert.match(refuses(assertConnectorUrl, 'http://user:pass@10.0.0.1/'), /credentials/)
  })

  it('treats 0.0.0.0 and the whole /8 as never a destination', () => {
    assert.match(refuses(assertConnectorUrl, 'http://0.0.0.0:8080/'), /never a destination/)
    assert.match(refuses(assertConnectorUrl, 'http://0.1.2.3/'), /never a destination/)
  })

  it('does not refuse a hostname whose DNS it does not consult', () => {
    // A hostname is not an address. Resolving here would add a way for a
    // connector run to hang on a path that already has a timeout, and the
    // rebinding case matters far less for an `admin:schedules` caller than for
    // an unauthenticated webhook subscriber.
    accepts(assertConnectorUrl, 'https://example.org/api')
    accepts(assertConnectorUrl, 'http://internal-gateway.local/readings')
  })
})

describe('ENH-78 — the gate classifies every fetch site it is given', () => {
  it('runs its own canaries without a failure', () => {
    const out = execFileSync(process.execPath, [GATE, '--self-test'], { encoding: 'utf8' })
    assert.match(out, /all canaries passed/)
  })

  it('passes on the tree as it stands', () => {
    assert.deepEqual(scanTree(ROOT), [], 'the tree has an unaccounted fetch site')
  })

  it('agrees with the canary table it ships', () => {
    for (const canary of CANARIES) {
      const got = scanSource(canary.source).length
      assert.equal(got, canary.expect, `${canary.name}: expected ${canary.expect}, got ${got}`)
    }
  })
})

describe('ENH-78 — the gate fails on a planted defect in the real tree', () => {
  /**
   * Exit 0 from a gate nobody has watched fail is not evidence. Each of these
   * removes a guard or a marker from the real tree, requires the gate to exit
   * non-zero, and restores from a backup — never `git checkout`, which in a
   * shared tree reverts other agents' uncommitted work along with the mutation.
   */
  const plantAndRequireFailure = (relPath, target, label) => {
    const full = path.join(ROOT, relPath)
    const before = fs.readFileSync(full, 'utf8')
    assert.ok(before.includes(target), `canary target not found in ${relPath} — the patch would be a no-op`)
    fs.writeFileSync(full, before.replace(target, ''))
    let failed = false
    try {
      execFileSync(process.execPath, [GATE], { stdio: 'pipe' })
    } catch {
      failed = true
    } finally {
      fs.writeFileSync(full, before)
    }
    assert.ok(failed, `${label}: the gate passed with the guard removed`)
    assert.deepEqual(scanTree(ROOT), [], `${label}: the tree was not restored`)
  }

  it('fails when a connector guard is deleted — dhis2 pull', () => {
    plantAndRequireFailure('src/connectors/dhis2.js', '  assertConnectorUrl(url)\n', 'dhis2 pull')
  })

  it('fails when a connector guard is deleted — kobo', () => {
    plantAndRequireFailure('src/connectors/kobo.js', '  assertConnectorUrl(url)\n', 'kobo')
  })

  it('fails when the marker on a non-caller URL is removed — rapidpro', () => {
    plantAndRequireFailure('src/rapidpro.js', '    // caller-url-ok:', 'rapidpro marker')
  })

  it('does not honour `guarded-by-caller` when the file names no guard', () => {
    // The falsifiability rule. The site claims its caller guards the URL; the
    // claim is a lie once the guard is gone, and the gate must not take the
    // marker's word for it.
    const source = [
      'import { assertConnectorUrl } from "../webhooks.js"',
      'async function fetchPage(url) {',
      '  // caller-url-ok: guarded-by-caller — the caller runs the guard',
      '  return fetch(url, { signal })',
      '}',
    ].join('\n')
    // The import alone must not satisfy it — an import is a name, not a call.
    assert.equal(scanSource(source).length, 1)
  })
})
