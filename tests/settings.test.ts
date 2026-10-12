import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  resolveDefaultMeetingLanguage,
  updateAppSettings,
} from "@/lib/settings/app-settings"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

describe("app settings", () => {
  beforeEach(async () => {
    process.env.MEETSUM_STORAGE = "memory"
    await updateAppSettings(DEFAULT_WORKSPACE_ID, DEFAULT_APP_SETTINGS)
  })

  it("returns safe production defaults", async () => {
    await expect(getAppSettings(DEFAULT_WORKSPACE_ID)).resolves.toMatchObject({
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
    const settings = await updateAppSettings(DEFAULT_WORKSPACE_ID, {
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
    await updateAppSettings(DEFAULT_WORKSPACE_ID, {
      defaultLocale: "he",
      meetingLanguageMode: "he",
      summaryTemplate: "real-estate",
      publicSharingEnabled: false,
      shareTranscriptByDefault: false,
    })

    await expect(getAppSettings(DEFAULT_WORKSPACE_ID)).resolves.toMatchObject({
      defaultLocale: "he",
      meetingLanguageMode: "he",
      summaryTemplate: "real-estate",
      publicSharingEnabled: false,
      shareTranscriptByDefault: false,
    })
  })

  it("defaults new meetings to workspace visibility and keeps settings per workspace", async () => {
    await expect(getAppSettings(DEFAULT_WORKSPACE_ID)).resolves.toMatchObject({
      defaultMeetingVisibility: "workspace",
    })

    await updateAppSettings("ws_other", {
      defaultMeetingVisibility: "private",
      summaryTemplate: "legal",
    })

    await expect(getAppSettings("ws_other")).resolves.toMatchObject({
      defaultMeetingVisibility: "private",
      summaryTemplate: "legal",
    })
    await expect(getAppSettings(DEFAULT_WORKSPACE_ID)).resolves.toMatchObject({
      defaultMeetingVisibility: "workspace",
      summaryTemplate: "general",
    })
  })

  it("resolves the default meeting language from the language mode", () => {
    expect(resolveDefaultMeetingLanguage({ meetingLanguageMode: "auto" })).toBe("he")
    expect(resolveDefaultMeetingLanguage({ meetingLanguageMode: "en" })).toBe("en")
  })
})
