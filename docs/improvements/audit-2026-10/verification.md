# Verification and complexity analysis — audit 2026-10

Two things the brief asked for that belong together: the asymptotic cost of every
hot path named in `defects.md`, and how each `file:line` was confirmed.

---

## Asymptotic complexity of the hot paths

`N` is the row count of the collection(s) a request names; `R` the number of active
alert rules; `E` the alert-event history for a rule; `I` the driver-item count (7);
`B` the response byte size.

**Re-measured 2026-10-17.** The `Where` column below was resolved against the tree
at `72a6b63` and every line in it has since moved — the symbols are all still
there, the numbers are not. The `Bound today` column is the audit's before-state,
and **six** of its rows describe a path that has since been fixed: SCL-01 put a row
budget and a cursor on `read()`, CON-05 built the per-rule event grouping once,
ENH-62 keyed the derived collections on the digest of their inputs,
`computeApiUptime` now returns `null` rather than `100.0` on zero observations,
SCL-07 scoped `/ready`'s two whole-store reads to the two collections its rollups
actually read, and SCL-04/05 removed the synchronous compression and hashing this
table called the event-loop blockers. Read the column as *what the bound was*, and
`defects.md` for what it is now.

| Path | Where (symbol; the audit's line) | Complexity | Bound at the audit | Cost of one call |
|---|---|---|---|---|
| Postgres `read()` | `src/postgres-store.js` `#readWith` (was `:267`) | O(N) bytes + O(N log N) sort | **was** none — no `LIMIT`, no cursor | materialised every requested row; now `LIMIT budget + 1` with `iterateRecords` as the cursor |
| `filterRecords` | `src/utils.js:229` (was `:207`) | O(filters × N) allocations, then O(limit) | `limit` ≤ 5000 after the slice | ~18 full-collection passes per request |
| `runPeriodicTick` | `src/server.js:311` (was `:229`) | O(I × N) | **was** none | ~10+ full-store reads per tick; now one read passed down |
| `evaluateAndPersistAlerts` | `src/server.js` `evaluateAndPersistAlerts` | O(raised × N) | none | one read + one merge per raised alert |
| `isSuppressed` | `src/alerts.js:757` (per rule) | O(R × E) | **was** none | re-filtered all events per rule per evaluation; now a `Map` built once |
| `Math.max(...seen)` | `src/alerts.js` | O(E) args | engine argument limit | `RangeError` on a long history — the spread is gone |
| `backtestTriggerProtocol` | `src/alerts.js:449` (was `:408`) | O(runs × hazards) + O(runs × N) | none | `pointInTimeContext` re-scans per run |
| `refreshAnalytics` | `src/analytics.js:403` (was `:226, 283`) | O(regions × N) + 2 full reads | **was** none | recomputed 8 derived collections; now only those whose input digest moved |
| `jsonResponse` | `src/utils.js:747` | O(B) sync serialize + sha256 | none | full body hash per 200 |
| `sendFile` | `src/server.js:1473` `sendFile` / `preparedStatic` | O(B) sync read + sha1 + gzip | none — no gzip cache | blocks the loop per static request |
| `computeApiUptime` | `src/kpi.js:174` (was `:97`) | O(1) | — | returned `100.0` on zero observations; returns `null` now |
| `/ready` | `src/routes/liveness.js` `handleLivenessRoute` (was `src/server.js:839, 861`) | 2 × O(N) + O(n log n) chain verify | **was** none | was two whole-store reads + a chain verify per poll; now one scoped read of the two collections its rollups name |

**The two that dominated.** `read()` (unbounded, per request) and `runPeriodicTick`
(7× per tick) multiplied: the periodic driver alone was ~10 full-store
materialisations per interval, and every API request added another. ENH-61 (cursor
reads) and ENH-62 (content-addressed derived cache) are the two removals; SCL-01/02/03
are the same finding from three directions. Both have landed.

**The two that blocked the event loop, and both were fixed.** `sendFile`'s
`gzipSync` and `jsonResponse`'s hash were synchronous CPU on the request path, and
under concurrency they serialised. SCL-04 added a `(path, mtime, size)`-keyed
compression cache — keyed on mtime rather than the path alone, because a deploy
rewrites the files under a process that runs for weeks — and SCL-05 moved the hash
behind `conditionable`, which is `status === 200` on a GET or HEAD, the only
requests a conditional request is defined for. The two are not the same fix and the
table named them as one: the cache removes repeat work, the guard removes work
nobody could have used. **SCL-05's own entry in `defects.md` said the fix was a
cache, and there is none** — corrected there, because a fix note naming a mechanism
that was never built sends the next reader looking for it.

**What is left of this table is the structural half**, and it is the half no cache
touches: `filterRecords`' ~18 full-collection passes per request, `jsonResponse`'s
synchronous `JSON.stringify` on every 200, and the `read()` budget that turns a
large store into a refusal rather than a slow answer.

---

## How the line numbers were confirmed

Every `file:line` in `defects.md` was re-resolved against the tree at commit
`72a6b63` with `rg -n <pattern> <file>` and the matched line read back. The audit
notes were treated as hypotheses, not sources: where a note's line had drifted (the
precip `reduce` note said `:444`; the tree says `:452`; `monthHasFlood` said `:194`,
tree `:194` confirmed), the verified line is used.

The four domain audits ran as parallel agents with read-only tools. Their headline
claims were spot-checked against source before being written down — for example,
VUL-01 was confirmed by grepping `assertSafeWebhookUrl` across `src/server.js` and
finding it absent, and by reading `normalizeDistributionChannels` (`:3030`) to see
`channel.url` pass through unvalidated.

**What was not verified and is marked as such.** The CI supply-chain findings
(VUL-05/06) cite workflow and Dockerfile lines that were read but whose *runtime*
effect (a compromised tag executing) was not reproduced. They are stated as the
configuration fact they are, not as an observed exploit.

---

## The audit's own instrument was defective

`docs/improvements/status.md` reported the state of the first audit's thirty
enhancements. Its tables were computed from `_status-*.json`; its prose was a string
literal typed once and re-emitted verbatim. By the time this audit read it, the
prose asserted "the other four are still exported, tested and called by nothing"
for four modules of which three had production callers, and named six guard test
files that had been renamed out of existence.

That is the exact failure class this audit catalogues elsewhere: a check that reports
without measuring. It is recorded here because the lesson generalises — a generated
artifact whose narrative is not derived from its data is a claim wearing a
measurement's clothes, and it will be read as verified.

**Fixed** in `72a6b63`: the generator derives its narrative, resolves every reference
against the tree, fails on a broken reference, and is guarded by
`test/enhancement-status.test.js`, whose canary watches the call-site scanner fail on
a module reached only through `lazy()` — because a scanner that returns `[]` for both
"no callers" and "I never ran" is not a measurement.

---

## Reproducing the baseline

```bash
node --test test/*.test.js          # 2872 pass, 0 fail at 72a6b63
node scripts/run-gates.mjs --tier self-contained   # 7/7
node docs/improvements/_build-status.mjs           # regenerates status.md; exit 1 on drift
```

The browser tier (`--tier needs-browser`) needs Chrome on `:9222` and a server on
`:4177`; it was not run for this audit, which is a documentation change.
