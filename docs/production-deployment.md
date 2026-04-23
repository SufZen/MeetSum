# Production Deployment

Production target: `/opt/meetsum` on the VPS.

## Architecture

Stateful services are separate from replaceable app code:

- `app`: Next.js UI/API, internal port `3000`, host port `3005`.
- `worker`: background/MCP process.
- `migrate`: one-shot `npm run db:migrate` container before app startup.
- `postgres`: persistent named volume.
- `redis`: persistent named volume.
- `minio`: persistent named volume.
- `n8n`: persistent named volume; workflow execution is deferred for now.

CI/CD may rebuild and replace `app`, `worker`, and `migrate` without deleting Postgres, Redis, or MinIO data.

## Compose

Use:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The production compose file includes Traefik labels for:

```text
meetsum.realization.co.il
```

DNS must point that subdomain at the VPS before HTTPS issuance can work.

## Health

`GET /api/health` returns app version, uptime, and status for database, Redis, and storage configuration without exposing secrets.

## Deploy Flow

```bash
cd /opt/meetsum
./scripts/backup-postgres.sh
git pull --ff-only
docker compose -f docker-compose.prod.yml build app worker migrate
docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

The helper `scripts/deploy-vps.sh` performs the same flow.
