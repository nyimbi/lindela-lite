#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ENH-78 — every outbound fetch says where its URL came from.
 *
 * VUL-01 was a CRITICAL SSRF: `POST /api/v1/reports/:id/distribute` fetched
 * `channel.url` straight from the request body. `assertSafeWebhookUrl` existed,
 * was correct, and was applied to webhook subscriptions only — the distribution
 * path fetched the same class of caller-supplied URL with no guard at all. The
 * fix added one call site. The *class* is what keeps recurring: a URL the server
 * will fetch, whose origin is the caller.
 *
 * A guard that exists at 1 of N paths is the 19-of-27-paths failure this
 * repository keeps finding. So this gate does not re-check the SSRF predicate —
 * `test/distribution-ssrf.test.js` and `test/webhook-security.test.js` drive that
 * against a live server. It checks the thing that decides whether those tests
 * could ever cover the next path: **is every `fetch(` in `src/` reached by a URL
 * whose origin is stated?**
 *
 * A site is clean when one of these holds, checked on the site and the two lines
 * above it:
 *
 *   1. It names a guard: `assertSafeWebhookUrl`, `assertSafeOutboundUrl`,
 *      `checkWebhookUrl`, `checkUrl`, `guardedFetch`, `safeFetch`.
 *   2. It carries a marker: `caller-url-ok: <reason>`. The reason is required —
 *      a bare marker is a decision nobody can review, and is refused. The reason
 *      `guarded-by-caller` is special: it is a claim that the caller guards the
 *      URL, and it is honoured only when the same file names a guard. That keeps
 *      the claim falsifiable, which a plain marker at a helper defined above its
 *      guarded caller would not be.
 *   3. Its URL is not caller-supplied at all. The gate cannot know this by
 *      reading one line, so the *caller-supplied* sites are the ones it knows to
 *      look for: a URL built from a request body, a `request.` field, or a
 *      parameter named `url` that arrives from outside.
 *
 * **Why the marker and not a heuristic.** Distinguishing "this URL came from the
 * request body" from "this URL is a constant" by regex is not possible; doing it
 * by AST is not possible without a type system. So the gate takes the reading
 * the repository already uses for the absent-value class: a site that is
 * genuinely safe says so, in a line naming why, and the line is what a reviewer
 * reads. That converts a silent judgement into a visible one, which is the whole
 * of what a security regression spec can do for a class rather than an instance.
 *
 * The connectors are the interesting jurisdiction, and the reason the marker
 * exists rather than a blanket rule. A DHIS2 instance or an IoT gateway is often
 * legitimately on the operator's own LAN, so a guard that refused RFC-1918 there
 * would break real deployments — the "gate scoped wider than its jurisdiction"
 * failure. Those sites carry a marker naming that, and the marker is the record
 * that the exception was considered rather than missed.
 *
 * Exit 0 when every site is accounted for, 1 with the sites listed. Canaried in
 * `--self-test`.
 *
 * An optional root argument scans a copy of the tree instead. The canaries in
 * `test/outbound-fetch.test.js` remove a guard from `src/` and require this gate
 * to fail — and a test that edits a tracked file makes every other test's result
 * a function of scheduling, because `node --test` runs files in parallel workers
 * over one tree and Node caches a module at first import. QUA-08 was that defect
 * for a served asset; this is the same class on `src/`. argv rather than an
 * environment variable: a stray variable in a shell would silently scan the
 * wrong tree and print `clean`.
 */

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['src']
const SCAN_EXT = /\.(js|mjs)$/
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '.git'])

