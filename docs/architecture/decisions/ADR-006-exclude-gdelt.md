# ADR-006: GDELT is excluded from ingestion

**Status:** Accepted — enforced in the first published commit (`fe5a9e3`, 2026-05-17), never enabled
**Applies to:** `src/schema.js:20`, `src/ingestion.js`, `src/server.js:522`, `public/app.js:2106`
**Deciders:** whoever adds a source id to `SOURCE_IDS`

## Context

`gdelt` is the only name in the ingestion vocabulary that cannot be ingested. It is not in
`SOURCE_IDS` — the sixteen ids the registry, `/api/v1/sources` and the schedule endpoints all draw
from — and it is named explicitly in a list of its own:

```js
export const BLOCKED_SOURCE_IDS = Object.freeze(['gdelt'])
```

Enforcement is in two places, both in `src/ingestion.js`, and both throw before anything is
fetched:

> `getConnector` — ``throw new Error(`${sourceId} ingestion is intentionally excluded from Lindela Lite`)``
>
> `runIngestion` / `validateSources` — the same string, checked per requested source before the
> loop that would call a connector.

`/api/v1/health` reports `exclusions: ['gdelt']`, `ingestionStatus` filters the blocked ids out of
the status list, and `publicSourceCatalog` never produces the entry.

**The reason is editorial, not legal.** Nothing in the codebase claims GDELT is unlicensed,
rate-limited or unusable. `docs/open-source-boundary.md` states the actual rule:

> *"Lindela Lite is the public-good climate-conflict edition. It is useful on its own, but it
> preserves the commercial value of full Lindela by limiting the release to public ingestion,
> neutral schemas, baseline heuristics, a small API, and a lightweight UI."*

GDELT sits in the same exclusion family as WorldMonitor code. `CONTRIBUTING.md` lists them together
— *"No GDELT ingestion"* and *"No WorldMonitor code or derivative implementation"* — and asks every
pull request to *"state that no client data, secrets, WorldMonitor code, GDELT ingestion, or full
Lindela internals were added."* `docs/improvements/_research/ingestion.md` calls it what it is:
*"`BLOCKED_SOURCE_IDS` (`schema.js:20`) is a deliberate editorial decision."*

Conflict events are not absent from the product. `acled_csv` and `conflict_csv` are first-class
sources writing to `conflict_events`; the block is on one provider, not on the signal.

### History

`git log -S"gdelt"` shows six commits, all of which carry the constant forward. `git show
fe5a9e3:src/schema.js` already contains `BLOCKED_SOURCE_IDS`, `git log --all --diff-filter=A
--name-only` has never seen a GDELT connector file, and `src/connectors/` has sixteen modules,
none of them GDELT. **It was never enabled.** The temptation to describe it as a reverted
experiment is wrong, and the block is cheaper partly because nothing had to be undone.

## Decision

Keep the hard block. Not a flag, not a default-off flag, not a config key. An attempt to ingest
`gdelt` throws, by name, in every path — `getConnector`, `runIngestion` and `validateSources` — and
the console says so on every refresh:

> `setStatus(\`Updated ${formatTimestamp(new Date())}. GDELT excluded.\`)`

## Options considered

### Keep it behind a flag

| Dimension | Assessment |
|---|---|
| Restores the signal | Only for whoever finds and sets the flag |
| Keeps the boundary | Only while the flag is off, and only by default |
| Failure mode when on | Silent. The console constant says excluded; the metric says otherwise |
| Test surface | A branch that CI never runs, on a path the boundary forbids |

**Rejected.** A flag converts a boundary into a preference, and the boundary is the entire point of
the Lite edition. It would also make the console's status line a lie the moment someone flipped it,
which is a worse outcome than the missing data.

### Sample it — a daily digest instead of a full feed

| Dimension | Assessment |
|---|---|
| Cost | Small: one fetch per day, records trimmed to the region |
| Signal quality | Unchanged in kind, and much worse in coverage — GDELT's local event density is what makes it useful |
| Boundary | Unchanged: it is still GDELT ingestion, just less of it |
| Complexity | A second code path, a second store, a second thing to exclude later |

**Rejected** on the boundary alone. Sampling is not a smaller version of a permitted thing; it is
the same thing with the volume turned down.

### Use it for a count only — "N media-reported events in the region"

| Dimension | Assessment |
|---|---|
| Appears cheap | Yes |
| Is it honest | Only if the count is labelled with its provenance, and the console already refuses exactly that kind of unlabelled aggregate |
| Interaction with the scoring | None — `computeClimateConflictRisk` reads `conflict_events`, so a count would not reach the score anyway |

**Rejected.** A count of events that are not in the store invites the reader to infer a density the
store cannot support, and it is the same move ADR-004 rejects: a number that is correct as computed
and misleading as read.

## Consequences

**Easier**

- The exclusion is one constant, one string, and three call sites. It cannot drift out of the
  vocabulary because it was never in it.
- Nothing has to be un-shipped if the boundary is later withdrawn — no connector, no stored records,
  no migration of already-ingested data.
- A contributor who reaches for GDELT hits `getConnector`'s throw immediately, and
  `CONTRIBUTING.md` explains why before they file the issue.

**Harder**

- **The product loses a broad conflict-event signal.** GDACS and USGS give hazards; `acled_csv` and
  `conflict_csv` give conflict, and only if an operator supplies the file. Out of the box the map's
  conflict layer is empty and the operator has to know that.
- **`computeClimateConflictRisk` is weaker for it.** `conflictPressure` is
  `Math.min(30, conflicts.reduce((sum, event) => sum + 4 + Number(event.fatalities || 0) * 0.8, 0))`
  over `conflict_events` within 125 km. With no source writing that collection, the term is 0 for a
  fresh deployment, and the component carries 30 of the score's 100 points. The remaining terms —
  climate 35, hazards 25, services 10 — can still reach 70. The score is not wrong; it is computed
  over a thinner input set than its own name implies, which is what the `confidence` term and the
  sensitivity band are for ([ADR-004](ADR-004-sensitivity-is-not-a-probability.md)).
- The block costs a constant on screen. Every refresh writes "GDELT excluded." into the status line,
  which some operator will eventually ask to have removed.

### Why the constant on screen is worth it

The alternative to a labelled exclusion is not a map with a conflict layer that quietly has no data
in it. It is a map that looks complete. `computeDataQuality` will report a coverage percentage, and
that percentage will be computed over the sources that remain — so an empty conflict layer reads as
"no conflict recorded", which is the single most dangerous thing a humanitarian situational map can
say about a region where people are armed.

A named, unchanging exclusion is a *statement about the product*. A silently degraded metric is a
statement about the world. The console says the first; the map would say the second.

## Revisit when

- The open-source boundary itself changes — a decision to publish the connector, at which point this
  ADR is superseded rather than amended.
- Conflict events come from a permitted source that covers the pilot districts without an
  operator-supplied file, in which case the cost above is paid down by other means and this becomes a
  restatement rather than a decision.

## One loose end

`exclusions: ['gdelt']` in `/api/v1/health` (`src/server.js:522`) is a **literal**, not
`[...BLOCKED_SOURCE_IDS]`. The health endpoint, the ingestion guards and the vocabulary are three
lists, and the first is maintained by hand. A second blocked source would be enforced in three of
four places and reported in none. That is the same failure mode ADR-002 names for `COLLECTIONS`
— *an unlisted key is dropped silently* — in a different list, and it deserves the same treatment:
derive it, and assert on it.

Related: [ADR-002](ADR-002-single-table-jsonb-store.md),
[ADR-004](ADR-004-sensitivity-is-not-a-probability.md)
