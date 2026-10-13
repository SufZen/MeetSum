/**
 * M9 Step 0 (docs/parity/m9.md item 5): dictionary module hygiene. No key is
 * defined by two modules, he/en key and placeholder parity, and complete
 * plural sets (he `_one/_two/_other`, en `_one/_other`).
 */
import { describe, expect, it } from "vitest"

import { asrMessagesEn } from "@/lib/i18n/asr-messages"
import { M9_MESSAGE_MODULES, dictionaries } from "@/lib/i18n/dictionaries"
import { clipsMessagesEn } from "@/lib/i18n/m5/clips"
import { commentsMessagesEn } from "@/lib/i18n/m5/comments"
import { intelligenceMessagesEn } from "@/lib/i18n/m5/intelligence"
import { tasksMessagesEn } from "@/lib/i18n/m5/tasks"
import { askMessagesEn } from "@/lib/i18n/m6/ask"
import { searchMessagesEn } from "@/lib/i18n/m6/search"
import { botMessagesEn } from "@/lib/i18n/m7/bot"
import { exportsMessagesEn } from "@/lib/i18n/m8/exports"
import { integrationsMessagesEn } from "@/lib/i18n/m8/integrations"
import { pluralMessage } from "@/lib/i18n/messages"
import { playerMessagesEn } from "@/lib/i18n/player-messages"
import { workspaceMessagesEn } from "@/lib/i18n/workspace-messages"

const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()
const PLURAL = /_(one|two|other)$/
const pluralBase = (key: string) => key.replace(PLURAL, "")

const OLDER_MODULES: Record<string, Record<string, string>> = {
  workspace: workspaceMessagesEn,
  asr: asrMessagesEn,
  player: playerMessagesEn,
  bot: botMessagesEn,
  intelligence: intelligenceMessagesEn,
  tasks: tasksMessagesEn,
  clips: clipsMessagesEn,
  comments: commentsMessagesEn,
  search: searchMessagesEn,
  ask: askMessagesEn,
  integrations: integrationsMessagesEn,
  m8exports: exportsMessagesEn,
}

describe("M9 message modules", () => {
  it("never define a key that another module (old or M9) defines", () => {
    const owners = new Map<string, string>()
    const collisions: string[] = []
    const modules: Array<[string, Record<string, string>]> = [
      ...Object.entries(M9_MESSAGE_MODULES).map(([name, messageModule]) => [
        `m9/${name}`,
        { ...messageModule.en, ...messageModule.he },
      ] as [string, Record<string, string>]),
    ]

    for (const [name, messages] of Object.entries(OLDER_MODULES)) {
      for (const key of Object.keys(messages)) if (!owners.has(key)) owners.set(key, name)
    }

    for (const [name, messages] of modules) {
      for (const key of Object.keys(messages)) {
        const owner = owners.get(key)

        if (owner && owner !== name) collisions.push(`${key}: ${owner} and ${name}`)
        owners.set(key, name)
      }
    }

    expect(collisions).toEqual([])
  })

  it("keep he/en key parity (he may add `_two`) and placeholder parity", () => {
    for (const [name, messageModule] of Object.entries(M9_MESSAGE_MODULES)) {
      const en: Record<string, string> = messageModule.en
      const he: Record<string, string> = messageModule.he
      const heKeys = Object.keys(he).filter((key) => !key.endsWith("_two"))

      expect(heKeys.sort(), name).toEqual(Object.keys(en).sort())

      for (const key of Object.keys(en)) {
        if (PLURAL.test(key)) continue
        expect(placeholders(he[key]!), `${name}.${key}`).toEqual(placeholders(en[key]!))
      }
    }
  })

  it("have complete plural sets: en _one/_other, he _one/_two/_other", () => {
    for (const [name, messageModule] of Object.entries(M9_MESSAGE_MODULES)) {
      const en: Record<string, string> = messageModule.en
      const he: Record<string, string> = messageModule.he
      const bases = new Set([...Object.keys(en), ...Object.keys(he)].filter((key) => PLURAL.test(key)).map(pluralBase))

      for (const base of bases) {
        expect(Object.keys(en).filter((key) => pluralBase(key) === base && PLURAL.test(key)).sort(), `${name}.${base} en`).toEqual([
          `${base}_one`,
          `${base}_other`,
        ])
        expect(Object.keys(he).filter((key) => pluralBase(key) === base && PLURAL.test(key)).sort(), `${name}.${base} he`).toEqual([
          `${base}_one`,
          `${base}_other`,
          `${base}_two`,
        ])
      }
    }
  })

  it("translate every M9 Hebrew value (non-empty, Hebrew script unless a brand/number)", () => {
    const hebrew = /[֐-׿]/

    for (const [name, messageModule] of Object.entries(M9_MESSAGE_MODULES)) {
      for (const [key, value] of Object.entries(messageModule.he as Record<string, string>)) {
        expect(value.trim(), `${name}.${key}`).not.toBe("")
        if (!/^[\d+]+$/.test(value)) expect(value, `${name}.${key}`).toMatch(hebrew)
        expect(value, `${name}.${key}`).not.toContain("...")
        expect(value, `${name}.${key}`).not.toMatch(/[א-ת]["'][א-ת]/)
      }
    }
  })

  it("are merged into both locale dictionaries", () => {
    for (const messageModule of Object.values(M9_MESSAGE_MODULES)) {
      for (const [key, value] of Object.entries(messageModule.en as Record<string, string>)) {
        expect((dictionaries.en as Record<string, string>)[key], key).toBe(value)
      }
      for (const [key, value] of Object.entries(messageModule.he as Record<string, string>)) {
        expect((dictionaries.he as Record<string, string>)[key], key).toBe(value)
      }
    }
  })

  it("resolve plurals with the Hebrew dual and the English fallback", () => {
    const he = dictionaries.he as Record<string, string>
    const en = dictionaries.en as Record<string, string>

    expect(pluralMessage(he, "he", "coreMeetingsCount", 1)).toBe("פגישה אחת")
    expect(pluralMessage(he, "he", "coreMeetingsCount", 2)).toBe("שתי פגישות")
    expect(pluralMessage(he, "he", "coreMeetingsCount", 5)).toBe("5 פגישות")
    expect(pluralMessage(en, "en", "coreMeetingsCount", 1)).toBe("1 meeting")
    expect(pluralMessage(en, "en", "coreMeetingsCount", 2)).toBe("2 meetings")
    expect(pluralMessage(en, "en", "missingKey", 2)).toBe("missingKey")
  })
})
