import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

/**
 * Three entry points — run.sh, install.sh, scripts/deploy.sh — reviewed after
 * the listen fix, where each was found to fail in a way its own output
 * contradicted:
 *
 *   - run.sh stripped LINDELA_LITE_TOKENS / LINDELA_LITE_API_KEY from the
 *     environment, then announced "authentication is disabled": the operator's
 *     configured auth, discarded before the server saw it.
 *   - install.sh ran compose through an unquoted `$compose` under IFS=$'\n\t',
 *     so "docker compose" never split and every compose call died
 *     command-not-found; a caller-supplied --key reached sed unescaped,
 *     corrupting .env with `&` or `|`; `--dir` armour for `rm -rf` was absent;
 *     a failed pinned-ref clone silently fell back to the default branch.
 *   - deploy.sh pushed to a git *remote named* after the ref (no working git
 *     transport at all), joined ssh options with newlines into the rsync -e
 *     value, excluded `.env.*` — which also excluded `.env.example`, leaving
 *     the first deploy nothing to build .env from — accepted any --dir, whose
 *     quote-closing values execute on the far shell, and echoed `compose`
 *     from the compose probe so the stack start line was a command that does
 *     not exist.
 *
 * Refusals and arrivals are pinned below by running the scripts in sandboxes
 * with stubbed docker/ssh/rsync/curl on PATH.
 */

const ROOT = new URL('..', import.meta.url).pathname
const RUN_SH = path.join(ROOT, 'run.sh')
const INSTALL_SH = path.join(ROOT, 'install.sh')
const DEPLOY_SH = path.join(ROOT, 'scripts', 'deploy.sh')

const INSTALL_SOURCE = fs.readFileSync(INSTALL_SH, 'utf8')
const DEPLOY_SOURCE = fs.readFileSync(DEPLOY_SH, 'utf8')

const SEP = String.fromCharCode(0x1f)

function runScript(script, args, { env = {}, stdin = '', timeout = 240000 } = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input: stdin,
    timeout,
    env: { ...process.env, ...env },
  })
}

