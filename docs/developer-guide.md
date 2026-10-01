# Lindela Lite Developer Guide

This guide is for developers extending or maintaining Lindela Lite.

## Local Setup

```bash
npm install
npm test
npm run validate
npm start
```

Open:

```text
http://127.0.0.1:4177
```

## Project Layout

```text
src/
  server.js          API routing and static serving
  schema.js          source ids, enums, empty store
  ingestion.js       connectors, schedules, source health
  analytics.js       risk and quality calculations
  operations.js      incidents/interventions/tasks/resources
  alerts.js          alert rules and alert events
  rapidpro.js        RapidPro integration
  reports.js         reporting engine
  store.js           JSON store
  postgres-store.js  PostgreSQL JSONB store
  connectors/        source connectors
public/
  index.html         dashboard shell
  app.js             dashboard behavior
  styles.css         dashboard styles
docs/
  *.md               operator/developer docs
test/
  *.test.js          node:test suites
```

## Development Rules

- Keep Lite dependency-light.
- Do not add proprietary data dependencies.
- Do not add GDELT ingestion.
- Keep scheduling explicit through due-run endpoints.
- Keep high-impact decisions human-reviewed.
- Add docs and tests for new public behavior.
- Keep OpenAPI in sync with public endpoints.

## Adding A Connector

1. Create `src/connectors/<source>.js`.
2. Export an object with `id` and `ingest(options)`.
3. Return normalized records grouped by collection.
4. Add the connector to `CONNECTORS` in `src/ingestion.js`.
5. Add source id and catalog metadata in `src/schema.js`.
6. Add source policy in `SOURCE_POLICIES`.
7. Add fixture tests.
8. Update docs:
   - [ingestion.md](ingestion.md)
   - [api.md](api.md)
   - [platform.md](platform.md)
   - [openapi.yaml](openapi.yaml)

Connector output shape:

```js
return {
  climate_observations: [],
  hazard_events: [],
  conflict_events: [],
  service_assets: [],
  errors: [],
}
```

## Adding An API Endpoint

1. Decide whether the endpoint belongs to an existing route family.
2. Add route matching in `src/server.js`.
3. Normalize input in a domain module, not inline in the route where practical.
4. Return consistent JSON:

```json
{
  "success": true,
  "data": []
}
```

5. Use `jsonResponse()` for JSON responses.
6. Add tests in `test/lite.test.js` or a focused test file.
7. Update:
   - [api.md](api.md)
   - [openapi.yaml](openapi.yaml)
   - `scripts/validate.mjs` for public endpoint coverage.

## Adding A Report Section

1. Add the section id to `SECTION_LIBRARY` in `src/reports.js`.
2. Add it to default report sections if appropriate.
3. Add a builder function.
4. Wire the builder in `buildSection()`.
5. Return `content(summary, metrics, source_refs, items)`.
6. Add tests for generated content and source refs.
7. Update reporting docs.

Report sections should be deterministic and source-backed. Do not add hidden model calls or opaque conclusions.

## Adding Dashboard UI

Dashboard changes usually touch:

- `public/index.html`
- `public/app.js`
- `public/styles.css`

Rules:

- Escape user/API data before inserting into `innerHTML`.
- Use `textContent` when rendering plain text blocks.
- Send `authHeaders()` for mutating requests.
- Keep controls compact and operational.
- Ensure mobile layouts do not overlap.
- Add tests or validation checks for security-sensitive rendering.

### Model Boundaries Are Enforced

`npm run check:model-boundaries` (also run inside `npm run validate`) fails the
build if a flood-probability or return-period field appears anywhere in
`src/`, `public/`, `scripts/`, or `test/` while no model basis has been agreed.

This exists because the rule was otherwise only author discipline. The rule is
real: rainfall intensity/duration to flood probability is not implemented, and
may only be against an explicit documented and agreed basis. A number shaped
like a probability that no model supports is worse than no output, and that
failure mode is exactly what a test suite will not catch.

To lift the guard legitimately: agree the basis first, record it in
`docs/flood-probability-model-basis.md`, and set `AGREED_MODEL_BASIS` in
`scripts/check-no-flood-probability.mjs` to that document. Do not lift it by
deleting the script. Confirmed to fail when a `return_period_years` field is
injected into the flood-depth response.

