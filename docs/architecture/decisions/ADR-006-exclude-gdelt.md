# ADR-006: Exclude GDELT from ingestion

**Status:** Accepted — inherited from the Lite boundary at the first release (`CHANGELOG.md:1118`),
not forced by an incident
**Applies to:** `src/schema.js`, `src/ingestion.js`, `src/server.js`, `connectors.registry.json`
**Deciders:** anyone who thinks GDELT belongs in the open-source edition

## Context

GDELT is the largest free global event database, it is keyless, and it reports conflict events — the
exact gap the product's `conflict_events` collection is thin in. Sixteen connectors ship in Lite
(`src/connectors/`) and none of them is GDELT. Fourteen of them poll upstream automatically.

That looks like an omission, and it is easy to read `POST /api/v1/ingest/run -d '{"sources":
["gdelt"]}'`, get an error, and conclude the feature was forgotten. It was not forgotten. It is
listed in the release notes under a heading of its own:

> ### Excluded
> - GDELT ingestion.

`docs/open-source-boundary.md` draws the line the exclusion serves: Lite is *"the public-good
climate-conflict edition"*, and what is closed in the commercial product includes *"production
ingestion orchestration, source lifecycle governance, enrichment, deduplication, proprietary source
reputation, and enterprise data-quality systems."*

The uncomfortable part is that the technical argument and the commercial argument are the same
argument here. GDELT's raw feed is free and redistributable. What is not free is the *pipeline*: the
event coding, the deduplication across the 65 language editions, and the reputation weighting that
turn a fire in a favela into a conflict event and a riot in a stadium into a football match. Lite
has none of that and would be presenting an unweighted code list next to the same field in the
commercial product. A user who cannot tell the two apart has been given a reason to.

## Decision

**GDELT is hard-blocked, and the block is a named constant rather than an absence.**

```js
export const BLOCKED_SOURCE_IDS = Object.freeze(['gdelt'])   // src/schema.js:20
```

There is no connector file. The block exists in five places, each doing something the mere absence
of a connector could not:

| Site | What it does |
|---|---|
| `src/schema.js:20` | The constant. `gdelt` is deliberately **not** in `SOURCE_IDS` (`src/schema.js:1-19`) |
| `src/ingestion.js:87-89` | `getConnector` throws `` `${sourceId} ingestion is intentionally excluded from Lindela Lite` `` |
| `src/ingestion.js:104` | `runIngestion` rejects the request before any connector is resolved |
| `src/ingestion.js:280`, `:302` | `ingestionStatus` filters it out; `validateSources` throws with the same message |
| `src/server.js:522` | `GET /api/v1/health` returns `exclusions: ['gdelt']` |

The error text matters as much as the throw. An unknown source returns `Unknown source: gdelt`,
which reads as a typo. The blocked source returns *"intentionally excluded"*, which is the truth and
is the difference between a support ticket and a one-line answer.

`GET /api/v1/health` advertising the exclusion is the part that is easy to leave out and the part
that makes the decision real: a boundary the system refuses quietly is indistinguishable from a
feature that was never announced. `test/lite.test.js:1025-1028` asserts both halves — that health
lists it and that `/api/v1/sources` does not.

