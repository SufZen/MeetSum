/**
 * Where a finished browser recording goes (M9 follow-up).
 *
 * Only an explicit "record into this meeting" action (the bot status strip)
 * sets `meetingId`. The "New recording" entry points (the top-bar recorder
 * sheet and the PWA `?record=1` shortcut) never do, so their recording
 * creates a new meeting: through the offline queue's idempotent ingest when
 * the recording was queued, else by a direct upload to a new meeting. The
 * meeting that happens to be selected is never a target.
 */
import type { RecordingMeta } from "@/components/bot/use-browser-recorder"

export type RecordingPlan =
  | { kind: "meeting"; meetingId: string }
  | { kind: "queue" }
  | { kind: "new-meeting" }

export function planBrowserRecording(meta: RecordingMeta): RecordingPlan {
  if (meta.meetingId) return { kind: "meeting", meetingId: meta.meetingId }

  return meta.captureId ? { kind: "queue" } : { kind: "new-meeting" }
}

/**
 * The text a failed upload toast shows: our own (already localized) errors
 * pass through; a raw network failure ("Failed to fetch", a ChunkLoadError)
 * becomes the localized offline message, anything else the fallback.
 */
export class LocalizedError extends Error {
  readonly localized = true
}

export function uploadErrorText(
  error: unknown,
  texts: { offline: string; fallback: string },
  online: boolean = typeof navigator === "undefined" ? true : navigator.onLine !== false
): string {
  if (error instanceof LocalizedError) return error.message

  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : ""
  const network =
    !online ||
    name === "ChunkLoadError" ||
    (error instanceof TypeError && /fetch|network|load failed/i.test(message))

  return network ? texts.offline : texts.fallback
}
