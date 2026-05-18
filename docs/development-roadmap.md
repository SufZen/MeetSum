# MeetSum V0.1.0 Completion Roadmap

Last updated: May 18, 2026.

## Status Snapshot

MeetSum is deployed and usable as an early v0.1.0 spine. It is not a full Fireflies/Timeless replacement yet, but the product now has the core daily loop: Google schedule context, selected artifact/media import, worker processing, transcript/summary/tasks/tags, public share, exports, RealizeOS payloads, webhooks, Memory, Rooms, and production VPS operations.

The latest smoke path processed one selected Google Meet recording/artifact end to end. The important finding is that `local-whisper` was attempted for a Hebrew/mixed recording and fell back to Gemini. The fallback is visible in provider metadata and quality warnings, but local ASR root-cause debugging is now the highest-priority engineering task.

## Recently Completed

- Production VPS stack with backup-before-deploy, app/worker/migrate containers, Postgres, Redis, MinIO, optional faster-whisper, and health checks.
- Fireflies-inspired Meetings UI with compact paging, filters, sort, dark mode, right rail, processing states, and share/export/automation affordances.
- Google Calendar sync, Meet artifact discovery/import, and operator-selected Drive recording import.
- Gemini transcription/summary path and local Hebrew ASR path under `MEETSUM_TRANSCRIPTION_PROVIDER=auto`.
- Provider metadata and quality warnings in meeting payloads and RealizeOS payloads.
- Public share pages with private media excluded by default.
- Participants, speaker mapping, favorites, tags, Rooms, Memory search/Ask, suggested agents, RealizeOS export jobs, webhook subscriptions, webhook test delivery, delivery history, and retry paths.
- Documentation baseline, including architecture, user manual, production deployment, language intelligence, state report, Antigravity handoff, and this roadmap.

## V0.1.0 Priority Order

### Phase 1: Debug Local Hebrew ASR Fallback

Goal: make Hebrew/mixed transcription reliable enough to trust, or clearly decide when Gemini should remain primary.

- Reproduce the fallback on the latest real recording.
- Inspect faster-whisper logs, worker timeout behavior, memory/CPU pressure, response payload shape, and temporary-file handling.
- Add a focused regression test or integration harness for local ASR failure/fallback metadata.
- Keep Gemini fallback active and visible.
- Do not declare local ASR trusted until private `.secrets/asr-eval` samples pass practical quality checks.

Acceptance:

- Root cause is documented.
- A Hebrew/mixed sample either completes through local Whisper or falls back with a precise error.
- Provider metadata shows attempted provider, actual provider, model, latency, confidence, and fallback state.

### Phase 2: Polish Provider Metadata In Share And Exports

Goal: the same trust signals visible in the app are available in exported/shared outputs.

- Add provider metadata and quality warnings to Markdown export.
- Add concise quality/provider section to PDF export.
- Decide whether public share shows quality warnings by default or behind a "technical details" section.
- Keep audio/video private on share pages.

Acceptance:

- Markdown/PDF exports include source/provider context.
- Public share remains safe and readable.
- No private media URLs are exposed.

### Phase 3: Improve Meet Artifact Discovery, Import, And Recovery UX

Goal: a scheduled Google Meet should clearly explain what is available and what the user should do next.

- Make Workspace show Meet sync freshness, artifact counts, and last errors.
- Strengthen "Process from Google artifacts" on meetings with smart notes, transcript entries, or recording artifacts.
- Add clearer failure recovery grouped by meeting/job/stage.
- Prevent stale failed jobs from making completed meetings look failed.
- Keep automatic media download disabled.

Acceptance:

- A meeting with artifacts has one obvious process action.
- A meeting with no artifacts has a precise next-action checklist.
- Failed jobs are retryable and do not obscure completed state.

### Phase 4: Finish Automations And RealizeOS Usability

Goal: RealizeOS and webhooks are usable v0.1.0 outputs, not decorative panels.

- Add or polish RealizeOS payload preview, queue/send status, response/error body, and retry history.
- Ensure RealizeOS payload includes provider/source metadata and quality warnings.
- Make webhook/n8n workflow setup clear: create/list/toggle subscriptions, signed test payload, delivery history, retry failed delivery.
- Keep external-impact actions approval-gated.

Acceptance:

- A processed meeting can be previewed and queued to RealizeOS.
- Webhook test delivery can be sent to an approved n8n/test endpoint.
- Delivery status and failures are visible.

### Phase 5: Strengthen Memory, Rooms, And Hebrew Quality Loop

Goal: MeetSum becomes a useful meeting memory system, not only a summary viewer.

- Improve Memory ranking, filters, and answer citations.
- Make Rooms useful with linked meetings, open tasks, participants, artifacts, and room-specific Ask.
- Create private ASR/intelligence evaluation samples under `.secrets/asr-eval`.
- Tighten action-item extraction so transcript fragments do not become tasks.

Acceptance:

- A user can search/ask across real processed meetings with citations.
- At least one Room can become a workstream hub.
- Hebrew/mixed output is evaluated against private examples.

## Outside V0.1.0

These are intentionally deferred:

- Gmail-aware prep/follow-up.
- DOCX and Notion exports.
- Vertex AI switch.
- Visible Google Meet bot.
- Desktop recorder.
- Zoom/Teams native capture.
- Analytics dashboards and model-cost dashboards.
- Full API-key management UI.
- Autonomous external-impact agents.
- CRM-native write-back automation.

## Release Gate

Before calling v0.1.0 usable:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

Production smoke must verify:

- health endpoint,
- app/worker/faster-whisper container status,
- one selected Google Meet artifact or Drive recording import,
- transcript/summary/tasks/tags,
- provider metadata and quality warnings,
- public share page without media exposure,
- Markdown/PDF export,
- RealizeOS preview/queue,
- webhook test delivery to an approved endpoint.
