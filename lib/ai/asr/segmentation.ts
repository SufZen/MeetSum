import { isHebrewLanguage } from "./config"
import { applyGlossaryToWords } from "./glossary"
import type {
  AsrCost,
  AsrGlossary,
  AsrProviderId,
  AsrResult,
  AsrSegment,
  AsrSpeaker,
  AsrWord,
} from "./types"

/**
 * Pure transcript shaping shared by every provider: speaker relabeling,
 * glossary pass, per-word language, segmentation into speaker-homogeneous
 * utterances and per-speaker stats (docs/parity/m3.md "Model").
 */

export const SEGMENT_RULES = {
  /** Silence between words that always starts a new segment. */
  maxGapMs: 1200,
  /** Past this length a segment closes at the next sentence break. */
  softMaxMs: 25_000,
  /** Absolute segment length cap. */
  hardMaxMs: 40_000,
  maxWords: 80,
} as const

export const DEFAULT_SPEAKER = "Speaker 1"

/** What a provider hands to {@link finalizeResult}. */
export type AsrDraft = {
  provider: AsrProviderId
  model: string
  language: string
  durationMs: number
  /** Flat word list; `speaker` is the provider's raw label. */
  words: AsrWord[]
  diarization: "provider" | "none"
  cost: AsrCost
  timings: Record<string, number>
  warnings: string[]
  /** Raw provider label → voice embedding. */
  speakerEmbeddings?: Record<string, { embedding: number[]; model?: string }>
}

const LATIN = /\p{Script=Latin}/gu
const HEBREW = /\p{Script=Hebrew}/gu
const NO_SPACE_BEFORE = /^[.,?!:;%)\]}…]/u
const SENTENCE_END = /[.?!…]["')\]]*$/u

function baseLanguage(language: string) {
  return isHebrewLanguage(language) ? "he" : language.split(/[-_]/)[0] || language
}

/** Script-detected language of a token, or undefined (digits, symbols). */
export function scriptLanguage(text: string, defaultLanguage: string): string | undefined {
  const latin = (text.match(LATIN) ?? []).length
  const hebrew = (text.match(HEBREW) ?? []).length

  if (!latin && !hebrew) return undefined
  if (hebrew >= latin) return "he"
  // Latin script in a Hebrew meeting is English; in other meetings it is the
  // meeting language (Portuguese, Spanish, …).
  return isHebrewLanguage(defaultLanguage) ? "en" : baseLanguage(defaultLanguage)
}

/**
 * Per-word language. Provider-tagged languages are kept; otherwise by script
 * (Hebrew → he, Latin → en in Hebrew meetings); script-less tokens (digits,
 * symbols) inherit from the previous word, else the next, else the default.
 */
export function assignLanguage(words: AsrWord[], defaultLanguage: string): AsrWord[] {
  const fallback = baseLanguage(defaultLanguage)
  const detected = words.map((word) => word.language || scriptLanguage(word.text, defaultLanguage))
  const resolved: string[] = new Array(words.length)
  let previous: string | undefined

  for (let index = 0; index < words.length; index += 1) {
    if (detected[index]) previous = detected[index]
    resolved[index] = detected[index] ?? previous ?? ""
  }

  let next: string | undefined

  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (detected[index]) next = detected[index]
    if (!resolved[index]) resolved[index] = next ?? fallback
  }

  return words.map((word, index) => ({ ...word, language: resolved[index] }))
}

/** Raw provider labels → `Speaker 1..n` by first appearance. */
export function relabelSpeakers(words: AsrWord[]): { words: AsrWord[]; mapping: Map<string, string> } {
  const mapping = new Map<string, string>()

  const relabeled = words.map((word) => {
    const raw = word.speaker ?? DEFAULT_SPEAKER

    if (!mapping.has(raw)) mapping.set(raw, `Speaker ${mapping.size + 1}`)
    return { ...word, speaker: mapping.get(raw) }
  })

  return { words: relabeled, mapping }
}

/**
 * Words without a speaker inherit the previous word's speaker, else the
 * next one's; with no labels at all everything is `Speaker 1`.
 */
