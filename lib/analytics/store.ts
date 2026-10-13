/**
 * `meeting_analytics` persistence (owner: Package D). Step 0 stubs that
 * throw "not implemented (M5)".
 */
import type { MeetingAnalyticsRecord } from "@/lib/analytics/types"
import { notImplementedM5, type RepoScope } from "@/lib/meetings/repository"

export async function getMeetingAnalytics(
  scope: RepoScope,
  meetingId: string
): Promise<MeetingAnalyticsRecord | undefined> {
  void scope
  void meetingId
  return notImplementedM5("getMeetingAnalytics")
}

export async function upsertMeetingAnalytics(
  scope: RepoScope,
  record: Omit<MeetingAnalyticsRecord, "computedAt">
): Promise<MeetingAnalyticsRecord> {
  void scope
  void record
  return notImplementedM5("upsertMeetingAnalytics")
}
