import type { CaptureAdapter, CaptureEvent } from "@/lib/capture/types"

const adapters = new Map<string, CaptureAdapter>()

/**
 * Register a capture adapter for a platform.
 * Called at startup for each configured platform.
 */
export function registerCaptureAdapter(adapter: CaptureAdapter) {
  adapters.set(adapter.platform, adapter)
}

/**
 * Get a capture adapter by platform name.
 */
export function getCaptureAdapter(platform: string): CaptureAdapter | undefined {
  return adapters.get(platform)
}

/**
 * List all registered capture adapters.
 */
export function listCaptureAdapters(): CaptureAdapter[] {
  return [...adapters.values()]
}

/**
 * List platform names of all registered adapters.
 */
export function listCapturePlatforms(): string[] {
  return [...adapters.keys()]
}

/**
 * Parses every relevant event of a webhook payload, falling back to the
 * single-event `parseEvent` for adapters that don't batch.
 */
export function parseCaptureEvents(
  adapter: CaptureAdapter,
  body: unknown
): CaptureEvent[] {
  if (adapter.parseEvents) return adapter.parseEvents(body)

  const event = adapter.parseEvent(body)

  return event ? [event] : []
}