export function fillMissingSpeakers(words: AsrWord[]): AsrWord[] {
  const filled = words.map((word) => ({ ...word }))
  let previous: string | undefined

  for (const word of filled) {
    if (word.speaker) previous = word.speaker
    else if (previous) word.speaker = previous
  }

  let next: string | undefined

  for (let index = filled.length - 1; index >= 0; index -= 1) {
    if (filled[index].speaker) next = filled[index].speaker
    else filled[index].speaker = next ?? DEFAULT_SPEAKER
  }

  return filled
}

/** Joins word texts, without a space before closing punctuation. */
export function joinWords(words: AsrWord[]): string {
  let text = ""

  for (const word of words) {
    const value = word.text.trim()

    if (!value) continue
    text += text && !NO_SPACE_BEFORE.test(value) ? ` ${value}` : value
  }

  return text
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
}

function majorityLanguage(words: AsrWord[], fallback: string): string {
  const counts = new Map<string, number>()

  for (const word of words) {
    if (word.language) counts.set(word.language, (counts.get(word.language) ?? 0) + 1)
  }

  let best = fallback
  let bestCount = 0

  for (const [language, count] of counts) {
    if (count > bestCount || (count === bestCount && language === fallback)) {
      best = language
      bestCount = count
    }
  }

  return best
}

function toSegment(words: AsrWord[], turnIndex: number, defaultLanguage: string): AsrSegment {
  const confidence = mean(
    words
      .map((word) => word.confidence)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  )
  const segment: AsrSegment = {
    startMs: words[0].startMs,
    endMs: Math.max(...words.map((word) => word.endMs)),
    text: joinWords(words),
    speaker: words[0].speaker ?? DEFAULT_SPEAKER,
    turnIndex,
    language: majorityLanguage(words, baseLanguage(defaultLanguage)),
    words,
  }

  if (confidence !== undefined) segment.confidence = Math.round(confidence * 1000) / 1000
  return segment
}

/**
 * Splits words into segments: new segment on speaker change, a gap
 * > 1200 ms, > 25 s at a sentence break, a hard 40 s cap, or 80 words.
 * `turnIndex` increments only on speaker change.
 */
export function buildSegments(words: AsrWord[], defaultLanguage: string): AsrSegment[] {
  const segments: AsrSegment[] = []
  let current: AsrWord[] = []
  let turnIndex = -1
  let currentSpeaker: string | undefined

  const flush = () => {
    if (current.length) segments.push(toSegment(current, turnIndex, defaultLanguage))
    current = []
  }

  for (const word of words) {
    const speaker = word.speaker ?? DEFAULT_SPEAKER

    if (speaker !== currentSpeaker) {
      flush()
      turnIndex += 1
      currentSpeaker = speaker
    } else if (current.length) {
      const first = current[0]
      const last = current[current.length - 1]
      const length = word.endMs - first.startMs
      const lastLength = last.endMs - first.startMs

      if (
        word.startMs - last.endMs > SEGMENT_RULES.maxGapMs ||
        current.length >= SEGMENT_RULES.maxWords ||
        length > SEGMENT_RULES.hardMaxMs ||
        (lastLength > SEGMENT_RULES.softMaxMs && SENTENCE_END.test(last.text.trim()))
      ) {
        flush()
      }
    }

    current.push(word)
  }

  flush()
  return segments
}

/** Per-speaker talk time / counts, ordered by first appearance. */
export function summarizeSpeakers(
  segments: AsrSegment[],
  embeddings: Map<string, { embedding: number[]; model?: string }> = new Map()
): AsrSpeaker[] {
  const speakers = new Map<string, AsrSpeaker>()

  for (const segment of segments) {
    const speaker = speakers.get(segment.speaker) ?? {
      label: segment.speaker,
      talkTimeMs: 0,
      wordCount: 0,
      segmentCount: 0,
      firstStartMs: segment.startMs,
    }

    speaker.talkTimeMs += Math.max(0, segment.endMs - segment.startMs)
    speaker.wordCount += segment.words.length
    speaker.segmentCount += 1
    speaker.firstStartMs = Math.min(speaker.firstStartMs, segment.startMs)
    speakers.set(segment.speaker, speaker)
  }

  return [...speakers.values()]
    .sort((a, b) => a.firstStartMs - b.firstStartMs)
    .map((speaker) => {
      const voice = embeddings.get(speaker.label)

      return voice
        ? { ...speaker, embedding: voice.embedding, ...(voice.model ? { embeddingModel: voice.model } : {}) }
        : speaker
    })
}

