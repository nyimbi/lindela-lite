# Roadmap

Six phases over **~31 engineer-weeks**. Sequencing is not a preference: four items are
unsafe to land before another, and one is unsafe to land *without* it.

| | Phases |
|---|---|
| **P0** | Restore the core loop — 6 weeks, 1 engineer |
| **P1** | The store stops being materialised per request — 5 weeks, 1 engineer |
| **P2** | Enforcement becomes a property — 4 weeks, 1 engineer |
| **P3** | Interruptible, parallel, bounded ingestion — 5 weeks, 1 engineer |
| **P4** | Veracity: closing the loop — 8 weeks, 2 engineers |
| **P5** | Client system and cognitive efficacy — 3 weeks, 1 engineer |

Total 31 engineer-weeks. With two engineers, P0+P1 run in parallel from day one and
the critical path is **P0 → P3 → P4 ≈ 19 weeks**; with one, ~31.

---

## Dependency graph

```
                        ┌──────────────────────────────────────┐
                        │ R-01  service worker cannot install  │
                        └──────────────────┬───────────────────┘
                                           │ required by
   R-06 partner scoping ──────────► ENH-07 read() manifest
   R-02 alert eval ────────────────► ENH-04 pipeline raises alerts
   R-03 scheduler || true ─────────► ENH-05 in-process driver
   R-05 no partial persistence ─────► ENH-25 per-source commits
   R-16 idempotency not claimed ────► ENH-28 claim before running
   R-19 captureBody cross-writes ───► ENH-26 bounded parallelism
   R-09 no inbound limiter ─────────► ENH-16 inbound cost bounded
   R-42 assertions never run ───────► ENH-48 assertions actually run
   R-76 7 gates never in CI ─────────► ENH-43 gates run every push
   R-01 worker cannot install ───────► ENH-41 precache covers lazy graph
                                           │
                                           ▼
   P0 ──────────────────────────────────────────────────────────────
   ENH-01 field app works offline ──┬──► ENH-03 one queue, one drainer
   ENH-02 exactly-once delivery ────┘
   ENH-04 pipeline raises alerts ◄── ENH-05 driver
   ENH-05 driver ──┬──► ENH-06 delivery SLA
                  ├──► ENH-30 liveness that means it
                  ├──► ENH-18 scheduled retention
                  └──► ENH-35 watermarks + audit chain visible
   ENH-13 json store no-indent/stamp ───────────────────────────────► P1
   P1 ──────────────────────────────────────────────────────────────
   ENH-08 history off read path ──┬──► ENH-49 history queryable
   ENH-11 writes stop reading ────┤
   ENH-10 generated columns ──────┼──► ENH-09 keyset pagination
   ENH-07 read() manifest ────────┘        │
   ENH-12 version table columns ───────────┘
   P2 ──────────────────────────────────────────────────────────────
   ENH-14 scoping from request ──┬──► ENH-17 partner_org + predicate
   ENH-15 read fallback denial ──┘
   ENH-16 inbound cost bounded
   P3 ──────────────────────────────────────────────────────────────
   ENH-25 per-source commits ──┬──► ENH-26 bounded parallelism
                               ├──► ENH-27 resumable backfill
   ENH-28 idempotency claimed ─┘
   ENH-29 limiter declared everywhere
   P4 ──────────────────────────────────────────────────────────────
   ENH-19 outcome channel ──┬──► ENH-20 cluster intervals
                           ├──► ENH-21 sample floors
                           ├──► ENH-23 reconcile derived numbers
                           ├──► ENH-24 alert derivation
   ENH-22 empty-200 ≠ quiet ─┘
   ENH-49 history queryable ───► ENH-50 composition
   P5 ──────────────────────────────────────────────────────────────
   ENH-43 gates every push ──┬──► everything else in P5
   ENH-36 browser harness ───┴──► ENH-37/38/39/47
   ENH-37 console states  ENH-38 one locale  ENH-39 one component layer
   ENH-40 identity cache  ENH-41 precache  ENH-42 version handshake
   ENH-45 per-surface budgets  ENH-46 defer dead panels
```

## The critical path

```
R-01 ──► ENH-01 ──► ENH-03 ──► P0 done
R-05 ──► ENH-25 ──► ENH-26 ──► P3 done ──► ENH-19 ──► ENH-20/21/23/24 ──► P4 done
                                                      ▲
                                          ENH-08 ─────┘ (ENH-49 needs history queryable)
```

**19 weeks with two engineers.** The path runs through the store twice, and that is
the constraint: ENH-25 and ENH-26 are cheap and safe only after P1 removes the
whole-store write, and P4's best item needs ENH-49 which needs P1's ENH-08.

