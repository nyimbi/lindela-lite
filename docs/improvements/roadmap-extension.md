# Roadmap extension: all 20 items from `docs/plans/world-class-roadmap.md`

The user asked that everything in the existing roadmap also be covered here. This
document does that, with a twist: rather than restating the proposals, it records
**what actually shipped**.

The finding that matters is that `docs/plans/world-class-roadmap.md` is badly
stale. Written before most of the platform existed, it now describes as future work
things that are implemented, tested and in the module inventory. At least 14 of its
20 items have shipped. An engineer or agent picking it up cold would re-propose
eight or nine capabilities the project already has, and would rank them as the
top priorities.

**Recommendation: retire that file, or replace it with a status table like this
one.** As a planning document it now actively misleads. See also
[_research/00-audit-baseline.md](_research/00-audit-baseline.md#b6-docsplansworld-class-roadmapmd-is-stale-and-should-not-be-used-as-a-source-of-planned-work).

Status vocabulary: **Shipped** — implemented and wired. **Partial** — exists but
does not do what the roadmap asked, usually for a reason worth reading.
**Open** — not implemented. **Rejected** — deliberately not done, with reasoning.

---

## Data & science

### 1. Probabilistic risk with calibrated uncertainty bands — **Partial**

*Replace point scores with quantile outputs plus a Brier/CRPS calibration report.*

The quantile work is done and was then deliberately walked back. `src/analytics.js:90-96`
records that the fields were originally `score_p10/p50/p90`, that they read as
predictive quantiles, and that they were renamed to sensitivity bands. The
`p10`/`p50`/`p90` aliases are retained for stored consumers. That is a better
outcome than the roadmap proposed.

What is missing: `calibrationReport` is computed at `src/analytics.js:5` and **never
routed** (`src/server.js:835` exports no such endpoint). A calibration report nobody
can fetch does not calibrate anything. Covered by **ENH-03** and **ENH-04**.

### 2. Ensemble & multi-model forcing — **Partial, and dead**

*Persist raw ensemble members; add `src/analytics/ensemble.js`.*

The module was written. It has no live data: no connector sets `ensemble_*`
fields, `spreadSkillIndex` has zero callers, `computeEnsembleStats` is called only
by a test, and the `ensemble_used` branch in `src/analytics.js:53` is
unreachable. `docs/architecture/system-overview.md` §4 lists it in the module
inventory as a working capability.

Decision required: wire it to a real ensemble source, or delete it. **ENH-21** is
what would earn it a place, because ensemble skill verification is the only thing
that would justify preferring `ensemble_p90`.

### 3. Impact-based forecasting (IBF) join — **Shipped, broken on Postgres**

*Cross hazard footprints with service assets and population rasters to produce
people-at-risk and facilities-at-risk.*

`src/analytics/impact.js` exists and is called. Two problems:

- **DAT-05**: `PostgresStore.replaceAnalytics` discards `population_at_risk` and
  `facilities_at_risk` entirely, so on the production backend the figures are
  computed and never stored. Works on JSON, silently absent on Postgres.
- **DATA-03**: `src/analytics/impact.js:71` counts each asset once per nearby
  hazard, inflating both facility counts and population served.

Shipped in shape, wrong in substance, and 100% line-covered while wrong.

### 4. Bias-corrected downscaling for local skill — **Partial, degenerate**

*Quantile-mapping against station observations or uploaded gauges.*

`src/analytics/downscaling.js` exists at 35% line coverage with its entire body
(lines 24-60) uncovered. `quantileMap` returns a constant given one station, and
its `|| 0` coercion puts missing rainfall at zero rather than absent — the same
null-vs-zero conflation the rest of the codebase warns against. The downscaled
output is preferred over observation.

### 5. Data-quality lineage graph — **Partial, and wrong**

*Emit per-record provenance into a `data_lineage` table.*

The single most genuinely open item on the roadmap, and the one area the codebase
has never examined. `src/lineage.js` is implemented and tested and produces
attribution that is wrong: `src/ingestion.js:181-188` rebuilds a run-wide record
union inside the per-source loop, so a nine-source run writes nine identical
lineage rows with identical `record_count` and `upstream_checksum`.
`upstream_url_or_endpoint` is always null, `transform_version` is a constant, and
IPC and WHO are excluded entirely.

This is **ENH-15**.

## Ops, triggering & response

### 6. Anticipatory-action trigger protocols with dry-run + backtest — **Shipped, defective**

*Versioned schema, backtest against history, shadow mode.*

All three exist: `src/alerts.js`, `examples/trigger-protocols/` (5 protocols),
shadow mode. But **INT-02**: the backtest at `src/alerts.js:163-200` ignores
`protocol.metric`, `protocol.operator` and `protocol.threshold` entirely. It counts
whether a hazard followed an ingestion run. `misses` is arithmetically always
zero, so precision and recall are the same meaningless number, and it reports
100%/100%. Under the roadmap's own stated motivation — donor pre-arranged finance
requiring documented trigger histories — a backtest that does not test the trigger
is worse than none, because it produces evidence.

### 7. Human-in-the-loop approval for high-severity alerts — **Shipped on SMS, absent on CAP**

*`alert_events.approval` state machine with reviewer identity; wire into the SMS
send path.*

The state machine shipped in `src/alerts.js` and `src/workflows.js`, and the SMS
path is gated at `src/server.js:1582`. The CAP endpoint at
`src/server.js:1649-1661` has **no approval gate**, so a human review requirement
enforced on SMS is bypassed by requesting CAP XML instead — the stricter channel is
the ungated one.

The roadmap's framing was right and remains right: *"the code doesn't enforce it
yet"* is now only true of one of two paths.

### 8. Two-way RapidPro flow correlation — **Partial**

*Correlate inbound field reports back to the outbound alert that triggered them;
surface a response rate per alert.*

Inbound free-text parsing exists. Correlation does not. `response_rate_pct`
(`src/rapidpro.js:214`) divides replies by dispatch count rather than recipients, so
a broadcast to 500 people can report 300% (ALERT-05). There is no delivery tracking
and no inbound idempotency, so a retried webhook double-SMs (ALERT-06).

This is **ENH-26**.

### 9. Offline-first PWA dashboard — **Shipped**

*Service worker, IndexedDB caching of API responses, background sync queue.*

Shipped and beyond the original ask: `public/sw.js:219-287` precaches the module
graph and queues writes. The console boots offline (fixed in `2a74feb`).

Two gaps remain: API responses are not cached for drill-down, and map tiles are
not cached, so an offline map degrades to an empty frame (**ENH-22**).

## Platform & integrations

### 10. First-class OGC / STAC compliance — **Shipped**

`src/stac.js`, `/stac/catalog.json`, `/ogc/` Features. Fixed in `36ad94e` after
publishing 233 hazard events at Null Island. Conformance is asserted in
`docs/architecture/system-overview.md` §6 and the standard outputs are correctly
described there as trustworthy, which means errors in them propagate.

### 11. CAP export — **Shipped, semantically broken**

`src/cap.js`. The XML itself is **schema-valid**: correct 1.2 namespace, correct
`xs:sequence` ordering, all required elements, correct escaping in every
server-populated field, and Circle is a legal CAP geometry. That is better than the
roadmap asked for.

The semantics are wrong: `Cancel` is unreachable (`src/cap.js:39` keys on
`rejected`/`cancelled` while `ALERT_EVENT_STATUSES` is
`open`/`acknowledged`/`resolved`), so rejected alerts keep publishing as live
alerts (ALERT-01); `<scope>` is hardcoded `Public` for every alert including
security and conflict (ALERT-07); a 200 km disc is labelled "district extent"
(D30).

### 12. Pluggable connector SDK + registry manifest — **Shipped**

`src/connectors/spec.js`, `connectors.registry.json`, validation in
`test/lite.test.js` and `scripts/validate.mjs`. Done as specified.

The registry has drifted from the code in two places: a `gho_top_years` option
that does not exist, and an IPC default country list of `['KE','SO','SS']` against
46 codes in the connector.

### 13. Webhook-driven event bus (outbox pattern) — **Partial, and non-functional**

*Durable `events_outbox`, subscription API, dispatcher.*

`src/outbox.js` and `src/webhooks.js` exist at **17.32% line and 25% function
coverage**. Worse than thin coverage, the signed path cannot work:

- **INT-01**: `src/outbox.js:54` calls `signPayload`, defined at
  `src/webhooks.js:44` and imported nowhere. The `ReferenceError` is swallowed by an
  empty `catch`; `last_error` is never written. **Reproduced:** signed subscription
  delivers nothing after 5 retries; unsigned delivers immediately.
- **ING-11**: the backoff is fictional — no `next_attempt_at`, events dropped
  permanently after five tries.
- The outbox write is not transactional with the state change that produced it
  (`src/server.js:1162-1163`), and dispatch marks an event sent if *any* subscriber
  succeeded.
- Nothing schedules dispatch; it requires an explicit POST.

This is the roadmap item that most needs finishing and least looks finished.

## Security, privacy & compliance

### 14. AuthN/AuthZ with scoped API tokens and audit log — **Partial, and worse than nothing**

*Replace the unauthenticated `/api/v1/*` with scoped tokens; append-only audit log.*

No OIDC exists; `src/auth.js` is a bespoke token table. The roadmap's premise was
right — *"the current server would fail any donor security review"* — and the
implementation did not resolve it:

- **SEC-01**: `src/server.js:237` never rejects an unauthenticated **GET**, so even
  with keys configured, `GET /api/v1/export.csv` returns field reports, RapidPro
  messages and interventions. The deployment looks secured.
- **SEC-03**: a `read:hazards` token can perform every route outside five special
  cases. **Reproduced** 201 on `community-feedback`, `webhooks`, `chw/reply`,
  `outbox/dispatch`, `equity/scan`.
- **SEC-04**: a typo in `LINDELA_LITE_TOKENS` disables auth silently.
- **SEC-06**: `scopeToPartnerOrg` is dead code, yet the portal renders the filter as
  applied.
- **SEC-09**: 8 characters of the bearer token are persisted as the actor in every
  action log.
- The audit log exists but is self-asserted, has no UI, and the three parametric
  write paths write none at all.

**ENH-01** and **ENH-28** are this item, finished.

### 15. Field-report PII minimisation + retention — **Partial, non-functional**

*Configurable redaction and a background retention task that ages out raw personal
data.*

`src/pii.js` implements both `redactPii` and `applyRetention` with **zero tests**.
Neither is wired:

- `redactPii` is never called from the HTTP field-report path
  (`src/server.js:2240-2248`); reporter name and phone are stored in cleartext.
  **Reproduced** in unauthenticated `GET /rapidpro/inbound` and in `export.csv`.
  The RapidPro path *does* redact. The two paths disagree.
- `redactNames` defaults to **false**; the hash is unsalted and truncated to 32
  bits, dictionary-reversible for a bounded name set; the geo-coarsening guard
  uses `if (latitude && longitude)`, so 0° is treated as absent.
- **DAT-07**: the retention route merges only `kept`, and `merge` cannot delete.
  **Reproduced:** a 400-day-old record reported `expired: 1` and remained readable.
  `docs/api.md:567-573` documents a `dry_run` flag that does not exist.

The legal exposure the roadmap identified is real and currently unmet.

### 16. Signed, reproducible releases and SBOM — **Partial**

*SLSA provenance, CycloneDX SBOM, cosign image signing.*

SBOM shipped: the CycloneDX job at `.github/workflows/ci.yml:53`. The rest did not.

- **Supply chain**: CI fetches unpinned packages at build time —
  `npx --yes trivy` at `:44`, cyclonedx at `:53`, `wait-on` at `:103,108`. Trivy is
  the least-safely-fetched thing in the repository.
- Six of seven jobs have no `permissions:` block; every action is on a mutable tag;
  no CodeQL.
- No cosign, no provenance attestation, no release signing.

## Reliability, observability & scale

### 17. OpenTelemetry traces + Prometheus metrics + structured logs — **Partial**

*Instrument `createServer`, `runIngestion`, `PostgresStore.merge`; expose
`/metrics`.*

Metrics and structured logs shipped: `src/observability.js`, counters, histograms,
Prometheus rendering at `/api/v1/metrics`, JSON request logging at
`src/server.js:124`. No OpenTelemetry, no tracing, no spans.

Two defects: `/metrics` is served **before** the auth gate (`src/server.js:105-109`),
so it is public regardless of configuration (SEC-10); and the histogram map is
unbounded with a client-controlled label (`src/observability.js:76`), which is a
memory-growth primitive. One call site has arguments reversed
(`src/server.js:404`, `logger.error({err}, 'msg')` against signature
`(event, fields)`), emitting one key per character.

### 18. Idempotent ingestion with content-addressed dedup — **Partial, broken on Postgres**

*Key records by `sha256(canonicalized-payload)`; make `run-due` a resumable job
with a lease.*

Dedup shipped: `canonicalHash` at `src/ingestion.js:139-140`, a unique index on
`(collection, payload_hash)` at `src/postgres-store.js:52`, and a
`skip-duplicates` query at `:133`. It does not work reliably:

- **DAT-01**: `PostgresStore.write()` (`src/postgres-store.js:70-82`) deletes the
  whole table and re-inserts **without `payload_hash`**. After one `write()`, every
  row has a null hash and dedup matches nothing again.
- **ING-05**: `canonicalHash` strips only top-level keys, and five connectors stamp
  `metadata.fetched_at`, so the hash changes every run.
- **DATA-13**: the hash is not namespaced by anything but id.
- **ING-04**: two backfill connectors mint a new id daily, so the id differs and the
  hash never collides.
- No lease. `run-due` is not resumable.

This was correctly identified as *"the foundation for the lineage graph in #5"*,
and both #5 and #18 are blocked on the same structural weakness.

## Product & community

### 19. Scenario workbench (deterministic what-if) — **Shipped**

`src/scenarios.js`, `/api/v1/scenarios`, and a `public/scenarios/` surface. Done as
specified, with one defect: scenario means are averaged over different region sets
after perturbation (`src/scenarios.js:57`), so a before/after comparison is not
like-for-like.

### 20. Localization, plain-language rendering, RTL/Arabic — **Partial**

*Externalize strings; i18n catalogs for en/fr/pt/sw/ar/am; plain-language report
mode.*

Localization shipped well beyond the ask: 11 locales in `public/i18n/` including
Amharic, Somali, Kinyarwanda, Khmer, **and** a `din` tag that is not valid BCP-47
(D32). Guards exist: `scripts/check-i18n.mjs` and `check-i18n-offers.mjs`.

The gaps are uneven in a way that matters:

- **The three surfaces a district officer actually uses — `districts`, `scenarios`,
  `parametric` — have no locale picker at all**, while the console ships 10
  languages. Translation effort has gone to the audience that was easiest to serve.
- RTL for `ar` is not implemented.
- Alert SMS is monolingual (`src/rapidpro.js:301`), which is the one channel that
  reaches the field.
- The plain-language report mode was not built. `src/reports.js` is 849 lines of
  template assembly and 90.58% covered, but it is written for an analyst audience,
  not a community one.

---

## Summary

| # | Item | Status |
|---|---|---|
| 1 | Quantile risk + calibration report | Partial — bands shipped, report not routed |
| 2 | Ensemble & multi-model forcing | Partial — dead module, no live data |
| 3 | Impact-based forecasting | Shipped — broken on Postgres, double-counted |
| 4 | Bias-corrected downscaling | Partial — degenerate with one station |
| 5 | Data-quality lineage graph | Partial — implemented, tested, wrong |
| 6 | Trigger protocols + backtest | Shipped — backtest does not test the trigger |
| 7 | Approval gate | Shipped on SMS, absent on CAP |
| 8 | Two-way RapidPro correlation | Partial — no correlation, no delivery tracking |
| 9 | Offline-first PWA | Shipped |
| 10 | STAC / OGC | Shipped |
| 11 | CAP export | Shipped — XML valid, semantics wrong |
| 12 | Connector SDK + registry | Shipped |
| 13 | Outbox event bus | Partial — signed path cannot work |
| 14 | Auth + scoped tokens + audit | Partial — GET unauthenticated, fails open |
| 15 | PII minimisation + retention | Partial — implemented, not wired, retention no-op |
| 16 | Signed releases + SBOM | Partial — SBOM only |
| 17 | OTel + Prometheus + logs | Partial — metrics and logs only |
| 18 | Idempotent ingestion | Partial — dedup broken on Postgres |
| 19 | Scenario workbench | Shipped |
| 20 | Localization + RTL | Partial — 11 locales, missing on 3 key surfaces |

**5 shipped, 15 partial, 0 rejected.**

The pattern is consistent and worth naming: this project builds the capability and
then does not finish the wiring. Item 3 computes the impact figures and never stores
them on the production backend. Item 5 writes lineage for every source on every run
and attributes it wrongly. Item 11 emits standards-conformant CAP for alerts that
were rejected. Item 15 implements redaction and retention and calls neither from a
request path.

That is a good failure mode — the hard part, the part requiring judgement and
domain knowledge, is done everywhere. What is missing is the class of check that
verifies a built capability is actually reachable: an adapter conformance suite, an
end-to-end "does the figure reach the caller" test, an assertion that a rejected
alert is not published. Five of the fifteen partials would be Shipped by adding a
test that fails today.

This is why **ENH-29's conformance suite** and **ENH-02's payload-honesty gate** are
worth more than any single feature in this repository: they convert "we built it"
into "we built it and it is connected".