import type {
  MeetingRecord,
  TranscriptSegment,
} from "@/lib/meetings/repository"

import type {
  ContentLanguage,
  MeetingIntelligence,
  MeetingLanguageMetadata,
  MeetingTag,
  SmartTask,
} from "./types"

export type {
  ContentLanguage,
  MeetingIntelligence,
  MeetingLanguageMetadata,
  MeetingTag,
  SmartTask,
} from "./types"

const HEBREW_SCRIPT = /[\u0590-\u05ff]/
const FILLER_PATTERNS = [
  /שומעים אותי/gi,
  /לא שומע/gi,
  /can you hear me/gi,
  /this meeting is being recorded/gi,
  /connection (is )?(bad|unstable)/gi,
]

const TECHNICAL_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/סופרבייס/g, "Supabase"],
  [/ג'מיני/g, "Gemini"],
  [/גמיני/g, "Gemini"],
  [/גמה/g, "Gemma"],
  [/קלוד קוד/g, "Claude Code"],
  [/רילייז ?אוס/g, "RealizeOS"],
  [/ויסקוד/g, "VSCode"],
  [/אם סי פי/g, "MCP"],
]

const STOPWORDS: Record<Exclude<ContentLanguage, "he" | "mixed">, string[]> = {
  en: ["the", "and", "need", "follow", "client", "team", "should", "for"],
  pt: ["precisamos", "revisar", "resumo", "para", "enviar", "orcamento", "orçamento"],
  es: ["necesitamos", "revisar", "resumen", "para", "enviar", "cliente"],
  it: ["dobbiamo", "rivedere", "riassunto", "per", "inviare", "cliente"],
}

const LANGUAGE_TAGS: Record<Exclude<ContentLanguage, "mixed">, MeetingTag> = {
  en: "english",
  he: "hebrew",
  pt: "portuguese",
  es: "spanish",
  it: "italian",
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function confidence(score: number, total: number): number {
  if (total === 0) return 0

  return Math.min(0.99, Number((score / total).toFixed(2)))
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}%.$/ -]+/gu, " ")
}

export function detectSegmentLanguage(
  text: string
): { language: ContentLanguage; confidence: number } {
  const normalized = normalizeText(text)
  const words = normalized.split(/\s+/).filter(Boolean)
  const scores: Record<ContentLanguage, number> = {
    en: 0,
    he: 0,
    pt: 0,
    es: 0,
    it: 0,
    mixed: 0,
  }

  scores.he = [...text].filter((character) =>
    HEBREW_SCRIPT.test(character)
  ).length

  for (const [language, stopwords] of Object.entries(STOPWORDS) as Array<
    [Exclude<ContentLanguage, "he" | "mixed">, string[]]
  >) {
    scores[language] = words.filter((word) => stopwords.includes(word)).length
  }

  const ranked = (Object.entries(scores) as Array<[ContentLanguage, number]>)
    .filter(([language]) => language !== "mixed")
    .sort((a, b) => b[1] - a[1])
  const [topLanguage, topScore] = ranked[0]
  const secondScore = ranked[1]?.[1] ?? 0
  const total = ranked.reduce((sum, [, score]) => sum + score, 0)

  if (topScore === 0) {
    return { language: "en", confidence: 0.25 }
  }

  if (secondScore > 0 && secondScore / topScore > 0.55) {
    return { language: "mixed", confidence: 0.5 }
  }

  return {
    language: topLanguage,
    confidence: Math.max(0.55, confidence(topScore, total)),
  }
}

export function detectMeetingLanguages(
  segments: TranscriptSegment[]
): MeetingLanguageMetadata {
  const segmentLanguages = segments.map((segment) => ({
    segmentId: segment.id,
    ...detectSegmentLanguage(segment.text),
  }))

  const counts = segmentLanguages.reduce(
    (accumulator, segment) => {
      accumulator[segment.language] = (accumulator[segment.language] ?? 0) + 1
      return accumulator
    },
    {} as Record<ContentLanguage, number>
  )
  const ranked = (Object.entries(counts) as Array<[ContentLanguage, number]>)
    .filter(([language]) => language !== "mixed")
    .sort((a, b) => b[1] - a[1])
  const distinctLanguages = ranked.map(([language]) => language)
  const top = ranked[0]
  const total = segmentLanguages.length
  const topShare = top ? top[1] / total : 0
  const mixedLanguage =
    segmentLanguages.some((segment) => segment.language === "mixed") ||
    distinctLanguages.length > 1

  return {
    primaryLanguage: mixedLanguage && topShare < 0.72 ? "mixed" : (top?.[0] ?? "en"),
    secondaryLanguages: mixedLanguage ? distinctLanguages : distinctLanguages.slice(1),
    segmentLanguages,
    confidence: Number((topShare || 0.25).toFixed(2)),
    mixedLanguage,
  }
}

