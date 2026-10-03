# ADR-009: An external scheduler sidecar rather than in-process timers

**Status:** Accepted
**Applies to:** `docker-compose.yml`, `src/ingestion.js`, `src/outbox.js`
**Deciders:** whoever operates a deployment

## Context

The product does four things on a schedule:

- poll sources whose `interval_minutes` has elapsed,
- run due report schedules,
- dispatch pending outbox events to webhooks,
- apply retention.

Only the first two are scheduled at all. The third requires `POST /api/v1/outbox/dispatch` and the
fourth `POST /api/v1/maintenance/apply-retention`, and **nothing in the system calls either on a
timer.** So does `POST /api/v1/analytics/bias-correct`, `POST /api/v1/kpi/refresh-snapshots` or
`POST /api/v1/equity/scan`. They are manual endpoints.

The natural implementation for the first two is a `setInterval` inside the Node process. The codebase
has **none**: `grep setInterval src/` returns nothing, and the only timers are HTTP timeouts.

## Decision

Schedule externally. A third compose service runs a shell loop and POSTs to the API:

```yaml
scheduler:
  command: >
    sh -c 'while true; do
      curl -X POST http://app:4177/api/v1/ingest/run-due
      curl -X POST http://api:4177/api/v1/report-schedules/run-due
      sleep ${LINDELA_LITE_SCHEDULER_INTERVAL_SECONDS:-900}; done'
```

The app keeps the state — `next_run_at` on each schedule — and the scheduler only says *now*. A
schedule is due when `status === 'active' && next_run_at <= now`, so a missed cycle is caught up by
the next one rather than skipped.

## Options considered

### `setInterval` inside the Node process

| Dimension | Assessment |
|---|---|
| Deployment | Simplest — one service |
| Restart behaviour | Timers are lost on restart; recovery depends on what runs at boot |
| Overlap | A slow run silently overlaps the next tick; nothing prevents it |
| Testability | Tests must control time; the suite would need a fake clock |
| Multi-instance | Two app instances means two schedulers, double-fetching every source |

**Rejected**, primarily on the last two. The overlap problem is the quiet one: ingestion already runs
sources sequentially with per-connector timeouts up to 60 s, so a tick that arrives mid-run is not
hypothetical.

### Cron inside the container

**Rejected.** It needs a crond process and its own config file, for a job that is one `curl`. It also
introduces a scheduler whose cadence is invisible to anyone reading the compose file — the loop above
is self-documenting.

### A real job queue (BullMQ, Sidekiq, pg-bq)

**Rejected.** A broker is a service to run, secure and back up, for a workload of one POST every
fifteen minutes. It becomes the single most fragile thing in the deployment.

### Kubernetes CronJob

**Rejected on scope.** The product's one-click path is `docker compose up`. Adding a cluster
requirement to a product that installs on a laptop is the wrong trade.

## Consequences

**Easier**

- The app is stateless about time. Restart it, and the next tick finds whatever is due.
- **Overlap is impossible.** One loop, one request at a time. The schedule's `next_run_at` is advanced
  by the run that just finished, so the loop interval and the schedule interval compose without
  coordination.
- The cadence is legible: the interval is an environment variable with a default, visible in the
  compose file.
- `pg0` development and a production Postgres deployment run the same code path.

**Harder**

- **If the scheduler container dies, ingestion stops silently.** Nothing in the app notices. There is
  no heartbeat, no lock, no lease, and no in-process timer to fail loudly. This is the most important
  operational fact about the deployment and it is handled by *detection*, not prevention — see below.
- The app and the scheduler can disagree about what "now" means if clocks drift. Both are containers on
  one host, so the drift is bounded and small relative to a 15-minute interval.
- Four capabilities that are obviously periodic — outbox dispatch, retention, KPI refresh, bias
  correction — are still manual endpoints. The mechanism exists; they were never moved onto it.

**Revisit when**

- Ingestion becomes long enough that a 15-minute loop is too coarse. The answer is to move sources onto
  `interval_minutes: 0` with a computed `next_run_at`, not to add a scheduler.
- Outbox dispatch moves from manual to scheduled, which is the single highest-value thing to add to
  the loop — a webhook that only fires when someone POSTs is not a webhook.

## Detecting a dead scheduler

There is no self-check, so the detection is a query. `GET /api/v1/ingest/status` returns per source:

```json
{ "source": "gdacs", "status": "fresh", "last_run": "...", "failure_streak": 0,
  "schedule": { "next_run_at": "..." } }
```

`status` is derived by `sourceHealth`: `never_run` → `failed` → `stale` (last run older than
`stale_after_minutes`) → `degraded` → `fresh`. A dead scheduler shows as every source sitting at
`fresh` with a `last_run` that stops advancing. **That is the signature**, and it is easy to mistake for
health, which is why it belongs in this ADR rather than only in the runbook.

The other half is `GET /api/v1/health`, which is the compose healthcheck target and reports the store
mode. It does not report ingestion recency, and it should.

Related: [deployment.md](../../deployment.md)