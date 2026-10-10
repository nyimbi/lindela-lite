# Phased roadmap — audit 2026-10

Fifty enhancements (`ENH-31..80`) and sixty-eight defects (`VUL/VER/CON/SCL/OBS/ARC/CAP/QUA`)
do not all ship at once. This sequences them by dependency, marks the critical path,
and allocates the two scarce resources: engineering weeks and reviewer attention.

Effort is in engineering-weeks at the current team size (1 ≈ days, 5 ≈ a quarter),
carried from `enhancements-50.md`.

---

## The dependency graph

An edge `A → B` means B cannot start until A lands. Only real dependencies are
drawn; items not listed as a predecessor can run in parallel.

```
                         ┌──────────────────────────────────────────────┐
                         │  Phase 0 — stop the bleeding (defects only)   │
                         └──────────────────────────────────────────────┘
  VUL-01 (SSRF)   VUL-02   VER-03   VER-05   VER-06   OBS-01   OBS-02   ARC-11
      │                                                        │
      └────────────────────────────┬───────────────────────────┘
                                    ▼
                         ┌──────────────────────────────────────────────┐
                         │  Phase 1 — the substrate everything rides on  │
                         └──────────────────────────────────────────────┘
      ENH-59 (route table) ──► ENH-60 (router extraction)
              │                        │
              │                        ▼
              │              ENH-64 (request id) ──► OBS-03
              │
      ENH-61 (streaming reads) ──► ENH-37 (bulk export) ──► ENH-31 (HXL) ──► ENH-32 (DHIS2 push)
              │                              │
              ▼                              ▼
      SCL-01/02/03 fixed              ENH-34 (versioned datasets) ──► ENH-48 (provenance stamps)
                                             │
      ENH-65 (per-server state) ──► QUA-01 ─┘
      ENH-63 (durable idempotency) ──► CON-01, CON-06, CON-07

                         ┌──────────────────────────────────────────────┐
                         │  Phase 2 — veracity engine + interop         │
                         └──────────────────────────────────────────────┘
      ENH-45 (aggregation kinds) ──► VER-01
      ENH-46 (absent-value gate) ──► VER-02, VER-12
      ENH-49 (contingency monitor) ──► VER-03 (regression)
      ENH-33 (org-unit registry) ──► ENH-57 (role briefings), ENH-69 (triage)
      ENH-50 (model-card registry) ──► ENH-54 (value of information)

                         ┌──────────────────────────────────────────────┐
                         │  Phase 3 — field system + decisions          │
                         └──────────────────────────────────────────────┘
      ENH-38 (form defs) ──► ENH-39 (submission merge) ──► ENH-41 (two-way sync)
              │                        │
              ▼                        ▼
      ENH-44 (quality gates)   ENH-40 (client idempotency) ──► CON-06
              │
              ▼
      ENH-43 (SMS/USSD)        ENH-42 (tile packs)

      ENH-51 (reconciliation ledger) ──► ENH-76 (deterministic replay) ──► ENH-58 (counterfactual)
      ENH-52 (AA trigger engine) ──► ENH-53 (pre-positioning optimiser)
      ENH-68 (grounded NL query) ──► ENH-71 (intent disclosure), ENH-72 (explainable ranking)

                         ┌──────────────────────────────────────────────┐
                         │  Phase 4 — assurance + federation            │
                         └──────────────────────────────────────────────┘
      ENH-78 (security regression suite) ──► VUL-01/03/04 regression
      ENH-75 (client chain verify) ──► ENH-76
      ENH-77 (load model) ──► ENH-66 (backpressure), ENH-67 (read replica)
      ENH-79 (residency) ──► ENH-80 (federation)
```

**The three edges that gate the most work:** `ENH-61 → ENH-37` (streaming reads
gate the whole interop group), `ENH-59 → ENH-60` (the route table gates the router
extraction and everything that wants a route seam), and `ENH-45/46 → the veracity
group` (the registries turn each veracity defect from a one-off fix into a class the
build refuses). Nothing in Phases 2–4 should start before Phase 1's three edges land.

---

## Phases, with allocation

### Phase 0 — stop the bleeding · ~2 weeks · 1 engineer + 1 reviewer

Defect-only. No enhancement. These are the items that are wrong *now* and cheap to
make right. Every one is a small, bounded edit.

| Item | Defect | Effort (days) |
|---|---|---|
| Guard the distribution fetch | VUL-01 | 0.5 |
| Drop the query-string secret fallback | VUL-02 | 0.5 |
| Same field set in prefilter and labeller | VER-03 | 0.5 |
| `null` uptime, not `100.0` | VER-05 | 0.5 |
| Skip id-less records in the dedupe | VER-06 | 0.5 |
| Fix the five inverted logger calls | OBS-01 | 0.5 |
| Log and counter the two silent emits | OBS-02 | 0.5 |
| Delete the two copy scripts | ARC-11 | 0.5 |
| **Refuse non-numeric `?limit=`** | QUA-07 | 0.5 |

**Exit criterion.** Each is guarded by a test that fails on the old code. VUL-01 and
VER-03 especially: a fix without a canary is a fix that will regress.

### Phase 1 — the substrate · ~10 weeks · 2 engineers

| Item | Effort (wk) | Depends on |
|---|---|---|
| ENH-59 route-table generator | 3 | — |
| ENH-60 router extraction | 4 | ENH-59 |
| ENH-61 streaming cursor reads | 3 | — |
| ENH-63 durable idempotency + advisory lock | 3 | — |
| ENH-64 request/correlation id | 2 | ENH-60 |
| ENH-65 per-server state | 2 | — |
| ENH-37 streaming bulk export | 2 | ENH-61 |

