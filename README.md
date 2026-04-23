# MeetSum

Self-hosted, AI-first meeting intelligence for Google Workspace.

MeetSum is being built as a production-grade alternative to meeting-summary tools like Fireflies, with a special focus on Hebrew accuracy, Google Workspace integration, automation, and interoperability with business systems such as RealizeOS, AI agents, n8n, REST APIs, CLIs, and MCP clients.

## Current Status

This repository currently contains the first working architecture slice:

- Next.js 16 App Router UI based on the Game Changer template.
- Fireflies-style meeting workspace with meeting inbox, transcript, summary, action items, Google context, recorder shell, and automation rail.
- Tested domain modules for meeting state, AI escalation policy, Google Workspace scope policy, signed webhooks, and meeting memory.
- REST API scaffold for meetings, uploads, Ask-style Q&A, Google sync, webhooks, and agent runs.
- CLI scaffold in `bin/meetings.mjs`.
- MCP server scaffold in `mcp/server.mjs`.
- VPS-oriented Docker Compose stack with Next.js, Postgres, Redis, MinIO, and n8n.
- Initial Postgres schema in `db/schema.sql`.

This is not yet a full production Fireflies replacement. Real Google API sync, persistent database repositories, media workers, transcription/diarization providers, billing/permissions, and production auth are the next build stages.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000`. If that port is already in use:

```bash
npm run dev -- --hostname 127.0.0.1 --port 3001
```

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Local API Examples

```bash
curl http://127.0.0.1:3000/api/meetings

curl -X POST http://127.0.0.1:3000/api/meetings/meet_google_workspace/ask \
  -H "content-type: application/json" \
  -d "{\"question\":\"What is the Google Workspace source of truth?\"}"

node bin/meetings.mjs export --target markdown
```

## Self-Hosted Stack

Copy `.env.example` to `.env.local`, fill real values, then run:

```bash
docker compose up --build
```

The compose stack includes:

- `app`: Next.js UI and API.
- `worker`: placeholder worker/MCP service process.
- `postgres`: source-of-truth database.
- `redis`: queues, locks, retry state.
- `minio`: S3-compatible meeting media storage.
- `n8n`: first automation surface.

## Documentation

- `docs/architecture.md`: current architecture and integration surfaces.
- `docs/google-workspace-setup.md`: Workspace admin setup notes.
- `docs/development-roadmap.md`: production-grade next-stage plan.

## Product Direction

MeetSum should become:

- Google Workspace-native: Calendar, Gmail, Drive, shared drives, Meet recordings, users, and domain-wide delegation.
- Hebrew-strong: local-first processing with escalation to stronger API providers when Hebrew confidence is weak.
- AI-first: summaries, action items, decisions, prep, follow-up drafts, semantic search, meeting memory, and agent workflows.
- Integration-first: REST, signed webhooks, CLI, MCP, n8n, RealizeOS, and future SDKs.
- VPS-first: deployable and maintainable without depending on Vercel or Supabase Cloud.
