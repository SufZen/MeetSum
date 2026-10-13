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

/**
 * Word boundaries that understand Hebrew. JS `\b` is ASCII-only, so a term like
 * `גמה` would match inside `דוגמה`/`מגמה`. These lookarounds treat any letter,
 * combining mark (niqqud) or digit as part of a word. Always used with `u`.
 */
const WORD_START = String.raw`(?<![\p{L}\p{M}\p{N}])`
const WORD_END = String.raw`(?![\p{L}\p{M}\p{N}])`

/**
 * Hebrew one-letter prefixes (ו ה ב כ ל מ ש) that attach directly to the next
 * word, optionally stacked (e.g. וב, שה, וכש). Captured so a replacement can
 * keep them, joined with a maqaf: `בסופרבייס` → `ב-Supabase`.
 */
const HEBREW_PREFIX = "(?<prefix>[והבכלמש]{1,3})"

/**
 * Builds a Unicode-aware, word-bounded regex for a term.
 * `allowHebrewPrefix` lets the match start with attached Hebrew prefixes.
 * Pass `global: true` only for replace/matchAll; `.test` callers must use the
 * default non-global form (a global regex keeps `lastIndex` between calls).
 */
export function termRegex(
  source: string,
  options: { allowHebrewPrefix?: boolean; global?: boolean; ignoreCase?: boolean } = {}
): RegExp {
  const prefix = options.allowHebrewPrefix ? `${HEBREW_PREFIX}?` : ""
  const flags = `u${options.global ? "g" : ""}${options.ignoreCase ? "i" : ""}`

  return new RegExp(`${WORD_START}${prefix}(?:${source})${WORD_END}`, flags)
}

const FILLER_PATTERNS = [
  termRegex("שומעים אותי"),
  termRegex("לא שומע(?:ים)?"),
  termRegex("can you hear me", { ignoreCase: true }),
  termRegex("this meeting is being recorded", { ignoreCase: true }),
  termRegex("connection (?:is )?(?:bad|unstable)", { ignoreCase: true }),
]

type TermReplacement = {
  pattern: RegExp
  replacement: string
}

function term(
  source: string,
  replacement: string,
  allowHebrewPrefix: boolean
): TermReplacement {
  return {
    pattern: termRegex(source, { allowHebrewPrefix, global: true }),
    replacement,
  }
}

/**
 * Hebrew transliterations of technical terms. Distinctive multi-letter terms
 * accept attached prefixes; short/ambiguous ones (Gemma `גמה`, MCP `אם סי פי`)
 * are strict whole words so ordinary Hebrew (`דוגמה`, `מגמה`, `ואם`) survives.
 */
const TECHNICAL_TERM_REPLACEMENTS: TermReplacement[] = [
  term("סופרבייס", "Supabase", true),
  term("ג['׳]מיני", "Gemini", true),
  term("גמיני", "Gemini", true),
  term("גמה", "Gemma", false),
  term("קלוד קוד", "Claude Code", true),
  term("רילייז ?אוס", "RealizeOS", true),
  term("ויסקוד", "VSCode", true),
  term("אם סי פי", "MCP", false),
]

function replaceTechnicalTerms(text: string): string {
  return TECHNICAL_TERM_REPLACEMENTS.reduce(
    (value, { pattern, replacement }) =>
      value.replace(pattern, (...args: unknown[]) => {
        const groups = args[args.length - 1] as { prefix?: string } | undefined
        const prefix = groups?.prefix

        return prefix ? `${prefix}-${replacement}` : replacement
      }),
    text
  )
}

/** Tokens that contain at least one letter (numbers and punctuation don't count). */
function countLetterWords(text: string): number {
  return text.split(/\s+/u).filter((token) => /\p{L}/u.test(token)).length
}

function stripFillers(text: string): string {
  return FILLER_PATTERNS.reduce(
    (value, pattern) => value.replace(new RegExp(pattern.source, `${pattern.flags}g`), " "),
    text
  )
}

/** Max silence (ms) between two identical segments for the second to count as an echo. */
const DUPLICATE_GAP_MS = 2000

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

/**
 * Normalizes transliterated technical terms, drops filler-only segments
 * ("שומעים אותי?") and removes echoes: a segment identical to the immediately
 * previous kept segment from the same speaker within 2 s. Repeating the same
 * sentence later in the meeting is kept — it may be intentional.
 */
export function cleanupTranscriptSegments(
  segments: TranscriptSegment[]
): TranscriptSegment[] {
  const kept: TranscriptSegment[] = []
  let previous: { segment: TranscriptSegment; normalized: string } | undefined

  for (const segment of segments) {
    const text = replaceTechnicalTerms(segment.text).trim()
    const normalized = normalizeText(text).trim()

    if (!normalized) continue
    if (
      FILLER_PATTERNS.some((pattern) => pattern.test(text)) &&
      countLetterWords(stripFillers(text)) < 2
    ) {
      continue
    }
    if (
      previous &&
      previous.normalized === normalized &&
      previous.segment.speaker === segment.speaker &&
      segment.startMs - previous.segment.endMs <= DUPLICATE_GAP_MS
    ) {
      continue
    }

    const cleaned = { ...segment, text }
    kept.push(cleaned)
    previous = { segment: cleaned, normalized }
  }

  return kept
}

