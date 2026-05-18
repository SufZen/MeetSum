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

- Local Whisper fallback root cause is not known yet.
- Local ASR is not trusted until private Hebrew/mixed benchmark samples pass.
- Meet artifact sync works but needs better freshness, recovery, and user guidance.
- Many scheduled meetings can still look empty unless the capture/artifact path is obvious.
- Public share works, but share UX needs more smoke testing for revoke/regenerate/included-section states.
- Markdown/PDF exports work, but provider metadata and quality warnings need better export presentation.
- RealizeOS export exists, but preview/send/retry history needs stronger meeting-level UX.
- Webhook infrastructure exists, but a real n8n workflow URL is still needed for live delivery testing.
- Memory and Rooms exist technically but need better ranking, filters, and daily workflows.

## V0.1.0 Readiness Score

- Capture and intake: 7/10. Calendar, Meet artifacts, Drive import, and upload exist; artifact recovery needs polish.
- Processing reliability: 6/10. Pipeline works, but failed-job recovery and local ASR fallback debugging remain.
- Hebrew/mixed AI quality: 5/10. Gemini fallback works; local ASR is not trusted yet.
- Product UI: 8/10. Main UI is strong; secondary workflows need more action-level polish.
- Sharing/export: 7/10. Share and exports exist; metadata and revoke/regenerate smoke need polish.
- Automations/RealizeOS: 7/10. Core routes and payloads exist; UX and live n8n testing remain.
- Operations: 7/10. VPS deploy/backup/health are solid; monitoring, rate limits, audit log UX, and MinIO backup automation remain.

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
