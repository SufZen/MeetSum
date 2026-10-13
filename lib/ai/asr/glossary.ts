import { envFlag, envNumber, type AsrEnv } from "./config"
import type { AsrGlossary, AsrWord, GlossaryTerm } from "./types"

/**
 * Pure glossary helpers: merging, provider hotwords / prompts and the
 * word-level replacement pass every provider result goes through.
 *
 * Matching is deliberately constrained (no fuzzy matching): a word matches
 * an alias only when its normalized form (NFKC, niqqud stripped, geresh
 * unified, lower-cased, edge punctuation removed) is identical. Hebrew
 * aliases may carry attached one-letter prefixes (ו ה ב כ ל מ ש, up to 3)
 * — `בסופבייס` → `ב-Supabase` — but only when the alias is distinctive
 * (first word ≥ 4 letters), so `גמה` never fires inside `מגמה`/`דוגמה`.
 */

const HEBREW_PREFIX_LETTERS = "והבכלמש"
const LATIN_LETTER = /\p{Script=Latin}/u
const HEBREW_LETTER = /\p{Script=Hebrew}/u
const EDGE_PUNCT = /^([\p{P}\p{S}]*)([\s\S]*?)([\p{P}\p{S}]*)$/u
const MIN_PREFIXABLE_LETTERS = 4

function cloneTerm(term: GlossaryTerm): GlossaryTerm {
  const copy: GlossaryTerm = { term: term.term, aliases: [...term.aliases], hotword: term.hotword }

  if (term.caseSensitive !== undefined) copy.caseSensitive = term.caseSensitive
  return copy
}

/**
 * Merges glossaries left to right. A later term with the same (case
 * insensitive) name overrides hotword/caseSensitive and unions aliases.
 */
export function mergeGlossary(...glossaries: Array<AsrGlossary | undefined>): AsrGlossary {
  const terms: GlossaryTerm[] = []
  const index = new Map<string, number>()

  for (const glossary of glossaries) {
    for (const term of glossary?.terms ?? []) {
      const key = term.term.trim().toLocaleLowerCase()

      if (!key) continue

      const existing = index.get(key)

      if (existing === undefined) {
        index.set(key, terms.length)
        terms.push(cloneTerm(term))
        continue
      }

      const current = terms[existing]
      const aliases = [...current.aliases]

      for (const alias of term.aliases) if (!aliases.includes(alias)) aliases.push(alias)
      terms[existing] = { ...cloneTerm(term), aliases }
    }
  }

  return { version: 1, terms }
}

/**
 * Hotword terms in priority order: Latin-script terms first (the ones
 * Hebrew models mangle), de-duplicated, whole terms only, cut off at the
 * first term that no longer fits; total joined
 * length (", " separators) ≤ maxChars.
 */
export function hotwordTerms(
  glossary: AsrGlossary,
  options: { maxChars?: number } = {}
): string[] {
  const maxChars = options.maxChars ?? 600
  const candidates = glossary.terms.filter((term) => term.hotword).map((term) => term.term.trim())
  const ordered = [
    ...candidates.filter((term) => LATIN_LETTER.test(term)),
    ...candidates.filter((term) => !LATIN_LETTER.test(term)),
  ]
  const seen = new Set<string>()
  const selected: string[] = []
  let length = 0

  for (const term of ordered) {
    const key = term.toLocaleLowerCase()

    if (!term || seen.has(key)) continue

    const added = (selected.length ? 2 : 0) + term.length

    if (length + added > maxChars) break
    seen.add(key)
    selected.push(term)
    length += added
  }

  return selected
}

/** Comma-separated hotwords string for faster-whisper style providers. */
export function buildHotwords(glossary: AsrGlossary, options: { maxChars?: number } = {}): string {
  return hotwordTerms(glossary, options).join(", ")
}

export function hotwordsMaxChars(env: AsrEnv): number {
  return envNumber(env, "MEETSUM_ASR_HOTWORDS_MAX_CHARS", 600)
}

/**
 * Optional Whisper initial prompt ("בפגישה הוזכרו: …"). Off unless
 * `MEETSUM_ASR_USE_INITIAL_PROMPT=true` — prompts can bias Whisper into
 * hallucinating the listed terms over silence.
 */
export function buildInitialPrompt(glossary: AsrGlossary, env: AsrEnv): string | undefined {
  if (!envFlag(env, "MEETSUM_ASR_USE_INITIAL_PROMPT")) return undefined

  const terms = hotwordTerms(glossary, { maxChars: hotwordsMaxChars(env) })

  return terms.length ? `בפגישה הוזכרו: ${terms.join(", ")}.` : undefined
}

function splitEdges(text: string): { lead: string; core: string; trail: string } {
  const match = EDGE_PUNCT.exec(text)

  return match ? { lead: match[1], core: match[2], trail: match[3] } : { lead: "", core: text, trail: "" }
}

