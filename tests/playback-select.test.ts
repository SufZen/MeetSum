import { describe, expect, it } from "vitest"

import type { MediaAsset } from "@/lib/meetings/repository"
import {
  baseContentType,
  describeMeetingMedia,
  selectPeaksSource,
  selectPlaybackAsset,
} from "@/lib/media/playback-select"

let clock = 0

function asset(overrides: Partial<MediaAsset> & { id: string }): MediaAsset {
  clock += 1
  return {
    meetingId: "m_1",
    storageKey: `meetings/m_1/${overrides.id}`,
    contentType: "audio/mpeg",
    sizeBytes: 100,
    retention: "audio",
    kind: "original",
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, clock)).toISOString(),
    ...overrides,
  }
}

describe("selectPlaybackAsset (audio)", () => {
  it("prefers the newest playback rendition", () => {
    const original = asset({ id: "orig", contentType: "audio/wav" })
    const oldPlayback = asset({ id: "p1", kind: "playback", contentType: "audio/mp4", derivedFromAssetId: "orig" })
    const newPlayback = asset({ id: "p2", kind: "playback", contentType: "audio/mp4", derivedFromAssetId: "orig" })

    expect(selectPlaybackAsset([newPlayback, original, oldPlayback])?.id).toBe("p2")
  })

  it("falls back to the newest browser-playable original audio", () => {
    const opus = asset({ id: "old", contentType: "audio/ogg" })
    const m4a = asset({ id: "new", contentType: "audio/x-m4a; codecs=mp4a" })
    const amr = asset({ id: "newest", contentType: "audio/amr" })

    expect(selectPlaybackAsset([opus, m4a, amr], "audio")?.id).toBe("new")
  })

  it("falls back to an mp4/webm original video, then none", () => {
    const video = asset({ id: "vid", contentType: "video/webm", retention: "audio" })
    const mkv = asset({ id: "mkv", contentType: "video/x-matroska" })

    expect(selectPlaybackAsset([video, mkv])?.id).toBe("vid")
    expect(selectPlaybackAsset([mkv])).toBeUndefined()
    expect(selectPlaybackAsset([])).toBeUndefined()
  })

  it("skips assets without a storage key", () => {
    expect(selectPlaybackAsset([asset({ id: "x", storageKey: "" })])).toBeUndefined()
  })
})

describe("selectPlaybackAsset (video)", () => {
  it("returns only a retained mp4/webm original", () => {
    const retained = asset({ id: "keep", contentType: "video/mp4", retention: "video" })
    const audioOnly = asset({ id: "audio-ret", contentType: "video/mp4", retention: "audio" })
    const playback = asset({ id: "p", kind: "playback", contentType: "video/mp4", retention: "video" })

    expect(selectPlaybackAsset([retained, audioOnly, playback], "video")?.id).toBe("keep")
    expect(selectPlaybackAsset([audioOnly, playback], "video")).toBeUndefined()
    expect(
      selectPlaybackAsset([asset({ id: "mov", contentType: "video/quicktime", retention: "video" })], "video")
    ).toBeUndefined()
  })
})

describe("selectPeaksSource / describeMeetingMedia", () => {
  it("uses the playback's original for peaks and duration", () => {
    const original = asset({
      id: "orig",
      contentType: "video/mp4",
      retention: "video",
      peaksStorageKey: "k/orig.peaks.v1.json",
      durationMs: 61_000,
    })
    const playback = asset({
      id: "play",
      kind: "playback",
      contentType: "audio/mp4",
      derivedFromAssetId: "orig",
      sizeBytes: 42,
    })

    expect(selectPeaksSource([original, playback])?.id).toBe("orig")
    expect(describeMeetingMedia([original, playback])).toEqual({
      available: true,
      audio: { assetId: "play", contentType: "audio/mp4", sizeBytes: 42, kind: "playback" },
      video: {
        assetId: "orig",
        contentType: "video/mp4",
        sizeBytes: 100,
        kind: "original",
        durationMs: 61_000,
      },
      peaks: true,
      durationMs: 61_000,
    })
  })

  it("reports no media and no peaks for an empty meeting", () => {
    expect(describeMeetingMedia([])).toEqual({ available: false, peaks: false })
  })

  it("never leaks storage keys in the summary", () => {
    const summary = describeMeetingMedia([asset({ id: "a", peaksStorageKey: "secret/key" })])

    expect(JSON.stringify(summary)).not.toContain("meetings/")
    expect(JSON.stringify(summary)).not.toContain("secret/key")
    expect(summary.peaks).toBe(true)
  })

  it("normalizes content types", () => {
    expect(baseContentType(" Audio/MP4 ; codecs=mp4a.40.2")).toBe("audio/mp4")
    expect(baseContentType(undefined)).toBe("")
  })
})