export function cleanupTranscriptSegments(
  segments: TranscriptSegment[]
): TranscriptSegment[] {
  const seen = new Set<string>()

  return segments
    .map((segment) => {
      const text = TECHNICAL_TERM_REPLACEMENTS.reduce(
        (value, [pattern, replacement]) => value.replace(pattern, replacement),
        segment.text
      ).trim()

      return { ...segment, text }
    })
    .filter((segment) => {
      const normalized = normalizeText(segment.text).trim()

      if (!normalized) return false
      if (FILLER_PATTERNS.some((pattern) => pattern.test(segment.text))) {
        return false
      }
      if (seen.has(normalized)) return false

      seen.add(normalized)
      return true
    })
}

export function generateAutoTags(segments: TranscriptSegment[]): MeetingTag[] {
  const text = normalizeText(segments.map((segment) => segment.text).join(" "))
  const languageMetadata = detectMeetingLanguages(segments)
  const tags: MeetingTag[] = []

  if (/api|mcp|supabase|vscode|gemini|gemma|realizeos|google drive/.test(text)) {
    tags.push("technical")
  }
  if (/budget|finance|invoice|cost|orcamento|orçamento|תקציב|כסף/.test(text)) {
    tags.push("finance")
  }
  if (/property|asset|real estate|נדלן|נכס/.test(text)) {
    tags.push("real-estate")
  }
  if (/client|customer|sales|לקוח|מכירה/.test(text)) tags.push("sales")
  if (/ops|operation|workflow|תפעול|אוטומציה/.test(text)) {
    tags.push("operations")
  }
  if (/legal|contract|law|חוזה|משפטי/.test(text)) tags.push("legal")
  if (/product|roadmap|feature|מוצר|פיצ/.test(text)) tags.push("product")
  if (/follow.?up|send|שלח|לשלוח|enviar|inviare/.test(text)) {
    tags.push("follow-up-needed")
  }
  if (/urgent|דחוף|דחופה|critico|urgente/.test(text)) tags.push("urgent")

  for (const language of languageMetadata.secondaryLanguages.length
    ? languageMetadata.secondaryLanguages
    : [languageMetadata.primaryLanguage]) {
    if (language !== "mixed") tags.push(LANGUAGE_TAGS[language])
  }

  if (languageMetadata.mixedLanguage) tags.push("mixed-language")

  return unique(tags)
}

export function extractSmartTasks(
  segments: TranscriptSegment[]
): SmartTask[] {
  const taskPatterns =
    /(צריך|צריכה|נדרש|חייב|אפשר לשלוח|לשלוח|להכין|תקבע|לקבוע|תבדוק|לבדוק|need\b|needs to|should|must|please send|send|prepare|schedule|follow up|precisamos|necesitamos|dobbiamo|enviar|inviare)/i
  const weakDiscussionPatterns =
    /^(uh|um|okay|yeah|yes|no|so|but|and|i think|you know|maybe|right)\b/i

  return segments
    .filter((segment) => taskPatterns.test(segment.text))
    .map((segment) => {
      const candidate =
        segment.text
          .split(/(?<=[.!?])\s+/)
          .find((sentence) => taskPatterns.test(sentence)) ?? segment.text
      const title = candidate
        .replace(/\s+/g, " ")
        .replace(/^[-–•\s]+/, "")
        .trim()
        .slice(0, 160)

      return { segment, title }
    })
    .filter(({ title }) => {
      const wordCount = title.split(/\s+/).filter(Boolean).length

      return wordCount >= 4 && !weakDiscussionPatterns.test(title)
    })
    .slice(0, 12)
    .map(({ segment, title }, index) => {
      const urgent = /urgent|דחוף|דחופה|critico|urgente/i.test(segment.text)

      return {
        id: `task_${segment.id}_${index}`,
        title,
        owner: segment.speaker,
        status: "open",
        priority: urgent ? "urgent" : "normal",
        confidence: urgent ? 0.87 : 0.68,
        sourceQuote: segment.text,
        sourceStartMs: segment.startMs,
        kind: "explicit",
      }
    })
}

export function buildMeetingIntelligence(
  meeting: MeetingRecord
): MeetingIntelligence {
  const transcript = cleanupTranscriptSegments(meeting.transcript ?? [])
  const languageMetadata = detectMeetingLanguages(transcript)
  const actionItems = extractSmartTasks(transcript)
  const tags = generateAutoTags(transcript)
  const overview =
    meeting.summary?.overview ??
    `${meeting.title} includes ${transcript.length} cleaned transcript segments and ${actionItems.length} suggested tasks.`

  return {
    overview,
    decisions: meeting.summary?.decisions ?? [],
    actionItems,
    risks: transcript
      .filter((segment) => /risk|blocker|בעיה|חסם|bloqueio|riesgo/i.test(segment.text))
      .map((segment) => segment.text),
    openQuestions: transcript
      .filter((segment) => /\?|שאלה|question/i.test(segment.text))
      .map((segment) => segment.text),
    commitments: transcript
      .filter((segment) => /commit|מתחייב|by next|עד יום/i.test(segment.text))
      .map((segment) => segment.text),
    followUpDraft: `Follow-up for ${meeting.title}: ${actionItems
      .map((item) => item.title)
      .join(" ")}`.trim(),
    timestampedQuotes: transcript.slice(0, 5).map((segment) => ({
      segmentId: segment.id,
      speaker: segment.speaker,
      startMs: segment.startMs,
      text: segment.text,
    })),
    tags,
    languageMetadata,
  }
}
