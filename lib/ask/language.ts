/**
 * Answer language (docs/parity/m6.md, C5): the request override, else the
 * question's script (Hebrew-first), else the workspace default, else `he`.
 */
import { hebrewRatio } from "@/lib/intelligence/language-check"
import type { AskLanguage } from "@/lib/ask/messages"

export const HEBREW_QUESTION_RATIO = 0.3

const HEBREW_LETTER = /[א-ת]/
const LATIN_LETTER = /[A-Za-z]/

export function resolveAskLanguage(
  question: string,
  options: { override?: string; workspaceDefault?: string } = {}
): AskLanguage {
  if (options.override === "he" || options.override === "en") return options.override
  if (HEBREW_LETTER.test(question) && hebrewRatio(question) >= HEBREW_QUESTION_RATIO) return "he"
  if (LATIN_LETTER.test(question) && !HEBREW_LETTER.test(question)) return "en"

  return options.workspaceDefault === "en" ? "en" : "he"
}