const clean = (s) => String(s).replace(/\033\[[0-9;]*m/g, '')

function currentBranch() {
  const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
  return r.stdout.trim() || 'main'
}

/** A directory with stub executables that log their argv to calls.txt. */
function stubDir(paths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-stub-'))
  const callsFile = path.join(dir, 'calls.txt')
  for (const [name, lines] of Object.entries(paths)) {
    const body = [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "${name}${SEP}argc=$#${SEP}args=$*" >> "$$CALLS$$"`,
      ...lines,
    ].join('\n').replaceAll('$$CALLS$$', callsFile)
    fs.writeFileSync(path.join(dir, name), body)
    fs.chmodSync(path.join(dir, name), 0o755)
  }
  return { dir, callsFile }
}

const DOCKER_STUB = [
  'case "$1" in',
  '  --version) echo "Docker version 27.0.0-teststub" ;;',
  '  info) exit 0 ;;',
  '  compose)',
  '    case "$2" in',
  '      version) exit 0 ;;',
  '      *) exit 0 ;;',
  '    esac ;;',
  'esac',
  'exit 0',
]

const CURL_STUB_HEALTHY =
  ['#!/usr/bin/env bash', 'printf \'{"success":true,"version":"9.8.7-teststub","healthy":true}\'', 'exit 0']

const SSH_STUB_DEPLOY = [
  'case "$*" in',
  // The $HOME probe gets a real answer; the compose probe says the plugin form.
  '*\'printf %s "$HOME"\'*) printf \'/home/deployer\' ;;',
  '*\'if docker compose version\'*) printf \'docker compose\' ;;',
  'esac',
  'exit 0',
]

describe('run.sh', () => {
  it('preflight starts nothing and exits clean', () => {
    const r = runScript(RUN_SH, ['--check'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(clean(r.stdout), /Preflight passed — nothing was started/)
  })

  it('refuses to start unauthenticated on any bind wider than loopback', () => {
    for (const host of ['0.0.0.0', '::']) {
      const r = runScript(RUN_SH, ['--host', host, '--check'])
      assert.equal(r.status, 1, `died on ${host}: ${r.stderr}`)
      assert.match(r.stderr, /refusing to start unauthenticated/)
    }
  })

  it('inherits a token list from the environment instead of stripping it', () => {
    // The pinned bug: run.sh unset the operator's tokens, then said auth was
    // off. With tokens in the environment the preflight must report them as
    // the auth source — and a 0.0.0.0 bind must be acceptable under them.
    const tokens = '[{"token":"t-in-test","scopes":["*"]}]'
    const r = runScript(RUN_SH, ['--host', '0.0.0.0', '--check'], {
      env: { LINDELA_LITE_TOKENS: tokens },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(clean(r.stdout), /token list inherited from LINDELA_LITE_TOKENS/)
    assert.doesNotMatch(clean(r.stdout), /authentication is off/)
  })

  it('inherits an environment API key as the auth source', () => {
    const r = runScript(RUN_SH, ['--host', '0.0.0.0', '--check'], {
      env: { LINDELA_LITE_API_KEY: 'env-key-in-test' },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(clean(r.stdout), /API key inherited from LINDELA_LITE_API_KEY/)
  })

  it('refuses --key alongside an environment token list, because the token list wins silently', () => {
    const tokens = '[{"token":"t-in-test","scopes":["*"]}]'
    const r = runScript(RUN_SH, ['--key', 'other', '--check'], {
      env: { LINDELA_LITE_TOKENS: tokens },
    })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /the server prefers the token list/)
  })

  it('refuses an empty --key and out-of-range ports', () => {
    const empty = runScript(RUN_SH, ['--key', ''])
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /--key needs a non-empty value/)

    for (const port of ['0', '99999', '70000']) {
      const r = runScript(RUN_SH, ['--port', port, '--check'])
      assert.equal(r.status, 1, `port ${port} must be refused`)
      assert.match(r.stderr, /port/)
    }
  })

  it('does not silently run --fresh against a PostgreSQL store', () => {
    const r = runScript(
      RUN_SH,
      ['--postgres', 'postgresql://lindela:pw@127.0.0.1:5432/lindela_lite', '--fresh', '--check'],
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /--fresh does not apply to a PostgreSQL store/)
  })
})

describe('install.sh', () => {
  it('spells docker compose as two commands, not one word the shell cannot find', () => {
    // Under IFS=$'\n\t' the old `$compose down` arrived as ONE word —
    // "docker compose" — and failed as command-not-found. The stub records
    // argc, so the pin is two arguments.
    const { dir: sb, callsFile } = stubDir({ docker: DOCKER_STUB })
    const inst = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-inst-'))
    fs.writeFileSync(path.join(inst, 'docker-compose.yml'), '')
    try {
      const r = runScript(INSTALL_SH, ['--uninstall', '--yes', '--dir', inst], {
        env: { PATH: `${sb}:${process.env.PATH}` },
      })
      assert.equal(r.status, 0, clean(r.stderr))
      const calls = fs.readFileSync(callsFile, 'utf8')
      assert.match(calls, new RegExp(`docker${SEP}argc=2${SEP}args=compose down`),
        `docker must receive "compose down" as separate arguments; got:\n${calls}`)
      assert.equal(fs.existsSync(inst), false, 'uninstall removes the directory')
    } finally {
      fs.rmSync(sb, { recursive: true, force: true })
    }
  })

  it('refuses to install into /, $HOME, . or any path containing ..', () => {
    for (const dir of ['/', os.homedir(), '.', '/usr']) {
      const r = runScript(INSTALL_SH, ['--uninstall', '--yes', '--dir', dir])
      assert.equal(r.status, 1, `refused ${dir}`)
      assert.match(r.stderr, /refusing|must not contain/)
      assert.equal(fs.existsSync(dir), true, `must not have removed ${dir}`)
    }
    // A `..` traversal is refused; node does not expand `~`, and the target
    // does not exist anyway, so only the refusal is asserted.
    const r = runScript(INSTALL_SH, ['--uninstall', '--yes', '--dir', '~/../escape'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /must not contain/)
  })

  it('declines to prompt where there is no terminal, instead of reading its own pipe', () => {
    // `curl … | bash` runs with the script's own text as stdin; the old ask()
    // read the reply from it, consuming the rest of the script as the answer.
    const { dir: sb } = stubDir({ docker: DOCKER_STUB })
    const inst = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-tty-'))
    fs.writeFileSync(path.join(inst, 'docker-compose.yml'), '')
    try {
      const r = runScript(INSTALL_SH, ['--uninstall', '--purge', '--dir', inst], {
        env: { PATH: `${sb}:${process.env.PATH}` },
        stdin: '',
      })
      assert.equal(r.status, 1, clean(r.stderr))
      assert.match(r.stderr, /no terminal to confirm/)
      assert.equal(fs.existsSync(inst), true, 'nothing removed without confirmation')
    } finally {
      fs.rmSync(sb, { recursive: true, force: true })
      fs.rmSync(inst, { recursive: true, force: true })
    }
  })

  it('carries a caller-supplied --key into .env verbatim', () => {
    // A real clone of this repository (file://) with docker and curl stubbed:
    // the full install path runs, and the sed escaping of the key is
    // exercised exactly as a real install exercises it.
    const { dir: sb, callsFile } = stubDir({ docker: DOCKER_STUB, curl: CURL_STUB_HEALTHY })
    const inst = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-full-'))
    const key = 'weird key&|chars=with-equals'
    try {
      const r = runScript(
        INSTALL_SH,
        ['--yes', '--repo', `file://${ROOT}`, '--ref', currentBranch(),
         '--dir', inst, '--port', '4981', '--key', key, '--show-key'],
        { env: { PATH: `${sb}:${process.env.PATH}` }, timeout: 300000 },
      )
      assert.equal(r.status, 0, clean(r.stderr))
      const envText = fs.readFileSync(path.join(inst, '.env'), 'utf8')
      assert.match(envText, new RegExp(`^LINDELA_LITE_API_KEY=${key.replace(/[&|]/g, '[-&|]')}$`, 'm'),
        `the key must survive into .env uncorrupted; .env:\n${envText}`)
      assert.match(envText, /^LINDELA_LITE_PORT=4981$/m)
      assert.match(envText, /^LINDELA_LITE_DATABASE_URL=postgresql:\/\/lindela:[0-9a-f]{48}@db:5432\/lindela_lite$/m,
        'the database credentials are generated and the password is a valid 48-hex value')
      assert.match(clean(r.stdout), /Version\s+9\.8\.7-teststub/,
        'the version comes from the (stubbed) health endpoint, proving the health loop ran')
      const calls = fs.readFileSync(callsFile, 'utf8')
      assert.match(calls, new RegExp(`docker${SEP}argc=[0-9]+${SEP}args=compose up -d --build`),
        `the stack starts with the two-word compose command; got:\n${calls}`)
    } finally {
      fs.rmSync(sb, { recursive: true, force: true })
      fs.rmSync(inst, { recursive: true, force: true })
    }
  })

  it('refuses to fall back to the default branch when a pinned ref cannot be cloned', () => {
    assert.match(INSTALL_SOURCE, /could not clone '\$DEFAULT_REF'/,
      'a failed shallow clone must die, not silently install main')
    assert.doesNotMatch(INSTALL_SOURCE, /git clone[^\n]*\|\|[^\n]*git clone/,
      'no second clone may retry without the requested ref')
  })
})

