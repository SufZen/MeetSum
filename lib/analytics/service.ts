/**
 * Meeting analytics service (M5 D3): reads, refreshes and recomputes
 * `meeting_analytics` for a visible meeting.
 *
 * Reads recompute the pure metrics when the transcript hash changed (M3
 * speaker merge, segment edits), so the card is right without a job; the
 * stored sentiment is regrouped from its cached turns.
 */
import {
  computeMeetingAnalytics,
  refreshSpeakerNames,
  transcriptHash,
} from "@/lib/analytics/compute"
import {
  analyzeSentiment,
  isSentimentEnabled,
  reaggregateSentiment,
} from "@/lib/analytics/sentiment"
import { getMeetingAnalytics, upsertMeetingAnalytics } from "@/lib/analytics/store"
import { describeLlmFailure, LlmError } from "@/lib/ai/llm/types"
import {
  MEETING_ANALYTICS_VERSION,
  type MeetingAnalyticsRecord,
} from "@/lib/analytics/types"
import type { Chapter } from "@/lib/intelligence"
import type {
  MeetingRecord,
  MeetingRepository,
  MeetingSpeaker,
  RepoScope,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import { getAppSettings } from "@/lib/settings/app-settings"

type TranscriptInputs = {
  segments: TranscriptSegment[]
  speakers: MeetingSpeaker[]
  chapters: Chapter[]
  language: string
}

async function loadInputs(
  repo: MeetingRepository,
  meeting: MeetingRecord
): Promise<TranscriptInputs> {
  const transcript = await repo.getMeetingTranscript(meeting.id)
  const intelligence = meeting.intelligence ?? (await repo.getMeetingIntelligence(meeting.id))

  return {
    segments: transcript?.segments ?? meeting.transcript ?? [],
    speakers: transcript?.speakers ?? meeting.speakers ?? [],
    chapters: intelligence?.chapters ?? [],
    language: sentimentLanguage(meeting, intelligence?.generation?.language),
  }
}

function sentimentLanguage(meeting: MeetingRecord, generated?: string): string {
  const primary = generated ?? meeting.languageMetadata?.primaryLanguage ?? meeting.language

  return primary === "mixed" ? "he" : primary
}

/**
 * Analytics of a visible meeting. Missing or stale rows (hash or version
 * changed) are recomputed and stored; display names always reflect the
 * current speakers.
 */
export async function readMeetingAnalytics(
  scope: RepoScope,
  repo: MeetingRepository,
  meeting: MeetingRecord
): Promise<{ analytics: MeetingAnalyticsRecord; recomputed: boolean }> {
  const inputs = await loadInputs(repo, meeting)
  const hash = transcriptHash(inputs.segments)
  const stored = await getMeetingAnalytics(scope, meeting.id)

  if (stored && stored.transcriptHash === hash && stored.version === MEETING_ANALYTICS_VERSION) {
    return {
      analytics: { ...stored, metrics: refreshSpeakerNames(stored.metrics, inputs.speakers) },
      recomputed: false,
    }
  }

  const metrics = computeMeetingAnalytics(inputs.segments, inputs.speakers)
  const sentiment = stored?.sentiment
    ? (reaggregateSentiment(stored.sentiment, inputs) ?? null)
    : undefined
  const record = {
    meetingId: meeting.id,
    workspaceId: scope.workspaceId,
    version: MEETING_ANALYTICS_VERSION,
    transcriptHash: hash,
    metrics,
    sentiment,
  }
  const saved = await upsertMeetingAnalytics(scope, record)

  return {
    analytics: saved ?? {
      ...record,
      sentiment: sentiment ?? undefined,
      sentimentAiRunId: stored?.sentimentAiRunId,
      computedAt: new Date().toISOString(),
    },
    recomputed: true,
  }
}

/**
 * Recomputes metrics and runs sentiment (when enabled). A sentiment failure
 * is non-fatal: the metrics are stored either way.
 */
export async function recomputeMeetingAnalytics(
  scope: RepoScope,
  repo: MeetingRepository,
  meeting: MeetingRecord,
  options: { sentiment?: boolean; force?: boolean; jobId?: string; interactive?: boolean } = {}
): Promise<{
  analytics: MeetingAnalyticsRecord | undefined
  sentiment: "ok" | "skipped" | "failed"
  /** Set when sentiment failed because no LLM provider is configured. */
  sentimentError?: "llm_not_configured"
}> {
  const inputs = await loadInputs(repo, meeting)
  const stored = await getMeetingAnalytics(scope, meeting.id)
  const metrics = computeMeetingAnalytics(inputs.segments, inputs.speakers)
  let sentimentStatus: "ok" | "skipped" | "failed" = "skipped"
  let sentiment: Awaited<ReturnType<typeof analyzeSentiment>>
  let sentimentError: "llm_not_configured" | undefined

  if (options.sentiment !== false) {
    try {
      sentiment = await analyzeSentiment({
        workspaceId: scope.workspaceId,
        meetingId: meeting.id,
        segments: inputs.segments,
        speakers: inputs.speakers,
        chapters: inputs.chapters,
        language: inputs.language,
        previous: options.force ? undefined : stored?.sentiment,
        jobId: options.jobId,
        ...(options.interactive ? { interactive: true } : {}),
      })
      sentimentStatus = sentiment ? "ok" : "failed"
    } catch (error) {
      sentimentStatus = "failed"
      if (error instanceof LlmError && error.kind === "config") sentimentError = "llm_not_configured"
      // Error kind only: provider/parse messages can carry model output.
      console.warn(`[analytics] sentiment failed for ${meeting.id}: ${describeLlmFailure(error)}`)
    }
  }

  const analytics = await upsertMeetingAnalytics(scope, {
    meetingId: meeting.id,
    workspaceId: scope.workspaceId,
    version: MEETING_ANALYTICS_VERSION,
    transcriptHash: transcriptHash(inputs.segments),
    metrics,
    // Keep the stored sentiment when this run produced none.
    sentiment: sentiment?.sentiment,
    sentimentAiRunId: sentiment?.sentiment ? (sentiment.aiRunId ?? null) : undefined,
  })

  return { analytics, sentiment: sentimentStatus, ...(sentimentError ? { sentimentError } : {}) }
}

/** Whether sentiment runs for a workspace (`aiFeatures.sentiment`, env). */
export async function sentimentEnabledFor(workspaceId: string): Promise<boolean> {
  try {
    return isSentimentEnabled(await getAppSettings(workspaceId))
  } catch {
    return isSentimentEnabled(undefined)
  }
}
