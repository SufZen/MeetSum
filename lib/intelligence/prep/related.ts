/**
 * Related meetings for a prep brief (owner: Package D): participant-email
 * Jaccard x0.5 + same room x0.3 + title token overlap x0.2 over the last 180
 * days of visible completed meetings. Step 0 stub: none.
 */
import type { MeetingRecord, MeetingRepository } from "@/lib/meetings/repository"

export type RelatedMeeting = {
  meetingId: string
  title: string
  startedAt: string
  score: number
}

export async function findRelatedMeetings(
  meetings: MeetingRepository,
  meeting: MeetingRecord
): Promise<RelatedMeeting[]> {
  void meetings
  void meeting
  return []
}
