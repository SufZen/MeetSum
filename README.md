# MeetSum

Self-hosted, AI-first meeting intelligence for Google Workspace.

MeetSum is being built as a production-grade, VPS-hosted alternative to meeting-summary tools such as Fireflies and Timeless, with a special focus on Hebrew and mixed-language accuracy, Google Workspace capture, shareable meeting knowledge, RealizeOS automation, webhooks, CLI, MCP, and agent workflows.

## Current Status

Last updated: May 18, 2026.

MeetSum is deployed and usable as an early v0.1.0 product spine. It is not yet a full Fireflies/Timeless replacement, but the daily workflow now exists: Google Calendar creates scheduled meetings, Google Meet/Drive artifacts can be selected and processed, Gemini generates transcript and intelligence output, local Hebrew ASR is available in `auto` mode, and results can be reviewed, shared, exported, and sent toward automation systems.

Production evidence after the latest smoke pass:

- `main` is at `dd7f7e8`.
- Production health is clean at `https://meetsum.realization.co.il/api/health`.
- App and worker containers are disposable; Postgres, Redis, MinIO, and optional local ASR are stateful services.
- The latest selected Google Meet recording/artifact smoke completed: import queued, media processed, transcript segments generated, summary/action items/tags generated, public share opened unauthenticated, PDF/Markdown rendered, and RealizeOS payload preview included provider/source metadata.
- The main technical risk is local Hebrew ASR reliability: `local-whisper` was attempted on a Hebrew/mixed recording and fell back to Gemini. That fallback is now visible in provider metadata and quality warnings, but root-cause debugging remains the next priority.

## Working Capabilities

- Next.js App Router UI with locale-prefixed routes for English, Hebrew, Portuguese, Spanish, and Italian.
- Fireflies-inspired Meetings workspace with compact inbox, filtering, sorting, paging, dark mode, meeting detail, transcript, summary, tasks, Google context, right-rail intelligence, and processing states.
- Google Calendar sync for schedule context, attendees, organizer, Meet links, and recurring meeting context.
- Google Meet artifact discovery/import for conference records, recordings, transcript entries where available, and smart notes.
- Operator-selected Google Drive recording discovery/import. Automatic bulk media ingestion is intentionally disabled.
- Manual upload and browser recorder surfaces for non-Google meetings.
- BullMQ worker pipeline for artifact import, media ingest, transcription, cleanup, summary generation, task extraction, indexing, quality review, webhook delivery, and RealizeOS export.
- Gemini AI Studio provider for transcription and summaries; Vertex AI credential path is prepared but not active.
- Local Hebrew ASR path through faster-whisper with `MEETSUM_TRANSCRIPTION_PROVIDER=auto`; Gemini remains fallback.
- Provider metadata and quality warnings surfaced on meetings and included in RealizeOS payloads.
- Public meeting share pages with private audio/video excluded by default.
- Participants, transcript speaker mapping, favorites, tags, Rooms/context links, Memory search/Ask, and suggested agent routes.
- Signed webhooks, webhook test delivery, delivery history, retry routes, and n8n-ready infrastructure.
- RealizeOS status, queued export, export history, retry path, and structured payload builder.
- CLI scaffold in `bin/meetings.mjs` and MCP scaffold in `mcp/server.mjs`.
- VPS Docker Compose deployment with Next.js, worker, Postgres, Redis, MinIO, and optional faster-whisper/n8n profiles.
- Backup-before-deploy scripts and production health checks.

## Current Limitations

- Local Whisper is promising but not trusted yet; a real long Hebrew/mixed recording fell back to Gemini.
- Meet artifact polling and recovery need more polish before the flow feels automatic.
- Gmail-aware prep/follow-up is deferred until Calendar, Meet, Drive, and processing are more reliable.
- DOCX/Notion exports, Vertex switch, visible Meet bot, desktop recorder, Zoom/Teams native capture, analytics dashboards, full API-key management UI, and autonomous external-impact agents are outside the first version.
- Raw Fireflies/Timeless/private samples are benchmark material only and must never be committed.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000/en`. If that port is already in use:

```bash
npm run dev -- --hostname 127.0.0.1 --port 3001
```

Run database migrations against a configured Postgres database:

```bash
npm run db:migrate
```

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

## Local API Examples

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/meetings
curl http://127.0.0.1:3000/api/ai/providers/status
curl http://127.0.0.1:3000/api/workspace/status

curl -X POST http://127.0.0.1:3000/api/meetings/MEETING_ID/ask \
  -H "authorization: Bearer $MEETSUM_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"question\":\"What did we decide?\"}"

node bin/meetings.mjs export --target markdown
```

When `MEETSUM_REQUIRE_API_KEY=true`, set `MEETSUM_API_KEY` for local CLI calls or pass `--api-key`.

## Self-Hosted Stack

Copy `.env.example` to `.env.local`, fill real values, then run:

```bash
docker compose up --build
```

Production on the VPS uses:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml up -d --build
```

The production stack includes:

- `app`: Next.js UI and API.
- `worker`: background jobs and integration work.
- `migrate`: one-shot migration runner.
- `postgres`: system-of-record database.
- `redis`: BullMQ queue, locks, retries, and job state.
- `minio`: private S3-compatible media storage.
- `faster-whisper`: optional local Hebrew ASR service.
- `n8n`: profile-gated automation surface.

## Documentation

- `docs/project-state-report.md`: current product state, smoke evidence, risks, readiness, and deferred scope.
- `docs/antigravity-handoff.md`: handoff briefing and next-work guide for Antigravity.
- `docs/v0.1.0-development-plan.md`: prioritized implementation plan for the remaining v0.1.0 work.
- `docs/architecture.md`: system architecture and integration boundaries.
- `docs/user-manual.md`: operator workflow and product usage.
- `docs/production-deployment.md`: VPS deployment, local ASR, health checks, and smoke checklist.
- `docs/language-intelligence.md`: Hebrew/mixed-language logic, local ASR, evaluation, and quality warnings.
- `docs/development-roadmap.md`: current v0.1.0 roadmap and post-v0.1.0 scope.
- `docs/design-system.md`: UI palette, typography, layout, and components.
- `docs/internationalization.md`: locale routing, language cookie, and RTL policy.
- `docs/google-workspace-setup.md`: Google Workspace and API setup.
- `docs/backup-restore.md`: Postgres backup and restore.
- `docs/competitive-feature-plan.md`: Fireflies/Timeless-inspired product staging.

## License

MeetSum is licensed under the MIT License. See `LICENSE`.

Third-party dependencies keep their own licenses. Private secrets, deployment environment files, Google credentials, Fireflies/Timeless transcript exports, recordings, summaries, meeting data, and private ASR evaluation samples are not covered by the repository license and must not be committed.

## Product Direction

MeetSum should become:

- Google Workspace-native: Calendar, Drive, Meet artifacts, Gmail context later, shared drives, and Workspace identity.
- Hebrew-strong: local Hebrew ASR where useful, Gemini fallback, and private evaluation before trust.
- AI-first: summaries, action items, decisions, prep, follow-up drafts, semantic search, Rooms, memory, and controlled agents.
- Integration-first: REST, signed webhooks, CLI, MCP, n8n, RealizeOS, and future SDKs.
- VPS-first: self-hosted, backup-aware, and maintainable without relying on Vercel or Supabase Cloud.
