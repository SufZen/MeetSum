# MeetSum Architecture

This repo starts the self-hosted meeting platform as a modular monolith. The app is intentionally built around stable integration boundaries before real credentials are added: Google Workspace sync, meeting ingestion, AI providers, event/webhook delivery, CLI, and MCP tools.

## Production Shape

- `app`: Next.js App Router UI and REST API. Production binds host port `3005` on `127.0.0.1` only (Traefik is the public entrypoint, so `X-Forwarded-For` is trustworthy) and serves locale-prefixed routes.
- `worker`: background jobs for Google sync, media processing, transcription, summarization, embeddings, webhook retries, and agent runs.
- `migrate`: one-shot migration runner that must complete before the app starts.
- `postgres`: system of record for meetings, Google state, transcripts, summaries, action items, tags, contexts, intelligence runs, API keys, and MCP clients. Migrations live in `db/migrations` and run through `npm run db:migrate`.
- `redis`: queue, retry, lock, and job state backend, stored in a persistent Docker volume.
- `minio`: S3-compatible storage for audio-first media artifacts, stored in a persistent Docker volume.
- `n8n`: first automation surface for business workflows.

The `app`, `worker`, and `migrate` containers are disposable. Postgres, Redis, MinIO, and n8n are stateful services with named volumes.

## Google Workspace

Use domain-wide delegation with narrow scope groups from `lib/google/workspace.ts`. Calendar, Gmail, Drive, and Meet each keep their own sync state. Calendar identifies meetings, Drive imports selected Google Meet recordings, Meet artifacts provide conference records/transcript metadata, and Gmail supplies prep/follow-up context after the core capture path is reliable.

Meet recording, transcript, and smart-notes artifacts can be imported through `POST /api/meetings/:id/artifacts/import`. The worker fetches structured transcript entries from Google Meet, exports the linked smart-notes document through Drive, or imports the linked recording Drive file into MinIO and the media pipeline. Transcript-like sources queue summary generation directly; recording artifacts enqueue the normal audio transcription pipeline. `GET /api/google/meet/artifacts?meetingId=...` returns the artifacts linked to one meeting.

Meeting capture readiness is derived in `lib/meetings/capture-readiness.ts`. It classifies meetings as processed, ready to process, capture armed, needing artifact sync, or needing manual capture. The UI uses this model to show upcoming meetings as capture/prep objects instead of empty summaries.

## AI Layer

Provider adapters should hide local/API choices from product code. The default policy is hybrid: local/open-source processing first, then paid/API escalation when Hebrew confidence, diarization confidence, or audio quality is weak.

The current deterministic intelligence layer handles language metadata, Hebrew cleanup, auto-tags, smart tasks, and structured output. Gemini and local Gemma should be added through provider adapters rather than directly inside route handlers.

## External Systems

Business systems should connect through these surfaces in this order:

1. REST API and signed webhooks.
2. n8n workflows.
3. MCP tools for agents and context-aware clients.
4. CLI for local/admin automation.

RealizeOS starts as an outbound export suggestion through `/api/integrations/realizeos/export`; autonomous execution should wait until the receiving API contract is stable.

## Authentication, workspaces and authorization

MeetSum is multi-tenant: a **workspace** owns every meeting, context, tag, job, webhook, API key, setting and audit entry. A **user** is a Google identity (lowercased email); a **membership** gives a user one role in a workspace: `owner > admin > member > viewer`. Permissions per role live in `ROLE_PERMISSIONS` (`lib/auth/authz.ts`); viewers read, members also create and edit meetings, admins also manage settings, members, API keys, webhooks, integrations, storage, audit and ops, and owners also manage owners.

- **Sign-in** (`app/api/auth/google/*`): Google OAuth. The callback upserts the user and issues a signed v2 session cookie (`{v:2, userId, email, ...}`, `lib/auth/session.ts`) only if the user already has a membership, or the return path is `/{locale}/invite/{token}` for a pending invitation addressed to that email. Everyone else is sent to `/login?error=no_access` (audited as `auth.login.denied`). There is no self-signup.
- **Bootstrap** (`lib/workspaces/bootstrap.ts`, run by `npm run db:migrate` and at login for allowlisted emails): `GOOGLE_WORKSPACE_SUBJECT` (else the first `MEETSUM_ALLOWED_EMAILS` entry) owns `ws_default`; other allowlisted emails become admins; existing memberships are never downgraded.
- **Invitations** (`/api/workspaces/current/invitations`): admins invite an email with a role. Tokens are `inv_` + 32 random bytes; only their sha256 is stored. Links expire after `MEETSUM_INVITE_TTL_HOURS` (168). Emails go through `lib/email` (SMTP, Gmail via delegation, or a log fallback); a failed send is stored on the invitation and the API always returns the copyable `inviteUrl`.
- **Every API route** is wrapped by `withAuthz(permission, …)`, `withSession(…)` or `withPublicRoute(reason, …)`. `withAuthz` authenticates per request: a bearer token is checked against env keys, then database keys; an invalid `Authorization` header is a 401 with no cookie fallback. Otherwise the session cookie is verified, the user loaded (disabled users are refused), and the active workspace resolved from the `meetsum_workspace` cookie if the user is still a member there, else their default workspace, else their oldest membership (none: 403 `no_workspace`). Membership is re-read on every request, so removed members lose access immediately. Cookie-authenticated requests with unsafe methods must send an `Origin` (or `Referer`) matching the request host or `NEXT_PUBLIC_APP_URL`. Missing permission: 403 `{error:"Forbidden", permission}`; meetings outside the caller's scope are 404.
- **API keys** belong to a workspace and carry scopes `admin ⊃ write ⊃ read`, acting as roles admin / member / viewer (never owner). Keys created in the UI are stored hashed (`lib/auth/api-keys.ts`) and shown once. Env bootstrap keys (`MEETSUM_API_KEYS` raw or `MEETSUM_API_KEY_HASHES`) are bound to `MEETSUM_ENV_API_KEY_WORKSPACE_ID` (default `ws_default`) with `MEETSUM_ENV_API_KEY_SCOPES` (default `read,write`). The CLI and MCP server send `Authorization: Bearer ...` from `--api-key` or `MEETSUM_API_KEY`.
- **Google delegation identity** (`workspaces.google_subject`) is set by bootstrap from the env subject, or by an owner to their own email only.
