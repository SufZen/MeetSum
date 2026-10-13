# Integrations runbook (M8)

Operator checklist for the M8 integrations: the external apps to create, the exact scopes and redirect URIs, the environment variables, how to verify everything locally against the fake providers, and the first live run per provider. Source of truth: `docs/parity/m8.md` ("External apps checklist", "Env", Acceptance 14).

## Overview

| Integration | Connection | Who connects | Used for |
|---|---|---|---|
| Slack | workspace | admins (`integrations:manage`) | Recaps and action items posted to a channel (rules and manual sends) |
| Notion | workspace | admins | A page per meeting in a database; re-exports update the same page |
| HubSpot | workspace | admins | Meeting or note logged on contacts and a deal, tasks from action items |
| Microsoft Outlook | personal | every member (`integrations:connect`) | Outlook calendar sync into the M7 bot rules |
| Google Drive (Docs) | personal | every member | "Export to Google Docs" into the user's own Drive |
| Email recap | none (M2 sender) | admins | One recap email per recipient after a meeting |
| Zapier / n8n / Make | none (webhooks) | admins (`webhooks:manage`) | Signed v2 webhook events |
| RealizeOS | env only | server operator | Read-only status card |

- Everything lives in **Settings → Integrations** (`/{locale}?panel=settings&section=integrations`). The automations panel only links there.
- No token ever reaches the browser, a log, an audit record or a job payload. Tokens are AES-256-GCM encrypted with AAD `workspaceId:connectionId:field`.
- Private meetings are never sent unless their owner opts in (their own rule with "Include private meetings I own", or the per-meeting "Allow integrations for this private meeting" toggle in the meeting ⋯ menu).
- Until the apps below exist, M8 runs on fixtures and the fake providers; live runs are listed as pending in `docs/parity/STATUS.md`.

## Redirect URIs

`BASE` is `MEETSUM_OAUTH_REDIRECT_BASE` (an origin with no path, `https:` in production; it defaults to `NEXT_PUBLIC_APP_URL`). The server never derives a redirect URI from request headers, so **register exactly these URIs and nothing else**:

| Provider | Path |
|---|---|
| Slack | `/api/integrations/slack/oauth/callback` |
| Microsoft | `/api/integrations/microsoft/oauth/callback` |
| Notion | `/api/integrations/notion/oauth/callback` |
| HubSpot | `/api/integrations/hubspot/oauth/callback` |
| Google Drive | `/api/integrations/google_drive/oauth/callback` |

Per environment:

| Environment | `BASE` | Example (Slack) |
|---|---|---|
| Production | `https://meetsum.realization.co.il` | `https://meetsum.realization.co.il/api/integrations/slack/oauth/callback` |
| Staging (if used) | `https://<staging host>` | `https://<staging host>/api/integrations/slack/oauth/callback` |
| Local development (real apps) | `http://localhost:3000` | `http://localhost:3000/api/integrations/slack/oauth/callback` |
| Local e2e (fake providers) | `http://localhost:3000` | nothing to register: the fake server auto-approves |

Notes:
- Slack, Notion and HubSpot reject `http://` redirect URIs other than `localhost` (Slack requires `https` for everything except its own dev tooling); use a tunnel with `https` for local tests against real Slack.
- Microsoft accepts `http://localhost` under the **Web** platform. Google accepts `http://localhost` for "Web application" clients.
- Register each environment's URI on the same app, or create one app per environment and set the matching credentials there.

## External apps checklist

Each app ends with the "First live run" for its provider (below). Record who owns each app and when its secret expires.

### Slack app

- **Where:** api.slack.com/apps → Create New App → From scratch.
- **OAuth & Permissions → Redirect URLs:** `BASE/api/integrations/slack/oauth/callback`.
- **Bot token scopes:**
  - `chat:write` (post messages)
  - `chat:write.public` (post to public channels without an invite; remove it through `SLACK_SCOPES` if the workspace prefers explicit invites)
  - `channels:read` (channel picker)
  - optional `groups:read` (private channels; set `SLACK_PRIVATE_CHANNELS=true` and invite the app to the channel)
