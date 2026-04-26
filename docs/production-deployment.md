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

The production compose file includes Coolify/Traefik labels for:

```text
meetsum.realization.co.il
```

DNS must point that subdomain at the VPS before HTTPS issuance can work.

The VPS currently uses Coolify's Traefik proxy. Deployments that use `docker-compose.prod.yml` attach the `app` container to the external `coolify` Docker network and set `traefik.docker.network=coolify`, so Traefik can reach the internal app port.
Coolify's Traefik entrypoints are named `http` and `https`.

RealizeOS currently runs directly on the VPS host at port `8082`. The production compose file maps `host.docker.internal` to the Docker host gateway for `app` and `worker`, so MeetSum can use `REALIZEOS_API_URL=http://host.docker.internal:8082` without exposing RealizeOS publicly.

Google Workspace signing material is mounted read-only from:

```text
/opt/meetsum/secrets
```

Production should prefer keyless domain-wide delegation. Leave
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` and `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`
empty, set `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and give the runtime Application
Default Credentials permission to call IAM Credentials `signJwt` for that
service account.

```env
GOOGLE_WORKSPACE_ADMIN_EMAIL=info@realization.co.il
GOOGLE_WORKSPACE_SUBJECT=info@realization.co.il
GOOGLE_SERVICE_ACCOUNT_EMAIL=meetsum-workspace-sync@meetsum-494211.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=
MEETSUM_SCHEDULE_GOOGLE_SYNC=true
MEETSUM_CALENDAR_POLL_MINUTES=15
MEETSUM_DRIVE_POLL_MINUTES=30
```

If keyless signing is not available, development may still use
`GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/opt/meetsum/secrets/google-service-account.json`
or `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. Do not commit service-account JSON
files, Gemini keys, OAuth secrets, or meeting media.

For the temporary AI Studio Gemini key path, keep:

```env
GOOGLE_GENAI_USE_VERTEXAI=false
GOOGLE_GEMINI_API_KEY=...
```

For the production Vertex AI path, create a dedicated `meetsum-ai-runtime` service account, grant `roles/aiplatform.user`, store the JSON at `/opt/meetsum/secrets/vertex-ai-runtime.json`, and switch:

```env
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=meetsum-494211
GOOGLE_CLOUD_LOCATION=global
GOOGLE_APPLICATION_CREDENTIALS=/opt/meetsum/secrets/vertex-ai-runtime.json
```

Because the app joins both the MeetSum network and Coolify's network, internal service URLs use unique aliases:

- `meetsum-postgres`
- `meetsum-redis`
- `meetsum-minio`

## Health

`GET /api/health` returns app version, uptime, and status for database, Redis, and storage configuration without exposing secrets.

Operational UI status comes from:

- `GET /api/ai/providers/status`
- `GET /api/workspace/status`
- `GET /api/google/sync/status`
- `GET /api/jobs`

## Deploy Flow

```bash
cd /opt/meetsum
./scripts/backup-postgres.sh
git pull --ff-only
docker compose --env-file .env.local -f docker-compose.prod.yml build app migrate
docker compose --env-file .env.local -f docker-compose.prod.yml up -d --remove-orphans
```

The helper `scripts/deploy-vps.sh` performs the same flow.

The `worker` runs by default because uploads, Gemini transcription, Google polling, RealizeOS export, and retryable jobs all depend on it. The bundled `n8n` service remains profile-gated until a live workflow is created:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml --profile automation up -d n8n
```
