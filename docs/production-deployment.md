# Production Deployment

Last updated: May 18, 2026.

Production target: `/opt/meetsum` on the VPS.

## Architecture

Stateful services are separate from replaceable app code:

- `app`: Next.js UI/API, internal port `3000`, host port `3005`.
- `worker`: BullMQ background processor.
- `migrate`: one-shot `npm run db:migrate` container before app startup.
- `postgres`: persistent named volume.
- `redis`: persistent named volume.
- `minio`: persistent named volume.
- `faster-whisper`: optional local Hebrew ASR service.
- `n8n`: persistent named volume; profile-gated until live workflows are configured.

CI/CD may rebuild and replace `app`, `worker`, and `migrate` without deleting Postgres, Redis, or MinIO data.

## Compose

Production must pass the env file to Docker Compose because service interpolation happens before `env_file` is applied:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml up -d --build
```

The production compose file includes Traefik/Coolify labels for:

```text
meetsum.realization.co.il
```

The app joins the external `coolify` Docker network so Coolify's Traefik can reach the internal app port. Internal service URLs use stable aliases:

- `meetsum-postgres`
- `meetsum-redis`
- `meetsum-minio`
- `faster-whisper`

RealizeOS currently runs on the VPS host at port `8082`. MeetSum reaches it through:

```env
REALIZEOS_API_URL=http://host.docker.internal:8082
```

## Google Workspace

The first production subject is:

```env
GOOGLE_WORKSPACE_ADMIN_EMAIL=info@realization.co.il
GOOGLE_WORKSPACE_SUBJECT=info@realization.co.il
GOOGLE_SERVICE_ACCOUNT_EMAIL=meetsum-workspace-sync@meetsum-494211.iam.gserviceaccount.com
```

Production should prefer keyless domain-wide delegation. If keyless signing is not available, development may use a service-account JSON key mounted under `/opt/meetsum/secrets`, but key files must never be committed.

Recommended sync defaults:

```env
MEETSUM_SCHEDULE_GOOGLE_SYNC=true
MEETSUM_SCHEDULE_CALENDAR_SYNC=true
MEETSUM_SCHEDULE_DRIVE_SYNC=false
MEETSUM_CALENDAR_POLL_MINUTES=15
MEETSUM_CALENDAR_LOOKBACK_DAYS=30
MEETSUM_CALENDAR_LOOKAHEAD_DAYS=60
MEETSUM_CALENDAR_IMPORT_ALL=false
MEETSUM_DRIVE_POLL_MINUTES=30
```

Calendar polling can run automatically. Drive and recording import should remain operator-selected until retention, review, and storage behavior are fully trusted.

## AI Providers

Gemini AI Studio is the active API provider and fallback:

```env
GOOGLE_GENAI_USE_VERTEXAI=false
GOOGLE_GEMINI_API_KEY=...
```

Vertex AI is prepared but inactive. Switch only after service-account auth passes a live container smoke test:

```env
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=meetsum-494211
GOOGLE_CLOUD_LOCATION=global
GOOGLE_APPLICATION_CREDENTIALS=/opt/meetsum/secrets/vertex-ai-runtime.json
```

## Local Hebrew ASR

The recommended production transcription mode is:

```env
MEETSUM_TRANSCRIPTION_PROVIDER=auto
```

Run faster-whisper with:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml --profile local-asr up -d faster-whisper
```

Set:

```env
LOCAL_TRANSCRIPTION_URL=http://faster-whisper:8000
LOCAL_TRANSCRIPTION_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2
LOCAL_TRANSCRIPTION_LANGUAGE=he
LOCAL_TRANSCRIPTION_TIMEOUT_MS=900000
```

Current production smoke result: local Whisper was attempted for a Hebrew/mixed recording but fell back to Gemini. This is acceptable while fallback remains visible, but it is not acceptable as a final quality state. Debugging that fallback is the next priority.

Run private local ASR benchmarks with:

```bash
npm run asr:evaluate -- --manifest .secrets/asr-eval/manifest.json
```

Do not commit `.secrets/asr-eval`, private audio, reference transcripts, or evaluation output.

## Deploy Flow

Always backup before deployment:

```bash
cd /opt/meetsum
./scripts/backup-postgres.sh
git pull --ff-only
docker compose --env-file .env.local -f docker-compose.prod.yml build app migrate
docker compose --env-file .env.local -f docker-compose.prod.yml up -d --remove-orphans
```

The helper script performs the same flow:

```bash
cd /opt/meetsum
./scripts/deploy-vps.sh
```

Do not deploy docs-only changes unless explicitly requested.

## Health And Status

Primary health check:

```bash
curl -fsS https://meetsum.realization.co.il/api/health
```

Useful status surfaces:

- `GET /api/ai/providers/status`
- `GET /api/workspace/status`
- `GET /api/google/sync/status`
- `GET /api/jobs`
- `GET /api/integrations/realizeos/status`

Container status on the VPS:

```bash
cd /opt/meetsum
docker compose --env-file .env.local -f docker-compose.prod.yml ps
```

## Production Smoke Checklist

After a production deploy or major capture/AI change:

1. Confirm health returns `200`.
2. Confirm `app`, `worker`, `postgres`, `redis`, `minio`, and `faster-whisper` are running when local ASR is expected.
3. Confirm `/api/ai/providers/status` reports Gemini and local ASR status accurately.
4. Run or inspect Google Meet artifact sync.
5. Select one latest eligible Meet artifact or Drive recording; do not bulk import.
6. Import/process the selected item and confirm transcript, summary, tasks, tags, and quality warnings.
7. Confirm provider metadata shows whether `local-whisper`, Gemini, or fallback was used.
8. Open a public share page unauthenticated and verify audio/video is not exposed.
9. Render Markdown and PDF exports.
10. Preview or queue RealizeOS export only when external-send approval is intended.
11. Send a webhook test only to an approved n8n/test endpoint.

## Verification Commands

Run locally before handoff:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

## Retention

Default retention policy:

- Transcripts and summaries: retained indefinitely.
- Audio: retained 180 days by default.
- Raw video: not retained unless explicitly enabled.
- Private media is not exposed on public share pages.