function cleanWords(words: AsrWord[]): AsrWord[] {
  return words
    .filter((word) => word.text?.trim())
    .map((word) => {
      const startMs = Math.max(0, Math.round(Number(word.startMs) || 0))
      const endMs = Math.max(startMs, Math.round(Number(word.endMs) || startMs))
      const cleaned: AsrWord = { ...word, text: word.text.trim(), startMs, endMs }

      if (cleaned.confidence !== undefined) {
        const value = Number(cleaned.confidence)

        if (Number.isFinite(value)) cleaned.confidence = Math.min(1, Math.max(0, value))
        else delete cleaned.confidence
      }

      return cleaned
    })
    .sort((a, b) => a.startMs - b.startMs)
}

/**
 * Turns a provider draft into the normalized {@link AsrResult}: clean and
 * order words, fill/relabel speakers, apply the glossary, assign languages,
 * segment and summarize. Every provider ends with this call.
 */
export function finalizeResult(draft: AsrDraft, glossary: AsrGlossary): AsrResult {
  const warnings = [...draft.warnings]
  let words = cleanWords(draft.words)
  const hasLabels = words.some((word) => word.speaker)
  const diarization: AsrResult["diarization"] =
    draft.diarization === "provider" && hasLabels ? "provider" : "none"

  if (diarization === "none") {
    words = words.map((word) => ({ ...word, speaker: DEFAULT_SPEAKER }))
    if (!warnings.includes("diarization_unavailable")) warnings.push("diarization_unavailable")
  } else {
    words = fillMissingSpeakers(words)
  }

  const relabeled = relabelSpeakers(words)
  const embeddings = new Map<string, { embedding: number[]; model?: string }>()

  for (const [raw, label] of relabeled.mapping) {
    const voice = draft.speakerEmbeddings?.[raw]

    if (voice?.embedding?.length) embeddings.set(label, voice)
  }

  const glossed = applyGlossaryToWords(relabeled.words, glossary)
  const languaged = assignLanguage(glossed.words, draft.language)
  const segments = buildSegments(languaged, draft.language)
  const lastEnd = segments.length ? segments[segments.length - 1].endMs : 0

  return {
    provider: draft.provider,
    model: draft.model,
    language: draft.language,
    durationMs: Math.max(Math.round(draft.durationMs || 0), lastEnd),
    segments,
    speakers: summarizeSpeakers(segments, embeddings),
    diarization,
    cost: draft.cost,
    timings: draft.timings,
    glossaryReplacements: glossed.replacements,
    warnings,
  }
}

/**
 * Evenly spread word timings over a span for providers that only return
 * segment-level timestamps (flagged `synthetic_word_timings`).
 */
export function synthesizeWords(
  text: string,
  startMs: number,
  endMs: number,
  extra: Partial<Pick<AsrWord, "speaker" | "confidence" | "language">> = {}
): AsrWord[] {
  const tokens = text.trim().split(/\s+/u).filter(Boolean)

  if (!tokens.length) return []

  const span = Math.max(tokens.length, endMs - startMs)
  const totalChars = tokens.reduce((sum, token) => sum + token.length, 0)
  let cursor = startMs

  return tokens.map((token, index) => {
    const share = Math.round((span * token.length) / totalChars)
    const wordEnd = index === tokens.length - 1 ? Math.max(cursor, endMs) : cursor + share
    const word: AsrWord = { startMs: cursor, endMs: wordEnd, text: token }

    if (extra.speaker !== undefined) word.speaker = extra.speaker
    if (extra.confidence !== undefined) word.confidence = extra.confidence
    if (extra.language !== undefined) word.language = extra.language
    cursor = wordEnd
    return word
  })
}
