import { describe, expect, it } from "vitest"

import { extractCalendarMeetingLink } from "@/lib/bot/calendar-links"
import { type GraphEvent, graphDateTimeToIso, mapGraphEventToCalendarEventLike } from "@/lib/integrations/microsoft/calendar-map"

import { fixture } from "./helpers/provider-fake-fetch"

type Page = { value: GraphEvent[] }

const page1 = fixture<Page>("microsoft/delta-page1.json")
const page2 = fixture<Page>("microsoft/delta-page2.json")
const teams = page1.value[0] as GraphEvent
const allDay = page1.value[1] as GraphEvent
const zoom = page2.value[0] as GraphEvent
const meet = fixture<GraphEvent>("microsoft/event-meet-location.json")

describe("mapGraphEventToCalendarEventLike", () => {
  it("maps a Teams event: joinUrl as a video entry point, UTC times, lowercased attendees", () => {
    const mapped = mapGraphEventToCalendarEventLike(teams, { selfEmail: "yossi@acme.co.il" })

    expect(mapped).toBeDefined()
    expect(mapped?.iCalUID).toBe("040000008200E00074C5B7101A82E00800000000SHARED1")
    expect(mapped?.startsAt).toBe("2026-10-14T09:00:00.000Z")
    expect(mapped?.endsAt).toBe("2026-10-14T10:00:00.000Z")
    expect(mapped?.status).toBe("confirmed")
    expect(mapped?.isPrivate).toBe(false)
    expect(mapped?.event.summary).toBe("פגישת היכרות עם לקוח")
    expect(mapped?.event.conferenceData?.entryPoints?.[0]).toMatchObject({ entryPointType: "video" })
    expect(mapped?.event.organizer).toMatchObject({ email: "dana@acme.co.il", self: false })
    expect(mapped?.event.attendees).toEqual([
      expect.objectContaining({ email: "yossi@acme.co.il", responseStatus: "accepted", self: true }),
      expect.objectContaining({ email: "ceo@client.example", responseStatus: "needsAction" }),
      expect.objectContaining({ email: "room1@acme.co.il", resource: true }),
    ])

    const link = extractCalendarMeetingLink(mapped!.event)

    expect(link?.platform).toBe("teams")
    expect(link?.source).toBe("conference_data")
    expect(mapped?.meetLink).toBe(link?.redactedUrl)
  })

  it("never keeps the body: only extracted links survive, and none here", () => {
    const mapped = mapGraphEventToCalendarEventLike(teams)
    const serialized = JSON.stringify(mapped)

    expect(mapped?.event.description).toBeNull()
    expect(serialized).not.toContain("door code")
    expect(serialized).not.toContain("4411")
  })

  it("keeps a Zoom link from the body for the bot but strips pwd from meet_link", () => {
    const mapped = mapGraphEventToCalendarEventLike(zoom)
    const link = extractCalendarMeetingLink(mapped!.event)

    expect(link?.platform).toBe("zoom")
    expect(link?.source).toBe("description")
    expect(link?.passcode).toBe("SeCrEtPwd123")
    expect(mapped?.meetLink).toBeTruthy()
    expect(mapped?.meetLink).not.toContain("SeCrEtPwd123")
    expect(mapped?.meetLink).not.toContain("pwd=")
    expect(mapped?.event.description).not.toContain("Board notes")
    expect(mapped?.event.description).not.toContain("998877")
    expect(mapped?.event.attendees?.[0]).toMatchObject({ email: "partner@other.example", responseStatus: "tentative" })
  })

  it("finds a Meet link in the location", () => {
    const mapped = mapGraphEventToCalendarEventLike(meet)
    const link = extractCalendarMeetingLink(mapped!.event)

    expect(link?.platform).toBe("google_meet")
    expect(link?.source).toBe("location")
    expect(mapped?.meetLink).toContain("meet.google.com/abc-defg-hij")
  })

  it("maps private and confidential sensitivity to private meetings", () => {
    expect(mapGraphEventToCalendarEventLike(zoom)?.isPrivate).toBe(true)
    expect(mapGraphEventToCalendarEventLike(meet)?.isPrivate).toBe(true)
    expect(mapGraphEventToCalendarEventLike({ ...meet, sensitivity: "personal" })?.isPrivate).toBe(false)
  })

  it("maps cancelled events and skips all-day ones", () => {
    expect(mapGraphEventToCalendarEventLike({ ...teams, isCancelled: true })?.status).toBe("cancelled")
    expect(mapGraphEventToCalendarEventLike({ ...teams, isCancelled: true })?.event.status).toBe("cancelled")
    expect(mapGraphEventToCalendarEventLike(allDay)).toBeUndefined()
  })

  it("parses Graph date-times: UTC without offset, explicit offsets, refuses other zones", () => {
    expect(graphDateTimeToIso({ dateTime: "2026-10-14T09:00:00.0000000", timeZone: "UTC" })).toBe("2026-10-14T09:00:00.000Z")
    expect(graphDateTimeToIso({ dateTime: "2026-10-14T12:00:00+03:00" })).toBe("2026-10-14T09:00:00.000Z")
    expect(graphDateTimeToIso({ dateTime: "2026-10-14T09:00:00", timeZone: "Israel Standard Time" })).toBeUndefined()
    expect(graphDateTimeToIso(null)).toBeUndefined()
  })
})
