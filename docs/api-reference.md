# MeetSum API Reference — v0.6.0

All endpoints require authentication via Bearer token (API key or session cookie).

## Health

### `GET /api/health`
Returns system health status. **No auth required.**

```json
{
  "app": "meetsum",
  "version": "0.6.0",
  "uptimeSeconds": 1234,
  "services": { "database": "ok", "redis": "configured", "storage": "configured" }
}
```

---

## Meetings

### `GET /api/meetings`
List meetings. Query: `limit` (default 20).

### `GET /api/meetings/:id`
Get a single meeting with full detail.

### `POST /api/meetings`
Create a meeting. Body: `{ title, source, language?, participants? }`.

### `POST /api/meetings/:id/upload`
Upload media for an existing meeting. Use multipart form data:
- `file` — audio/video file.
- `transcript` — optional JSON array of `{ text, speaker?, startMs, endMs, confidence?, language? }`.
- `captureMetadata` — optional JSON object for desktop companion details such as `captureId`, app version, platform, device names, sample rate, duration, local transcription provider/model, and upload status.

When transcript segments are supplied, MeetSum stores them and queues summary generation without retranscribing the media.

### `POST /api/desktop-capture/ingest`
Create a `desktop_recorder` meeting from a desktop companion upload. Use multipart form data:
- `meeting` — JSON `{ title, startedAt, endedAt?, participants?, language? }`.
- `file` — optional audio/video file.
- `transcript` — optional JSON transcript segment array.
- `captureMetadata` — optional desktop capture metadata.

At least one of `file` or `transcript` is required. Media-only uploads queue `media.ingest`; transcript-bearing uploads queue `meeting.summarize`.
Use a stable `captureMetadata.captureId` when retrying spooled uploads so MeetSum can reuse an existing desktop media asset instead of storing a duplicate.

### `DELETE /api/meetings/:id`
Delete a meeting.

### `GET /api/meetings/search`
Search meetings. Query params:
- `q` — Full-text search (title, participants, overview)
- `tag` — Filter by tag
- `status` — Filter by status
- `source` — Filter by source
- `limit` — Max results (default 20, max 100)

**Rate limit:** 120 req/min

### `GET /api/meetings/timeline`
Calendar-style meeting aggregation. Query params:
- `from` — ISO date (default: 30 days ago)
- `to` — ISO date (default: now)
- `roomId` — Filter by room
- `groupBy` — `day` | `week` | `month` (default: day)

Returns `{ stats, timeline: [{ period, meetingCount, meetings }] }`.

**Rate limit:** 120 req/min

---

## Speakers

### `GET /api/meetings/:id/speakers`
List unique speaker labels with segment counts.

```json
{
  "speakers": [{ "label": "Speaker 1", "segmentCount": 42 }],
  "participants": ["Alice", "Bob"]
}
```

### `POST /api/meetings/:id/speakers`
Assign speaker labels to person names.

```json
// Request
{ "mappings": [{ "speaker": "Speaker 1", "person": "Alice" }] }

// Response
{ "mappingsApplied": 1, "segmentsUpdated": 42, "totalSegments": 85 }
```

**Rate limit:** 120 req/min

---

## Export

### `POST /api/meetings/:id/export/markdown`
Export as Markdown. **Rate limit:** 20 req/min.

### `POST /api/meetings/:id/export/pdf`
Export as PDF. **Rate limit:** 20 req/min.

### `POST /api/meetings/:id/export/docx`
Export as DOCX (Word). Returns `.docx` file download. **Rate limit:** 20 req/min.

### `POST /api/meetings/:id/export/notion`
Create (or update in place) the meeting's page in a Notion database through the workspace's **Notion OAuth connection** (Settings → Integrations; an admin connects it). Body: `{ databaseId? }`; without it the connection's default database is used. **No token goes in the body**: a body with `token` is refused (400 `token_not_accepted`), and there is no server-wide `NOTION_TOKEN` fallback. Requires `meeting:write`; the meeting must be visible (else 404) and a private meeting also needs `canManageMeeting`. Optional `Idempotency-Key` header (a replayed key returns the same page).

The same checks as `POST /api/meetings/:id/integrations/send` apply:
- no active Notion connection → 409 `notion_not_connected`;
- `allowManualSend: false` on the connection → 403 `manual_send_disabled`;
- a private meeting needs its owner's per-meeting opt-in → 403 `private_meeting_not_opted_in`;
- a client-supplied `databaseId` is checked with Notion first → 400 `invalid_destination`.

