/**
 * Citation mapping and the faithfulness guard (A7). Models cite segment
 * aliases only; unknown aliases are dropped, and a quote that is not a
 * normalized substring of the segment it cites drops that citation. No
 * citation, no claim: only resolvable refs reach the UI.
 */
import type { SummaryItemRef } from "@/lib/intelligence/types"
import type { TranscriptSegment } from "@/lib/meetings/repository"

import type { PromptTranscript } from "./transcript-format"

const NIQQUD = /[\u0591-\u05c7]/g
const QUOTE_MARKS = /["'`\u05f3\u05f4\u201c\u201d\u2018\u2019\u201e]/g

/** NFKC, no niqqud or quote marks, punctuation -> space, lowercase, single spaces. */
export function normalizeForQuote(text: string): string {
  return text
    .normalize("NFKC")
    // Maqaf first: it sits inside the niqqud range.
    .replace(/[\u05be\-\u2013\u2014]/g, " ")
    .replace(NIQQUD, "")
    .replace(QUOTE_MARKS, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeAlias(alias: string): string {
  return alias.trim().replace(/^\[|\]$/g, "").toLowerCase()
}

export function resolveAlias(
  alias: string | undefined,
  transcript: PromptTranscript
): TranscriptSegment | undefined {
  return alias ? transcript.aliasToSegment.get(normalizeAlias(alias)) : undefined
}

/** Resolves aliases to refs; unknown aliases are dropped, duplicates merged. */
export function resolveRefs(aliases: readonly string[], transcript: PromptTranscript): SummaryItemRef[] {
  const seen = new Set<string>()
  const refs: SummaryItemRef[] = []

  for (const alias of aliases) {
    const segment = resolveAlias(alias, transcript)

    if (!segment || seen.has(segment.id)) continue
    seen.add(segment.id)
    refs.push({ segmentId: segment.id, startMs: segment.startMs })
  }

  return refs.sort((left, right) => left.startMs - right.startMs)
}

/** True when `quote` appears (normalized) inside the segment text. */
export function quoteMatchesSegment(quote: string, segment: Pick<TranscriptSegment, "text">): boolean {
  const normalizedQuote = normalizeForQuote(quote)

  return Boolean(normalizedQuote) && normalizeForQuote(segment.text).includes(normalizedQuote)
}

export type ActionItemSource = {
  segment?: TranscriptSegment
  /** Verified quote (or the cited segment's text when none was given). */
  quote: string
}

/**
 * Validates an action item's source. A valid alias with a matching (or
 * missing) quote keeps the citation; a fabricated quote drops it.
 */
export function resolveActionItemSource(
  sourceRef: string | undefined,
  sourceQuote: string | undefined,
  transcript: PromptTranscript
): ActionItemSource {
  const segment = resolveAlias(sourceRef, transcript)

  if (!segment) return { quote: "" }

  const quote = sourceQuote?.trim()

  if (!quote) return { segment, quote: segment.text }
  return quoteMatchesSegment(quote, segment) ? { segment, quote } : { quote: "" }
}
