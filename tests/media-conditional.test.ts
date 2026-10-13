import { describe, expect, it } from "vitest"

import {
  evaluateConditionals,
  httpDate,
  mediaAssetEtag,
  peaksEtag,
} from "@/lib/media/conditional"

const etag = '"a-asset_1-abcdef12"'
const lastModified = new Date("2026-10-01T10:00:00.000Z")

function evaluate(headers: Record<string, string>, method = "GET") {
  return evaluateConditionals({ method, headers: new Headers(headers), etag, lastModified })
}

describe("media validators", () => {
  it("builds strong asset ETags from the checksum, else the creation time", () => {
    expect(
      mediaAssetEtag({ id: "asset_1", checksumSha256: "abcdef1234567890", createdAt: "x" })
    ).toBe('"a-asset_1-abcdef12"')
    expect(mediaAssetEtag({ id: "asset_2", createdAt: "2026-10-01T10:00:00.900Z" })).toBe(
      `"a-asset_2-${Date.parse("2026-10-01T10:00:00Z") / 1000}"`
    )
  })

  it("builds peaks ETags from preparedAt", () => {
    expect(peaksEtag({ id: "asset_1", preparedAt: "2026-10-01T10:00:00.000Z" })).toBe(
      `"p-asset_1-${Date.parse("2026-10-01T10:00:00Z") / 1000}"`
    )
    expect(peaksEtag({ id: "asset_1" })).toBe('"p-asset_1-0"')
  })

  it("truncates Last-Modified to whole seconds", () => {
    expect(httpDate("2026-10-01T10:00:00.999Z").toISOString()).toBe("2026-10-01T10:00:00.000Z")
  })
})

describe("evaluateConditionals", () => {
  it("proceeds without validators", () => {
    expect(evaluate({})).toBe("proceed")
    expect(evaluate({ range: "bytes=0-" })).toBe("proceed")
  })

  it("answers 304 to a matching If-None-Match (weak comparison, lists, *)", () => {
    expect(evaluate({ "if-none-match": etag })).toBe("not_modified")
    expect(evaluate({ "if-none-match": `W/${etag}` })).toBe("not_modified")
    expect(evaluate({ "if-none-match": `"other", ${etag}` })).toBe("not_modified")
    expect(evaluate({ "if-none-match": "*" })).toBe("not_modified")
    expect(evaluate({ "if-none-match": etag }, "HEAD")).toBe("not_modified")
    expect(evaluate({ "if-none-match": '"other"' })).toBe("proceed")
    expect(evaluate({ "if-none-match": etag }, "POST")).toBe("proceed")
  })

  it("uses If-Modified-Since only without If-None-Match", () => {
    expect(evaluate({ "if-modified-since": lastModified.toUTCString() })).toBe("not_modified")
    expect(evaluate({ "if-modified-since": "Wed, 01 Oct 2025 10:00:00 GMT" })).toBe("proceed")
    expect(
      evaluate({ "if-none-match": '"other"', "if-modified-since": lastModified.toUTCString() })
    ).toBe("proceed")
    expect(evaluate({ "if-modified-since": "garbage" })).toBe("proceed")
  })

  it("honours a matching If-Range (strong ETag or exact date)", () => {
    expect(evaluate({ range: "bytes=0-", "if-range": etag })).toBe("proceed")
    expect(evaluate({ range: "bytes=0-", "if-range": lastModified.toUTCString() })).toBe(
      "proceed"
    )
  })

  it("ignores the range when If-Range does not match", () => {
    expect(evaluate({ range: "bytes=0-", "if-range": '"a-asset_1-stale"' })).toBe("ignore_range")
    expect(evaluate({ range: "bytes=0-", "if-range": `W/${etag}` })).toBe("ignore_range")
    expect(
      evaluate({ range: "bytes=0-", "if-range": "Wed, 01 Oct 2025 10:00:00 GMT" })
    ).toBe("ignore_range")
    expect(evaluate({ range: "bytes=0-", "if-range": "not a date" })).toBe("ignore_range")
  })

  it("ignores If-Range without a Range header", () => {
    expect(evaluate({ "if-range": '"stale"' })).toBe("proceed")
  })
})
