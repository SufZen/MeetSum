import type { ActionItem } from "@/lib/meetings/repository"

export type ContentLanguage = "en" | "he" | "pt" | "es" | "it" | "mixed"

export type SegmentLanguage = {
  segmentId: string
  language: ContentLanguage
  confidence: number
}

export type MeetingLanguageMetadata = {
  primaryLanguage: ContentLanguage
  secondaryLanguages: ContentLanguage[]
  segmentLanguages: SegmentLanguage[]
  confidence: number
  mixedLanguage: boolean
}

export type MeetingTag =
  | "technical"
  | "finance"
  | "real-estate"
  | "sales"
  | "operations"
  | "legal"
  | "product"
  | "follow-up-needed"
  | "urgent"
  | "hebrew"
  | "english"
  | "portuguese"
  | "spanish"
  | "italian"
  | "mixed-language"

export type SmartTask = ActionItem & {
  dueDate?: string
  priority: "low" | "normal" | "high" | "urgent"
  confidence: number
  sourceQuote: string
  sourceStartMs: number
  kind: "explicit" | "inferred"
}

export type TimestampedQuote = {
  segmentId: string
  speaker: string
  startMs: number
  text: string
}

/** Kinds of a citable summary item (M5). */
export type SummaryItemKind =
  | "decision"
  | "risk"
  | "open_question"
  | "commitment"
  | "next_step"
  | "section_item"

/** A transcript citation; `startMs` survives re-transcription. */
export type SummaryItemRef = {
  segmentId: string
  startMs: number
}

/**
 * One summary bullet with a stable id (M5):
 * `"si_" + sha1(kind + normalizeTaskTitle(text)).slice(0, 12)`.
 */
export type SummaryItem = {
  id: string
  kind: SummaryItemKind
  /** Template section of a `section_item`. */
  sectionKey?: string
  text: string
  refs: SummaryItemRef[]
}

/** A transcript chapter (M5); starts are monotonic, `endMs` = next start. */
export type Chapter = {
  id: string
  title: string
  summary: string
  startMs: number
  endMs: number
  startSegmentId: string
  bullets: string[]
}

/** Output of one template section; items live in `MeetingIntelligence.items`. */
export type TemplateSectionOutput = {
  key: string
  title?: string
  text?: string
  itemIds: string[]
}

/** How an IntelligenceV2 was generated (M5). */
export type IntelligenceGeneration = {
  provider: string
  model?: string
  promptVersion?: string
  templateKey?: string
  language?: string
  languageCheck?: "passed" | "failed" | "skipped"
  fallbackUsed?: boolean
  costUsd?: number | null
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  aiRunIds?: string[]
  generatedAt?: string
}

/**
 * Meeting intelligence. The M5 (V2) fields are additive and optional: legacy
 * `decisions/risks/openQuestions/commitments` stay populated (derived from
 * `items`), so exports, share, webhooks and RealizeOS keep working.
 */
export type MeetingIntelligence = {
  overview: string
  decisions: string[]
  actionItems: SmartTask[]
  risks: string[]
  openQuestions: string[]
  commitments: string[]
  followUpDraft: string
  timestampedQuotes: TimestampedQuote[]
  tags: MeetingTag[]
  languageMetadata: MeetingLanguageMetadata
  version?: 2
  title?: string
  meetingType?: string
  /** Free-form, in the meeting language, at most 8. */
  topics?: string[]
  chapters?: Chapter[]
  sections?: TemplateSectionOutput[]
  items?: SummaryItem[]
  generation?: IntelligenceGeneration
}
