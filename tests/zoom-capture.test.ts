import { describe, expect, it } from "vitest"

import { verifyZoomSignature, zoomCaptureAdapter } from "@/lib/capture/zoom"
import { createHmac } from "node:crypto"

const MOCK_SECRET = "test-zoom-webhook-secret"

function createZoomHeaders(body: string, secret: string) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const message = `v0:${timestamp}:${body}`
  const signature = `v0=${createHmac("sha256", secret).update(message).digest("hex")}`

  return {
    "x-zm-request-timestamp": timestamp,
    "x-zm-signature": signature,
  }
}

const sampleRecordingEvent = {
  event: "recording.completed",
  payload: {
    object: {
      uuid: "abc-123-def",
      id: 12345,
      topic: "Weekly Team Standup",
      start_time: "2026-05-29T10:00:00Z",
      duration: 30,
      participant_count: 5,
      recording_files: [
        {
          id: "rec-1",
          meeting_id: "abc-123-def",
          recording_start: "2026-05-29T10:00:00Z",
          recording_end: "2026-05-29T10:30:00Z",
          file_type: "MP4",
          file_extension: "MP4",
          file_size: 150000000,
          download_url: "https://zoom.us/rec/download/test-recording.mp4",
          recording_type: "shared_screen_with_speaker_view",
        },
      ],
    },
  },
}

describe("zoom webhook signature", () => {
  it("verifies valid signature", () => {
    const body = JSON.stringify(sampleRecordingEvent)
    const headers = createZoomHeaders(body, MOCK_SECRET)

    expect(verifyZoomSignature(headers, body, MOCK_SECRET)).toBe(true)
  })

  it("rejects invalid signature", () => {
    const body = JSON.stringify(sampleRecordingEvent)
    const headers = createZoomHeaders(body, MOCK_SECRET)

    expect(verifyZoomSignature(headers, body, "wrong-secret")).toBe(false)
  })

  it("rejects missing timestamp", () => {
    expect(
      verifyZoomSignature({}, JSON.stringify(sampleRecordingEvent), MOCK_SECRET)
    ).toBe(false)
  })

  it("rejects tampered body", () => {
    const body = JSON.stringify(sampleRecordingEvent)
    const headers = createZoomHeaders(body, MOCK_SECRET)

    expect(verifyZoomSignature(headers, body + "tampered", MOCK_SECRET)).toBe(false)
  })
})

describe("zoom capture adapter", () => {
  it("parses recording.completed event", () => {
    const event = zoomCaptureAdapter.parseEvent(sampleRecordingEvent)

    expect(event).not.toBeNull()
    expect(event!.platform).toBe("zoom")
    expect(event!.eventType).toBe("recording.available")
    expect(event!.externalId).toBe("abc-123-def")
    expect(event!.title).toBe("Weekly Team Standup")
    expect(event!.recordingUrl).toContain("download")
  })

  it("returns null for non-recording events", () => {
    const event = zoomCaptureAdapter.parseEvent({
      event: "meeting.started",
      payload: { object: {} },
    })

    expect(event).toBeNull()
  })

  it("converts event to meeting input", () => {
    const event = zoomCaptureAdapter.parseEvent(sampleRecordingEvent)!
    const input = zoomCaptureAdapter.toMeetingInput(event)

    expect(input.title).toBe("Weekly Team Standup")
    expect(input.source).toBe("zoom")
    expect(input.language).toBe("auto")
    expect(input.startedAt).toBe("2026-05-29T10:00:00Z")
  })

  it("extracts metadata from recording event", () => {
    const event = zoomCaptureAdapter.parseEvent(sampleRecordingEvent)!

    expect(event.metadata.zoomMeetingId).toBe(12345)
    expect(event.metadata.duration).toBe(30)
    expect(event.metadata.participantCount).toBe(5)
  })
})

describe("zoom adapter validation", () => {
  it("rejects when ZOOM_WEBHOOK_SECRET is not set", () => {
    const origSecret = process.env.ZOOM_WEBHOOK_SECRET
    delete process.env.ZOOM_WEBHOOK_SECRET

    const result = zoomCaptureAdapter.validateWebhook({}, "")

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain("ZOOM_WEBHOOK_SECRET")
    }

    if (origSecret) process.env.ZOOM_WEBHOOK_SECRET = origSecret
  })
})
