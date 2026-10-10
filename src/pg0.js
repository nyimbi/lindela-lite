import { spawn } from 'node:child_process'

export class Pg0Manager {
  constructor({
    command = process.env.PG0_BIN || 'pg0',
    name = process.env.PG0_NAME || process.env.LINDELA_LITE_PG0_NAME || 'lindela-lite',
    port = process.env.PG0_PORT || process.env.LINDELA_LITE_PG0_PORT || null,
    dataDir = process.env.PG0_DATA_DIR || process.env.LINDELA_LITE_PG0_DATA_DIR || null,
    username = process.env.PG0_USERNAME || 'postgres',
    password = process.env.PG0_PASSWORD || 'postgres',
    database = process.env.PG0_DATABASE || 'postgres',
    databaseUrl = process.env.LINDELA_LITE_DATABASE_URL || process.env.DATABASE_URL || null,
    timeoutMs = Number(process.env.LINDELA_LITE_PG0_TIMEOUT_MS || 20000),
  } = {}) {
    this.command = command
    this.name = name
    this.port = port
    this.dataDir = dataDir
    this.username = username
    this.password = password
    this.database = database
    this.databaseUrl = databaseUrl
    this.timeoutMs = timeoutMs
  }

  async available() {
    const result = await runCommand(this.command, ['--version'], { timeoutMs: 4000, rejectOnExit: false })
    return result.code === 0
  }

  async start() {
    const args = ['start', '--name', this.name, '--username', this.username, '--password', this.password, '--database', this.database]
    if (this.port) args.push('--port', String(this.port))
    if (this.dataDir) args.push('--data-dir', this.dataDir)
    const result = await runCommand(this.command, args, { timeoutMs: this.timeoutMs, rejectOnExit: false })
    const output = `${result.stdout}
${result.stderr}`
    if (result.code !== 0 && !/already|running|started|listening/i.test(output)) {
      throw new Error(`pg0 start failed: ${output.trim() || `exit ${result.code}`}`)
    }
    const info = await this.info().catch(() => null)
    if (!info?.running) {
      throw new Error(`pg0 start did not produce a running instance for ${this.name}. ${output.trim()}`.trim())
    }
    return { databaseUrl: this.databaseUrl || info.uri || info.connection_uri || this.defaultUri(), output, info }
  }

  async info() {
    const result = await runCommand(this.command, ['info', '--name', this.name, '--output', 'json'], { timeoutMs: 8000, rejectOnExit: false })
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `pg0 info failed with ${result.code}`)
    return JSON.parse(result.stdout)
  }

  async stop() {
    return runCommand(this.command, ['stop', '--name', this.name], { timeoutMs: this.timeoutMs, rejectOnExit: false })
  }

  async drop() {
    return runCommand(this.command, ['drop', '--name', this.name, '--force'], { timeoutMs: this.timeoutMs, rejectOnExit: false })
  }

  defaultUri() {
    return `postgresql://${this.username}:${this.password}@127.0.0.1:${this.port || 5432}/${this.database}`
  }
}

/**
 * SCL-08. How much of a child's output to keep.
 *
 * `stdout += chunk` accumulated without limit. `initdb`, `pg_ctl` and the
 * restore paths are the callers, and a `pg_restore` over a large dump prints
 * every object it restores — hundreds of megabytes of progress lines held as
 * one string in the parent, to be discarded on the next line anyway. The cap
 * keeps the head (where the error is) and the tail (where the summary is), and
 * records how much it dropped rather than silently truncating.
 */
const MAX_OUTPUT_CHARS = 256 * 1024
const TRUNCATION_NOTE = '\n… output truncated by pg0 …\n'

function appendCapped(existing, chunk) {
  const next = existing + chunk.toString()
  if (next.length <= MAX_OUTPUT_CHARS) return next
  // Keep the first half and the last half. The head carries the command's
  // opening and any early failure; the tail carries the exit summary and the
  // last error. The middle is progress output nobody reads.
  const half = Math.floor(MAX_OUTPUT_CHARS / 2)
  return next.slice(0, half) + TRUNCATION_NOTE + next.slice(next.length - half)
}

function runCommand(command, args, { timeoutMs, rejectOnExit = true }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    // SCL-08. `unref` so the timeout does not hold the event loop open by
    // itself. `clearTimeout` below covers the normal path, but a child that
    // exits without emitting `close` — killed by a signal, or a spawn that
    // never fires `error` — left a live timer pinning the process for the rest
    // of its timeout, which is the difference between a clean exit and a test
    // runner that hangs for fifteen seconds.
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout.on('data', (chunk) => { stdout = appendCapped(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = appendCapped(stderr, chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (error.code === 'ENOENT') {
        resolve({ code: 127, stdout, stderr: `${stderr}${command} not found` })
        return
      }
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && rejectOnExit) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout || `exit ${code}`}`))
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

/** Test seam: the output cap, so a test does not have to produce 256 KB. */
export const PG0_MAX_OUTPUT_CHARS = MAX_OUTPUT_CHARS

/**
 * Test seam: the capping function itself.
 *
 * `runCommand` is not exported — it spawns a process and nothing about the cap
 * needs one. The behaviour worth pinning is the fold, so it is exported rather
 * than reached through a spawned command.
 */
export function capChildOutput(existing, chunk) {
  return appendCapped(existing, chunk)
}
