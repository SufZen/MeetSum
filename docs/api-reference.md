# MeetSum API reference

Every `app/api` route handler is documented below, grouped by area. Each section names the methods and path, then the guard the handler checks and the API key scope it needs, then what it does. The generated route index at the end of the file lists the same inventory in one table (`npm run api:reference` rewrites it; `npm run api:reference -- --check` and `tests/api-reference-complete.test.ts` fail when a handler has no section here).

## Overview & conventions

- **Base URL.** Every route is served by the Next.js app under `/api` on the app origin (for example `https://meetsum.example.com/api/meetings`). There is no version prefix.
- **JSON.** Request and response bodies are JSON unless a section says otherwise (multipart uploads, file exports, media streams, SSE, redirects).
- **Errors.** Errors are JSON with an `error` field. Most handlers use either an English message (`{ "error": "Meeting not found" }`) or a stable machine code (`{ "error": "not_found" }`, `"user_required"`, `"queue_unavailable"`, …); some add `message`, `reason`, `permission`, `fieldErrors` or `field`. Common shapes:
  - `401 { "error": "Unauthorized" }`: no valid session cookie or Bearer key.
  - `403 { "error": "Forbidden", "permission": "<permission>" }`: the role (or key scope) lacks the guard's permission.
  - `403 { "error": "Forbidden", "reason": "origin" }`: a cookie-authenticated unsafe request (POST, PATCH, PUT, DELETE) without a same-host `Origin`/`Referer` (CSRF guard; Bearer requests are exempt).
  - `403 { "error": "no_workspace" }`: signed in but not a member of any workspace.
  - `403 { "error": "Forbidden", "reason": "user_required" }`: a route that only serves people (comments, Ask threads, notifications, onboarding, analytics dashboard) called with an API key.
  - `403 { "error": "Forbidden", "reason": "meeting_manage_required" }`: share, visibility and similar changes need the meeting owner or an admin (`canManageMeeting`).
  - `404`: missing, in another workspace, or not visible to the caller. Handlers never distinguish these (no existence hints).
  - `429 { "error": "Too many requests" }` with `Retry-After` (see [Rate limits](#rate-limits)).
  - `503 { "error": "Authentication unavailable" }`: the auth backend failed (fails closed).
- **Ids.** Ids are opaque strings with a type prefix (`meet_…`, `api_key_…`, `ws_…`, `evt_…`). Do not parse them.
- **Timestamps.** ISO 8601 strings in UTC.
- **Pagination.** There is no single scheme. `GET /api/meetings` uses `limit` (5, 10 or 20) and `offset` with `page: { limit, offset, total, hasMore }`; audit logs, tasks, Ask threads, notifications, search and integration deliveries use an opaque cursor (`before`/`cursor` in, `nextCursor` out); many list routes take only `limit`.
- **Workspace scoping.** Every authenticated request runs in one workspace: the API key's workspace, or for a session the active workspace (the `meetsum_workspace` cookie when the user is a member, else their default workspace, else their oldest membership). Membership and role are re-checked on every request. Ids from another workspace answer 404.
- **Meeting visibility.** A meeting is `private`, `workspace` or `link`. `workspace` and `link` meetings are visible to every principal of the workspace. A `private` meeting is visible only to its owner and to members whose email matches one of its participant emails; **admins do not bypass private**. An API key sees `workspace`/`link` meetings plus private meetings owned by the member who created the key. A record without a visibility is treated as private. Everything that is not visible is a 404, including child resources (action items, clips, comments, transcript segments) addressed by their own id.
- **Platform events.** Some write routes return an `event` object (the platform event they emitted) next to the result; it is informational.

## Authentication

Two credentials are accepted. When an `Authorization` header is present it is used exclusively: an invalid or unknown Bearer token is a 401 and the session cookie is not consulted.

### Session cookie

Browser sessions sign in with Google (`GET /api/auth/google/start`). The callback sets `meetsum_session`, an httpOnly, `SameSite=Lax`, signed cookie valid for 7 days. Session requests with unsafe methods must carry an `Origin` (or `Referer`) whose host is the request host, `X-Forwarded-Host` or `NEXT_PUBLIC_APP_URL`. A disabled user, or a user removed from the workspace, loses access on the next request.

Routes guarded by "signed-in user (cookie session)" need only a session (no workspace) and refuse API keys with 401.

### Bearer API keys

```
Authorization: Bearer ms_a1b2c3d4e5f6...
```

A key belongs to one workspace and has scopes `read`, `write` and/or `admin` (each includes the ones below it). The scope maps to a role: `read` → viewer, `write` → member, `admin` → admin (a key is never an owner). A database key acts for the member who created it: it stops working when that member is disabled or leaves the workspace, and it never exceeds that member's current role (demoting the creator demotes their keys).

- Keys are created with `POST /api/admin/api-keys` (default scope `read`; only admins and owners can mint an `admin` key). The raw key is returned once; only a SHA-256 hash is stored.
- Bootstrap keys can be configured in the environment: `MEETSUM_API_KEYS` (comma-separated raw keys, hashed at runtime) or `MEETSUM_API_KEY_HASHES` (`sha256:…`). They are bound to `MEETSUM_ENV_API_KEY_WORKSPACE_ID` (default `ws_default`) with scopes from `MEETSUM_ENV_API_KEY_SCOPES` (default `read,write`) and have no creator, so they never see private meetings.
- Some handlers add checks on top of the scope: routes for people refuse keys (`user_required`), favorites are per user, and private-meeting rights follow the key creator.

### Roles and permissions

| Role | Permissions |
|---|---|
| viewer | `workspace:read`, `meeting:read`, `jobs:read`, `comments:write` |
| member | viewer + `meeting:write`, `meeting:create`, `contexts:write`, `jobs:write`, `integrations:connect` |
| admin | member + `settings:write`, `members:manage`, `api_keys:manage`, `webhooks:manage`, `integrations:manage`, `storage:manage`, `audit:read`, `ops:read` |
| owner | admin + `owners:manage`, `workspace:delete` |

The `Guard` line of each section is the permission the route wrapper checks (with the minimum role); the `API key` part is the scope a Bearer key needs, `not needed` for public routes and `refused` for session-only routes.

## Health

### `GET /api/health`
Guard: public · API key: not needed

Health report for the reverse proxy and uptime checks; always 200. Body: `{ app, version, uptimeSeconds, timestamp, warnings?, services: { database, redis, storage, ai? } }`. `database` is pinged (`ok`/`degraded`); `redis` and `storage` only report `configured`/`not_configured`; `warnings` lists runtime environment problems (fatal ones prefixed `FATAL:`).

### `GET /api/health/live`
Guard: public · API key: not needed

Liveness only: `{ "status": "ok" }` with `cache-control: no-store`. Never calls a dependency.

### `GET /api/health/ready`
Guard: public · API key: not needed

**Stub.** Always answers `501 { "status": "not_implemented" }`. The planned readiness checks (database, Redis, storage, migrations with 200/503) are not implemented yet.

## Auth & session

### `GET /api/auth/google/start`
Guard: public · API key: not needed

Starts Google sign-in: redirects to Google's consent screen (OpenID, email, profile plus the Google Workspace scopes) and sets a 10-minute `meetsum_oauth_state` cookie. Query: `returnTo` (a safe relative path), `loginHint` (an email).

### `GET /api/auth/google/callback`
Guard: public · API key: not needed

Google redirect target. Verifies the state cookie, upserts the user and sets the session cookie, then redirects to `returnTo` (or the user's stored locale home). Failures redirect to `/<locale>/login?error=` with `oauth_state`, `no_access` (disabled user, or no membership and no matching pending invitation), `email_mismatch` (an invitation for another email) or `unauthorized`. Denials are audited (`auth.login.denied`).

### `GET, POST /api/auth/logout`
Guard: public · API key: not needed

Clears the session and active-workspace cookies and redirects to `/<locale>/login` (`?locale=`; relative `Location`). POST answers 303, GET 307.

### `GET /api/me`
Guard: signed-in user (cookie session) · API key: refused

The signed-in user, their workspaces `[{ id, name, role }]`, `activeWorkspaceId`, `role` and `permissions` in the active workspace. Works without any membership (empty list, `role: null`).

### `GET, PATCH /api/me/preferences`
Guard: signed-in user (cookie session) · API key: refused

`{ preferences }`: the user's UI locale, time zone and notification mutes. PATCH validates every field (locale allowlist, IANA zone, known notification kinds) and answers `400 { error: "validation_failed", field }`; a locale change also refreshes the `meetsum_locale` cookie.

### `GET /api/me/invitations`
Guard: signed-in user (cookie session) · API key: refused

Pending invitations addressed to the session email in any workspace: `{ invitations }`.

### `POST /api/me/invitations/:id/accept`
Guard: signed-in user (cookie session) · API key: refused

Accepts a pending, unexpired invitation addressed to the session email, makes that workspace active (cookie) and answers `{ workspace: { id, name, slug }, role }`. Anything else (unknown, someone else's, expired, revoked, used, or a race) is the same `404 { error: "not_found" }`. Audited; `admin` rate limit.

### `POST /api/user/locale`
Guard: public · API key: not needed

Body `{ locale }` (a supported locale, else 400). Sets the `meetsum_locale` cookie; with a valid session (same Origin checks as session routes) it also stores `users.locale`. Answers `{ locale, persisted }`.

### `GET /api/locales`
Guard: public · API key: not needed

`{ defaultLocale, cookieName, locales: [{ code, direction }] }`, needed before sign-in.

### `GET /api/invitations/:token`
Guard: public · API key: not needed

Invite-link preview for the token holder: `{ invitation: { email, role, status, expiresAt }, workspace: { id, name } }`, `no-store`. An unknown or malformed token is `404 { error: "invitation_not_found" }`. `publicAccess` rate limit (60/min per IP).

### `POST /api/invitations/:token/accept`
Guard: signed-in user (cookie session) · API key: refused

Joins the invitation's workspace as the signed-in user (the email must match; idempotent), makes it active and answers `{ workspace, role }`. Store errors map to `{ error: <code>, message }` with their status (for example a mismatched email or a revoked invitation); a malformed token is 404. `admin` rate limit.

### `GET /api/workspace/status`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ workspace }`: setup status of the active workspace (Google subject, sync state, …) for the dashboard.

### `POST /api/workspaces`
Guard: signed-in user (cookie session) · API key: refused

Creates a workspace owned by the caller, makes it active and answers `201 { workspace: { id, name, slug }, role: "owner" }`. Body `{ name }` (1–120 characters). Disabled unless `MEETSUM_ALLOW_WORKSPACE_CREATION` is true (`403 workspace_creation_disabled`). `admin` rate limit.

### `POST /api/workspaces/switch`
Guard: signed-in user (cookie session) · API key: refused

Body `{ workspaceId }`. Sets the active-workspace cookie and the user's default workspace; answers `{ activeWorkspaceId, workspace, role }`. A workspace the caller is not a member of is 404.

### `GET, PATCH /api/workspaces/current`
Guard: GET `workspace:read` (viewer+), PATCH `settings:write` (admin+) · API key: GET `read`, PATCH `admin`

GET: `{ workspace, role, permissions }`. PATCH `{ name?, googleSubject? }` (`admin` rate limit, audited `workspace.updated`). `googleSubject`, the identity MeetSum impersonates for Google domain-wide delegation, can only be set by an **owner signed in as a user**, and only to their own email or cleared (`403 owners:manage`, `403 google_subject_not_own_email`).

### `GET, POST /api/workspaces/current/invitations`
Guard: `members:manage` (admin+) · API key: `admin`

GET lists the workspace's invitations. POST `{ email, role?, locale? }` (`role` is `admin`, `member` (default) or `viewer`) creates one, emails it when a provider is configured and answers `201 { invitation, inviteUrl, emailSent, emailError? }` (a send failure is never fatal). An existing member is `409 already_member`. POST has the `admin` rate limit.

### `DELETE /api/workspaces/current/invitations/:id`
Guard: `members:manage` (admin+) · API key: `admin`

Revokes a pending invitation: `{ invitation }`. Audited; `admin` rate limit.

### `POST /api/workspaces/current/invitations/:id/resend`
Guard: `members:manage` (admin+) · API key: `admin`

Issues a fresh token (the old link stops working), extends the expiry and emails it again. Body `{ locale? }`. Answers `{ invitation, inviteUrl, emailSent, emailError? }`.

### `GET /api/workspaces/current/members`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ members: [{ userId, email, name, picture, role, createdAt }] }`.

### `PATCH, DELETE /api/workspaces/current/members/:userId`
Guard: PATCH `members:manage` (admin+), DELETE `workspace:read` (viewer+) · API key: PATCH `admin`, DELETE `read`

PATCH `{ role }` changes a member's role; changes that involve the owner role need `owners:manage`, and the last owner can never be demoted. DELETE removes a member (needs `members:manage`, and `owners:manage` for an owner) **or** lets a signed-in user leave with their own user id at any role, which is why its wrapper guard is only `workspace:read`. The last owner can neither leave nor be removed. Answers `{ removed: true, left }`. Both have the `admin` rate limit.

## Meetings

### `GET, POST /api/meetings`
Guard: GET `meeting:read` (viewer+), POST `meeting:create` (member+) · API key: GET `read`, POST `write`

GET lists visible meetings: query `query`, `status` (default `all`), `sort` (`smart` (default), `recent`, `oldest`, `title`, `status`), `limit` (5, 10 or 20; default 5), `offset`. Answers `{ meetings, page: { limit, offset, total, hasMore } }`.

POST creates a meeting: `{ title, source, startedAt, language?, participants? }` where `source` is `upload`, `pwa_recorder`, `google_meet`, `desktop_recorder` or `meeting_bot`, `startedAt` is an ISO date-time with offset and `participants` is a list of names. Owner and visibility come from the caller and the workspace default (`defaultMeetingVisibility`), never from the body; `language` falls back to the workspace default. Answers `201 { meeting, event }`; an invalid body is 400.

### `GET, PATCH, DELETE /api/meetings/:id`
Guard: GET `meeting:read` (viewer+), PATCH `meeting:write` (member+), DELETE `meeting:read` (viewer+) · API key: GET `read`, PATCH `write`, DELETE `read`

GET: `{ meeting, permissions: { canWrite, canManage } }` without the transcript (read `/transcript`); `?include=transcript` adds the segments without word timings. `qualityWarnings[]` items are codes (`{ code, severity, params? }`) and `suggestedAgentRuns[].payload` carries an `intent` code; clients translate them.

PATCH renames: `{ title }` (trimmed, 1–200 characters), reindexes and audits `meeting.renamed`.

DELETE hard-deletes the meeting. Its wrapper guard is only `meeting:read`, but the handler then requires `canManageMeeting`: the meeting owner, or a role of admin or higher (an API key needs the `admin` scope), else `403 { error: "Forbidden", permission: "meeting:manage" }`. Rows cascade in one transaction; stored media objects are deleted after the commit and failures are handed to a `storage.delete` job. Answers `{ deleted: true }`. PATCH and DELETE have the `api` rate limit.

### `GET /api/meetings/timeline`
Guard: `meeting:read` (viewer+) · API key: `read`

Calendar-style aggregation of visible meetings. Query: `from` (inclusive, default 30 days ago), `to` (exclusive, default now), `roomId`, `groupBy` (`day` (default), `week`, `month`). Answers `{ from, to, groupBy, roomId, stats, timeline: [{ period, meetingCount, meetings }] }`. Without `roomId` only the latest 500 meetings are considered. `api` rate limit.

### `POST /api/meetings/:id/upload`
Guard: `meeting:create` (member+) · API key: `write`

Multipart upload of media for an existing visible meeting (404 before any byte is read otherwise):
- `file`: audio/video file;
- `transcript`: optional JSON array of `{ text, speaker?, startMs, endMs, confidence?, language? }`;
- `captureMetadata`: optional JSON (desktop `captureId`, app version, devices, local transcription provider, …).

With transcript segments the media is stored and summary generation is queued without retranscribing. A retried upload with the same `captureMetadata.captureId` reuses the stored asset. Answers `202 { asset, job, deduplicated, transcriptSegments, captureMetadata, event }`; size limits come from the upload configuration.

### `GET, HEAD /api/meetings/:id/media`
Guard: `meeting:read` (viewer+) · API key: `read`

Streams the meeting's playback media through the server (`?variant=audio|video`) with Range and conditional requests; object storage is never exposed. HEAD returns headers only. Not audited or rate limited (players issue many range requests).

### `GET /api/meetings/:id/media/peaks`
Guard: `meeting:read` (viewer+) · API key: `read`

Waveform peaks JSON of the playable audio, with `ETag "p-<assetId>-<preparedAt>"` and 304 on `If-None-Match`; `404 no_peaks` until the media has been prepared.

### `GET /api/meetings/:id/participants`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ participants }` of a visible meeting.

### `PATCH /api/meetings/:id/participants/:participantId`
Guard: `meeting:write` (member+) · API key: `write`

Edits `name`, `email`, `role` (`organizer`, `attendee`, `speaker`, `unknown`), `attendanceStatus` and `speakerLabel`. A participant of another meeting is 404. Changing the **email** needs `canManageMeeting` (participant emails grant access to private meetings), else `403 meeting_manage_required`.

### `GET, POST /api/meetings/:id/speakers`
Guard: GET `meeting:read` (viewer+), POST `meeting:write` (member+) · API key: GET `read`, POST `write`

GET: diarized speakers with their mapping state, the participants and `totalTalkTimeMs`. POST is the legacy bulk mapping: it confirms each named speaker as the participant whose name or email matches, else as a display name; segments are never rewritten.

```json
// POST request
{ "mappings": [{ "speaker": "Speaker 1", "person": "Alice" }] }
// response
{ "mappingsApplied": 1, "segmentsUpdated": 42, "totalSegments": 85 }
```

A meeting without a transcript is 400. `api` rate limit.

### `PATCH /api/meetings/:id/speakers/:speakerId`
Guard: `meeting:write` (member+) · API key: `write`

Body `{ action: "confirm" | "reject" | "reset", participantId?, displayName? }`. `confirm` maps the speaker to a participant of this meeting or a typed name (≤ 120 characters), or with neither accepts the current suggestion, and remembers the person in the workspace speaker profiles; `reject` marks the suggestion wrong so it is never suggested again; `reset` unmaps. Answers `{ speaker }`. `api` rate limit.

### `POST /api/meetings/:id/speakers/assign`
Guard: `meeting:write` (member+) · API key: `write`

Legacy single mapping: `{ speakerLabel, participantId }` confirms the speaker as that participant (which must belong to the meeting). Answers `{ participant, speaker }`.

### `POST /api/meetings/:id/speakers/merge`
Guard: `meeting:write` (member+) · API key: `write`

`{ sourceSpeakerId, targetSpeakerId }`: moves the source speaker's segments to the target (diarization split one person in two) and deletes the source. Both must belong to the meeting. Answers `{ speaker }`. `api` rate limit.

### `POST /api/meetings/:id/speakers/suggest`
Guard: `meeting:write` (member+) · API key: `write`

Recomputes speaker suggestions; confirmed and rejected speakers are left alone. Answers `{ suggested, speakers }`. `api` rate limit.

### `PATCH /api/meetings/:id/favorite`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ favorite: boolean }` sets the caller's own favorite and answers `{ meeting }`. Favorites are per user: an API key gets **400** (not 403).

### `PATCH /api/meetings/:id/tags`
Guard: `meeting:write` (member+) · API key: `write`

`{ tags: string[] }` replaces the meeting's tags and reindexes it. Answers `{ meeting }`.

### `POST /api/meetings/:id/contexts`
Guard: `meeting:write` (member+) · API key: `write`

`{ contextId }` links the meeting to a room (context) of the workspace (`404 Room not found` otherwise). Answers `{ meeting }`.

### `PATCH /api/meetings/:id/visibility`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ visibility: "private" | "workspace" | "link" }`. The wrapper guard is `meeting:read`, but the handler requires `canManageMeeting` (owner or admin+; API keys need the `admin` scope), else `403 meeting_manage_required`. Leaving `link` revokes the active share links in the same transaction; making a meeting private clears its integrations opt-in. Audited `meeting.visibility.changed`.

### `POST, PATCH /api/meetings/:id/share`
Guard: POST `meeting:read` (viewer+), PATCH `meeting:write` (member+) · API key: POST `read`, PATCH `write`

Both need a visible meeting and `canManageMeeting` (`403 meeting_manage_required`), and `publicSharingEnabled` in Settings (else 403).

- POST creates (or returns) the public link and switches the meeting to `link` visibility. Body `{ includedSections? }`; the default sections are summary, decisions, participants, plus action items and transcript when the workspace settings say so. The recording (`media`) is shared only when listed. Answers `{ share, url, visibility: "link" }`.
- PATCH `{ revoked?, regenerate?, includedSections?, password? }` revokes/restores, rotates the token, changes the sections, or sets (8–128 characters) or clears (`null`) the link password. The password is hashed and never echoed; changing it invalidates access cookies. Revoking still works with public sharing disabled. `exports` rate limit.

`share` never contains the password hash, only `passwordProtected`. An unknown section is 400. The public page is `/share/:token`.

### `POST /api/meetings/:id/process`
Guard: `meeting:write` (member+) · API key: `write`

Queues processing from whatever the meeting has, answering `202 { job, mode, message }`: Google Meet transcript/smart notes first when `googleArtifactsFirst` is on and there is no transcript (`mode: "meet-content-artifact"`), else the attached recording (`media`, `media.ingest`), else the existing transcript (`transcript`, `meeting.summarize`), else any importable Meet artifact. Nothing to process is `409 { error, nextActions }`.

### `POST /api/meetings/:id/reprocess`
Guard: `meeting:write` (member+) · API key: `write`

`{ mode?: "full" | "summary" | "tasks" | "transcript-cleanup" }` (default `full`). `full` re-ingests the media (or imports Meet artifacts when there is no media); the other modes re-run `meeting.summarize` and need a transcript. Answers `202 { job, mode, event }`; missing inputs are `409 { error, nextActions }`.

### `POST /api/meetings/:id/export/markdown`
Guard: `meeting:read` (viewer+) · API key: `read`

Markdown download (`text/markdown`, attachment). `?locale=he|en` picks the chrome language. Records an export. `exports` rate limit.

### `POST /api/meetings/:id/export/pdf`
Guard: `meeting:read` (viewer+) · API key: `read`

Hebrew-capable PDF download. Headings, page numbers and dates follow `?locale=he|en` (else the request locale) and the caller's time zone (user, then workspace, then environment); content keeps the meeting language. A render failure is `500 export_failed`. `exports` rate limit.

### `POST /api/meetings/:id/export/docx`
Guard: `meeting:read` (viewer+) · API key: `read`

Word (`.docx`) download; `?locale=`. `exports` rate limit.

### `POST /api/meetings/:id/export/google-docs`
Guard: `meeting:read` (viewer+) · API key: `read`

Creates (or updates in place) a Google Doc of the recap in the requester's Drive; body `{ includeTranscript? }`, `?new=1` forces a new document. Auth, in order: the requester's personal `google_drive` connection (OAuth with PKCE, `drive.file`), then service-account domain-wide delegation when `MEETSUM_GOOGLE_DOCS_DWD=true` and the requester's domain matches the workspace subject's; otherwise `409 { error: "google_docs_not_connected", connectUrl }`. API keys never have a personal connection, so they always get the 409. `allowManualSend: false` on the connection is `403 manual_send_disabled`; a private meeting needs its owner's per-meeting opt-in (`403 private_meeting_not_opted_in`). Answers `{ documentId, url, updated }`; Google's error text is never reflected. `exports` rate limit.

### `POST /api/meetings/:id/export/notion`
Guard: `meeting:write` (member+) · API key: `write`

Creates (or updates in place) the meeting's page in a Notion database through the workspace's Notion OAuth connection. Body `{ databaseId? }` (else the connection's default database; neither is `400 notion_database_required`). A body with `token` is refused (`400 token_not_accepted`); there is no server token fallback. A private meeting also needs `canManageMeeting`. Optional `Idempotency-Key` header (a replayed key returns the same page; a concurrent run is `409 export_in_progress`). Other refusals: `409 notion_not_connected`, `403 manual_send_disabled`, `403 private_meeting_not_opted_in`, `400 invalid_destination`. Answers `{ deliveryId, pageId, url, updated }`. `exports` rate limit.

## Transcript & player

### `GET /api/meetings/:id/transcript`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ meetingId, version, language, segments, speakers }` with word timings as compact tuples. `ETag: "t-<meetingId>-<version>"`; a matching `If-None-Match` answers 304 after reading only the version.

### `PATCH /api/meetings/:id/transcript/segments/:segmentId`
Guard: `meeting:write` (member+) · API key: `write`

Body `{ revision, text?, speakerId? | newSpeakerName?, scope?: "segment" | "turn" }`. Edits the segment text (words are realigned so untouched timings survive) and/or reassigns its speaker (`turn`: every segment of the same turn and old speaker). A stale `revision` is `409 { error: "conflict", segment }`; an unknown segment is 404. The audit entry never carries transcript text. `api` rate limit.

### `GET /api/meetings/:id/transcript/segments/:segmentId/revisions`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ revisions }`: prior states of an edited segment, newest first.

### `POST /api/meetings/:id/transcript/segments/:segmentId/undo`
Guard: `meeting:write` (member+) · API key: `write`

Body `{ revision }`. Undoes the segment's latest edit as a whole (every segment of its edit group, in one transaction). `409 { error: "nothing_to_undo" }`, or `409 { error: "conflict", segment }` when any segment of the group changed since. `api` rate limit.

## Intelligence

### `GET /api/meetings/:id/intelligence`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ intelligence }`: the latest meeting intelligence normalized to the V2 shape. 404 when none has been generated.

### `POST /api/meetings/:id/intelligence/run`
Guard: `meeting:write` (member+) · API key: `write`

`{ templateKey?, language?: "he" | "en" }` queues `meeting.summarize` and answers `202 { job, event }`. An unknown template is `400 unknown_template`; a down queue is `503 queue_unavailable` with `Retry-After`.

### `PATCH /api/meetings/:id/template`
Guard: `meeting:write` (member+) · API key: `write`

`{ templateKey: string | null }`: the meeting's summary template (`null` falls back to the workspace default). Unknown keys are `400 unknown_template`. Answers `{ meeting: { id, templateKey } }`.

### `GET, POST /api/meetings/:id/action-items`
Guard: GET `meeting:read` (viewer+), POST `meeting:write` (member+) · API key: GET `read`, POST `write`

GET: `{ actionItems }`. POST creates a user task (origin `user`, marked edited so regeneration never touches it): title plus optional status, priority, owner (`ownerText`, `ownerParticipantId` or `ownerUserId`, which must be a workspace member) and due (`dueOn` or a `dueText` phrase parsed against the meeting start). Answers `201 { actionItem }`; the assignee is notified.

### `PATCH, DELETE /api/action-items/:id`
Guard: `meeting:write` (member+) · API key: `write`

PATCH `{ meetingId, title?, status?, priority?, ownerText? | ownerParticipantId? | ownerUserId?, dueOn? | dueText? }`; DELETE takes `?meetingId=` (or the same field in the body). The parent meeting is resolved first (404 when invisible or foreign) and the item must belong to it (404). A content edit marks the item `edited_by_user` so it survives regeneration. PATCH answers `{ actionItem }` and emits `action_item.updated`; DELETE answers `{ deleted: true, id }`.

### `GET, POST /api/meetings/:id/follow-up`
Guard: `meeting:read` (viewer+) · API key: `read`

GET lists generated follow-up email variants (`?includeActionItems=0`). POST `{ language?: "he" | "en", tone?: "formal" | "friendly" | "concise", includeActionItems?, recipients?, force? }` generates or serves the cached variant and answers `{ variant, mailto, mailtoMaxBodyChars }`. The cached variant is shared, so only `meeting:write` saves it; viewers get an unsaved (`ephemeral`) variant, and `force` needs `meeting:write` (403). No summary is `409 summary_required`; LLM errors are `503 llm_not_configured` / `502 llm_failed`. Shares the on-demand LLM budget with prep.

### `GET, POST /api/meetings/:id/prep`
Guard: `meeting:read` (viewer+) · API key: `read`

GET: the cached prep brief or `{ brief: null, related }` (`?language=he|en`). POST `{ language?, force? }` generates a brief (also for upcoming calendar meetings) from meetings the caller can see; the same write/`ephemeral`/`force` rules, LLM error codes and on-demand budget as follow-up apply.

### `GET /api/meetings/:id/analytics`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ analytics, recomputed, sentimentEnabled }`: talk time, words per minute, monologues, questions, filler rate, interruptions and per-speaker sentiment. Pure metrics are recomputed on read when the transcript changed.

### `POST /api/meetings/:id/analytics/sentiment`
Guard: `meeting:write` (member+) · API key: `write`

Re-runs sentiment (`{ force? }` ignores cached turns). Sentiment disabled is `409 sentiment_disabled`; no LLM provider is `503 llm_not_configured`; a provider failure is 502. Fresh metrics are stored and returned (`{ analytics, sentiment }`) in every case.

### `GET /api/analytics/overview`
Guard: `meeting:read` (viewer+) · API key: `read`

Analytics dashboard over the meetings visible to the caller. **User principals only** (API keys get `403 user_required`). Query: `from`/`to` or `range`, `interval`, `scope`, `roomId`, `tz`. The per-member breakdown is for owners and admins; a room of another workspace is 404; ranges above 366 days are 400. `api` rate limit, `private, no-store`.

### `GET, POST /api/templates`
Guard: GET `workspace:read` (viewer+), POST `settings:write` (admin+) · API key: GET `read`, POST `admin`

GET: built-in summary templates plus workspace templates (`?includeArchived=1`). POST creates a workspace template: `201 { template }`, `400 { error: "Invalid template", fieldErrors }`, `409 template_key_exists`.

### `GET, PATCH, DELETE /api/templates/:id`
Guard: GET `workspace:read` (viewer+), PATCH and DELETE `settings:write` (admin+) · API key: GET `read`, PATCH and DELETE `admin`

GET one workspace template. PATCH replaces the editable fields (`409 template_key_exists`, `409 template_key_immutable`). DELETE archives it; meetings keep their key. Unknown ids are 404.

## Search & Ask

### `GET /api/search`
Guard: `meeting:read` (viewer+) · API key: `read`

Hybrid (lexical + vector) search over visible meetings. Params: `q` (≤ 300 characters), `from`, `to`, `participant`, `speaker`, `room`, `tag`, `language` (`he`, `en`, `mixed`), `type`, `source`, `kind` (`transcript`, `summary`, `item`, `action_item`, `chapter`, `meta`), `meetingId` (all repeatable), `group` (`meeting` or `chunk`), `limit` (≤ 25 groups / ≤ 50 chunks), `hits` (≤ 10 per meeting), `cursor`. Invalid params or cursor are 400; `503 Search unavailable`. `search` rate limit (per principal).

### `GET /api/search/facets`
Guard: `meeting:read` (viewer+) · API key: `read`

Filter values (people, speakers, rooms, tags, languages, meeting types, sources) from the caller's visible meetings. Same rate-limit bucket as search.

### `GET /api/meetings/search`
Guard: `meeting:read` (viewer+) · API key: `read`

Older search kept for compatibility (prefer `GET /api/search`). Query: `q`, `tag`, `status`, `source` (at least one required), `limit` (default 20, max 100). Answers `{ query, total, meetings: [{ id, title, startedAt, status, source, language, overview, participantCount, tags, isFavorite }] }`. `search` rate limit.

### `POST /api/ask`
Guard: `meeting:read` (viewer+) · API key: `read`

AskMeetSum. Body `{ question (1–2000 characters), scope: { kind: "meeting", meetingId } | { kind: "room", roomId } | { kind: "workspace" }, threadId?, language?, persist? }`. With `Accept: text/event-stream` (default) it streams SSE events `thread`, `context`, `delta`…, then `done` or `error`; with `Accept: application/json` it returns one JSON answer. API keys are always stateless (`persist: false`). An invisible meeting or foreign room is 404; daily/rate limits are 429, no LLM is 503. The question is never logged or audited. `ask` rate limit per IP plus a per-principal limit in the service.

### `GET, POST /api/ask/threads`
Guard: `meeting:read` (viewer+) · API key: `read`

The caller's own Ask threads. **User principals only** (API keys: `403 user_required`). GET filters by `scope=meeting&meetingId=` / `room&roomId=` / `workspace`, `archived=1`, `limit` (≤ 50), `cursor`. POST `{ scope, title? }` answers `201 { thread }`; more than `MEETSUM_ASK_MAX_ACTIVE_THREADS` (500) active threads is `409 thread_limit`. POST has the `threads` rate limit (per user).

### `GET, PATCH, DELETE /api/ask/threads/:id`
Guard: `meeting:read` (viewer+) · API key: `read`

One of the caller's own threads (user principals only). Another user's thread is 404, admins included. PATCH `{ title?, archived? }`; DELETE is a soft delete, audited `ask.thread.deleted`.

### `POST /api/ask/messages/:id/feedback`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ rating: 1 | -1 | null }` (legacy `{ feedback }` accepted) on an assistant message in one of the caller's threads; answers `{ ok: true, rating }`. User principals only; another user's message is 404.

### `POST /api/meetings/:id/ask`
Guard: `meeting:read` (viewer+) · API key: `read`

Compatibility route over AskMeetSum in meeting scope: `{ question }` → `{ answer: { answer, citations: [{ meetingId, segmentId, startMs }] }, status, grounded }`. Not saved as a thread. `ask` rate limit.

### `POST /api/memory/ask`
Guard: `meeting:read` (viewer+) · API key: `read`

Compatibility route over AskMeetSum across every visible meeting: `{ question }` → `{ answer, citations, status, grounded }`. Not saved. `ask` rate limit.

### `GET /api/memory/search`
Guard: `meeting:read` (viewer+) · API key: `read`

Deprecated memory search (`Deprecation: true`, `Link` to `/api/search`). Query: `query`, `limit` (≤ 50), `roomId`, `tag`, `participant`, `language`. Answers `{ results }` (meetings with matches); without `query` it lists recent meetings. `search` rate limit.

### `GET, POST /api/contexts`
Guard: GET `workspace:read` (viewer+), POST `contexts:write` (member+) · API key: GET `read`, POST `write`

Rooms (contexts) of the workspace. GET: `{ contexts }`. POST `{ name, description? }` creates one: `201 { context }`. This is how rooms are created (there is no `POST /api/rooms`).

### `GET /api/rooms`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ rooms }` with meeting counts.

### `GET /api/rooms/:id`
Guard: `workspace:read` (viewer+) · API key: `read`

Room detail built from the room's visible meetings: stats, meetings, tasks, participants and artifacts. A room of another workspace is 404.

### `GET /api/rooms/suggestions`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ suggestions }`: room groupings suggested from meeting title patterns and tags, skipping existing room names.

### `POST /api/rooms/:id/ask`
Guard: `meeting:read` (viewer+) · API key: `read`

Compatibility route over AskMeetSum in room scope: `{ question }` → `{ answer, citations, status, grounded }`. A foreign room is 404. `ask` rate limit.

## Clips, comments & reactions

### `GET, POST /api/meetings/:id/clips`
Guard: GET `meeting:read` (viewer+), POST `meeting:write` (member+) · API key: GET `read`, POST `write`

GET: `{ clips }` of a visible meeting. POST `{ startMs, endMs, title? }` or `{ segmentIds (≤ 500), title? }` creates a clip (≥ 2 s, ≤ `MEETSUM_CLIP_MAX_MS`, inside the meeting), queues `clip.render` and answers `201 { clip }`. Errors: 400 validation codes, `403 clip_owner_required` (no acting user, for example an environment API key), `429 clip_limit_reached { scope }`, `503 quota_unavailable`. 20 creations per principal per hour.

### `GET, PATCH, DELETE /api/clips/:id`
Guard: GET `meeting:read` (viewer+), PATCH and DELETE `meeting:write` (member+) · API key: GET `read`, PATCH and DELETE `write`

A clip of a meeting the caller can see (else 404). PATCH `{ title }` renames and DELETE soft-deletes (revoking the clip's share links); both need the clip author or the meeting manager (`403 clip_manage_required`).

### `POST /api/clips/:id/share`
Guard: `meeting:read` (viewer+) · API key: `read`

Creates (or returns) the clip's public link: `{ url, share: { token, createdAt, expiresAt } }`. Needs `canManageMeeting` on the clip's meeting (403), public sharing enabled (403) and a non-private meeting (`409 meeting_private`). The link exposes only the clip and never changes the meeting's visibility.

### `GET, POST /api/meetings/:id/comments`
Guard: GET `meeting:read` (viewer+), POST `comments:write` (viewer+) · API key: `read`

User principals only (API keys: `403 user_required`). GET: threads grouped by target (with an `orphaned` flag when the target is gone), reaction counts and author display names. POST `{ targetType, targetId, body, parentId?, anchor? }` answers `201 { comment }`; mentions notify members who can see the meeting. The body is never audited.

### `PATCH, DELETE /api/comments/:id`
Guard: `comments:write` (viewer+) · API key: `read`

User principals only. PATCH `{ body }` edits (author only) or `{ resolved }` resolves/reopens the thread (member and up). DELETE is allowed to the author or an admin/owner. Store errors map to `{ error: <code> }` with their status.

### `POST /api/reactions`
Guard: `comments:write` (viewer+) · API key: `read`

`{ meetingId, targetType, targetId, emoji }` toggles the caller's reaction; the emoji allowlist is 👍 ❤️ 🎯 ✅ ❓ 😂. User principals only.

## Tasks

### `GET /api/tasks`
Guard: `meeting:read` (viewer+) · API key: `read`

Action items across every meeting the caller can see. Query: `scope=mine|all`, `status=open|done|overdue|all`, `roomId`, `meetingId`, `ownerUserId`, `dueFrom`, `dueTo`, `q`, `sort`, `cursor`, `limit` (≤ 100). An invalid query or cursor is 400.

### `POST /api/tasks/bulk`
Guard: `meeting:write` (member+) · API key: `write`

`{ ids (≤ 100), patch: { status? , ownerUserId? (a member id or null), dueOn?, priority? } }`. Every id is checked on its own: items of invisible or foreign meetings land in `notFound` and are never written. Answers `{ updated, notFound }`; reassignments notify the new owner.

## Notifications & onboarding

### `GET /api/notifications`
Guard: `workspace:read` (viewer+) · API key: `read`

The caller's notifications in the current workspace plus invitations from any workspace; each item re-checks meeting visibility. Query `cursor`, `limit` (1–50, default 20, else `400 invalid_limit`), `unread=1`, `locale`. User principals only (`403 user_required`). `api` rate limit.

### `POST /api/notifications/read`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ ids: string[] (≤ 200) }` or `{ all: true }` marks the caller's own rows read; answers `{ updated, unread }`. User principals only.

### `GET /api/notifications/unread-count`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ count }` with a weak ETag; answers 304 while the count and newest unread row are unchanged. User principals only.

### `GET, POST /api/onboarding`
Guard: `workspace:read` (viewer+) · API key: `read`

The caller's onboarding checklist: `{ steps, dismissed, completed, enabled }` (admin-only steps are `unavailable` for members; `enabled` reflects `MEETSUM_ONBOARDING_ENABLED`). POST `{ action: "skip" | "unskip", step }` or `{ action: "dismiss" | "complete" }` stores the caller's progress (`400 invalid_action`). User principals only.

## Meeting bot

All bot routes answer `404 { error: "bot_disabled" }` when the meeting bot is not enabled on the instance. Bot errors use `{ error: <code> }`.

### `GET /api/bot/sessions`
Guard: `meeting:read` (viewer+) · API key: `read`

`{ byMeetingId }`: open bot sessions plus the last 24 h of finished ones, newest per meeting, only for meetings the caller can see (`?active=0` widens the window to 7 days).

### `GET /api/bot/status`
Guard: `ops:read` (admin+) · API key: `admin`

Bot provider (Vexa) health: `{ enabled, vexaVersion, healthy, running, capacity: { max, perWorkspace }, webhookConfigured }`.

### `POST /api/meetings/bot`
Guard: `meeting:create` (member+) · API key: `write`

"Join now": `{ meetingUrl | text, language?: "he" | "en" | "auto", title? }` sends the bot to a pasted Meet, Zoom or Teams link (or invite text). It attaches to a scheduled meeting for that link or creates a `meeting_bot` meeting, and answers `201 { meeting, session }` (or `200 … reused: true` when a bot is already headed there). Errors: `400 invalid_meeting_link { reason }`, `409 bot_already_in_meeting`, `429 bot_rate_limited` (5/min per user, plus a per-workspace hourly cap) or `429 bot_capacity`. Passcodes and raw URLs are never returned.

### `GET, POST, DELETE /api/meetings/:id/bot`
Guard: GET `meeting:read` (viewer+), POST and DELETE `meeting:write` (member+) · API key: GET `read`, POST and DELETE `write`

GET: `{ session, history, canSend, link }` (the link is redacted). POST `{ meetingUrl? | text? }` sends the bot to this meeting using the given link or the meeting's own (`400 bot_no_link`); it is scheduled for the meeting start minus the join lead time, or dispatched now (`201 { session }`; an open session is returned with 200). DELETE cancels a scheduled bot or stops a live one (`409 bot_session_terminal`, `502 bot_provider_unavailable`). An invisible meeting is 404.

### `GET /api/meetings/:id/bot/live`
Guard: `meeting:read` (viewer+) · API key: `read`

Live draft transcript of the running bot as Server-Sent Events (only with `MEETSUM_LIVE_TRANSCRIPT`); `404 live_unavailable` otherwise. Not the final transcript.

### `POST /api/integrations/vexa/webhook`
Guard: public · API key: not needed

Vexa bot status events, authenticated by an HMAC-SHA256 signature over `<timestamp>.<raw body>` with `VEXA_WEBHOOK_SECRET` (a legacy Bearer secret only when explicitly allowed). The workspace comes from the stored bot session; unknown meetings are a 200 no-op. An oversized body is 413.

## Capture & Google

### `POST /api/desktop-capture/ingest`
Guard: `meeting:create` (member+) · API key: `write`

Multipart upload from the desktop companion or the PWA offline queue:
- `meeting`: JSON `{ title, startedAt, endedAt?, participants?, language? }`;
- `file`: optional audio/video; `transcript`: optional JSON segments; `captureMetadata`: optional JSON (use a stable `captureId`);
- `targetMeetingId`: optional existing meeting the recording belongs to (must be visible and the caller needs `meeting:write`; 404/403).

At least one of `file` or `transcript` is required. Without a target, a `desktop_recorder` meeting is created idempotently per `captureId`, so retries never duplicate meetings or media. Answers `202 { meeting, asset, job, deduplicated, transcriptSegments, captureMetadata, event? }` (200 when deduplicated). An `X-MeetSum-Workspace-Id` header that differs from the caller's workspace is `409 workspace_mismatch`; a `captureId` owned by a meeting the caller cannot see is `409 capture_conflict`.

### `GET /api/google/drive/recordings`
Guard: `meeting:create` (member+) · API key: `write`

Drive recordings that could be imported. Query `limit` (default 25), `cursor`, `query`, `includeImported=true`, `subject` (a Google identity the caller may act as; default the workspace subject or the caller's email). No Google identity is `409 google_not_configured`.

### `POST /api/google/drive/import`
Guard: `meeting:create` (member+) · API key: `write`

`{ fileIds, subject? }` imports the selected Drive files as meetings owned by the caller; answers 202 with the import result.

### `GET /api/google/meet/artifacts`
Guard: `integrations:manage` (admin+) · API key: `admin`

Google Meet conference artifacts (recordings, transcripts, smart notes). Query `subject`, `limit` (≤ 50), `pageToken`, `meetingId` (must be visible, else 404).

### `POST /api/google/meet/sync`
Guard: `meeting:create` (member+) · API key: `write`

`{ subject?, limit? }` discovers Meet artifacts and links them to meetings; answers the sync counts plus an `event`.

### `POST /api/google/sync/:source`
Guard: `integrations:manage` (admin+) · API key: `admin`

Queues a poll for `calendar` or `gmail` (`{ subject? }`) and answers `{ sync, job, event }`. Needs a workspace Google subject (`409 google_not_configured`). `drive` is refused with 409 (Drive import is manual-only); any other source is 400.

### `POST /api/google/sync/all`
Guard: `integrations:manage` (admin+) · API key: `admin`

Queues the calendar poll and answers `202 { jobs, skipped }` (Drive is manual-only and Gmail is deferred). Needs a workspace Google subject.

### `GET /api/google/sync/status`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ sync }`: per-source Google sync state of the workspace.

### `POST /api/meetings/:id/artifacts/import`
Guard: `meeting:write` (member+) · API key: `write`

`{ artifactIds?, subject? }` queues `artifact.import` for the meeting's linked Google Meet transcript, smart notes or recording and answers `202 { job, mode, message }`. A meeting with no importable artifact is `409 { error, nextActions }`.

### `GET /api/storage/media-assets`
Guard: `storage:manage` (admin+) · API key: `admin`

`{ assets }`: stored media assets (`?limit=`, default 50).

### `DELETE /api/storage/media-assets/:id`
Guard: `storage:manage` (admin+) · API key: `admin`

Deletes a media asset and its object: `{ asset }`. Unknown ids are 404.

## Integrations

Integration errors use fixed codes (`{ error: <code> }`); provider error text is never reflected. Providers are `slack`, `notion`, `hubspot` (workspace connections, managed by admins) and `microsoft`, `google_drive` (personal connections, owned by one user).

### `GET /api/integrations/providers`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ providers: [{ id, scope, configured, fake }] }`. Never includes client ids or secrets.

### `GET /api/integrations/:provider/oauth/start`
Guard: `integrations:connect` (member+) · API key: `write`

Redirects (302) to the provider's consent screen with a signed, single-use state bound to the user, workspace and provider (PKCE where supported); `?returnTo=`, `?locale=`. Needs a signed-in user (`403 user_session_required` for API keys); workspace providers also need `integrations:manage`. `integrationsOAuth` rate limit.

### `GET /api/integrations/:provider/oauth/callback`
Guard: signed-in user (cookie session) · API key: refused

Provider redirect target. Membership and permission are re-checked for the state's workspace; every outcome is a 302 (failures carry a fixed `integration_error` code), the state cookie is cleared and the response is `no-store`, `no-referrer`.

### `GET /api/integrations/connections`
Guard: `integrations:connect` (member+) · API key: `write`

`{ connections, fake }`: workspace connections (label, status, non-secret config) plus the caller's personal ones; admins also see other users' personal connections (label and status only). Never a token.

### `PATCH, DELETE /api/integrations/connections/:id`
Guard: `integrations:connect` (member+) · API key: `write`

PATCH `{ config }` updates the provider's allowlisted settings (workspace connection: `integrations:manage`; personal: owner only). DELETE disconnects: best-effort provider revoke, tokens wiped, rules disabled, queued deliveries cancelled (personal: the owner or an admin). Others' personal connections are 404 to non-admins. `integrationsWrite` rate limit.

### `GET /api/integrations/connections/:id/options/:picker`
Guard: `meeting:write` (member+) · API key: `write`

Destination picker (Slack channels, Notion databases, HubSpot deals): `?q=&cursor=&purpose=rule|send`. Rule pickers on a workspace connection need `integrations:manage`; send pickers need `allowManualSend`; personal connections are owner-only; a connection needing reauth is `409 integration_needs_reauth`; an unknown picker is 404.

### `POST /api/integrations/connections/:id/test`
Guard: `integrations:connect` (member+) · API key: `write`

Runs the provider's no-op call (for example Slack `auth.test`), updates `last_used_at`/`last_error` and answers a fixed result code. Same access rules as PATCH. `integrationsWrite` rate limit.

### `GET /api/integrations/deliveries`
Guard: `integrations:manage` (admin+) · API key: `admin`

`{ deliveries, nextCursor? }`. Query `status`, `provider`, `ruleId`, `meetingId`, `before`, `limit` (≤ 200). `meetingTitle` is set only when the viewer can see the meeting.

### `GET /api/integrations/deliveries/:id`
Guard: `meeting:write` (member+) · API key: `write`

One delivery (used to poll a manual send). Admins see any delivery; others only manual deliveries they requested. Anything else is 404.

### `POST /api/integrations/deliveries/:id/retry`
Guard: `integrations:manage` (admin+) · API key: `admin`

Re-queues a `failed`, `partial`, or `skipped` (`needs_reauth`) delivery, resetting attempts and keeping the idempotency key: `202 { delivery }`. Otherwise `409 not_retryable`; a down queue is `503 queue_unavailable`.

### `GET, POST /api/integrations/rules`
Guard: `integrations:manage` (admin+) · API key: `admin`

Automatic delivery rules of the workspace. GET `{ rules }`; POST creates a rule (`201 { rule }`) and upserts the single email-recap rule; caps are 409. POST has the `integrationsWrite` rate limit.

### `PATCH, DELETE /api/integrations/rules/:id`
Guard: `integrations:manage` (admin+) · API key: `admin`

PATCH updates a rule (`{ rule }`); editing another admin's rule resets `includePrivate` and stamps the editor. DELETE answers 204. Another workspace's rule is 404.

### `GET, POST /api/integrations/teams/subscription`
Guard: `integrations:manage` (admin+) · API key: `admin`

The instance-level Microsoft Teams recording subscription, managed only from the capture workspace (`MEETSUM_CAPTURE_WORKSPACE_ID`; others get 404). GET: `{ configured, resource, notificationUrl, lifecycleNotificationUrl, subscriptions }`. POST creates or renews it now (201 created, 200 renewed); missing configuration is 503, a Graph failure 502.

### `GET, PUT /api/meetings/:id/integration-prefs`
Guard: GET `meeting:read` (viewer+), PUT `meeting:write` (member+) · API key: GET `read`, PUT `write`

`{ prefs: { meetingId, allowPrivatePush, emailRecap: "inherit" | "on" | "off" }, emailRecapAvailable }`. PUT: `allowPrivatePush` (the owner's opt-in that lets a private meeting be pushed to integrations) only by the meeting owner signed in as a user (`403 owner_only`); `emailRecap` on a private meeting needs `canManageMeeting`. `integrationsWrite` rate limit.

### `POST /api/meetings/:id/integrations/send`
Guard: `meeting:write` (member+) · API key: `write`

Manual push to Slack, Notion or HubSpot: `{ connectionId, destination?, content? }` with an `Idempotency-Key` header; answers `202 { deliveryId, replayed }` (poll `GET /api/integrations/deliveries/:id`). A private meeting needs `canManageMeeting` and the owner's opt-in; the connection must be an active workspace connection with `allowManualSend` not false; the destination (given or the connection default) is checked with the provider. A key reused for a different request is `422 idempotency_key_reuse`; a down queue `503 queue_unavailable`. `integrationsSend` rate limit.

### `POST /api/integrations/realizeos/export`
Guard: `meeting:write` (member+) · API key: `write`

`{ meetingId, contextId? }` creates a RealizeOS suggestion from the meeting intelligence and queues `realizeos.export` (sending to `REALIZEOS_API_URL` + `REALIZEOS_MEETING_CONTEXT_PATH`). Answers `{ suggestion, job, event }`. Invisible meetings are 404 (so are other failures in this handler).

The payload carries `schemaVersion: 2`: `processing.qualityWarnings[]` is `{ code, severity, params?, title, message }` and `suggestedRuns[]` is `{ id, target, status, intent, title, description }`, with English text rendered from the codes at export time (additive for v1 readers).

### `GET /api/integrations/realizeos/exports`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ exports }`: RealizeOS export attempts (`?meetingId=`, `?limit=`, default 25).

### `POST /api/integrations/realizeos/exports/:id/retry`
Guard: `meeting:write` (member+) · API key: `write`

Re-queues an export. Unknown ids are 404; exports of private meetings are refused with the error's code and status.

### `GET /api/integrations/realizeos/preview/:id`
Guard: `meeting:read` (viewer+) · API key: `read`

The RealizeOS payload for meeting `:id` without sending it.

### `GET /api/integrations/realizeos/status`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ status: { configured, baseUrl, path, authConfigured, mode, message } }`: whether the RealizeOS endpoint is configured (no network call).

### `GET, POST /api/email/unsubscribe`
Guard: public · API key: not needed

Email recap unsubscribe with a signed token `t`. GET never changes anything: it redirects (302) to the confirmation page (`?l=` locale). POST (the page's form, or RFC 8058 one-click `List-Unsubscribe=One-Click`) records the unsubscribe and answers 303 to the done page (form) or `{ ok: true }`. An invalid token is `400 invalid_token`. `publicAccess` rate limit.

## Webhooks

### `GET, POST /api/webhooks/subscriptions`
Guard: `webhooks:manage` (admin+) · API key: `admin`

GET: `{ subscriptions }`. POST creates one:

```json
{ "url": "https://example.com/webhook", "events": ["meeting.completed"], "secret": "optional, >= 16 chars", "payloadVersion": 2 }
```

`payloadVersion` is `1` or `2` (default `2`, see [Payload versions](#payload-versions)); without `events` the subscription gets every event of its version. The URL must be `https` (plain `http` only outside production or for allowlisted hosts) and must not resolve to a private, loopback, link-local or reserved address; `MEETSUM_WEBHOOK_ALLOWED_HOSTS` (hosts, `*.suffix`, CIDRs) allowlists internal receivers. Without `secret` a `whsec_…` secret is generated. Answers `201 { subscription, secret, testEvent, signature }`; `secret` is shown **once** (stored encrypted). Validation errors are `400 { error: <code>, message }`. `admin` rate limit.

### `PATCH, DELETE /api/webhooks/subscriptions/:id`
Guard: `webhooks:manage` (admin+) · API key: `admin`

PATCH `{ url?, enabled?, events?, rotateSecret?, payloadVersion? }`; with `rotateSecret: true` the response includes the new `secret` once, and `payloadVersion: 2` upgrades a v1 subscription (one-way). DELETE removes the subscription and its delivery history. `admin` rate limit.

### `GET /api/webhooks/deliveries`
Guard: `webhooks:manage` (admin+) · API key: `admin`

`{ deliveries }`. Query `subscriptionId`, `limit` (default 25). Statuses: `queued`, `active`, `retrying`, `sent`, `failed`, `cancelled`.

### `POST /api/webhooks/deliveries/:id/retry`
Guard: `webhooks:manage` (admin+) · API key: `admin`

Re-queues a failed or cancelled delivery: `{ delivery }`. A delivery has a lifetime cap of `MEETSUM_WEBHOOK_MAX_TOTAL_ATTEMPTS` (20) attempts. `admin` rate limit plus 3 req/min per delivery.

### `GET /api/webhooks/catalog`
Guard: `webhooks:manage` (admin+) · API key: `admin`

`{ version, events: [{ name, versions, description, example, schemaUrl }] }` (see [Event catalog](#event-catalog)). `private, max-age=300`.

### `POST /api/webhooks/test`
Guard: `webhooks:manage` (admin+) · API key: `admin`

`{ subscriptionId | url, eventName?, payloadVersion? }` sends the catalog example of `eventName` (default `meeting.completed`), flagged `"test": true`, with every production header. A subscription test is signed with its secret; an ad-hoc `url` test with a throwaway secret returned once as `secret` (the global `WEBHOOK_SIGNING_SECRET` is never used). 200 when delivered, 502 otherwise; unknown event `400 unknown_event`. `webhookTest` rate limit (10/min).

### `POST /api/webhooks/zoom`
Guard: public · API key: not needed

Zoom events, authenticated by the Zoom HMAC signature (`ZOOM_WEBHOOK_SECRET`; the URL-validation challenge also requires a valid signature, 503 when the secret is unset). `recording.completed` creates a meeting in the capture workspace (idempotent per Zoom meeting UUID: `{ status: "duplicate" }`) and queues `media.ingest`; other events are `{ status: "ignored" }`. Processing failures are 500 so Zoom redelivers.

### `POST /api/webhooks/teams`
Guard: public · API key: not needed

Microsoft Graph change notifications for Teams recordings, authenticated by the subscription `clientState`; echoes `validationToken` during subscription validation. Each new recording becomes a meeting in the capture workspace (idempotent per recording) plus a `media.ingest` job: `202 { status: "accepted", meetingIds, duplicates }`. Partial failures are 500 so Graph redelivers.

### `POST /api/webhooks/teams/lifecycle`
Guard: public · API key: not needed

Graph lifecycle notifications (`reauthorizationRequired`, `subscriptionRemoved`, `missed`), authenticated by `clientState`; echoes `validationToken`. Answers `202 { outcomes }`.

## Jobs & agents

### `GET /api/jobs`
Guard: `jobs:read` (viewer+) · API key: `read`

`{ jobs }` of the workspace (`?meetingId=`, `?status=`), each with `stage`, `stageTitle`, `stageTitleHe` and an approximate `progress` (0–1).

### `GET /api/jobs/:id`
Guard: `jobs:read` (viewer+) · API key: `read`

`{ job }` with its `stage`. Jobs of other workspaces are 404.

### `POST /api/jobs/:id/retry`
Guard: `jobs:write` (member+) · API key: `write`

Enqueues a new job with the same name and payload (`retryOfJobId` set; the workspace always comes from the caller): `202 { job }`.

### `POST /api/agents/run`
Guard: `meeting:write` (member+) · API key: `write`

`{ meetingId, agent? }` (default agent `realizeos-context`) queues `realizeos.export` for a visible meeting: `202 { run: { id, agent, meetingId, status: "queued" }, job, event }`.

### `POST /api/agent-runs/:id/approve`
Guard: `meeting:write` (member+) · API key: `write`

`{ meetingId }` (or `?meetingId=`) approves a suggested agent run; the run must belong to that visible meeting (404). A RealizeOS run queues `realizeos.export`. Answers `{ run, job? }`.

### `POST /api/meetings/:id/agents/suggest`
Guard: `meeting:write` (member+) · API key: `write`

Without a body: builds the default suggestions for the meeting and answers `{ suggestions }`. With `{ target?, payload? }` (`target` is `realizeos`, `n8n`, `mcp` or `webhook`) creates one suggested run: `{ run }`.

## Admin & settings

Admin routes are workspace-scoped (the active workspace) and use the `admin` rate limit unless noted.

### `GET, POST /api/admin/api-keys`
Guard: `api_keys:manage` (admin+) · API key: `admin`

GET: `{ keys }` of the workspace (masked: prefix, label, scopes, dates; active and revoked). POST `{ label?, expiresAt?, scopes? }` (default `["read"]`) creates a key; an `admin`-scope key can only be minted by an admin or owner. The raw key is returned once:

```json
{ "key": "ms_a1b2c3d4e5f6...", "record": { "id": "api_key_...", "keyPrefix": "ms_a1b2c3d4", "label": "CI/CD", "scopes": ["read"] } }
```

### `DELETE /api/admin/api-keys/:id`
Guard: `api_keys:manage` (admin+) · API key: `admin`

Revokes a key: `{ revoked }`. Unknown, foreign or already revoked keys are 404.

### `GET /api/admin/audit-logs`
Guard: `audit:read` (admin+) · API key: `admin`

`{ logs, nextCursor }`. Query `action`, `actor`, `targetType`, `targetId`, `before` (cursor), `limit` (≤ 200, default 50). An invalid cursor is 400.

### `GET /api/admin/operations`
Guard: `ops:read` (admin+) · API key: `admin`

Operational metrics of the workspace for the admin dashboard (jobs, meetings, sync, storage, AI, audit).

### `GET /api/admin/webhooks/stats`
Guard: `webhooks:manage` (admin+) · API key: `admin`

Webhook health from the last 100 deliveries: subscription counts, 24 h totals and success rate, 7-day event breakdown, the 5 most recent failures.

### `GET /api/admin/search/status`
Guard: `ops:read` (admin+) · API key: `admin`

Search index status: storage, `mode` (`hybrid` or `lexical`), meeting counts by index state, capabilities (pgvector, HNSW, Hebrew trigrams, with the reason search runs lexical) and embedding coverage. `?refresh` re-probes the capabilities.

### `POST /api/admin/search/reindex`
Guard: `settings:write` (admin+) · API key: `admin`

`{ meetingId? }` re-indexes one visible meeting (404 otherwise), else the whole workspace; answers `202 { scope, … }`. Audited `search.reindex.requested`.

### `GET, PATCH /api/settings`
Guard: GET `workspace:read` (viewer+), PATCH `settings:write` (admin+) · API key: GET `read`, PATCH `admin`

`{ settings }`: workspace settings (summary template, AI configuration, default visibility, sharing defaults, …). PATCH takes a partial object, audits the changed keys and answers the merged settings; invalid values are 400. It never changes the user's locale cookie.

### `GET, PUT /api/settings/bot`
Guard: GET `workspace:read` (viewer+), PUT `settings:write` (admin+) · API key: GET `read`, PUT `admin`

GET: `{ enabled: false }` when the bot is off, else `{ enabled, rules, editable, envInternalDomains }`. PUT updates the auto-join rules and answers `{ rules }`; turning on auto-join needs the consent acknowledgment (`400 consent_ack_required`), invalid fields are `400 validation_failed { fields }`, and a disabled bot is `404 bot_disabled`.

### `GET, PUT /api/asr/glossary`
Guard: GET `workspace:read` (viewer+), PUT `settings:write` (admin+) · API key: GET `read`, PUT `admin`

`{ glossary, defaults, limits }`: the effective ASR glossary (built-in defaults merged with the workspace terms). PUT `{ version: 1, terms: [...] }` (or `{ glossary: {...} }`) replaces the workspace terms; invalid input is `400 { error: "Invalid glossary", fieldErrors }` keyed like `terms.3.aliases.1`. `api` rate limit.

### `GET /api/asr/status`
Guard: `ops:read` (admin+) · API key: `admin`

ASR provider chains with per-provider configuration, health and circuit-breaker state. Never includes keys.

### `GET /api/ai/providers/status`
Guard: `workspace:read` (viewer+) · API key: `read`

`{ providers }`: configuration status of the AI, transcription and Google Workspace providers (no secrets).

## Share

Public routes behind a share link `/share/:token` (the page itself is not an API route). The unguessable token, plus the share's password cookie when the link has a password, is the credential. Clip tokens never reach the parent meeting.

### `GET, POST /api/share/:token/verify`
Guard: public · API key: not needed

GET: `{ passwordRequired, expiresAt }` (404 for an unknown or expired link). POST checks the password: an HTML form post (`password` field) answers 303 back to the share page (`?error=invalid|rate_limited`); JSON `{ password }` answers `{ valid, passwordRequired }`, or `403 { valid: false, … }` when wrong. Success sets a short-lived, httpOnly, signed cookie scoped to the share page and its media routes. 10 attempts per minute per IP per token, plus per-token failure spacing across all IPs (429 with `Retry-After`); the owner is notified once per streak of failures.

### `GET, HEAD /api/share/:token/media`
Guard: public · API key: not needed

A shared clip's audio (clip tokens), or the shared meeting's recording (meeting tokens, only when the share includes `media`; `?variant=audio|video`). Always proxied, never presigned. 404 unless every gate passes.

### `GET /api/share/:token/media/peaks`
Guard: public · API key: not needed

Waveform peaks of a shared recording behind the same gate as the media route; clip tokens are 404.

## Rate limits

Limits are in-memory sliding windows, per app instance (with N instances the effective budget is up to N times higher). A store failure denies the request. `MEETSUM_RATE_LIMIT=false` disables all of them.

| Preset | Limit | Key | Applies to |
|---|---|---|---|
| `api` | 120/min | client IP | `PATCH`/`DELETE /api/meetings/:id`, speakers, timeline, transcript edits and undo, ASR glossary, analytics overview, notifications list |
| `search` | 60/min | workspace + user (or key) | `/api/search`, `/api/search/facets`, `/api/meetings/search`, `/api/memory/search` |
| `ask` | 20/min | client IP (plus a per-principal limit in the Ask service) | `/api/ask`, `/api/meetings/:id/ask`, `/api/memory/ask`, `/api/rooms/:id/ask` |
| `threads` | 30/min | workspace + user | `POST /api/ask/threads` |
| `exports` | 20/min | client IP | markdown, PDF, DOCX, Notion and Google Docs exports; `PATCH /api/meetings/:id/share` |
| `admin` | 30/min | client IP | `/api/admin/*`, webhook subscriptions, catalog and retry, `PATCH /api/settings`, `PATCH /api/workspaces/current`, members and invitations, invitation accept, workspace creation |
| `publicAccess` | 60/min | client IP | `GET /api/invitations/:token`, `/api/email/unsubscribe` |
| `webhookTest` | 10/min | client IP | `POST /api/webhooks/test` |
| `integrationsOAuth` | 10/min | workspace + principal | OAuth start |
| `integrationsWrite` | 30/min | workspace + principal | connection PATCH/DELETE/test, rule writes, delivery retry, meeting integration prefs |
| `integrationsSend` | 10/min | workspace + principal | `POST /api/meetings/:id/integrations/send` |
| on-demand LLM | writers 3/min and 20/h; others 2/min and 10/h | workspace + principal | `POST` prep and follow-up (one shared budget) |

Route-specific limits: clip creation 20/h per principal; bot "Join now" 5/min per user plus a per-workspace hourly cap; share password checks 10/min per IP per token plus per-token failure spacing; webhook delivery retry 3/min per delivery.

**Headers returned** by IP-keyed presets: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds). A blocked request is `429 { "error": "Too many requests" }` with `Retry-After`.

**Client identification:** IP keys use the client IP. With `MEETSUM_TRUSTED_PROXY_HOPS=N` (default `1`), the client is the Nth `X-Forwarded-For` entry from the right (left entries are client-supplied and ignored); `X-Real-IP` is the fallback. Set `MEETSUM_CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) only if your edge proxy overwrites that header. Values that are not valid IPs are ignored. The app port must not be reachable except through the trusted proxy (production binds it to `127.0.0.1`).

## Event catalog

Webhooks for Zapier, n8n, Make or your own receiver. The machine-readable catalog is `GET /api/webhooks/catalog` (`webhooks:manage`): `{ version: 2, events: [{ name, versions, description, example, schemaUrl }] }`. JSON Schemas (draft 2020-12) for every v2 event live in [`docs/webhooks/schemas/v2/`](webhooks/schemas/v2/) and are regenerated with `npm run webhooks:schemas`.

### Payload versions

Every subscription has a `payloadVersion`:

| Version | Who gets it | Envelope |
|---|---|---|
| `1` | subscriptions created before M8 (unchanged, frozen) | `{ id, name, occurredAt, workspace_id, data }` |
| `2` | new subscriptions (default) and upgraded ones | `{ id, name, version: 2, occurredAt, workspace_id, data }` |

- `POST /api/webhooks/subscriptions` accepts `payloadVersion: 1 | 2` (default `2`). Without `events`, a subscription gets every event of its version.
- `PATCH /api/webhooks/subscriptions/:id` with `{ "payloadVersion": 2 }` upgrades a v1 subscription. The upgrade is one-way (`payload_version_downgrade`, 400).
- Subscribing to an event that is not in the subscription's version (for example `clip.created` on v1), or to an unknown event, answers 400 `event_not_in_version`.
- A v1 subscription never receives a v2-only event, and its payloads stay exactly as before.

### Events

| Event | Versions | When |
|---|---|---|
| `meeting.completed` | 1, 2 | A meeting finished processing (transcript, summary, action items ready). |
| `summary.created` | 1, 2 | A summary was generated or regenerated. The name stays `summary.created` (no rename to `summary.ready`). |
| `action_item.created` | 1, 2 | An action item was extracted (one event per new item). |
| `meeting.process_failed` | 1, 2 | A processing job failed (`permanent: true` means no more retries). |
| `realizeos.export.sent` / `realizeos.export.failed` | 1, 2 | A RealizeOS export succeeded or failed. |
| `action_item.updated` | 2 | An action item was edited; `changed` lists the field names. |
| `clip.created` | 2 | A clip was cut from a meeting. |
| `bot.status_changed` | 2 | The meeting bot changed status. |
| `integration.delivery.failed` | 2 | An integration delivery (Slack, Notion, HubSpot, email recap) failed for good. |

### Headers

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-meetsum-event` | the event name |
| `x-meetsum-event-version` | `1` or `2` |
| `x-meetsum-delivery` | delivery id: the same on every retry of one delivery (dedupe key) |
| `x-meetsum-timestamp` | unix seconds when this attempt was signed |
| `x-meetsum-signature-v2` | `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>` |
| `x-meetsum-signature` | legacy: hex HMAC-SHA256(secret, rawBody), kept for v1 receivers |

Redirects are not followed.

### Verifying signatures

Verify `x-meetsum-signature-v2` on the **raw** body (before any JSON parsing), compare in constant time, and reject a timestamp more than **5 minutes** away from your clock: the timestamp is part of the signed string, so a captured request cannot be replayed later. During a secret rotation the header may carry several `v1=` entries; accept the request when any of them matches. `x-meetsum-signature` (no timestamp) is only for receivers written before M8.

Test vector: secret `whsec_test_secret_1234`, `t = 1760000000`, body `{"id":"evt_1","name":"clip.created","version":2}` → `v1=0e55d105497846c2677e19306f1917ee1eb519bb12214d54507ab2f2a79fbbaa`.

**Node.js**

```js
import { createHmac, timingSafeEqual } from "node:crypto"

export function verifyMeetSum(rawBody, header, secret, toleranceSec = 300) {
  const pairs = String(header ?? "").split(",").map((part) => part.trim().split("="))
  const t = Number(pairs.find(([key]) => key === "t")?.[1])
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest()
  return pairs
    .filter(([key]) => key === "v1")
    .some(([, sig]) => {
      const actual = Buffer.from(sig ?? "", "hex")
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    })
}
```

**Python**

```python
import hashlib, hmac, time

def verify_meetsum(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    pairs = [p.strip().split("=", 1) for p in header.split(",") if "=" in p]
    ts = next((v for k, v in pairs if k == "t"), None)
    if ts is None or not ts.isdigit() or abs(time.time() - int(ts)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in pairs if k == "v1")
```

**n8n Code node** (Webhook node with *Raw Body* enabled; the templates in [`docs/n8n-templates/`](n8n-templates/) ship this node):

```js
const crypto = require("crypto")
const secret = $env.MEETSUM_WEBHOOK_SECRET
const item = $input.first()
const headers = item.json.headers
const raw = item.binary?.data ? Buffer.from(item.binary.data.data, "base64").toString("utf8") : JSON.stringify(item.json.body)
const parts = Object.fromEntries(headers["x-meetsum-signature-v2"].split(",").map((p) => p.trim().split("=")))
const t = Number(parts.t)
if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw new Error("MeetSum signature: timestamp outside the 5 minute window")
const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")
const given = Buffer.from(parts.v1 ?? "")
if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), given)) throw new Error("MeetSum signature mismatch")
return $input.all()
```

### Delivery and retries

- At-least-once: a delivery is retried with exponential backoff (from `WEBHOOK_BACKOFF_MS`) up to `max_attempts` (default 6), within a lifetime budget of `MEETSUM_WEBHOOK_MAX_TOTAL_ATTEMPTS` (20) including manual retries.
- 2xx means delivered. 4xx other than 408/429 stops the retries; anything else is retried.
- Deduplicate on `x-meetsum-delivery` (one delivery to your endpoint) or the envelope `id` (one event; the same id reaches every subscription). There is **no ordering guarantee**.
- Receivers are reached only through the SSRF guard (public addresses only, no redirects).
- `POST /api/webhooks/test { subscriptionId | url, eventName?, payloadVersion? }` sends the catalog example of `eventName` (default `meeting.completed`) for the subscription's version, flagged `"test": true` in the envelope, with every production header. An ad-hoc `url` test is signed with a throwaway secret returned once as `secret`.

### Private meetings

Webhook subscribers (admins) never read private meetings. For a meeting whose visibility is `private`, or cannot be read, meeting events carry only identifiers:

| Event | Private payload keys |
|---|---|
| `meeting.completed`, `summary.created` | `meetingId`, `mode`, `workspace_id`, `visibility: "private"` |
| `action_item.created`, `action_item.updated` | `meetingId`, `actionItemId`, `workspace_id`, `visibility` |
| `clip.created` | `meetingId`, `clipId`, `workspace_id`, `visibility` |
| `meeting.process_failed` | `meetingId`, `jobId`, `jobName`, `attempts`, `permanent`, `workspace_id`, `visibility` |
| `realizeos.export.*` (v2) | `meetingId`, `suggestionId`, `workspace_id`, `visibility` |
| `bot.status_changed`, `integration.delivery.failed` | unchanged: they never carry meeting content |

`title`, `tags`, action item text/owner/priority and error text are omitted; `workspace` and `link` meetings receive the full payload. `clip.created` follows the clip's meeting. v2 payloads re-read the meeting right before they are built, so a visibility change made during processing is honoured.

### Example payloads (v2)

```json
{ "id": "evt_…", "name": "meeting.completed", "version": 2, "occurredAt": "2026-10-12T08:02:11.000Z", "workspace_id": "ws_…",
  "data": { "meetingId": "meet_01HZX5V8Q3", "title": "סנכרון שבועי", "startedAt": "2026-10-12T07:30:00.000Z", "durationMs": 1860000,
            "language": "he", "participantCount": 4, "actionItemCount": 3, "overview": "הצוות סיכם את יעדי הרבעון.",
            "url": "https://meetsum.example.com/he?meeting=meet_01HZX5V8Q3", "visibility": "workspace" } }
```

`data` of the other events:

```json
{ "summary.created": { "meetingId": "meet_01HZX5V8Q3", "title": "Weekly sync", "tags": ["planning"], "url": "https://meetsum.example.com/he?meeting=meet_01HZX5V8Q3", "visibility": "workspace" },
  "action_item.created": { "meetingId": "meet_01HZX5V8Q3", "actionItemId": "act_1", "title": "Send the plan", "owner": "Dana", "priority": "high", "url": "https://meetsum.example.com/he?meeting=meet_01HZX5V8Q3", "visibility": "workspace" },
  "action_item.updated": { "meetingId": "meet_01HZX5V8Q3", "actionItemId": "act_1", "changed": ["status"], "title": "Send the plan", "owner": "Dana", "status": "done", "dueDate": "2026-10-20", "priority": "high", "url": "https://meetsum.example.com/he?meeting=meet_01HZX5V8Q3", "visibility": "workspace" },
  "clip.created": { "meetingId": "meet_01HZX5V8Q3", "clipId": "clip_1", "title": "ההחלטה על התקציב", "startMs": 125000, "endMs": 158000, "url": "https://meetsum.example.com/he?meeting=meet_01HZX5V8Q3&t=125", "visibility": "workspace" },
  "bot.status_changed": { "sessionId": "bot_1", "meetingId": "meet_01HZX5V8Q3", "status": "in_call_recording" },
  "integration.delivery.failed": { "deliveryId": "intd_1", "provider": "slack", "meetingId": "meet_01HZX5V8Q3", "reason": "auth" },
  "meeting.process_failed": { "meetingId": "meet_01HZX5V8Q3", "jobId": "job_1", "jobName": "meeting.transcribe", "error": "ASR timeout", "attempts": 3, "permanent": true, "visibility": "workspace" },
  "realizeos.export.sent": { "meetingId": "meet_01HZX5V8Q3", "suggestionId": "sug_1", "responseStatus": 200, "visibility": "workspace" },
  "realizeos.export.failed": { "meetingId": "meet_01HZX5V8Q3", "suggestionId": "sug_1", "responseStatus": 502, "error": "RealizeOS returned 502", "visibility": "workspace" } }
```

v1 `data` is unchanged: `meeting.completed {meetingId, title, mode?}`, `summary.created {meetingId, title, mode?, tags?}`, `action_item.created {meetingId, actionItemId, title, owner?, priority?}`, `meeting.process_failed {meetingId, jobId, jobName, error, attempts, permanent}`, `realizeos.export.sent {meetingId, suggestionId?, responseStatus}`, `realizeos.export.failed` (+ `error`).

### Zapier: "Catch Hook" recipe

1. In Zapier, create a Zap with **Webhooks by Zapier → Catch Raw Hook** (raw, so the body can be verified) and copy the hook URL.
2. In MeetSum, Settings → Integrations → Webhooks: create a v2 subscription for that URL and the events you need, and copy the secret (shown once).
3. Add a **Code by Zapier (JavaScript)** step that runs the Node.js check above on `inputData.raw_body` and `inputData.headers["X-Meetsum-Signature-V2"]`, and stops the Zap when it returns `false`.
4. Map fields from the parsed body: `data.title`, `data.overview`, `data.url`…
5. Use **Test webhook** (`POST /api/webhooks/test`) to send a schema-valid example and finish the Zap mapping.

<!-- BEGIN GENERATED ROUTE INDEX (npm run api:reference) -->

159 route files, 203 handlers. Guard = the permission each handler checks (minimum workspace role); API key = the scope a Bearer key needs (`read` = viewer, `write` = member, `admin` = admin). Session-only routes refuse API keys.

| Method | Path | Guard | API key |
|---|---|---|---|
| `PATCH` | `/api/action-items/:id` | `meeting:write` (member+) | `write` |
| `DELETE` | `/api/action-items/:id` | `meeting:write` (member+) | `write` |
| `GET` | `/api/admin/api-keys` | `api_keys:manage` (admin+) | `admin` |
| `POST` | `/api/admin/api-keys` | `api_keys:manage` (admin+) | `admin` |
| `DELETE` | `/api/admin/api-keys/:id` | `api_keys:manage` (admin+) | `admin` |
| `GET` | `/api/admin/audit-logs` | `audit:read` (admin+) | `admin` |
| `GET` | `/api/admin/operations` | `ops:read` (admin+) | `admin` |
| `POST` | `/api/admin/search/reindex` | `settings:write` (admin+) | `admin` |
| `GET` | `/api/admin/search/status` | `ops:read` (admin+) | `admin` |
| `GET` | `/api/admin/webhooks/stats` | `webhooks:manage` (admin+) | `admin` |
| `POST` | `/api/agent-runs/:id/approve` | `meeting:write` (member+) | `write` |
| `POST` | `/api/agents/run` | `meeting:write` (member+) | `write` |
| `GET` | `/api/ai/providers/status` | `workspace:read` (viewer+) | `read` |
| `GET` | `/api/analytics/overview` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/ask` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/ask/messages/:id/feedback` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/ask/threads` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/ask/threads` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/ask/threads/:id` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/ask/threads/:id` | `meeting:read` (viewer+) | `read` |
| `DELETE` | `/api/ask/threads/:id` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/asr/glossary` | `workspace:read` (viewer+) | `read` |
| `PUT` | `/api/asr/glossary` | `settings:write` (admin+) | `admin` |
| `GET` | `/api/asr/status` | `ops:read` (admin+) | `admin` |
| `GET` | `/api/auth/google/callback` | public | not needed |
| `GET` | `/api/auth/google/start` | public | not needed |
| `POST` | `/api/auth/logout` | public | not needed |
| `GET` | `/api/auth/logout` | public | not needed |
| `GET` | `/api/bot/sessions` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/bot/status` | `ops:read` (admin+) | `admin` |
| `GET` | `/api/clips/:id` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/clips/:id` | `meeting:write` (member+) | `write` |
| `DELETE` | `/api/clips/:id` | `meeting:write` (member+) | `write` |
| `POST` | `/api/clips/:id/share` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/comments/:id` | `comments:write` (viewer+) | `read` |
| `DELETE` | `/api/comments/:id` | `comments:write` (viewer+) | `read` |
| `GET` | `/api/contexts` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/contexts` | `contexts:write` (member+) | `write` |
| `POST` | `/api/desktop-capture/ingest` | `meeting:create` (member+) | `write` |
| `GET` | `/api/email/unsubscribe` | public | not needed |
| `POST` | `/api/email/unsubscribe` | public | not needed |
| `POST` | `/api/google/drive/import` | `meeting:create` (member+) | `write` |
| `GET` | `/api/google/drive/recordings` | `meeting:create` (member+) | `write` |
| `GET` | `/api/google/meet/artifacts` | `integrations:manage` (admin+) | `admin` |
| `POST` | `/api/google/meet/sync` | `meeting:create` (member+) | `write` |
| `POST` | `/api/google/sync/:source` | `integrations:manage` (admin+) | `admin` |
| `POST` | `/api/google/sync/all` | `integrations:manage` (admin+) | `admin` |
| `GET` | `/api/google/sync/status` | `workspace:read` (viewer+) | `read` |
| `GET` | `/api/health` | public | not needed |
| `GET` | `/api/health/live` | public | not needed |
| `GET` | `/api/health/ready` | public | not needed |
| `GET` | `/api/integrations/:provider/oauth/callback` | signed-in user (cookie session) | refused |
| `GET` | `/api/integrations/:provider/oauth/start` | `integrations:connect` (member+) | `write` |
| `GET` | `/api/integrations/connections` | `integrations:connect` (member+) | `write` |
| `PATCH` | `/api/integrations/connections/:id` | `integrations:connect` (member+) | `write` |
| `DELETE` | `/api/integrations/connections/:id` | `integrations:connect` (member+) | `write` |
| `GET` | `/api/integrations/connections/:id/options/:picker` | `meeting:write` (member+) | `write` |
| `POST` | `/api/integrations/connections/:id/test` | `integrations:connect` (member+) | `write` |
| `GET` | `/api/integrations/deliveries` | `integrations:manage` (admin+) | `admin` |
| `GET` | `/api/integrations/deliveries/:id` | `meeting:write` (member+) | `write` |
| `POST` | `/api/integrations/deliveries/:id/retry` | `integrations:manage` (admin+) | `admin` |
| `GET` | `/api/integrations/providers` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/integrations/realizeos/export` | `meeting:write` (member+) | `write` |
| `GET` | `/api/integrations/realizeos/exports` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/integrations/realizeos/exports/:id/retry` | `meeting:write` (member+) | `write` |
| `GET` | `/api/integrations/realizeos/preview/:id` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/integrations/realizeos/status` | `workspace:read` (viewer+) | `read` |
| `GET` | `/api/integrations/rules` | `integrations:manage` (admin+) | `admin` |
| `POST` | `/api/integrations/rules` | `integrations:manage` (admin+) | `admin` |
| `PATCH` | `/api/integrations/rules/:id` | `integrations:manage` (admin+) | `admin` |
| `DELETE` | `/api/integrations/rules/:id` | `integrations:manage` (admin+) | `admin` |
| `GET` | `/api/integrations/teams/subscription` | `integrations:manage` (admin+) | `admin` |
| `POST` | `/api/integrations/teams/subscription` | `integrations:manage` (admin+) | `admin` |
| `POST` | `/api/integrations/vexa/webhook` | public | not needed |
| `GET` | `/api/invitations/:token` | public | not needed |
| `POST` | `/api/invitations/:token/accept` | signed-in user (cookie session) | refused |
| `GET` | `/api/jobs` | `jobs:read` (viewer+) | `read` |
| `GET` | `/api/jobs/:id` | `jobs:read` (viewer+) | `read` |
| `POST` | `/api/jobs/:id/retry` | `jobs:write` (member+) | `write` |
| `GET` | `/api/locales` | public | not needed |
| `GET` | `/api/me` | signed-in user (cookie session) | refused |
| `GET` | `/api/me/invitations` | signed-in user (cookie session) | refused |
| `POST` | `/api/me/invitations/:id/accept` | signed-in user (cookie session) | refused |
| `GET` | `/api/me/preferences` | signed-in user (cookie session) | refused |
| `PATCH` | `/api/me/preferences` | signed-in user (cookie session) | refused |
| `GET` | `/api/meetings` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings` | `meeting:create` (member+) | `write` |
| `GET` | `/api/meetings/:id` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/meetings/:id` | `meeting:write` (member+) | `write` |
| `DELETE` | `/api/meetings/:id` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/:id/action-items` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/action-items` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/agents/suggest` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/analytics` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/analytics/sentiment` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/artifacts/import` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/ask` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/:id/bot` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/bot` | `meeting:write` (member+) | `write` |
| `DELETE` | `/api/meetings/:id/bot` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/bot/live` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/:id/clips` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/clips` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/comments` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/comments` | `comments:write` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/contexts` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/export/docx` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/export/google-docs` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/export/markdown` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/export/notion` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/export/pdf` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/meetings/:id/favorite` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/:id/follow-up` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/follow-up` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/:id/integration-prefs` | `meeting:read` (viewer+) | `read` |
| `PUT` | `/api/meetings/:id/integration-prefs` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/integrations/send` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/intelligence` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/intelligence/run` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/media` | `meeting:read` (viewer+) | `read` |
| `HEAD` | `/api/meetings/:id/media` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/:id/media/peaks` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/:id/participants` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/meetings/:id/participants/:participantId` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/prep` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/prep` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/process` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/reprocess` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/share` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/meetings/:id/share` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/speakers` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/speakers` | `meeting:write` (member+) | `write` |
| `PATCH` | `/api/meetings/:id/speakers/:speakerId` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/speakers/assign` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/speakers/merge` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/speakers/suggest` | `meeting:write` (member+) | `write` |
| `PATCH` | `/api/meetings/:id/tags` | `meeting:write` (member+) | `write` |
| `PATCH` | `/api/meetings/:id/template` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/transcript` | `meeting:read` (viewer+) | `read` |
| `PATCH` | `/api/meetings/:id/transcript/segments/:segmentId` | `meeting:write` (member+) | `write` |
| `GET` | `/api/meetings/:id/transcript/segments/:segmentId/revisions` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/:id/transcript/segments/:segmentId/undo` | `meeting:write` (member+) | `write` |
| `POST` | `/api/meetings/:id/upload` | `meeting:create` (member+) | `write` |
| `PATCH` | `/api/meetings/:id/visibility` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/meetings/bot` | `meeting:create` (member+) | `write` |
| `GET` | `/api/meetings/search` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/meetings/timeline` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/memory/ask` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/memory/search` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/notifications` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/notifications/read` | `workspace:read` (viewer+) | `read` |
| `GET` | `/api/notifications/unread-count` | `workspace:read` (viewer+) | `read` |
| `GET` | `/api/onboarding` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/onboarding` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/reactions` | `comments:write` (viewer+) | `read` |
| `GET` | `/api/rooms` | `workspace:read` (viewer+) | `read` |
| `GET` | `/api/rooms/:id` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/rooms/:id/ask` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/rooms/suggestions` | `workspace:read` (viewer+) | `read` |
| `GET` | `/api/search` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/search/facets` | `meeting:read` (viewer+) | `read` |
| `GET` | `/api/settings` | `workspace:read` (viewer+) | `read` |
| `PATCH` | `/api/settings` | `settings:write` (admin+) | `admin` |
| `GET` | `/api/settings/bot` | `workspace:read` (viewer+) | `read` |
| `PUT` | `/api/settings/bot` | `settings:write` (admin+) | `admin` |
| `GET` | `/api/share/:token/media` | public | not needed |
| `HEAD` | `/api/share/:token/media` | public | not needed |
| `GET` | `/api/share/:token/media/peaks` | public | not needed |
| `POST` | `/api/share/:token/verify` | public | not needed |
| `GET` | `/api/share/:token/verify` | public | not needed |
| `GET` | `/api/storage/media-assets` | `storage:manage` (admin+) | `admin` |
| `DELETE` | `/api/storage/media-assets/:id` | `storage:manage` (admin+) | `admin` |
| `GET` | `/api/tasks` | `meeting:read` (viewer+) | `read` |
| `POST` | `/api/tasks/bulk` | `meeting:write` (member+) | `write` |
| `GET` | `/api/templates` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/templates` | `settings:write` (admin+) | `admin` |
| `GET` | `/api/templates/:id` | `workspace:read` (viewer+) | `read` |
| `PATCH` | `/api/templates/:id` | `settings:write` (admin+) | `admin` |
| `DELETE` | `/api/templates/:id` | `settings:write` (admin+) | `admin` |
| `POST` | `/api/user/locale` | public | not needed |
| `GET` | `/api/webhooks/catalog` | `webhooks:manage` (admin+) | `admin` |
| `GET` | `/api/webhooks/deliveries` | `webhooks:manage` (admin+) | `admin` |
| `POST` | `/api/webhooks/deliveries/:id/retry` | `webhooks:manage` (admin+) | `admin` |
| `GET` | `/api/webhooks/subscriptions` | `webhooks:manage` (admin+) | `admin` |
| `POST` | `/api/webhooks/subscriptions` | `webhooks:manage` (admin+) | `admin` |
| `PATCH` | `/api/webhooks/subscriptions/:id` | `webhooks:manage` (admin+) | `admin` |
| `DELETE` | `/api/webhooks/subscriptions/:id` | `webhooks:manage` (admin+) | `admin` |
| `POST` | `/api/webhooks/teams` | public | not needed |
| `POST` | `/api/webhooks/teams/lifecycle` | public | not needed |
| `POST` | `/api/webhooks/test` | `webhooks:manage` (admin+) | `admin` |
| `POST` | `/api/webhooks/zoom` | public | not needed |
| `GET` | `/api/workspace/status` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/workspaces` | signed-in user (cookie session) | refused |
| `GET` | `/api/workspaces/current` | `workspace:read` (viewer+) | `read` |
| `PATCH` | `/api/workspaces/current` | `settings:write` (admin+) | `admin` |
| `GET` | `/api/workspaces/current/invitations` | `members:manage` (admin+) | `admin` |
| `POST` | `/api/workspaces/current/invitations` | `members:manage` (admin+) | `admin` |
| `DELETE` | `/api/workspaces/current/invitations/:id` | `members:manage` (admin+) | `admin` |
| `POST` | `/api/workspaces/current/invitations/:id/resend` | `members:manage` (admin+) | `admin` |
| `GET` | `/api/workspaces/current/members` | `workspace:read` (viewer+) | `read` |
| `PATCH` | `/api/workspaces/current/members/:userId` | `members:manage` (admin+) | `admin` |
| `DELETE` | `/api/workspaces/current/members/:userId` | `workspace:read` (viewer+) | `read` |
| `POST` | `/api/workspaces/switch` | signed-in user (cookie session) | refused |

<!-- END GENERATED ROUTE INDEX -->
