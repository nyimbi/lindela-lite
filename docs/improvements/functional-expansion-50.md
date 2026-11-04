# 50 Functional Expansions + Implementation Audit

Source prompt ("functional expansion and architectural audit") fulfilled by persisting
this artefact in `docs/improvements/` (workspace root, commit `94aa7b3`). Companion
to `docs/research/decision-models/README.md` (decision-model integration options).

## Part A, fifty functional expansions

Each entry: feature / novelty / touched subsystems / per-unit complexity.

1. Per-district confidentiality ring, store partitioning on organisation.
   `src/auth.js`, `src/store.js`. O(1) token validation, O(n) per-record ring
   derivation.
2. Device-local offline queue with durable encryption passthrough.
   `public/shared/queue-core.js`. O(1) enqueue, O(n) replay.
3. Fine-grained JWT geo scope. `src/auth.js`, defaults TTL in `src/constants.js`.
   O(1) auth check plus O(n_cities) enumeration on rotation.
4. Audit-immortal hash-linked decision trail. `src/audit-chain.js`. O(1) write,
   O(n) verify.
5. Phonetic voice-driven CHW wizard. `public/chw/app.js` + `src/forms.js`.
   O(v) for the voice vocab.
6. Type-ahead from prior district submission. `validateAnswers` extension. O(1).
7. Cross-realm form sync gate (`check-module-coverage`).
8. Single-source-of-truth publish lattice. O(n) doc compilation.
9. Semantic search (FTS + cosine). Distinct from literal grep.
10. Deterministic replay of `action_logs` via `src/audit-chain.js`.
11. Service-time estimation for dispatch.
12. Shortest-delay-first dispatch sort. O(n log n) per dispatch.
13. Skill-per-distance roster planner.
14. Flow-volume supply-chain routing (threshold band occupancy).
15. What-if intervention constraints solver (binary search).
16. Reliability intervals on risk scores (calibrated).
17. Tail-risk decomposition per score (SHAP-lite).
18. Seasonal drift detector (CUSUM).
19. Federated evidence summarization.
20. Analog-event forecast matcher.
21. Priority highway routing on computed road graph.
22. Multi-hazard joint dispatch priority.
23. Fairness cap on sub-district stockage.
24. Incident auto-inference via Jaccard similarity.
25. Model-suggested protocol text (decision-model layer).
26. Idempotent merge for connectors (stable-ID keyed).
27. Migration ownership reassignment (table owner check gate).
28. Partial-unique-index enumeration.
29. Write rollback semantics (open).
30. Colorblind palette switch.
31. Exact-zoom tile vector layer.
32. Choropleth bands (operator-configurable per view).
33. Offline vector-tile cache.
34. Local route matrix (Dijkstra).
35. RBAC surface toggle.
36. Incident step zoom.
37. Field-value side rail.
38. Offline GC at 30 days.
39. Secret-scanning gate.
40. Dispatch payload integrity check.
41. Credential-hygiene lint.
42. Boot-time log-level validation gate.
43. Declared-route exhaustive scope audit (see A2).
44. `validateAnswers` property-based tests.
45. Coverage boost for `src/operations.js`.
46. Mutation testing on `numericOrNull`.
47. Chaos tests (mid-write process kill).
48. CI matrix on Node 26 for `check-budget`.
49. Form-version deprecation checklist.
50. Model shadow for dispatch (per `docs/research/decision-models/README.md`).

## Part B: audit of defects, anti-patterns, bottlenecks

### Architectural anti-patterns
- A1. Uncentralized normalization (`Number(x) || 0` recurring). Mitigate
  with `toNumber`/`numericOrNull` gates.
- A2. Dual-realm forms module (`public/shared/forms.js` re-exported through
  `src/forms.js`). Lockstep via `check-module-coverage`.
- A3. Cross-panel DOM id reads (a panel reads another panel's element
  by `getElementById`). Fix: per-panel indirection and pass-by-reference.
- A4. Table-vs-view drift on identical field lists.
- A5. Route manifest duplication (`src/route-declaration.js`,
  `src/route-manifests.js`); the gate scans both.

### Concurrency anomalies
- C1. Temp-store teardown race (`check-*`); fixed at gate level. O(1) per test,
  randomized collision probability `1 / test_id_space`.
- C2. Shared test log path between parallel invocations (see lessons). Fixed
  by unique file per run.
- C3. `asyncio` loop re-use after `run` throws on later tests.
- C4. Wrapper-script child survival; kill by pgid.
- C5. `asyncio.get_event_loop` deprecated on 3.13+; not an issue here.

### Scalability bottlenecks
- S1. First-load 230 KB gz budget (check-budget.mjs).
- S2. O(n_regions × n_sources) per ingestion.
- S3. O(n_districts) per map legend render ( 44 pilot districts).
- S4. `np.argmin` extremum over indexed classification masks.
- S5. `stats` helper randomized read outliers under contention.

### Observability deficits
- O1. `LOG_LEVEL=fatal` silently ignored (unknown level).
- O2. DB updates in autocommit hide transaction rollback.
- O3. RSC second error site leaks function-prop cross.
- O4. Integration gates that warn but don't assert predicate.
- O5. NDJSON stream without replay anchor.
- O6. Partial-merge ordering in `src/operations.js`.

### Security / privacy vulnerabilities
- V1. Un-scoped routes fold into `admin:*` (`scopeForRoute`).
- V2. Hard-coded DSN in source (gate `check-dsn-no-prod`).
- V3. Non-finite-coercion patterns (sweep already addressed).
- V4. LiteLLM remote endpoint drift (`62.169.25.77`).
- V5. Cross-panel element read attack surface.
- V6. Disparate consent scope for PHI (no explicit map yet).

## Part C: phased rollout

- Phase 0: held ground, gates green.
- Phase 1 (now): absence-coercion closure done; CI property tests present.
- Phase 2 (1 week): central `numericOrNull`; gates amended for spec.
- Phase 3 (4 weeks): decision-model infrastructure + shadow mode.
- Phase 4: `app.js` panel-handler budget payback.
- Phase 5: promote shadow-mode to primary by governance decision.

Dependency graph:
```
numericOrNull-centralized -> absences sweep -> test mutation suite
forms dual-realm -> universe of frontend input paths
budget headroom -> app.js panel-handler debt
model registry -> shadow mode -> governance
```

## Appendix A: file references

- `src/utils.js:851` (`readCoordinate`)
- `src/analytics/numeric.js` (canonical absence gate)
- `src/forms.js` (dual-realm wrapper)
- `src/auth.js:290 / 1240–1450` (RLS vs layer)
- `src/server.js:383–403` (counter typing)
- `src/ingestion.js:145–215` (request flow)
- `public/app.js` (interactive header, ~ 6 455 lines)
- Gate scripts: `scripts/run-gates.mjs`, `scripts/check-doc-citations.mjs`,
  `scripts/check-budget.mjs`.
- Companion research: `docs/research/decision-models/README.md`.

## Appendix B: sources

Internal only (`CLAUDE.md`, `MEMORY.md`, `docs/improvements/`, `docs/architecture/`).
No external citation is load-bearing; if any later is, archive it per the
`Sources, always save a copy` rule.
EOF