The same boundary is stated where a reader will meet it: `README.md:23` (*"It does not ingest
GDELT"*), `docs/ingestion.md:28`, `docs/developer-guide.md:49` (*"Do not add GDELT ingestion"*), and
`connectors.registry.json`, which has no `gdelt` entry among its sixteen.

## Options considered

### Include GDELT, treat it as a public source like any other

| Dimension | Assessment |
|---|---|
| Fills a real gap | Yes — `conflict_events` is the product's thinnest collection |
| Keyless and redistributable | Yes |
| Licence | Permissive; not the blocker |
| Classification quality | Raw automated coding, no confidence weighting, multi-edition duplicates |
| Relationship to the commercial product | Presents the same field as Lite without the pipeline that makes it mean anything |

**Rejected.** The licence is not what stops this. A reader comparing the two editions cannot tell
which events are weighted, and would reasonably assume they are.

### Include it behind an off-by-default config flag

**Rejected.** A flag is a promise someone will set. The state this prevents is a deployment with
GDELT on and no note explaining why its conflict numbers differ from the commercial edition's.

### Support ACLED instead

**What was actually done**, and the contrast is the whole point. `acled_csv` *is* in `SOURCE_IDS`
(`src/schema.js:15`), it produces the same `conflict_events` collection, and it is gated at
`src/connectors/uploads.js:35-38`:

```js
if (!options.acled_license_accepted) {
  return { conflict_events: [], errors: ['ACLED imports require acled_license_accepted=true and user-supplied licensed data.'] }
}
```

The difference is who holds the entitlement. ACLED data reaches Lite because an operator who has the
licence uploaded it themselves; the connector records
`license: 'user_supplied_acled_license'` so the provenance travels with the record. GDELT would
reach Lite because *we* chose to fetch it, which is the case the boundary is about.

### Block it by not writing the connector, and document the omission in prose

**Rejected**, and this is the option the code actually moved away from. An absent connector produces
`Unknown source: gdelt` and nothing else. The `/health` exclusion, the distinct message and the tests
at `test/lite.test.js:756-763` were added to make the exclusion *stated* rather than inferred —
because a boundary that has to be inferred from a missing file will be filled in by the next
contributor who finds the gap interesting.

## Consequences

**Easier**

- The open-source boundary is legible from the running system, not only from a document.
- A contributor who asks is answered by a named constant and a test, in under a minute.
- `/health` can be polled by a deployment to assert that the Lite build it received is the Lite
  build it expected.
- ACLED users still get conflict data, with provenance, without the platform taking the licence
  decision on their behalf.

**Harder**

- **The exclusion is a `const`, not a type.** Nothing stops a connector file named
  `src/connectors/gdelt.js` from being added — it would simply never be reachable through
  `getConnector`, because `CONNECTORS` is keyed by `SOURCE_IDS`. A contributor could write the
  connector, wire it into the map, and see tests pass while the block still holds. The failure mode
  is confusing rather than dangerous, and it is not covered by any test.
- **`SOURCE_IDS` and `BLOCKED_SOURCE_IDS` are two lists where one would do.** Every source appears in
  exactly one, and the code checks the blocked list first everywhere, which means the ordering is
  load-bearing at four sites and stated nowhere. Adding an id to `SOURCE_IDS` that is also in
  `BLOCKED_SOURCE_IDS` produces an unreachable source that still appears in `SOURCE_POLICIES`.
- The block stops the *platform* ingestion path only. Nothing prevents an operator POSTing GDELT
  data as `conflict_csv`, and nothing can — the CSV connector accepts any rows. The boundary is a
  statement about what Lite fetches, not about what a user may load.
- The GitHub issue that eventually arrives is *"why no GDELT?"*, and the answer is a link to this
  file.

**Revisit when**

- The commercial boundary changes, which is a product decision with an owner outside this codebase.
- An openly-licensed, redistribution-friendly conflict feed with documented coding confidence appears
  and can be ingested *with* that confidence attached to each record. That is the condition — the
  confidence field, not the licence — and it is the same condition ACLED satisfies by shifting the
  entitlement to the operator.
- Someone wants a build-time guard on `BLOCKED_SOURCE_IDS` the way
  [ADR-010](ADR-010-build-time-claim-guard.md) guards the model boundary. Unlike the model boundary
  there is no regex that distinguishes "documenting the exclusion" from "adding the connector", and
  the existing `test/lite.test.js` assertions are the current enforcement.

## What could not be verified

Whether GDELT was ever implemented in this repository and later removed. `CHANGELOG.md:1118-1122`
lists it under **Excluded** in what is otherwise the added-and-excluded ledger of the first public
release, which reads as *never included*. Nothing in the code, the tests or the CHANGELOG records a
removal. This ADR therefore records an inherited boundary rather than a reversal — the distinction
matters, because a boundary that was tried and undone carries an incident that would justify it and
this one does not.

Related: [ADR-002](ADR-002-single-table-jsonb-store.md), [ADR-003](ADR-003-content-hash-idempotency.md)