Response: `{ deliveryId, pageId, url, updated }`. Re-exporting updates the tracked page (old blocks are archived). Notion's error text is never reflected (`notion_not_found`, `notion_rate_limited` with `Retry-After`, …). **Rate limit:** 20 req/min.

### `POST /api/meetings/:id/export/google-docs`
Create (or update in place) a Google Doc of the recap in the requester's own Drive, with RTL Hebrew paragraphs. Body: `{ includeTranscript? }`; `?new=1` forces a new document. Requires `meeting:read` and a visible meeting (else 404). Auth, in order: the requester's personal Google Drive connection (OAuth with PKCE, `drive.file` only), then service-account domain-wide delegation when `MEETSUM_GOOGLE_DOCS_DWD=true` and the requester's domain matches the workspace subject's; otherwise 409 `google_docs_not_connected` with a `connectUrl`. A private meeting needs its owner's per-meeting opt-in (403 `private_meeting_not_opted_in`), and a connection with `allowManualSend: false` is refused (403 `manual_send_disabled`). Response: `{ documentId, url, updated }`. Google's error text is never reflected. **Rate limit:** 20 req/min.

---

## Rooms

### `GET /api/rooms`
List all rooms with meeting counts.

### `GET /api/rooms/:id`
Room detail with stats, meetings, tasks, participants, and artifacts.

### `POST /api/rooms`
Create a room. Body: `{ name, description? }`.

### `GET /api/rooms/suggestions`
Suggest room groupings from meeting title patterns and tags.

### `POST /api/rooms/:id/ask`
Ask a question scoped to a room's meetings. **Rate limit:** 30 req/min.

---

## Memory

### `POST /api/memory/ask`
Ask a question across all indexed meetings. **Rate limit:** 30 req/min.

```json
// Request
{ "question": "What was decided about the Q3 roadmap?" }

// Response
{ "answer": "...", "sources": [{ "meetingId": "...", "title": "..." }] }
```

---

## Share

### `POST /api/meetings/:id/share`
Create or get a share link. Body: `{ includedSections?, expiresAt?, password? }`.

### `PATCH /api/meetings/:id/share`
Update share settings. Body: `{ revoked?, regenerate?, includedSections? }`.

### `GET /share/:token`
Public share page (no auth required). Returns rendered meeting summary.

---

## Admin

### `GET /api/admin/operations`
Operational dashboard metrics: jobs, meetings, sync, storage, AI, audit.

### `GET /api/admin/webhooks/stats`
Webhook system health: subscription counts, delivery rates, event breakdowns.

### `GET /api/admin/api-keys`
List all API keys (masked). Shows prefix, label, dates.

### `POST /api/admin/api-keys`
Create a new API key. Body: `{ label?, expiresAt? }`.

**Response includes raw key (shown once):**
```json
{
  "key": "ms_a1b2c3d4e5f6...",
  "record": { "id": "api_key_...", "keyPrefix": "ms_a1b2c3d4", "label": "CI/CD" }
}
```

### `DELETE /api/admin/api-keys/:id`
Revoke an API key.

### `GET /api/settings`
Get app settings (summary template, AI config).

### `PATCH /api/settings`
Update app settings.

---

## Webhooks

### `GET /api/webhooks/subscriptions`
List webhook subscriptions. **Rate limit:** 30 req/min.

### `POST /api/webhooks/subscriptions`
Create webhook subscription. **Rate limit:** 30 req/min.

```json
{ "url": "https://example.com/webhook", "events": ["meeting.completed"], "secret": "optional, >= 16 chars", "payloadVersion": 2 }
```

