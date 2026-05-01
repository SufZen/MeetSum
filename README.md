# MeetSum

Self-hosted, AI-first meeting intelligence for Google Workspace.

MeetSum is being built as a production-grade alternative to meeting-summary tools like Fireflies, with a special focus on Hebrew accuracy, Google Workspace integration, automation, and interoperability with business systems such as RealizeOS, AI agents, n8n, REST APIs, CLIs, and MCP clients.

## Current Status

This repository currently contains the first working architecture slice:

- Next.js 16 App Router UI based on the Game Changer template.
- Fireflies-style meeting workspace with meeting inbox, transcript, summary, action items, Google context, recorder shell, and automation rail.
- Production-oriented app shell with locale-prefixed UI routes for English, Hebrew, Portuguese, Spanish, and Italian.
- Deterministic mixed-language intelligence for language metadata, Hebrew cleanup, auto-tags, smart tasks, and structured follow-up output.
- Tested domain modules for meeting state, AI escalation policy, Google Workspace scope policy, signed webhooks, and meeting memory.
- Postgres migration runner and repository adapter, with in-memory demo mode still available for local UI work.
- API key hashing/verification, bearer-token CLI support, and request validation for meeting creation and protected write routes.
- REST API scaffold for meetings, uploads, Ask-style Q&A, Google sync, webhooks, and agent runs.
- Public meeting share pages, meeting favorites, tags, Rooms/context links, participants, and transcript speaker mapping.
- Google Calendar sync, operator-selected Drive recording import, Meet artifact status checks, and BullMQ worker processing.
- Gemini-backed audio/summary provider path with AI Studio active and Vertex AI credential path prepared.
- CLI scaffold in `bin/meetings.mjs`.
- MCP server scaffold in `mcp/server.mjs`.
- VPS-oriented Docker Compose stack with Next.js, Postgres, Redis, MinIO, and n8n.
- Initial Postgres schema in `db/schema.sql`.
- Production compose, health endpoint, and Postgres backup/restore scripts.

This is not yet a full production Fireflies replacement. The next build stages are deeper Meet artifact import/linking, Gmail prep/follow-up, stronger Hebrew evaluation, richer automations, and production-grade admin/security UX.

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
```

## Local API Examples

```bash
curl http://127.0.0.1:3000/api/meetings
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/locales

curl -X POST http://127.0.0.1:3000/api/meetings/meet_google_workspace/ask \
  -H "authorization: Bearer $MEETSUM_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"question\":\"What is the Google Workspace source of truth?\"}"

node bin/meetings.mjs export --target markdown
```

When `MEETSUM_REQUIRE_API_KEY=true`, set `MEETSUM_API_KEY` for local CLI calls or pass `--api-key`.

## Self-Hosted Stack

Copy `.env.example` to `.env.local`, fill real values, then run:

```bash
docker compose up --build
```

The compose stack includes:

- `app`: Next.js UI and API.
- `migrate`: one-shot migration runner.
- `worker`: placeholder worker/MCP service process.
- `postgres`: source-of-truth database.
- `redis`: queues, locks, retry state.
- `minio`: S3-compatible meeting media storage.
- `n8n`: first automation surface.

Production VPS deploy uses `docker-compose.prod.yml`, exposes MeetSum on host port `3005`, and includes Traefik labels for `meetsum.realization.co.il`.

## Documentation

- `docs/architecture.md`: current architecture and integration surfaces.
- `docs/user-manual.md`: basic logic, daily workflow, capture model, integrations, and operating rules.
- `docs/design-system.md`: UI palette, typography, layout, and component layer.
- `docs/internationalization.md`: locale routing, language cookie, and RTL policy.
- `docs/language-intelligence.md`: mixed-language detection, Hebrew cleanup, tags, and smart tasks.
- `docs/production-deployment.md`: VPS compose, Traefik, health checks, and deploy flow.
- `docs/backup-restore.md`: Postgres backup and restore commands.
- `docs/competitive-feature-plan.md`: Fireflies/Timeless-inspired feature staging.
- `docs/google-workspace-setup.md`: Workspace admin setup notes.
- `docs/development-roadmap.md`: production-grade next-stage plan.

## License

MeetSum is licensed under the MIT License. See `LICENSE`.

Third-party dependencies keep their own licenses. Private secrets, deployment environment files, Google credentials, Fireflies transcript exports, recordings, summaries, and meeting data are not covered by the repository license and must not be committed.

## Product Direction

MeetSum should become:

- Google Workspace-native: Calendar, Gmail, Drive, shared drives, Meet recordings, users, and domain-wide delegation.
- Hebrew-strong: local-first processing with escalation to stronger API providers when Hebrew confidence is weak.
- AI-first: summaries, action items, decisions, prep, follow-up drafts, semantic search, meeting memory, and agent workflows.
- Integration-first: REST, signed webhooks, CLI, MCP, n8n, RealizeOS, and future SDKs.
- VPS-first: deployable and maintainable without depending on Vercel or Supabase Cloud.
