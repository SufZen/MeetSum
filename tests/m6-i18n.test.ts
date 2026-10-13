import { describe, expect, it } from "vitest"

import { dictionaries } from "@/lib/i18n/dictionaries"
import { askMessagesEn, askMessagesHe } from "@/lib/i18n/m6/ask"
import { searchMessagesEn, searchMessagesHe } from "@/lib/i18n/m6/search"

/**
 * M6 search and Ask strings: he/en key parity, identical placeholders, real
 * Hebrew, no collisions with existing dictionary keys, and gender-neutral
 * Hebrew (infinitives or nouns, never a masculine imperative or present
 * tense addressed to the user).
 */
const MODULES = [
  ["search", searchMessagesEn, searchMessagesHe],
  ["ask", askMessagesEn, askMessagesHe],
] as const

const MASCULINE_FORMS = [
  "צור",
  "סמן",
  "הסר",
  "העתק",
  "פתח",
  "שמור",
  "העבר",
  "הוסף",
  "בחר",
  "מחק",
  "ערוך",
  "שלח",
  "נקה",
  "חפש",
  "שאל",
  "הקלד",
  "נסה",
  "המתן",
  "עצור",
  "בדוק",
  "מחפש",
  "שואל",
  "בודק",
  "טוען",
]

const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()

describe("M6 i18n", () => {
  it.each(MODULES)("%s: he and en have the same keys and placeholders", (_name, en, he) => {
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort())

    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(he[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it.each(MODULES)("%s: every Hebrew string is translated, unless it is a shortcut or a pure template", (_name, enMessages, heMessages) => {
    const hebrew = /[֐-׿]/
    const en: Record<string, string> = enMessages
    const he: Record<string, string> = heMessages

    for (const key of Object.keys(en)) {
      if (en[key] === "Ctrl K" || en[key].startsWith("{")) continue
      expect(he[key], key).toMatch(hebrew)
    }
  })

  it.each(MODULES)("%s: Hebrew never uses a masculine imperative or present tense", (_name, _en, he) => {
    for (const [key, value] of Object.entries(he)) {
      const words = value.split(/[\s.,:;·…!?—„”"]+/).filter(Boolean)

      for (const word of words) expect(MASCULINE_FORMS, `${key}: ${value}`).not.toContain(word)
    }
  })

  it("merges into every locale's dictionary without overriding older keys", () => {
    for (const key of [...Object.keys(searchMessagesEn), ...Object.keys(askMessagesEn)]) {
      expect(dictionaries.en, key).toHaveProperty(key)
      expect(dictionaries.he, key).toHaveProperty(key)
    }
    // Existing M4 keys keep their values.
    expect(dictionaries.en.askCitation).toBeTruthy()
    expect(dictionaries.he.searchTitle).toBe(searchMessagesHe.searchTitle)
    expect(dictionaries.he.askRefusal).toBe(askMessagesHe.askRefusal)
  })

  it("uses the sidebar label from the spec", () => {
    expect(searchMessagesHe.navSearchAsk).toBe("חיפוש ושאלות")
    expect(searchMessagesEn.navSearchAsk).toBe("Search & Ask")
  })
})
