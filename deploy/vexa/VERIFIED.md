# Vexa v0.12.28: verification record (M7 C1)

Checked on 2026-10-13 against the upstream repository at tag `v0.12.28`
(annotated tag object `6655035c1b1409ad6fc9119adee593b15e7373be` → commit
`f1a62fbbdfd2c98cb162582d82c31fe8102acc89`), its `deploy/compose/docker-compose.yml`,
`deploy/compose/.env.example`, `deploy/compose/Makefile` and
`deploy/compose/bin/provision-token`, plus the Docker Hub registry. No live gateway was
available, so items that need a running stack are marked **unverified** with the
fallback MeetSum uses.

| # | Item | Result at v0.12.28 | Status |
|---|---|---|---|
| 1 | Internal gateway port and service names | Compose project name `vexa-v012` upstream (we run `-p vexa`). Services: `redis` (valkey 8), `postgres` (17), `storage` (versitygw v1.8.0), `storage-init`, `admin-api` (:8001), `runtime` (:8090), `meeting-api` (:8080), `gateway` (:8000, health `GET /health`), plus `agent-api`, `agent-worker`, `flows-*`, `mcp`, `terminal`, `dashboard` that MeetSum does not start. Upstream binds every host port to `127.0.0.1` (gateway `18056→8000`). MeetSum: `VEXA_API_URL=http://vexa-gateway:8000` on the `meetsum-vexa` network. | verified |
| 2 | S3 bucket environment variable names | `meeting-api` and `storage-init` read `MINIO_ENDPOINT` (host:port), `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` (default `vexa`), `MINIO_SECURE`. `storage-init` ensures the bucket exists and round-trips a probe object under `.vexa-storage-init/`, so a bucket-scoped MinIO user works once `vexa-minio-init` has created the bucket. | verified |
| 3 | Shape of the `POST /bots` response | Not documented and not derivable from the compose files. Package A parses tolerantly (`id \| meeting_id \| meeting.id`); fixtures stay `_synthetic` until re-recorded with `scripts/bot-simulate.ts --record` against the staging gateway. | **unverified** |
| 4 | Webhook envelope | Not documented. Package B parses tolerantly (`event_type\|event\|type`, `data.meeting{…}` or top-level fields). Re-record on staging. | **unverified** |
| 5 | Does the gateway accept a private webhook URL? | The operator *system* webhook has an explicit `VEXA_SYSTEM_WEBHOOK_ALLOW_PRIVATE_HTTP=false` opt-in; the per-user webhook (`PUT /user/webhook`) policy is not visible in compose. `npm run vexa:configure` tries `VEXA_WEBHOOK_URL` first; if the gateway rejects the internal `http://meetsum-app:3000/...` URL, set `VEXA_WEBHOOK_URL=https://meetsum.realization.co.il/api/integrations/vexa/webhook`. | **unverified** (fallback documented) |
| 6 | Chat endpoint | Not visible in compose. Consent chat stays capability-probed (`…/chat`, then `…/acts`); `unsupported` makes the UI tell the host to announce the recording. | **unverified** (fallback built in) |
| 7 | How API tokens are minted | `deploy/compose/bin/provision-token`: with `X-Admin-API-Key: $ADMIN_TOKEN` against admin-api, resolve-or-create the user (`GET /admin/users/email/{email}`, else `POST /admin/users {email, max_concurrent_bots}`), then `POST /admin/users/{id}/tokens?scopes=bot,tx` returns `{token: "vxa_…"}`. Tokens are additive. See the runbook. | verified |

## Other findings that changed the plan

- **Bot image.** The spec assumed the bot must be built locally (`make bot`). At v0.12.28
  upstream's install path is the published, release-validated `vexaai/vexa-bot` image
  (`v012` moving tag; also `v0.12.28`). `vexaai/vexa-bot:dev` remains the incompatible 0.10
  line. MeetSum pins `vexaai/vexa-bot:v0.12.28@sha256:e2398b…` in `vexa.lock`;
  `VEXA_BUILD_BOT=1` builds from the checkout instead (`make -C deploy/compose bot`,
  tagged `vexa/vexa-bot:<sha12>`).
- **Version-pinned images exist.** Every service image is published as
  `vexaai/v012-<service>:v0.12.28`, so `compose.override.yml` pins tag + digest instead of
  the moving `v012` tag.
- **Secrets.** `ADMIN_TOKEN` has no fallback and admin-api / meeting-api refuse published
  placeholders; `INTERNAL_API_SECRET` has no default and services refuse to boot without it.
- **Transcription.** `TRANSCRIBE_ENABLED` defaults to `true` upstream; the override sets
  `false` (MeetSum sends `transcribe_enabled:false` per bot anyway).
- **Agent domain.** The gateway fronts `/agent/*` unless `AGENT_API_URL` is set empty; the
  override sets it empty so the agent services are not needed.
- **Runtime network.** The runtime attaches bots to `${COMPOSE_PROJECT_NAME}_vexa`; with
  `-p vexa` that is `vexa_vexa`, set explicitly as `DOCKER_NETWORK`.
- **Docker socket.** The runtime mounts `/var/run/docker.sock`. Whether it honours
  `DOCKER_HOST` (needed for `compose.socket-proxy.yml`) is **unverified**.
- **MinIO client image.** `minio/mc` is no longer pullable from Docker Hub;
  `vexa-minio-init` uses `bitnamilegacy/minio-client:2025.7.21-debian-12-r3` pinned by digest.
  (The production compose file's `minio/minio:latest` reference has the same problem; it is
  outside M7's files and is flagged in the runbook.)
