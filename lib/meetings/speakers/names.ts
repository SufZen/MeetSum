/**
 * Name normalization for speaker suggestions: NFKC, niqqud/cantillation and
 * other combining marks removed, geresh/gershayim/apostrophes inside words
 * removed, other punctuation → space, lowercase, whitespace collapsed.
 * Hebrew and Latin are never transliterated into each other — a Hebrew
 * spelling of a Latin name only matches through an alias.
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{M}/gu, "")
    .replace(/(?<=\p{L})["'׳״’](?=\p{L})/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

export function nameTokens(value: string): string[] {
  const normalized = normalizeName(value)

  return normalized ? normalized.split(" ") : []
}

/** Text prepared for intro regexes: marks stripped, case and punctuation kept. */
export function stripMarks(value: string): string {
  return value.normalize("NFKC").replace(/\p{M}/gu, "").replace(/’/gu, "'")
}

/** Generic diarization / placeholder names that never identify a person. */
export function isGenericSpeakerName(value: string): boolean {
  return /^(?:(?:speaker|דובר|דוברת)\s*\d*|google meet smart notes)$/iu.test(
    normalizeName(value)
  )
}

/** True when `tokens` starts with `prefix` (token-wise). */
export function startsWithTokens(tokens: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((token, index) => tokens[index] === token)
}

/** Index of `needle` as a contiguous token run inside `haystack`, else -1. */
export function indexOfTokens(haystack: readonly string[], needle: readonly string[]): number {
  if (!needle.length || needle.length > haystack.length) return -1

  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return start
  }

  return -1
}
