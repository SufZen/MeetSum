import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { BUILT_IN_TEMPLATES, MEETING_TYPES, templateForMeetingType } from "@/lib/ai/templates/builtins"
import { meetingTypeLabel } from "@/lib/search/meeting-type-labels"

/** Result chips show a translated meeting type, not the raw key (M6 review). */
describe("meeting-type labels", () => {
  it("match the built-in template names for every classified type (he and en)", () => {
    for (const type of MEETING_TYPES.filter((value) => value !== "other")) {
      const name = BUILT_IN_TEMPLATES[templateForMeetingType(type, "en")].name

      expect(meetingTypeLabel(type, "he"), type).toBe(name.he)
      expect(meetingTypeLabel(type, "en"), type).toBe(name.en)
    }
  })

  it("labels 'other', and keeps an unknown key readable", () => {
    expect(meetingTypeLabel("other", "he")).toBe("אחר")
    expect(meetingTypeLabel("other", "en")).toBe("Other")
    expect(meetingTypeLabel("board_review", "en")).toBe("board review")
  })

  it("is used by the result chips and the type filter", () => {
    expect(readFileSync("components/search/search-results.tsx", "utf8")).toContain("meetingTypeLabel(meeting.meetingType, locale)")
    expect(readFileSync("components/search/search-filters.tsx", "utf8")).toContain("meetingTypeLabel(type,")
  })
})
