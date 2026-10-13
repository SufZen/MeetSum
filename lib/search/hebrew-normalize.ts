/**
 * Hebrew-aware text folding: the only text-folding authority for the
 * indexer, query builder, snippet highlighter, memory engine and eval
 * (docs/parity/m6.md, A1; owner: Package A).
 *
 * Folding pipeline (per code point, then three passes over the output):
 *   1. NFKC.
 *   2. Strip cantillation (U+0591–U+05AF) and points (U+05B0–U+05BD,
 *      U+05BF, U+05C1–U+05C2, U+05C4–U+05C5, U+05C7); drop format
 *      characters (bidi marks, zero-width joiners).
 *   3. Maqaf U+05BE, paseq U+05C0 and sof pasuq U+05C3 become spaces.
 *   4. Geresh/gershayim (`׳ ״ ' " ’`) right after a Hebrew letter are
 *      removed (`צה״ל→צהל`, `דו"ח→דוח`, `ג׳ירה→גירה`).
 *   5. Final letters fold (`ך→כ ם→מ ן→נ ף→פ ץ→צ`); display keeps the
 *      original through `foldWithOffsets`.
 *   6. Latin is lower-cased.
 *   7. A hyphen-attached prefix (`ב-Supabase`, `ה-API`, `וב-2026`) is
 *      dropped, leaving the bare word.
 *   8. Thousands separators go (`1,200→1200`); `3.5`, `Q3`, `v2` stay.
 * `tokenize` then splits on everything else. Short tokens are kept; only a
 * bare one-letter prefix letter is dropped. Prefix stripping happens in
 * `hebrewPrefixVariants`, never in the raw tokens, so exact matches rank
 * higher (raw tokens are weight A, variants weight B).
 */
import type { NormalizedQuery, QueryToken, TextLanguage } from "@/lib/search/types"

/** Prefix stripping never leaves fewer letters than this. */
export const MIN_STEM_LETTERS = 3

/**
 * Query tokens marked `stop`. They only prune the FTS OR group when other
 * tokens remain (Package B); they are never dropped and never applied at
 * index time.
 */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "של",
  "את",
  "על",
  "עם",
  "עמ", // folded form of עם
  "זה",
  "גם",
  "גמ",
  "כי",
  "אם",
  "אמ",
  "או",
  "אבל",
  "the",
  "a",
  "of",
  "to",
  "and",
])

const FINAL_LETTERS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" }
const GERESH = new Set(["׳", "״", "'", '"', "’"])
const HYPHENS = new Set(["-", "‐", "‑"])
const PREFIX_LETTERS = new Set(["ו", "ה", "ב", "כ", "ל", "מ", "ש"])
const PREFIX_CHAIN = /^(ו)?(ש|כש|מש)?(ב|כ|ל|מ)?(ה)?$/
const MAX_VARIANTS = 3
const MIN_VARIANT_TOKEN_LETTERS = 4
const LATIN_STEM_MIN_LENGTH = 5

const PREFIX_GROUPS: readonly (readonly string[])[] = [
  ["", "ו"],
  ["", "ש", "כש", "מש"],
  ["", "ב", "כ", "ל", "מ"],
  ["", "ה"],
]

/** Every non-empty prefix the chain `^(ו)?(ש|כש|מש)?(ב|כ|ל|מ)?(ה)?` can produce. */
const PREFIX_CHAINS: readonly string[] = (() => {
  let chains = [""]

  for (const group of PREFIX_GROUPS) {
    chains = chains.flatMap((chain) => group.map((part) => chain + part))
  }

  return [...new Set(chains)].filter(Boolean)
})()

function isHebrewLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "א" && ch <= "ת"
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9"
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{M}\p{N}]/u.test(ch)
}

function isStrippedMark(code: number): boolean {
  return (
    (code >= 0x0591 && code <= 0x05bd) ||
    code === 0x05bf ||
    code === 0x05c1 ||
    code === 0x05c2 ||
    code === 0x05c4 ||
    code === 0x05c5 ||
    code === 0x05c7
  )
}

function isHebrewSeparator(code: number): boolean {
  return code === 0x05be || code === 0x05c0 || code === 0x05c3
}

type Unit = { ch: string; src: number }

/** Steps 1–3, 5, 6: per code point, each output UTF-16 unit keeps its source index. */
function mapCodePoints(s: string): Unit[] {
  const out: Unit[] = []
  let index = 0

  for (const cp of s) {
    const start = index

    index += cp.length
    const normalized = cp.normalize("NFKC")

    for (const part of normalized) {
      const code = part.codePointAt(0) ?? 0

      if (isStrippedMark(code) || /\p{Cf}/u.test(part)) continue
      if (isHebrewSeparator(code)) {
        out.push({ ch: " ", src: start })
        continue
      }

      const folded = FINAL_LETTERS[part] ?? part.toLowerCase()
      const sameShape = folded.length === cp.length

      for (let offset = 0; offset < folded.length; offset += 1) {
        out.push({ ch: folded[offset], src: sameShape ? start + offset : start })
      }
    }
  }

  return out
}

/** Step 4: geresh/gershayim right after a Hebrew letter. */
function removeGeresh(units: Unit[]): Unit[] {
  const out: Unit[] = []

  for (const unit of units) {
    if (GERESH.has(unit.ch) && isHebrewLetter(out[out.length - 1]?.ch)) continue
    out.push(unit)
  }

  return out
}