/** A call that fetches. `fetch(` and the wrapper the connectors use. */
const FETCH_CALL = /\b(?:globalThis\.)?fetch\s*\(/

/**
 * A guard named on the site or just above it. Naming the predicate is what makes
 * a site clean without a marker — the guard is the statement.
 */
const GUARD = /\b(assertSafeWebhookUrl|assertSafeOutboundUrl|assertConnectorUrl|checkWebhookUrl|checkUrl|guardedFetch|safeFetch|safeOutboundFetch)\b/

/**
 * The marker. `caller-url-ok:` followed by a reason. Requiring the reason is the
 * value: an exemption with no reason cannot be told from a mistake someone
 * silenced.
 */
const ALLOW = /caller-url-ok:\s*\S/

/**
 * The marker whose reason is a claim the gate can check: *the caller guards this
 * URL before handing it here*.
 *
 * This exists because the fetch helper is routinely defined **above** the entry
 * point that guards it — `fetchDataValueSet` sits at `dhis2.js:88` and its
 * guarded caller at `:133` — so a window reaching upward from the fetch can
 * never see the guard. A plain marker would then be unfalsifiable: delete the
 * guard and the marker still excuses the site.
 *
 * So this marker binds the file: it is only honoured when the same file names a
 * guard. The claim becomes checkable at the scope where it is actually true
 * (the module), and a marker whose guard was removed fails the gate rather than
 * covering for it.
 */
const CALLER_GUARDED = /caller-url-ok:\s*guarded-by-caller\b/

/**
 * The URL is caller-supplied: it is built from a request body, a `request.`
 * field, or a parameter named `url`/`base_url`/`endpoint`. This only labels a
 * finding for the reader — the finding is raised either way, because "the URL is
 * a variable" is exactly the state VUL-01 was in before anyone checked where the
 * variable came from.
 */
const CALLER_URL = /\b(request|body|input|payload)\??\.\s*(base_url|url|endpoint|webhook_url|callback_url)\b/

/** A literal URL — `fetch('https://…')` — is not caller-supplied. */
const LITERAL_URL = /fetch\s*\(\s*['"`]https?:\/\//

/**
 * Blank out comments, keeping every newline so line numbers stay aligned.
 *
 * Both comment forms matter, and the block form is the one that bit: a JSDoc
 * block above a helper names the guard it documents, so stripping only `//`
 * left `assertConnectorUrl` visible in the guard test and a fetch with its real
 * guard deleted still passed. Canary G covered the line-comment case and the
 * gate was blind to the block-comment one — a gate scoped to the instance, not
 * the class. A guard named in a comment of either form is not a guard.
 */
function stripComments(source) {
  let out = ''
  let quote = null
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (quote) {
      out += ch
      if (ch === '\\') { out += source[i + 1] ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * The lines a guard or marker may sit on.
 *
 * A fixed window above the fetch, bounded at `CONTEXT_LINES`. A guard is applied
 * near the URL construction or just before the fetch, and `src/outbox.js` puts
 * `await checkUrl(webhook.url)` five lines above the `fetch`, past a blank line
 * and a `setTimeout`. A one-or-two-line window misses it, and a gate that reports
 * a guarded site as unguarded is a gate whose findings nobody trusts.
 *
 * The bound is what keeps a marker from reaching up the file to excuse a site it
 * was never about. The window is not stopped at blank lines because the statement
 * a guard sits in is routinely separated from the fetch by one, and a marker
 * still has to name a reason, which is the part that makes it reviewable.
 */
const CONTEXT_LINES = 14

function contextLines(lines, index) {
  const parts = [lines[index]]
  for (let i = index - 1, seen = 0; i >= 0 && seen < CONTEXT_LINES; i -= 1, seen += 1) {
    parts.unshift(lines[i])
  }
  return parts.join('\n')
}

/**
 * An `import`/`export … from` line, which names symbols without running them.
 *
 * This exists because a file that imports the guard satisfies a naive search for
 * the guard's name — and an import is exactly what a file has when it *stopped*
 * calling the guard. The canary for the `guarded-by-caller` rule passed against
 * a real file whose guard had been deleted, because the import line still named
 * `assertConnectorUrl`. An import is a name, not a call.
 */
const IMPORT_LINE = /^\s*(?:import|export)\b/

/** Recursively list scannable files under a directory. */
function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, out)
    else if (SCAN_EXT.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Scan one source string. Exported so the canaries drive it with text rather
 * than with files — a canary that writes files is a canary that can corrupt the
 * tree it is testing.
 */
export function scanSource(source, { file = '<memory>' } = {}) {
  // Two aligned views of the same file. `codeLines` is the source with every
  // comment blanked, so a guard can only be found where a guard can run;
  // `rawLines` is untouched, because the marker *is* a comment and stripping is
  // exactly what erases it. Both keep their newlines, so line numbers agree.
  const rawLines = source.split('\n')
  // Import and export lines are blanked as well as comments: a file that
  // *stopped* calling the guard still imports it, so counting the import would
  // let every site in the file pass on a name that never runs. An import is a
  // name, not a call. Blanked rather than dropped so line numbers stay aligned.
  const codeLines = stripComments(source).split('\n')
    .map((line) => (IMPORT_LINE.test(line) ? '' : line))
  // The whole-file guard search that makes `guarded-by-caller` falsifiable.
  const guardedInFile = codeLines.some((line) => GUARD.test(line))
  const findings = []
  for (let i = 0; i < codeLines.length; i += 1) {
    const code = codeLines[i]
    if (!FETCH_CALL.test(code)) continue
    // A literal URL cannot be caller-supplied, and is the common case.
    if (LITERAL_URL.test(code)) continue
    // The guard is read from code: a guard named in a comment is not a guard,
    // and a marker's own reason names the guard it claims — matching raw lines
    // would let every `guarded-by-caller` marker prove its own claim.
    if (GUARD.test(contextLines(codeLines, i))) continue
    const raw = contextLines(rawLines, i)
    if (ALLOW.test(raw)) {
      // A bare marker is a stated decision. A `guarded-by-caller` marker is a
      // claim, and the claim is only honoured when the file actually guards.
      if (!CALLER_GUARDED.test(raw) || guardedInFile) continue
    }
    // Not a caller URL and not a literal: a variable whose origin the gate
    // cannot see from here. Reported, because "the URL is a variable" is exactly
    // the state VUL-01 was in before anyone checked where the variable came from.
    findings.push({
      file,
      line: i + 1,
      text: rawLines[i].trim(),
      caller: CALLER_URL.test(raw),
      // Named so the operator's fix is the one the message asks for.
      reason: CALLER_GUARDED.test(raw)
        ? 'the site claims its caller guards the URL, but this file names no guard'
        : null,
    })
  }
  return findings
}

/** Scan the tree. */
export function scanTree(root = ROOT) {
  const findings = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir)
    if (!fs.existsSync(full)) continue
    for (const file of filesUnder(full)) {
      const rel = path.relative(root, file)
      findings.push(...scanSource(fs.readFileSync(file, 'utf8'), { file: rel }))
    }
  }
  return findings
}

/**
 * Canaries. Each is a case the gate must get right, run in `--self-test` and in
 * the test file. The first two are the defect and its fix side by side — the
 * VUL-01 shape and the guard that closes it.
 */
export const CANARIES = [
  {
    name: 'A: flags an unguarded fetch of a caller-supplied URL — the VUL-01 shape',
    source: [
      'const target = required(channel.url, "url")',
      'const response = await fetch(target, { method: "POST" })',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'B: passes the same fetch once the guard names itself',
    source: [
      'const target = await checkWebhookUrl(channel.url)',
      'const response = await fetch(target, { method: "POST" })',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'C: passes a fetch of a literal URL, which cannot be caller-supplied',
    source: 'const response = await fetch("https://api.example.org/v1/events")',
    expect: 0,
  },
  {
    name: 'D: flags a fetch of a bare variable with no guard named',
    source: [
      'const url = `${base}/api/dataValueSets`',
      'const payload = await fetch(url, { headers })',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'E: honours a marker that names why the URL is not caller-supplied',
    source: [
      '// caller-url-ok: the DHIS2 instance root is operator configuration, and a',
      '// national instance is legitimately on the operator LAN, so no SSRF guard',
      'const response = await fetch(url, { headers })',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'F: does not honour a bare marker with no reason',
    source: [
      'const response = await fetch(url, { headers }) // caller-url-ok:',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'G: does not flag the fetch named in a comment',
    source: [
      '// this used to be `await fetch(channel.url)` with no guard at all',
      'const target = await assertSafeWebhookUrl(channel.url)',
      'const response = await fetch(target)',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'H: is not fooled by // inside a string, and still sees the fetch after it',
    source: [
      'const doc = "see https://example.test/x for the shape"',
      'const response = await fetch(target, { method: "POST" })',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'I: honours `guarded-by-caller` when the same file names the guard',
    source: [
      'async function fetchPage(url) {',
      '  // caller-url-ok: guarded-by-caller — ingest() runs assertConnectorUrl first',
      '  return fetch(url, { signal })',
      '}',
      'export async function ingest(request) {',
      '  assertConnectorUrl(request.base_url)',
      '  return fetchPage(request.base_url)',
      '}',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'J: refuses `guarded-by-caller` once the guard is deleted from the file',
    source: [
      'async function fetchPage(url) {',
      '  // caller-url-ok: guarded-by-caller — ingest() runs assertConnectorUrl first',
      '  return fetch(url, { signal })',
      '}',
      'export async function ingest(request) {',
      '  return fetchPage(request.base_url)',
      '}',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'K: still honours a plain marker naming a reason the gate cannot check',
    source: [
      '// caller-url-ok: the RapidPro root is operator config (RAPIDPRO_BASE_URL),',
      '// never a request field, so no caller can steer this fetch',
      'const response = await fetch(url, { method: "POST", body })',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'L: does not let a JSDoc block naming the guard excuse an unguarded fetch',
    source: [
      '/**',
      ' * Guarded by assertConnectorUrl at the call site, documented here.',
      ' */',
      'async function fetchPage(url) {',
      '  return fetch(url, { signal })',
      '}',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'M: `/*` inside a string does not open a comment that swallows the file',
    source: [
      'const doc = "the /* marker is a literal here"',
      'const response = await fetch(target, { method: "POST" })',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'N: an import of the guard is not a call to it, so the claim still fails',
    source: [
      'import { assertConnectorUrl } from "../webhooks.js"',
      'async function fetchPage(url) {',
      '  // caller-url-ok: guarded-by-caller — ingest() runs assertConnectorUrl first',
      '  return fetch(url, { signal })',
      '}',
    ].join('\n'),
    expect: 1,
  },
]

function selfTest() {
  let failed = 0
  for (const canary of CANARIES) {
    const got = scanSource(canary.source).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  const real = scanTree(ROOT)
  console.log(`${real.length === 0 ? 'ok  ' : 'FAIL'} the tree is clean — ${real.length} finding(s)`)
  if (real.length) failed += 1
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())
  const findings = scanTree(ROOT)
  if (findings.length === 0) {
    console.log('outbound-fetch check: clean')
    process.exit(0)
  }
  console.error(`outbound-fetch check: ${findings.length} fetch site(s) whose URL origin is not stated\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}${f.caller ? '  [caller-supplied URL]' : ''}`)
    console.error(`    ${f.text}`)
    if (f.reason) console.error(`    → ${f.reason}`)
  }
  console.error('\nName the guard on the site (`checkWebhookUrl(url)`), or mark it')
  console.error('`caller-url-ok: <reason>` when the URL is not caller-supplied — operator')
  console.error('configuration, or a connector endpoint that is legitimately on the LAN.')
  process.exit(1)
}
