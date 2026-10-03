# Architecture Decision Records

Each ADR records a decision that is **load-bearing**: changing it would change what the product is,
not merely how it is built. Decisions that were routine are not recorded, because a record of every
choice is a record of nothing.

Most of these are not hypothetical. The rationale already exists in the source — a comment that
explains not *what* the code does but *why it stopped doing the obvious thing*. The ADRs give those
comments a home, an option analysis, and a stated cost.

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-zero-frontend-dependencies.md) | Zero front-end dependencies and no build step | Accepted |
| [ADR-002](ADR-002-single-table-jsonb-store.md) | One JSONB table rather than a relational schema | Accepted |
| [ADR-003](ADR-003-content-hash-idempotency.md) | Content-hash idempotency for ingestion | Accepted |
| [ADR-004](ADR-004-sensitivity-is-not-a-probability.md) | Rename the risk percentiles to sensitivity bands | Accepted |
| [ADR-005](ADR-005-flood-probability-basis.md) | Empirical co-occurrence, not a hydrological model | Accepted |
| [ADR-006](ADR-006-exclude-gdelt.md) | Exclude GDELT from ingestion | Accepted |
| [ADR-007](ADR-007-soft-delete.md) | Soft delete rather than hard delete | Accepted |
| [ADR-008](ADR-008-hand-rolled-svg-map.md) | Hand-rolled SVG map rather than a mapping library | Accepted |
| [ADR-009](ADR-009-external-scheduler.md) | An external scheduler sidecar rather than in-process timers | Accepted |
| [ADR-010](ADR-010-build-time-claim-guard.md) | Fail the build on a forbidden capability claim | Accepted |
| [ADR-011](ADR-011-standard-interchange-formats.md) | STAC, OGC Features and CAP over a bespoke export | Accepted |
| [ADR-012](ADR-012-eight-separate-surfaces.md) | Eight separate applications rather than one routed app | Accepted |

## Format

Every record uses the same shape, so they can be read together:

- **Status** — Accepted, with the date the decision was made and, where it applies, the incident or
  defect that forced it. Several of these exist because the obvious thing was tried first and failed
  in production.
- **Context** — the forces, including the ones that are uncomfortable. A constraint nobody mentioned
  is a constraint somebody will rediscover badly.
- **Decision** — what was chosen.
- **Options considered** — including the option that was rejected and why. A record that only
  documents the chosen path teaches nothing.
- **Consequences** — what got easier, what got harder, and what will need revisiting.

## The pattern worth noticing

Four of these decisions (004, 005, 010, and the false-alert tri-state in 003's sibling) exist for one
reason: **the product had previously displayed a number that was correct as computed and misleading as
read.** Each response was to make the number say what it was — rename it, refuse to compute it, null it
rather than zero it, or fail the build if the claim reappeared. That is a stronger pattern than adding
accuracy, and it is cheaper, because it survives the accuracy work not being finished.