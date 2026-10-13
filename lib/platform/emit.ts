/**
 * Platform event emitter for events outside the processing pipeline
 * (docs/parity/m8.md, Step 0 items 7–8): `action_item.updated`,
 * `clip.created`, `bot.status_changed`. Owner: Package C, which makes it
 * deliver v2 webhooks (visibility-aware payloads; private meetings stay
 * minimal through `platformEventData`).
 *
 * Step 0: a no-op that never throws, so the call sites cannot fail a request.
 */
import type { MeetingRepository } from "@/lib/meetings/repository"
import type { PlatformEventName } from "@/lib/platform/events"

export type PlatformEventScope = {
  workspaceId: string
  /** Scoped repository, used to re-read the meeting's visibility. */
  repo?: MeetingRepository
}

export async function emitPlatformEvent(
  scope: PlatformEventScope,
  name: PlatformEventName,
  data: Record<string, unknown>
): Promise<void> {
  void scope
  void name
  void data
}
