/**
 * Player time formatting (M4, client-safe, pure).
 *
 * Clock strings are Western digits for `<time dir="ltr">`; spoken strings are
 * for `aria-valuetext` and live-region announcements. The meeting-level
 * duration label mirrors Package B's `formatDurationLabel(ms, locale)` so the
 * client can show real durations before that lands; integration may point
 * these at `lib/meetings/duration.ts`.
 */
import { getMeetingDurationMs, UNKNOWN_DURATION_LABEL } from "@/lib/meetings/duration"
import type { MeetingRecord } from "@/lib/meetings/repository"

/** "m:ss" below an hour, "h:mm:ss" from one hour. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`
}

type Unit = "hour" | "minute" | "second"

const HEBREW_UNITS: Record<Unit, [string, string]> = {
  hour: ["שעה", "שעות"],
  minute: ["דקה", "דקות"],
  second: ["שנייה", "שניות"],
}

const ENGLISH_UNITS: Record<Unit, [string, string]> = {
  hour: ["hour", "hours"],
  minute: ["minute", "minutes"],
  second: ["second", "seconds"],
}

/**
 * Spoken duration: he "12 דקות ו־34 שניות", en "12 minutes 34 seconds".
 * Zero components are dropped (except a lone "0 seconds").
 */
export function formatSpokenTime(ms: number, locale: string): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const parts: [Unit, number][] = [
    ["hour", Math.floor(totalSeconds / 3600)],
    ["minute", Math.floor((totalSeconds % 3600) / 60)],
    ["second", totalSeconds % 60],
  ]
  const present = parts.filter(([, value]) => value > 0)
  const items = present.length ? present : [["second", 0] as [Unit, number]]
  const hebrew = locale.startsWith("he")
  const units = hebrew ? HEBREW_UNITS : ENGLISH_UNITS
  const words = items.map(([unit, value]) => `${value} ${units[unit][value === 1 ? 0 : 1]}`)

  if (!hebrew) return words.join(" ")
  if (words.length === 1) return words[0]

  // Hebrew joins the last item with the conjunction vav + maqaf ("ו־").
  return `${words.slice(0, -1).join(", ")} ו־${words.at(-1)}`
}

/** Real meeting duration (denormalized column first), or undefined. */
export function meetingDurationMs(
  meeting: Pick<MeetingRecord, "durationMs" | "mediaAssets" | "transcript" | "meetConferenceRecords">
): number | undefined {
  if (typeof meeting.durationMs === "number" && meeting.durationMs > 0) return meeting.durationMs

  return getMeetingDurationMs(meeting)
}

/** Compact duration: he "1 שע׳ 02 דק׳" / "45 דק׳", en "1h 02m" / "45m"; "—" when unknown. */
export function formatDurationShort(ms: number | undefined, locale: string): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return UNKNOWN_DURATION_LABEL

  const minutes = Math.round(ms / 60000)
  const hebrew = locale.startsWith("he")

  if (minutes < 1) return hebrew ? "פחות מדקה" : "<1m"

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  if (hebrew) {
    return hours ? `${hours} שע׳ ${String(rest).padStart(2, "0")} דק׳` : `${minutes} דק׳`
  }

  return hours ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${minutes}m`
}
