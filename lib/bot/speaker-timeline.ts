import { getBotConfig } from "@/lib/bot/config"
import { getBotSessionStore, type BotSessionStore } from "@/lib/bot/store"
import type { VexaTranscriptSegment } from "@/lib/bot/vexa/types"
import type { MeetTimelineEntry } from "@/lib/meetings/speakers/types"

/**
 * Bot-observed speaker timeline (M7 B5).
 *
 * Vexa segments are grouped into `{name, startMs, endMs}` runs (gaps of at
 * most 1.5 s merged) aligned to OUR recording. Entries never carry an email:
 * the names are self-chosen platform display names, so they feed the M3
 * `meet_alignment` signal as a speaker *suggestion* only and can never
 * auto-confirm a mapping.
 */

export const BOT_TIMELINE_MERGE_GAP_MS = 1500
/** Offset 0 is trusted only when the recording and session spans agree within 2%. */
export const BOT_TIMELINE_SPAN_TOLERANCE = 0.02

export type BotTimelineAlignment = {
  /** Wall-clock start of our recording (Vexa recording `startedAt`). */
  recordingStartedAt?: string | null
  recordingDurationMs?: number | null
  /** Bot session span (joined_at .. left_at). */
  sessionStartedAt?: string | null
  sessionEndedAt?: string | null
}

function parseTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined

  const parsed = Date.parse(value)

  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Milliseconds to add to Vexa segment times to land on our recording's
 * timeline; undefined when it cannot be trusted.
 */
export function botTimelineOffsetMs(
  segments: readonly VexaTranscriptSegment[],
  alignment: BotTimelineAlignment
): number | undefined {
  const recordingStart = parseTime(alignment.recordingStartedAt)
  const anchored = segments.find((segment) => parseTime(segment.absoluteStartTime) !== undefined)

  if (recordingStart !== undefined && anchored) {
    const absolute = parseTime(anchored.absoluteStartTime) as number

    return Math.round(absolute - recordingStart - anchored.start * 1000)
  }

  const sessionStart = parseTime(alignment.sessionStartedAt)
  const sessionEnd = parseTime(alignment.sessionEndedAt)
  const duration = alignment.recordingDurationMs

  if (sessionStart === undefined || sessionEnd === undefined || !duration || duration <= 0) {
    return undefined
  }

  const span = sessionEnd - sessionStart

  if (span <= 0) return undefined
  return Math.abs(duration - span) <= span * BOT_TIMELINE_SPAN_TOLERANCE ? 0 : undefined
}

function isBotSpeaker(name: string, exclude: readonly string[]): boolean {
  const normalized = name.trim().toLowerCase()

  return exclude.some((candidate) => {
    const value = candidate.trim().toLowerCase()

    return Boolean(value) && (normalized === value || normalized.startsWith(`${value} `) || normalized.startsWith(`${value}·`))
  })
}

/** Groups segments into speaker runs; bot / empty speakers dropped. */
export function buildBotSpeakerTimeline(
  segments: readonly VexaTranscriptSegment[],
  options: { offsetMs: number; botName?: string; botEmail?: string }
): MeetTimelineEntry[] {
  const exclude = [options.botName ?? "", options.botEmail ?? ""].filter(Boolean)
  const runs: MeetTimelineEntry[] = []
  const sorted = [...segments]
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .sort((a, b) => a.start - b.start)

  for (const segment of sorted) {
    const name = (segment.speaker ?? "").trim()

    if (!name || isBotSpeaker(name, exclude)) continue

    const startMs = Math.max(0, Math.round(segment.start * 1000 + options.offsetMs))
    const endMs = Math.max(startMs, Math.round(segment.end * 1000 + options.offsetMs))
    const last = runs[runs.length - 1]

    if (last && last.name === name && startMs - last.endMs <= BOT_TIMELINE_MERGE_GAP_MS) {
      last.endMs = Math.max(last.endMs, endMs)
      continue
    }

    runs.push({ name: name.slice(0, 200), startMs, endMs })
  }

  return runs
}

/** Offset + grouping in one step; undefined when the offset is untrusted. */
export function alignBotSpeakerTimeline(
  segments: readonly VexaTranscriptSegment[],
  alignment: BotTimelineAlignment,
  options: { botName?: string; botEmail?: string } = {}
): MeetTimelineEntry[] | undefined {
  const offsetMs = botTimelineOffsetMs(segments, alignment)

  if (offsetMs === undefined) return undefined

  const timeline = buildBotSpeakerTimeline(segments, { ...options, offsetMs })

  return timeline.length ? timeline : undefined
}

function validEntries(value: unknown): MeetTimelineEntry[] | undefined {
  if (!Array.isArray(value)) return undefined

  const entries = value.flatMap((item): MeetTimelineEntry[] => {
    const entry = item as Partial<MeetTimelineEntry> | null

    if (
      !entry ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      typeof entry.startMs !== "number" ||
      typeof entry.endMs !== "number"
    ) {
      return []
    }

    // Never pass an email through: suggestion signal only.
    return [{ name: entry.name, startMs: entry.startMs, endMs: entry.endMs }]
  })

  return entries.length ? entries : undefined
}

/** The newest bot session timeline for a meeting, workspace-scoped. */
export async function loadBotSpeakerTimeline(
  meetingId: string,
  workspaceId: string,
  deps: { store?: BotSessionStore } = {}
): Promise<MeetTimelineEntry[] | undefined> {
  const store = deps.store ?? getBotSessionStore()
  const sessions = await store.listForMeeting(workspaceId, meetingId)
  const botName = getBotConfig().botName

  for (const session of sessions) {
    const entries = validEntries(session.speakerTimeline)

    if (entries) {
      return entries.filter((entry) => !isBotSpeaker(entry.name, [session.botName, botName]))
    }
  }

  return undefined
}

/**
 * Speaker-suggestion timeline loader for the job processor (M7 wiring).
 *
 * The bot-observed timeline (Vexa speaker events) is only a suggestion
 * signal; our own ASR transcript stays the final source. It is used for
 * bot-recorded meetings and for calendar meetings a bot attended, whenever
 * the primary (Google Meet transcript) timeline is absent or empty.
 */
export function speakerTimelineLoaderWithBot(input: {
  meetingId: string
  workspaceId: string
  meetingSource?: string
  primary?: () => Promise<MeetTimelineEntry[] | undefined>
  /** Default: MEETSUM_BOT_ENABLED, or always for `meeting_bot` meetings. */
  botEnabled?: boolean
  store?: BotSessionStore
}): (() => Promise<MeetTimelineEntry[] | undefined>) | undefined {
  const useBot = input.meetingSource === "meeting_bot" || (input.botEnabled ?? getBotConfig().enabled)

  if (!input.primary && !useBot) return undefined

  return async () => {
    const primary = input.primary ? await input.primary().catch(() => undefined) : undefined

    if (primary?.length || !useBot) return primary

    return loadBotSpeakerTimeline(input.meetingId, input.workspaceId, { store: input.store })
  }
}
