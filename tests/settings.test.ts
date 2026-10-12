import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  rows: [] as unknown[],
}))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({
    query: async (text: string, values: unknown[] = []) => {
      db.queries.push({ text, values })
      return { rows: /select key, value/.test(text) ? db.rows : [] }
    },
  }),
}))

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

describe("workspace settings (postgres)", () => {
  beforeEach(() => {
    process.env.MEETSUM_STORAGE = "postgres"
    db.queries.length = 0
    db.rows = []
  })

  afterEach(() => {
    process.env.MEETSUM_STORAGE = "memory"
  })

  it("reads only the requested workspace and ignores removed keys", async () => {
    db.rows = [
      { key: "summaryTemplate", value: "sales" },
      { key: "requireApiKeyForMachines", value: false },
      { key: "aiProviderPreference", value: "vertex-ai" },
      { key: "defaultMeetingVisibility", value: "private" },
    ]

    const settings = await getAppSettings("ws_a")

    expect(db.queries[0].text).toContain("from workspace_settings")
    expect(db.queries[0].text).toContain("workspace_id = $1")
    expect(db.queries[0].values).toEqual(["ws_a"])
    expect(settings).toMatchObject({
      summaryTemplate: "sales",
      defaultMeetingVisibility: "private",
    })
    expect(settings).not.toHaveProperty("requireApiKeyForMachines")
    expect(settings).not.toHaveProperty("aiProviderPreference")
  })

  it("upserts every setting under the workspace key and never writes removed keys", async () => {
    await updateAppSettings("ws_a", {
      summaryTemplate: "legal",
      requireApiKeyForMachines: false,
    } as never)

    const writes = db.queries.filter((query) =>
      query.text.includes("insert into workspace_settings")
    )

    expect(writes.length).toBe(Object.keys(DEFAULT_APP_SETTINGS).length)
    expect(writes.every((write) => write.values[0] === "ws_a")).toBe(true)
    expect(writes[0].text).toContain("on conflict (workspace_id, key)")
    expect(writes.map((write) => write.values[1])).not.toContain(
      "requireApiKeyForMachines"
    )
    expect(
      writes.find((write) => write.values[1] === "summaryTemplate")?.values[2]
    ).toBe(JSON.stringify("legal"))
    expect(db.queries.some((query) => query.text.includes("app_settings"))).toBe(false)
  })
})
