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

export type PlatformEvent<TData extends Record<string, unknown>> = {
  id: string
  name: PlatformEventName
  occurredAt: string
  /** Workspace the event belongs to (M2); part of the signed envelope. */
  workspace_id?: string
  data: TData
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
