# MeetSum Project State Report

Date: May 18, 2026.

## Executive Summary

MeetSum is deployed and usable as an early v0.1.0 spine, but it is not yet a full Fireflies/Timeless replacement. The product has a real end-to-end path for selected Google Meet/Drive content: discover or select an artifact, import it, process it through the worker, review transcript/summary/tasks/tags, share it publicly without media exposure, export it, and prepare RealizeOS/webhook automation.

The most important current risk is Hebrew local ASR reliability. The latest production smoke confirmed that local ASR was attempted for a Hebrew/mixed recording and then fell back to Gemini. That fallback is visible and non-blocking, but the root cause must be debugged before local Whisper can be trusted as the primary Hebrew path.

## Current Evidence

- Local branch evidence: `main` at `dd7f7e8`.
- Latest relevant commits:
  - `dd7f7e8 Expose ASR provider metadata and quality warnings`
  - `981d357 Merge local Hebrew ASR provider`
  - `4e80791 feat: add local Hebrew ASR provider`
- Production URL: `https://meetsum.realization.co.il`.
- Production health: app, database, Redis configuration, and storage configuration are healthy.
- Production deployment: VPS stack under `/opt/meetsum`.
- Latest deployment followed backup-before-replace flow.
- Latest known backup from the smoke pass: `/opt/meetsum/backups/postgres/meetsum-postgres-20260517T215623Z.dump`.

## Completed Capabilities

### Platform And Deployment

- Next.js App Router app with worker process and production Docker Compose.
- Disposable app/worker/migrate containers.
- Persistent Postgres, Redis, and MinIO.
- Optional faster-whisper service for local Hebrew ASR.
- Health endpoint and production deployment script.
- Postgres backup and restore scripts.
- Locale-prefixed routes for English, Hebrew, Portuguese, Spanish, and Italian.

### Google Workspace Intake

- Google Calendar sync creates scheduled meeting records.
- Google Meet artifact sync can discover conference records, recordings, smart notes, and transcript entries where Google exposes them.
- Google Drive recording discovery/import is operator-controlled.
- Manual upload and recorder surfaces exist for non-Google capture paths.
- Capture readiness distinguishes upcoming, ready-to-process, processing, failed, and completed meetings.

### Processing And Intelligence

- BullMQ worker handles artifact import, media ingest, transcription, cleanup, summary generation, task extraction, indexing, quality review, webhook delivery, and RealizeOS export jobs.
- Gemini AI Studio is active for transcription and summary generation.
- Local Whisper can be attempted for Hebrew/mixed meetings under `MEETSUM_TRANSCRIPTION_PROVIDER=auto`.
- AI run metadata records provider, attempted provider, model, latency, confidence, and fallback metadata.
- Quality warnings are derived and surfaced.

### Product UI

- Meetings page uses a Fireflies-inspired command-center layout.
- Meeting list supports search, filters, Smart/Recent/Oldest/Title/Status sorting, page size 5/10/20, and selected meeting URL state.
- Meeting detail shows summary, transcript, Ask, tasks, prep/follow-up surfaces, action items, tags, Google context, provider metadata, quality warnings, and integrations.
- Workspace, Automations, Storage, Settings, Memory, and Rooms have aligned product shells.
- Dark mode exists.

### Sharing, Participants, Memory, Rooms

- Public share pages exist at `/share/:token`.
- Share settings can include summary, decisions, participants, action items, and transcript.
- Private audio/video is excluded by default.
- Participants and transcript speaker mapping exist.
- Rooms/context links exist.
- Memory search and Ask endpoints exist with citation-style results.

### Automations And RealizeOS

- RealizeOS status, export queue, export history, retry route, and payload builder exist.
- RealizeOS payload includes meeting metadata, summary, decisions, action items, tags, participants, transcript references, Google context, provider metadata, and quality warnings.
- Webhook subscription, signed test delivery, delivery history, retry, and event surfaces exist.
- n8n infrastructure is prepared but does not require a live workflow yet.

## Latest Production Smoke Result

Test source: latest eligible Google Meet recording/artifact.

Observed result:

