import { afterEach, describe, expect, it, vi } from "vitest"

import {
  handleZoomChallenge,
  isZoomChallenge,
  resetZoomTokenCache,
  selectZoomRecordingFile,
  verifyZoomSignature,
  zoomCaptureAdapter,
} from "@/lib/capture/zoom"
import { CaptureConfigError, RecordingDownloadError } from "@/lib/capture/types"
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

  it("rejects correctly signed but stale requests (replay)", () => {
    const body = JSON.stringify(sampleRecordingEvent)
    const headers = createZoomHeaders(body, MOCK_SECRET)
    const signedAtMs = Number(headers["x-zm-request-timestamp"]) * 1000

    expect(
      verifyZoomSignature(headers, body, MOCK_SECRET, { now: signedAtMs + 299_000 })
    ).toBe(true)
    expect(
      verifyZoomSignature(headers, body, MOCK_SECRET, { now: signedAtMs + 301_000 })
    ).toBe(false)
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

describe("zoom url validation challenge", () => {
  it("recognizes a well-formed endpoint.url_validation payload", () => {
    expect(
      isZoomChallenge({
        event: "endpoint.url_validation",
        payload: { plainToken: "abc123" },
      })
    ).toBe(true)
  })

  it("rejects challenges without a string plainToken and other events", () => {
    expect(isZoomChallenge({ event: "endpoint.url_validation" })).toBe(false)
    expect(
      isZoomChallenge({
        event: "endpoint.url_validation",
        payload: { plainToken: 42 },
      })
    ).toBe(false)
    expect(isZoomChallenge(sampleRecordingEvent)).toBe(false)
    expect(isZoomChallenge(null)).toBe(false)
  })
})

describe("zoom recording file selection", () => {
  const base = {
    meeting_id: "abc",
    recording_start: "2026-05-29T10:00:00Z",
    recording_end: "2026-05-29T10:30:00Z",
    file_size: 100,
    status: "completed",
  }

  it("prefers the audio-only M4A over MP4 views", () => {
    const chosen = selectZoomRecordingFile([
      { ...base, id: "v", file_type: "MP4", recording_type: "gallery_view", download_url: "https://zoom.us/rec/download/v" },
      { ...base, id: "t", file_type: "TRANSCRIPT", recording_type: "audio_transcript", download_url: "https://zoom.us/rec/download/t" },
      { ...base, id: "a", file_type: "M4A", recording_type: "audio_only", download_url: "https://zoom.us/rec/download/a" },
    ])

    expect(chosen?.id).toBe("a")
  })

  it("falls back to the preferred MP4 view and skips incomplete or non-media files", () => {
    const chosen = selectZoomRecordingFile([
      { ...base, id: "a", file_type: "M4A", recording_type: "audio_only", status: "processing", download_url: "https://zoom.us/rec/download/a" },
      { ...base, id: "chat", file_type: "CHAT", recording_type: "chat_file", download_url: "https://zoom.us/rec/download/c" },
      { ...base, id: "gallery", file_type: "MP4", recording_type: "gallery_view", download_url: "https://zoom.us/rec/download/g" },
      { ...base, id: "speaker", file_type: "MP4", recording_type: "speaker_view", download_url: "https://zoom.us/rec/download/s" },
    ])

    expect(chosen?.id).toBe("speaker")
  })

  it("parseEvent uses the audio file and ignores events without downloadable media", () => {
    const withAudio = structuredClone(sampleRecordingEvent)
    withAudio.payload.object.recording_files.push({
      id: "rec-audio",
      meeting_id: "abc-123-def",
      recording_start: "2026-05-29T10:00:00Z",
      recording_end: "2026-05-29T10:30:00Z",
      file_type: "M4A",
      file_extension: "M4A",
      file_size: 5000,
      download_url: "https://zoom.us/rec/download/audio.m4a",
      recording_type: "audio_only",
    })

    const event = zoomCaptureAdapter.parseEvent(withAudio)!

    expect(event.recordingUrl).toBe("https://zoom.us/rec/download/audio.m4a")
    expect(event.recordingMimeType).toBe("audio/mp4")
    expect(event.metadata.recordingFileId).toBe("rec-audio")

    const transcriptOnly = structuredClone(sampleRecordingEvent)
    transcriptOnly.payload.object.recording_files[0].file_type = "TRANSCRIPT"
    transcriptOnly.payload.object.recording_files[0].file_extension = "VTT"

    expect(zoomCaptureAdapter.parseEvent(transcriptOnly)).toBeNull()
  })
})

describe("zoom challenge secret", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("refuses to answer the challenge with an empty secret", () => {
    vi.stubEnv("ZOOM_WEBHOOK_SECRET", "")

    expect(() =>
      handleZoomChallenge({
        event: "endpoint.url_validation",
        payload: { plainToken: "abc" },
      })
    ).toThrow(CaptureConfigError)
  })

  it("answers with an HMAC of the plain token", () => {
    vi.stubEnv("ZOOM_WEBHOOK_SECRET", MOCK_SECRET)

    expect(
      handleZoomChallenge({
        event: "endpoint.url_validation",
        payload: { plainToken: "abc" },
      })
    ).toEqual({
      plainToken: "abc",
      encryptedToken: createHmac("sha256", MOCK_SECRET).update("abc").digest("hex"),
    })
  })
})

describe("zoom recording download", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetZoomTokenCache()
  })

  function stubZoomEnv() {
    vi.stubEnv("ZOOM_ACCOUNT_ID", "acct")
    vi.stubEnv("ZOOM_CLIENT_ID", "client")
    vi.stubEnv("ZOOM_CLIENT_SECRET", "secret")
  }

  it("downloads with a Bearer header (no access_token in the URL), streams, and caches the token", async () => {
    stubZoomEnv()
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)

      if (url.startsWith("https://zoom.us/oauth/token")) {
        return Response.json({ access_token: "tok-1", expires_in: 3600 })
      }

      return new Response("media-bytes", {
        status: 200,
        headers: { "content-length": "11" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const event = zoomCaptureAdapter.parseEvent(sampleRecordingEvent)!
    const first = await zoomCaptureAdapter.downloadRecording(event)
    await zoomCaptureAdapter.downloadRecording(event)

    const downloadCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes("oauth")
    )
    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("oauth")
    )

    expect(tokenCalls).toHaveLength(1)
    expect(downloadCalls).toHaveLength(2)
    expect(String(downloadCalls[0][0])).toBe(
      "https://zoom.us/rec/download/test-recording.mp4"
    )
    expect(String(downloadCalls[0][0])).not.toContain("access_token")
    expect((downloadCalls[0] as unknown as [string, RequestInit])[1].headers).toEqual({
      Authorization: "Bearer tok-1",
    })
    expect(first.sizeBytes).toBe(11)
    expect(first.contentType).toBe("video/mp4")
    expect(await new Response(first.body as ReadableStream).text()).toBe("media-bytes")
  })

  it("throws a config error when Zoom credentials are missing", async () => {
    vi.stubEnv("ZOOM_ACCOUNT_ID", "")
    vi.stubEnv("ZOOM_CLIENT_ID", "")
    vi.stubEnv("ZOOM_CLIENT_SECRET", "")
    vi.stubGlobal("fetch", vi.fn())

    const event = zoomCaptureAdapter.parseEvent(sampleRecordingEvent)!

    await expect(zoomCaptureAdapter.downloadRecording(event)).rejects.toBeInstanceOf(
      CaptureConfigError
    )
  })

  it("refuses non-Zoom download hosts", async () => {
    stubZoomEnv()
    vi.stubGlobal("fetch", vi.fn())

    const event = {
      ...zoomCaptureAdapter.parseEvent(sampleRecordingEvent)!,
      recordingUrl: "https://169.254.169.254/latest/meta-data",
    }

    await expect(zoomCaptureAdapter.downloadRecording(event)).rejects.toBeInstanceOf(
      CaptureConfigError
    )
  })

  it("surfaces HTTP failures with their status", async () => {
    stubZoomEnv()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("oauth")
          ? Response.json({ access_token: "tok", expires_in: 3600 })
          : new Response("gone", { status: 404 })
      )
    )

    const event = zoomCaptureAdapter.parseEvent(sampleRecordingEvent)!

    await expect(zoomCaptureAdapter.downloadRecording(event)).rejects.toMatchObject({
      status: 404,
    })
    await expect(zoomCaptureAdapter.downloadRecording(event)).rejects.toBeInstanceOf(
      RecordingDownloadError
    )
  })
})
