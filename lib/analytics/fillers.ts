/**
 * Filler-word detection (M5 D1). Heuristic: only standalone tokens count, so
 * `כאילו` inside `שכאילו` or `like` inside `likely` is never a filler, and
 * words such as "like"/"נו"/"בעצם" are counted even when used literally.
 * The rate is a conversational signal, not a grammar check.
 */
import { normalizeToken } from "@/lib/analytics/text"

/** Hebrew fillers (multi-word entries are matched as consecutive tokens). */
export const HEBREW_FILLERS = [
  "אה",
  "אהה",
  "אמ",
  "אממ",
  "כאילו",
  "בעצם",
  "נו",
  "יעני",
  "סתם",
  "וואלה",
  "זאתומרת",
  "זאת אומרת",
  "איך אומרים",
  "כזה",
] as const

/** English fillers (multi-word entries are matched as consecutive tokens). */
export const ENGLISH_FILLERS = [
  "um",
  "uh",
  "like",
  "you know",
  "basically",
  "actually",
  "i mean",
  "sort of",
  "kind of",
] as const

/** Elongated hesitations: אההה, אממממ, ummm, uhhh. */
const ELONGATED_HESITATION = /^(?:א+ה+|א+מ+|u+m+|u+h+)$/u

const FILLER_SEQUENCES: string[][] = [...HEBREW_FILLERS, ...ENGLISH_FILLERS]
  .map((filler) => filler.split(" ").map(normalizeToken))
  // Longest first, so "you know" wins over a shorter overlapping entry.
  .sort((a, b) => b.length - a.length)

function matchesAt(tokens: readonly string[], index: number, sequence: string[]): boolean {
  return sequence.every((part, offset) => tokens[index + offset] === part)
}

/**
 * Number of filler occurrences in already-normalized tokens. Multi-word
 * fillers consume all their tokens, so "you know" counts once.
 */
export function countFillers(tokens: readonly string[]): number {
  let count = 0
  let index = 0

  while (index < tokens.length) {
    const sequence = FILLER_SEQUENCES.find((candidate) => matchesAt(tokens, index, candidate))

    if (sequence) {
      count += 1
      index += sequence.length
    } else if (ELONGATED_HESITATION.test(tokens[index])) {
      count += 1
      index += 1
    } else {
      index += 1
    }
  }

  return count
}
