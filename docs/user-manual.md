# MeetSum User Manual

MeetSum is a self-hosted, Google-first meeting intelligence system. It is designed to capture meetings, process recordings into useful intelligence, and connect that intelligence to RealizeOS, n8n, agents, APIs, CLI tools, and MCP clients.

## Core Logic

1. Google Calendar creates the schedule layer: meeting title, time, attendees, organizer, Meet links, and recurrence context.
2. Google Drive and Google Meet artifacts provide the content layer: selected recordings, transcripts, and smart notes.
3. Manual upload and the browser recorder provide the fallback capture path for Zoom, Teams, in-person meetings, or external audio.
4. Worker jobs process media through transcription, cleanup, summary generation, task extraction, indexing, and quality review.
5. The UI exposes the result as summary, transcript, decisions, action items, tags, participants, rooms, exports, share links, and memory search.

## Daily Workflow

### 1. Review Meetings

Open the Meetings page. The default view shows 5 meetings per page with Smart sorting so processed and useful meetings appear before empty future calendar events.

Use filters:

- All: every meeting in the current page/search.
- Ready: completed or usable meetings.
- Processing: meetings with active media/intelligence jobs.
- Failed: meetings that need a retry or manual action.
- Upcoming: scheduled meetings waiting for capture.

### 2. Sync Calendar

Use Sync -> Calendar sync to pull current schedule context from Google Workspace. Calendar sync should not import media by itself; it creates or updates meeting records and participant context.

### 3. Import Recordings

Use Sync -> Find Drive recordings. The picker lists likely recordings and only imports the files you select.

Import behavior:

- Maximum 5 recordings per request.
- Duplicate Drive files are not imported twice.
- Video is converted into an audio-first asset by default.
- The drawer shows Drive download/audio extraction and worker processing status.
- After import, MeetSum selects the imported meeting directly.

### 4. Process Intelligence

Processed meetings move through:

`drive.import -> audio.extract -> audio.transcribe -> transcript.clean -> summary.generate -> tasks.extract -> meeting.index -> quality.review -> completed`

If a meeting has no recording or transcript, MeetSum should not fake content. It shows next actions: upload recording, find Drive recordings, or sync Meet artifacts.

### 5. Review The Meeting

Meeting detail has these tabs:

- Summary: overview, decisions, action items, risks, open questions, key quotes, and audio player.
- Transcript: searchable timestamped transcript and speaker mapping.
- Ask: question answering for the selected meeting.
- Tasks: extracted action items with completion state.
- Prep: future Gmail/Drive prep context.
- Follow-up: generated follow-up draft after intelligence runs.

### 6. Fix Participants And Speakers

Use Participants from the meeting header or Edit speakers in the Transcript tab.

Participant records can come from:

- Google Calendar attendees.
- Transcript speaker labels.
- Manual edits.
- Future Meet artifact data.

Speaker mapping links transcript labels such as `Speaker 2` to real participants. In production, the Postgres repository updates speaker display names so the transcript refreshes with the corrected names.

### 7. Share A Meeting

Use Share in the meeting header. Public sharing creates a read-only page that includes summary, decisions, action items, participants, and transcript.

By default, media/audio is private and is not exposed on the public share page.

### 8. Search Memory

Use AI Memory to search across summaries, transcript snippets, tags, action items, and rooms. Ask all meetings returns an answer with citations where available.

## Integrations

### Google Workspace

Google Workspace is the primary data layer:

- Calendar: schedule context and attendees.
- Drive: selected recordings.
- Meet artifacts: conference records, recordings, transcripts, and smart notes where available.
- Gmail: deferred contextual prep/follow-up layer.

### Gemini And Vertex AI

Production currently uses the AI Studio Gemini API key. Vertex AI support is prepared but should only be enabled after service-account authentication is smoke-tested inside the production container.

### RealizeOS

RealizeOS is the first deep business integration. Meeting exports include structured meeting context, summary, action items, tags, transcript references, language metadata, and Google source context.

### n8n And Webhooks

MeetSum can create signed webhook subscriptions from the Automations page. Paste
an n8n production webhook URL or another API endpoint, choose the events, and
MeetSum will POST signed event payloads to that endpoint.

Supported v0.1.0 events:

- `meeting.completed`
- `summary.created`
- `action_item.created`

Each delivery includes an `x-meetsum-signature` HMAC header. The Automations page
also shows recent delivery attempts, response status codes, and failure messages.
n8n workflows can consume these signed events once workflows are created.

### CLI And MCP

CLI and MCP are intended for agents and automation. Production access should use API keys, never browser-only session assumptions.

## Storage And Retention

- Postgres: system of record for meetings, participants, summaries, actions, sync states, jobs, shares, and integrations.
- Redis/BullMQ: job queue and retry layer.
- MinIO: private object storage for media assets.
- Audio retention: 180 days by default.
- Transcript and summary retention: indefinite by default.
- Video retention: disabled unless explicitly configured.
- Deployments: app, worker, and migrate containers are disposable; Postgres, Redis, and MinIO persist through named Docker volumes.

The Storage page lists recent MinIO media assets. Deleting a media asset removes
the private audio/video object and its media record, but keeps the meeting,
transcript, summary, tasks, tags, participants, and share metadata.

## Operating Rules

- Do not auto-ingest every Drive video. Use operator-selected imports.
- Do not commit raw Fireflies, Timeless, or private transcript samples.
- Keep Google credentials, Gemini keys, OAuth secrets, and service-account materials out of Git.
- Run a Postgres backup before deployment.
- Treat every visible button as either functional or explicitly disabled with a reason.

## Current Limitations

- Meet artifact listing is available, but full artifact-to-meeting import/linking still needs expansion.
- Gmail-aware prep and follow-up are not first-priority until Calendar and Drive paths are reliable.
- DOCX and Notion exports are prepared but not active.
- Vertex AI is not the active production provider yet.
- A visible meeting bot and desktop recorder are deferred until consent and API requirements are proven.

## V0.1.0 Acceptance Target

MeetSum is v0.1.0-ready when:

- A real Google/Drive/imported meeting becomes transcript, summary, decisions, action items, tags, and quotes.
- Public read-only meeting sharing works.
- Participants and speakers can be viewed and corrected.
- Drive import progress is clear.
- Memory search and Ask work across indexed meetings.
- Rooms/context linking works.
- PDF and Markdown exports work.
- Workspace status clearly explains Google/Meet/Drive readiness.
- Hebrew and mixed-language meetings remain first-class.