The same discipline applies to the risk-score bands, which are named
`sensitivity_*` and carry `calibrated_uncertainty: false` precisely because
they are not calibrated.

### Keeping The DOM Contract

`$('id')` returns `null` for a missing element, and the failure surfaces later
as a property access on `null` rather than at load. Three tests in
`test/lite.test.js` hold this contract, so run them after touching either file:

- `resolves every element the dashboard looks up by id` — every `$(...)` and
  `getElementById(...)` in `app.js` must have a matching `id` in `index.html`.
- `imports the flood-bands module the dashboard actually loads` — a rename of
  `/shared/flood-bands.js` breaks the browser bundle silently, since Node
  resolves the test import from a different path than the browser request.
- `styles every flood depth band class it renders` — an unstyled band renders
  as invisible fill, so the operator sees no water and no error.

Rendering logic that can be isolated from the DOM belongs in
`public/shared/*.js` and gets tested directly. `test/flood-bands.test.js` is the
worked example: the band cut points, grid stride, and coverage maths are all
verified as pure functions instead of by matching source text with a regex.

### Overlays That Recompute

Layers drawn over the basemap (flood depth, road status) are cleared and
redrawn on every map render, because a filter change re-renders the whole map.
They therefore read their content from `state` and re-render from it, rather
than assuming their layer survives. Keep any such layer's data in `state`, and
have `renderMap` redraw it after clearing.

## Testing

Default suite:

```bash
npm test
```

Validation:

```bash
npm run validate
```

Coverage, with enforced thresholds over `src/**`:

```bash
npm run test:coverage
```

Thresholds are 75% line, 60% branch, 75% function. The command exits non-zero if
coverage falls below them, so a regression fails CI rather than going unnoticed.
Current baseline is roughly 77.9% line, 63.9% branch, 79.3% function — raise the
thresholds as coverage improves.

Dependency audit:

```bash
npm run audit
```

Fails on high or critical advisories in the dependency tree.

Live source check:

```bash
npm run check:live-sources
```

Probes every public source against its real upstream. Add `--strict` to exit
non-zero when any source errors or returns nothing.

**Run this after touching any connector.** The fixture suite cannot catch a
provider changing its response shape, because fixtures describe what the code
expects. Three connectors shipped reporting success while ingesting nothing:
CHIRPS (index moved to year subdirectories), GloFAS (RSS URL started serving a
web app), and NASA FIRMS (no keyless access; the placeholder key produced HTTP
400s). Every one looked healthy from the test suite.

Treat these three states differently:

- **ok** — records returned.
- **error** — the connector reported why. Usually an upstream change or a
  missing credential.
- **empty** — records expected, none returned, no error. This is the dangerous
  one: it reads as "no data right now" when it actually means "nothing was
  ingested".

When adding a connector, decide which of these an empty result should be. If
it cannot be "no data", make it an error.

Syntax checks:

```bash
node --check src/server.js
node --check src/ingestion.js
node --check src/reports.js
node --check public/app.js
```

PostgreSQL integration, when a database is available:

```bash
LINDELA_LITE_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/lindela_lite_test npm run test:postgres
```

pg0 integration, when pg0 is available:

```bash
LINDELA_LITE_TEST_PG0=1 npm run test:pg0
```

## Documentation Validation

`scripts/validate.mjs` checks:

- Example JSON parses.
- Important platform-guide sections exist.
- Docs index links exist.
- Deployment guide covers one-click details.
- OpenAPI contains expected public endpoints.

When adding public docs, add targeted validation checks for critical files and links.

## Common Failure Modes

### Tests Pass But Dashboard Action Fails

Check:

- API key field.
- Browser console.
- Whether the API route requires POST/PATCH.
- Whether the dashboard sends `authHeaders()`.

### Ingestion Appears To Work But Health Is Wrong

Check source-run ordering and `completed_at`. Latest source runs should sort ahead of older runs.

### Schedule Runs Repeatedly Fail

Check:

- Source or report template exists.
- Schedule is active.
- `next_run_at` is being advanced.
- Failed runs are recorded.

### Docs Drift From API

Update these together:

- `src/server.js`
- `docs/api.md`
- `docs/openapi.yaml`
- `scripts/validate.mjs`
- tests

