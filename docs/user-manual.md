# MeetSum User Manual

Last updated: May 18, 2026.

MeetSum is a self-hosted, Google-first meeting intelligence system. It helps you capture meetings, process them into useful intelligence, share the result, and connect the output to RealizeOS, n8n, agents, APIs, CLI tools, and MCP clients.

## Core Logic

1. Google Calendar creates the schedule layer: meeting title, time, attendees, organizer, Meet links, and recurrence context.
2. Google Meet artifacts and Google Drive provide the content layer: selected recordings, transcript entries, and smart notes.
3. Manual upload and browser recording are fallback paths for Zoom, Teams, in-person meetings, or external audio.
4. Worker jobs process content through import, transcription, cleanup, summary generation, task extraction, indexing, and quality review.
5. The UI exposes the result as summary, transcript, decisions, action items, tags, participants, Rooms, exports, public share links, memory search, RealizeOS export, and webhooks.

## Daily Workflow

### 1. Review Meetings

Open the Meetings page. The default list shows 5 meetings per page. Use Smart sorting so processed, processing, imported, and useful meetings appear before empty future calendar placeholders.

Useful filters:

- All: every meeting in the current search/page.
- Ready: completed or usable meetings.
- Processing: meetings with active jobs.
- Failed: meetings needing retry or manual action.
- Upcoming: scheduled meetings waiting for capture.

### 2. Understand Meeting State

- Upcoming: the meeting is on the calendar. Use the capture checklist to confirm whether recording, transcript, or smart notes should be enabled during the meeting.
- Ready to process: MeetSum found an artifact or media source. Use Process now or Process from Google artifacts.
- Processing: a worker job is running. Watch stage, job id, and last update.
- Failed: read the failure message, then retry, reprocess, sync artifacts, upload media, or find Drive recordings.
- Completed: review summary, transcript, decisions, tasks, tags, participants, provider metadata, quality warnings, share/export options, and integrations.

### 3. Sync Calendar

Use Sync -> Calendar sync to pull current Google Workspace schedule context. Calendar sync does not import media by itself. It creates and updates meeting records, attendees, organizer data, Meet links, and recurrence context.

### 4. Discover Google Meet Artifacts

Use the Workspace page or Sync menu to run Meet artifact sync. MeetSum can discover conference records, recordings, transcript entries where Google exposes them, and smart notes.

If artifacts exist, the meeting can show Process from Google artifacts. If no artifacts exist, use the next recommended action:

- wait for Google to generate the artifact,
- enable recording/transcript/smart notes in Google Meet,
- import a Drive recording,
- upload a local recording,
- use the browser recorder for in-person meetings.

### 5. Import Recordings

Use Sync -> Find Drive recordings. The picker lists likely recordings and imports only selected files.

Import rules:

- Maximum 5 recordings per request.
- Duplicate Drive files are not imported twice.
- Raw video is not retained by default; MeetSum stores audio-first media.
- After import, the UI should navigate to the imported meeting and show processing progress.

### 6. Process Intelligence

For artifact-based meetings:

```text
artifact.import -> transcript.clean -> summary.generate -> tasks.extract -> meeting.index -> quality.review -> completed
```

For recording/upload-based meetings:

```text
drive.import -> audio.extract -> audio.transcribe -> transcript.clean -> summary.generate -> tasks.extract -> meeting.index -> quality.review -> completed
```

If a transcript or smart-notes artifact exists, MeetSum can generate intelligence without audio transcription. If only a recording exists, MeetSum transcribes it first.

### 7. Review Provider Metadata And Quality Warnings

The meeting right rail shows which provider was used:

- `local-whisper`: local Hebrew ASR.
- `gemini`: Gemini transcription.
- fallback used: local ASR or another primary path failed and Gemini completed the job.

Quality warnings are review guidance:

- fallback used,
- weak transcript confidence,
- no speaker diarization,
- smart-notes-only source,
- tasks missing owner or due date.

Warnings do not mean the meeting is unusable. They tell you what to review before sharing or sending to external systems.

### 8. Review The Meeting

Meeting tabs:

- Summary: overview, decisions, action items, risks, open questions, key quotes, and audio player when media exists.
- Transcript: timestamped transcript, speaker labels, and speaker mapping.
- Ask: questions about the selected meeting.
- Tasks: extracted action items with completion state.
- Prep: future Gmail/Drive prep context.
- Follow-up: follow-up draft after intelligence runs.

### 9. Fix Participants And Speakers

Participant records can come from:

