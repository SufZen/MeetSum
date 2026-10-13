import type { BotStatusReason, CalendarEventLike } from "@/lib/bot/types"

/**
 * Calendar-driven bot scheduling (M7 A5), called from pollCalendar only when
 * the bot feature is enabled. Step 0 stubs are no-ops.
 */

export type SyncCalendarBotSessionInput = {
  workspaceId: string
  /** The workspace DWD subject whose calendar was polled. */
  subject: string
  calendarEventId: string
  meetingId: string
  event: CalendarEventLike
}

export async function syncCalendarBotSession(input: SyncCalendarBotSessionInput): Promise<void> {
  void input
}

export async function cancelCalendarBotSession(input: {
  workspaceId: string
  calendarEventId: string
  reason: BotStatusReason
}): Promise<void> {
  void input
}

/** Re-evaluates upcoming calendar events after a rules change. */
export async function resyncWorkspaceBotSessions(workspaceId: string): Promise<void> {
  void workspaceId
}
