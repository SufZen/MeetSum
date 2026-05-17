# MeetSum V0.1.0 Completion Roadmap

## Status Snapshot

Last audited: 2026-05-16.

MeetSum is now a real self-hosted product spine, not only a prototype. The VPS deployment is healthy, the worker is running, Calendar polling is stable, Google Meet artifact discovery works in production, and one real Google Meet smart-notes artifact was imported through the worker into transcript-style segments, summary intelligence, action items, and tags.

The most important remaining work is daily usability: every real meeting should move clearly from scheduled or captured to artifact discovery, selected import, processing, useful intelligence, sharing, export, and recovery if anything fails.

## Current Production Evidence

- App health: `GET /api/health` returns healthy database, Redis, and storage.
- Local verification: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit --omit=dev` pass.
- Meetings in production:
  - `14` completed
  - `253` scheduled
  - `12` failed
  - `5` created
- Jobs in production:
  - `1661` completed
  - `336` failed
- Google sync state:
  - Calendar is current and scheduled every 15 minutes.
  - Meet artifact sync works, but is currently manual/stale after the smoke run.
  - Drive and Gmail sync states are older and should not be treated as reliable daily flows yet.
- Meet artifacts:
  - `11` conference records persisted
  - `8` conference records linked to meetings
  - `2` recording artifacts
  - `2` smart-note artifacts
  - `0` transcript-entry artifacts returned by Google so far
- Real artifact processing smoke:
  - Smart notes imported from Google Docs export.
  - `14` segments persisted.
  - Meeting status became `completed`.
  - Summary, decisions, two action items, and tags were generated.
- Operational usage gaps:
  - `0` active public share links in production.
  - `0` rooms configured in production.
  - `0` webhook subscriptions configured in production.

## Recently Completed

### Core Platform

- VPS production architecture runs with disposable app/worker containers and persistent Postgres, Redis, and MinIO.
- Deployment script creates a Postgres backup before replacing containers.
- Health endpoint reports database, Redis, and storage state without exposing secrets.
- Google OAuth login and first-admin access are in place.
- API-key guard exists for machine/automation access.
- Next.js 16.2.6 build is green and current audit is clean.

### Product UI

- Meetings page has the Fireflies-inspired command-center layout.
- Meeting list supports paging with default `5`, and only `10` or `20` expansion.
- Search, filters, sort, selected meeting routing, dark mode, and compact layout are implemented.
- Workspace, Automations, Storage, Settings, Memory, and Rooms have aligned product shells.
- Meeting detail now distinguishes upcoming, ready-to-process, processing, failed, and completed states.
- Right rail shows pipeline, confidence, tags, exports, and Google context.

### Google Workspace

- Calendar polling is stable and idempotent enough for production use.
- Google Meet API is enabled and authorized.
- Meet artifact sync can list conference records, recordings, and smart notes.
- Meet artifact persistence now handles real production Google IDs:
  - long conference record names use stable hash IDs.
  - existing Google identities return the persisted database ID.
  - raw Drive/Docs IDs from Meet artifacts are accepted.
- Manual Drive recording discovery/import exists and remains operator-controlled.
- Gmail context exists as an early endpoint/sync surface but is not yet a reliable daily workflow.

### Processing And Intelligence

- Worker supports `artifact.import`, media ingestion, summarize/reprocess jobs, Google polling jobs, webhooks, and RealizeOS export jobs.
- Gemini AI Studio is active for transcription/summary.
- Google Meet smart notes can become transcript-style segments and feed the summary pipeline.
- Drive recording artifacts can be imported through Drive recording import.
- Reprocess and selected intelligence actions exist.
- Action-item toggling and task persistence exist.

### Sharing, Participants, Memory, Rooms, Agents

- Public share route and unauthenticated `/share/:token` page exist.
- Meeting share settings can include summary, decisions, participants, action items, and transcript.
- Participant and speaker mapping APIs exist.
- AI Memory search and Ask endpoints exist with citation-style result generation.
- Rooms/context APIs and room detail builder exist.
- Suggested agent routes and approval flow exist.
- RealizeOS export route and auditable job path exist.

### Documentation

- Architecture, production deployment, backup/restore, design system, internationalization, language intelligence, Google setup, and user manual docs exist.

## Key Gaps

### Critical Gaps For Usability

1. Meet artifact sync is not scheduled or promoted as the main capture recovery loop.
2. Workspace UI does not yet guide the user from "artifacts found" to "process this meeting" strongly enough.
3. Failed historical jobs are numerous and need cleanup, grouping, and retry/reprocess UX.
4. Completed meetings exist, but many scheduled/upcoming meetings still look empty unless the user understands the capture/import path.
5. Public sharing exists technically, but the Share modal/workflow needs a full smoke test and production UX polish.
6. Rooms exist technically, but production has no rooms; creation, suggestions, and daily room workflows need to be made obvious.
7. Memory Ask exists, but needs stronger ranking, filters, and cited answer UI before it feels dependable.
8. Participant hydration and editing exist, but need a tighter header/popover/speaker assignment flow.
9. PDF/Markdown exports exist as endpoints but need user-facing polish and smoke tests.
10. RealizeOS export exists, but needs payload preview, status history, and retry visibility.

### Important But Not First

- Gmail-aware prep/follow-up.
- n8n starter workflows.
- DOCX/Notion exports.
- Vertex AI switch.
- API key management UI.
- Audit logs and rate limits.
- MinIO backup automation.
- Analytics and model-cost dashboards.
- Zoom/Teams native capture.
- Visible meeting bot or desktop recorder.

## V0.1.0 Priority Order

### Phase 1: Make Google Meet Artifacts The Daily Capture Loop

Goal: a real Google Meet should become useful with the fewest clicks.

- Schedule Meet artifact polling in the worker, separate from Calendar polling.
- Add `MEETSUM_SCHEDULE_MEET_SYNC` and `MEETSUM_MEET_POLL_MINUTES`.
- Store last Meet artifact sync result clearly in Workspace.
- Add a Workspace action: "Find new Meet artifacts".
- Add a meeting action: "Process from Google artifacts" when smart notes, transcript entries, or recording artifacts are linked.
- If no artifacts exist, show the exact next action:
  - enable recording/transcript/smart notes in Google Meet,
  - wait for Google artifact generation,
  - sync Meet artifacts,
  - import Drive recording manually,
  - upload local recording.
- Keep automatic media download disabled; only metadata polling should be scheduled.

Acceptance checks:

- Calendar polling continues every 15 minutes.
- Meet artifact polling can run on schedule without importing media automatically.
- Workspace shows last Meet artifact sync counts and errors.
- A linked smart-notes artifact can be processed from the meeting UI.

### Phase 2: Processing Recovery And Job Clarity

Goal: no failed or processing meeting should feel mysterious.

- Add a Processing Recovery panel in Workspace:
  - failed jobs grouped by meeting,
  - failed stage,
  - last error,
  - retry button,
  - open meeting button,
  - ignore/archive failure button.
- Normalize job result stages for artifact import:
  - `artifact.import`
  - `smart_notes.export`
  - `transcript.entries`
  - `recording.import`
  - `summary.generate`
  - `quality.review`
- Show historical failed jobs without letting stale failures override a later completed meeting.
- Add targeted tests for latest-job selection when older jobs failed but newer jobs completed.

Acceptance checks:

- `PAT Sisters #3` remains completed even though an older artifact import job failed.
- Failed jobs are visible in Workspace, but do not make completed meetings look failed.
- Retrying a failed artifact import creates a new job and shows progress.

