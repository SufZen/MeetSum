/**
 * Per-turn sentiment via the `sentiment` LLM task (M5 D2).
 *
 * Speaker turns (consecutive segments of one speaker) are truncated to 600
 * characters and sent in batches of at most 40. Each turn is cached by the
 * sha1 of its text, so a re-run only classifies turns that changed. Results
 * are aggregated per speaker, per chapter and for the whole meeting. A failed
 * batch is non-fatal: its turns are counted in `failedTurns`.
 */
import { z } from "zod"

import { speakerKey } from "@/lib/analytics/compute"
import type {
  MeetingSentiment,
  SentimentAggregate,
  SentimentLabel,
  SentimentTurn,
} from "@/lib/analytics/types"
import { describeLlmFailure, generateStructured, interactiveLlmOptions } from "@/lib/ai/llm"
import type { Chapter } from "@/lib/intelligence"
import { sha1Hex } from "@/lib/intelligence/normalize"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"

export const SENTIMENT_PROMPT_VERSION = "m5.sentiment.1"
export const SENTIMENT_BATCH_SIZE = 40
export const SENTIMENT_TURN_MAX_CHARS = 600

const SENTIMENT_LABELS = ["positive", "neutral", "negative", "mixed"] as const

export const sentimentResponseSchema = z.object({
  turns: z.array(
    z.object({
      turn: z.string(),
      label: z.enum(SENTIMENT_LABELS),
      score: z.number(),
    })
  ),
})

export type SentimentResponse = z.infer<typeof sentimentResponseSchema>

export type AnalyzeSentimentInput = {
  workspaceId: string
  meetingId: string
  segments: TranscriptSegment[]
  speakers: MeetingSpeaker[]
  chapters?: Chapter[]
  language: string
  /** Previous result: its cached turns are reused by text hash. */
  previous?: MeetingSentiment
  jobId?: string
  /** A user is waiting (POST): 60s deadline and one transport retry per batch. */
  interactive?: boolean
}

export type SpeakerTurn = {
  alias: string
  speakerKey: string
  speakerId?: string
  speakerLabel: string
  startMs: number
  text: string
  hash: string
}

/** Consecutive segments of the same speaker, in time order. */
export function buildSpeakerTurns(segments: TranscriptSegment[]): SpeakerTurn[] {
  const turns: Array<Omit<SpeakerTurn, "alias" | "hash">> = []

  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    const text = segment.text.trim()

    if (!text) continue

    const key = speakerKey(segment)
    const last = turns[turns.length - 1]

    if (last && last.speakerKey === key) {
      last.text = `${last.text} ${text}`
    } else {
      turns.push({
        speakerKey: key,
        speakerId: segment.speakerId,
        speakerLabel: segment.speaker,
        startMs: segment.startMs,
        text,
      })
    }
  }

  return turns.map((turn, index) => {
    const text = turn.text.slice(0, SENTIMENT_TURN_MAX_CHARS)

    return { ...turn, text, alias: `t${index + 1}`, hash: sha1Hex(text) }
  })
}

function sentimentInstructions(language: string, turns: SpeakerTurn[]): string {
  const lines = turns.map((turn) => `[${turn.alias}] ${turn.text.replace(/\s+/g, " ")}`).join("\n")

  if (language === "he") {
    return [
      "סווג/י את הסנטימנט של כל תור דיבור בפגישה עסקית.",
      "לכל תור החזר/י label (positive / neutral / negative / mixed) ו-score בין -1 ל-1.",
      "ברירת המחדל היא neutral: דיון ענייני, שאלות ועדכוני סטטוס הם ניטרליים.",
      "שים/י לב לציניות ולאירוניה בעברית מדוברת (\"יופי, עוד עיכוב\" הוא שלילי) ולביטויים כמו \"סבבה\", \"אחלה\", \"וואלה\".",
      "אל תסיק/י רגש ממילים טכניות באנגלית. החזר/י רק את מזהי התורים שמופיעים למטה.",
      "",
      lines,
    ].join("\n")
  }

  return [
    "Classify the sentiment of each speaker turn from a business meeting.",
    "For every turn return a label (positive / neutral / negative / mixed) and a score from -1 to 1.",
    "Default to neutral: factual discussion, questions and status updates are neutral.",
    "Watch for sarcasm and irony (\"great, another delay\" is negative). Turns may mix Hebrew and English.",
    "Only return turn ids listed below.",
    "",
    lines,
  ].join("\n")
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0

  return Math.max(-1, Math.min(1, Math.round(score * 1000) / 1000))
}

/**
 * Aggregate label: `mixed` when at least a quarter of the turns are positive
 * and a quarter negative; otherwise by mean score (±0.2), neutral between.
 */
