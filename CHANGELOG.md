# Changelog

All notable changes to MeetSum are documented in this file.

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
