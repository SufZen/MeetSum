import type { MeetingRecord } from "@/lib/meetings/repository"

type DurationSource = Pick<
  MeetingRecord,
  "mediaAssets" | "transcript" | "meetConferenceRecords"
>

export const UNKNOWN_DURATION_LABEL = "—"

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function mediaDurationMs(meeting: DurationSource): number | undefined {
  let longest: number | undefined

  for (const asset of meeting.mediaAssets ?? []) {
    const metadata = asset.metadata ?? {}
    const fromMs = positiveNumber(metadata.durationMs)
    const fromSeconds = positiveNumber(metadata.durationSeconds)
    const candidate = fromMs ?? (fromSeconds ? fromSeconds * 1000 : undefined)

    if (candidate && (!longest || candidate > longest)) {
      longest = candidate
    }
  }

  return longest
}

function transcriptDurationMs(meeting: DurationSource): number | undefined {
  let end: number | undefined

  for (const segment of meeting.transcript ?? []) {
    const candidate = positiveNumber(segment.endMs)

    if (candidate && (!end || candidate > end)) {
      end = candidate
    }
  }

  return end
}

function conferenceDurationMs(meeting: DurationSource): number | undefined {
  let longest: number | undefined

  for (const record of meeting.meetConferenceRecords ?? []) {
    if (!record.startTime || !record.endTime) continue

    const candidate = positiveNumber(
      new Date(record.endTime).getTime() - new Date(record.startTime).getTime()
    )

    if (candidate && (!longest || candidate > longest)) {
      longest = candidate
    }
  }

  return longest
}

/**
 * Real meeting duration in milliseconds, or undefined when unknown.
 * Preference order: recorded media metadata, transcript end, Google Meet
 * conference start/end. Never invents a value.
 */
export function getMeetingDurationMs(meeting: DurationSource): number | undefined {
  return (
    mediaDurationMs(meeting) ??
    transcriptDurationMs(meeting) ??
    conferenceDurationMs(meeting)
  )
}

/** Human duration such as "45m", "1h 02m", "<1m"; "—" when unknown. */
export function formatDurationLabel(durationMs: number | undefined): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return UNKNOWN_DURATION_LABEL
  }

  const minutes = Math.round(durationMs / 60000)

  if (minutes < 1) return "<1m"

  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
    : `${minutes}m`
}

export function meetingDurationLabel(meeting: DurationSource): string {
  return formatDurationLabel(getMeetingDurationMs(meeting))
}

/** Playback timestamp: "m:ss" below one hour, "h:mm:ss" from one hour. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`
}
