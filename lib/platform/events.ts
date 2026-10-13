import { createHmac, timingSafeEqual } from "node:crypto"

export type PlatformEventName =
  | "google.calendar.event_changed"
  | "google.gmail.thread_matched"
  | "google.drive.recording_found"
  | "meeting.created"
  | "meeting.completed"
  | "meeting.process_failed"
  | "summary.created"
  | "action_item.created"
  | "agent.triggered"
  | "realizeos.export.sent"
  | "realizeos.export.failed"
  // M8 catalog v2 (lib/platform/event-catalog.ts).
  | "action_item.updated"
  | "clip.created"
  | "bot.status_changed"
  | "integration.delivery.failed"

export type PlatformEvent<TData extends Record<string, unknown>> = {
  id: string
  name: PlatformEventName
  occurredAt: string
  /** Workspace the event belongs to (M2); part of the signed envelope. */
  workspace_id?: string
  data: TData
  /** Only on test-fire deliveries (`POST /api/webhooks/test`, M8). */
  test?: true
}

export function createPlatformEvent<TData extends Record<string, unknown>>(
  name: PlatformEventName,
  data: TData,
  options: { workspaceId?: string } = {},
): PlatformEvent<TData> {
  return {
    id: `evt_${crypto.randomUUID()}`,
    name,
    occurredAt: new Date().toISOString(),
    ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
    data,
  }
}

export function signWebhookPayload(
  event: PlatformEvent<Record<string, unknown>>,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(event))
    .digest("hex")
}

export function verifyWebhookSignature(
  event: PlatformEvent<Record<string, unknown>>,
  signature: string,
  secret: string,
): boolean {
  const expected = signWebhookPayload(event, secret)
  const expectedBuffer = Buffer.from(expected, "hex")
  const actualBuffer = Buffer.from(signature, "hex")

  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  )
}

// ---------------------------------------------------------------------------
// M8 C4: catalog v2 envelope and the timestamped signature.

/** The v2 webhook envelope: `{id, name, version: 2, occurredAt, workspace_id, data}`. */
export type PlatformEventV2<TData extends Record<string, unknown>> = {
  id: string
  name: PlatformEventName
  version: 2
  occurredAt: string
  workspace_id: string
  data: TData
  /** Only on test-fire deliveries (`POST /api/webhooks/test`). */
  test?: true
}

/** A v1 event re-shaped as a v2 envelope with the v2 data (same id and time). */
export function toPlatformEventV2<TData extends Record<string, unknown>>(
  event: Pick<PlatformEvent<Record<string, unknown>>, "id" | "name" | "occurredAt">,
  workspaceId: string,
  data: TData
): PlatformEventV2<TData> {
  return {
    id: event.id,
    name: event.name,
    version: 2,
    occurredAt: event.occurredAt,
    workspace_id: workspaceId,
    data,
  }
}

/** Receivers should reject a v2 signature older or newer than this. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300

/** Lower-case hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`). */
export function computeWebhookSignatureV2(rawBody: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
}

/**
 * `x-meetsum-signature-v2` value: `t=<unix seconds>,v1=<hex>`. The timestamp
 * is part of the signed string, so a captured delivery cannot be replayed
 * outside the receiver's tolerance window.
 */
export function signWebhookPayloadV2(
  rawBody: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): { timestamp: number; header: string } {
  return {
    timestamp,
    header: `t=${timestamp},v1=${computeWebhookSignatureV2(rawBody, secret, timestamp)}`,
  }
}

export type WebhookSignatureV2Check =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "malformed" | "mismatch" | "skew" }

/**
 * Verifies an `x-meetsum-signature-v2` header against the raw request body:
 * any `v1=` entry may match (timing-safe), and the timestamp must be within
 * `toleranceSeconds` of `now` in either direction.
 */
export function verifyWebhookSignatureV2(
  header: string | null | undefined,
  rawBody: string,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {}
): WebhookSignatureV2Check {
  if (!header) return { ok: false, reason: "malformed" }

  let timestamp: number | undefined
  const signatures: string[] = []

  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2)

    if (key === "t" && value && /^\d{1,12}$/.test(value)) timestamp = Number(value)
    if (key === "v1" && value && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase())
  }

  if (timestamp === undefined || !signatures.length) return { ok: false, reason: "malformed" }

  const now = options.now ?? Math.floor(Date.now() / 1000)
  const tolerance = options.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS

  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "skew" }

  const expected = Buffer.from(computeWebhookSignatureV2(rawBody, secret, timestamp), "hex")
  const matches = signatures.some((signature) => {
    const actual = Buffer.from(signature, "hex")

    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })

  return matches ? { ok: true, timestamp } : { ok: false, reason: "mismatch" }
}
