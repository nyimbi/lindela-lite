# Contributing to Lindela Lite

Lindela Lite is a public-good climate-conflict, flood, environmental, and service-delivery impact toolkit. Contributions are welcome when they keep the project useful, transparent, and safely separated from the commercial Lindela platform.

## Project Boundary

Contributions must stay inside the Lite boundary:

- Public or user-supplied data ingestion only.
- Neutral schemas, baseline heuristics, API formatting, documentation, and UI improvements.
- No proprietary Lindela internals, client data, trained models, source reputation systems, report-management workflows, wargaming, classified workflows, or enterprise orchestration.
- No GDELT ingestion.
- No WorldMonitor code or derivative implementation.

If a contribution is useful but belongs in full Lindela rather than Lite, open an issue describing the need without submitting the restricted implementation.

## Development Setup

```bash
npm test
npm start
```

The local API listens on `LINDELA_LITE_PORT` or `4177`.

Useful checks:

```bash
curl http://127.0.0.1:4177/api/v1/health
curl http://127.0.0.1:4177/api/v1/sources
```

## Contribution Types

Good first contributions include:

- Documentation fixes and examples.
- Parser tests using small public fixtures.
- UI accessibility and responsive layout improvements.
- New public-source connectors with clear license terms.
- New trigger protocol examples.
- Safer validation, clearer errors, or export improvements.

Before adding a connector, confirm:

- The source license allows open-source use.
- Credentials, if any, are user-supplied.
- The connector can fail safely without breaking the server.
- The output maps to the existing Lite schemas.
- The connector does not recreate full Lindela ingestion orchestration.

## Pull Request Requirements

Every pull request should include:

- A concise explanation of the change and why it belongs in Lite.
- Tests or fixtures for parser, API, or scoring changes.
- Documentation updates when public behavior changes.
- A statement that no client data, secrets, WorldMonitor code, GDELT ingestion, or full Lindela internals were added.

Run tests before opening a pull request:

```bash
npm test
```

## Coding Guidelines

- Use Node built-ins unless a dependency is clearly necessary.
- Keep connectors small, auditable, and source-specific.
- Prefer transparent heuristics over opaque models.
- Store source attribution and freshness metadata.
- Avoid hidden network calls in tests.
- Keep examples realistic but synthetic.

## Data And Fixture Rules

Do not commit:

- API keys or tokens.
- Client, operational, classified, or sensitive data.
- Bulk downloaded datasets.
- Generated local stores under `data/*.json`.
- Trained model artifacts, coefficients, or validation sets from full Lindela.

Allowed fixtures:

- Small synthetic records.
- Small excerpts from public sources where redistribution is allowed.
- Minimal parser fixtures with source attribution.

## Trigger Protocol Examples

Trigger protocol examples live in `examples/trigger-protocols/`. They are configuration examples for downstream automation and response systems. They should remain declarative and portable: no embedded secrets, no customer-specific endpoints, and no proprietary Lindela actions.

## Security Issues

Do not file public issues for vulnerabilities, exposed credentials, or sensitive data leakage. Email the maintainers or use the repository security advisory process when available.

## License

By contributing, you agree that your contribution may be distributed under the Lindela Lite dual-license model described in `LICENSE`.
