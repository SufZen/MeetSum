/**
 * `meeting.analyze` job (M5 D3): computes metrics, runs sentiment when the
 * workspace allows it and upserts `meeting_analytics`. Sentiment failures are
 * non-fatal; a missing meeting is skipped.
 */
import { recomputeMeetingAnalytics, sentimentEnabledFor } from "@/lib/analytics/service"
import type { MeetingRepository, RepoScope } from "@/lib/meetings/repository"

export type AnalyzeMeetingJobInput = {
  workspaceId: string
  meetingId: string
  /** System repository of the workspace. */
  repo: MeetingRepository
  jobId?: string
}

export async function analyzeMeetingJob(
  input: AnalyzeMeetingJobInput
): Promise<Record<string, unknown>> {
  const meeting = await input.repo.getMeeting(input.meetingId, { includeTranscript: false })

  if (!meeting) {
    return { meetingId: input.meetingId, skipped: true, reason: "meeting_not_found" }
  }

  const scope: RepoScope = { kind: "system", workspaceId: input.workspaceId }
  const sentiment = await sentimentEnabledFor(input.workspaceId)
  const result = await recomputeMeetingAnalytics(scope, input.repo, meeting, {
    sentiment,
    jobId: input.jobId,
  })

  return {
    meetingId: input.meetingId,
    speakers: result.analytics?.metrics.speakers.length ?? 0,
    basis: result.analytics?.metrics.basis,
    sentiment: result.sentiment,
  }
}
