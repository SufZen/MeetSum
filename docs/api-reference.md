# MeetSum API Reference — v0.3.0

All endpoints require authentication via Bearer token (API key or session cookie).

## Health

### `GET /api/health`
Returns system health status. **No auth required.**

```json
{
  "app": "meetsum",
  "version": "0.3.0",
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
{ "url": "https://example.com/webhook", "events": ["meeting.completed"], "secret": "..." }
```

### `PATCH /api/webhooks/subscriptions/:id`
Update subscription. Body: `{ enabled?, events? }`.

### `GET /api/webhooks/deliveries`
List webhook deliveries. Query: `subscriptionId`, `limit`.

### `POST /api/webhooks/deliveries/:id/retry`
Retry a failed delivery.

### `POST /api/webhooks/test`
Send a test webhook event.

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
