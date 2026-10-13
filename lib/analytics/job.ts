/**
 * `meeting.analyze` job (owner: Package D): computes metrics, runs sentiment
 * and upserts `meeting_analytics`. Step 0 stub: a no-op.
 */
import type { MeetingRepository } from "@/lib/meetings/repository"

export type AnalyzeMeetingJobInput = {
  workspaceId: string
  meetingId: string
  repo: MeetingRepository
}

export async function analyzeMeetingJob(
  input: AnalyzeMeetingJobInput
): Promise<Record<string, unknown>> {
  return { meetingId: input.meetingId, skipped: true, reason: "not implemented (M5)" }
}
