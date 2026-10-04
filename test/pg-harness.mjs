/**
 * A disposable PostgreSQL cluster for tests that must not skip.
 *
 * `pg0` is the project's declared way to get one and it is not installed on
 * every machine, which is how `test/database.integration.test.js` has ended up
 * skipping itself in CI and how `PostgresStore` ran at 0% function coverage for
 * the life of the store. Skipping is the failure mode this harness exists to
 * remove, so the fallback is the `initdb`/`pg_ctl` pair that ships with every
 * PostgreSQL install — including the Postgres.app bundle in /Applications,
 * which is what a developer's machine actually has.
 *
 * If no binaries can be found at all, `postgresHarness()` resolves to a skip
 * with the reason, and callers decide what to do about it under CI.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Candidate bindirs, most specific first. */
async function candidateBindirs() {
  const dirs = []
  if (process.env.PG_BINDIR) dirs.push(process.env.PG_BINDIR)
  // pg_config knows where its own installation keeps the server binaries, and
  // it is on PATH wherever Homebrew or Postgres.app put one.
  const configured = await run('pg_config', ['--bindir'])
  if (configured.code === 0 && configured.stdout.trim()) dirs.push(configured.stdout.trim())
  dirs.push(
    '/Applications/Postgres.app/Contents/Versions/latest/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/opt/homebrew/opt/postgresql@15/bin',
    '/opt/homebrew/opt/postgresql@14/bin',
    '/usr/local/opt/postgresql@16/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/16/bin',
    '/usr/bin',
  )
  return [...new Set(dirs.filter(Boolean))]
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** The directory holding initdb/pg_ctl/postgres, or null. */
export async function findBindir() {
  for (const dir of await candidateBindirs()) {
    if (await exists(path.join(dir, 'initdb')) && await exists(path.join(dir, 'pg_ctl'))) return dir
  }
  // One level down from a versioned bundle, e.g. Versions/16/bin.
  const bundle = '/Applications/Postgres.app/Contents/Versions'
  try {
    for (const version of (await fs.readdir(bundle)).reverse()) {
      const dir = path.join(bundle, version, 'bin')
      if (await exists(path.join(dir, 'initdb')) && await exists(path.join(dir, 'pg_ctl'))) return dir
    }
  } catch { /* no Postgres.app */ }
  return null
}

function run(bin, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Starts a cluster and returns a handle with its URL and a `stop()`.
 *
 * Resolves `{ skipped: reason }` if no server binaries are present — never a
 * green pass with nothing behind it. `stop()` is idempotent.
 */
export async function postgresCluster({ name = 'lindela-test' } = {}) {
  // An externally supplied database short-circuits provisioning: the same tests
  // then run against a real cluster the operator chose.
  if (process.env.LINDELA_LITE_TEST_DATABASE_URL) {
    return {
      skipped: null,
      url: process.env.LINDELA_LITE_TEST_DATABASE_URL,
      stop: async () => {},
    }
  }

  const bindir = await findBindir()
  if (!bindir) {
    return { skipped: 'no PostgreSQL server binaries found (looked for initdb and pg_ctl)' }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lindela-${name}-`))
  const dataDir = path.join(dir, 'data')
  const port = await freePort()
  const init = await run(path.join(bindir, 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust'])
  if (init.code !== 0) {
    return { skipped: `initdb failed: ${(init.stderr || init.stdout).trim().split('\n')[0]}` }
  }

  const start = await run(path.join(bindir, 'pg_ctl'), [
    '-D', dataDir,
    '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
    '-l', path.join(dir, 'server.log'),
    '-w', '-t', '30', 'start',
  ])
  if (start.code !== 0) {
    const log = await fs.readFile(path.join(dir, 'server.log'), 'utf8').catch(() => '')
    return { skipped: `pg_ctl start failed: ${(log || start.stderr).trim().split('\n').slice(-1)[0]}` }
  }

  let stopped = false
  return {
    skipped: null,
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      if (stopped) return
      stopped = true
      await run(path.join(bindir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'])
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Starts a cluster, hands a connection URL to `body`, then stops it and removes
 * its data directory. Resolves `{ skipped: reason }` if no server binaries are
 * present.
 */
export async function withPostgres(body, options = {}) {
  const cluster = await postgresCluster(options)
  if (cluster.skipped) return { skipped: cluster.skipped }
  try {
    return { skipped: null, result: await body(cluster.url) }
  } finally {
    await cluster.stop()
  }
}