### Phase 3: Share, Export, And Participant Smoke

Goal: a processed meeting can be sent to someone else.

- Run and verify the full share flow:
  - create link,
  - copy URL,
  - open unauthenticated,
  - revoke,
  - regenerate.
- Improve Share modal states:
  - public sharing disabled,
  - no summary yet,
  - transcript excluded,
  - media private by default.
- Smoke-test PDF and Markdown exports from a real processed meeting.
- Improve participant display:
  - attendee hydration from Calendar,
  - participant popover,
  - speaker-to-person assignment from Transcript tab,
  - participant list visible on public share page.

Acceptance checks:

- A processed meeting can be shared publicly without exposing audio/video.
- Share page includes summary, decisions, action items, participants, transcript when selected.
- PDF/Markdown export contains the same core sections.

### Phase 4: Make Rooms And Memory Useful

Goal: the app becomes a meeting memory system, not a pile of summaries.

- Add room creation from sidebar and Add-to-room modal.
- Add automatic room suggestions from:
  - calendar title,
  - existing meeting tags,
  - recurring event name,
  - participants,
  - Drive folder/file names.
- Make Room detail show:
  - meetings,
  - open tasks,
  - participants,
  - linked files/artifacts,
  - ask room memory.
- Improve Memory search:
  - filters for room, participant, tag, language, status, date.
  - answer citations with meeting title and timestamp.
  - "open source meeting" links.

Acceptance checks:

- At least one production room can be created and linked to real meetings.
- Asking across memory returns cited answers that open the source meeting.

### Phase 5: Intelligence Quality Loop

Goal: Hebrew and mixed-language output becomes consistently useful.

- Create a private, uncommitted Hebrew/mixed evaluation set.
- Add evaluation scripts that run only against local/private samples.
- Tighten task extraction:
  - only commitments, assignments, next steps, or explicit follow-ups become tasks.
  - transcript fragments are rejected.
- Add quality warnings:
  - weak transcript,
  - missing owner,
  - missing due date,
  - low confidence,
  - smart-notes-only source.
- Add summary templates:
  - General,
  - Sales,
  - Real Estate,
  - Product,
  - Operations,
  - Legal.

Acceptance checks:

- Hebrew/mixed meetings preserve names, dates, money, technical terms, and uncertainty.
- Action items are real tasks, not raw transcript sentences.
- Smart-notes-only meetings clearly show that the source is Google-generated notes.

### Phase 6: Production Hardening

Goal: the app can run safely without constant shell access.

- Add admin API key management UI.
- Add audit logs for:
  - share create/revoke,
  - exports,
  - external webhooks,
  - RealizeOS export,
  - API keys,
  - deletes,
  - reprocesses.
- Add rate limiting for:
  - public share pages,
  - Ask endpoints,
  - upload/import,
  - API-key endpoints.
- Add metrics:
  - queue depth,
  - failed jobs,
  - Google sync lag,
  - AI latency/cost estimate,
  - storage growth,
  - webhook failures.
- Add MinIO backup/restore commands.
- Add retention deletion job:
  - transcripts/summaries retained indefinitely,
  - audio retained 180 days by default,
  - video retained only when explicitly enabled.
- Smoke-test Vertex AI from production containers before switching away from AI Studio Gemini.

Acceptance checks:

- Admin can diagnose system health from the UI.
- Failed jobs and Google sync lag are visible without SSH.
- Backups cover both Postgres and MinIO.

## Next Most Useful Slice

Implement Phase 1 plus the first part of Phase 2:

1. Schedule Meet artifact metadata polling.
2. Show Meet sync freshness and linked artifact counts in Workspace and Google Context.
3. Add a clear "Process from Google artifacts" action on meetings with linked smart notes or recordings.
4. Add a Processing Recovery panel showing failed jobs grouped by meeting.
5. Add tests that prevent stale failed jobs from overriding completed meeting status.

This is the highest-leverage slice because it turns the newly proven Google Meet artifact path into something usable every day.

