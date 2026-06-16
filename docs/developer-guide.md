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

## Testing

Default suite:

```bash
npm test
```

Validation:

```bash
npm run validate
```

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

