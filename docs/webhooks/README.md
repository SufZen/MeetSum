# MeetSum webhooks

The webhook event catalog (M8) for Zapier, n8n, Make and custom receivers.

- **Reference:** [API reference → Event catalog](../api-reference.md#event-catalog): payload versions, events, headers, signature verification (Node, Python, n8n), retries, the private-meeting table, example payloads and a Zapier "Catch Hook" recipe.
- **Live catalog:** `GET /api/webhooks/catalog` (`webhooks:manage`) returns every event with its versions, description, a schema-valid example and its schema path.
- **JSON Schemas:** [`schemas/v2/`](schemas/v2/), one file per event (envelope + data, draft 2020-12). Generated from `lib/platform/event-schemas.ts` with `npm run webhooks:schemas`; a test fails when they are stale.
- **n8n templates:** [`../n8n-templates/`](../n8n-templates/). Every webhook template verifies `x-meetsum-signature-v2` in a Code node before it acts.

## In one minute

1. Create a subscription (payload v2 is the default) and store the secret: it is shown once.
2. On every request, verify `x-meetsum-signature-v2: t=<unix>,v1=<hex>` where `hex = HMAC-SHA256(secret, t + "." + rawBody)`, compare in constant time, and reject a `t` more than 5 minutes from your clock.
3. Answer 2xx quickly. Deliveries are at-least-once and unordered: deduplicate on `x-meetsum-delivery` or the envelope `id`.
4. Private meetings arrive with identifiers only (`visibility: "private"`); fetch details through the API with a key that can see them, or ignore them.
