# Handoff prompt — finish the system-audit remediation

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

The console agent deferred four rail panels out of `public/index.html` into `public/panels/*.html`, loaded at runtime by `mountPanel`. The test asserts the equity table exists in the `GET /` HTML, which is now stale. Do **not** delete the guard. Rewrite it: fetch the panel source from `public/panels/` (the way the tests in `test/` already read surface files) and assert (i) the equity panel's elements exist at its new location, and (ii) `index.html`/`app.js` still wires the panel in (`mountPanel` call for it, or the panel id appears in a load path). The invariant is "the equity panel exists somewhere real and is reachable", not "it inlines in index.html".

### 1b. `test/chw-offline-feedback.test.js` — `names what was actually filed`

The toast ternary now repeats the noun: `sent?.queued ? t('chw.report_queued', { what: 'symptom report' }) : t('chw.report_sent', { what: 'symptom report' })` — so each noun appears 4× per submission (submitOrQueue arg + two toast branches + reportSendFailure arg = 4) and the test, which asserts 3, fails. Fix in `public/chw/app.js` (the code, not the test): each of the three submission handlers should hold the noun once, e.g.

```js
const what = 'symptom report'
const sent = await submitOrQueue('/api/v1/chw/report', body, { what })
showToast(
  sent?.queued ? t('chw.report_queued', { what }) : t('chw.report_sent', { what }),
  sent?.queued ? 'info' : 'ok',
)
...
reportSendFailure(error, what)
```

That satisfies the test's own invariant — "one sentence per noun per outcome" — rather than weakening the counts. Keep the toast on both branches (queued = 'info', sent = 'ok'); a queued report that says nothing is the defect a previous commit existed to fix (`98e1d53`).

**Verify:** `npm test > /tmp/lindela-test.log 2>&1` → `pass 2323, fail 0`.

## §2 P5 residuals (small, mechanical, each is a commit)

2. **R-62/63 — i18n base layer at boot.** `public/shared/runtime.js` `initI18n` (~line 474) fetches only `/i18n/${defaultLocale}.json`. A partial locale file therefore has no English floor, though `set()` correctly re-reads English first, and `scripts/check-i18n-offers.mjs`' justification comment claims the floor exists. Fix: after building the `i18n` object, route boot through the same two-step as `set()` — simplest correct form: delete the catalog-building block from `initI18n`, and at the end of it call `await i18n.set(defaultLocale)` before returning (keep the `applyI18n()` + `window.__i18n` wiring, and make `t()`'s `window.__i18n` guard order still safe). Then delete the now-false justification about fallback if the code contradicts it. Verify: `test/web-chw-offline.test.js` and any i18n test still pass.

3. **R-65/ENH-41 — precache closure.** In `public/sw.js` `REFERENCE_PATTERNS` (~line 224) add two patterns: a comment-tolerant dynamic `import(...)` call and a `lazy(...)` call (look at how `public/shared/app.js` and the panels load things dynamically — `grep -n "lazy(" public/`, `grep -n "await import(" public/`). Add to `BOOTSTRAP_ASSETS`: `/workflow/panel.css`, the ten `/i18n/*.json`, and the nine `/panels/*.html` (list them; keep the existing four entries). Update `test/sw-precache.test.js` (or the WEB-06 test) — the closure count it records will grow from 45; it asserts the number with reasoning, so update both number and reasoning, and confirm by running the test. Then re-check the budget gate (`node scripts/check-budget.mjs`) because precached size may matter to it — record any impact.

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