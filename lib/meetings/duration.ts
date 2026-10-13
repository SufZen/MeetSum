import type { MeetingRecord } from "@/lib/meetings/repository"

type DurationSource = Partial<
  Pick<MeetingRecord, "durationMs" | "mediaAssets" | "transcript" | "meetConferenceRecords">
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
    const fromColumn = positiveNumber(asset.durationMs)
    const fromMs = positiveNumber(metadata.durationMs)
    const fromSeconds = positiveNumber(metadata.durationSeconds)
    const candidate = fromColumn ?? fromMs ?? (fromSeconds ? fromSeconds * 1000 : undefined)

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
 * Preference order: the denormalized `meetings.duration_ms` (M4), probed
 * media duration / media metadata, transcript end, Google Meet conference
 * start/end. Never invents a value.
 */
export function getMeetingDurationMs(meeting: DurationSource): number | undefined {
  return (
    positiveNumber(meeting.durationMs) ??
    mediaDurationMs(meeting) ??
    transcriptDurationMs(meeting) ??
    conferenceDurationMs(meeting)
  )
}

function isHebrew(locale: string | undefined): boolean {
  return Boolean(locale && /^(he|iw)(-|$)/i.test(locale))
}

/**
 * Compact duration label; "—" when unknown. English: "45m", "1h 02m",
 * "<1m". Hebrew: "45 דק׳", "1 שע׳ 02 דק׳", "פחות מדקה".
 */
export function formatDurationLabel(durationMs: number | undefined, locale = "en"): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return UNKNOWN_DURATION_LABEL
  }

  const minutes = Math.round(durationMs / 60000)
  const hebrew = isHebrew(locale)

  if (minutes < 1) return hebrew ? "פחות מדקה" : "<1m"

  const hours = Math.floor(minutes / 60)
  const rest = String(minutes % 60).padStart(2, "0")

  if (hebrew) {
    return hours > 0 ? `${hours} שע׳ ${rest} דק׳` : `${minutes} דק׳`
  }

  return hours > 0 ? `${hours}h ${rest}m` : `${minutes}m`
}

export function meetingDurationLabel(meeting: DurationSource, locale = "en"): string {
  return formatDurationLabel(getMeetingDurationMs(meeting), locale)
}

type DurationParts = { hours: number; minutes: number; seconds: number }

function durationParts(durationMs: number): DurationParts {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))

  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  }
}

const HEBREW_UNITS = {
  hours: { one: "שעה אחת", two: "שעתיים", many: "שעות" },
  minutes: { one: "דקה אחת", two: "2 דקות", many: "דקות" },
  seconds: { one: "שנייה אחת", two: "2 שניות", many: "שניות" },
} as const

function hebrewSpoken(parts: DurationParts): string {
  const units = (["hours", "minutes", "seconds"] as const).filter((unit) => parts[unit] > 0)
  const words = units.map((unit) => {
    const value = parts[unit]
    const forms = HEBREW_UNITS[unit]

    if (value === 1) return forms.one
    if (value === 2) return forms.two
    return `${value} ${forms.many}`
  })

  if (!words.length) return "0 שניות"
  if (words.length === 1) return words[0]

  // "12 דקות ו־34 שניות" (vav + maqaf before the last part).
  return `${words.slice(0, -1).join(", ")} ו־${words[words.length - 1]}`
}

function englishSpoken(parts: DurationParts): string {
  const words = (["hours", "minutes", "seconds"] as const)
    .filter((unit) => parts[unit] > 0)
    .map((unit) => {
      const value = parts[unit]
      const name = unit.slice(0, -1)

      return `${value} ${value === 1 ? name : `${name}s`}`
    })

  return words.length ? words.join(" ") : "0 seconds"
}

type DurationFormatConstructor = new (
  locale: string,
  options: { style: "long" }
) => { format: (duration: Partial<DurationParts>) => string }

/**
 * Spoken duration for screen readers (`aria-valuetext`, talk time):
 * "12 minutes 34 seconds" / "12 דקות ו־34 שניות"; "—" when unknown. Hebrew
 * and English use these fixed forms; other locales use Intl.DurationFormat
 * when the runtime has it.
 */
export function formatSpokenDuration(durationMs: number | undefined, locale = "en"): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return UNKNOWN_DURATION_LABEL
  }

  const parts = durationParts(durationMs)

  if (isHebrew(locale)) return hebrewSpoken(parts)

  const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatConstructor })
    .DurationFormat

  if (!/^en(-|$)/i.test(locale) && DurationFormat) {
    try {
      const nonZero = Object.fromEntries(
        Object.entries(parts).filter(([, value]) => value > 0)
      ) as Partial<DurationParts>

      return new DurationFormat(locale, { style: "long" }).format(
        Object.keys(nonZero).length ? nonZero : { seconds: 0 }
      )
    } catch {
      // Unsupported locale: fall through to English.
    }
  }

  return englishSpoken(parts)
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
