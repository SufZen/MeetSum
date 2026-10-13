/**
 * "No citation, no claim" (docs/parity/m6.md, C4).
 *
 * On `done` the answer is split into sentences (Hebrew/Latin aware: it keeps
 * abbreviations and decimal numbers together and attaches markers written
 * after the full stop, `…אושר. [s1]`, to their sentence). In strict mode
 * every sentence without a valid marker is removed, except one leading
 * framing sentence of at most 12 words with no digits, names or quotes.
 */
import { citedAliases, hasValidMarker, type AliasMap } from "@/lib/ask/citations"

export const FRAMING_MAX_WORDS = 12

const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "eg",
  "ie",
  "etc",
  "vs",
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "no",
  "st",
  "inc",
  "ltd",
  "co",
  "jr",
  "sr",
  "approx",
  "fig",
  "cf",
])
const SENTENCE_END = /[.!?…]/
const CLOSERS = /["'”’)\]»״׳]/
const TRAILING_MARKERS = /^(?:\s*\[\s*[sa]\d+(?:\s*[,;]\s*[sa]\d+)*\s*\])+/i
const BULLET = /^(\s*(?:[-*•]|\d{1,3}[.)])\s+)(.*)$/

function wordBefore(text: string, index: number): string {
  const match = text.slice(0, index).match(/([\p{L}.]+)$/u)

  return (match?.[1] ?? "").toLowerCase()
}

function isAbbreviation(text: string, index: number): boolean {
  if (text[index] !== ".") return false

  const word = wordBefore(text, index)

  if (!word) return false
  if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(word.replace(/\./g, ""))) return true
  // Initials ("J. Smith") and dotted acronyms ("U.S.").
  return /^[a-z]$/i.test(word) || /^(?:[a-z]\.)+[a-z]$/i.test(word)
}

/** Splits one line (no newlines) into sentences, markers kept with their sentence. */
export function splitSentences(line: string): string[] {
  const sentences: string[] = []
  let start = 0
  let index = 0

  while (index < line.length) {
    if (!SENTENCE_END.test(line[index]) || isAbbreviation(line, index)) {
      index += 1
      continue
    }

    let end = index + 1

    while (end < line.length && (SENTENCE_END.test(line[end]) || CLOSERS.test(line[end]))) end += 1

    // A bare ellipsis is a pause inside the sentence, not its end.
    if (/^(?:…+|\.{3,})$/.test(line.slice(index, end))) {
      index = end
      continue
    }

    const markers = line.slice(end).match(TRAILING_MARKERS)

    if (markers) end += markers[0].length
    if (end < line.length && !/\s/.test(line[end])) {
      index = end
      continue
    }

    const sentence = line.slice(start, end).trim()

    if (sentence) sentences.push(sentence)
    start = end
    index = end
  }

  const rest = line.slice(start).trim()

  if (rest) sentences.push(rest)
  return sentences
}

function containsName(sentence: string, names: readonly string[]): boolean {
  const words = sentence.split(/\s+/).slice(1)

  if (words.some((word) => /^[A-Z][a-z]/.test(word.replace(/^["'(]/, "")))) return true
  return names.some((name) => name.length >= 2 && sentence.includes(name))
}

/** A short leading sentence that frames the answer without claiming anything. */
export function isFramingSentence(sentence: string, names: readonly string[] = []): boolean {
  const words = sentence.trim().split(/\s+/).filter(Boolean)

  return (
    words.length > 0 &&
    words.length <= FRAMING_MAX_WORDS &&
    !/\p{Nd}/u.test(sentence) &&
    !/["“”״'‘’]/.test(sentence.replace(/(?<=\p{L})['׳](?=\p{L})/gu, "")) &&
    !containsName(sentence, names)
  )
}

export type ClaimsResult = {
  content: string
  droppedUncitedSentences: number
  citedSentences: number
}

/** Names that disqualify a framing sentence: speakers and meeting titles. */
export function namesOf(aliases: AliasMap): string[] {
  const names = new Set<string>()

  for (const entry of Object.values(aliases)) {
    if (entry.speakerName) names.add(entry.speakerName)
    if (entry.meetingTitle) names.add(entry.meetingTitle)
  }
  return [...names]
}

/** Removes uncited sentences (strict mode) and reports what was dropped. */
export function enforceCitations(
  content: string,
  aliases: AliasMap,
  options: { strict: boolean; names?: readonly string[] }
): ClaimsResult {
  const names = options.names ?? namesOf(aliases)
  const lines: string[] = []
  let dropped = 0
  let cited = 0
  let seenFirst = false

  for (const rawLine of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (!rawLine.trim()) {
      lines.push("")
      continue
    }

    const bullet = rawLine.match(BULLET)
    const prefix = bullet ? bullet[1].trimStart() : ""
    const body = bullet ? bullet[2] : rawLine
    const kept: string[] = []

    for (const sentence of splitSentences(body)) {
      const first = !seenFirst

      seenFirst = true
      if (hasValidMarker(sentence, aliases)) {
        cited += 1
        kept.push(sentence)
      } else if (!options.strict || (first && isFramingSentence(sentence, names))) {
        kept.push(sentence)
      } else {
        dropped += 1
      }
    }
    if (kept.length) lines.push(prefix + kept.join(" "))
  }

  return {
    content: lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    droppedUncitedSentences: dropped,
    citedSentences: cited,
  }
}

/** True when the (enforced) content cites at least one valid alias. */
export function isGrounded(content: string, aliases: AliasMap): boolean {
  return citedAliases(content, aliases).length > 0
}