- **Stretch (slash command):** `commands`, `users:read`, `users:read.email`; Slash command `/meetsum` → Request URL `BASE/api/integrations/slack/commands`; then set `SLACK_COMMANDS_ENABLED=true` and `SLACK_SIGNING_SECRET` (Basic Information → App Credentials → Signing Secret).
- **Optional:** OAuth & Permissions → Advanced token security → token rotation (refresh tokens are persisted automatically).
- **Multi-workspace installs:** Manage Distribution → Activate Public Distribution.
- **Env:** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (Basic Information → App Credentials), optionally `SLACK_SCOPES`, `SLACK_PRIVATE_CHANNELS`, `SLACK_SIGNING_SECRET`.
- Screenshot placeholder: `docs/runbooks/img/slack-oauth-scopes.png`.

### Microsoft Entra app

May be the existing Teams capture app; the app-only `OnlineMeetingRecording.Read.All` permission for Teams capture is unchanged.

- **Where:** entra.microsoft.com → App registrations → New registration (or the existing app).
- **Supported account types:** "Accounts in any organizational directory" (multitenant), unless only your own tenant connects.
- **Authentication → Add a platform → Web → Redirect URI:** `BASE/api/integrations/microsoft/oauth/callback`.
- **API permissions → Microsoft Graph → Delegated:**
  - `openid`
  - `profile`
  - `email`
  - `offline_access`
  - `User.Read`
  - `Calendars.Read`
  - `OnlineMeetings.Read` is **not** requested (`onlineMeeting.joinUrl` comes with `Calendars.Read`), so default tenants need no admin consent.
- **Certificates & secrets → New client secret.** Record its expiry date in the ops calendar.
- **Env:** `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (fall back to `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`), `MS_TENANT` (default `organizations`; falls back to `AZURE_TENANT_ID`), optional `MS_ALLOWED_TENANTS` (comma-separated tenant ids), `MEETSUM_MS_CALENDAR_SYNC_MINUTES` (10), `MEETSUM_MS_CALENDAR_LOOKAHEAD_DAYS` (14), stretch `MS_CALENDAR_PUSH`.
- Screenshot placeholder: `docs/runbooks/img/entra-delegated-permissions.png`.

### Notion public integration

- **Where:** notion.so/my-integrations → New integration → Type **Public**.
- **OAuth domain & URIs → Redirect URIs:** `BASE/api/integrations/notion/oauth/callback`.
- **Capabilities:** Read content, Update content, Insert content. No user information is needed ("No user information").
- **API version:** `NOTION_API_VERSION` (default `2022-06-28`, database parents). The 2025 data-source API migration is deferred.
- **Env:** `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` (OAuth client ID / secret), optional `NOTION_API_VERSION`, `MEETSUM_NOTION_MAX_TRANSCRIPT_BLOCKS` (900).
- When connecting, the person picks the pages and databases the integration can see; a database must be shared with it to appear in the picker.
- Screenshot placeholder: `docs/runbooks/img/notion-capabilities.png`.

### HubSpot public app

- **Where:** developers.hubspot.com → Apps → Create app (public app).
- **Auth → Redirect URL:** `BASE/api/integrations/hubspot/oauth/callback`.
- **Required scopes:**
  - `oauth`
  - `crm.objects.contacts.read`
  - `crm.objects.contacts.write`
  - `crm.objects.deals.read`
- **Optional scopes** (`HUBSPOT_OPTIONAL_SCOPES`): `crm.objects.owners.read` (task owner mapping by email).
- **Exact scope string** MeetSum requests (`HUBSPOT_SCOPES` in `lib/integrations/hubspot/oauth.ts`): `scope=oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read` and `optional_scope=crm.objects.owners.read`. Select exactly these in the app's Auth settings (required vs optional must match, or HubSpot rejects the install).
- **Verified by Package B (2026-10-13):** the HubSpot Meetings, Notes and Tasks v3 object guides list only `crm.objects.contacts.read`/`.write` for creating engagements and their associations, so no separate meetings, notes or tasks scope is requested; deals are only read (picker and association). Re-check on the first live run: a 403 `MISSING_SCOPES` on a meeting, note or task write means HubSpot changed this, and the scope it names must be added here and in `HUBSPOT_SCOPES`.
- **Env:** `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_OPTIONAL_SCOPES`.
- **Token endpoints (verify against current HubSpot docs on the first live run):** token info (connect and "Test connection") is `POST /oauth/v3/token/introspect` and disconnect revokes with `POST /oauth/v3/token/revoke`, both form-urlencoded with `client_id`, `client_secret`, `token` and `token_type_hint`, so no token ever appears in a URL (checked 2026-10-13; HubSpot's versioned reference also lists `/oauth/2026-03/token/...`). The legacy `GET /oauth/v1/access-tokens/{token}` and `DELETE /oauth/v1/refresh-tokens/{token}` put the token in the path and are no longer called; log redaction still masks those paths. If introspect ever stops returning `hub_id`, `GET /account-info/v3/details` with a Bearer header gives the portal id.
- Screenshot placeholder: `docs/runbooks/img/hubspot-scopes.png`.

### Google OAuth client (Docs export)

The existing Google sign-in client is reused.

- **Where:** console.cloud.google.com → APIs & Services → Credentials → the existing OAuth client.
- **Authorized redirect URIs → add:** `BASE/api/integrations/google_drive/oauth/callback`.
- **APIs & Services → Library:** enable the **Google Docs API** and the **Google Drive API**.
- **OAuth consent screen → Scopes:** add `https://www.googleapis.com/auth/drive.file` (MeetSum only sees files it creates).
- **Optional DWD path** (`MEETSUM_GOOGLE_DOCS_DWD=true`): Admin console → Security → API controls → Domain-wide delegation → add `https://www.googleapis.com/auth/documents` and `https://www.googleapis.com/auth/drive.file` to the service account.
- **Env:** reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; `MEETSUM_GOOGLE_DOCS_DWD`.
- Screenshot placeholder: `docs/runbooks/img/google-docs-scopes.png`.

