import { describe, expect, it } from "vitest"

import {
  LINK_REASON_MESSAGE,
  botErrorMessageKey,
  buildJoinPreview,
  buildJoinRequest,
  type MeetingLinkParser,
} from "@/components/bot/join-meeting-state"
import { MEETING_LINK_REJECT_REASONS, type ParsedMeetingLink } from "@/lib/bot/types"
import { botMessagesEn, botMessagesHe } from "@/lib/i18n/m7/bot"

const zoom: ParsedMeetingLink = {
  platform: "zoom",
  nativeMeetingId: "81234567890",
  passcode: "AbC123",
  canonicalUrl: "https://zoom.us/j/81234567890?pwd=AbC123",
  redactedUrl: "https://zoom.us/j/81234567890",
  source: "input",
}
const meet: ParsedMeetingLink = {
  platform: "google_meet",
  nativeMeetingId: "abc-defg-hij",
  canonicalUrl: "https://meet.google.com/abc-defg-hij",
  redactedUrl: "https://meet.google.com/abc-defg-hij",
  source: "input",
}

/** Stand-in for A's parser (lib/bot/meeting-url.ts), keyed on substrings. */
const fakeParser: MeetingLinkParser = {
  extract: (text) => [
    ...(text.includes("zoom.us/j/81234567890") ? [zoom] : []),
    ...(text.includes("meet.google.com/abc-defg-hij") ? [meet] : []),
  ],
  diagnose: (text) => (text.includes("zoom.us/my/") ? "personal_link" : "no_link"),
}

describe("join dialog preview", () => {
  it("previews a Zoom link pasted inside Hebrew invite text", () => {
    const preview = buildJoinPreview(
      "להצטרפות (https://zoom.us/j/81234567890?pwd=AbC123) תודה",
      fakeParser
    )

    expect(preview).toEqual({ kind: "found", link: zoom, extraCount: 0 })
    if (preview.kind === "found") {
      expect(preview.link.redactedUrl).not.toContain("AbC123")
    }
  })

  it("uses the first link and counts the rest", () => {
    expect(
      buildJoinPreview(
        "https://zoom.us/j/81234567890?pwd=AbC123 או https://meet.google.com/abc-defg-hij",
        fakeParser
      )
    ).toMatchObject({ kind: "found", link: { platform: "zoom" }, extraCount: 1 })
  })

  it("shows why nothing usable was found", () => {
    expect(buildJoinPreview("   ", fakeParser)).toEqual({ kind: "empty" })
    expect(buildJoinPreview("https://zoom.us/my/dana", fakeParser)).toEqual({
      kind: "rejected",
      reason: "personal_link",
    })
    expect(buildJoinPreview("x".repeat(5000), fakeParser)).toEqual({
      kind: "rejected",
      reason: "too_long",
    })
  })

  it("has a he/en message for every reject reason", () => {
    for (const reason of MEETING_LINK_REJECT_REASONS) {
      const key = LINK_REASON_MESSAGE[reason]

      expect(botMessagesEn[key], reason).toBeTruthy()
      expect(botMessagesHe[key], reason).toMatch(/[֐-׿]/)
    }
  })
})

describe("join request", () => {
  it("sends a bare URL as meetingUrl and invite text as text", () => {
    expect(
      buildJoinRequest({ input: " https://meet.google.com/abc-defg-hij ", language: "auto" })
    ).toEqual({ meetingUrl: "https://meet.google.com/abc-defg-hij", language: "auto" })
    expect(
      buildJoinRequest({
        input: "קישור לפגישה: https://meet.google.com/abc-defg-hij",
        title: "  סנכרון משפטי ",
        language: "he",
      })
    ).toEqual({
      text: "קישור לפגישה: https://meet.google.com/abc-defg-hij",
      title: "סנכרון משפטי",
      language: "he",
    })
  })
})

describe("join error mapping", () => {
  it("names the cause and the next step", () => {
    expect(botErrorMessageKey(429, { error: "bot_capacity" })).toBe("botErrorCapacity")
    expect(botErrorMessageKey(429, { error: "bot_rate_limited" })).toBe("botErrorRateLimited")
    expect(botErrorMessageKey(429, {})).toBe("botErrorRateLimited")
    expect(botErrorMessageKey(409, { error: "bot_already_in_meeting" })).toBe(
      "botErrorAlreadyInMeeting"
    )
    expect(botErrorMessageKey(409, null)).toBe("botErrorAlreadyInMeeting")
    expect(botErrorMessageKey(400, { error: "invalid_meeting_link", reason: "personal_link" })).toBe(
      "botLinkPersonalLink"
    )
    expect(botErrorMessageKey(400, { error: "invalid_meeting_link" })).toBe("botLinkNoLink")
    expect(botErrorMessageKey(404, { error: "bot_disabled" })).toBe("botErrorDisabled")
    expect(botErrorMessageKey(403, { error: "forbidden" })).toBe("botErrorForbidden")
    expect(botErrorMessageKey(0, undefined)).toBe("botErrorNetwork")
    expect(botErrorMessageKey(500, undefined)).toBe("botErrorGeneric")
  })

  it("never leaks the other workspace on a 409", () => {
    expect(botMessagesEn.botErrorAlreadyInMeeting).not.toMatch(/workspace/i)
  })
})