## The four sequencing constraints that are not negotiable

**1. R-01 before ENH-40.** Making the service worker installable switches on a 7-day
`detail-v1` cache that includes unredacted `community_feedback` narrative, keyed on
URL with no `Vary` on authorization. On a shared district laptop that is org A's
narrative served to org B. **Do not fix the worker without the identity-scoped cache.**

**2. R-01 before ENH-03.** Fixing the registration activates two independent queue
drains (`flush()` and `replayQueue()`) that both `getAll()` and `delete` with no
claim and no idempotency key. ENH-02 then ENH-03 must land in the same change as R-01,
or a health worker gets duplicate field reports.

**3. R-06 before ENH-07.** Turning `read()` into a manifest formalises what each route
touches. If the three unscoping handlers are still in place, the manifest institutionalises
the leak into a shape that looks deliberate.

**4. R-19 before ENH-26.** `captureBody` pushes into every live recording. Any source
parallelism and every lineage row's `upstream_url_or_endpoint` is another source's URL.

## Resource allocation

| Phase | Weeks | Engineer | Focus | Definition of done |
|---|---|---|---|---|
| **P0** | 6 | 1 | Client offline correctness + the alert loop | A service worker registers in a browser; a week of offline reports reaches the server exactly once; a scheduled cycle raises an alert when a threshold crosses; a failed dispatch raises an alert about itself |
| **P1** | 5 | 1 | Storage | `read()` takes a manifest; a request transfers one collection, not the store; a write no longer reads the whole table; the version table is off the default read path |
| **P2** | 4 | 1 | Authorisation | Every route derives the caller's partner organisation from the request; an unmapped read is denied; every route has an inbound budget; retention runs on a schedule over every PII collection |
| **P3** | 5 | 1 | Ingestion | A killed run loses at most one source; 9 sources run with bounded concurrency; a killed backfill resumes from its cursor |
| **P4** | 8 | 2 | Veracity | Outcomes are recorded; calibration is estimable; a district rate below the sample floor cannot be produced by any consumer |
| **P5** | 3 | 1 | Client + gates | Every gate runs on every push; the front end is testable in Node; the console's alert rail cannot claim an unearned negative |

**P0 takes one engineer and no dependencies** — it can start today, and it is the
phase that makes the product what it says it is. P1 is independent and parallelisable.
P2 is independent of P1 and P3. P5 is independent of everything except that its gate
work benefits from being done early.

**P4 is the only phase that needs two engineers, and it is the only phase where
stopping partway leaves the system no worse than it started.** P5's gate work (ENH-43)
should be pulled *forward* into P0 — it is half a day and it is what stops the
`hidden`-defeating-`display` class from shipping a fourth time.

---

## What each phase makes newly possible

| Phase | Unlocks |
|---|---|
| **P0** | A health worker can file for a week with no connectivity and be believed. A threshold crossing alerts without a human. A deployment that is down says so. |
| **P1** | The store can grow past a laptop. Per-collection cost replaces whole-store cost, so the storage model stops being the thing that dictates whether a deployment is viable. |
| **P2** | Organisations working the same response stop reading each other's field reports. Today it is not a configuration; it is a decision not to route `auth` on three handlers. (Not multi-tenant hosting — see the correction under ENH-17 in `02-enhancements.md`.) |
| **P3** | Runs become interruptible and resumable. A 4.2-hour archive crawl is no longer an all-or-nothing gamble, and adding sources stops costing wall-clock linearly. |
| **P4** | Calibration becomes estimable. Today every calibration surface reports "not measurable" because nothing reports outcomes — this is the item that makes the honesty discipline *productive* rather than purely defensive. |
| **P5** | The front end is testable without a browser, and a defect that needs a browser to find is one that will be found. |

## What is deliberately not on this roadmap

- **Reversing ADR-002** (one JSONB table). Every proposal above works within it. A
  relational schema would make some queries faster and would end the deployment
  story — a district-office server with one process and one port.
- **Reversing ADR-012** (eight separate surfaces). ENH-39 shares a component layer
  across them; merging them would destroy the CHW app's deliberate divergence.
- **Reversing ADR-001** (zero front-end dependencies). ENH-36 makes the existing code
  testable rather than replacing it with a framework that would be.
- **A message broker, cache tier, or service mesh.** ADR-009's sidecar and the
  in-process driver in ENH-05 cover the periodic work; the data volume does not yet
  justify more, and P1 removes the reason it appeared necessary.