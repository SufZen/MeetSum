import { describe, expect, it } from "vitest"

type RetentionPolicy = {
  audioMaxDays: number
  videoRetention: "opt-in" | "all" | "none"
  dryRun: boolean
}

type MediaCandidate = {
  id: string
  meetingId: string
  storageKey: string
  contentType: string
  sizeBytes: number
  createdAt: string
}

function getExpiredMedia(
  candidates: MediaCandidate[],
  policy: RetentionPolicy,
  now: Date = new Date()
): MediaCandidate[] {
  return candidates.filter((item) => {
    const ageMs = now.getTime() - new Date(item.createdAt).getTime()
    const ageDays = ageMs / (1000 * 60 * 60 * 24)

    const isAudio = item.contentType.startsWith("audio/")
    const isVideo = item.contentType.startsWith("video/")

    if (isAudio && ageDays > policy.audioMaxDays) return true
    if (isVideo && policy.videoRetention === "none") return true

    return false
  })
}

const now = new Date("2026-06-15T00:00:00Z")

const sampleMedia: MediaCandidate[] = [
  {
    id: "m1",
    meetingId: "mtg_1",
    storageKey: "audio/old.wav",
    contentType: "audio/wav",
    sizeBytes: 50000000,
    createdAt: "2025-12-01T00:00:00Z", // 197 days old
  },
  {
    id: "m2",
    meetingId: "mtg_2",
    storageKey: "audio/recent.wav",
    contentType: "audio/wav",
    sizeBytes: 30000000,
    createdAt: "2026-06-01T00:00:00Z", // 14 days old
  },
  {
    id: "m3",
    meetingId: "mtg_3",
    storageKey: "video/meeting.mp4",
    contentType: "video/mp4",
    sizeBytes: 500000000,
    createdAt: "2026-05-01T00:00:00Z", // 45 days old
  },
  {
    id: "m4",
    meetingId: "mtg_4",
    storageKey: "application/pdf",
    contentType: "application/pdf",
    sizeBytes: 100000,
    createdAt: "2025-01-01T00:00:00Z", // 531 days old
  },
]

describe("media retention enforcement", () => {
  it("expires audio files older than policy threshold", () => {
    const expired = getExpiredMedia(
      sampleMedia,
      { audioMaxDays: 180, videoRetention: "opt-in", dryRun: false },
      now
    )

    expect(expired).toHaveLength(1)
    expect(expired[0].id).toBe("m1") // 197 days old, exceeds 180
  })

  it("retains recent audio files", () => {
    const expired = getExpiredMedia(
      sampleMedia,
      { audioMaxDays: 180, videoRetention: "opt-in", dryRun: false },
      now
    )

    const recent = expired.find((e) => e.id === "m2")
    expect(recent).toBeUndefined() // 14 days old, within 180
  })

  it("does not expire video when policy is opt-in", () => {
    const expired = getExpiredMedia(
      sampleMedia,
      { audioMaxDays: 180, videoRetention: "opt-in", dryRun: false },
      now
    )

    const video = expired.find((e) => e.id === "m3")
    expect(video).toBeUndefined()
  })

  it("expires all video when policy is none", () => {
    const expired = getExpiredMedia(
      sampleMedia,
      { audioMaxDays: 180, videoRetention: "none", dryRun: false },
      now
    )

    const video = expired.find((e) => e.id === "m3")
    expect(video).toBeDefined()
  })

  it("never expires non-media files (PDF, etc)", () => {
    const expired = getExpiredMedia(
      sampleMedia,
      { audioMaxDays: 1, videoRetention: "none", dryRun: false },
      now
    )

    const pdf = expired.find((e) => e.id === "m4")
    expect(pdf).toBeUndefined()
  })

  it("respects custom audio threshold", () => {
    const expired = getExpiredMedia(
      sampleMedia,
      { audioMaxDays: 7, videoRetention: "opt-in", dryRun: false },
      now
    )

    // Both audio files are older than 7 days
    const audioExpired = expired.filter((e) =>
      e.contentType.startsWith("audio/")
    )
    expect(audioExpired).toHaveLength(2)
  })

  it("returns empty when no media exceeds policy", () => {
    const expired = getExpiredMedia(
      sampleMedia,
      { audioMaxDays: 999, videoRetention: "opt-in", dryRun: false },
      now
    )

    expect(expired).toHaveLength(0)
  })
})