/** Step 7: `ב-Supabase`, `וב-2026` → the bare word, at a word start only. */
function removeHyphenPrefixes(units: Unit[]): Unit[] {
  const out: Unit[] = []
  let index = 0

  while (index < units.length) {
    if (isHebrewLetter(units[index].ch) && !isWordChar(out[out.length - 1]?.ch)) {
      let end = index

      while (end < units.length && end - index < 4 && isHebrewLetter(units[end].ch)) end += 1
      const run = units
        .slice(index, end)
        .map((unit) => unit.ch)
        .join("")

      if (
        end - index <= 3 &&
        HYPHENS.has(units[end]?.ch ?? "") &&
        isWordChar(units[end + 1]?.ch) &&
        PREFIX_CHAIN.test(run)
      ) {
        index = end + 1
        continue
      }
    }

    out.push(units[index])
    index += 1
  }

  return out
}

/** Step 8: `1,200` → `1200` (a comma followed by exactly three digits). */
function removeThousandsSeparators(units: Unit[]): Unit[] {
  return units.filter((unit, index) => {
    if (unit.ch !== ",") return true

    return !(
      isDigit(units[index - 1]?.ch) &&
      isDigit(units[index + 1]?.ch) &&
      isDigit(units[index + 2]?.ch) &&
      isDigit(units[index + 3]?.ch) &&
      !isDigit(units[index + 4]?.ch)
    )
  })
}

function foldUnits(s: string): Unit[] {
  return removeThousandsSeparators(removeHyphenPrefixes(removeGeresh(mapCodePoints(s))))
}

export function foldText(s: string): string {
  return foldUnits(s)
    .map((unit) => unit.ch)
    .join("")
}

/**
 * Folded text plus, for each folded UTF-16 index, the index in `s` it came
 * from (`map.length === folded.length`). A folded end offset equal to
 * `folded.length` corresponds to `s.length`.
 */
export function foldWithOffsets(s: string): { folded: string; map: number[] } {
  const units = foldUnits(s)

  return { folded: units.map((unit) => unit.ch).join(""), map: units.map((unit) => unit.src) }
}

const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]*\p{N}(?:\.\p{N}+)+|[\p{L}\p{M}\p{N}]+/gu

/** Tokens of folded text; drops only bare one-letter Hebrew prefix letters. */
export function tokenize(folded: string): string[] {
  return (folded.match(TOKEN_PATTERN) ?? []).filter(
    (token) => !(token.length === 1 && PREFIX_LETTERS.has(token))
  )
}

function isHebrewWord(token: string): boolean {
  return [...token].every(isHebrewLetter)
}

/**
 * Prefix-stripped variants of a folded Hebrew token of 4+ letters: every
 * strip point of `^(ו)?(ש|כש|מש)?(ב|כ|ל|מ)?(ה)?` whose remainder keeps at
 * least `MIN_STEM_LETTERS` letters, longest remainder first, at most three.
 */
export function hebrewPrefixVariants(token: string): string[] {
  if (token.length < MIN_VARIANT_TOKEN_LETTERS || !isHebrewWord(token)) return []

  const lengths = new Set<number>()

  for (const chain of PREFIX_CHAINS) {
    if (token.startsWith(chain) && token.length - chain.length >= MIN_STEM_LETTERS) {
      lengths.add(chain.length)
    }
  }

  return [...lengths]
    .sort((a, b) => a - b)
    .slice(0, MAX_VARIANTS)
    .map((length) => token.slice(length))
}

/** Light Latin stemmer for words of 5+ letters: `-ies→y`, `-ing`, `-ed`, `-es`, `-s`. */
function latinStem(token: string): string | undefined {
  if (token.length < LATIN_STEM_MIN_LENGTH || !/^[a-z]+$/.test(token)) return undefined
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`
  if (token.endsWith("ing")) return token.slice(0, -3)
  if (token.endsWith("ed")) return token.slice(0, -2)
  if (token.endsWith("sses") || token.endsWith("shes") || token.endsWith("ches") || token.endsWith("xes")) {
    return token.slice(0, -2)
  }
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1)

  return undefined
}

function tokenVariants(token: string): string[] {
  const latin = latinStem(token)

  return latin ? [latin] : hebrewPrefixVariants(token)
}

/** Index text: raw folded tokens (weight A) and their variants (weight B). */
export function normalizeForIndex(text: string): { norm: string; stems: string } {
  const tokens = tokenize(foldText(text))

  return { norm: tokens.join(" "), stems: tokens.flatMap(tokenVariants).join(" ") }
}

function tokenScript(token: string): QueryToken["script"] {
  if (/^[\p{N}.]+$/u.test(token)) return "number"
  if (/^[א-ת\p{N}]+$/u.test(token)) return "he"
  if (/^[\p{Script=Latin}\p{M}\p{N}]+$/u.test(token)) return "latin"

  return "mixed"
}

export function normalizeQuery(q: string): NormalizedQuery {
  const folded = foldText(q)

  return {
    input: q,
    folded,
    tokens: tokenize(folded).map((raw) => ({
      raw,
      variants: tokenVariants(raw),
      script: tokenScript(raw),
      stop: QUERY_STOPWORDS.has(raw),
    })),
  }
}

/** Hebrew letter share of all letters: ≥ 0.6 → he, ≤ 0.1 → en, else mixed. */
export function detectTextLanguage(text: string): TextLanguage {
  let letters = 0
  let hebrew = 0

  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue
    letters += 1
    if (ch >= "א" && ch <= "ת") hebrew += 1
  }

  if (letters === 0) return "en"
  const share = hebrew / letters

  if (share >= 0.6) return "he"
  if (share <= 0.1) return "en"

  return "mixed"
}
