import { describe, expect, it } from "vitest"

import { clipsMessagesHe } from "@/lib/i18n/m5/clips"
import { commentsMessagesHe } from "@/lib/i18n/m5/comments"
import { intelligenceMessagesHe } from "@/lib/i18n/m5/intelligence"
import { tasksMessagesHe } from "@/lib/i18n/m5/tasks"

/**
 * M5 Hebrew UI strings are gender-neutral: buttons and labels use
 * infinitives or nouns ("יצירה מחדש", "שמירה"), never a masculine
 * singular imperative ("צור", "שמור", "הוסף").
 */
const MASCULINE_IMPERATIVES = [
  "צור",
  "סמן",
  "הסר",
  "העתק",
  "נתח",
  "נסח",
  "פתח",
  "שמור",
  "העבר",
  "הוסף",
  "העלה",
  "הורד",
  "בחר",
  "מחק",
  "ערוך",
  "שלח",
  "נקה",
]

describe("M5 Hebrew strings", () => {
  it.each([
    ["intelligence", intelligenceMessagesHe],
    ["clips", clipsMessagesHe],
    ["comments", commentsMessagesHe],
    ["tasks", tasksMessagesHe],
  ])("%s strings never start with a masculine imperative", (_name, messages) => {
    for (const [key, value] of Object.entries(messages)) {
      const firstWord = value.trim().split(/\s+/)[0]

      expect(MASCULINE_IMPERATIVES, `${key}: ${value}`).not.toContain(firstWord)
    }
  })

  it("uses the reviewed neutral forms", () => {
    expect(intelligenceMessagesHe.intelRegenerate).toBe("יצירה מחדש")
    expect(intelligenceMessagesHe.intelPrepGenerate).toBe("יצירת תדריך")
    expect(intelligenceMessagesHe.intelOpenInMail).toBe("פתיחה באפליקציית המייל")
    expect(intelligenceMessagesHe.intelSave).toBe("שמירה")
    expect(intelligenceMessagesHe.intelTemplateAddSection).toBe("הוספת סעיף")
  })
})