Two tracks run in parallel: **routing** (59→60→64) and **store** (61→37, 63, 65).
They touch different files and merge cleanly. Fixes SCL-01/02/03, CON-01/06/07,
OBS-03, ARC-01/02, QUA-01.

### Phase 2 — veracity engine + interop · ~12 weeks · 2 engineers + 1 data reviewer

| Item | Effort (wk) | Depends on |
|---|---|---|
| ENH-45 aggregation-kind registry | 2 | — |
| ENH-46 absent-value gate | 2 | — |
| ENH-49 contingency monitor | 2 | — |
| ENH-33 org-unit registry | 3 | — |
| ENH-50 model-card registry | 3 | — |
| ENH-31 HXL export | 1 | ENH-37 |
| ENH-32 DHIS2 push | 2 | ENH-31 |
| ENH-34 versioned datasets | 3 | ENH-37 |
| ENH-48 provenance-stamped exports | 2 | ENH-34 |

Fixes VER-01/02/03/12 as a *class*, not as instances — the registry and the gate are
the deliverable; the three defects are its first catches. **The data reviewer is the
scarce resource here**: every one of these changes what a published number means, and
none should merge without a domain read.

### Phase 3 — field system + decisions · ~16 weeks · 3 engineers

| Item | Effort (wk) | Depends on |
|---|---|---|
| ENH-38 versioned form definitions | 4 | — |
| ENH-39 conflict-free submission merge | 4 | ENH-38 |
| ENH-40 client idempotency keys | 2 | ENH-63 |
| ENH-44 submission quality gates | 2 | ENH-38 |
| ENH-41 field-level two-way sync | 5 | ENH-39 |
| ENH-42 offline tile packs | 3 | — |
| ENH-43 SMS/USSD fallback | 4 | ENH-38 |
| ENH-51 reconciliation ledger | 4 | ENH-48 |
| ENH-52 AA trigger engine | 4 | ENH-50 |
| ENH-68 grounded NL query | 4 | ENH-60 |

This is where the platform stops being a dashboard. It is also the longest phase and
the one to stage last, because ENH-38/39 are a genuine subsystem, not a feature.

### Phase 4 — assurance + federation · ~14 weeks · 2 engineers

| Item | Effort (wk) | Depends on |
|---|---|---|
| ENH-78 security regression suite | 3 | Phase 0 |
| ENH-76 deterministic replay harness | 4 | ENH-51 |
| ENH-77 synthetic-population load model | 3 | — |
| ENH-66 backpressure / admission | 3 | ENH-77 |
| ENH-67 read-replica split | 4 | ENH-77 |
| ENH-75 client chain verification | 3 | — |
| ENH-79 data residency | 4 | — |
| ENH-80 federated multi-node | 5 | ENH-79 |

---

## Critical path

The longest dependency chain, end to end:

```
ENH-61 (3wk) → ENH-37 (2wk) → ENH-34 (3wk) → ENH-48 (2wk) → ENH-51 (4wk)
   → ENH-76 (4wk) → ENH-58 (5wk)                                  = 23 weeks
```

The routing chain is shorter but gates more surfaces:

```
ENH-59 (3wk) → ENH-60 (4wk) → ENH-64 (2wk) → ENH-68 (4wk) → ENH-71 (3wk)  = 16 weeks
```

**ENH-61 and ENH-59 are the two items to start first.** Everything in the interop
group waits on the first; everything that wants a route seam waits on the second.
Both are low-risk extractions with no behaviour change, which makes them safe to
begin before the Phase 0 defects have settled.

---

## Milestones

| # | Milestone | Gate | Items |
|---|---|---|---|
| M1 | The bleed is stopped | All Phase 0 tests fail on the old code | Phase 0 |
| M2 | One route table, one router | `check-openapi` passes with one declaration; `handleApiRequestInContext` < 400 lines | ENH-59, ENH-60 |
| M3 | Bounded memory on every read | A load test holds RSS flat over 10⁶ records | ENH-61, SCL-01/02/03 |
| M4 | The veracity class is closed | The gate fails the build on a new `?? 0` on a nullable field | ENH-45, ENH-46, VER-01/02 |
| M5 | Push interoperability | A DHIS2 instance ingests a published `dataValueSet` | ENH-31, ENH-32, ENH-37 |
| M6 | A district changes a question without a redeploy | Form v2 and v1 reconcile in one store | ENH-38, ENH-39 |
| M7 | Any published number is reproducible | The replay harness reproduces three historic numbers bit-for-bit | ENH-51, ENH-76 |

---

## What not to do

- **Do not start ENH-53, ENH-56, ENH-58 or ENH-80 before Phase 3.** They are the
  highest-impact items in the set (optimisation, compound hazard, counterfactual,
  federation) and every one of them is a decision layer on top of a substrate that
  is not yet bounded or reproducible. Building them first builds on SCL-01.
- **Do not raise a budget or widen a check to make a phase green.** The status-file
  drift in this very audit (a generator whose prose was a string literal) is the
  cautionary case: a check that reports without measuring is worse than no check.
- **Do not fix a veracity defect without the registry that generalises it.** VER-01
  and VER-02 are one class — a nullable field treated as a number. Fixing the two
  instances leaves the third to be found by the next audit.
