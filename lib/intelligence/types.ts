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
}
