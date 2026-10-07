import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'

/**
 * The startup line used to claim `http://127.0.0.1:<port>` unconditionally.
 *
 * It was wrong. `listen(port)` with no host argument binds every interface, so
 * a bare-metal run was reachable on every interface the machine had — while the
 * process printed a loopback URL and an operator read that as the exposure
 * boundary. Measured on a laptop: the port answered `200` on the LAN address.
 *
 * With no tokens configured, authentication is off entirely, so the thing being
 * over-published was an unauthenticated platform holding field reports with
 * names and household counts in them.
 *
 * The default is unchanged, and deliberately: the container must bind 0.0.0.0 or
 * a published port reaches nothing. What is pinned here is that the process
 * stops *claiming* loopback when it is not binding loopback, and that
 * `LINDELA_LITE_HOST` can narrow it.
 */

const SERVER = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
const COMPOSE = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const DOCKERFILE = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')

/**
 * Start the real server on an ephemeral port and return its startup output.
 *
 * Waits for stdout to go quiet after the first line rather than resolving on
 * that line alone. The startup block is three lines when bound to every
 * interface and one when bound to loopback, and resolving on the first of them
 * made the two warning lines a race this test lost about half the time.
 */
function startServer(env, { quietFor = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const port = 4300 + Math.floor(Math.random() * 400)
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        LINDELA_LITE_PORT: String(port),
        // Never read: the startup lines are written before the store is opened,
        // so pointing this at a nonexistent path costs nothing.
        LINDELA_LITE_STORE: '/nonexistent/lindela-test-store.json',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let quietTimer = null
    let done = false

    const finish = (fn, arg) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      if (quietTimer) clearTimeout(quietTimer)
      child.kill('SIGTERM')
      fn(arg)
    }

    const onData = (chunk) => {
      out += chunk
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(resolve, { output: out, port }), quietFor)
    }

    const deadline = setTimeout(() => {
      finish(reject, new Error(`server did not report a startup line within 30s. Output:\n${out}`))
    }, 30000)

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => finish(reject, error))
  })
}

/** True when something accepts a TCP connection on this address. */
function acceptsConnection(address, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port })
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(3000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

describe('the process does not claim loopback it is not binding', () => {
  it('says so when bound to every interface', async () => {
    const { output } = await startServer({ LINDELA_LITE_HOST: '0.0.0.0' })
    assert.match(output, /bound to every interface/,
      'binding 0.0.0.0 must not be announced as a 127.0.0.1 URL')
    assert.match(output, /reachable from other machines/,
      'a listener on every interface has to say so, because auth may be off')
  })

  it('announces a loopback bind plainly, with no warning', async () => {
    const { output } = await startServer({ LINDELA_LITE_HOST: '127.0.0.1' })
    assert.match(output, /listening on http:\/\/127\.0\.0\.1:/)
    assert.doesNotMatch(output, /reachable from other machines/,
      'a loopback bind must not warn about network exposure it does not have')
  })

  it('defaults to every interface, because a container needs it', () => {
    // The default cannot move: binding 127.0.0.1 inside a container makes a
    // published port unreachable. This pins the choice so nobody "tightens" it
    // and breaks every deployment.
    assert.match(SERVER, /LINDELA_LITE_HOST \|\| '0\.0\.0\.0'/)
    assert.match(COMPOSE, /LINDELA_LITE_HOST: 0\.0\.0\.0/,
      'compose should say so rather than inherit it')
    assert.match(DOCKERFILE, /LINDELA_LITE_HOST=0\.0\.0\.0/,
      'so should the image, for `docker run -p` without compose')
  })

  it('narrowing the bind actually narrows it', async () => {
    // The env var is only worth having if it changes what the socket does, and
    // the loopback address is the only one available to test against on a host
    // that may or may not have a LAN address.
    const { port } = await startServer({ LINDELA_LITE_HOST: '127.0.0.1' })
    assert.equal(await acceptsConnection('127.0.0.1', port), true,
      'the loopback bind should be listening on loopback')

    const wildcard = await startServer({ LINDELA_LITE_HOST: '0.0.0.0' })
    assert.equal(await acceptsConnection('127.0.0.1', wildcard.port), true,
      'the wildcard bind should also answer on loopback')
  })
})
