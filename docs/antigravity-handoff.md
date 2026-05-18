# Antigravity Handoff

Date: May 18, 2026.

## Briefing

MeetSum is a self-hosted, Google-first meeting intelligence app. It is deployed at `https://meetsum.realization.co.il` and is currently an early v0.1.0 product spine: usable, but still in active hardening. The next work should focus on reliability and trust, not broad new feature sprawl.

The most important current finding: local Hebrew ASR is wired and attempted in `auto` mode, but the latest real Hebrew/mixed recording fell back from `local-whisper` to Gemini. The fallback is visible and non-blocking. Debugging this path is the next highest-value engineering task.

## Repository Orientation

- `app/`: Next.js App Router pages and API routes.
- `components/`: client UI, command center, meeting panels, operational pages.
- `lib/meetings/`: repository types, Postgres adapter, capture readiness, quality warnings.
- `lib/google/`: Calendar, Drive, Workspace auth, Meet artifact discovery/import.
- `lib/ai/`: Gemini, local Whisper, provider selection, transcription/summary adapters.
- `lib/jobs/`: BullMQ queue and processor.
- `lib/integrations/`: RealizeOS payload/export logic.
- `lib/webhooks/`: webhook subscription, delivery, signature, retry, test delivery.
- `lib/memory.ts`, `lib/rooms.ts`: Memory search/Ask and Rooms.
- `worker/`: worker entrypoint.
- `scripts/`: migration, deployment, retention, ASR evaluation, cleanup helpers.
- `db/`: schema and migrations.
- `docs/`: architecture, deployment, state report, handoff, roadmap, user manual.
- `tests/`: Vitest coverage for domain logic and API-ish behavior.

## First Commands

Run these before editing:

```bash
git status --short --branch
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

Use a feature branch for implementation work:

```bash
git switch -c codex/<short-feature-name>
```

## Production Facts

- VPS path: `/opt/meetsum`.
- Production URL: `https://meetsum.realization.co.il`.
- Production compose file: `docker-compose.prod.yml`.
- Production env file: `.env.local`.
- Production deploy helper: `./scripts/deploy-vps.sh`.
- Always backup Postgres before deployment.

Production compose commands must include the env file:

```bash
docker compose --env-file .env.local -f docker-compose.prod.yml ps
```

Health check:

```bash
curl -fsS https://meetsum.realization.co.il/api/health
```

## Safe Operating Rules

- Do not commit `.env.local`, service-account files, Gemini keys, OAuth secrets, recordings, Fireflies/Timeless exports, private transcripts, or `.secrets/asr-eval`.
- Do not bulk-import Drive videos.
- Do not deploy docs-only changes unless requested.
- Do not switch to Vertex AI until a production container smoke test passes.
- Do not remove Gemini while local ASR is still being evaluated.
- Do not make audio/video public on share pages by default.
- Keep external-impact actions approval-gated.
- Preserve the self-hosted architecture: app/worker/migrate disposable, Postgres/Redis/MinIO persistent.

## Current Verified State

- `main` includes `dd7f7e8 Expose ASR provider metadata and quality warnings`.
- Production health is clean.
- Latest selected Meet artifact/recording smoke completed through Gemini fallback.
- Public share page opened unauthenticated.
- PDF and Markdown rendering worked.
- RealizeOS payload preview included provider metadata and quality warnings.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit --omit=dev` passed after the latest code slice.

## Next Implementation Sequence

### 1. Debug Local Whisper Fallback

Goal: determine why a Hebrew/mixed recording attempted `local-whisper` but completed through Gemini fallback.

Inspect:

- faster-whisper container logs,
- worker logs around `audio.transcribe`,
- local ASR timeout settings,
- memory/CPU pressure,
- response payload shape,
- temp audio file creation and cleanup,
- local Whisper server restart timing.

Acceptance:

- Root cause is documented in `docs/project-state-report.md` or a new implementation note.
- The real recording either completes through local Whisper or falls back with a precise recorded error.
- Tests verify fallback metadata remains visible.

### 2. Add Provider Metadata To Exports And Share

Goal: trust signals should follow the meeting outside the app.

Implement:

- Markdown export section for provider metadata and quality warnings.
- PDF export section for concise provider/source/quality metadata.
- Public share technical details section, if safe and readable.

Acceptance:

- Exports show provider, model, fallback state, confidence, and warnings.
- Share pages still exclude private media.

### 3. Improve Meet Artifact Recovery UX

Goal: a user should know exactly what to do for an empty/upcoming Google meeting.

Implement:

- Workspace freshness and artifact counts.
- Meeting-level Process from Google artifacts action.
- Job recovery grouped by meeting/stage/error.
- Retry/open meeting actions.
- Stale failed jobs do not override completed state.

Acceptance:

- Upcoming, ready, processing, failed, and completed meetings have distinct next actions.

### 4. Polish RealizeOS And Webhooks

Goal: automations are usable in v0.1.0.

Implement:

- RealizeOS payload preview in UI.
- Export queue/sent/failed status per meeting.
- Retry and error body visibility.
- Webhook/n8n setup helper, signed test payload, delivery history, retry failed delivery.

Acceptance:

- A processed meeting can be previewed and queued to RealizeOS.
- A webhook test can be sent to an approved endpoint and history is recorded.

### 5. Strengthen Memory, Rooms, And Hebrew Evaluation

Goal: MeetSum becomes a useful knowledge system, not only a meeting page.

Implement:

- Better Memory filters and cited answers.
- Room detail improvements: linked meetings, tasks, participants, artifacts.
- Private ASR evaluation manifest and sample workflow.
- Stricter task extraction checks.

Acceptance:

- Ask across meetings returns useful cited answers.
- At least one Room can act as a real workstream hub.
- Hebrew/mixed evaluation has a repeatable private workflow.

## Verification Before Handoff

For code changes:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

For production-impacting changes:

```bash
cd /opt/meetsum
./scripts/backup-postgres.sh
./scripts/deploy-vps.sh
curl -fsS https://meetsum.realization.co.il/api/health
```

Then smoke one selected Google Meet artifact or Drive recording. Do not run broad media imports.
