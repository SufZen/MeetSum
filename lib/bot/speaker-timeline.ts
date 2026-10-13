import type { MeetTimelineEntry } from "@/lib/meetings/speakers/types"

/**
 * Bot-observed speaker timeline (M7 B5): Vexa segments grouped into
 * MeetTimelineEntry runs, fed to the M3 meet_alignment signal (detail "bot")
 * for `meeting_bot` meetings. Step 0 stub: no timeline.
 */
export async function loadBotSpeakerTimeline(
  meetingId: string,
  workspaceId: string
): Promise<MeetTimelineEntry[] | undefined> {
  void meetingId
  void workspaceId

  return undefined
}
