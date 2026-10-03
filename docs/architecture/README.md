# Architecture

How Lindela Lite is put together, in enough detail that a reader can predict what
it will do before running it.

The code is unusual in one respect that shapes this documentation: **it argues with
itself in comments.** A connector records why its rate limit is not enforced; the
risk scorer records that its percentiles are not quantiles; the CAP renderer records
the 50 km circle at Null Island it used to emit. Those comments are the design
rationale, and they are treated here as primary sources rather than as incidental
prose.

## Read in this order

| Document | Answers |
|---|---|
| [system-overview.md](system-overview.md) | What are the pieces, how do they fit, what crosses a boundary |
| [request-lifecycle.md](request-lifecycle.md) | What happens to one request, end to end |
| [data-model.md](data-model.md) | What is stored, how it is keyed, what idempotency rests on |
| [ingestion.md](ingestion.md) | How external data becomes records |
| [analytics-and-alerts.md](analytics-and-alerts.md) | How records become risk, and risk becomes an alert |
| [frontend.md](frontend.md) | The eight surfaces, the module graph, the offline model, what the browser can and cannot do |
| [deployment.md](deployment.md) | Topology, configuration, and what to do when it is down |
| [decisions/](decisions/) | The decisions that shaped the above, and what they cost |

Operating the deployment day to day lives in the guides this set sits beside:
[platform.md](../platform.md) for configuration, [deployment.md](../deployment.md) for the
one-click install, [dashboard.md](../dashboard.md) for the operator console, and
[operations.md](../operations.md) for the runbook. `docs/architecture.md` is the
shallower overview they assume; this set is the depth beneath it.

## Three facts worth knowing before reading further

**1. One process, one port, one database table.**
The entire backend is a single Node process with no runtime dependencies except
`pg`. Storage is one PostgreSQL table — `lite_records(collection, id, body JSONB)` —
or a JSON file. There is no message broker, no cache tier, no service mesh, and no
build step. Recurrence comes from a sidecar container that POSTs to the API.

This is a deliberate shape for a product that must run on a district office server
or a laptop, not a cloud platform.

**2. The product refuses to claim more than it can compute.**
Flood probability is empirical co-occurrence, not hydrology, and every record says
so. Risk percentiles are sensitivity bands, not predictive intervals, and they were
*renamed* to stop them reading as quantiles. Alerts carry `false_alert: null` when
nobody has determined one, so the KPI can report "not yet measurable" instead of a
confident zero. `scripts/check-no-flood-probability.mjs` fails the build if a
forbidden capability claim reappears anywhere in the tree.

**3. The interfaces are eight separate applications, not one.**
`public/` contains eight surfaces sharing a token layer and a component layer.
They differ by audience — a community health worker, a duty officer, an analyst, a
donor — and several diverge deliberately, most obviously the CHW app, which is
built for one-handed offline use rather than for feature parity.

## Conventions used in these documents

- **Diagrams** are Mermaid, rendered by any Mermaid-capable viewer. Every diagram is
  generated from the code paths named beside it; where a diagram and the code
  disagree, the code is right and the diagram is a bug.
- **`file.js:123`** refers to a line in the current tree. Line numbers drift; symbol
  names do not.
- **"Must"** means a constraint enforced in code. **"Should"** means convention.
  Where the two conflict, the comment in the code wins.