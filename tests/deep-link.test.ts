import { describe, expect, it } from "vitest"

import {
  buildSegmentLink,
  buildShareSegmentLink,
  formatSegmentCopy,
  parseTimeParam,
  withoutTimeParam,
} from "@/lib/player/deep-link"

describe("parseTimeParam", () => {
  it("parses seconds, clock and unit forms to milliseconds", () => {
    expect(parseTimeParam("123")).toBe(123_000)
    expect(parseTimeParam("2:03")).toBe(123_000)
    expect(parseTimeParam("1:02:03")).toBe(3_723_000)
    expect(parseTimeParam("1m30s")).toBe(90_000)
    expect(parseTimeParam("1h2m3s")).toBe(3_723_000)
    expect(parseTimeParam("45s")).toBe(45_000)
    expect(parseTimeParam("12.5")).toBe(12_500)
    expect(parseTimeParam(" 0 ")).toBe(0)
  })

  it("rejects malformed or negative values", () => {
    for (const value of ["", "abc", "-5", "1:75", "1:2:3:4", "1x", "m", null, undefined]) {
      expect(parseTimeParam(value), String(value)).toBeUndefined()
    }
  })
})

describe("segment links", () => {
  it("builds a workspace deep link with whole seconds", () => {
    expect(buildSegmentLink({ locale: "he", meetingId: "m 1", ms: 754_900 })).toBe(
      "/he?meeting=m+1&t=754"
    )
    expect(
      buildSegmentLink({ origin: "https://meetsum.example", locale: "en", meetingId: "abc", ms: 0 })
    ).toBe("https://meetsum.example/en?meeting=abc&t=0")
  })

  it("builds a share deep link", () => {
    expect(buildShareSegmentLink({ token: "tok/1", ms: 61_000 })).toBe("/share/tok%2F1?t=61")
    expect(buildShareSegmentLink({ origin: "https://x.test", token: "t", ms: 1_500 })).toBe(
      "https://x.test/share/t?t=1"
    )
  })

  it("formats a copied segment with timestamp, speaker and link", () => {
    expect(
      formatSegmentCopy({ ms: 754_000, speaker: "דנה", text: "נכנסים ל-due diligence", link: "https://x/he?t=754" })
    ).toBe("[12:34] דנה: נכנסים ל-due diligence\nhttps://x/he?t=754")
    expect(formatSegmentCopy({ ms: 3_725_000, speaker: "Dana", text: "ok" })).toBe("[1:02:05] Dana: ok")
  })
})

describe("withoutTimeParam", () => {
  it("drops t and keeps everything else", () => {
    expect(withoutTimeParam("?meeting=a&t=12")).toBe("?meeting=a")
    expect(withoutTimeParam("t=12")).toBe("")
    expect(withoutTimeParam("?a=1&t=2&b=3")).toBe("?a=1&b=3")
  })
})
