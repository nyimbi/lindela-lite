# Handoff prompt — finish the system-audit remediation

> **Historical — the handoff this describes was executed.** Kept as the record of
> what the pass was asked to do. The task list below is stale in one respect worth
> knowing before copying it anywhere: its §4 lists ENH-17 (`partner_org` row
> scoping) as outstanding. That landed on 2026-10-07 — see
> [STATUS-2026-10-05.md](STATUS-2026-10-05.md#2026-10-07--enh-17-landed-and-its-framing-corrected).
> Everything else it lists as open has since been addressed, and the only items
> still open in the audit are R-27/ENH-09 and ENH-12. Do not start from this file;
> start from the audit's own status tables.

Copy everything below the line into the new agent's first message verbatim.

---

You are continuing an in-flight remediation of Lindela Lite at `/Users/nyimbiodero/src/pjs/Lindela-Lite`, branch `fix/storage-and-ingestion-correctness`. The audit you are implementing lives in `docs/improvements/system-audit/` (read 01-remediation.md, 02-enhancements.md, 03-roadmap.md first — every item id below refers there). Progress so far is catalogued in [STATUS-2026-10-05.md](STATUS-2026-10-05.md): 2321 of 2323 tests pass, P0 is mostly done, P1 mostly done, P2/P3/P4 partial.

Work through the tasks **in order**. Each says what done means and how to verify it. After each numbered task: commit (explicit file paths, never `git add -A`) and push. Commit subject = the defect it fixes, in the style of recent history (`git log --oneline -15`), ending with:

```
Co-Authored-By: Claude Code <noreply@anthropic.com>
```

## Non-negotiable rules

1. **Other agents share this working tree.** NEVER run `git checkout`, `git stash`, `git restore`, `git reset`, or `git add -A`. Commit only paths you changed, by name.
2. **Never pipe a verdict through `tail`.** `npm test | tail -20` masks pass/fail. Run `npm test > /tmp/lindela-test.log 2>&1`, then read `grep -E "^ℹ (tests|pass|fail)"` from the log. Same rule for anything whose exit code matters.
3. **Batch testing.** Write tests as you go, but run the suite (or `node scripts/run-gates.mjs --tier self-contained`) after each numbered task, not after each file.
4. **When a test fails because correct code changed its premise,** update the test to assert the invariant the test was protecting, with a comment recording why the old premise is stale. When a test fails because the code is wrong, fix the code. Always say in the commit which one you did and why.
5. **Every automated check must have watched itself fail once** (canary: run it against a known-bad input and confirm exit ≠ 0) before you trust or gate on it.
6. If a fix changes an export, a function signature, or any module you touched, re-run a test that *imports* it — a file that parses but names an unimported symbol fails only at import time.

## §1 Restore green (do this first; nothing else until the suite is green)

### 1a. `test/lite.test.js` — `GET / HTML contains equity panel elements` (~line 2802)

The consoles' four panels are public/panels/equity.html, ingestion.html, reports.html, settings.html, fetched at runtime by `mountPanel` (`public/app.js:3438`; the deferral commit is `a33a1c0`). The test asserts the equity table exists in the `GET /` HTML, which is now stale. Do **not** delete the guard. Rewrite it to assert both halves of the invariant "the equity panel exists somewhere real and is reachable": (i) the equity panel's elements (the ids the test names — the equity table and its container) exist in `public/panels/equity.html`, and (ii) `public/index.html` or `public/app.js` still references that panel by name and path (`grep -n "panels/equity" public/`, and the `mountPanel` dispatch must name it).

### 1b. `test/chw-offline-feedback.test.js` — `names what was actually filed`

The toast ternary now names the noun in **both** branches — `sent?.queued ? t('chw.report_queued', { what: 'symptom report' }) : t('chw.report_sent', { what: 'symptom report' })` — so each noun literal appears 4× per submission (submitOrQueue arg + two toast branches + reportSendFailure arg = 4) and the test, asserting 3, fails. Fix in `public/chw/app.js` (the code, not the test): collapse the duplicated object by moving the branch inside the template choice. In the **symptom** handler (~line 653) and the **incident** handler (~line 762):

```js
showToast(
  t(sent?.queued ? 'chw.report_queued' : 'chw.report_sent', { what: 'symptom report' }),
  sent?.queued ? 'info' : 'ok',
)
```

That lands exactly 3 literals per noun (submitOrQueue arg + one toast + reportSendFailure arg) and changes no behaviour.

**Do NOT hoist the noun**, e.g. `const what = 'symptom report'; submitOrQueue(path, body, { what })`: that leaves only **1** literal per noun, the test's `assert.equal(...?.length, 3)` fails again at a different number, and you have changed more surface than needed.

Leave the **reply** handler (~line 884) alone: it already uses `t('chw.reply_sent')` with no params on the sent branch, so its noun cannot collapse, and the test makes no total-count claim for `'reply'` — only `reportSendFailure(error, 'reply')` must stay exact.

**Verify:** `npm test > /tmp/lindela-test.log 2>&1` → `pass 2323, fail 0`.

## §2 P5 residuals (small, mechanical, each is a commit)

2. **R-62/63 — i18n base layer at boot.** `public/shared/runtime.js` `initI18n` (~line 474) fetches only `/i18n/${defaultLocale}.json`, so a partial locale file booted directly has no English floor — but `set()` re-reads English first, and `scripts/check-i18n-offers.mjs`' justification comment claims that floor exists. Replace the whole body from `const catalog = {}` down to the final `}` of the function with exactly this (keep `t()` and `set()` inside the object unchanged, and keep the three explanatory comments above `set()` untouched):

   ```js
   export async function initI18n(defaultLocale = 'en') {
     const catalog = {}
     const i18n = {
       current: defaultLocale,
       catalog,
       t(key, params = {}) {
         let text = catalog[key] || key
         for (const [name, value] of Object.entries(params)) {
           text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), value)
         }
         return text
       },
       async set(locale) {
         // [leave the existing set() body and its comments exactly as they are]
       },
     }
     // R-62: boot goes through the same two-step as a switch, so English is the
     // base layer even at load and a partial locale file falls back to English
     // rather than to its key ids.
     await i18n.set(defaultLocale)
     window.__i18n = i18n
     return i18n
   }
   ```

   The single observable change a test should catch: `initI18n('so')` on a partial so.json now falls back to English for missing keys. `scripts/check-i18n-offers.mjs`' comment becomes true rather than false after this — do not touch it. Verify: `node --test test/web-chw-offline.test.js` and the i18n describe blocks still pass.

3. **R-65/ENH-41 — precache closure.** `test/web-precache-report.test.js` is a written report with the exact change specified in its header comment (lines 106-135) — use those patterns verbatim:
   ```js
   // In REFERENCE_PATTERNS, after the existing five:
   /(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?[`'"]([^`'"]+)[`'"]\s*\)/g,  // dynamic import, comment-tolerant
   /\blazy\s*\(\s*[`'"]([^`'" ]+)[`'"]\s*\)/g,                                     // the repo's deferred-module helper
   ```
   Both return the path in group 1, which `parseReferences` expects. Add to `BOOTSTRAP_ASSETS`: `/workflow/panel.css`, the ten `/i18n/*.json` entries, and the nine `/panels/*.html` entries (equity, ingestion, reports, settings exist today — list whatever `ls public/panels/` shows; keep the existing four entries). **⚠ After the patterns land, `test/web-precache-report.test.js` will start failing on purpose** — its assertions say so, in their own messages: "R-65 may already be fixed… delete this report rather than leaving it stale". When it fails, that is the designed hand-off: retire the report test file (delete it) and keep a positive guard asserting `shellGraph` reaches `lazy()` targets (the file's last `describe` has the harness for that — move it into a positive test asserting `missing.length === 0`). Then re-run check-i18n and check-budget; record any size impact.

4. **package.json** — add scripts: `"gates": "node scripts/run-gates.mjs --tier self-contained"` and `"gates:browser": "node scripts/run-gates.mjs --tier needs-server"`. Canary both: run them, and confirm each exits non-zero when one constituent gate fails (delete a locale file in a temp copy if needed — do not mutate the real tree for the canary).

5. **Budget.** First load is 12.8 KB over the 148 KB budget (`node scripts/check-budget.mjs` tells you the per-file breakdown). Prefer actual reduction: the four deferred panels moved to `public/panels/*.html`, which should already be off the first-load path — find what is still being counted that does not belong (a stale entry in the gate's file list is a likely candidate) and fix that first. If after honest investigation the budget is genuinely exceeded, raise the recorded budget in `scripts/check-budget.mjs` with a comment stating what the raise bought and why, never silently.

6. **Delete `public/i18n/_deferred/`** — `grep -rn "_deferred" public/ scripts/ test/` shows no loader references it; the real am/fr/pt files live in `public/i18n/`. Then re-run check-i18n.

## §3 P0/P2 finish line (each item: read the audit's evidence column first, then fix, then verify)

7. **R-03** — `docker-compose.yml:59-61`: the scheduler loop `|| true`s over `curl` failures, making 401/500/nothing-due indistinguishable. Capture the response code and body to the loop's stdout with timestamps, distinguish 2xx/4xx/5xx, and keep the loop alive. Canary: point it at a URL that 500s and confirm the log says 500.
8. **R-04 + ENH-06** — `src/rapidpro.js` failed dispatch has no retry, no timer, no self-alert. Implement ENH-06 as the audit specifies: a reconciliation pass in the periodic driver (`startPeriodicDriver` in src/server.js) that finds `alert_events` in `chain_dispatched` with no `rapidpro_dispatches` of `status:'sent'` in the window `src/rapidpro.js:681` computes, and raises one synthetic high alert naming the original — one per original, ever. Tests with a fixture store (see existing test patterns, no mocks).
9. **R-10** — shared-cache leak across tokens. `src/utils.js` `jsonResponse` must emit `Vary: Authorization` (or set-cookie), and the worker's API cache keys must incorporate the auth identity. `test/` has a web suite pattern for sw.js assertions — write the guard before the fix, watch it fail, then fix.
10. **R-13** — `/stac/*` and `/ogc/*` dispatch before `handleApiRequest` in src/server.js (~lines 104-107). Move the auth gate in front of them; redact fields the audit lists from `stacItem`'s spread in `src/stac.js:171`. Verify with a partner-scoped token test.
11. **R-14** — `Dockerfile`: add a non-root `USER`; `.dockerignore` missing `.omc`; confirm `docs/` is either dropped from the runtime image or `/docs` is gated.
12. **R-12** — scheduled retention over `community_feedback` (it is the only PII collection with none): add it to the retention tables the retention route already iterates, and run retention from the periodic driver, not just the POST route.
13. **R-09** — inbound rate limiting. `src/rate-limit.js` currently serves the outbound path. Add an inbound token-bucket middleware keyed on `remoteAddress`/`x-forwarded-for` (bounded trust — spoofable headers only widen, never narrow), returning 429 with Retry-After, exempting health/ready. The earlier full-suite flake (`waits for a token instead of bursting` at 205 s) may be the same limiter mis-keying — when you touch this, investigate `test/rate-limit-wiring.test.js` against `src/connectors/http.js` `fetchWithRetry` and replace real sleeps with a fake clock before trusting timing windows.

## §4 Verify-then-fix list

For each id below: read the item's row in the audit, check whether the cited evidence still holds in the current code, and fix only if it holds. Some of these may already be fixed by commits you didn't make — say so in the commit message of the doc-status update rather than "fixing" a non-defect.

- R-17 (watermark backwards merge), R-18 (store tmp filename keyed on pid only — confirmed still live), R-19 (fetch-recording leak), R-20/R-21/R-22 (outbox retry reset, dispatch mutex, emit-before-merge), R-15 (`isPublicPath` prefix match), R-25 (full-table DELETE+reinsert for one-record edits), R-27 (SQL keyset pagination), R-28 (write-cache invalidation), R-11 (dead outbound limiter call sites), R-53 (schedule-slip metric), R-52 (watermark route — check the obs agent's commits before touching).
- ENH-07 (read() collection manifest), ENH-08 (version history off the default read path), ENH-09, ENH-10 (generated columns for filtered fields), ENH-12 (version-table real columns to completion — compaction already done in this branch), ENH-17 (partner_org row scoping), ENH-36-adjacent gate work already partly shipped.

## §5 P4 veracity core (the largest remaining block; budget ~8 engineer-weeks, do after everything above)

14. **ENH-19 outcome channel** — alert outcomes are recorded end-to-end: an alert that resolves records its own outcome, making calibration estimable. Follow the audit's spec (schema fields, who writes them, sample floors from `src/analytics/metrics.js`).
15. **ENH-20 cluster-interval statistics.** 16. **ENH-23 derived-number reconciliation** (a pass in the driver that recomputes every published derived number the cheap way and compares — a reconciliation script that measures nothing must fail, not report success). 17. **ENH-24 alert derivation.** 18. **ENH-49 history queryable.**

Write tests per item in `test/`, run in batches at each commit boundary.

## §6 Housekeeping, continuously

- After each completed audit item, add a one-line status note to the item in `docs/improvements/system-audit/01-remediation.md` / `02-enhancements.md` (e.g. `**Fixed 2026-10-05** — commit subject`), and update `docs/improvements/status/STATUS-*.md`'s confirmed-done list.
- No mention of UNICEF anywhere in docs or code. No new front-end dependencies (ADR-001). Keep the one-process/one-port/one-table model (ADR-002). Tabs in Python, two-space indent in the JS.
- When you are fully done: the tree is green, `run-gates --tier self-contained` exits 0, and the audit docs' status sections match reality.

## §7 Anti-loop policy — read once now, re-read whenever something misbehaves

**Time budget.** A full `npm test` takes ~3.5 min (one suite exercises 205 s of deliberate wall-clock). Run it **once per numbered §-task**, never per file edit. While working inside a task, run only the affected files: `node --test test/<name>.test.js`.

**Timing flakes.** `fetchWithRetry honours a declared limit → waits for a token instead of bursting` (`test/rate-limit-wiring.test.js:49`) failed one full run (205 s) and passed the next. If it flakes:
- Rerun that one file first (seconds). A failure that disappears in isolation is suite-parallelism pressure, not your bug; move on.
- If it fails in isolation repeatedly, the real suspect is `createRateLimiter`'s permit accounting (`src/connectors/http.js:283`, cached in `limitersByKey`, default `concurrency` 1) — the fix is an injected fake clock (both `now` and `sleep` params already exist on the limiter and on `fetchWithRetry`), never a wider timing window and never deleting the test.

**Designed failures.** Some tests fail on purpose by their own design and say so in their assertion message:
- `test/web-precache-report.test.js` — fails once R-65 lands; its messages tell you to delete the report and keep a positive guard. See §2 item 3.
If your fix is followed by a failure whose message says "R-… may already be fixed in sw.js — delete this report", that message **is** the instruction. Follow it.

**Bounded attempts.** If one fix has not landed after **3 attempts**, stop. Write one paragraph to `docs/improvements/status/STUCK.md` — task, what you tried, what you observed, best hypothesis — commit it, and move to the next task. Returning to it later after other work has changed the surface is a legitimate strategy, not laziness.

**Never solve a problem by:**
- rewriting a test's assertions to match your code's output (the only permitted test edit is recording a stale premise, with a comment saying which invariant survives — see rule 4);
- deleting or skipping a test, or passing `--test-name-pattern` and calling the rest green;
- widening timing windows to make a flake rare instead of making it impossible;
- reverting, stashing or "cleaning up" files you did not write (rule 1 again: other agents share this tree);
- editing a file whose failure you cannot explain. Green you cannot justify is not success.

**Before diagnosing any odd failure** with no obvious cause: run `git status` and `git log --oneline -5`. Another agent may have touched the same file between your edit and your test. If the file's current contents are not yours and you did not write them, do not "fix" them — leave the file, record it in STUCK.md, move on.