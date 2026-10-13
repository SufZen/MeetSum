import { describe, expect, it } from "vitest"

import {
  DEFAULT_LOCALE,
  LEGACY_LOCALES,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  coerceLocale,
  defaultLocaleFromEnv,
  getLegacyPathLocale,
  getLocaleDirection,
  isSupportedLocale,
  parseAcceptLanguage,
  replacePathLocale,
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
  it("supports Hebrew (default) and English only (M9)", () => {
    expect(SUPPORTED_LOCALES).toEqual(["he", "en"])
    expect(LEGACY_LOCALES).toEqual(["pt", "es", "it"])
    expect(DEFAULT_LOCALE).toBe("he")
    expect(LOCALE_COOKIE).toBe("meetsum_locale")
  })

  it("reads MEETSUM_DEFAULT_LOCALE and allowlists it", () => {
    expect(defaultLocaleFromEnv("en")).toBe("en")
    expect(defaultLocaleFromEnv(" EN ")).toBe("en")
    expect(defaultLocaleFromEnv("pt")).toBe("he")
    expect(defaultLocaleFromEnv(undefined)).toBe("he")
  })

  it("validates supported locales and rejects removed or unknown codes", () => {
    expect(isSupportedLocale("he")).toBe(true)
    expect(isSupportedLocale("en")).toBe(true)
    for (const code of ["pt", "es", "it", "pt-BR", "fr"]) expect(isSupportedLocale(code), code).toBe(false)
  })

  it("uses RTL direction only for Hebrew", () => {
    expect(getLocaleDirection("he")).toBe("rtl")
    expect(getLocaleDirection("en")).toBe("ltr")
  })

  it("parses Accept-Language by q-value, mapping iw and he-* to he", () => {
    expect(parseAcceptLanguage("en-US,en;q=0.9,he;q=0.8")).toEqual(["en", "he"])
    expect(parseAcceptLanguage("fr;q=1, he-IL;q=0.5, en;q=0.7")).toEqual(["en", "he"])
    expect(parseAcceptLanguage("iw")).toEqual(["he"])
    expect(parseAcceptLanguage("*, pt-BR")).toEqual([])
    expect(parseAcceptLanguage("en;q=abc, he;q=0, ;;")).toEqual([])
    expect(parseAcceptLanguage(undefined)).toEqual([])
  })

  it("resolves path → cookie → user → Accept-Language → default", () => {
    expect(resolveLocalePreference({ path: "/en/tasks", cookie: "he" })).toBe("en")
    expect(resolveLocalePreference({ cookie: "en", userLocale: "he", acceptLanguage: "he" })).toBe("en")
    expect(resolveLocalePreference({ cookie: "pt", userLocale: "en" })).toBe("en")
    expect(resolveLocalePreference({ acceptLanguage: "en-GB,en;q=0.9" })).toBe("en")
    expect(resolveLocalePreference({ acceptLanguage: "pt-PT" })).toBe("he")
    expect(resolveLocalePreference()).toBe("he")
  })

  it("redirects legacy locale prefixes and coerces stored legacy values", () => {
    expect(getLegacyPathLocale("/pt/tasks")).toBe("pt")
    expect(getLegacyPathLocale("/he/tasks")).toBeUndefined()
    expect(replacePathLocale("/pt/tasks", "he")).toBe("/he/tasks")
    expect(replacePathLocale("/es", "en")).toBe("/en")
    expect(coerceLocale("it")).toBe("he")
    expect(coerceLocale("en")).toBe("en")
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
