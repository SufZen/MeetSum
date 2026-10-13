export type WordErrorRateResult = {
  wer: number
  substitutions: number
  insertions: number
  deletions: number
  referenceWords: number
}

export type CharErrorRateResult = {
  cer: number
  substitutions: number
  insertions: number
  deletions: number
  referenceChars: number
}

export type TermRecallResult = {
  /** Glossary-term occurrences in the reference. */
  expected: number
  /** Of those, how many the hypothesis reproduced (capped per term). */
  found: number
  /** found / expected, or null when no term occurs in the reference. */
  recall: number | null
  /** Distinct glossary terms that occur in the reference. */
  terms: number
}

type EditCounts = {
  cost: number
  substitutions: number
  insertions: number
  deletions: number
}

/** Geresh / gershayim / ASCII and typographic quotes inside a word. */
const INNER_QUOTES = /(?<=[\p{L}\p{N}])['"׳״’”](?=[\p{L}\p{N}])/gu
/** Maqaf, hyphens, dashes and slashes separate words. */
const WORD_SEPARATORS = /[־\-‐-―/\\]+/gu

/**
 * Normalizes transcript text into comparable tokens:
 * NFKC → strip combining marks (niqqud, cantillation) → drop geresh,
 * gershayim and quotes between letters (צה״ל = צה"ל = צהל) → maqaf, hyphen
 * and slash become spaces → other punctuation becomes spaces → lowercase.
 */
export function normalizeTranscriptForWer(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/\p{M}+/gu, "")
    .replace(INNER_QUOTES, "")
    .replace(WORD_SEPARATORS, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function chooseBest(left: EditCounts, right: EditCounts) {
  if (left.cost !== right.cost) return left.cost < right.cost ? left : right
  const leftEdits = left.substitutions + left.insertions + left.deletions
  const rightEdits = right.substitutions + right.insertions + right.deletions

  return leftEdits <= rightEdits ? left : right
}

/** Levenshtein alignment counts between two token sequences (two-row DP). */
function editCounts(ref: readonly string[], hyp: readonly string[]): EditCounts {
  let previous: EditCounts[] = Array.from({ length: hyp.length + 1 }, (_, j) => ({
    cost: j,
    substitutions: 0,
    insertions: j,
    deletions: 0,
  }))

  for (let i = 1; i <= ref.length; i += 1) {
    const current: EditCounts[] = [
      { ...previous[0], cost: previous[0].cost + 1, deletions: previous[0].deletions + 1 },
    ]

    for (let j = 1; j <= hyp.length; j += 1) {
      if (ref[i - 1] === hyp[j - 1]) {
        current[j] = previous[j - 1]
        continue
      }

      const substitution = {
        ...previous[j - 1],
        cost: previous[j - 1].cost + 1,
        substitutions: previous[j - 1].substitutions + 1,
      }
      const insertion = {
        ...current[j - 1],
        cost: current[j - 1].cost + 1,
        insertions: current[j - 1].insertions + 1,
      }
      const deletion = {
        ...previous[j],
        cost: previous[j].cost + 1,
        deletions: previous[j].deletions + 1,
      }

      current[j] = chooseBest(chooseBest(substitution, insertion), deletion)
    }

    previous = current
  }

  return previous[hyp.length]
}

function errorRate(cost: number, referenceLength: number, hypothesisLength: number) {
  if (referenceLength) return cost / referenceLength

  return hypothesisLength ? 1 : 0
}

function werFromTokens(ref: string[], hyp: string[]): WordErrorRateResult {
  const result = editCounts(ref, hyp)

  return {
    wer: errorRate(result.cost, ref.length, hyp.length),
    substitutions: result.substitutions,
    insertions: result.insertions,
    deletions: result.deletions,
    referenceWords: ref.length,
  }
}

export function calculateWordErrorRate(
  reference: string,
  hypothesis: string
): WordErrorRateResult {
  return werFromTokens(
    normalizeTranscriptForWer(reference),
    normalizeTranscriptForWer(hypothesis)
  )
}

/** Character error rate over the normalized text (single spaces count). */
export function calculateCharErrorRate(
  reference: string,
  hypothesis: string
): CharErrorRateResult {
  const ref = Array.from(normalizeTranscriptForWer(reference).join(" "))
  const hyp = Array.from(normalizeTranscriptForWer(hypothesis).join(" "))
  const result = editCounts(ref, hyp)

  return {
    cer: errorRate(result.cost, ref.length, hyp.length),
    substitutions: result.substitutions,
    insertions: result.insertions,
    deletions: result.deletions,
    referenceChars: ref.length,
  }
}

function countSequence(tokens: readonly string[], needle: readonly string[]) {
  if (!needle.length) return 0

  let count = 0

  for (let i = 0; i + needle.length <= tokens.length; i += 1) {
    if (needle.every((token, offset) => tokens[i + offset] === token)) {
      count += 1
      i += needle.length - 1
    }
  }

  return count
}

/**
 * Recall of glossary terms: of the term occurrences in the reference, how
 * many the hypothesis reproduces in canonical form (per term, capped at the
 * reference count). Hebrew prefixes (`ב-Supabase`) are separated by the
 * normalization, so they still count.
 */
export function termRecall(
  reference: string,
  hypothesis: string,
  terms: readonly string[]
): TermRecallResult {
  const ref = normalizeTranscriptForWer(reference)
  const hyp = normalizeTranscriptForWer(hypothesis)
  const seen = new Set<string>()
  let expected = 0
  let found = 0
  let present = 0

  for (const term of terms) {
    const needle = normalizeTranscriptForWer(term)
    const key = needle.join(" ")

    if (!key || seen.has(key)) continue
    seen.add(key)

    const inReference = countSequence(ref, needle)

    if (!inReference) continue
    present += 1
    expected += inReference
    found += Math.min(inReference, countSequence(hyp, needle))
  }

  return {
    expected,
    found,
    recall: expected ? found / expected : null,
    terms: present,
  }
}

const LATIN = /\p{Script=Latin}/u

/** WER restricted to tokens that contain Latin letters (code-switching). */
export function latinTokenWer(
  reference: string,
  hypothesis: string
): WordErrorRateResult {
  const latin = (text: string) =>
    normalizeTranscriptForWer(text).filter((token) => LATIN.test(token))

  return werFromTokens(latin(reference), latin(hypothesis))
}
