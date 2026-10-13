import { describe, expect, it } from "vitest"

import { integrationsMessagesEn, integrationsMessagesHe } from "@/lib/i18n/m8/integrations"

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
/** Product and provider names stay in Latin script in Hebrew too. */
const LATIN_ONLY = new Set(["integrationsProviderSlack", "integrationsProviderNotion", "integrationsProviderHubspot", "integrationsProviderMicrosoft", "integrationsProviderGoogleDrive", "integrationsProviderRealizeos", "integrationsLogTabWebhooks", "integrationsSectionWebhooks", "integrationsSourceGoogleMeet", "integrationsSourceTeams", "integrationsSourceZoom"])

describe("M8 integrations messages", () => {
  const keys = Object.keys(integrationsMessagesEn) as (keyof typeof integrationsMessagesEn)[]

  it("keeps the frozen 200 keys plus the two Integration-step webhook keys and the 33 review-fix keys", () => {
    expect(keys).toHaveLength(235)
    expect(keys).toEqual(expect.arrayContaining(["integrationsWebhookUrlLabel", "integrationsSendPrivateNotOptedIn", "integrationsErrorKindRetryable"]))
    expect(keys).toEqual(expect.arrayContaining(["integrationsWebhookAdd", "integrationsWebhookRotateSecret"]))
    expect(Object.keys(integrationsMessagesHe).sort()).toEqual([...keys].sort())
  })

  it("fills every value in both languages with matching placeholders", () => {
    for (const key of keys) {
      expect(integrationsMessagesEn[key], key).not.toBe("")
      expect(integrationsMessagesHe[key], key).not.toBe("")
      expect(placeholders(integrationsMessagesHe[key]), key).toEqual(placeholders(integrationsMessagesEn[key]))
    }
  })

  it("writes Hebrew in Hebrew, gender-neutral (no slash forms)", () => {
    for (const key of keys) {
      const value = integrationsMessagesHe[key]

      if (!LATIN_ONLY.has(key)) expect(/[֐-׿]/.test(value), key).toBe(true)
      // e.g. "חבר/י", "מחובר/ת": the guide asks for infinitives and nouns instead.
      expect(/[֐-׿]\/[֐-׿]/.test(value), key).toBe(false)
    }
  })
})
