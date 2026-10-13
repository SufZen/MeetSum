import { describe, expect, it } from "vitest"

import {
  DEFAULT_SHARE_SECTIONS,
  InvalidShareSectionError,
  SHARE_SECTIONS,
  isShareSection,
  parseShareSections,
} from "@/lib/sharing/share-sections"

describe("share sections", () => {
  it("adds media as an opt-in section outside the defaults", () => {
    expect(SHARE_SECTIONS).toContain("media")
    expect(DEFAULT_SHARE_SECTIONS).toEqual([
      "summary",
      "decisions",
      "action_items",
      "transcript",
      "participants",
    ])
    expect(DEFAULT_SHARE_SECTIONS).not.toContain("media")
  })

  it("parses known sections, trims and dedupes in order", () => {
    expect(parseShareSections(["transcript", " media ", "transcript", "summary"])).toEqual([
      "transcript",
      "media",
      "summary",
    ])
    expect(parseShareSections([])).toEqual([])
  })

  it("throws on unknown sections and non-arrays", () => {
    expect(() => parseShareSections(["summary", "secrets"])).toThrow(InvalidShareSectionError)
    expect(() => parseShareSections(["Summary"])).toThrow(InvalidShareSectionError)
    expect(() => parseShareSections([1])).toThrow(InvalidShareSectionError)
    expect(() => parseShareSections("summary")).toThrow(InvalidShareSectionError)
    expect(() => parseShareSections(undefined)).toThrow(InvalidShareSectionError)
  })

  it("reports the offending section", () => {
    try {
      parseShareSections(["recording"])
      expect.unreachable()
    } catch (error) {
      expect((error as InvalidShareSectionError).section).toBe("recording")
    }
  })

  it("guards section names", () => {
    expect(isShareSection("media")).toBe(true)
    expect(isShareSection("nope")).toBe(false)
    expect(isShareSection(undefined)).toBe(false)
  })
})
