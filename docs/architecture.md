# MeetSum Architecture

This repo starts the self-hosted meeting platform as a modular monolith. The app is intentionally built around stable integration boundaries before real credentials are added: Google Workspace sync, meeting ingestion, AI providers, event/webhook delivery, CLI, and MCP tools.

## Production Shape

- `app`: Next.js App Router UI and REST API. Production exposes host port `3005` and serves locale-prefixed routes.
- `worker`: background jobs for Google sync, media processing, transcription, summarization, embeddings, webhook retries, and agent runs.
- `migrate`: one-shot migration runner that must complete before the app starts.
- `postgres`: system of record for meetings, Google state, transcripts, summaries, action items, tags, contexts, intelligence runs, API keys, and MCP clients. Migrations live in `db/migrations` and run through `npm run db:migrate`.
- `redis`: queue, retry, lock, and job state backend, stored in a persistent Docker volume.
- `minio`: S3-compatible storage for audio-first media artifacts, stored in a persistent Docker volume.
- `n8n`: first automation surface for business workflows.

The `app`, `worker`, and `migrate` containers are disposable. Postgres, Redis, MinIO, and n8n are stateful services with named volumes.

## Google Workspace

Use domain-wide delegation with narrow scope groups from `lib/google/workspace.ts`. Calendar, Gmail, and Drive each keep their own sync state and watch-channel metadata. Calendar identifies meetings, Drive imports Google Meet recordings, and Gmail supplies prep/follow-up context.

## AI Layer

Provider adapters should hide local/API choices from product code. The default policy is hybrid: local/open-source processing first, then paid/API escalation when Hebrew confidence, diarization confidence, or audio quality is weak.

The current deterministic intelligence layer handles language metadata, Hebrew cleanup, auto-tags, smart tasks, and structured output. Gemini and local Gemma should be added through provider adapters rather than directly inside route handlers.

## External Systems

Business systems should connect through these surfaces in this order:

1. REST API and signed webhooks.
2. n8n workflows.
3. MCP tools for agents and context-aware clients.
4. CLI for local/admin automation.

RealizeOS starts as an outbound export suggestion through `/api/integrations/realizeos/export`; autonomous execution should wait until the receiving API contract is stable.

## API Security

Production API access is guarded by bearer API keys when `MEETSUM_REQUIRE_API_KEY=true`. Keys can be provided as raw bootstrap values with `MEETSUM_API_KEYS` or as stored hashes with `MEETSUM_API_KEY_HASHES`; the hashing helper lives in `lib/auth/api-keys.ts`. The CLI sends `Authorization: Bearer ...` from `--api-key` or `MEETSUM_API_KEY`.