### Email sender

M2's sender is reused (`getEmailSender()`); nothing new to register for OAuth.

- **SMTP:** set `SMTP_*` and `MEETSUM_EMAIL_*`, or
- **Gmail DWD:** domain-wide delegation of `https://www.googleapis.com/auth/gmail.send` for `MEETSUM_EMAIL_FROM`.
- **DNS on the sender domain:** SPF, DKIM and DMARC. Gmail requires DKIM and one-click unsubscribe for bulk senders; recaps carry `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- **Env:** `MEETSUM_EMAIL_*`, `SMTP_*`, `MEETSUM_EMAIL_RECAP_MAX_RECIPIENTS` (50), `MEETSUM_EMAIL_RECAP_MAX_PER_HOUR` (200 per workspace).
- When email isn't configured, Settings → Integrations → Email recap says so and stays read-only.

### Zapier / n8n

No app to create.

1. Settings → Integrations → Webhooks: add the receiver URL (Zapier "Catch Hook", n8n Webhook node, Make custom webhook). New subscriptions use payload **v2**.
2. Copy the signing secret when it's shown (once).
3. Verify `x-meetsum-signature-v2: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>` and reject a skew over 5 minutes; dedupe by `x-meetsum-delivery`.
4. Existing v1 subscriptions keep v1 payloads until someone clicks "Upgrade to v2" (one-way).
5. Docs: `docs/api-reference.md` → "Event catalog"; templates in `docs/n8n-templates/`.

## Environment

All variables are in `.env.example` (M8 block). Never commit real values; production values live in the deployment's secret store.

| Variable | Default | Notes |
|---|---|---|
| `MEETSUM_OAUTH_REDIRECT_BASE` | `NEXT_PUBLIC_APP_URL` | Origin only; `https:` in production |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | | |
| `SLACK_SCOPES` | `chat:write,chat:write.public,channels:read` | |
| `SLACK_PRIVATE_CHANNELS` | `false` | Adds `groups:read` |
| `SLACK_COMMANDS_ENABLED`, `SLACK_SIGNING_SECRET` | `false` | Stretch |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | |
| `MS_TENANT` | `organizations` | Falls back to `AZURE_TENANT_ID` |
| `MS_ALLOWED_TENANTS` | | Optional, comma-separated tenant ids |
| `MEETSUM_MS_CALENDAR_SYNC_MINUTES` | `10` | |
| `MEETSUM_MS_CALENDAR_LOOKAHEAD_DAYS` | `14` | |
| `MS_CALENDAR_PUSH` | `false` | Stretch |
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | | |
| `NOTION_API_VERSION` | `2022-06-28` | |
| `MEETSUM_NOTION_MAX_TRANSCRIPT_BLOCKS` | `900` | |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | | |
| `HUBSPOT_OPTIONAL_SCOPES` | | e.g. `crm.objects.owners.read` |
| `MEETSUM_GOOGLE_DOCS_DWD` | `false` | Docs OAuth reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| `MEETSUM_INTEGRATION_MAX_ATTEMPTS` | `5` | |
| `MEETSUM_INTEGRATIONS_CONCURRENCY` | `4` | |
| `MEETSUM_INTEGRATION_DELIVERY_RETENTION_DAYS` | `90` | |
| `MEETSUM_EMAIL_RECAP_MAX_RECIPIENTS` | `50` | |
| `MEETSUM_EMAIL_RECAP_MAX_PER_HOUR` | `200` | Per workspace |
| `MEETSUM_INTEGRATIONS_FAKE_BASE_URL` | | Dev/e2e only, loopback only; **refused in production** (boot throws) |
| `E2E_EMAIL_CAPTURE_FILE` | | Dev/e2e only: the `log` email sender appends JSON lines |

Reused: `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` (**required in production when any integration is configured**; the boot check warns when it falls back to the session secret), `MEETSUM_DEFAULT_TIMEZONE`, `MEETSUM_EMAIL_*` / `SMTP_*` (M2), `MEETSUM_BOT_ACCOUNT_EMAIL` / `MEETSUM_BOT_INTERNAL_DOMAINS` (M7), `WEBHOOK_*` (M1).

A provider counts as configured when its client ID and secret are set; otherwise its card says "Not configured on this server" and Connect is hidden.

## Verify with fake providers

No real keys are needed. This is Acceptance 14 (`tests/e2e/m8-integrations.spec.ts`).

1. `docker compose up postgres redis`
2. `npm run db:migrate`
3. `npm run integrations:e2e-seed` (writes test session cookies and ids to `E2E_ENV_FILE`, default `.secrets/e2e.env`, gitignored; nothing is printed)
4. `npm run integrations:fake` (fake Slack, Microsoft, Notion, HubSpot and Google on `127.0.0.1:4010`, plus a webhook receiver). The spec reads the recorded, token-redacted requests with `GET /__fake/requests?provider=<id>` and clears them with `DELETE /__fake/requests`; the webhook receiver records `provider: "webhook"` with the raw body for the signature check. The fake Outlook event uses the iCalUID `e2e-m8-shared-event@meetsum.test`, the one the seed puts on a Google row.
5. Start the app and the worker with:
   - `NODE_ENV=development`
   - `MEETSUM_INTEGRATIONS_FAKE_BASE_URL=http://127.0.0.1:4010`
   - fake client ids and secrets for every provider (any non-empty value, e.g. `SLACK_CLIENT_ID=fake-slack`)
   - `MEETSUM_EMAIL_PROVIDER=log` and `E2E_EMAIL_CAPTURE_FILE=.secrets/e2e-emails.jsonl`
   - `MEETSUM_OAUTH_REDIRECT_BASE=http://localhost:3000`
   - `MEETSUM_WEBHOOK_ALLOWED_HOSTS=127.0.0.1` (the fake webhook receiver, `POST http://127.0.0.1:4010/__fake/webhook`, is loopback; the SSRF guard refuses it otherwise)
   - `MEETSUM_MS_CALENDAR_SYNC_MINUTES=1` (the Outlook sync runs every minute, so step 6 sees the fake Teams event quickly)
