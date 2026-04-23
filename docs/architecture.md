# MeetSum Architecture

This repo starts the self-hosted meeting platform as a modular monolith. The app is intentionally built around stable seams before real credentials are added: Google Workspace sync, meeting ingestion, AI providers, event/webhook delivery, CLI, and MCP tools.

## Production Shape

- `app`: Next.js App Router UI and REST API.
- `worker`: background jobs for Google sync, media processing, transcription, summarization, embeddings, webhook retries, and agent runs.
- `postgres`: system of record for meetings, Google state, transcripts, summaries, action items, API keys, and MCP clients. Migrations live in `db/migrations` and run through `npm run db:migrate`.
- `redis`: queue, retry, lock, and job state backend.
- `minio`: S3-compatible storage for audio-first media artifacts.
- `n8n`: first automation surface for business workflows.

## Google Workspace

Use domain-wide delegation with narrow scope groups from `lib/google/workspace.ts`. Calendar, Gmail, and Drive each keep their own sync state and watch-channel metadata. Calendar identifies meetings, Drive imports Google Meet recordings, and Gmail supplies prep/follow-up context.

## AI Layer

Provider adapters should hide local/API choices from product code. The default policy is hybrid: local/open-source processing first, then paid/API escalation when Hebrew confidence, diarization confidence, or audio quality is weak.

## External Systems

Business systems should connect through these surfaces in this order:

1. REST API and signed webhooks.
2. n8n workflows.
3. MCP tools for agents and context-aware clients.
4. CLI for local/admin automation.

RealizeOS starts as an outbound agent target through `/api/agents/run`; the payload contract should become a dedicated adapter once the receiving API is stable.

## API Security

Production API access is guarded by bearer API keys when `MEETSUM_REQUIRE_API_KEY=true`. Keys can be provided as raw bootstrap values with `MEETSUM_API_KEYS` or as stored hashes with `MEETSUM_API_KEY_HASHES`; the hashing helper lives in `lib/auth/api-keys.ts`. The CLI sends `Authorization: Bearer ...` from `--api-key` or `MEETSUM_API_KEY`.
