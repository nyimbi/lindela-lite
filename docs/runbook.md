# Lindela Lite Operations Runbook

This runbook is for operators responsible for keeping a Lindela Lite deployment healthy.

## Daily Checks

1. Check service health.
2. Check source health.
3. Check data quality.
4. Check scheduler freshness.
5. Check RapidPro dispatch failures if RapidPro is enabled.
6. Check open alerts and critical incidents.
7. Confirm scheduled reports ran when expected.

Commands:

```bash
curl -fsS http://127.0.0.1:4177/api/v1/health
curl -fsS http://127.0.0.1:4177/api/v1/ingest/status
curl -fsS http://127.0.0.1:4177/api/v1/data-quality
curl -fsS http://127.0.0.1:4177/api/v1/operations/summary
curl -fsS http://127.0.0.1:4177/api/v1/alert-events
curl -fsS http://127.0.0.1:4177/api/v1/report-schedule-runs
```

With API key, GET requests still do not need `x-api-key`.

## Scheduler Checks

The one-click deployment uses a scheduler sidecar. Check that schedules exist:

```bash
curl -fsS http://127.0.0.1:4177/api/v1/ingest/schedules
curl -fsS http://127.0.0.1:4177/api/v1/report-schedules
```

Manually trigger due schedules:

```bash
curl -fsS -X POST http://127.0.0.1:4177/api/v1/ingest/run-due \
  -H "x-api-key: $LINDELA_LITE_API_KEY"

curl -fsS -X POST http://127.0.0.1:4177/api/v1/report-schedules/run-due \
  -H "x-api-key: $LINDELA_LITE_API_KEY"
```

If these manual calls work but automatic runs do not, inspect the external scheduler, scheduler sidecar logs, or cron/systemd configuration.

## Incident Response

### App Is Down

1. Check process/container status.
2. Check logs.
3. Check database availability.
4. Restart the app.
5. Verify `/api/v1/health`.

Docker Compose:

```bash
docker compose ps
docker compose logs --tail=200 app
docker compose restart app
curl -fsS http://127.0.0.1:4177/api/v1/health
```

Local npm:

```bash
npm start
curl -fsS http://127.0.0.1:4177/api/v1/health
```

### Database Is Unavailable

Symptoms:

- App startup failure in `postgres` mode.
- Health endpoint fails.
- Mutating API calls fail.

Checks:

```bash
docker compose ps db
docker compose logs --tail=200 db
docker compose exec db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Recovery:

1. Restart database container/service.
2. Confirm credentials in `.env`.
3. Confirm `LINDELA_LITE_DATABASE_URL`.
4. Restore from backup if data volume is corrupt.

### Source Ingestion Fails

1. Inspect `/api/v1/ingest/status`.
2. Find the failed `last_run`.
3. Inspect `errors` and `diagnostics`.
4. Run the source manually.
5. Increase timeout/retries if failures are transient.
6. Pause the schedule if the upstream source is unavailable for an extended period.

Pause:

```bash
curl -X PATCH http://127.0.0.1:4177/api/v1/ingest/schedules/ingestion_schedule_... \
  -H 'content-type: application/json' \
  -H "x-api-key: $LINDELA_LITE_API_KEY" \
  -d '{"status":"paused"}'
```

Resume:

```bash
curl -X PATCH http://127.0.0.1:4177/api/v1/ingest/schedules/ingestion_schedule_... \
  -H 'content-type: application/json' \
  -H "x-api-key: $LINDELA_LITE_API_KEY" \
  -d '{"status":"active"}'
```

### Reports Do Not Run

1. Check `/api/v1/report-schedules`.
2. Confirm `status` is `active`.
3. Confirm `next_run_at` is due.
4. Confirm referenced template exists.
5. Call `POST /api/v1/report-schedules/run-due`.
6. Inspect `/api/v1/report-schedule-runs`.

If a template was deleted or missing, Lite records a failed schedule run and advances the schedule. Recreate or patch the schedule to point at a valid template.

### RapidPro Dispatch Fails

1. Check `/api/v1/rapidpro/status`.
2. Confirm `RAPIDPRO_API_TOKEN`.
3. Confirm `RAPIDPRO_BASE_URL`.
4. Confirm `RAPIDPRO_ALERT_FLOW_UUID` for flow-start mode.
5. Confirm recipients.
6. Inspect `/api/v1/rapidpro/dispatches`.

Retry by sending the alert/report again after configuration is corrected.

### RapidPro Inbound Webhook Fails

1. Confirm RapidPro is calling `/api/v1/rapidpro/field-report`.
2. Confirm `RAPIDPRO_WEBHOOK_SECRET`.
3. Confirm RapidPro sends one of:
   - `x-rapidpro-secret`
   - `Authorization: Bearer <secret>`
   - `?secret=<secret>`
4. Inspect `/api/v1/rapidpro/inbound`.

When `LINDELA_LITE_API_KEY` is enabled, the RapidPro webhook secret can authenticate this endpoint without the general API key.

## Backups

### JSON Mode

Back up:

```bash
cp data/lindela-lite-store.json "backups/lindela-lite-store-$(date +%Y%m%d%H%M%S).json"
```

Restore:

```bash
cp backups/lindela-lite-store-YYYYMMDDHHMMSS.json data/lindela-lite-store.json
```

Restart the app after restore.

### PostgreSQL Mode

Back up:

```bash
pg_dump "$LINDELA_LITE_DATABASE_URL" > "backups/lindela-lite-$(date +%Y%m%d%H%M%S).sql"
```

Docker Compose:

```bash
docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/lindela-lite.sql
```

Restore into a clean database:

```bash
psql "$LINDELA_LITE_DATABASE_URL" < backups/lindela-lite.sql
```

## Updates

Recommended update flow:

1. Back up the store/database.
2. Pull or deploy the new code.
3. Run validation/tests where possible.
4. Rebuild/restart.
5. Check health.
6. Run due ingestion and report schedules.
7. Check source health and report schedule runs.

Docker Compose:

```bash
docker compose pull || true
docker compose up -d --build
curl -fsS http://127.0.0.1:4177/api/v1/health
```

## Security Operations

- Keep `.env` out of source control.
- Rotate `LINDELA_LITE_API_KEY` after operator turnover.
- Rotate RapidPro tokens if exposed.
- Put the app behind HTTPS outside localhost.
- Use reverse-proxy access control for shared deployments.
- Avoid storing sensitive personal data unless the deployment has appropriate policy controls.

## Release Verification Checklist

Before calling a deployment healthy:

- `GET /api/v1/health` returns `success: true`.
- `GET /api/v1/sources` returns expected source ids.
- `GET /api/v1/ingest/status` has no unexpected failed/stale regular sources.
- `POST /api/v1/ingest/run-due` succeeds with the API key.
- `POST /api/v1/report-schedules/run-due` succeeds with the API key.
- Dashboard loads.
- Dashboard mutating action works with API key.
- RapidPro status is expected for the environment.
- Backup procedure has been tested.

