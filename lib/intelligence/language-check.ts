/**
 * Output language check (A7), pure. `hebrewRatio` = Hebrew letters / all
 * letters after removing Latin tech-term tokens: glossary terms and
 * technical-looking `[A-Za-z0-9._-]+` tokens (digits, dots, underscores,
 * dashes, ALLCAPS or CamelCase like `PR`, `v2.1`, `GitHub`).
 *
 * `he` passes at >= 0.6; `en` passes when the Hebrew ratio is <= 0.1.
 */
import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr/default-glossary"

export const HEBREW_PASS_RATIO = 0.6
export const ENGLISH_MAX_HEBREW_RATIO = 0.1

const BUILT_IN_TECH_TERMS = [
  "api",
  "pr",
  "sdk",
  "ui",
  "ux",
  "crm",
  "kpi",
  "roi",
  "saas",
  "mvp",
  "qa",
  "ai",
  "llm",
  "json",
  "sql",
  "aws",
  "gcp",
  "zoom",
  "teams",
  "slack",
  "jira",
  "notion",
  "figma",
  "github",
  "gitlab",
  "google",
  "meet",
  "excel",
  "email",
  "deploy",
  "billing",
  "dashboard",
  "backend",
  "frontend",
  "sprint",
  "demo",
  "pipeline",
  "release",
  "feature",
  "bug",
  "staging",
  "production",
]

const LATIN_TOKEN = /[A-Za-z0-9][A-Za-z0-9._-]*/g
const HEBREW_LETTER = /[\u05d0-\u05ea]/gu
const ANY_LETTER = /\p{L}/gu

function glossaryTerms(extra: readonly string[]): Set<string> {
  const terms = new Set<string>(BUILT_IN_TECH_TERMS)

  for (const entry of DEFAULT_ASR_GLOSSARY.terms) {
    for (const word of entry.term.split(/\s+/)) terms.add(word.toLowerCase())
  }
  for (const term of extra) {
    for (const word of term.split(/\s+/)) if (word) terms.add(word.toLowerCase())
  }

  return terms
}

function isTechToken(raw: string, terms: Set<string>): boolean {
  // Trailing sentence punctuation ("Agreed.", "Done...") is not part of the
  // word: only dots/dashes inside a token (v2.1, node.js) mark it technical.
  const token = raw.replace(/[._-]+$/, "")

  if (!token) return false

  return (
    terms.has(token.toLowerCase()) ||
    /[0-9._-]/.test(token) ||
    /^[A-Z]{2,}s?$/.test(token) ||
    /^[A-Za-z][a-z]*[A-Z]/.test(token)
  )
}

function stripTechTokens(text: string, extraTerms: readonly string[]): string {
  const terms = glossaryTerms(extraTerms)

  return text.replace(LATIN_TOKEN, (token) => (isTechToken(token, terms) ? " " : token))
}

function ratioOf(stripped: string): { letters: number; ratio: number } {
  const letters = stripped.match(ANY_LETTER)?.length ?? 0

  return { letters, ratio: letters ? (stripped.match(HEBREW_LETTER)?.length ?? 0) / letters : 0 }
}

/** Hebrew letters / all letters after removing Latin tech-term tokens. */
export function hebrewRatio(text: string, extraTerms: readonly string[] = []): number {
  return ratioOf(stripTechTokens(text, extraTerms)).ratio
}

export type LanguageCheckResult = { passed: boolean; ratio: number; checked: boolean }

/** Checks `text` against the output language (`he`/`en`; others skipped). */
export function checkOutputLanguage(
  text: string,
  lang: string,
  extraTerms: readonly string[] = []
): LanguageCheckResult {
  const hasLetters = /\p{L}/u.test(text)

  if (!hasLetters || (lang !== "he" && lang !== "en")) return { passed: true, ratio: 0, checked: false }

  const { letters, ratio } = ratioOf(stripTechTokens(text, extraTerms))

  if (lang === "he") {
    // Nothing but tech terms left to judge: pass.
    return { passed: letters === 0 || ratio >= HEBREW_PASS_RATIO, ratio, checked: true }
  }

  return { passed: ratio <= ENGLISH_MAX_HEBREW_RATIO, ratio, checked: true }
}

/** Model-written prose of a summary output (quotes excluded). */
export function summaryProse(output: {
  overview?: string
  sections?: Array<{ text?: string; items: Array<{ text: string }> }>
  decisions?: Array<{ text: string }>
  risks?: Array<{ text: string }>
  openQuestions?: Array<{ text: string }>
  commitments?: Array<{ text: string }>
  nextSteps?: Array<{ text: string }>
  chapters?: Array<{ title: string; summary: string; bullets: string[] }>
  actionItems?: Array<{ title: string }>
}): string {
  return [
    output.overview ?? "",
    ...(output.sections ?? []).flatMap((section) => [section.text ?? "", ...section.items.map((item) => item.text)]),
    ...[output.decisions, output.risks, output.openQuestions, output.commitments, output.nextSteps].flatMap(
      (list) => (list ?? []).map((item) => item.text)
    ),
    ...(output.chapters ?? []).flatMap((chapter) => [chapter.title, chapter.summary, ...chapter.bullets]),
    ...(output.actionItems ?? []).map((item) => item.title),
  ]
    .filter(Boolean)
    .join("\n")
}