- Artifact import was queued.
- Media processing completed.
- Transcript segments were generated.
- Summary, action items, and tags were generated.
- Public share page opened unauthenticated.
- PDF and Markdown rendering worked.
- RealizeOS payload preview included provider/source metadata and quality warnings.
- No duplicate broad media ingestion was intentionally triggered.

Important finding:

- `local-whisper` was attempted for a Hebrew/mixed recording.
- The processing path fell back to Gemini.
- The meeting still completed successfully.
- The fallback is visible in provider metadata and quality warnings.
- Root-cause debugging remains critical.

## Known Issues And Risks

### Local Whisper Root Cause (Diagnosed 2026-05-28)

The `faster-whisper` container crashed during a 52-minute Hebrew/mixed recording transcription on 2026-05-17. Root cause:

- The `ivrit-ai/whisper-large-v3-turbo-ct2` model loaded successfully (13.66s).
- Model auto-converted from `float16` to `float32` (CPU-only container cannot use `float16`).
- Processing started at `22:02:16` for a 52:09 audio file.
- Container crashed/restarted at `22:12:05` (~10 minutes into processing).
- `OOMKilled=false`, `RestartCount=1` — not a Docker OOM kill, likely an internal process crash from excessive memory growth on `float32` compute.
- **Fix options**: (a) set `WHISPER_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2` with explicit `float32` compute and memory limits, (b) chunk long recordings before sending to Whisper, (c) set a timeout shorter than 10 minutes so the fallback to Gemini is faster.
- **Current state**: Whisper `/v1/models` endpoint is healthy from Docker internal network. Short recordings (<15 min) should work. Long recordings will crash the container.
- **Recommendation**: For v0.1.0, rely on Gemini for recordings >15 minutes. Local Whisper for short Hebrew recordings only.

### Remaining Issues

- Public share flow needs E2E smoke testing for revoke/regenerate states.
- RealizeOS export exists, but preview/send/retry history needs meeting-level UX.
- Webhook infrastructure exists, but no production subscriptions configured yet.
- Memory and Rooms exist technically but need creation UX and filter UI.

## V0.1.0 Readiness Score

- Capture and intake: 8/10. Calendar, Meet artifacts, Drive import, upload, workspace sync panel, and artifact discovery all operational.
- Processing reliability: 8/10. Pipeline works, meeting-grouped job recovery with stale-failure protection, structured Whisper diagnostics.
- Hebrew/mixed AI quality: 6/10. Gemini fallback works; local ASR root cause diagnosed (CPU float32 crash on long recordings). Short recordings should work.
- Product UI: 8/10. Main UI is strong; room creation and memory filters still needed.
- Sharing/export: 8/10. Markdown + multi-page PDF include provider metadata; share page has processing footer. Smoke testing remains.
- Automations/RealizeOS: 7/10. Core routes, payloads, and tests exist; preview UX and live n8n testing remain.
- Operations: 8/10. GitHub Actions CI, VPS deploy, backup, health checks all operational. Auto-deploy not yet wired.

## In Scope For V0.1.0

- Reliable selected Google Meet/Drive/manual recording processing.
- Visible provider metadata and quality warnings.
- Public share page without media exposure.
- Markdown/PDF exports.
- RealizeOS export preview/queue/status/retry.
- Webhook subscriptions, signed test delivery, delivery history, and retry.
- Memory search/Ask with citations.
- Rooms as workstream hubs.
- Private Hebrew/mixed ASR evaluation loop.

## Outside First Version

- Gmail-aware prep/follow-up.
- DOCX and Notion exports.
- Vertex AI switch.
- Visible Google Meet bot.
- Desktop recorder.
- Zoom/Teams native capture.
- Analytics dashboards.
- Model-cost dashboards.
- Full API-key management UI.
- Autonomous external-impact agents.
- CRM-native write-back automation.

## Immediate Next Priority

1. Debug local Whisper fallback on the real Hebrew/mixed recording.
2. Add provider metadata and quality warnings into Markdown/PDF/share surfaces.
3. Improve Meet artifact discovery/import/recovery UX.
4. Polish RealizeOS and webhook/n8n usability.
5. Strengthen Memory, Rooms, and private Hebrew quality evaluation.
