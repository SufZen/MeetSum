/**
 * Pure live-transcript draft state (M7 B8/C3, flag only): segments are
 * upserted by id, ordered by start, and get `dir` from the segment language
 * (falling back to the meeting language).
 */
import type { BotLiveSegmentEvent } from "@/lib/bot/api-types"

export const LIVE_SEGMENT_LIMIT = 400

export function upsertLiveSegment(
  segments: readonly BotLiveSegmentEvent[],
  segment: BotLiveSegmentEvent
): BotLiveSegmentEvent[] {
  const next = segments.filter((existing) => existing.id !== segment.id)

  next.push(segment)
  next.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))

  return next.length > LIVE_SEGMENT_LIMIT ? next.slice(next.length - LIVE_SEGMENT_LIMIT) : next
}

const RTL_LANGUAGES = new Set(["he", "iw", "ar", "fa", "ur", "yi"])

/** `dir` from the language we know; `auto` only when neither is known. */
export function liveSegmentDir(
  segmentLanguage: string | null | undefined,
  meetingLanguage: string | null | undefined
): "rtl" | "ltr" | "auto" {
  for (const language of [segmentLanguage, meetingLanguage]) {
    const code = language?.trim().toLowerCase().split(/[-_]/)[0]

    if (!code || code === "mixed" || code === "auto") continue

    return RTL_LANGUAGES.has(code) ? "rtl" : "ltr"
  }

  return "auto"
}

export function parseLiveEvent<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T
  } catch {
    return undefined
  }
}
