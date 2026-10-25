import { spawn } from 'node:child_process'
import { toNumber } from './utils.js'

/**
 * How long to wait for a `pg0` subprocess, in ms.
 *
 * `Number(env.X || 20000)` reads a typo as a bound and hands it to
 * `setTimeout`, where `NaN` and a negative number both fire on the next tick:
 * `LINDELA_LITE_PG0_TIMEOUT_MS=20s` (a unit the variable's name does not carry)
 * made every `pg0 start` fail within 2 ms with "timed out after NaNms", and
 * `=0` — which is what an unset shell variable interpolates to — did the same.
 * The failure message blamed pg0 for a value the caller wrote.
 *
 * A value that is present but not a positive finite number is a configuration
 * error, so it is refused rather than defaulted. Absent or blank keeps the 20 s
 * default. Resolved at the point of use rather than in the constructor: `auto`
 * mode builds a `Pg0Manager` on every start, including deployments that end up
 * on the JSON store and never call a subprocess, and a JSON deployment must not
 * fail on a variable it does not use.
 */
function pg0Timeout(raw, fallbackMs = 20_000) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return fallbackMs
  const parsed = toNumber(raw)
  if (parsed === null || parsed <= 0) {
    throw new TypeError(`LINDELA_LITE_PG0_TIMEOUT_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

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
    timeoutMs = undefined,
  } = {}) {
    this.command = command
    this.name = name
    this.port = port
    this.dataDir = dataDir
    this.username = username
    this.password = password
    this.database = database
    this.databaseUrl = databaseUrl
    // Resolved on each use, not here, so a JSON deployment that builds a manager
    // in `auto` mode and never calls a subprocess is not failed by a variable it
    // does not use. A caller that supplies one explicitly is held to it now.
    this.timeoutMs = timeoutMs === undefined ? undefined : pg0Timeout(timeoutMs)
  }

  /**
   * The bound for one subprocess call. An explicit constructor value wins;
   * otherwise the environment is read here, at the point of use.
   */
  commandTimeout() {
    return this.timeoutMs === undefined ? pg0Timeout(process.env.LINDELA_LITE_PG0_TIMEOUT_MS) : this.timeoutMs
  }

  async available() {
    const result = await runCommand(this.command, ['--version'], { timeoutMs: 4000, rejectOnExit: false })
    return result.code === 0
  }

  async start() {
    const args = ['start', '--name', this.name, '--username', this.username, '--password', this.password, '--database', this.database]
    if (this.port) args.push('--port', String(this.port))
    if (this.dataDir) args.push('--data-dir', this.dataDir)
    const result = await runCommand(this.command, args, { timeoutMs: this.commandTimeout(), rejectOnExit: false })
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
    return runCommand(this.command, ['stop', '--name', this.name], { timeoutMs: this.commandTimeout(), rejectOnExit: false })
  }

  async drop() {
    return runCommand(this.command, ['drop', '--name', this.name, '--force'], { timeoutMs: this.commandTimeout(), rejectOnExit: false })
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