`payloadVersion` is `1` or `2` (default `2`; see [Payload versions](#payload-versions)). Existing v1 subscriptions keep their frozen v1 payloads until they are upgraded. The settings UI creates v2 subscriptions and lists events from `GET /api/webhooks/catalog`.

The URL must be `https` (plain `http` only outside production or for allowlisted hosts) and must not resolve to a private, loopback, link-local or otherwise reserved address; `MEETSUM_WEBHOOK_ALLOWED_HOSTS` (hosts, `*.suffix`, CIDRs) allowlists internal receivers. Without `secret`, a `whsec_…` secret is generated. The response contains `secret` **once**; it is stored encrypted and never returned again.

Deliveries are signed with that secret (`x-meetsum-signature`, HMAC-SHA256 hex of the JSON body) and carry `x-meetsum-event` and `x-meetsum-delivery`. Redirects are not followed.

**Private meetings.** Meeting events (`summary.created`, `action_item.created`, `meeting.completed`, `meeting.process_failed`) for a meeting whose visibility is `private` carry a minimal payload, because webhook subscribers (admins) must not read private meetings:

```json
{ "meetingId": "meet_…", "workspace_id": "ws_…", "visibility": "private" }
```

Only non-content identifiers are kept (`actionItemId`, `clipId`, `suggestionId`, `jobId`, `jobName`, `attempts`, `permanent`, `mode` where the event has them; one list for v1 and v2); `title`, `tags`, action item text/owner/priority and error text are omitted. `workspace` and `link` meetings receive the full payload. A meeting whose visibility cannot be read is treated as private.

### `PATCH /api/webhooks/subscriptions/:id`
Update subscription. Body: `{ url?, enabled?, events?, rotateSecret?, payloadVersion? }`. With `rotateSecret: true` the response includes the new `secret` once. `payloadVersion: 2` upgrades a v1 subscription (one-way).

### `GET /api/webhooks/catalog`
The event catalog `{ version, events: [{ name, versions, description, example, schemaUrl }] }` (`webhooks:manage`).

### `DELETE /api/webhooks/subscriptions/:id`
Delete a subscription and its delivery history.

### `GET /api/webhooks/deliveries`
List webhook deliveries. Query: `subscriptionId`, `limit`. Statuses: `queued`, `active`, `retrying`, `sent`, `failed`, `cancelled`.

### `POST /api/webhooks/deliveries/:id/retry`
Re-queue a failed or cancelled delivery. **Rate limit:** 30 req/min, plus 3 req/min per delivery. A delivery has a lifetime cap of `MEETSUM_WEBHOOK_MAX_TOTAL_ATTEMPTS` (20) attempts.

### `POST /api/webhooks/test`
Send a test webhook event. Body: `{ subscriptionId }` (signed with that subscription's secret) or `{ url }` (ad-hoc URL, signed with a fresh throwaway secret returned once as `secret` in the response; the global `WEBHOOK_SIGNING_SECRET` is never used for ad-hoc URLs).

---

## Event catalog

Webhooks for Zapier, n8n, Make or your own receiver (M8). The machine-readable catalog is `GET /api/webhooks/catalog` (`webhooks:manage`): `{ version: 2, events: [{ name, versions, description, example, schemaUrl }] }`. JSON Schemas (draft 2020-12) for every v2 event live in [`docs/webhooks/schemas/v2/`](webhooks/schemas/v2/) and are regenerated with `npm run webhooks:schemas`.

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

`clip.created` follows the clip's meeting. v2 payloads re-read the meeting right before they are built, so a visibility change made during processing is honoured.

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

---

## Rate Limits

| Preset | Limit | Applies To |
|--------|-------|------------|
| `share` | 30 req/min | memory/ask, rooms/:id/ask |
| `exports` | 20 req/min | markdown, pdf, docx exports |
| `admin` | 30 req/min | admin endpoints, webhooks |
| `api` | 120 req/min | meetings, speakers, timeline, search |

**Headers returned:**
- `X-RateLimit-Limit` — Window max
- `X-RateLimit-Remaining` — Remaining in window
- `X-RateLimit-Reset` — Window reset timestamp

**Client identification:** limits are keyed by client IP. With `MEETSUM_TRUSTED_PROXY_HOPS=N` (default `1`), the client is the Nth `X-Forwarded-For` entry from the right (left entries are client-supplied and ignored); `X-Real-IP` is the fallback. Set `MEETSUM_CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) only if your edge proxy overwrites that header. Values that are not valid IPs are ignored. The app port must not be reachable except through the trusted proxy (production binds it to `127.0.0.1`).

**Bypass:** Set `MEETSUM_RATE_LIMIT=false` in environment.

---

## Authentication

### Bearer Token
```
Authorization: Bearer ms_a1b2c3d4e5f6...
```

API keys can be created via the admin API or configured via environment variables:
- `MEETSUM_API_KEYS` — Comma-separated raw keys (hashed at runtime)
- `MEETSUM_API_KEY_HASHES` — Comma-separated pre-hashed keys (`sha256:...`)
