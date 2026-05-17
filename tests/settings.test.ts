import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  updateAppSettings,
} from "@/lib/settings/app-settings"

describe("app settings", () => {
  beforeEach(async () => {
    process.env.MEETSUM_STORAGE = "memory"
    await updateAppSettings(DEFAULT_APP_SETTINGS)
  })

  it("returns safe production defaults", async () => {
    await expect(getAppSettings()).resolves.toMatchObject({
      defaultLocale: "en",
      meetingLanguageMode: "auto",
      googleArtifactsFirst: true,
      pwaRecorderEnabled: true,
      publicSharingEnabled: true,
      audioRetentionDays: 180,
      retainVideoByDefault: false,
    })
  })

  it("normalizes unsupported values instead of persisting invalid settings", async () => {
    const settings = await updateAppSettings({
      defaultLocale: "fr",
      meetingLanguageMode: "pt-BR",
      summaryTemplate: "anything",
      audioRetentionDays: 99999,
    } as never)

    expect(settings.defaultLocale).toBe("en")
    expect(settings.meetingLanguageMode).toBe("auto")
    expect(settings.summaryTemplate).toBe("general")
    expect(settings.audioRetentionDays).toBe(3650)
  })

  it("persists supported settings in the memory fallback", async () => {
    await updateAppSettings({
      defaultLocale: "he",
      meetingLanguageMode: "he",
      summaryTemplate: "real-estate",
      publicSharingEnabled: false,
      shareTranscriptByDefault: false,
    })

    await expect(getAppSettings()).resolves.toMatchObject({
      defaultLocale: "he",
      meetingLanguageMode: "he",
      summaryTemplate: "real-estate",
      publicSharingEnabled: false,
      shareTranscriptByDefault: false,
    })
  })
})
