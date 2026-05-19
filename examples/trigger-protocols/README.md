# Trigger Protocol Examples

These examples show how downstream projects can turn Lindela Lite API outputs into clear monitoring and response triggers.

The files are intentionally declarative. They are not proprietary Lindela workflow definitions and they do not require full Lindela reporting, wargaming, source reliability, or orchestration systems.

## Files

- `flood-watch.json` monitors flood risk and flood-related hazard events.
- `climate-conflict-watch.json` monitors climate-conflict risk and user-supplied conflict events.
- `service-impact-watch.json` monitors impact scores for health, water, education, transport, power, and telecom assets.

## Common Shape

Each protocol includes:

- `id` and `name` for stable identification.
- `purpose` for human-readable intent.
- `poll` describing the Lite API endpoint and cadence.
- `scope` filters such as country, bbox, or service type.
- `triggers` with threshold conditions.
- `actions` with portable response instructions.
- `suppression` to avoid noisy repeated triggers.
- `review` to clarify human approval expectations.

## How To Use

Run Lindela Lite locally:

```bash
npm start
```

Inspect the relevant endpoint:

```bash
curl http://127.0.0.1:4177/api/v1/flood-risk
curl http://127.0.0.1:4177/api/v1/conflict-risk
curl http://127.0.0.1:4177/api/v1/service-impacts
```

Load a protocol into your scheduler, workflow runner, or integration service. The examples use generic actions such as `notify`, `create_ticket`, and `export_snapshot` so they can be adapted to many environments.

## Safety Notes

- Treat scores as decision support, not automated determinations.
- Keep a human review step for high-impact actions.
- Check data freshness before acting.
- Do not embed secrets or customer-specific endpoints in committed protocol files.
- Do not add GDELT-based triggers to this repository.
