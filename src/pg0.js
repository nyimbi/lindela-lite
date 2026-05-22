import { spawn } from 'node:child_process'

export class Pg0Manager {
  constructor({
    command = process.env.PG0_BIN || 'pg0',
    databaseUrl = process.env.LINDELA_LITE_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
    timeoutMs = Number(process.env.LINDELA_LITE_PG0_TIMEOUT_MS || 15000),
  } = {}) {
    this.command = command
    this.databaseUrl = databaseUrl
    this.timeoutMs = timeoutMs
  }

  async available() {
    const result = await runCommand(this.command, ['--version'], { timeoutMs: 4000, rejectOnExit: false })
    return result.code === 0
  }

  async start() {
    const result = await runCommand(this.command, ['start'], { timeoutMs: this.timeoutMs, rejectOnExit: false })
    const output = `${result.stdout}
${result.stderr}`
    if (result.code !== 0 && !/already|running|started|listening/i.test(output)) {
      throw new Error(`pg0 start failed: ${output.trim() || `exit ${result.code}`}`)
    }
    return { databaseUrl: this.databaseUrl, output }
  }
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

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
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
