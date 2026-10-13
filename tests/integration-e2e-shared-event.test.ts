import { describe, expect, it } from "vitest"

import type { CalendarEventLike } from "@/lib/bot/types"
import type { FakeProviderRequest } from "@/lib/integrations/core/types"
import { meetingLinkKey } from "@/lib/integrations/microsoft/calendar-dedupe"
import { mapGraphEventToCalendarEventLike, type GraphEvent } from "@/lib/integrations/microsoft/calendar-map"
import { fakeSharedEvent, microsoftFakeHandlers } from "@/lib/integrations/microsoft/fake"

/**
 * M8 e2e fix #2: the e2e seed's Google row (built from `fakeSharedEvent()`)
 * and the fake Outlook feed describe the SAME meeting: same iCalUID, same
 * start and same bot link, so the iCalUID dedupe can actually trigger.
 */
describe("e2e shared calendar event", () => {
  it("the fake Outlook event matches the seeded Google row on iCalUID, start and link", () => {
    const shared = fakeSharedEvent()
    const request: FakeProviderRequest = { method: "GET", path: "/v1.0/me/calendarView/delta", query: {}, headers: {}, body: undefined }
    const response = microsoftFakeHandlers["GET /v1.0/me/calendarView/delta"](request) as { body: { value: GraphEvent[] } }
    const mapped = mapGraphEventToCalendarEventLike(response.body.value[0])

    expect(mapped?.iCalUID).toBe(shared.iCalUID)
    expect(new Date(mapped?.startsAt ?? "").toISOString()).toBe(shared.start.toISOString())
    expect(meetingLinkKey(mapped?.event)).toBeDefined()
    expect(meetingLinkKey(mapped?.event)).toBe(meetingLinkKey(shared.googleRaw as CalendarEventLike))
  })

  it("is stable within a day (seed and a later sync agree)", () => {
    const morning = fakeSharedEvent(new Date("2026-10-13T00:05:00Z"))
    const evening = fakeSharedEvent(new Date("2026-10-13T23:55:00Z"))

    expect(morning.start.toISOString()).toBe("2026-10-14T09:00:00.000Z")
    expect(evening.start.toISOString()).toBe(morning.start.toISOString())
  })
})
