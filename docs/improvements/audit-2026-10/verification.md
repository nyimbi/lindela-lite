# Verification and complexity analysis — audit 2026-10

Two things the brief asked for that belong together: the asymptotic cost of every
hot path named in `defects.md`, and how each `file:line` was confirmed.

---

## Asymptotic complexity of the hot paths

`N` is the row count of the collection(s) a request names; `R` the number of active
alert rules; `E` the alert-event history for a rule; `I` the driver-item count (7);
`B` the response byte size.

| Path | Where | Complexity | Bound today | Cost of one call |
|---|---|---|---|---|
| Postgres `read()` | `src/postgres-store.js:267` | O(N) bytes + O(N log N) sort | none — no `LIMIT`, no cursor | materialises every requested row into the heap |
| `filterRecords` | `src/utils.js:207–241` | O(filters × N) allocations, then O(limit) | `limit` ≤ 5000 after the slice | ~18 full-collection passes per request |
| `runPeriodicTick` | `src/server.js:229–263` | O(I × N) | none | ~10+ full-store reads per tick |
| `evaluateAndPersistAlerts` | `src/server.js:3337–3363` | O(raised × N) | none | one read + one merge per raised alert |
| `isSuppressed` | `src/alerts.js` (per rule) | O(R × E) | none | re-filters all events per rule per evaluation |
| `Math.max(...seen)` | `src/alerts.js` | O(E) args | engine argument limit | `RangeError` on a long history |
| `backtestTriggerProtocol` | `src/alerts.js:408–486` | O(runs × hazards) + O(runs × N) | none | `pointInTimeContext` re-scans per run |
| `refreshAnalytics` | `src/analytics.js:226, 283` | O(regions × N) + 2 full reads | none | recomputes 8 derived collections |
| `jsonResponse` | `src/utils.js` | O(B) sync serialize + sha256 | none | full body hash per 200 |
| `sendFile` | `src/server.js:4610, 4624, 4658` | O(B) sync read + sha1 + gzip | none — no gzip cache | blocks the loop per static request |
| `computeApiUptime` | `src/kpi.js:97–102` | O(1) | — | returns 100.0 on zero observations |
| `/ready` | `src/server.js:839, 861` | 2 × O(N) + O(n log n) chain verify | none | paid per readiness poll |

**The two that dominate.** `read()` (unbounded, per request) and `runPeriodicTick`
(7× per tick) multiply: the periodic driver alone is ~10 full-store materialisations
per interval, and every API request adds another. ENH-61 (cursor reads) and ENH-62
(content-addressed derived cache) are the two removals; SCL-01/02/03 are the same
finding from three directions.

**The two that block the event loop.** `sendFile`'s `gzipSync` and `jsonResponse`'s
hash are synchronous CPU on the request path. Under concurrency they serialise; the
async work behind them cannot proceed. A gzip cache and a streaming ETag (hash the
stream, not the buffer) remove both.

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