/** Matching form of a token: NFKC, no niqqud, unified quotes, lower-cased. */
export function normalizeGlossaryToken(text: string, caseSensitive = false): string {
  const normalized = text
    .normalize("NFKC")
    .replace(/\p{M}/gu, "")
    .replace(/[׳‘’`]/gu, "'")
    .replace(/[״“”]/gu, '"')
  const { core } = splitEdges(normalized.trim())

  return caseSensitive ? core : core.toLocaleLowerCase()
}

type Matcher = {
  term: GlossaryTerm
  tokens: string[]
  allowPrefix: boolean
  caseSensitive: boolean
  weight: number
}

function letterCount(text: string) {
  return (text.match(/\p{L}/gu) ?? []).length
}

function buildMatchers(glossary: AsrGlossary): Matcher[] {
  const matchers: Matcher[] = []

  for (const term of glossary.terms) {
    const caseSensitive = term.caseSensitive === true
    const sources = [...term.aliases]

    // The canonical term itself is matched (case-insensitively) to restore
    // its casing: "supabase" → "Supabase".
    if (!caseSensitive && LATIN_LETTER.test(term.term)) sources.push(term.term)

    for (const source of sources) {
      const tokens = source
        .split(/\s+/u)
        .map((token) => normalizeGlossaryToken(token, caseSensitive))
        .filter(Boolean)

      if (!tokens.length) continue

      const hebrew = HEBREW_LETTER.test(tokens[0]) && !LATIN_LETTER.test(tokens[0])

      matchers.push({
        term,
        tokens,
        allowPrefix: hebrew && letterCount(tokens[0]) >= MIN_PREFIXABLE_LETTERS,
        caseSensitive,
        weight: tokens.join(" ").length,
      })
    }
  }

  return matchers.sort((a, b) => b.tokens.length - a.tokens.length || b.weight - a.weight)
}

function matchFirstToken(core: string, token: string, allowPrefix: boolean): string | undefined {
  if (core === token) return ""
  if (!allowPrefix) return undefined

  for (let length = 1; length <= 3 && length < core.length; length += 1) {
    const prefix = core.slice(0, length)

    if (![...prefix].every((char) => HEBREW_PREFIX_LETTERS.includes(char))) break

    const rest = core.slice(length).replace(/^[-־]/u, "")

    if (rest === token) return prefix
  }

  return undefined
}

function matchAt(words: AsrWord[], start: number, matcher: Matcher): { length: number; prefix: string } | undefined {
  const { tokens } = matcher

  if (start + tokens.length > words.length) return undefined

  let prefix = ""

  for (let offset = 0; offset < tokens.length; offset += 1) {
    const word = words[start + offset]
    const edges = splitEdges(word.text.trim())

    // Punctuation inside a multi-word match (e.g. a comma) breaks it.
    if (offset > 0 && edges.lead) return undefined
    if (offset < tokens.length - 1 && edges.trail) return undefined

    const core = normalizeGlossaryToken(word.text, matcher.caseSensitive)

    if (offset === 0) {
      const matched = matchFirstToken(core, tokens[0], matcher.allowPrefix)

      if (matched === undefined) return undefined
      prefix = matched
    } else if (core !== tokens[offset]) {
      return undefined
    }
  }

  return { length: tokens.length, prefix }
}

function minConfidence(words: AsrWord[]): number | undefined {
  const values = words
    .map((word) => word.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))

  return values.length ? Math.min(...values) : undefined
}

/**
 * Replaces glossary aliases in a word list. Multi-word matches merge into
 * one word (first start, last end, minimum confidence). Edge punctuation of
 * the matched span is preserved. Returns the new list and the number of
 * words whose text actually changed.
 */
export function applyGlossaryToWords(
  words: AsrWord[],
  glossary: AsrGlossary
): { words: AsrWord[]; replacements: number } {
  const matchers = buildMatchers(glossary)

  if (!matchers.length || !words.length) return { words: [...words], replacements: 0 }

  const output: AsrWord[] = []
  let replacements = 0
  let index = 0

  while (index < words.length) {
    let replaced = false

    for (const matcher of matchers) {
      const match = matchAt(words, index, matcher)

      if (!match) continue

      const span = words.slice(index, index + match.length)
      const lead = splitEdges(span[0].text.trim()).lead
      const trail = splitEdges(span[span.length - 1].text.trim()).trail
      const text = `${lead}${match.prefix ? `${match.prefix}-` : ""}${matcher.term.term}${trail}`

      if (span.length === 1 && text === span[0].text) break

      const merged: AsrWord = {
        startMs: span[0].startMs,
        endMs: Math.max(...span.map((word) => word.endMs)),
        text,
      }
      const confidence = minConfidence(span)

      if (confidence !== undefined) merged.confidence = confidence
      if (span[0].speaker !== undefined) merged.speaker = span[0].speaker
      output.push(merged)
      replacements += 1
      index += match.length
      replaced = true
      break
    }

    if (!replaced) {
      output.push(words[index])
      index += 1
    }
  }

  return { words: output, replacements }
}
