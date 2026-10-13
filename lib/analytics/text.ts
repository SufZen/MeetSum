/**
 * Token helpers shared by the analytics heuristics (M5 D1). Pure and
 * isomorphic.
 */

const NIQQUD = /[֑-ׇ]/gu
/** Leading/trailing characters that are not part of a word. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/** NFKC, no niqqud, lower case, edge punctuation removed. */
export function normalizeToken(token: string): string {
  return token
    .normalize("NFKC")
    .replace(NIQQUD, "")
    .toLowerCase()
    .replace(EDGE_PUNCTUATION, "")
}

/** Word tokens (at least one letter or digit) of a text, normalized. */
export function tokenize(text: string): string[] {
  return text
    .split(/[\s־]+/u)
    .map(normalizeToken)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
}
