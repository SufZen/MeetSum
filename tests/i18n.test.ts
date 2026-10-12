import { describe, expect, it } from "vitest"

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  getLocaleDirection,
  isSupportedLocale,
  resolveLocalePreference,
} from "@/lib/i18n/locales"
import { dictionaries, formatMessage } from "@/lib/i18n/dictionaries"
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
