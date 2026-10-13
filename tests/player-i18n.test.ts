import { describe, expect, it } from "vitest"

import { dictionaries } from "@/lib/i18n/dictionaries"
import { SUPPORTED_LOCALES } from "@/lib/i18n/locales"
import { playerMessagesEn, playerMessagesHe } from "@/lib/i18n/player-messages"

const keys = Object.keys(playerMessagesEn) as Array<keyof typeof playerMessagesEn>
const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()

describe("player i18n", () => {
  it("covers the player, transcript, talk-time, rename/delete and share namespaces", () => {
    for (const prefix of ["player", "transcript", "talkTime", "meetingRename", "meetingDelete", "shortcuts"]) {
      expect(keys.some((key) => key.startsWith(prefix)), prefix).toBe(true)
    }
    expect(keys).toContain("shareIncludeRecording")
  })

  it("translates every key into Hebrew and keeps English for other locales", () => {
    const hebrew = /[֐-׿]/

    for (const key of keys) {
      expect(dictionaries.he[key], key).toBe(playerMessagesHe[key])
      expect(dictionaries.he[key], key).toMatch(hebrew)
      expect(dictionaries.en[key], key).toBe(playerMessagesEn[key])
      for (const locale of SUPPORTED_LOCALES.filter((code) => code !== "he")) {
        expect(dictionaries[locale][key], `${locale}.${key}`).toBe(playerMessagesEn[key])
      }
    }
  })

  it("keeps placeholders identical between Hebrew and English", () => {
    for (const key of keys) {
      expect(placeholders(playerMessagesHe[key]), key).toEqual(placeholders(playerMessagesEn[key]))
    }
  })

  it("never uses dir-hostile ASCII hyphens after Hebrew prefix letters before a placeholder", () => {
    for (const key of keys) {
      expect(playerMessagesHe[key], key).not.toMatch(/[א-ת]-\{/)
    }
  })
})
