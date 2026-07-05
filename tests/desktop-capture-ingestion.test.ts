import { describe, expect, it } from "vitest"

import {
  buildDesktopCaptureIngestionPlan,
  normalizeDesktopCaptureMetadata,
  normalizeDesktopTranscriptSegments,
  parseDesktopMeetingInput,
} from "@/lib/capture/desktop-ingestion"

describe("desktop capture ingestion", () => {
  it("normalizes unknown desktop meeting payloads into MeetSum meetings", () => {
    expect(
      parseDesktopMeetingInput({
        title: "  Local strategy recording  ",
        startedAt: "2026-07-05T09:00:00.000Z",
        endedAt: "2026-07-05T09:37:00.000Z",
        participants: [" Ran ", "", "Maya"],
        language: "mixed",
      })
    ).toEqual({
      meeting: {
        title: "Local strategy recording",
        source: "desktop_recorder",
        language: "mixed",
        startedAt: "2026-07-05T09:00:00.000Z",
        participants: ["Ran", "Maya"],
      },
      endedAt: "2026-07-05T09:37:00.000Z",
    })
  })

  it("cleans desktop transcript segments and keeps timing/confidence metadata", () => {
    const segments = normalizeDesktopTranscriptSegments(
      [
        {
          text: "  We approved the desktop recorder path. ",
          speaker: " Ran ",
          startMs: -100,
          endMs: 2400,
          confidence: 1.4,
          language: "en",
        },
        {
          text: "Next step is upload retry support.",
          startMs: 2400,
          endMs: 2400,
          confidence: 0.63,
        },
        { text: "   ", startMs: 3000, endMs: 4000 },
      ],
      "he"
    )

    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      speaker: "Ran",
      startMs: 0,
      endMs: 2400,
      text: "We approved the desktop recorder path.",
      confidence: 1,
      language: "en",
    })
    expect(segments[1]).toMatchObject({
      speaker: "Speaker 2",
      startMs: 2400,
      endMs: 3400,
      confidence: 0.63,
      language: "he",
    })
    expect(segments.every((segment) => segment.id.startsWith("seg_"))).toBe(true)
  })

  it("records only safe desktop capture metadata fields", () => {
    expect(
      normalizeDesktopCaptureMetadata({
        captureId: "capture_20260705_0900",
        appVersion: "0.1.0",
        platform: "windows",
        deviceNames: {
          microphone: "Built-in Mic",
          systemAudio: "Speakers",
          ignored: "secret",
        },
        sampleRate: 48000,
        durationMs: 122000,
        endedAt: "2026-07-05T09:37:00.000Z",
        localTranscription: {
          provider: "parakeet",
          model: "parakeet-tdt-0.6b-v3-int8",
        },
        uploadStatus: "spooled",
        accessToken: "must-not-persist",
      })
    ).toEqual({
      captureId: "capture_20260705_0900",
      appVersion: "0.1.0",
      platform: "windows",
      deviceNames: {
        microphone: "Built-in Mic",
        systemAudio: "Speakers",
      },
      sampleRate: 48000,
      durationMs: 122000,
      endedAt: "2026-07-05T09:37:00.000Z",
      localTranscription: {
        provider: "parakeet",
        model: "parakeet-tdt-0.6b-v3-int8",
      },
      uploadStatus: "spooled",
    })
  })

  it("routes transcript-bearing desktop captures to summarization without retranscribing", () => {
    expect(
      buildDesktopCaptureIngestionPlan({ hasFile: true, transcriptSegments: 1 })
    ).toMatchObject({
      jobName: "meeting.summarize",
      mode: "desktop-transcript",
    })

    expect(
      buildDesktopCaptureIngestionPlan({ hasFile: true, transcriptSegments: 0 })
    ).toMatchObject({
      jobName: "media.ingest",
      mode: "desktop-media",
    })
  })
})
