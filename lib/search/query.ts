/**
 * Query builders for the lexical legs (docs/parity/m6.md, B1; owner: Package B).
 *
 * The tsquery string is always bound as a parameter (`to_tsquery('simple', $n)`);
 * lexemes are additionally quoted and escaped so user input can never form
 * tsquery operators.
 */
import type { NormalizedQuery, QueryToken } from "@/lib/search/types"

/** Prefix matching (`:*`) only for lexemes at least this long. */
const PREFIX_MIN_CHARS = 3
/** Hard cap on query groups (questions can be long). */
export const MAX_QUERY_GROUPS = 32

/** Quoted tsquery lexeme with `' : & | ! \` escaped. */
export function escapeLexeme(lexeme: string): string {
  return `'${lexeme.replace(/['\\:&|!]/g, (char) => `\\${char}`)}'`
}

/** Tokens that take part in the FTS OR group (stop tokens only when alone). */
export function activeTokens(nq: NormalizedQuery): QueryToken[] {
  const nonStop = nq.tokens.filter((token) => !token.stop)

  return (nonStop.length ? nonStop : nq.tokens).slice(0, MAX_QUERY_GROUPS)
}

function lexeme(value: string, token: QueryToken): string {
  const prefix = token.script !== "number" && [...value].length >= PREFIX_MIN_CHARS

  return prefix ? `${escapeLexeme(value)}:*` : escapeLexeme(value)
}

/**
 * `(raw | v1 | v2:*…) | (…)`: one group per active token, groups ORed. Null
 * when the query has no tokens.
 */
export function buildTsQuery(nq: NormalizedQuery): string | null {
  const groups: string[] = []
  const seen = new Set<string>()

  for (const token of activeTokens(nq)) {
    const lexemes = [token.raw, ...token.variants].filter((value) => value.length > 0)
    const key = lexemes.join("\u0000")

    if (!lexemes.length || seen.has(key)) continue
    seen.add(key)
    groups.push(`(${[...new Set(lexemes)].map((value) => lexeme(value, token)).join(" | ")})`)
  }

  return groups.length ? groups.join(" | ") : null
}

/** Trigram query caps: the trigram leg's cost grows with the query length. */
export const MAX_TRGM_TOKENS = 8
export const MAX_TRGM_CHARS = 120

/**
 * Trigram query: the folded text (first 8 tokens, at most 120 characters)
 * when it has at least 3 characters.
 */
export function trgmQuery(nq: NormalizedQuery): string | null {
  const words = nq.folded.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TRGM_TOKENS).join(" ")
  const capped = [...words].slice(0, MAX_TRGM_CHARS).join("").trim()

  return [...capped].length >= 3 ? capped : null
}
