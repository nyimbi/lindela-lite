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
 * A private database on an externally supplied cluster.
 *
 * The name carries the pid and a random suffix so two test files running
 * concurrently — which is how `node --test test/*.test.js` runs them — cannot
 * collide, and so a leftover from a killed run is not reused.
 */
async function provisionDatabase(baseUrl, name) {
  const dbName = `lindela_${name}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase()

  const adminUrl = new URL(baseUrl)
  adminUrl.pathname = '/postgres'

  // Through `pg`, not `psql`. The client binary is not guaranteed to exist on a
  // machine that can reach a database — a CI runner with a Postgres *service
  // container* has the server behind a port and no client on PATH — and a
  // harness that fails for want of a CLI reports the same "no database" as a
  // machine that genuinely has none. `pg` is already the project's one runtime
  // dependency, so it is always there.
  const { default: pg } = await import('pg')
  const admin = new pg.Client({ connectionString: adminUrl.toString() })
  try {
    await admin.connect()
    // `CREATE DATABASE` takes no bind parameters for the name, which is why the
    // name is built from a sanitised alphabet above rather than passed through.
    await admin.query(`CREATE DATABASE ${dbName}`)
  } catch (error) {
    // Refusing to fall back is the point. Sharing the database again would
    // restore exactly the cross-test contamination this exists to prevent, and
    // it would do so silently — the tests would pass or fail depending on which
    // other files ran. A skip with the reason is the honest outcome.
    return {
      skipped: `could not create a private test database on the supplied cluster `
        + `(needs CREATEDB): ${String(error.message || error).trim().split('\n')[0]}`,
    }
  } finally {
    await admin.end().catch(() => {})
  }

  const url = new URL(baseUrl)
  url.pathname = `/${dbName}`

  let stopped = false
  return {
    skipped: null,
    url: url.toString(),
    stop: async () => {
      if (stopped) return
      stopped = true
      const drop = new pg.Client({ connectionString: adminUrl.toString() })
      try {
        await drop.connect()
        await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      } catch { /* the cluster may already be gone; nothing to clean up */ } finally {
        await drop.end().catch(() => {})
      }
    },
  }
}

/**
 * Starts a cluster and returns a handle with its URL and a `stop()`.
 *
 * Resolves `{ skipped: reason }` if no server binaries are present — never a
 * green pass with nothing behind it. `stop()` is idempotent.
 */
export async function postgresCluster({ name = 'lindela-test' } = {}) {
  // An externally supplied database runs the same tests against a real cluster
  // the operator chose — but each caller gets its *own* database on it.
  //
  // Handing every caller the same database was a silent isolation failure, and
  // an asymmetric one: with no external URL each caller provisions a private
  // `initdb` cluster, so on a developer machine the tests are isolated and pass,
  // while under CI's `LINDELA_LITE_TEST_DATABASE_URL` they all share one
  // database and read each other's rows — `'asset-1' !== 'seed-asset'`, and a
  // `read()` that returns six rows where the test wrote one. The failure was
  // invisible locally by construction, which is the worst shape a test bug can
  // have.
  //
  // A private database rather than a private schema: the store's SQL is
  // unqualified, so a schema would need `search_path` set on every connection
  // the pool opens, and a `pg.Pool` gives no hook for that. `CREATE DATABASE` is
  // one statement, and dropping it in `stop()` takes the whole namespace with
  // it.
  if (process.env.LINDELA_LITE_TEST_DATABASE_URL) {
    return provisionDatabase(process.env.LINDELA_LITE_TEST_DATABASE_URL, name)
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
