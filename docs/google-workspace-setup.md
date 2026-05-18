# Google Workspace Setup

Last updated: May 18, 2026.

Google Workspace is MeetSum's primary source for schedule, identity, and live-meeting artifacts.

## Required Google Cloud APIs

Enable these APIs in project `meetsum-494211`:

- Google Calendar API
- Google Drive API
- Google Meet API
- Gmail API
- Admin SDK API
- IAM Credentials API
- Vertex AI API only when preparing the future Vertex switch

## OAuth And Admin Subject

First production admin/subject:

```text
info@realization.co.il
```

Google OAuth is used for browser login and first-admin Workspace consent. Service-account/domain-wide delegation remains the preferred production path for backend polling where possible.

## Domain-Wide Delegation

Use the Workspace service account:

```text
meetsum-workspace-sync@meetsum-494211.iam.gserviceaccount.com
```

In Google Admin Console, authorize the service-account client ID with the narrow scopes used by the app. Keep scopes aligned with `lib/google/workspace.ts`.

The production preference is keyless signing through IAM Credentials. Avoid creating long-lived service-account JSON keys unless there is no alternative. If a key file is used for development or emergency fallback, store it only under `/opt/meetsum/secrets` or a local uncommitted path.

## Capture Responsibilities

- Calendar sync creates and updates scheduled meeting records, attendees, organizer, Meet links, and recurrence context.
- Meet artifact sync discovers conference records, recordings, transcript entries where available, and smart notes.
- Drive discovery lists likely recordings without downloading them.
- Drive import downloads only selected recordings.
- Gmail context remains deferred until the Calendar/Meet/Drive content path is reliable.

## Operator Workflow

1. Sync Calendar.
2. Sync Meet artifacts after meetings have ended.
3. If transcript entries or smart notes are available, process from Google artifacts.
4. If only a recording is available, import the selected recording.
5. If no Google artifact exists, upload or record manually.

Do not enable broad automatic Drive video import. Media intake should remain operator-selected for v0.1.0.

## Production Status Checks

Use:

```bash
curl -fsS https://meetsum.realization.co.il/api/workspace/status
curl -fsS https://meetsum.realization.co.il/api/google/sync/status
curl -fsS https://meetsum.realization.co.il/api/google/meet/artifacts
```

The UI Workspace page should expose Calendar readiness, Meet API/artifact readiness, Drive readiness, provider health, and recent job failures.

## Common Problems

- No Calendar meetings: verify OAuth/Workspace subject and Calendar API access.
- No Meet artifacts: verify Meet API is enabled, scopes are approved, the meeting used Google Meet, and Google had time to generate artifacts.
- Recording not importable: verify Drive file permissions and that the artifact links to a Drive recording.
- Transcript missing: Google may not expose transcript entries for every meeting; use smart notes or recording import.
- Local ASR fallback: this is an AI/worker issue, not a Workspace auth issue.

## Secrets Policy

Never commit:

- OAuth client secrets.
- Service-account JSON.
- Gemini keys.
- Vertex credentials.
- Raw recordings or transcripts.
- Fireflies/Timeless exports.
- `.secrets/asr-eval`.
