# Deployment

Topology, configuration, and operations for Lindela Lite (one Node process, one
port, one `lite_records` JSONB table). Topology map: `system-overview.md`.

## Critical fact

The periodic `setInterval` driver (`src/server.js:443`) runs ingestion schedules,
alert evaluation, dispatch outbox, and retention; writes one heartbeat per tick.
`/api/v1/health` returns 503 when heartbeat ages past interval. Tick entry:
`src/server.js:320`.

## Critical checks

- Gate suite: `node scripts/run-gates.mjs --tier self-contained`
- Unit tests: `node --test test/*.test.js`
- Budget: `node scripts/check-budget.mjs` (ceiling 230 KB gz)
- Citations: `node scripts/check-doc-citations.mjs`
- Doc links: `node scripts/check-doc-links.mjs`
- Module coverage: `node scripts/check-module-coverage.mjs`

## Operating invariants

- 230 KB gz first-load budget (currently ~0 B headroom).
- `numericOrNull` (`src/analytics/numeric.js`) is the only absence coercion.
- All routes declared in manifests; gates enforce.
- No prod DSN in source (`check-dsn-no-prod`).
- Two-oracle principle on actionable decisions.

## Services

- `db` (Postgres) plus `app` (Node), `LiteLLM` proxy reachable via
  `62.169.25.77:4000`. The proxy is NOT at `84.247.181.100`.

## Change rules

- Run gate suite and unit tests; tree must be clean before push (standing rule).
- No AI attribution in commits or documents.
- Archive referenced external docs per "Sources - always save a copy"
  (see `docs/research/`, `sources/INDEX.md`).
EOF