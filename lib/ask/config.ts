/**
 * AskMeetSum environment knobs (docs/parity/m6.md, "Env"). Pure reads of an
 * env record so tests can inject values.
 */
type Env = Record<string, string | undefined>

export type AskConfig = {
  maxPassages: number
  contextTokens: number
  fullTranscriptTokens: number
  historyTurns: number
  minSimilarity: number
  maxOutputTokens: number
  dailyLimitPerUser: number
  strictCitations: boolean
}

function int(value: string | undefined, fallback: number, min = 0): number {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed >= min ? Math.trunc(parsed) : fallback
}

function float(value: string | undefined, fallback: number): number {
  const parsed = Number(value)

  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback
}

export function getAskConfig(env: Env = process.env): AskConfig {
  return {
    maxPassages: int(env.MEETSUM_ASK_MAX_PASSAGES, 12, 1),
    contextTokens: int(env.MEETSUM_ASK_CONTEXT_TOKENS, 12_000, 500),
    fullTranscriptTokens: int(env.MEETSUM_ASK_FULL_TRANSCRIPT_TOKENS, 60_000),
    historyTurns: int(env.MEETSUM_ASK_HISTORY_TURNS, 6),
    minSimilarity: float(env.MEETSUM_ASK_MIN_SIMILARITY, 0.55),
    maxOutputTokens: int(env.MEETSUM_ASK_MAX_OUTPUT_TOKENS, 1_500, 64),
    dailyLimitPerUser: int(env.MEETSUM_ASK_DAILY_LIMIT_PER_USER, 200),
    strictCitations: !/^(0|false|no|off)$/i.test(env.MEETSUM_ASK_STRICT_CITATIONS?.trim() ?? "true"),
  }
}

/** Question length bounds (characters). */
export const ASK_QUESTION_MAX_CHARS = 2_000
