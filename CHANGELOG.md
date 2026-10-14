# Changelog

All notable changes to MeetSum are documented in this file.

## [0.7.0] — unreleased (Fireflies parity programme, M0–M10)

`package.json` (and so `/api/health` and the log `version` field) moved to 0.7.0 at the M10 Integration step. Per-milestone detail is in `docs/parity/m0.md`–`m10.md` and in `docs/parity/STATUS.md`; the scored, evidence-backed feature comparison is in `docs/parity/AUDIT.md`.

### Added
- **M1, pipeline:** streaming idempotent uploads; Zoom and Teams capture webhooks; webhook SSRF guard and signed deliveries v2; scoped API keys.
- **M2, workspaces:** multi-user workspaces with roles (viewer, member, admin, owner), invitations, meeting visibility (private, workspace, link) enforced on every read path, and API keys bound to a workspace.
- **M3.5, design system:** Cadence v2.0 tokens and primitives (`design-system/`).
- **M3, Hebrew ASR:** ASR router with a circuit breaker (RunPod ivrit-ai, Modal `asr-worker` with pyannote, Soniox, OpenAI-compatible Whisper including Groq), diarization, speaker suggestions, glossary, and the `asr:evaluate` harness.
- **M4, player:** waveform, speaker lanes, range streaming, virtualized transcript, transcript editing with history and undo, in-transcript finder.
- **M5, intelligence:** Hebrew-native cited summaries, 11 templates plus custom ones, chapters, action items with he/en relative due dates, a Tasks view, clips, comments, reactions, per-meeting analytics, and the `llm:evaluate` harness.
- **M6, search and Ask:** Hebrew normalizer; hybrid pgvector, full-text and trigram search with a lexical fallback; streaming AskMeetSum with strict citations and private threads; `search:eval`.
- **M7, meeting bot:** Vexa sidecar ("Join now", calendar rules, consent, lobby and stop lifecycle), webhook verification, live transcript behind `MEETSUM_LIVE_TRANSCRIPT`.
- **M8, integrations:** Slack, Outlook calendar, Notion, HubSpot, Google Docs, DOCX, email recap, webhook catalog v2, one privacy gate for every push, and encrypted row-bound tokens.
- **M9, i18n and polish:** he/en only (pt, es and it removed), full RTL, the gender-neutral Hebrew style guide, Hebrew PDF (Plex Sans Hebrew, bidi layout), notifications, onboarding, the analytics dashboard, PWA, and password-protected shares.
- **M10, hardening:** generated `db/schema.sql` with a CI diff; a token-encryption keyring with `scripts/reencrypt-tokens.ts`; HubSpot and Graph behaviour re-verified against the vendor docs; RealizeOS behind the privacy gate; the transcript finder on the M6 normalizer; an API reference covering every route; truthful README and SETUP; the final parity audit. Packages A–C add CI end-to-end tests, structured logging, health and readiness checks, a Redis rate limiter, a one-build deploy with rollback, digest-pinned images, and the bundle diet.

### Changed
- HubSpot OAuth uses the date-versioned `/oauth/2026-03/token` endpoints (the v1 token endpoint errors from 2027-02-16).
- Outlook calendar sync no longer cancels a meeting when Graph reports `@removed` for an event that only moved outside the sync window.
- Historical docs moved to `docs/archive/`; `docs/design-system.md` (v1) was removed in favour of `design-system/README.md`.

### Security
- Ciphertexts carry a key id, so `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` can be rotated with `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS` and a dry-run-first re-encrypt script.
- A private meeting is exported to RealizeOS only with its current owner's opt-in.

## [Unreleased]

Milestone M0 "Baseline & honesty" (see `docs/parity/PLAN.md`).