- Google Calendar attendees,
- organizer metadata,
- transcript speaker labels,
- manual edits,
- future Meet artifact data.

Use participant editing and speaker mapping to link labels such as `Speaker 2` to real people. Corrected speaker names should improve transcript readability and public share clarity.

### 10. Share A Meeting

Use Share in the meeting header. Public sharing creates a read-only page that can include summary, decisions, action items, participants, and transcript.

Audio/video remains private by default and is not exposed on public share pages.

Recommended share workflow:

1. Review quality warnings.
2. Confirm participants and speaker names.
3. Choose included sections.
4. Create or regenerate the link.
5. Open the public page in an unauthenticated browser.
6. Revoke the link when it should no longer be accessible.

### 11. Export And Automate

Use the right rail or Automations page for:

- Markdown export,
- PDF export,
- RealizeOS export,
- webhook/n8n delivery,
- future DOCX/Notion exports.

RealizeOS exports should include meeting metadata, summary, decisions, tasks, tags, participants, transcript references, Google context, provider metadata, and quality warnings.

External-impact actions should remain approval-gated.

### 12. Search Memory And Use Rooms

AI Memory searches across summaries, decisions, transcript snippets, tags, action items, and Rooms. Ask all meetings should return answers with citations that name the source meeting, source type, and timestamp when available.

Rooms are workstream hubs. A Room should eventually show linked meetings, open tasks, participants, related files/artifacts, and room-specific memory.

## Integrations

### Google Workspace

- Calendar: schedule context and attendees.
- Meet artifacts: conference records, recordings, transcript entries, and smart notes where available.
- Drive: selected recordings and source files.
- Gmail: deferred contextual prep/follow-up layer.

### Gemini, Local Whisper, And Vertex AI

Production currently uses Gemini AI Studio as the active API provider and fallback. Local Whisper is active through `MEETSUM_TRANSCRIPTION_PROVIDER=auto` for Hebrew/mixed meetings, but it is still being validated. Vertex AI is prepared but inactive until production container auth passes a smoke test.

### RealizeOS

RealizeOS is the first deep business integration. Export status and history should be checked in Automations and the meeting integration surfaces.

### n8n And Webhooks

MeetSum can create signed webhook subscriptions. Paste an n8n production webhook URL or another approved endpoint, choose events, and send a test event before relying on automation.

Supported v0.1.0 events include:

- `meeting.completed`
- `summary.created`
- `action_item.created`
- `meeting.process_failed`
- `realizeos.export.sent`
- `realizeos.export.failed`

Deliveries include an `x-meetsum-signature` HMAC header and are recorded for history/retry.

### CLI And MCP

CLI and MCP are intended for agents and admin automation. Production use should rely on API keys rather than browser sessions.

## Storage And Retention

- Postgres: system of record.
- Redis/BullMQ: queue and retry layer.
- MinIO: private media storage.
- Audio retention: 180 days by default.
- Transcript and summary retention: indefinite by default.
- Video retention: disabled unless explicitly configured.
- Public share pages do not expose private audio/video by default.

## Operating Rules

- Do not auto-ingest every Drive video.
- Do not commit raw Fireflies, Timeless, recording, transcript, or ASR evaluation samples.
- Keep Google credentials, Gemini keys, OAuth secrets, and service-account materials out of Git.
- Run a Postgres backup before deployment.
- Treat every visible button as either functional or explicitly disabled with a reason.
- Do not treat local ASR as trusted until private benchmarks pass.

## Current Limitations

- Local Whisper fallback on real long Hebrew/mixed recordings still needs debugging.
- Meet artifact discovery/import is usable but needs better recovery and scheduling polish.
- Gmail-aware prep/follow-up is deferred.
- DOCX and Notion exports are not active.
- Vertex AI is not active production provider yet.
- Visible meeting bot, desktop recorder, Zoom native capture, and Teams native capture are post-v0.1.0.

## V0.1.0 Acceptance Target

MeetSum is v0.1.0-ready when:

- A real Google/Drive/imported meeting becomes transcript, summary, decisions, action items, tags, quotes, provider metadata, and quality warnings.
- Public read-only meeting sharing works without exposing private media.
- Participants and speakers can be viewed and corrected.
- Drive/Meet import progress and failures are clear.
- Memory search and Ask work across indexed meetings.
- Rooms/context linking works for at least one real workstream.
- PDF and Markdown exports work.
- RealizeOS and webhook flows are auditable and retryable.
- Hebrew and mixed-language meetings remain first-class.
