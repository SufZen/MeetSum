/**
 * Hebrew-aware text folding: the only text-folding authority for the
 * indexer, query builder, snippets, memory engine and eval
 * (docs/parity/m6.md, A1; owner: Package A).
 *
 * STEP 0 STUB: NFKC plus lower case only. Package A replaces the bodies
 * (niqqud, final letters, geresh/gershayim, maqaf, prefix variants).
 */
import type { NormalizedQuery, TextLanguage } from "@/lib/search/types"

/** Prefix stripping never leaves fewer letters than this. */
export const MIN_STEM_LETTERS = 3

/** Query tokens marked `stop` (kept, never dropped). */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set<string>()

export function foldText(s: string): string {
  return s.normalize("NFKC").toLowerCase()
}

/** Folded text plus, for each folded UTF-16 index, the source index. */
export function foldWithOffsets(s: string): { folded: string; map: number[] } {
  const folded = foldText(s)

  return { folded, map: Array.from({ length: folded.length }, (_, index) => index) }
}

export function tokenize(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

export function hebrewPrefixVariants(token: string): string[] {
  void token

  return []
}

export function normalizeForIndex(text: string): { norm: string; stems: string } {
  return { norm: tokenize(foldText(text)).join(" "), stems: "" }
}

export function normalizeQuery(q: string): NormalizedQuery {
  const folded = foldText(q)

  return {
    input: q,
    folded,
    tokens: tokenize(folded).map((raw) => ({ raw, variants: [], script: "mixed", stop: false })),
  }
}

export function detectTextLanguage(text: string): TextLanguage {
  return /[֐-׿]/.test(text) ? "he" : "en"
}
