/**
 * Platform event payload builders (docs/parity/m8.md, C4). Owner: Package
 * C, which builds the v2 catalog payloads here. Step 0: returns today's
 * payload unchanged, so v1 webhook deliveries are byte-for-byte the same.
 */
import type { PlatformEventName } from "@/lib/platform/events"

export function platformEventPayload(
  name: PlatformEventName,
  data: Record<string, unknown>
): Record<string, unknown> {
  void name

  return data
}
