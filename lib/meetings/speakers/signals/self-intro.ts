import { matchPhrase, type NameMatch, type SpeakerCandidate } from "@/lib/meetings/speakers/candidates"
import { nameTokens, stripMarks } from "@/lib/meetings/speakers/names"
import type { SignalContext } from "@/lib/meetings/speakers/signals/context"

export const SELF_INTRO_WINDOW_MS = 180_000
export const SELF_INTRO_WEIGHT = 0.75
export const WORKSPACE_MEMORY_WEIGHT = 0.1

/** "אני דנה", "שמי דנה כהן", "קוראים לי דנה" (Hebrew needs a word boundary before). */
const HEBREW_INTRO = /(?:^|[^\p{L}])(?:אני|שמי|קוראים לי)\s+(\S+(?:\s\S+)?)/gu
/** "my name is Dana", "this is Dana", "I'm Dana", "I am Dana" (capitalized name). */
const ENGLISH_INTRO = /(?:^|[^\p{L}])(?:[Mm]y name is|[Tt]his is|I'm|I am)\s+(\p{Lu}\p{L}+)/gu

const MATCH_RANK: Record<NameMatch, number> = { full: 3, first: 2, alias: 1 }

/** Names a segment's speaker introduces themselves with. */
export function extractSelfIntroductions(text: string): string[] {
  const prepared = stripMarks(text)
  const phrases: string[] = []

  for (const pattern of [HEBREW_INTRO, ENGLISH_INTRO]) {
    for (const match of prepared.matchAll(pattern)) phrases.push(match[1])
  }

  return phrases
}

/** The single best candidate a phrase names (ambiguous best tier → none). */
export function resolvePhrase(
  phrase: string,
  candidates: readonly SpeakerCandidate[]
): { candidate: SpeakerCandidate; match: NameMatch } | undefined {
  const tokens = nameTokens(phrase)

  if (!tokens.length) return undefined

  const matches = candidates
    .map((candidate) => ({ candidate, match: matchPhrase(tokens, candidate) }))
    .filter(
      (entry): entry is { candidate: SpeakerCandidate; match: NameMatch } => Boolean(entry.match)
    )

  if (!matches.length) return undefined

  const best = Math.max(...matches.map((entry) => MATCH_RANK[entry.match]))
  const top = matches.filter((entry) => MATCH_RANK[entry.match] === best)

  return top.length === 1 ? top[0] : undefined
}

/**
 * self_intro: within the first 180 s, a speaker says "אני דנה" / "I'm Dana"
 * and the name (niqqud-insensitive, aliases for Hebrew↔Latin) resolves to one
 * candidate → 0.75; an alias hit adds workspace_memory (0.1).
 */
export function selfIntroSignal(context: SignalContext) {
  for (const speaker of context.speakers) {
    const seen = new Set<string>()

    for (const segment of context.segmentsBySpeaker.get(speaker.id) ?? []) {
      if (segment.startMs >= SELF_INTRO_WINDOW_MS) continue

      for (const phrase of extractSelfIntroductions(segment.text)) {
        const resolved = resolvePhrase(phrase, context.candidates)

        if (!resolved || seen.has(resolved.candidate.key)) continue
        seen.add(resolved.candidate.key)

        const name = nameTokens(phrase)[0]

        context.book.add(speaker.id, resolved.candidate.key, {
          kind: "self_intro",
          detail: `Introduced themselves as "${name}"`,
          weight: SELF_INTRO_WEIGHT,
        })
        if (resolved.match === "alias") {
          context.book.add(speaker.id, resolved.candidate.key, {
            kind: "workspace_memory",
            detail: `"${name}" is a known alias of ${resolved.candidate.name}`,
            weight: WORKSPACE_MEMORY_WEIGHT,
          })
        }
      }
    }
  }
}
