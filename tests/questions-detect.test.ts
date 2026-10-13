import { describe, expect, it } from "vitest"

import { countQuestions, isQuestionSentence, splitSentences } from "@/lib/analytics/questions"

describe("question detection", () => {
  it.each([
    "האם סגרנו את החוזה",
    "מה הסטטוס של ה-API",
    "מי לוקח את זה",
    "למה זה התעכב",
    "איך נתקדם",
    "מתי המשלוח",
    "איפה המסמך",
    "כמה זה עולה",
    "איזה לקוח",
    "איזו גרסה",
    "אילו משימות נשארו",
    "נכון שזה מוכן",
    "ומה עם התקציב",
    "סגרנו?",
    "זה ב-Supabase?",
    "What is the budget",
    "how do we ship this",
    "Do you have the numbers",
    "can we move it to Sunday",
    "Is this final?",
  ])("detects %s", (sentence) => {
    expect(isQuestionSentence(sentence)).toBe(true)
  })

  it.each([
    "מה שחשוב זה הלקוח",
    "מי שאחראי ישלח מחר",
    "סגרנו את החוזה",
    "We shipped it",
    "Do the review today",
    "Can of worms",
    "",
  ])("does not flag %s", (sentence) => {
    expect(isQuestionSentence(sentence)).toBe(false)
  })

  it("splits sentences and counts questions per sentence", () => {
    expect(splitSentences("סגרנו. מתי שולחים? טוב")).toEqual(["סגרנו.", "מתי שולחים?", "טוב"])
    expect(countQuestions("סגרנו. מתי שולחים? האם יש תקציב. כן")).toBe(2)
    expect(countQuestions("Okay. What about Friday? Sure")).toBe(1)
  })
})
