import type { AuthContext } from "@/lib/auth/authz"
import type { MediaAsset } from "@/lib/meetings/repository"

/**
 * Media assets of a meeting the caller can see, or undefined (→ 404 for a
 * missing, invisible or foreign meeting). The transcript is not loaded.
 */
export async function loadMeetingMediaAssets(
  ctx: Pick<AuthContext, "meetings">,
  meetingId: string
): Promise<MediaAsset[] | undefined> {
  if (!meetingId) return undefined

  const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript: false })

  return meeting ? (meeting.mediaAssets ?? []) : undefined
}
