# MeetSum Architecture

Last updated: May 18, 2026.

MeetSum is a self-hosted modular monolith with clear integration boundaries. The app is optimized for a Google-first meeting workflow: Calendar supplies schedule context, Google Meet and Drive supply content artifacts, the worker turns content into intelligence, and the UI/API expose that intelligence to humans, RealizeOS, webhooks, CLI, MCP, and future agents.

## Production Shape

Production runs under `/opt/meetsum` on the VPS.

- `app`: Next.js UI and REST API, exposed internally on port `3000` and externally through host port `3005`/Traefik.
- `worker`: BullMQ processor for sync, import, transcription, summaries, webhooks, RealizeOS exports, and retryable jobs.
- `migrate`: one-shot migration runner for `npm run db:migrate`.
- `postgres`: system of record for meetings, Google state, media, transcripts, summaries, tasks, tags, Rooms, shares, participants, AI runs, jobs, webhooks, and integration runs.
- `redis`: BullMQ queues, locks, retry state, and scheduled job coordination.
- `minio`: private S3-compatible media storage.
- `faster-whisper`: optional local Hebrew ASR service used by `MEETSUM_TRANSCRIPTION_PROVIDER=auto`.
- `n8n`: optional automation runtime, profile-gated until live workflows are configured.

The `app`, `worker`, and `migrate` containers are disposable. Postgres, Redis, MinIO, and n8n use persistent volumes. Deployments must backup Postgres before replacing containers.

## Google-First Capture Model

MeetSum intentionally separates schedule, content, and intelligence.

1. Calendar is the schedule layer: meeting title, time, organizer, attendees, recurrence, Google Meet link, and capture readiness.
2. Google Meet artifacts are the preferred live-meeting content layer: conference records, recordings, transcript entries where available, and smart notes.
3. Google Drive is the selected-media layer: operator-selected Meet recordings and shared-drive files.
4. Manual upload and the browser recorder are fallback capture paths for Zoom, Teams, in-person meetings, or external audio.

Media import remains operator-controlled. Calendar and Meet artifact metadata can be polled, but MeetSum must not automatically bulk-download every Drive video.

## Processing Pipeline

The worker handles all long-running work through BullMQ jobs. The user-facing stages are:

- `artifact.import`
- `drive.import`
- `audio.extract`
- `audio.transcribe`
- `transcript.clean`
- `summary.generate`
- `tasks.extract`
- `meeting.index`
- `quality.review`
- `completed` or `failed`

Google Meet smart notes and transcript entries can bypass audio transcription and feed summary generation directly. Recording artifacts and uploaded media use the audio path. Older failed jobs should not override a later completed meeting; the UI should show stale failures as recovery items, not as the current meeting state.

## AI Provider Layer

The active production default is:

```env
MEETSUM_TRANSCRIPTION_PROVIDER=auto
```

In `auto` mode:

- Hebrew and mixed-language meetings try local Whisper first when `LOCAL_TRANSCRIPTION_URL` is configured.
- Clearly non-Hebrew meetings use Gemini directly.
- Gemini remains the fallback if local ASR fails.
- Provider metadata is recorded in `ai_runs` and exposed to the UI and RealizeOS payloads.

Current production smoke finding: local Whisper was attempted for a Hebrew/mixed Google Meet recording and fell back to Gemini. This is expected to be visible, but local ASR should not be considered trusted until benchmarked with private samples.

Gemini AI Studio is the active API provider. Vertex AI support is prepared but inactive until service-account authentication is smoke-tested inside production containers.

## Quality Warnings

Meeting intelligence includes practical quality warnings:

- local ASR fallback used
- weak transcript confidence
- no speaker diarization
- smart-notes-only source
- action items missing owner or due date

These warnings should guide the user toward rerun, speaker cleanup, manual review, or task enrichment. They should not block sharing or exports.

## Public Interfaces

Meeting core:

- `GET /api/meetings`
- `GET /api/meetings/:id`
- `POST /api/meetings/:id/process`
- `POST /api/meetings/:id/reprocess`
- `POST /api/meetings/:id/artifacts/import`
- `POST /api/meetings/:id/share`
- `PATCH /api/meetings/:id/share`
- `GET /share/:token`

Google:

- `POST /api/google/sync/calendar`
- `POST /api/google/meet/sync`
- `GET /api/google/meet/artifacts`
- `GET /api/google/drive/recordings`
- `POST /api/google/drive/import`

Intelligence and operations:

- `GET /api/ai/providers/status`
- `GET /api/jobs`
- `POST /api/jobs/:id/retry`
- `GET /api/workspace/status`

Memory, Rooms, and participants:

- `GET /api/memory/search`
- `POST /api/memory/ask`
- `GET /api/rooms`
- `GET /api/rooms/:id`
- participant hydration/editing routes
- speaker assignment routes

Automations and integrations:

- `GET /api/integrations/realizeos/status`
- `POST /api/integrations/realizeos/export`
- `GET /api/integrations/realizeos/exports`
- `POST /api/integrations/realizeos/exports/:id/retry`
- webhook subscription, delivery, retry, and test routes

## External Systems

RealizeOS is the first deep business integration. Exports include meeting metadata, summary, decisions, action items, tags, participants, transcript references, Google context, provider metadata, and quality warnings. External-impact actions should stay approval-gated.

Webhooks/n8n are production-ready infrastructure: subscriptions can be created, signed test events can be sent, deliveries are recorded, and failed deliveries can be retried. A live n8n workflow still needs to be configured by the operator.

CLI and MCP surfaces are intended for agents and automation. Production access should use API keys and never rely on browser session assumptions.

## API Security

Production API access is guarded by bearer API keys when `MEETSUM_REQUIRE_API_KEY=true`. Keys can be provided as raw bootstrap values with `MEETSUM_API_KEYS` or as stored hashes with `MEETSUM_API_KEY_HASHES`.

Public share links are intentionally unauthenticated, but audio/video remains private by default. Share pages should expose only the selected meeting sections.

Secrets, OAuth refresh tokens, service-account material, Gemini keys, raw recordings, and private ASR evaluation samples must never be committed.
