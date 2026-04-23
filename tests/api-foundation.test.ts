import { describe, expect, it } from "vitest"

import {
  createApiKeyHash,
  extractBearerToken,
  verifyApiKey,
} from "@/lib/auth/api-keys"
import { parseCreateMeetingInput } from "@/lib/meetings/validation"

describe("API key authentication", () => {
  it("hashes API keys for storage and verifies only matching keys", () => {
    const hash = createApiKeyHash("ms_live_super_secret")

    expect(hash).toMatch(/^sha256:/)
    expect(verifyApiKey("ms_live_super_secret", [hash])).toBe(true)
    expect(verifyApiKey("ms_live_wrong", [hash])).toBe(false)
  })

  it("extracts bearer tokens and rejects non-bearer authorization", () => {
    expect(
      extractBearerToken(new Headers({ authorization: "Bearer ms_live_123" }))
    ).toBe("ms_live_123")
    expect(
      extractBearerToken(new Headers({ authorization: "Basic abc" }))
    ).toBeUndefined()
  })
})

describe("meeting request validation", () => {
  it("normalizes valid create meeting payloads with Hebrew as the default language", () => {
    expect(
      parseCreateMeetingInput({
        title: "פגישת אסטרטגיה",
        source: "google_meet",
        startedAt: "2026-04-23T09:00:00.000Z",
      })
    ).toEqual({
      title: "פגישת אסטרטגיה",
      source: "google_meet",
      language: "he",
      startedAt: "2026-04-23T09:00:00.000Z",
      participants: [],
    })
  })

  it("rejects invalid meeting sources and empty titles", () => {
    expect(() =>
      parseCreateMeetingInput({
        title: "",
        source: "spreadsheet",
        startedAt: "not-a-date",
      })
    ).toThrow("Invalid meeting payload")
  })
})
