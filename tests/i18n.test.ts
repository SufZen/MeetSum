import { describe, expect, it } from "vitest"

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  getLocaleDirection,
  isSupportedLocale,
  resolveLocalePreference,
} from "@/lib/i18n/locales"
import { asrMessagesEn, asrMessagesHe } from "@/lib/i18n/asr-messages"
import { dictionaries, formatMessage } from "@/lib/i18n/dictionaries"
import {
  BOT_LATIN_ONLY_KEYS,
  botMessagesEn,
  botMessagesHe,
} from "@/lib/i18n/m7/bot"
import {
  workspaceMessagesEn,
  workspaceMessagesHe,
} from "@/lib/i18n/workspace-messages"

describe("internationalization", () => {
  it("supports exactly the day-one MeetSum locales with English as default", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "he", "pt", "es", "it"])
    expect(DEFAULT_LOCALE).toBe("en")
    expect(LOCALE_COOKIE).toBe("meetsum_locale")
  })

  it("validates supported locales and rejects unsupported codes", () => {
    expect(isSupportedLocale("he")).toBe(true)
    expect(isSupportedLocale("pt-BR")).toBe(false)
    expect(isSupportedLocale("fr")).toBe(false)
  })

  it("uses RTL direction only for Hebrew", () => {
    expect(getLocaleDirection("he")).toBe("rtl")
    expect(getLocaleDirection("en")).toBe("ltr")
    expect(getLocaleDirection("pt")).toBe("ltr")
  })

  it("prefers a saved locale and otherwise defaults to English", () => {
    expect(resolveLocalePreference("es", "he-IL,he;q=0.9")).toBe("es")
    expect(resolveLocalePreference(undefined, "he-IL,he;q=0.9")).toBe("en")
    expect(resolveLocalePreference("fr", "pt-PT,pt;q=0.9")).toBe("en")
  })

  it("translates every workspace/admin string into Hebrew", () => {
    const hebrew = /[֐-׿]/

    for (const key of Object.keys(workspaceMessagesEn) as Array<
      keyof typeof workspaceMessagesEn
    >) {
      expect(dictionaries.he[key], key).toMatch(hebrew)
      expect(dictionaries.en[key], key).toBe(workspaceMessagesEn[key])
    }
  })

  it("keeps placeholders identical between Hebrew and English", () => {
    const placeholders = (value: string) =>
      (value.match(/\{\w+\}/g) ?? []).sort()

    for (const key of Object.keys(workspaceMessagesEn) as Array<
      keyof typeof workspaceMessagesEn
    >) {
      expect(placeholders(workspaceMessagesHe[key]), key).toEqual(
        placeholders(workspaceMessagesEn[key])
      )
    }
  })

  it("translates every speaker, glossary and ASR status string into Hebrew", () => {
    const hebrew = /[֐-׿]/
    const keys = Object.keys(asrMessagesEn) as Array<keyof typeof asrMessagesEn>

    expect(keys.filter((key) => key.startsWith("speakers")).length).toBeGreaterThan(10)
    expect(keys.filter((key) => key.startsWith("glossary")).length).toBeGreaterThan(10)
    expect(keys.filter((key) => key.startsWith("asrStatus")).length).toBeGreaterThan(5)

    for (const key of keys) {
      expect(dictionaries.he[key], key).toMatch(hebrew)
      expect(dictionaries.en[key], key).toBe(asrMessagesEn[key])
      expect(dictionaries.pt[key], key).toBe(asrMessagesEn[key])
    }
  })

  it("keeps ASR placeholders identical between Hebrew and English", () => {
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()

    for (const key of Object.keys(asrMessagesEn) as Array<keyof typeof asrMessagesEn>) {
      expect(placeholders(asrMessagesHe[key]), key).toEqual(placeholders(asrMessagesEn[key]))
    }
  })

  it("keeps M7 bot strings in he/en parity with matching placeholders", () => {
    const hebrew = /[֐-׿]/
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()
    const keys = Object.keys(botMessagesEn) as Array<keyof typeof botMessagesEn>

    expect(Object.keys(botMessagesHe).sort()).toEqual([...keys].sort())
    expect(keys.filter((key) => key.startsWith("botReason")).length).toBe(20)

    for (const key of keys) {
      expect(botMessagesHe[key].trim(), key).not.toBe("")
      expect(placeholders(botMessagesHe[key]), key).toEqual(placeholders(botMessagesEn[key]))
      expect(dictionaries.en[key], key).toBe(botMessagesEn[key])
      expect(dictionaries.he[key], key).toBe(botMessagesHe[key])
      expect(dictionaries.pt[key], key).toBe(botMessagesEn[key])
      if (!BOT_LATIN_ONLY_KEYS.includes(key)) {
        expect(botMessagesHe[key], key).toMatch(hebrew)
      }
    }
  })

  it("localizes generic speaker labels", () => {
    expect(formatMessage(dictionaries.he.speakersGenericLabel, { n: 2 })).toBe("דובר 2")
    expect(formatMessage(dictionaries.en.speakersGenericLabel, { n: 2 })).toBe("Speaker 2")
  })

  it("fills message placeholders", () => {
    expect(
      formatMessage("הצטרפות אל {workspace} בתפקיד {role}.", {
        workspace: "צוות",
        role: "מנהל",
      })
    ).toBe("הצטרפות אל צוות בתפקיד מנהל.")
    expect(formatMessage("{missing} stays", {})).toBe("{missing} stays")
  })

  it("keeps dictionary keys complete for every locale", () => {
    const englishKeys = Object.keys(dictionaries.en).sort()

    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(dictionaries[locale]).sort()).toEqual(englishKeys)
    }
  })
})
