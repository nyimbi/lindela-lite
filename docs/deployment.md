# One-Click Deployment

Lindela Lite ships with a Docker Compose deployment that runs the platform, PostgreSQL, and a scheduler sidecar. The goal is one operational command on any Docker-capable machine:

```bash
./deploy/one-click.sh
```

or:

```bash
npm run deploy:one-click
```

The script creates local secrets, builds the app image, starts the stack, waits for health, and initializes default public-source ingestion schedules.

## What The One-Click Stack Provides

- `app`: Lindela Lite API and dashboard.
- `db`: PostgreSQL 16 with a persistent Docker volume.
- `scheduler`: a lightweight sidecar that calls:
  - `POST /api/v1/ingest/run-due`
  - `POST /api/v1/report-schedules/run-due`
- `.env`: generated from `.env.example` with local secrets.
- Health checks for Postgres and the app.
- Restart policy for all services.

This is the recommended default deployment because it is portable, auditable, and does not require platform-specific infrastructure.

## Prerequisites

- Docker Engine or Docker Desktop.
- Docker Compose v2, or the legacy `docker-compose` command.
- A host port available for `LINDELA_LITE_PORT` (default `4177`).

## Quick Start

Run:

```bash
./deploy/one-click.sh
```

When it completes, open:

```text
http://127.0.0.1:4177
```

The script writes the generated `LINDELA_LITE_API_KEY` into `.env`. Paste that value into the dashboard API key field before using dashboard buttons that create incidents, run ingestion, send RapidPro alerts, or generate reports.

Useful URLs:

```text
http://127.0.0.1:4177/api/v1/health
http://127.0.0.1:4177/docs/platform.md
http://127.0.0.1:4177/docs/deployment.md
```

## Deployment Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Production app image. |
| `docker-compose.yml` | App, PostgreSQL, scheduler, health checks, persistent volume. |
| `.env.example` | Editable deployment configuration template. |
| `deploy/one-click.sh` | Bootstrap script for local or VPS deployment. |
| `.dockerignore` | Keeps local data, node modules, secrets, and git metadata out of the image. |

## What The Script Does

1. Verifies Docker and Docker Compose are available.
2. Creates `.env` from `.env.example` when `.env` does not exist.
3. Generates a `LINDELA_LITE_API_KEY`.
4. Generates a PostgreSQL password.
5. Updates `LINDELA_LITE_DATABASE_URL` to use the generated database password.
6. Runs `docker compose up -d --build`.
7. Waits for `GET /api/v1/health` to pass.
8. Calls `POST /api/v1/ingest/schedules/defaults` so regular public-source ingestion is ready.
9. Prints the dashboard URL and common compose commands.

The script does not overwrite an existing `.env`. To rotate generated local secrets, edit `.env` intentionally and restart the stack.

## Configuration

Edit `.env` after first run.

### Core Settings

```env
LINDELA_LITE_PORT=4177
LINDELA_LITE_API_KEY=generated-by-script
LINDELA_LITE_DB_MODE=postgres
LINDELA_LITE_DATABASE_URL=postgresql://lindela:password@db:5432/lindela_lite
```

### PostgreSQL

```env
POSTGRES_DB=lindela_lite
POSTGRES_USER=lindela
POSTGRES_PASSWORD=generated-by-script
```

### Scheduler

```env
LINDELA_LITE_SCHEDULER_INTERVAL_SECONDS=900
```

The scheduler interval controls how often the sidecar checks due ingestion and report schedules. Each schedule still controls its own next-run time.

### RapidPro

```env
RAPIDPRO_BASE_URL=https://rapidpro.io
RAPIDPRO_API_TOKEN=
RAPIDPRO_ALERT_MODE=flow_start
RAPIDPRO_ALERT_FLOW_UUID=
RAPIDPRO_WEBHOOK_SECRET=
```

Leave RapidPro values blank when SMS integration is not needed.

## Operations

Start or update the stack:

```bash
docker compose up -d --build
```

View status:

```bash
docker compose ps
```

Follow logs:

```bash
docker compose logs -f app
docker compose logs -f scheduler
docker compose logs -f db
```

Stop the stack:

```bash
docker compose down
```

Stop and delete the database volume:

```bash
docker compose down -v
```

Only use `down -v` when you intentionally want to delete the local PostgreSQL data.

## Backups

Create a PostgreSQL dump:

```bash
docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > lindela-lite-backup.sql
```

Restore into a fresh database:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB" < lindela-lite-backup.sql
```

Keep backups outside the repository. They may contain operational records, field reports, or recipient data.

## Updating

Pull or copy the new code, then run:

```bash
./deploy/one-click.sh
```

or:

```bash
docker compose up -d --build
```

The database volume is preserved across rebuilds.

## Host And HTTPS

For a VPS or shared server:

1. Run `./deploy/one-click.sh` on the host.
2. Put a reverse proxy such as Nginx, Caddy, Traefik, or a managed load balancer in front of port `4177`.
3. Terminate HTTPS at the proxy.
4. Keep `LINDELA_LITE_API_KEY` enabled.
5. Restrict direct access to the Docker host where possible.

Lite itself does not manage TLS certificates.

## Health Checks

Use:

```bash
curl http://127.0.0.1:4177/api/v1/health
curl http://127.0.0.1:4177/api/v1/ingest/status
```

Docker also checks app health internally:

```bash
docker compose ps
```

## Scheduler Behavior

The scheduler sidecar checks due work repeatedly:

```text
POST /api/v1/ingest/run-due
POST /api/v1/report-schedules/run-due
```

This keeps scheduling explicit and auditable. It also avoids embedding a hidden background timer in the app process.

Create default ingestion schedules again if needed:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/schedules/defaults \
  -H "x-api-key: $LINDELA_LITE_API_KEY"
```

## Troubleshooting

### Docker Is Not Running

Start Docker Desktop or the Docker service, then rerun:

```bash
./deploy/one-click.sh
```

### Port Is Already In Use

Edit `.env`:

```env
LINDELA_LITE_PORT=4180
```

Then restart:

```bash
docker compose up -d
```

### App Is Unhealthy

Check logs:

```bash
docker compose logs --tail=200 app
docker compose logs --tail=200 db
```

Check the database URL in `.env`.

### API Mutations Return 401

Include the API key:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run-due \
  -H "x-api-key: $LINDELA_LITE_API_KEY"
```

### Scheduler Is Running But Nothing Happens

Inspect schedules:

```bash
curl http://127.0.0.1:4177/api/v1/ingest/schedules
curl http://127.0.0.1:4177/api/v1/report-schedules
```

Due-run endpoints only process schedules whose `next_run_at` is due and whose `status` is `active`.

## Verification

Before publishing a deployment change:

```bash
bash -n deploy/one-click.sh
docker compose config
npm run validate
npm test
```

`docker compose config` validates the Compose file. It does not build or run containers.
