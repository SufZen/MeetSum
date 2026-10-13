import { describe, expect, it } from "vitest"

import {
  DEFAULT_MEDIA_MAX_RANGE_BYTES,
  mediaMaxRangeBytes,
  parseRange,
} from "@/lib/media/range"

const MiB = 1024 * 1024

describe("parseRange", () => {
  it("parses closed, open and suffix byte ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ type: "partial", start: 0, end: 99 })
    expect(parseRange("bytes=500-", 1000)).toEqual({ type: "partial", start: 500, end: 999 })
    expect(parseRange("bytes=-100", 1000)).toEqual({ type: "partial", start: 900, end: 999 })
    expect(parseRange("BYTES = 10-20", 1000)).toEqual({ type: "partial", start: 10, end: 20 })
  })

  it("caps an open range at 8 MiB by default", () => {
    expect(parseRange("bytes=0-", 100 * MiB)).toEqual({
      type: "partial",
      start: 0,
      end: DEFAULT_MEDIA_MAX_RANGE_BYTES - 1,
    })
    expect(parseRange("bytes=10-", 100 * MiB, { maxChunkBytes: 100 })).toEqual({
      type: "partial",
      start: 10,
      end: 109,
    })
    expect(parseRange("bytes=0-99999999", 100 * MiB, { maxChunkBytes: 1000 })).toEqual({
      type: "partial",
      start: 0,
      end: 999,
    })
  })

  it("clamps the end to the last byte", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ type: "partial", start: 900, end: 999 })
    expect(parseRange("bytes=-5000", 1000)).toEqual({ type: "partial", start: 0, end: 999 })
  })

  it("caps a suffix range from its start", () => {
    expect(parseRange("bytes=-500", 1000, { maxChunkBytes: 100 })).toEqual({
      type: "partial",
      start: 500,
      end: 599,
    })
  })

  it("reports unsatisfiable ranges", () => {
    expect(parseRange("bytes=1000-", 1000)).toEqual({ type: "unsatisfiable" })
    expect(parseRange("bytes=2000-3000", 1000)).toEqual({ type: "unsatisfiable" })
    expect(parseRange("bytes=-0", 1000)).toEqual({ type: "unsatisfiable" })
  })

  it("ignores malformed, non-byte and multi-range headers (full response)", () => {
    for (const header of [
      "bytes=abc",
      "bytes=5-2",
      "bytes=-",
      "bytes=",
      "items=0-10",
      "bytes=0-1,5-6",
      "bytes 0-10",
      "bytes=1.5-2",
      "",
    ]) {
      expect(parseRange(header, 1000), header).toEqual({ type: "full" })
    }
    expect(parseRange(null, 1000)).toEqual({ type: "full" })
    expect(parseRange(undefined, 1000)).toEqual({ type: "full" })
  })

  it("serves empty files in full", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ type: "full" })
    expect(parseRange("bytes=-10", 0)).toEqual({ type: "full" })
  })
})

describe("mediaMaxRangeBytes", () => {
  it("reads MEETSUM_MEDIA_MAX_RANGE_BYTES with an 8 MiB default", () => {
    expect(mediaMaxRangeBytes({})).toBe(8_388_608)
    expect(mediaMaxRangeBytes({ MEETSUM_MEDIA_MAX_RANGE_BYTES: "1048576" })).toBe(1_048_576)
    expect(mediaMaxRangeBytes({ MEETSUM_MEDIA_MAX_RANGE_BYTES: "-5" })).toBe(8_388_608)
    expect(mediaMaxRangeBytes({ MEETSUM_MEDIA_MAX_RANGE_BYTES: "lots" })).toBe(8_388_608)
  })
})
