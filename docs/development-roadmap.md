# MeetSum Production Development Roadmap

## Goal

Turn the current scaffold into a production-grade, self-hosted, Google Workspace-native meeting intelligence platform with high Hebrew accuracy, reliable automations, and clean integration surfaces for RealizeOS, AI agents, n8n, REST, CLI, and MCP.

## Production Principles

- Build production foundations before feature sprawl: auth, persistence, background jobs, observability, security, backups, and test data.
- Keep provider boundaries clean: Google, AI models, storage, queues, RealizeOS, and MCP should be swappable behind adapters.
- Treat Hebrew quality as a product requirement, not a prompt tweak.
- Make every automation auditable: event name, payload, retries, delivery status, and source meeting.
- Prefer audio-first storage and explicit retention policy.

## Phase 1: Hardening The Scaffold

Expected outcome: the current demo state becomes a persistent, testable app that can survive restarts.

- Replace the in-memory meeting repository with a Postgres repository using the schema in `db/schema.sql`.
- Add migrations and a repeatable migration command.
- Add app authentication for the first admin user.
- Add API key authentication for automation, CLI, and MCP clients.
- Add request validation for every API route.
- Add structured error responses and server-side audit logging.
- Add seed data only in development mode.
- Add integration tests that run against a disposable Postgres database.

Acceptance checks:

