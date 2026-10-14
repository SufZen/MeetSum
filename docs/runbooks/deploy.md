# Runbook: deploy, readiness and rollback

MeetSum has one deploy path: `scripts/deploy-vps.sh`. The GitHub workflow `.github/workflows/deploy.yml` only runs that script on the VPS over SSH, and operators run the same script by hand. Spec: `docs/parity/m10.md` ("Deploy", package B).

## The gate

A deploy runs only when **all** of these hold:

- the `CI` workflow succeeded for a **push to `main`** (typecheck, lint, design-system check, tests, `next build`, bundle check and the schema job, on Node 24);
- the repository variable **`DEPLOY_ENABLED` is `true`** (it is unset today, so nothing deploys);
- the job's **`production` environment** allows it (add required reviewers in the repository settings if you want a manual approval).

`workflow_dispatch` (manual "Run workflow") still needs `DEPLOY_ENABLED=true` and runs on `main` only. A CI-triggered deploy passes `DEPLOY_SHA`, and the script fast-forwards the VPS checkout to exactly that commit. Deploys are serialized by the workflow's concurrency group and by the deploy lock on the host.

Secrets used by the workflow: `VPS_HOST`, `VPS_USER`, `SSH_PRIVATE_KEY`, optional `VPS_PORT`. The workflow never reads `.env.local`.

## What `deploy-vps.sh` does

```bash
cd /opt/meetsum
./scripts/deploy-vps.sh             # deploy origin/main
DEPLOY_SHA=<sha> ./scripts/deploy-vps.sh
./scripts/deploy-vps.sh --dry-run   # print the plan, execute nothing
```

