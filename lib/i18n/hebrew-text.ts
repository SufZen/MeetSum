/**
 * Hebrew typography and bidi helpers (M9, docs/parity/m9.md "Hebrew
 * typography API"). Canonical module: `lib/integrations/bidi.ts` re-exports
 * these primitives (same names, same behaviour). Applied at render/export
 * time only, never persisted: stored text, search offsets, clipboard and
 * transcript DOM stay raw.
 */

export const RLM = "‏"
export const LRM = "‎"
export const WJ = "⁠"
export const NBSP = " "
export const LRI = "⁦"
export const RLI = "⁧"
export const FSI = "⁨"
export const PDI = "⁩"

const HEBREW = /[֐-׿יִ-ﭏ]/
/** Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan… and their presentation forms. */
const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u
const LETTER = /\p{L}/u
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜⁠]/g
const CONTROL_CHAR = /[‎‏‪-‮⁦-⁩؜⁠ ]/
/** LRI, RLI and FSI open an isolate (skipped, UBA rule P2); PDI closes it. */
const ISOLATE_OPEN = new Set([LRI, RLI, FSI])
const RTL_LANGUAGES = new Set(["he", "iw", "yi", "ar", "fa", "ur"])

export function hasHebrew(s: string): boolean {
  return HEBREW.test(s)
}

/**
 * Direction of the first strong character, or neutral when there is none
 * (digits, punctuation, emoji). Isolated runs are skipped (UBA P2); RLM and
 * LRM count as strong.
 */
export function firstStrongDirection(s: string): "rtl" | "ltr" | "neutral" {
  let depth = 0

  for (const char of s) {
    if (ISOLATE_OPEN.has(char)) {
      depth += 1
      continue
    }
    if (char === PDI) {
      if (depth > 0) depth -= 1
      continue
    }
    if (depth > 0) continue
    if (char === RLM) return "rtl"
    if (char === LRM) return "ltr"
    if (STRONG_RTL.test(char)) return "rtl"
    if (LETTER.test(char)) return "ltr"
  }

  return "neutral"
}

/** he, iw, yi, ar, fa, ur (any region subtag, `-` or `_`). */
export function isRtlLanguage(lang?: string | null): boolean {
  if (!lang) return false

  return RTL_LANGUAGES.has(lang.trim().toLowerCase().split(/[-_]/)[0] ?? "")
}

/** A known language decides; otherwise the first strong character (neutral → ltr). */
export function directionFor(lang?: string | null, text?: string): "rtl" | "ltr" {
  const normalized = lang?.trim().toLowerCase()

  if (normalized && normalized !== "mixed" && normalized !== "auto") {
    return isRtlLanguage(normalized) ? "rtl" : "ltr"
  }

  return text && firstStrongDirection(text) === "rtl" ? "rtl" : "ltr"
}

// URLs, emails, @mentions, `code` spans and runs of existing control characters.
const PROTECTED =
  /(https?:\/\/[^\s]+|www\.[^\s]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|@[\w.-]+|`[^`]*`|[‎‏‪-‮⁦-⁩؜⁠]+)/g

function typesetSegment(segment: string): string {
  return (
    segment
      // 2. RLM after a Latin token that is followed by whitespace and a digit.
      .replace(/([A-Za-z][A-Za-z0-9.+#&'’-]*)(?=\s+\d)/g, (token, _match, offset: number, whole: string) =>
        CONTROL_CHAR.test(whole[offset + token.length] ?? "") ? token : `${token}${RLM}`
      )
      // 3. Word joiner after a Hebrew prefix hyphen before Latin/digits (ל-Google, ב-14:30).
      .replace(/(^|[\s(["'׳״])([ובכלמשה]{1,3})([-־])(?=[A-Za-z0-9])/g, `$1$2$3${WJ}`)
      // 4. No-break space before a spaced dash.
      .replace(/ ([—–]) /g, `${NBSP}$1 `)
  )
}

/**
 * Idempotent Hebrew typesetting for display/export strings; a no-op for
 * strings without Hebrew unless the base direction is RTL.
 */
export function fixHebrewTypography(s: string, opts: { base?: "rtl" | "ltr" } = {}): string {
  if (!s || (!hasHebrew(s) && opts.base !== "rtl")) return s

  return s
    .split(PROTECTED)
    .map((part, index) => (index % 2 === 1 ? part : typesetSegment(part)))
    .join("")
}

/** LRI…PDI around a Latin run. Plain-text outputs only (PDF/DOCX/email/Slack), never DOM. */
export function isolateLtr(s: string): string {
  if (!s || (s.startsWith(LRI) && s.endsWith(PDI))) return s

  return `${LRI}${s}${PDI}`
}

function rtlSingleLine(line: string): string {
  if (!line) return line

  const first = String.fromCodePoint(line.codePointAt(0) as number)

  if (first === RLM || STRONG_RTL.test(first)) return line

  return `${RLM}${line}`
}

/**
 * Keeps a line's base RTL in renderers that take the direction from the
 * first strong character (Slack, Notion, plain text): prefixes RLM unless the
 * line already starts with an RTL character or RLM. Applied per line; marks
 * are only ever added at a line start, never inside URLs or tokens.
 */
export function rtlLine(s: string): string {
  return s.split("\n").map(rtlSingleLine).join("\n")
}

/** Removes U+200E/F, 202A–202E, 2066–2069, 061C and 2060. */
export function stripBidiControls(s: string): string {
  return s.replace(BIDI_CONTROLS, "")
}

/**
 * Locale list ("א, ב וג" / "a, b, and c"). In Hebrew, when the last item
 * starts with a non-Hebrew character, the conjunction is "ו-" + WJ
 * ("Slack, Notion ו-HubSpot").
 */
export function hebrewList(
  items: string[],
  locale: "he" | "en",
  type: "conjunction" | "disjunction" = "conjunction"
): string {
  const list = items.filter((item) => item.length > 0)

  if (list.length === 0) return ""
  if (list.length === 1) return list[0]!

  const last = list[list.length - 1]!

  if (locale === "he" && type === "conjunction" && !HEBREW.test(last[0] ?? "")) {
    return `${list.slice(0, -1).join(", ")} ו-${WJ}${last}`
  }

  return new Intl.ListFormat(locale, { style: "long", type }).format(list)
}
