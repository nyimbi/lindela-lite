#!/usr/bin/env node
/**
 * VUL-07. The CSP hashes must cover the scripts the browser is actually served.
 *
 * `script-src` used to name `'unsafe-inline'`, which is the mitigation it exists
 * to provide. It now names the sha256 of each inline script — and a hash that
 * does not match does not throw. The browser blocks the script and the page
 * stops working with nothing in the console a production user will see. That is
 * a worse failure than the one being fixed, so it needs a test that fails on
 * the *served* bytes.
 *
 * Testing against the file on disk is not enough: the server rewrites HTML on
 * the way out (`fillAppVersionMarker`, gzip), and a hash computed from the file
 * would pass while the browser computed something else. These tests fetch over
 * HTTP and hash what came back, which is the only thing the browser ever sees.
 *
 * The header is read from a real response too. Asserting on the array exported
 * by `server.js` would prove the two copies agree, not that either reached the
 * client — the defect class this codebase keeps finding.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { INLINE_SCRIPT_HASHES } from '../src/server.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/** The eight surfaces the server recognises, plus the bare root. */
const SURFACES = ['/', '/portal/', '/chw/', '/co/', '/districts/', '/focal-point/', '/parametric/', '/scenarios/']

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-csp-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Every `'sha256-…'` the policy allows, as written in the header. */
function allowedHashes(csp) {
  return new Set([...csp.matchAll(/'sha256-[^']+'/g)].map((match) => match[0]))
}

function hashOf(body) {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
}

describe('the CSP allows exactly the inline scripts the pages ship', () => {
  it('drops unsafe-inline from script-src', async () => {
    // The whole point. If this fails, the policy is back to allowing any
    // injected script and every other assertion here is decoration.
    await withServer(async (base) => {
      for (const surface of SURFACES) {
        const res = await fetch(`${base}${surface}`)
        const csp = res.headers.get('content-security-policy') || ''
        const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src')) || ''
        assert.ok(scriptSrc, `${surface} sent no script-src directive`)
        assert.ok(
          !scriptSrc.includes("'unsafe-inline'"),
          `${surface} still allows 'unsafe-inline' in script-src: ${scriptSrc.trim()}`,
        )
      }
    })
  })

  it('hashes every inline script in the served HTML', async () => {
    await withServer(async (base) => {
      let checked = 0
      for (const surface of SURFACES) {
        const res = await fetch(`${base}${surface}`)
        const csp = res.headers.get('content-security-policy') || ''
        const allowed = allowedHashes(csp)
        const html = await res.text()
        for (const match of html.matchAll(INLINE_SCRIPT)) {
          const hash = hashOf(match[1])
          checked++
          assert.ok(
            allowed.has(hash),
            `${surface} ships an inline script the policy does not allow (${hash}). ` +
            'The browser blocks it silently — run `node scripts/check-csp.mjs --write`.',
          )
        }
      }
      // A regex that stopped matching would report zero scripts and pass. This
      // is the same guard the route-coverage gate carries, for the same reason.
      assert.ok(checked >= 8, `expected an inline script on each surface, found ${checked}`)
    })
  })

  it('does not carry a hash for a script that no longer exists', async () => {
    // The other direction. A stale hash is not a hole — it is a hash that no
    // longer covers anything, and its presence is what makes the list look
    // maintained while a real script goes uncovered.
    await withServer(async (base) => {
      const present = new Set()
      for (const surface of SURFACES) {
        const html = await (await fetch(`${base}${surface}`)).text()
        for (const match of html.matchAll(INLINE_SCRIPT)) present.add(hashOf(match[1]))
      }
      for (const hash of INLINE_SCRIPT_HASHES) {
        assert.ok(
          present.has(`'${hash}'`),
          `${hash} is in the policy but matches no served script`,
        )
      }
    })
  })

  it('quotes every hash-source, which the header must do and the array must not', async () => {
    // A CSP hash-source is `'sha256-…'`, quoted. Unquoted it is not a hash-source
    // at all: the browser ignores it and blocks the script, with nothing logged.
    // The array holds bare values and `server.js` adds the quotes — writing them
    // in the array instead makes them JavaScript string delimiters, so they
    // vanish from the value. That is the exact bug this test was written after
    // finding in the first version of the fix.
    await withServer(async (base) => {
      const csp = (await fetch(`${base}/`)).headers.get('content-security-policy') || ''
      const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src')) || ''
      // A hash preceded by anything other than a quote is unquoted. Matching
      // `sha256-…` alone would also match inside the quoted form, which is the
      // bug the first version of this assertion had.
      const unquoted = scriptSrc.match(/(?<!')sha256-[A-Za-z0-9+/=]+/g) || []
      assert.equal(
        unquoted.length, 0,
        `script-src ships unquoted hash-sources, which the browser ignores: ${unquoted.join(', ')}`,
      )
      assert.equal(allowedHashes(csp).size, INLINE_SCRIPT_HASHES.length)
    })
  })

  it('covers the scripts in the file the browser caches, not only the fresh one', async () => {
    // The service worker caches HTML for offline use, which is why a per-request
    // nonce was rejected. A cached page carries the same inline scripts, so the
    // hash list has to be stable across requests — a policy that varied per
    // request would leave every cached surface with blocked scripts.
    await withServer(async (base) => {
      const first = await fetch(`${base}/chw/`)
      const second = await fetch(`${base}/chw/`)
      assert.equal(
        first.headers.get('content-security-policy'),
        second.headers.get('content-security-policy'),
        'the policy varies between requests, so a cached page would not match it',
      )
    })
  })

  it('ships no inline event handler, which a hash cannot cover', async () => {
    // `onclick=` is `'unsafe-inline'` by another name: the CSP treats an inline
    // handler as an inline script and hashes do not apply to it. One of these
    // coming back is how `'unsafe-inline'` returns.
    await withServer(async (base) => {
      for (const surface of SURFACES) {
        const html = await (await fetch(`${base}${surface}`)).text()
        const handler = html.match(/\son(click|change|input|submit|load|error|keyup|keydown|focus|blur)\s*=/i)
        assert.equal(
          handler?.[0] ?? null, null,
          `${surface} ships an inline event handler (${handler?.[0]?.trim()}), which no hash can cover`,
        )
      }
    })
  })
})
