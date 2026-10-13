/**
 * Pure recorder-dock state (M7 C3): which live recordings get a row, the
 * mono timer text, the "+N" overflow, the one-shot polite announcements and
 * what Stop does. The dock component only renders this.
 */
import type { BotPlatform, BotSessionSummary } from "@/lib/bot/types"

export const DOCK_MAX_ROWS = 2

export type DockEntry =
  | {
      kind: "bot"
      id: string
      meetingId: string
      sessionId: string
      title: string | null
      platform: BotPlatform
      /** epoch ms the recording started (joined_at). */
      startedAt: number
    }
  | {
      kind: "browser"
      id: "browser"
      meetingId: string | null
      title: string | null
      startedAt: number
    }

/** mm:ss under an hour, h:mm:ss after. Western digits; never negative. */
export function formatDockElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const ss = String(seconds).padStart(2, "0")

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}`
    : `${String(minutes).padStart(2, "0")}:${ss}`
}

/**
 * One row per live recording: active bot sessions (from joined_at) plus the
 * browser recorder. Oldest first so rows don't jump as new ones arrive.
 */
export function dockEntriesFrom({
  sessions,
  titles,
  browser,
  now = Date.now(),
}: {
  sessions: Readonly<Record<string, BotSessionSummary>>
  titles: Readonly<Record<string, string | undefined>>
  browser?: { startedAt: number; meetingId: string | null; title: string | null } | null
  /** Fallback start for a session without joined_at (defaults to now). */
  now?: number
}): DockEntry[] {
  const entries: DockEntry[] = []

  for (const [meetingId, session] of Object.entries(sessions)) {
    if (session.status !== "active") continue

    const joined = Date.parse(session.joinedAt ?? "")

    entries.push({
      kind: "bot",
      id: `bot:${session.id}`,
      meetingId: session.meetingId ?? meetingId,
      sessionId: session.id,
      title: titles[session.meetingId ?? meetingId] ?? null,
      platform: session.platform,
      startedAt: Number.isNaN(joined) ? now : joined,
    })
  }
  if (browser) {
    entries.push({
      kind: "browser",
      id: "browser",
      meetingId: browser.meetingId,
      title: browser.title,
      startedAt: browser.startedAt,
    })
  }

  return entries.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** At most `max` rows, then "+N". */
export function splitDockRows<T>(entries: readonly T[], max = DOCK_MAX_ROWS) {
  return { visible: entries.slice(0, max), overflow: Math.max(0, entries.length - max) }
}

export type DockAnnouncerState = { recording: boolean }
export type DockAnnouncement = "started" | "stopped" | null

/**
 * The polite region says "Recording started" / "Recording stopped" once per
 * transition between no recordings and some, never on every tick or row.
 */
export function nextDockAnnouncement(
  state: DockAnnouncerState,
  liveCount: number
): { state: DockAnnouncerState; announce: DockAnnouncement } {
  const recording = liveCount > 0

  if (recording === state.recording) return { state, announce: null }

  return { state: { recording }, announce: recording ? "started" : "stopped" }
}

export type DockStopAction =
  | { kind: "browser" }
  | { kind: "bot"; meetingId: string; sessionId: string; title: string | null }

/** Stop on a browser row stops the MediaRecorder; on a bot row it asks to stop the bot. */
export function dockStopAction(entry: DockEntry): DockStopAction {
  return entry.kind === "browser"
    ? { kind: "browser" }
    : { kind: "bot", meetingId: entry.meetingId, sessionId: entry.sessionId, title: entry.title }
}