- Restarting the app does not lose meetings.
- API routes reject unauthenticated access.
- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` stay green.
- Docker Compose boots app, Postgres, Redis, MinIO, and n8n from a clean checkout.

## Phase 2: Google Workspace Integration

Expected outcome: Google Calendar, Gmail, and Drive become the primary meeting context source.

- Implement domain-wide delegation credentials and per-subject impersonation.
- Use keyless service-account signing for local diagnostics and avoid downloaded service-account JSON keys.
- Sync all calendars for selected Workspace users.
- Handle recurring events, changed events, cancelled events, attendees, Meet links, and organizer metadata.
- Implement Drive changes sync for Meet recordings, shared drives, file metadata, and recording download.
- Implement Gmail thread matching for meeting prep and follow-up context.
- Use Gmail polling in V1; defer Pub/Sub push until the organization policy exception is approved.
- Store sync cursors, watch channels, expiration timestamps, and last error state in Postgres.
- Add scheduled renewal for Calendar/Drive watch channels and Gmail Pub/Sub subscriptions.
- Add admin UI for Workspace sync health and scope status.

Acceptance checks:

- A Google Meet recording in Drive creates or updates the correct meeting record.
- Calendar edits and cancellations reconcile without duplicating meetings.
- Gmail context is linked to the right meeting and can be included in AI prep/follow-up.
- Expired watch channels are renewed automatically.

## Phase 3: Media Pipeline

Expected outcome: uploaded files and Google Meet recordings become normalized audio assets ready for transcription.

- Add object storage repository for MinIO/S3.
- Implement media asset records with checksums, storage keys, size, content type, and retention policy.
- Add worker queue with Redis/BullMQ or equivalent.
- Add `ffmpeg` audio extraction from uploaded video.
- Add PWA recorder upload finalization.
- Add retry policy, poison queue handling, and job progress updates.
- Add per-meeting media timeline and processing status UI.

Acceptance checks:

- Uploading audio creates a media asset and queues transcription.
- Uploading video extracts audio and stores only audio by default.
- Failed media jobs are visible and retryable.
- Storage keys never expose private bucket paths directly to untrusted clients.

## Phase 4: Hebrew-First AI Pipeline

Expected outcome: the app produces useful Hebrew transcripts, summaries, decisions, and action items.

- Implement `TranscriptionProvider`, `DiarizationProvider`, `SummaryProvider`, `EmbeddingProvider`, and `ChatProvider` interfaces.
- Add a local transcription provider option.
- Add at least one API-based transcription fallback.
- Add confidence scoring and escalation using `lib/ai/policy.ts`.
- Add diarization and speaker-label editing.
- Add Hebrew summary templates for overview, decisions, action items, questions, risks, follow-ups, and quotes with timestamps.
- Add embeddings for meeting search and Ask-style Q&A.
- Store every AI run with provider, model, cost metadata, latency, input hash, and output version.
- Build a Hebrew regression dataset with expected transcript/summary assertions.

Acceptance checks:

- Low-confidence Hebrew chunks escalate automatically.
- Hebrew summaries preserve names, business terms, owners, dates, and uncertainty.
- Ask-style answers cite transcript segments.
- AI runs are replayable or inspectable for debugging.

## Phase 5: Automations And Business Integrations

Expected outcome: every meeting artifact can trigger reliable workflows and agents.

- Persist webhook subscriptions and signed deliveries.
- Add retry/backoff and delivery inspection UI.
- Add n8n starter workflows for completed meetings, action items, and summaries.
- Define the RealizeOS meeting-context payload contract.
- Implement RealizeOS outbound connector.
- Add agent-run orchestration for meeting follow-up, CRM sync, email drafts, and context updates.
- Add CLI authentication and command coverage for sync, ingest, ask, export, and retries.
- Harden MCP server tools with auth and permission checks.

Acceptance checks:

- `meeting.completed` can trigger n8n and RealizeOS.
- Webhook failures are retried and auditable.
- MCP tools can search meetings, fetch summaries, list action items, and ask meeting memory.
- CLI commands work against a deployed VPS app.

## Phase 6: Product UI And Operational UX

Expected outcome: the app is usable daily on desktop and mobile.

- Add real meeting detail pages and routing.
- Add filters for owner, source, language, status, date, calendar, and action-item state.
- Add meeting prep view from Calendar/Gmail/Drive.
- Add follow-up drafting view for Gmail.
- Add transcript editor with speaker correction.
- Add summary template settings.
- Add integration settings for Google, n8n, RealizeOS, API keys, MCP clients, and storage.
- Add admin health dashboard for workers, queues, Google sync, webhooks, storage, and model providers.

Acceptance checks:

- A user can find a meeting, inspect transcript/summary, ask questions, and send follow-up without leaving the app.
- Mobile layout remains usable for recording, reading summaries, and reviewing action items.
- Admin can diagnose stuck syncs, failed jobs, and webhook delivery issues.

## Phase 7: Production Operations

Expected outcome: the system can run safely on a VPS.

- Add reverse proxy and TLS deployment docs.
- Add environment validation at boot.
- Add backup and restore scripts for Postgres and MinIO.
- Add log aggregation guidance.
- Add metrics for queue depth, job latency, AI cost, Google sync lag, webhook failure rate, and storage growth.
- Add rate limiting and abuse protection for API, CLI, and MCP clients.
- Add secret rotation process.
- Add retention and deletion workflows.
- Add disaster recovery runbook.

Acceptance checks:

- A fresh VPS can be provisioned from docs and environment variables.
- Backups can be restored into a clean environment.
- Production health can be checked without shell access.
- Secrets are not committed and can be rotated.

## Information Needed From You

Provide these when you are ready to wire real systems:

- Google Workspace domain name and admin email.
- Which Workspace users/calendars/shared drives should be included first.
- Google Cloud project ID, service account email, and confirmation that domain-wide delegation is approved.
- Preferred VPS operating system, specs, public domain/subdomain, and reverse proxy preference.
- Object storage preference: local MinIO only, external S3-compatible provider, or both.
- AI provider preferences and constraints: local model host, OpenAI/API keys, budget ceilings, latency expectations, and Hebrew quality examples.
- RealizeOS API base URL, authentication method, and desired meeting-context payload shape.
- n8n URL and whether workflows should be created manually first or seeded from this repo.
- Required compliance constraints: retention period, deletion rules, sensitive-client handling, and who can access meeting data.
- Sample Hebrew recordings/transcripts and examples of summaries you consider excellent.

## Recommended Next Sprint

Start with Phase 1 and part of Phase 2:

1. Add database migrations and Postgres repository.
2. Add admin/API-key auth.
3. Add Google Workspace credential adapter and sync-state persistence.
4. Implement Calendar sync first.
5. Add Drive recording discovery second.
6. Keep Gmail context third, after meeting identity matching is stable.

This order creates a reliable product spine before expensive AI/media processing work begins.
