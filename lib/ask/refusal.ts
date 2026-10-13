/**
 * Refusal gate and model sentinel (docs/parity/m6.md, C5).
 *
 * - Before the LLM (retrieval mode): no passages, or a weak best vector match
 *   (`topSimilarity < MEETSUM_ASK_MIN_SIMILARITY`, or null when lexical)
 *   with no lexical hit -> localized refusal, no LLM call, no cost.
 * - After: the model answers exactly `<<NO_ANSWER>>` when the passages don't
 *   support an answer. The first 16 characters are buffered so the sentinel
 *   is never streamed to the client.
 */
import { NO_ANSWER_SENTINEL } from "@/lib/ask/prompt"

export const SENTINEL_BUFFER_CHARS = 16

export function shouldRefuseBeforeLlm(input: {
  passages: number
  topSimilarity: number | null
  lexicalHits: number
  minSimilarity: number
}): boolean {
  if (input.passages === 0) return true

  const weakVector = input.topSimilarity === null || input.topSimilarity < input.minSimilarity

  return weakVector && input.lexicalHits === 0
}

/** True when the model's whole answer is the sentinel (whitespace aside). */
export function isSentinelAnswer(text: string): boolean {
  return text.trim() === NO_ANSWER_SENTINEL || text.trim().startsWith(NO_ANSWER_SENTINEL)
}

/** Removes stray sentinels from an otherwise real answer. */
export function stripSentinel(text: string): string {
  return text.split(NO_ANSWER_SENTINEL).join("").trim()
}

/**
 * Holds back the start of the stream while it could still be the sentinel.
 * `push` returns the text that may be shown; once the buffer can no longer
 * be the sentinel everything passes straight through.
 */
export function createSentinelGate() {
  let buffer = ""
  let open = false

  return {
    push(delta: string): string {
      if (open) return delta
      buffer += delta

      const trimmed = buffer.trimStart()
      const couldBeSentinel =
        NO_ANSWER_SENTINEL.startsWith(trimmed.slice(0, NO_ANSWER_SENTINEL.length)) &&
        trimmed.length <= SENTINEL_BUFFER_CHARS

      if (couldBeSentinel || trimmed.startsWith(NO_ANSWER_SENTINEL)) return ""
      open = true

      const out = buffer

      buffer = ""
      return out
    },
    /** Remaining buffered text at the end (empty when it was the sentinel). */
    flush(): string {
      if (open) return ""

      const out = isSentinelAnswer(buffer) ? "" : buffer

      buffer = ""
      return out
    },
  }
}