type TagRule = {
  tag: MeetingTag
  /** Latin-script words, matched as whole words (with optional plural `s`). */
  words?: string[]
  /**
   * Hebrew stems: whole-word start (attached prefixes allowed), open end so
   * inflections (לקוחות, תקציבים) still match. Matched against normalized text,
   * where geresh/gershayim become spaces (נדל"ן → "נדל ן").
   */
  hebrewStems?: string[]
}

const TAG_RULES: TagRule[] = [
  {
    tag: "technical",
    words: ["api", "mcp", "supabase", "vscode", "gemini", "gemma", "realizeos", "google drive"],
  },
  {
    tag: "finance",
    words: ["budget", "finance", "invoice", "cost", "orcamento", "orçamento"],
    hebrewStems: ["תקציב", "כסף"],
  },
  {
    tag: "real-estate",
    words: ["property", "properties", "asset", "real estate"],
    hebrewStems: [String.raw`נדל\s*ן`, "נכס"],
  },
  { tag: "sales", words: ["client", "customer", "sales"], hebrewStems: ["לקוח", "מכירה", "מכירות"] },
  {
    tag: "operations",
    words: ["ops", "operation", "operations", "workflow"],
    hebrewStems: ["תפעול", "אוטומציה"],
  },
  { tag: "legal", words: ["legal", "contract", "law"], hebrewStems: ["חוזה", "משפטי"] },
  { tag: "product", words: ["product", "roadmap", "feature"], hebrewStems: ["מוצר", "פיצ"] },
  {
    tag: "follow-up-needed",
    words: ["follow-?up", "follow up", "send", "sending", "enviar", "inviare"],
    hebrewStems: ["שלח", "לשלוח"],
  },
  {
    tag: "urgent",
    words: ["urgent", "critico", "urgente"],
    hebrewStems: ["דחוף", "דחופה"],
  },
]

function compileTagRule(rule: TagRule): RegExp[] {
  const patterns: RegExp[] = []

  // Entries are regex fragments (e.g. "follow-?up"); a space matches any whitespace.
  const toFragment = (entry: string) => entry.replace(/ /g, String.raw`\s+`)

  if (rule.words?.length) {
    patterns.push(termRegex(`(?:${rule.words.map(toFragment).join("|")})s?`))
  }

  if (rule.hebrewStems?.length) {
    const stems = rule.hebrewStems.map(toFragment).join("|")
    patterns.push(new RegExp(`${WORD_START}${HEBREW_PREFIX}?(?:${stems})`, "u"))
  }

  return patterns
}

const COMPILED_TAG_RULES = TAG_RULES.map((rule) => ({
  tag: rule.tag,
  patterns: compileTagRule(rule),
}))

export function generateAutoTags(segments: TranscriptSegment[]): MeetingTag[] {
  const text = normalizeText(segments.map((segment) => segment.text).join(" "))
  const languageMetadata = detectMeetingLanguages(segments)
  const tags: MeetingTag[] = []

  for (const rule of COMPILED_TAG_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) tags.push(rule.tag)
  }

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
    /(צריך|צריכה|נדרש|חייב|אפשר לשלוח|לשלוח|להכין|תקבע|לקבוע|תבדוק|לבדוק|need\b|needs to|must|please send|prepare|schedule|follow up|precisamos|necesitamos|dobbiamo|enviar|inviare)/i

  /**
   * "send" and "should" need more context to be actionable.
   * - "send" is valid with an object: "send the report", "send a follow-up"
   * - "should" is valid with an action: "should prepare", "should send"
   */
  const contextualTaskPatterns =
    /\bsend\s+(the|a|an|this|that|it|them)\b|\bshould\s+(send|prepare|schedule|review|follow|update|check|fix|create|write|submit|complete)\b/i

  const weakDiscussionPatterns =
    /^(uh|um|okay|yeah|yes|no|so|but|and|i think|you know|maybe|right)\b/i

  /** Reject sentences that are questions — they are not actionable tasks */
  const questionPattern = /\?\s*$/

  const seen = new Set<string>()

  return segments
    .filter(
      (segment) =>
        taskPatterns.test(segment.text) ||
        contextualTaskPatterns.test(segment.text)
    )
    .map((segment) => {
      const candidate =
        segment.text
          .split(/(?<=[.!?])\s+/)
          .find(
            (sentence) =>
              (taskPatterns.test(sentence) ||
                contextualTaskPatterns.test(sentence)) &&
              !questionPattern.test(sentence)
          ) ?? segment.text
      const title = candidate
        .replace(/\s+/g, " ")
        .replace(/^[-–•\s]+/, "")
        .trim()
        .slice(0, 160)

      return { segment, title }
    })
    .filter(({ title }) => {
      const wordCount = title.split(/\s+/).filter(Boolean).length

      if (wordCount < 4) return false
      if (weakDiscussionPatterns.test(title)) return false
      if (questionPattern.test(title)) return false

      // Deduplicate similar task titles (e.g. repeated statements across segments)
      const normalized = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

      if (seen.has(normalized)) return false

      seen.add(normalized)
      return true
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
