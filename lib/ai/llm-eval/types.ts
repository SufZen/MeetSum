/**
 * Hebrew summary eval harness types (M5 D8). Fixtures carry transcripts;
 * recordings and reports never do.
 */

/** `<provider>:<model>`, e.g. `gemini:gemini-3.8-flash`. */
export type ModelSpec = string

export type EvalProvider = "anthropic" | "gemini"

export type EvalModel = { spec: ModelSpec; provider: EvalProvider; model: string }

export type EvalReferenceActionItem = {
  title: string
  owner?: string
  /** `YYYY-MM-DD` */
  dueOn?: string
}

export type EvalFixtureSegment = {
  id: string
  speaker: string
  startMs: number
  endMs: number
  text: string
}

/** One eval meeting (synthetic fixture or a consented real meeting). */
export type EvalMeetingFixture = {
  id: string
  /** True for the committed fixtures; real meetings come from the manifest. */
  _synthetic: boolean
  title: string
  language: "he" | "en" | "mixed"
  startedAt: string
  tags?: string[]
  segments: EvalFixtureSegment[]
  reference: {
    actionItems: EvalReferenceActionItem[]
    decisions: string[]
    keyTopics: string[]
  }
}

/**
 * What a candidate produced for one meeting, reduced to what the metrics
 * need. Quotes and transcript excerpts are scrubbed before recording.
 */
export type CandidateRecording = {
  meetingId: string
  overview?: string
  decisions: string[]
  actionItems: EvalReferenceActionItem[]
  /** Segment ids cited by summary items, chapters and tasks. */
  citations: string[]
  chapterCount: number
  languageCheck?: "passed" | "failed" | "skipped"
  latencyMs: number
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  costUsd?: number | null
  error?: string
}

export type CandidateRecordingFile = {
  candidate: ModelSpec
  synthetic?: boolean
  outputs: Record<string, CandidateRecording>
}

export const EVAL_CRITERIA = ["faithfulness", "coverage", "hebrew_fluency", "action_item_recall"] as const

export type EvalCriterion = (typeof EVAL_CRITERIA)[number]

export type Verdict = "A" | "B" | "tie"

/** One judge call: summaries shown as A and B in a given order. */
export type JudgeVerdictRecord = {
  meetingId: string
  /** Summary shown as A. */
  a: ModelSpec
  /** Summary shown as B. */
  b: ModelSpec
  verdicts: Record<EvalCriterion, { winner: Verdict; rationale: string }>
}

export type JudgeRecordingFile = {
  judge: ModelSpec
  synthetic?: boolean
  records: JudgeVerdictRecord[]
}

export type RecordingManifest = {
  synthetic: boolean
  recordedAt: string
  baseline: ModelSpec
  candidates: ModelSpec[]
  judges: ModelSpec[]
}
