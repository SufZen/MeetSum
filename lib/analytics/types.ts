/**
 * Meeting analytics contract (docs/parity/m5.md, Step 0; owner: Package D).
 * Client-safe. Filler and question detection are heuristic.
 */

export type SpeakerAnalytics = {
  speakerId?: string
  label: string
  displayName?: string
  talkTimeMs: number
  /** Share of total talk time, 0..1. */
  share: number
  wordCount: number
  /** Words per talk-minute. */
  wpm: number
  longestMonologueMs: number
  questions: number
  fillerPer100Words: number
  interruptions: number
}

export type MeetingAnalyticsMetrics = {
  /** `words` when M3 raw words were used, else `text` (fillers less exact). */
  basis: "words" | "text"
  totalTalkTimeMs: number
  totalWords: number
  totalQuestions: number
  fillerPer100Words: number
  interruptions: number
  speakers: SpeakerAnalytics[]
}

export type SentimentLabel = "positive" | "neutral" | "negative" | "mixed"

export type SentimentAggregate = {
  label: SentimentLabel
  /** -1..1 */
  score: number
  turns: number
}

/**
 * One classified speaker turn, cached by the sha1 of its (truncated) text so
 * re-runs only send changed turns. Carries no transcript text.
 */
export type SentimentTurn = {
  hash: string
  speakerKey: string
  startMs: number
  label: SentimentLabel
  score: number
}

export type MeetingSentiment = {
  /** `label` is the sentiment label; the speaker is `speakerLabel`. */
  bySpeaker: Array<
    { speakerKey: string; speakerId?: string; speakerLabel: string; displayName?: string } & SentimentAggregate
  >
  byChapter: Array<{ chapterId: string } & SentimentAggregate>
  /** Overall meeting aggregate. */
  overall?: SentimentAggregate
  turns?: SentimentTurn[]
  /** Turns that could not be classified (a failed batch). */
  failedTurns?: number
  provider?: string
  model?: string
  computedAt?: string
}

export type MeetingAnalyticsRecord = {
  meetingId: string
  workspaceId: string
  version: number
  /** sha1 of segment ids, text and speaker ids. */
  transcriptHash: string
  metrics: MeetingAnalyticsMetrics
  sentiment?: MeetingSentiment
  sentimentAiRunId?: string
  computedAt: string
}

/** Bumped when the metric definitions change. */
// 2: interruptions count only overlaps (stored v1 rows are recomputed).
export const MEETING_ANALYTICS_VERSION = 2