6. `E2E_BASE_URL=http://localhost:3000 npm run test:e2e -- m8`
7. `npm run integrations:e2e-seed -- --complete <meetingId>` runs the real dispatch path for a seeded meeting without ASR (the spec calls it itself; it is also useful by hand).

The page shows a "Test providers" banner whenever the fake base URL is set. If Playwright browsers can't be installed on the host, run the same 13 steps by hand in a browser and attach he/en screenshots to the PR.

## First live run

Run each one in a test workspace with a Hebrew sample meeting (a summary, two action items, one decision). Each run ends by disconnecting and confirming the revocation.

### Slack

1. Settings → Integrations → Slack → Connect; approve in Slack. The card shows the Slack workspace name and no pill.
2. Test connection → "The connection works."
3. Set a default channel; from the sample meeting ⋯ → Send to → Slack.
4. In Slack: every line reads right-to-left (RLM-prefixed), the "פתיחה ב-MeetSum" button opens the meeting, nothing pings `@channel`.
5. Send again within 24 h: the same message is updated, not duplicated.
6. Disconnect: the dependent rules show "Off: the connection was disconnected"; in Slack, the app's token is revoked (Settings → Manage apps).

### Microsoft Outlook

1. As a member: Your connections → Microsoft Outlook → Connect; consent without an admin prompt.
2. Turn on "Sync my Outlook calendar"; wait one sync interval (or trigger `calendarSync`).
3. An Outlook event with a Teams link appears as a scheduled meeting and follows the bot rules; an event that is also on a synced Google calendar is not duplicated.
4. A private or confidential Outlook event creates a private meeting.
5. Disconnect; remove the app from myapps.microsoft.com if it should be fully revoked (Microsoft has no revoke API).

