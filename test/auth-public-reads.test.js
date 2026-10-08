#!/usr/bin/env node
/**
 * Public paths are a read widening, not an open door.
 *
 * `LINDELA_LITE_PUBLIC_PATHS=/api/v1` is how a deployment publishes the demo
 * dashboard: anyone can browse the data, and a token is still required for
 * every mutation. The regression this guards: the public-path bypass once
 * applied to every method, so a publicly listed prefix silently opened
 * anonymous writes.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { isPublicRequest, publicReadsOpen } from '../src/auth.js'

describe('public paths widen reads only', () => {
  let baseUrl
  let listener

  before(async () => {
    process.env.LINDELA_LITE_API_KEY = 'test-public-reads-key'
    process.env.LINDELA_LITE_PUBLIC_PATHS = '/api/v1'
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-public-reads-'))
    const server = createServer({ store: new JsonStore(path.join(dir, 'store.json')) })
    listener = server.listen(0)
    baseUrl = `http://localhost:${listener.address().port}`
  })

  after(() => {
    delete process.env.LINDELA_LITE_API_KEY
    delete process.env.LINDELA_LITE_PUBLIC_PATHS
    listener.close()
  })

  it('serves an anonymous GET under a public prefix', async () => {
    const res = await fetch(`${baseUrl}/api/v1/climate`)
    assert.equal(res.status, 200, 'anonymous GET under a public prefix must succeed')
  })

  it('still rejects an anonymous POST under the same public prefix', async () => {
    const res = await fetch(`${baseUrl}/api/v1/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'forged', incident_type: 'test' }),
    })
    assert.equal(res.status, 401, 'a public prefix must never open anonymous writes')
  })

  it('serves the mutation for a caller with the token', async () => {
    const res = await fetch(`${baseUrl}/api/v1/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-public-reads-key' },
      body: JSON.stringify({ title: 'operator action', incident_type: 'flood_access' }),
    })
    assert.equal(res.status, 201, 'a token holder writes under a public prefix')
  })

  it('isPublicRequest is false for every mutation method', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.equal(isPublicRequest(method, '/api/v1/climate'), false, `${method} is never public`)
    }
    assert.equal(isPublicRequest('GET', '/api/v1/climate'), true)
    assert.equal(isPublicRequest('HEAD', '/api/v1/climate'), true)
  })

  it('publicReadsOpen reports the /api/v1 namespace as browsable', () => {
    assert.equal(publicReadsOpen({ LINDELA_LITE_PUBLIC_PATHS: '/api/v1' }), true)
    assert.equal(publicReadsOpen({ LINDELA_LITE_PUBLIC_PATHS: '/api/v1/health' }), false, 'one public endpoint is not an open console')
    assert.equal(publicReadsOpen({}), false)
  })
})
