import { describe, expect, it } from "vitest"

import { hitDir } from "@/lib/client/highlight"

describe("search result dir", () => {
  it("uses the hit's own language when it is known", () => {
    expect(hitDir("he", "en")).toBe("rtl")
    expect(hitDir("en", "he")).toBe("ltr")
  })

  it("falls back to the meeting language for mixed hits", () => {
    expect(hitDir("mixed", "he")).toBe("rtl")
    expect(hitDir("mixed", "en-US")).toBe("ltr")
  })

  it("uses the meeting language when the hit has none", () => {
    expect(hitDir(undefined, "he")).toBe("rtl")
  })

  it("is auto only when nothing is known", () => {
    expect(hitDir("mixed", "mixed")).toBe("auto")
    expect(hitDir(undefined, undefined)).toBe("auto")
    expect(hitDir(null, null)).toBe("auto")
  })
})
