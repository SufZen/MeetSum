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

Use `--env-file .env.local` in production because Docker Compose interpolates service environment values before `env_file` is applied:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml up -d --build
```

The production compose file includes Traefik labels for:

```text
meetsum.realization.co.il
```

DNS must point that subdomain at the VPS before HTTPS issuance can work.

The VPS currently uses Coolify's Traefik proxy. Deployments that use `docker-compose.prod.yml` attach the `app` container to the external `coolify` Docker network and set `traefik.docker.network=coolify`, so Traefik can reach the internal app port.

RealizeOS currently runs directly on the VPS host at port `8082`. The production compose file maps `host.docker.internal` to the Docker host gateway for `app` and `worker`, so MeetSum can use `REALIZEOS_API_URL=http://host.docker.internal:8082` without exposing RealizeOS publicly.

Because the app joins both the MeetSum network and Coolify's network, internal service URLs use unique aliases:

- `meetsum-postgres`
- `meetsum-redis`
- `meetsum-minio`

## Health

`GET /api/health` returns app version, uptime, and status for database, Redis, and storage configuration without exposing secrets.

## Deploy Flow

```bash
cd /opt/meetsum
./scripts/backup-postgres.sh
git pull --ff-only
docker compose --env-file .env.local -f docker-compose.prod.yml build app migrate
docker compose --env-file .env.local -f docker-compose.prod.yml up -d --remove-orphans
```

The helper `scripts/deploy-vps.sh` performs the same flow.

The `worker` and bundled `n8n` services are profile-gated. Start them only when they are ready to do useful work:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml --profile worker up -d worker
docker compose --env-file .env.local -f docker-compose.prod.yml --profile automation up -d n8n
```
