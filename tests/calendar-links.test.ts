import { describe, expect, it } from "vitest"

import { extractCalendarMeetingLink, hasConferenceLink } from "@/lib/bot/calendar-links"
import type { CalendarEventLike } from "@/lib/bot/types"

const HEBREW_ZOOM_DESCRIPTION = `<p>שלום לכולם,</p>
<p>מצורף קישור לפגישת Zoom:<br><a href="https://us06web.zoom.us/j/84512345678?pwd=Rk9aQ2x3&amp;from=addon">https://us06web.zoom.us/j/84512345678?pwd=Rk9aQ2x3</a></p>
<p>מזהה פגישה: 845 1234 5678<br>קוד סיסמה: 123456</p>`

describe("extractCalendarMeetingLink", () => {
  it("prefers conferenceData video entry points", () => {
    const event: CalendarEventLike = {
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+972-3-555-1234" },
          { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
        ],
      },
      hangoutLink: "https://meet.google.com/zzz-zzzz-zzz",
      location: "https://zoom.us/j/81234567890",
      description: "https://teams.microsoft.com/meet/312345678901?p=x",
    }

    expect(extractCalendarMeetingLink(event)).toMatchObject({
      platform: "google_meet",
      nativeMeetingId: "abc-defg-hij",
      source: "conference_data",
    })
  })

  it("takes the Zoom add-on passcode from the entry point", () => {
    const link = extractCalendarMeetingLink({
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/81234567890", passcode: "778899" }],
      },
    })

    expect(link).toMatchObject({ platform: "zoom", passcode: "778899", source: "conference_data" })
  })

  it("then hangoutLink, location, description", () => {
    const base: CalendarEventLike = {
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      location: "חדר ישיבות / https://zoom.us/j/81234567890",
      description: "https://teams.microsoft.com/meet/312345678901?p=x",
    }

    expect(extractCalendarMeetingLink(base)?.source).toBe("hangout_link")
    expect(extractCalendarMeetingLink({ ...base, hangoutLink: null })).toMatchObject({
      platform: "zoom",
      source: "location",
    })
    expect(extractCalendarMeetingLink({ ...base, hangoutLink: null, location: "חדר 3" })).toMatchObject({
      platform: "teams",
      source: "description",
    })
  })

  it("skips unsupported entries and falls through", () => {
    expect(
      extractCalendarMeetingLink({
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://webex.com/meet/x" }] },
        location: "https://zoom.us/my/dana",
        description: "https://meet.google.com/abc-defg-hij",
      })?.source
    ).toBe("description")
  })

  it("finds Zoom in a Hebrew HTML description", () => {
    expect(extractCalendarMeetingLink({ description: HEBREW_ZOOM_DESCRIPTION })).toMatchObject({
      platform: "zoom",
      nativeMeetingId: "84512345678",
      passcode: "Rk9aQ2x3",
      redactedUrl: "https://us06web.zoom.us/j/84512345678",
      source: "description",
    })
  })

  it("hasConferenceLink", () => {
    expect(hasConferenceLink({ description: HEBREW_ZOOM_DESCRIPTION })).toBe(true)
    expect(hasConferenceLink({ description: "פגישה בחדר 4", location: "תל אביב" })).toBe(false)
    expect(hasConferenceLink({})).toBe(false)
  })
})
