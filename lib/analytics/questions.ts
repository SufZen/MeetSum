/**
 * Question detection (M5 D1). Heuristic, per sentence:
 * - the sentence ends with `?` (Latin or Arabic question mark);
 * - Hebrew: it starts with האם/מה/מי/למה/איך/מתי/איפה/כמה/איזה/איזו/אילו/נכון
 *   (optionally with a ו prefix), unless the question word opens a relative
 *   clause ("מה שחשוב זה…");
 * - English: it starts with a wh-word, or with an auxiliary followed by a
 *   subject ("do you…", "can we…").
 */
import { tokenize } from "@/lib/analytics/text"

const HEBREW_QUESTION_WORDS = new Set([
  "האם",
  "מה",
  "מי",
  "למה",
  "איך",
  "מתי",
  "איפה",
  "כמה",
  "איזה",
  "איזו",
  "אילו",
  "נכון",
])

const ENGLISH_WH = new Set(["what", "why", "who", "whom", "whose", "where", "when", "which", "how"])

const ENGLISH_AUX = new Set([
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "am",
  "can",
  "could",
  "will",
  "would",
  "should",
  "shall",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
])

const ENGLISH_SUBJECTS = new Set([
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "it",
  "this",
  "that",
  "there",
  "these",
  "those",
  "anyone",
  "someone",
  "everyone",
  "somebody",
  "anybody",
])

/** Splits on sentence punctuation, keeping the terminator with its sentence. */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?؟\n]+[.!?؟]*/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function startsLikeHebrewQuestion(tokens: string[]): boolean {
  const [first, second] = tokens
  const word = first?.startsWith("ו") && HEBREW_QUESTION_WORDS.has(first.slice(1)) ? first.slice(1) : first

  if (!word || !HEBREW_QUESTION_WORDS.has(word)) return false
  // "מה שחשוב…", "מי שאחראי…": a relative clause, not a question.
  if (second?.startsWith("ש") && word !== "האם" && word !== "נכון") return false

  return true
}

function startsLikeEnglishQuestion(tokens: string[]): boolean {
  const [first, second] = tokens

  if (!first) return false
  if (ENGLISH_WH.has(first)) return true

  return ENGLISH_AUX.has(first) && second !== undefined && ENGLISH_SUBJECTS.has(second)
}

/** True when one sentence reads as a question. */
export function isQuestionSentence(sentence: string): boolean {
  const trimmed = sentence.trim()

  if (!trimmed) return false
  if (/[?؟]\s*$/u.test(trimmed)) return true

  const tokens = tokenize(trimmed)

  return startsLikeHebrewQuestion(tokens) || startsLikeEnglishQuestion(tokens)
}

/** Number of question sentences in a text. */
export function countQuestions(text: string): number {
  return splitSentences(text).filter(isQuestionSentence).length
}
