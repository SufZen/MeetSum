import { describe, expect, it } from "vitest"

import { parseCreateMeetingInput } from "@/lib/meetings/validation"

const body = {
  title: "Weekly sync",
  source: "upload",
  startedAt: "2026-04-23T09:00:00.000Z",
}

describe("parseCreateMeetingInput default language", () => {
  it("uses the workspace default language when the body omits one", () => {
    expect(parseCreateMeetingInput(body, { defaultLanguage: "en" }).language).toBe("en")
  })

  it("keeps an explicit body language over the workspace default", () => {
    expect(
      parseCreateMeetingInput({ ...body, language: "he" }, { defaultLanguage: "en" })
        .language
    ).toBe("he")
  })

  it("never accepts ownership or visibility from the request body", () => {
    const input = parseCreateMeetingInput({
      ...body,
      ownerUserId: "user_attacker",
      visibility: "link",
    })

    expect(input).not.toHaveProperty("ownerUserId")
    expect(input).not.toHaveProperty("visibility")
  })
})