### Changed
- **CI is now a real gate** — lint fails the build on any error or warning, `next build` runs in CI with the same 4 GB heap as the Dockerfile, and CI uses Node 24 to match the `node:24-alpine` image.
- **`next build` no longer needs runtime secrets** — `meetingRepository` is resolved lazily on first use, so collecting page data no longer requires `MEETSUM_STORAGE` / `DATABASE_URL`. Production misconfiguration is still rejected at boot by `instrumentation.ts`.
- **Provider health reports the real summary model** — `lib/ai/provider-health.ts` reads the canonical `GOOGLE_GEMINI_SUMMARY_MODEL`; `GEMINI_MODEL` remains as a fallback alias.
- **`.env.example` documents every variable** the app, worker, MCP server and scripts read (Zoom/Teams capture, S3 aliases and region, Gemini and worker tuning, Gmail/Meet limits, rate limit, webhook timeout, Notion, ASR eval, compose infrastructure), with placeholder values instead of real addresses. Dead `OPENAI_API_KEY` / `AI_GATEWAY_API_KEY` removed; Pub/Sub and n8n API variables marked as unused/reserved.

### Security
- Production boot refuses placeholder secrets (`dev-secret`, `replace-with-…`) for `WEBHOOK_SIGNING_SECRET` and `MEETSUM_SESSION_SECRET`.
- Added `.dockerignore`: `.env*` (except `.env.example`), `.secrets`, `.git`, agent worktrees, `node_modules`, `.next` and build/test artifacts are no longer sent to the Docker build context. Previously `COPY . .` baked `.env.local` into the builder layer.
- Notion export (`POST /api/meetings/:id/export/notion`) requires `meeting:write` + `integrations:manage` and a per-request token; the `NOTION_TOKEN` server fallback was removed (it allowed cross-tenant writes into the operator's Notion).
- `MEETSUM_ALLOW_WORKSPACE_CREATION` now defaults to `false`: self-service workspace creation must be enabled explicitly with `true`.
- M2 security review: private meetings stay private everywhere — RealizeOS export list/retry, Google Meet artifact listings, Drive recording listing/import (no attaching media to an invisible meeting), and storage media assets apply the caller's visibility scope; `GET /api/google/meet/artifacts` requires `integrations:manage`; webhook events for private meetings carry a minimal payload; any participant email change requires owner-or-admin rights; ad-hoc webhook tests use a throwaway signing secret; `workspaces.google_subject` is cleared when its owner is demoted or removed; a desktop `captureId` held by an invisible meeting returns `409 capture_conflict`.

### Fixed
- Flaky `tests/meet-artifacts-identity.test.ts` timeout: the test no longer loads googleapis/BullMQ/S3 transitively (~1s import) and now runs in milliseconds.
- Zoom webhook route uses the shared, stricter `isZoomChallenge` guard (requires a string `plainToken`); removed the dead Teams `isGraphValidation` helper. ESLint now reports 0 warnings.

## [0.6.0] — 2026-07-06

### Added
- **MeetSum Capture desktop companion** — Electron app for personal Windows desktop capture with mic plus system-audio recording, local spool, retry upload, and authenticated upload into MeetSum.
- **Desktop recorder ingestion API** — `POST /api/desktop-capture/ingest` creates `desktop_recorder` meetings from companion uploads and accepts optional local transcript segments.
- **Desktop metadata persistence** — Media assets now store capture metadata, stable `captureId`, checksum, local ASR/provider details, device names, sample rate, duration, and upload status.
- **Windows installer packaging** — Electron Builder creates NSIS installer and portable EXE artifacts; GitHub Actions uploads `meetsum-capture-windows` artifacts.
- **Optional Windows code signing** — Workflow supports `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` and verifies Authenticode signatures when signing secrets are configured.
- **Laptop Hebrew ASR runbook** — Ops/dev runbook for validated native Ryzen laptop Hebrew ASR setup with VPS fallback guidance.
- **VPS handoff prompt** — `docs/vps-v0.6.0-handoff-prompt.md` captures the production deployment steps for `https://meetsum.realization.co.il/`.

### Changed
- Manual upload remains on the standard `media.ingest` path unless desktop metadata or transcript segments are present.
- Desktop recorder retry uploads reuse an existing desktop media asset when `captureMetadata.captureId` repeats.
- UI now exposes desktop-recorder import affordances alongside upload and browser recording.
- Production deployment docs now call out migration `014_desktop_capture_metadata.sql` and desktop-recorder API-key readiness.

### Fixed (landed between v0.5.0 and v0.6.0)
- **Security audit of v0.5.0** (`63c4752`) — `requireAppAccess` fails closed when the session lookup throws; the session secret no longer falls back to (and must differ from) `WEBHOOK_SIGNING_SECRET`; the hardcoded `dev-secret` webhook signing fallback was removed; outgoing webhook fetches have timeouts; DB-managed admin API keys are now actually accepted; transcript segment replacement is transactional; Zoom signatures use `timingSafeEqual`; the heuristic fallback no longer fabricates a transcript; startup env validation (`assertRuntimeEnvironment`) runs in `instrumentation.ts` and the worker; Teams validates `clientState` for every notification; rate limiting keys on the trusted-proxy IP.
- **Migration 013 repaired** (`087d5c7`) — it previously never applied on a real database, so admin API keys could not work; `deploy-vps.sh` fixed to run migrations via `docker-compose.migrate.yml`.
- **Local Hebrew ASR reliability** — faster-whisper CPU `compute_type=int8` (`e82303c`); undici 300s header/body timeouts lifted for long transcriptions (`358981f`); Whisper multipart serialized via undici `FormData` and non-date action-item due strings coerced to `null` (`b471aa3`); TCP keepalive on long ASR connections (`9dbe44c`).
- **Container DNS** — public IPv4 resolvers added after Docker's embedded resolver so external lookups no longer fail with `EAI_AGAIN` (`3180737`).
- **Build memory** — `next build` heap raised to 4 GB and app/worker images built sequentially on the VPS (`6f9dd96`).

### Validation
- 54 test files / 332 tests passing after clean rerun.
- TypeScript typecheck clean.
- Next production build clean.
- Windows desktop installer build clean.
- Production dependency audit reports 0 vulnerabilities.

## [0.5.0] — 2026-05-29

Sprint 6 — Platform Expansion (`7eb7a50`).

### Added
- **Vertex AI provider support** — `GOOGLE_GENAI_USE_VERTEXAI` switches Gemini calls to Vertex AI; `lib/ai/provider-health.ts` validates the configuration and `/api/health` reports `ai.provider`, `ai.model` and `ai.configured`.
- **Capture adapter interface** — `lib/capture/types.ts` and `lib/capture/registry.ts` define a pluggable `CaptureAdapter`; `zoom` and `teams` added as meeting sources.
- **Zoom webhook receiver** — `POST /api/webhooks/zoom` answers the URL-validation challenge, verifies the HMAC-SHA256 signature, and on `recording.completed` creates a meeting and enqueues `media.ingest` with the recording URL. The adapter has a `downloadRecording` helper (Server-to-Server OAuth), but **recording download is not yet wired into the ingest pipeline**, so no media is fetched.
- **Teams webhook receiver** — `POST /api/webhooks/teams` echoes Graph subscription validation tokens, validates `clientState`, and creates a meeting from a recording change notification. **Graph subscriptions are not created/renewed by MeetSum and recording download is not yet wired.**
- Audit actions `capture.zoom.recording` and `capture.teams.recording`.

### Stats
- 50 test files, 307 tests at release.

## [0.4.0] — 2026-05-29

Sprint 5 — Frontend & Integrations (`4508576`, released in `cc5aed0`).

### Added
- **Room detail page** — `/[locale]/rooms/[id]` with stat cards, meetings, open tasks, participants, artifacts and an "Ask Room" input.
- **Room suggestions banner** — suggests creating a room for meetings without room context, using `/api/rooms/suggestions`; dismissals persist.
- **Notion export** — `POST /api/meetings/:id/export/notion` builds Notion blocks via the REST API (integration token from the request or `NOTION_TOKEN`), with audit logging. No OAuth flow yet.
- **n8n starter workflow templates** — `docs/n8n-templates/` (meeting-completed → Slack, action item → Todoist, weekly digest email). These are importable JSON templates, not a built-in integration.

### Stats
- 46 test files, 277 tests at release.

## [0.3.1] — 2026-05-29

Sprint 4 — Operational hardening (`5fa9721`, released in `70d13b3`).

### Added
- **Unified backup/restore** — `scripts/backup-full.sh` / `scripts/restore-full.sh` (`npm run backup:full`, `npm run backup:restore`) back up Postgres + MinIO with a checksummed `manifest.json` and validate it on restore.
- **Media retention policies** — age-based audio retention (default 180 days) and video retention modes (`opt-in`, `all`, `none`); audit actions `media.retention.deleted`, `backup.created`, `backup.restored`.
- **GitHub Actions auto-deploy** — `.github/workflows/deploy.yml` deploys on push to `main`, gated by the `DEPLOY_ENABLED` repo variable, with a pre-deploy backup and health check.

### Stats
- 45 test files, 263 tests at release.

## [0.3.0] — 2026-05-29

### Added

#### Admin Self-Service
- **API Key Management** — Create, list, and revoke API keys via `/api/admin/api-keys`. Keys use `ms_<hex>` format, stored as SHA-256 hashes. Raw key shown once on creation.
- **Operational Dashboard** — `GET /api/admin/operations` aggregates system health across 6 categories: jobs, meetings, sync freshness, storage, AI metrics, and audit logs.
- **Webhook Dashboard** — `GET /api/admin/webhooks/stats` surfaces subscription counts, delivery success rates, event breakdowns, and recent failures.

#### Intelligence Pipeline
- **Summary Template Wiring** — `GeminiSummaryProvider` now reads the active template from app settings and injects domain-specific prompt addenda (Sales, Real-Estate, Product, Operations, Legal).
- **Speaker-to-Person Assignment** — `POST /api/meetings/:id/speakers` maps generic speaker labels to named participants. `GET` returns unique speakers with segment counts.

#### Export & Share
- **DOCX Export** — `POST /api/meetings/:id/export/docx` generates formatted Word documents with full section parity (title, metadata, overview, decisions, action items, transcript).
- **Share Link Enhancements** — Share links now support optional password protection (`passwordHash`) and expiration (`expiresAt`).

#### Discovery
- **Meeting Timeline** — `GET /api/meetings/timeline` provides calendar-style aggregation with day/week/month grouping, date range filtering, room filtering, and aggregate statistics.
- **Meeting Search** — `GET /api/meetings/search` supports full-text search across titles, participants, and summaries, with tag/status/source filters.

#### Infrastructure
- **Rate Limiting** — In-memory sliding window rate limiter wired into 7 endpoints: memory/ask (30/min), rooms/:id/ask (30/min), exports (20/min), admin (30/min), webhooks (30/min). Bypass via `MEETSUM_RATE_LIMIT=false`.
- **ASR Evaluation** — Hebrew ASR evaluation script enhanced with `--sample` filtering and `--output` JSON report capabilities.
- **Database Migration** — `013_api_keys.sql` adds the `api_keys` table for admin-managed key lifecycle.

### Changed
- Version bumped from `0.0.1` to `0.3.0`.
- Webhook subscription routes now rate-limited (admin preset).
- `MeetingShare` type extended with `passwordHash` field.
- `createMeetingShare` now accepts `expiresAt` and `password` parameters.
- `AuditAction` type extended with `api_key.created`, `api_key.revoked`, `meeting.export.docx`.

### Stats
- 43 test files, 249 tests (up from 180 in v0.2.0)
- 0 TypeScript errors
- 8 new API endpoints, 5 enhanced endpoints
- 11 stories completed across 3 sprints

## [0.2.0] — 2026-05-28

### Added
- Webhook management system (subscriptions, deliveries, retry, test sends)
- Meet artifacts pipeline (conference records, speaker metadata)
- RealizeOS export integration (queue, send, retry)
- Audit logging system
- App settings management
- Meeting intelligence engine (tags, language detection, smart tasks)
- Platform event system with HMAC webhook signatures
- Share link system with section-level visibility controls

## [0.1.0] — 2026-05-15

### Added
- Core meeting lifecycle (upload, transcribe, summarize)
- Google Meet integration via workspace add-on
- Gemini AI provider (transcription + summarization)
- Room/context system for meeting grouping
- Memory system with vector search (ask-this-room)
- Markdown and PDF export
- Multi-language support (Hebrew, English, Portuguese)
- OAuth session management
- MCP server for AI tool integration
