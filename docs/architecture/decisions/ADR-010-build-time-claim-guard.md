# ADR-010: Fail the build on a forbidden capability claim

**Status:** Accepted
**Applies to:** `scripts/check-no-flood-probability.mjs`, `npm run check:model-boundaries`
**Deciders:** whoever changes what the product says it can do

## Context

The product's honesty problem is not arithmetic. The arithmetic is mostly right. The problem is that
**a claim, once written down, outlives the code that justified it.**

`docs/demo-audit-2026-10-02.md` records the pattern with some precision. A KPI was *"mislabelled
against an external response-time target"*; the label was correct on the screen and wrong in the document that left
the building. A README listed sources that did not exist. The OpenAPI specification covered 63 of 89
endpoints. Each of those passed every functional test, because the test asserted the code, and the
defect was in the prose beside it.

The flood probability work ([ADR-005](ADR-005-flood-probability-basis.md)) made this concrete. Three
capabilities were considered and rejected on data grounds — return periods, GEV annual maxima, IDF
curves. The rejection is defensible and durable, **except that a later contributor reading a
well-intentioned README could reintroduce the claim, and every functional test would still pass**,
because none of them assert on prose.

## Decision

Fail the build.

`scripts/check-no-flood-probability.mjs` scans `src`, `public`, `scripts`, `test` and `docs` plus
`README.md`, `CHANGELOG.md` and `connectors.registry.json` for terms including
`return_period`, `annual_exceedance`, `flood_return_period`, `inundation_probability`,
`recurrence_interval`, `flood_frequency` and `overlap_hydrologic`.

Its header states the intent:

> *"Those were rejected on data grounds (no validated discharge record; MERIT unreachable) and stay
> forbidden anywhere outside the basis document … A return-period capability silently appearing in a
> README would pass every functional test; it must not pass the build."*

Exactly two files are exempt — `docs/flood-probability-model-basis.md`, which must name what was
rejected in order to explain the rejection, and `docs/developer-guide.md`. They are listed explicitly
in a `Set`, and the code says why:

> *"Listed explicitly rather than pattern-matched so that adding a new document cannot quietly join the
> exemption."*

`npm run validate` runs it, and `npm test` runs `validate.mjs` as a subprocess, so it cannot be
skipped by running tests directly.

## Options considered

### Document the boundary and rely on review

| Dimension | Assessment |
|---|---|
| Cost | Zero |
| Enforcement | A reviewer's memory, under deadline |
| Evidence of failure | The audit found three unbacked claims in this repository |

**Rejected.** This is the default state that produced the audit.

### Test for it in the functional suite

**Rejected.** It would work, but a test that fails for an unreachable reason is a test people delete
rather than fix. A named `npm run check:model-boundaries` is discoverable and gives a message that
explains the rule rather than pointing at a string comparison.

### A positive-only check: assert the docs do not over-claim

**Not viable.** "Over-claims" is not a pattern. The forbidden-term list is the negation of a decision
already made, which makes it exact.

### Move the basis document's rejected list out of the repo

**Rejected.** The rejection is only durable while the reasoning is readable. A guard whose exemption
is a private document the next contributor cannot see is a guard that gets deleted.

## Consequences

**Easier**

- A rejected capability cannot re-enter through documentation.
- The exemption list is itself reviewable. Adding a file to it is a visible act.
- The failure message names the rule, so a contributor learns the constraint rather than working
  around a regex.

**Harder**

- **The guard fires on research notes.** It caught an in-progress research document that named the
  rejected approaches while analysing them, and the build failed until that document either moved
  into the basis document or out of the tree. That is the correct outcome — the terms belong in one
  place — but it is a sharp edge, and contributors will hit it.
- The list must be maintained. A newly rejected capability needs a term added, or the guard protects
  only the capabilities rejected so far.
- Scanning `docs/` means a legitimate quotation in a design note fails the build.

**Revisit when**

- A capability moves from rejected to implemented. Remove the term, supersede
  [ADR-005](ADR-005-flood-probability-basis.md), and delete the exemptions that existed for it.
- The same pattern is needed for another boundary. The mechanism generalises — it is a forbidden-term
  list with an explicit exemption set and a reason — and the second instance should share the harness
  rather than copy it.

## The pattern worth keeping

This is the cheapest possible enforcement of a constraint that would otherwise be enforced only by
memory. It costs one script and a few seconds of CI, and it converts a decision from prose into a rule
the build applies.

The same reasoning extends to the other three places the codebase refuses to overstate — the renamed
sensitivity band, the tri-state `false_alert`, and the model's refusal floors. Together they are one
idea: **make the number say what it is, and make the build refuse the alternative.**

Related: [ADR-004](ADR-004-sensitivity-is-not-a-probability.md), [ADR-005](ADR-005-flood-probability-basis.md)