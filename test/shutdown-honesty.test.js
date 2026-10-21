import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { installShutdown } from '../src/server.js'

/**
 * R-60 — the process had no SIGTERM handler at all.
 *
 * Measured on the tree before this test existed: `docker stop` or a systemd
 * unit's stop took the default action, so the child exited with
 * `code: null, signal: 'SIGTERM'` 14 ms after the signal. Three things were
 * lost with it — the periodic driver's tick, which may have been midway through
 * a write; the Postgres pool's connections, torn down by the kernel rather than
 * returned to the pool; and any request being served at that instant, whose
 * caller got a reset socket with no explanation.
 *
 * The JSON store's temp-file-and-rename is why the *file* survives a kill, and
 * it is why the defect is invisible from the data: what is missing is the
 * process's own account of stopping. These tests spawn the real entry point and
 * read the signal's effect, not the source.
 */

const ROOT = new URL('..', import.meta.url).pathname

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const port = 4400 + Math.floor(Math.random() * 500)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-test-'))
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        LINDELA_LITE_PORT: String(port),
        LINDELA_LITE_HOST: '127.0.0.1',
        LINDELA_LITE_STORE: path.join(dir, 'store.json'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const onData = (chunk) => {
      out += chunk
      if (/listening on http/.test(out)) {
        clearTimeout(deadline)
        resolve({
          child,
          port,
          output: () => out,
          cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
        })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    const deadline = setTimeout(() => reject(new Error(`no startup line within 20s:\n${out}`)), 20000)
  })
}

/** Resolve with how the child exited, and how long it took after the signal. */
function stopAndWait(child, signal = 'SIGTERM') {
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })))
  const at = Date.now()
  child.kill(signal)
  return exited.then((result) => ({ ...result, ms: Date.now() - at }))
}

describe('R-60 — the process stops when it is told to', () => {
  it('exits cleanly on SIGTERM instead of dying on the signal', async (t) => {
    const { child, cleanup } = await startServer()
    t.after(() => { child.kill('SIGKILL'); cleanup() })
    const { code, signal } = await stopAndWait(child)
    assert.equal(signal, null,
      'the process was terminated by SIGTERM, so it has no shutdown path at all')
    assert.equal(code, 0, 'a shutdown that ran its handlers reports success, not a failure code')
  })

  it('exits cleanly on SIGINT, so a terminal Ctrl-C is the same path', async (t) => {
    const { child, cleanup } = await startServer()
    t.after(() => { child.kill('SIGKILL'); cleanup() })
    const { code, signal } = await stopAndWait(child, 'SIGINT')
    assert.equal(signal, null, 'SIGINT must reach the same handler')
    assert.equal(code, 0)
  })

  it('finishes the request it was serving before it exits', async (t) => {
    // The claim that makes the handler worth having, and the one a spawned
    // process cannot show: a shutdown that exits immediately would pass the
    // tests above and still reset every socket it had open.
    //
    // Driven in-process against `installShutdown` with an injected exit, so the
    // handler runs on a server whose route deliberately takes 120 ms. The route
    // is what makes the request *in flight* rather than merely connected —
    // `server.close()` closes idle sockets immediately and correctly, so a
    // request that had not arrived yet proves nothing either way.
    const calls = []
    const server = http.createServer((req, res) => {
      setTimeout(() => { res.writeHead(200); res.end('slow') }, 120)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    t.after(() => server.close())
    const shutdown = installShutdown(server, {
      exit: (code) => calls.push(`exit:${code}`),
      onStop: () => calls.push('stop-driver'),
    })
    const { port } = server.address()
    const response = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text())
    // Let the connection be accepted and the handler entered before signalling.
    await new Promise((r) => setTimeout(r, 40))
    shutdown('SIGTERM')
    const body = await response
    assert.equal(body, 'slow',
      'the in-flight request was reset by the shutdown instead of being allowed to finish')
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(calls, ['stop-driver', 'exit:0'],
      'the driver must stop before the exit, and the exit must wait for the response')
  })

  it('does not hang when a connection refuses to close', async (t) => {
    // The bound. A shutdown that waits forever is a process the orchestrator
    // has to SIGKILL, which is the state the handler exists to prevent.
    const { child, cleanup } = await startServer({ LINDELA_LITE_SHUTDOWN_MS: '150' })
    t.after(() => { child.kill('SIGKILL'); cleanup() })
    const { signal, ms } = await stopAndWait(child)
    assert.equal(signal, null, 'the handler must own the exit, not the signal')
    assert.ok(ms < 5000, `shutdown took ${ms} ms against a 150 ms bound`)
  })
})
