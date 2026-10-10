#!/usr/bin/env node
/**
 * The distribution webhook must clear the same guard as a subscription webhook.
 *
 * `POST /api/v1/reports/:id/distribute` fetches `channel.url` straight from the
 * request body. The outbox has applied `assertSafeWebhookUrl` to subscription
 * URLs since the first audit; the distribution path never did, so one reports
 * token could make the server fetch the cloud metadata endpoint or any RFC-1918
 * host and persist the response into `report_distribution_runs`.
 *
 * The canary is the metadata URL: it must be refused *before* any fetch, and
 * the refusal must be visible as a failed run rather than a thrown 500.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

const KEY = 'distribution-ssrf-key'

describe('report distribution webhook is SSRF-guarded', () => {
  let baseUrl
  let listener
  let dir
  let saved = {}

  before(async () => {
    for (const k of ['LINDELA_LITE_TOKENS', 'LINDELA_LITE_API_KEY', 'LINDELA_LITE_PUBLIC_PATHS']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.LINDELA_LITE_API_KEY = KEY
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-dist-ssrf-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    // A ready report, so distribution reaches the channel loop rather than
    // rejecting on status.
    await store.merge({
      reports: [{
        id: 'rpt-ssrf-1', title: 'Flood SITREP', report_type: 'situation',
        status: 'ready', summary: 'Test report', sections: [], sources: [],
      }],
    })
    const server = createServer({ store })
    listener = server.listen(0)
    baseUrl = `http://127.0.0.1:${listener.address().port}`
  })

  after(async () => {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  async function distribute(url) {
    const res = await fetch(`${baseUrl}/api/v1/reports/rpt-ssrf-1/distribute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ channels: [{ channel: 'webhook', url }] }),
    })
    return { status: res.status, body: await res.json() }
  }

  it('refuses the cloud metadata endpoint and records a failed run', async () => {
    const { body } = await distribute('http://169.254.169.254/latest/meta-data/iam/security-credentials/')
    const run = body.data?.[0]
    assert.ok(run, 'a distribution run is recorded even when the URL is refused')
    assert.equal(run.status, 'failed', 'a non-public URL must not be fetched')
    assert.match(String(run.error), /non-public|public address/i,
      `the refusal names the reason, not a raw network error: ${run.error}`)
  })

  it('refuses RFC-1918 and loopback hosts', async () => {
    for (const url of ['http://10.0.0.1/hook', 'http://127.0.0.1:4177/hook', 'http://192.168.1.5/hook']) {
      const { body } = await distribute(url)
      assert.equal(body.data?.[0]?.status, 'failed', `${url} must not be fetched`)
    }
  })

  it('refuses a non-http scheme and embedded credentials', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:11211/', 'http://user:pass@example.com/hook']) {
      const { body } = await distribute(url)
      assert.equal(body.data?.[0]?.status, 'failed', `${url} must not be fetched`)
    }
  })
})