1. **Lock.** `flock -w 600 /opt/meetsum/.deploy.lock` serializes manual and CI deploys (and rollbacks).
2. **Preflight.** The env file (`.env.local`) exists, `docker compose config -q` passes for the prod and migrate files, and at least 5 GB is free under `/opt/meetsum`.
3. **Backup (hard fail).** `scripts/backup-postgres.sh` writes `backups/postgres/meetsum-postgres-<UTC>.dump`. A failed or empty dump stops the deploy.
4. **Pull.** It records `PREV_SHA`, then runs `git pull --ff-only origin main` (or `git fetch` + `git merge --ff-only $DEPLOY_SHA`).
5. **One build.** `docker compose build app` builds `meetsum:<sha12>` with `MEETSUM_GIT_SHA` as a build arg (the Sentry release and the image's `org.opencontainers.image.revision` label). `worker` and `migrate` use the same image, so there is exactly one `next build` per deploy.
6. **Migrations before the switch.** `docker compose -f docker-compose.prod.yml -f docker-compose.migrate.yml run --rm migrate` runs with the **new** image while the old release is still serving. If it fails, app and worker are not switched and the checkout returns to `PREV_SHA`.
7. **Switch.** `meetsum:current` is retagged `meetsum:previous`, then `up -d --no-deps app worker` starts the new image.
8. **Readiness.** For up to 120 s it polls `wget -qO- http://127.0.0.1:3000/api/health/ready` inside the app container and the worker's `/ready` (`MEETSUM_WORKER_HEALTH_PORT`, default 3101) inside the worker container. Both must answer 200.
9. **Success:** `meetsum:<sha12>` is tagged `meetsum:current`. **Failure:** automatic rollback (below), then the script exits non-zero so the workflow run fails.

The script never prints environment values. Compose reads `.env.local` itself.

## Readiness endpoints

| Endpoint | Where | Checks | Answers |
|---|---|---|---|
| `GET /api/health/live` | app (public) | none (process is up) | 200 `{status:"ok"}` |
| `GET /api/health/ready` | app (public) | database `select 1` (2 s), Redis `PING` (1 s), S3 `HeadBucket` (2 s), migrations (database not behind `db/migrations`) | 200 or 503 `{status, checks:{database, redis, storage, migrations}}`, each `ok`/`fail`/`skip` |
| `GET /api/health` | app (public, legacy shape) | as before, with a real Redis ping and storage check | 200 |
| `GET /live` | worker, container-internal | event-loop lag < 2 s | 200/503 |
| `GET /ready` | worker, container-internal | Redis `PING`, database, every started BullMQ worker `isRunning()` | 200/503 `{status, checks:{redis, database, workers}}` |

The probes never return error text, hosts or versions. The public ones are rate-limited per IP (120/min, in-process). The worker port is never published.

The compose healthchecks use `/api/health/ready` (app) and `/ready` (worker). Note: Traefik stops routing to a container Docker marks unhealthy, so a Redis or MinIO outage that lasts longer than the healthcheck window (5 × 30 s) takes the site out of rotation. That is intended (the app cannot serve uploads or jobs without them), but expect it during maintenance.

The migrations check accepts a database that is *ahead* of the files. After an automatic rollback, the previous release runs on a schema that already has the new (backward-compatible) migration, and it must still become ready.

## Automatic rollback

When readiness times out after the switch:

1. app and worker go back to **`meetsum:previous`** (`up -d --no-deps app worker` with `MEETSUM_IMAGE_TAG=previous`);
2. the checkout returns to `PREV_SHA` (`git reset --keep`, which refuses to overwrite local changes);
3. readiness is awaited again; on success `meetsum:previous` becomes `meetsum:current`;
4. the script exits non-zero either way.

**The database is not rolled back.** The new migration stays applied; that's why migrations must be backward-compatible (below). If a migration damaged data, restore the pre-deploy backup by hand (next section).

The very first deploy with this script has no `meetsum:previous` (older deploys built `meetsum-app`/`meetsum-worker` images), so it cannot roll back automatically. Watch that one.

## Manual rollback

```bash
./scripts/rollback-vps.sh            # back to meetsum:previous and its SHA (from the image label)
./scripts/rollback-vps.sh <sha>      # back to <sha>; rebuilds meetsum:<sha12> if the image is gone
./scripts/rollback-vps.sh --dry-run
```

It takes the same lock and waits for readiness.

## Restoring the database (manual, destructive)

Only when a release corrupted data and the forward fix is worse than losing the writes made since the backup:

1. Stop writers: `docker compose -f docker-compose.prod.yml --env-file .env.local stop app worker`.
2. Take one more backup of the current state: `./scripts/backup-postgres.sh`.
3. Restore the pre-deploy dump (the path the deploy printed):
   ```bash
   ./scripts/restore-postgres.sh backups/postgres/meetsum-postgres-<UTC>.dump --confirm-restore
   ```
4. Roll the code back to the release that matches that schema (`./scripts/rollback-vps.sh <sha>`), which also starts app and worker.
5. Check `/api/health/ready` and a meeting page.

## Expand/contract migrations

Migrations are forward-only and run before the new code serves traffic, while the previous release is still running. Each release must therefore work with both the old and the new schema:

- **Expand first:** add tables, nullable columns, new indexes and backfills in one release. The old code ignores them. The runner wraps each migration in a transaction, so `create index concurrently` isn't available there; build a large index by hand in a maintenance window and make the migration's `create index if not exists` a no-op.
- **Switch:** the next release starts reading and writing the new shape.
- **Contract last:** drop old columns or tables only in a later release, once no deployed code reads them (migration 032 is an example: `integration_endpoints` had no readers since M8).
- Never rename or drop something the previous release still reads in the same release that stops reading it.
- Make migrations idempotent (`if not exists`, guarded `do $$` blocks); a re-run must be a no-op.

## Backup and restore drill

Run this at least once per quarter, and before risky migrations:

1. `./scripts/backup-postgres.sh` and note the file.
2. Start a scratch Postgres with the production image:
   ```bash
   docker run -d --name restore-drill -e POSTGRES_PASSWORD=drill pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21
   docker exec restore-drill sh -c 'until pg_isready -U postgres; do sleep 1; done; createdb -U postgres meetings'
   docker exec -i restore-drill pg_restore -U postgres -d meetings --no-owner --no-privileges < backups/postgres/<file>.dump
   ```
3. Compare row counts for `meetings`, `transcript_segments`, `workspaces` and `schema_migrations` with production.
4. `docker rm -f restore-drill`.

The full backup (Postgres plus MinIO) is in `docs/backup-restore.md`.

## Images

Every third-party image is pinned by tag **and** digest in the compose files and the Dockerfiles (`tests/image-pins.test.ts`). The two images built here (`meetsum:<sha12>` and `meetsum-minio:<release>`) are allowed without a digest because their own base images are pinned. Digests were resolved on 2026-10-14 with the registry API. `.github/dependabot.yml` proposes weekly bumps for Docker images, compose files and GitHub Actions.

| Service | Image |
|---|---|
| app, worker, migrate | `meetsum:<sha12>` built from the `Dockerfile` (`node:24.21.0-alpine@sha256:ebfe2f90…`) |
| postgres | `pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adf…` (Debian; see `postgres-17-pgvector.md`) |
| redis | `redis:7.4.11-alpine@sha256:858f009f…` |
| minio | `meetsum-minio:RELEASE.2025-10-15T17-29-55Z`, built from the official source by `deploy/minio/Dockerfile` (`golang:1.26.9-alpine@sha256:3082400e…` build stage, `alpine:3.22.6@sha256:5291449c…` runtime; see below) |
| n8n (profile `automation`) | `n8nio/n8n:2.43.4@sha256:c34ee910…` (what `latest` pointed to on 2026-10-14) |
| faster-whisper (profile `local-asr`) | `fedirz/faster-whisper-server:0.5.0-cpu@sha256:760e5e43…` (what `latest-cpu` pointed to) |

**MinIO (R16).** MinIO stopped publishing community images, and `minio/minio` no longer resolves on Docker Hub (checked 2026-10-14; `quay.io/minio/minio` requires auth). The user decision is to build our own image from the official source rather than trust a third-party rebuild. `deploy/minio/Dockerfile`:

- clones `github.com/minio/minio` at `RELEASE.2025-10-15T17-29-55Z` (commit `9e49d5e7`) and `github.com/minio/mc` at `RELEASE.2025-08-13T08-35-41Z` (commit `7394ce0d`), the last official release tags on 2026-10-14 (GitHub API), and fails if a tag no longer points at the pinned commit;
- builds both with upstream's flags (`CGO_ENABLED=0`, `-tags kqueue`, `-trimpath`, the version ldflags from `buildscripts/gen-ldflags.go`), no prebuilt binaries;
- copies them onto a pinned Alpine runtime that runs as root with data in `/data`, like MinIO's own image. The existing `minio-data` volume, the `command` and the `mc ready local` healthcheck are unchanged. The AGPL `LICENSE` and `CREDITS` files are in `/licenses`.

Operating it:

- **First switch on an existing host** (from `coollabsio/minio`; the deploy script only recreates `app` and `worker`): back up first (`npm run backup:full`), then `docker compose -f docker-compose.prod.yml build minio` (a few minutes: it compiles Go) and `docker compose -f docker-compose.prod.yml up -d minio`. The volume is reused as is; check `/api/health/ready` reports `storage: ok`.
- **Fresh host:** `docker compose up -d` builds the image the first time (the default pull policy builds a missing image that has a `build` section).
- **Updating MinIO:** change the four `ARG`s (release tags and commits; verify with `git ls-remote --tags https://github.com/minio/minio <tag>`, and for an annotated tag use the commit on its `^{}` line), the `image:` tag in both compose files, and this table, then rebuild. If a newer Go toolchain ever fails to compile a release, the Dockerfile names the Go 1.24 digest MinIO itself built with.
- Dependabot cannot see upstream source releases, so MinIO security fixes stay a **manual watch item** (the upstream repository now ships source only).
- **Not verified locally:** the image was written without a Docker daemon on the integration machine. Build it once (`docker compose build minio`) before the first deploy that needs it.
- **Future option:** move production object storage to Garage or SeaweedFS (the e2e workflow already runs SeaweedFS as its S3 server, and Vexa uses versitygw). Both speak the S3 API the app uses; the move is a data migration (`mc mirror` into the new bucket) plus `S3_ENDPOINT`/credential changes, not a code change.

**n8n** moved from 1.x to 2.x upstream. If an existing n8n volume was created by 1.x, read the n8n 2.0 migration notes before starting the `automation` profile on this pin.

## Logs

Compose keeps each container's logs as `json-file` with rotation (`max-size: 10m`, `max-file: 5`). App and worker write pino JSON; see `observability.md`.