export function aggregateSentiment(
  turns: ReadonlyArray<Pick<SentimentTurn, "label" | "score">>
): SentimentAggregate {
  if (!turns.length) return { label: "neutral", score: 0, turns: 0 }

  const score = turns.reduce((sum, turn) => sum + turn.score, 0) / turns.length
  const positives = turns.filter((turn) => turn.label === "positive").length
  const negatives = turns.filter((turn) => turn.label === "negative").length
  let label: SentimentLabel = "neutral"

  if (positives / turns.length >= 0.25 && negatives / turns.length >= 0.25) label = "mixed"
  else if (score >= 0.2) label = "positive"
  else if (score <= -0.2) label = "negative"

  return { label, score: Math.round(score * 1000) / 1000, turns: turns.length }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

/**
 * Classifies the meeting's speaker turns and aggregates them. Returns
 * undefined when nothing could be classified (no turns, or every batch
 * failed with no cached turns to fall back on).
 */
export async function analyzeSentiment(
  input: AnalyzeSentimentInput
): Promise<{ sentiment: MeetingSentiment; aiRunId?: string } | undefined> {
  const turns = buildSpeakerTurns(input.segments)

  if (!turns.length) return undefined

  const cache = new Map((input.previous?.turns ?? []).map((turn) => [turn.hash, turn]))
  const classified = new Map<string, SentimentTurn>()
  const pending: SpeakerTurn[] = []

  for (const turn of turns) {
    const cached = cache.get(turn.hash)

    if (cached) {
      classified.set(turn.alias, { ...cached, speakerKey: turn.speakerKey, startMs: turn.startMs })
    } else {
      pending.push(turn)
    }
  }

  let failedTurns = 0
  let aiRunId: string | undefined
  let provider = input.previous?.provider
  let model = input.previous?.model

  for (const batch of chunk(pending, SENTIMENT_BATCH_SIZE)) {
    const aliases = new Set(batch.map((turn) => turn.alias))

    try {
      const result = await generateStructured<SentimentResponse>({
        task: "sentiment",
        ctx: {
          workspaceId: input.workspaceId,
          meetingId: input.meetingId,
          jobId: input.jobId,
          promptVersion: SENTIMENT_PROMPT_VERSION,
        },
        language: input.language,
        instructions: sentimentInstructions(input.language, batch),
        schema: { name: "turn_sentiment", zod: sentimentResponseSchema },
        effort: "low",
        validate: (value) =>
          value.turns.filter((item) => !aliases.has(item.turn)).map((item) => `unknown turn id ${item.turn}`),
        ...(input.interactive ? interactiveLlmOptions() : {}),
      })
      const byAlias = new Map(batch.map((turn) => [turn.alias, turn]))

      for (const item of result.value.turns) {
        const turn = byAlias.get(item.turn)

        if (!turn) continue
        classified.set(turn.alias, {
          hash: turn.hash,
          speakerKey: turn.speakerKey,
          startMs: turn.startMs,
          label: item.label,
          score: clampScore(item.score),
        })
      }
      failedTurns += batch.filter((turn) => !classified.has(turn.alias)).length
      aiRunId = result.aiRunId ?? aiRunId
      provider = result.provider
      model = result.model
    } catch (error) {
      failedTurns += batch.length
      // Error kind only: provider/parse messages can carry model output.
      console.warn(`[sentiment] batch failed for meeting ${input.meetingId}: ${describeLlmFailure(error)}`)
    }
  }

  const sentiment = summarizeSentiment(turns, classified, input, { failedTurns, provider, model })

  return sentiment ? { sentiment, aiRunId } : undefined
}

function summarizeSentiment(
  turns: SpeakerTurn[],
  classified: Map<string, SentimentTurn>,
  context: Pick<AnalyzeSentimentInput, "speakers" | "chapters">,
  meta: Pick<MeetingSentiment, "failedTurns" | "provider" | "model" | "computedAt">
): MeetingSentiment | undefined {
  const results = turns.flatMap((turn) => {
    const value = classified.get(turn.alias)

    return value ? [value] : []
  })

  if (!results.length) return undefined

  const speakersById = new Map(context.speakers.map((speaker) => [speaker.id, speaker]))
  const bySpeaker = [...new Set(turns.map((turn) => turn.speakerKey))].flatMap((key) => {
    const first = turns.find((turn) => turn.speakerKey === key)!
    const known = first.speakerId ? speakersById.get(first.speakerId) : undefined
    const own = results.filter((turn) => turn.speakerKey === key)

    return own.length
      ? [
          {
            speakerKey: key,
            speakerId: first.speakerId,
            speakerLabel: known?.label ?? first.speakerLabel,
            displayName: known?.displayName,
            ...aggregateSentiment(own),
          },
        ]
      : []
  })
  const byChapter = (context.chapters ?? []).map((chapter) => ({
    chapterId: chapter.id,
    ...aggregateSentiment(
      results.filter((turn) => turn.startMs >= chapter.startMs && turn.startMs < chapter.endMs)
    ),
  }))

  return {
    bySpeaker,
    byChapter,
    overall: aggregateSentiment(results),
    turns: results,
    failedTurns: meta.failedTurns ?? 0,
    provider: meta.provider,
    model: meta.model,
    computedAt: meta.computedAt ?? new Date().toISOString(),
  }
}

/**
 * Re-aggregates a stored sentiment against the current transcript and
 * speakers from cached turns only (no LLM call): after an M3 speaker merge or
 * rename, turns are regrouped; turns whose text changed are left out.
 */
export function reaggregateSentiment(
  previous: MeetingSentiment,
  context: Pick<AnalyzeSentimentInput, "segments" | "speakers" | "chapters">
): MeetingSentiment | undefined {
  const turns = buildSpeakerTurns(context.segments)
  const cache = new Map((previous.turns ?? []).map((turn) => [turn.hash, turn]))
  const classified = new Map<string, SentimentTurn>()

  for (const turn of turns) {
    const cached = cache.get(turn.hash)

    if (cached) classified.set(turn.alias, { ...cached, speakerKey: turn.speakerKey, startMs: turn.startMs })
  }

  return summarizeSentiment(turns, classified, context, {
    failedTurns: turns.length - classified.size,
    provider: previous.provider,
    model: previous.model,
    computedAt: previous.computedAt,
  })
}

/**
 * Sentiment is on unless `MEETSUM_SENTIMENT_ENABLED=false` or the workspace
 * setting `aiFeatures.sentiment` is false.
 */
export function isSentimentEnabled(
  settings: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  if (env.MEETSUM_SENTIMENT_ENABLED === "false") return false

  const features = (settings as { aiFeatures?: { sentiment?: unknown } } | undefined)?.aiFeatures

  return features?.sentiment !== false
}
