/**
 * Per-turn sentiment via the `sentiment` LLM task (owner: Package D). Step 0
 * stub: no sentiment.
 */
import type { MeetingSentiment } from "@/lib/analytics/types"
import type { Chapter } from "@/lib/intelligence"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"

export type AnalyzeSentimentInput = {
  workspaceId: string
  meetingId: string
  segments: TranscriptSegment[]
  speakers: MeetingSpeaker[]
  chapters?: Chapter[]
  language: string
}

export async function analyzeSentiment(
  input: AnalyzeSentimentInput
): Promise<{ sentiment: MeetingSentiment; aiRunId?: string } | undefined> {
  void input
  return undefined
}