### Notion

1. Connect; share the target database with the integration during consent.
2. Pick it as the default database; Send to → Notion from the sample meeting.
3. **RTL check (required on the first live run; Notion has no paragraph direction, so this is empirical).** Open the page in the Notion web app, the desktop app and the mobile app. Pass when every Hebrew heading, paragraph, bullet and to-do starts on the right (MeetSum starts each RTL line with Hebrew or an RLM), English names and dates inside a Hebrew line stay in order, transcript timecodes sit at the end of the line, and an English meeting stays left-to-right. Record pass/fail, the date and the Notion API version (`2022-06-28`) in `docs/parity/STATUS.md` and in the comment at the top of `lib/integrations/notion/blocks.ts`. On a fail, keep Notion rules off for Hebrew meetings and file an issue with screenshots.
4. Send again: the same page is updated (old blocks archived), not a new page.
5. Disconnect; remove the integration in Notion → Settings → Connections (Notion has no revoke API).

### HubSpot

1. Connect; Test connection.
2. Create a contact with a participant's email and a deal; Send to → HubSpot with that deal.
3. In HubSpot: a meeting (or note) on the contact and deal, Hebrew body right-to-left, tasks for open action items with owners matched by email.
4. Send again: the engagement is updated and no task is duplicated.
5. Disconnect: the refresh token is revoked (connected apps no longer list MeetSum).

### Google Docs

1. Your connections → Google Drive → Connect (consent shows only "files created by this app").
2. From the meeting export menu → Google Docs: the document opens with right-to-left Hebrew paragraphs and bullets.
3. Export again: the same document is replaced; "new document" forces a copy.
4. Disconnect: the token is revoked at `oauth2.googleapis.com/revoke`.

### Email recap

1. Email recap → "Only for meetings where it's turned on", recipients "Workspace members…", language "The meeting's language".
2. In the sample meeting ⋯ → Email recap → "On for this meeting"; complete the meeting.
3. The received email: subject `סיכום פגישה: …`, right-to-left body, an unsubscribe link and the one-click header.
4. Open the unsubscribe link: GET shows a confirmation page; confirm; the next recap skips that address.
5. Switch the mode back to Off.

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| Toast "This integration isn't configured on this server." (`integration_error=not_configured`) | Client id or secret missing, or `MEETSUM_OAUTH_REDIRECT_BASE` isn't a valid origin (`https:` in production) | Set the env vars and restart |
| Provider says "redirect_uri mismatch" | The registered URI differs from `BASE/api/integrations/<provider>/oauth/callback` | Register the exact URI from "Redirect URIs" |
| `integration_error=expired_state` / `invalid_state` | Consent took over 10 minutes, or cookies were blocked / another tab reused the link | Connect again from the same browser |
| `integration_error=forbidden` | The user lost the permission (or was removed) between start and callback | Workspace providers need an admin |
| `integration_error=tenant_not_allowed` | The Microsoft tenant isn't in `MS_ALLOWED_TENANTS` | Add the tenant id or clear the allowlist |
| `integration_error=cap_reached` | 20 connections per workspace | Disconnect unused ones |
| Card pill "Needs reconnecting" | Refresh failed (`invalid_grant`, revoked in the provider) | Reconnect; dependent deliveries can be retried from the delivery log |
| Delivery "Skipped: Private meeting…" | The meeting is private and its owner hasn't opted in | Expected; the owner can allow it from the meeting ⋯ menu |
| Delivery "Hourly email limit reached" | `MEETSUM_EMAIL_RECAP_MAX_PER_HOUR` hit | It resumes next hour; raise the cap if needed |
| Slack "not in channel" in the delivery log | Private channel without the app, or `chat:write.public` removed | Invite the app to the channel |
| Notion database missing from the picker | Not shared with the integration | Share it in Notion (⋯ → Connections) |