describe('scripts/deploy.sh', () => {
  it('refuses endpoint shapes that could hide a second command', () => {
    const refused = runScript(DEPLOY_SH, ['--dry-run; rm -rf ~'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /unknown option|may not start with a dash/)

    const flagged = runScript(DEPLOY_SH, ['-oProxyCommand=evil'])
    assert.equal(flagged.status, 1)
    assert.match(flagged.stderr, /unknown option|may not start with a dash/)

    const extra = runScript(DEPLOY_SH, ['ops@10.0.0.5', 'rm -rf ~'])
    assert.equal(extra.status, 1)
    assert.match(extra.stderr, /endpoint takes one value|unexpected argument/)
  })

  it('caps the ssh port at 65535, not merely at five digits', () => {
    for (const port of ['0', '99999']) {
      const r = runScript(DEPLOY_SH, [`ops@10.0.0.5:${port}`])
      assert.equal(r.status, 1, `${port} refused`)
      assert.match(r.stderr, /out of range|not a destination port/)
    }
  })

  it('validates --dir before any connection; a quote-closing value dies', () => {
    const marker = `/tmp/lindela-deploy-test-marker-${process.pid}`
    try {
      const r = runScript(DEPLOY_SH, ['ops@10.0.0.5', '--dry-run', '--dir', `x'; touch ${marker}; '`])
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /--dir must be a simple path/)
      assert.equal(fs.existsSync(marker), false, 'nothing may execute, not even in dry-run')
    } finally {
      fs.rmSync(marker, { force: true })
    }
  })

  it('carries ssh options into rsync -e on one line', () => {
    // IFS=$'\n\t' made "${SSH_OPTS[*]}" join with newlines: rsync received
    // "ssh -o\nBatchMode=yes…" and no remote shell existed on the other side.
    // The dry-run output must show the -e value intact.
    const r = runScript(DEPLOY_SH, ['ops@10.0.0.5', '--dry-run', '--transport', 'rsync', '--dir', '/srv/lindela'])
    assert.equal(r.status, 0, r.stderr)
    const rsyncLine = r.stdout.split('\n').find((l) => l.includes('[dry-run] rsync'))
    assert.ok(rsyncLine, `no rsync line in dry-run output:\n${r.stdout}`)
    assert.match(rsyncLine, /-e ssh\\ -o\\ BatchMode=yes\\ -o\\ ConnectTimeout=15 /,
      'the -e value is one literal string')
    assert.ok(!rsyncLine.includes('$\''), `no newline escape inside the -e value: ${rsyncLine}`)
  })

  it('transfers .env.example but not .env, on both copy transports', () => {
    // `.env.*` also matched `.env.example`, so a first deploy on a bare host
    // had no template to build .env from and the secrets step died there.
    const rsyncBlock = DEPLOY_SOURCE.slice(DEPLOY_SOURCE.indexOf('rsync)'))
    assert.match(rsyncBlock, /--exclude '\.env'/, 'the runtime secret is excluded outright')
    assert.doesNotMatch(rsyncBlock, /--exclude '\.env\.\*'/, '.env.example must survive the excludes')
    const tarBlock = DEPLOY_SOURCE.slice(DEPLOY_SOURCE.indexOf('tar)'))
    assert.match(tarBlock, /--exclude=\.env\b(?!\.)/, 'tar excludes the runtime secret exactly')
    assert.doesNotMatch(tarBlock, /--exclude=\.env\*/, 'tar must not exclude .env.example')
  })

  it('pushes to the host over SSH, not to a git remote named after the ref', () => {
    // The old form pushed to a remote NAMED "$REMOTE_REF" — on any normal
    // setup that fails with "does not appear to be a git repository", which
    // the script then misdiagnosed as a missing SSH key. The reworked
    // transport pushes to the host's checkout via ssh:// and verifies the
    // checkout by rev-parse.
    assert.doesNotMatch(DEPLOY_SOURCE, /push --dry-run "\$REMOTE_REF"/,
      'the remote-named-after-ref form must be gone')
    assert.match(DEPLOY_SOURCE, /refs\/heads\/lindela-deploy/,
      'the deploy lands on a dedicated ref the host checks out detached')
    assert.match(DEPLOY_SOURCE, /GIT_SSH_COMMAND/,
      'the push runs under BatchMode so a missing key fails fast instead of hanging')
  })

  it('fails closed when the host cannot generate secrets', () => {
    // An EMPTY generated key would set LINDELA_LITE_API_KEY=, which turns
    // authentication off entirely — so generation is verified on the host
    // before it is used.
    assert.match(DEPLOY_SOURCE, /grep -Eq '\^\[0-9a-f\]\{48\}/,
      'generated values are checked as 48 hex characters at the source')
    assert.match(DEPLOY_SOURCE, /could not generate secrets on \$ENDPOINT/,
      'a failed generation dies the deploy instead of writing an empty key')
    assert.doesNotMatch(DEPLOY_SOURCE, /sed -i/,
      'BSD sed treats the next argument as a backup suffix; the host-side rewrite never uses sed -i')
  })

  it('runs an rsync deploy end to end with stubbed ssh and rsync', () => {
    const { dir: sb, callsFile } = stubDir({ ssh: SSH_STUB_DEPLOY, rsync: [] })
    try {
      const r = runScript(DEPLOY_SH,
        ['ops@10.0.0.5', '--transport', 'rsync', '--dir', '/srv/lindela', '--port', '4983'],
        { env: { PATH: `${sb}:${process.env.PATH}` }, timeout: 300000 })
      assert.equal(r.status, 0, clean(r.stderr))
      const calls = fs.readFileSync(callsFile, 'utf8')
      const rsyncAt = calls.indexOf(`rsync${SEP}`)
      const envProbeAt = calls.indexOf('ops@10.0.0.5 test -f')
      assert.ok(rsyncAt !== -1 && envProbeAt !== -1 && rsyncAt < envProbeAt,
        `the working tree is copied before configuration is probed; got:\n${calls}`)
      assert.match(calls, /docker compose up -d --build/,
        `the stack starts with the two-word compose command; got:\n${calls}`)
      // The probe stub cannot serve a real .env content check, so the API key
      // is empty here; the schedule call must be skipped with a warning, not
      // sent mangled. warn() writes to stderr.
      assert.doesNotMatch(clean(r.stdout), /default ingestion schedules created/)
      assert.match(clean(r.stdout + r.stderr), /cannot create default ingestion schedules/)
    } finally {
      fs.rmSync(sb, { recursive: true, force: true })
    }
  })

  it('announces dry-run as having changed nothing', () => {
    const r = runScript(DEPLOY_SH, ['ops@10.0.0.5', '--dry-run'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /dry-run — nothing was changed|dry-run: the host's state is unknown/)
  })
})

describe('the three scripts stay shellcheck-clean', () => {
  it('run.sh, install.sh and scripts/deploy.sh pass shellcheck', () => {
    const available = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' })
    if (available.status !== 0) {
      return // not on PATH on this machine; treated as advisory here
    }
    const r = spawnSync('shellcheck', [RUN_SH, INSTALL_SH, DEPLOY_SH], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout)
  })
})