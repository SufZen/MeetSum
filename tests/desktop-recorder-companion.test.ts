import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildDesktopCaptureMetadata,
  createCaptureManifest,
  normalizeRecorderConfig,
} from "@/desktop-recorder/src/core/manifest"
import {
  listPendingCaptures,
  markCaptureUploaded,
  writeCaptureManifest,
} from "@/desktop-recorder/src/core/spool"
import { uploadDesktopCapture } from "@/desktop-recorder/src/core/uploader"

let tempDir: string | undefined

async function makeTempDir() {
  tempDir = await mkdtemp(join(tmpdir(), "meetsum-desktop-recorder-"))
  return tempDir
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe("MeetSum desktop recorder companion core", () => {
  it("normalizes connection config and strips unsafe URL suffixes", () => {
    expect(
      normalizeRecorderConfig({
        meetSumUrl: " https://meet.example.com/// ",
        apiKey: "  ms_secret  ",
        defaultLanguage: "mixed",
      })
    ).toEqual({
      meetSumUrl: "https://meet.example.com",
      apiKey: "ms_secret",
      defaultLanguage: "mixed",
    })
  })

  it("creates a stable capture manifest with desktop metadata", () => {
    const manifest = createCaptureManifest({
      title: "Planning call",
      startedAt: "2026-07-05T09:00:00.000Z",
      endedAt: "2026-07-05T09:30:00.000Z",
      language: "he",
      mediaPath: "C:/captures/planning.webm",
      contentType: "audio/webm",
      sizeBytes: 2048,
      metadata: buildDesktopCaptureMetadata({
        captureId: "cap_local_1",
        appVersion: "0.1.0",
        platform: "windows",
        microphoneName: "USB Mic",
        systemAudioName: "Speakers",
        sampleRate: 48000,
        durationMs: 1800000,
        localTranscription: { provider: "whisper.cpp", model: "large-v3" },
        uploadStatus: "spooled",
      }),
    })

    expect(manifest).toMatchObject({
      id: "cap_local_1",
      status: "spooled",
      meeting: {
        title: "Planning call",
        startedAt: "2026-07-05T09:00:00.000Z",
        endedAt: "2026-07-05T09:30:00.000Z",
        language: "he",
      },
      media: {
        path: "C:/captures/planning.webm",
        contentType: "audio/webm",
        sizeBytes: 2048,
      },
      captureMetadata: {
        captureId: "cap_local_1",
        appVersion: "0.1.0",
        platform: "windows",
        deviceNames: {
          microphone: "USB Mic",
          systemAudio: "Speakers",
        },
        sampleRate: 48000,
        durationMs: 1800000,
        localTranscription: { provider: "whisper.cpp", model: "large-v3" },
        uploadStatus: "spooled",
      },
    })
  })

  it("keeps pending captures in an offline spool and marks uploaded captures", async () => {
    const spoolDir = await makeTempDir()
    const manifest = createCaptureManifest({
      title: "Offline call",
      startedAt: "2026-07-05T10:00:00.000Z",
      mediaPath: join(spoolDir, "offline.webm"),
      contentType: "audio/webm",
      sizeBytes: 3,
      metadata: buildDesktopCaptureMetadata({
        captureId: "cap_spooled",
        uploadStatus: "spooled",
      }),
    })

    await writeCaptureManifest(spoolDir, manifest)
    expect(await listPendingCaptures(spoolDir)).toHaveLength(1)

    await markCaptureUploaded(spoolDir, "cap_spooled", "meet_123")
    expect(await listPendingCaptures(spoolDir)).toHaveLength(0)
    await expect(
      readFile(join(spoolDir, "cap_spooled.json"), "utf8").then(JSON.parse)
    ).resolves.toMatchObject({
      id: "cap_spooled",
      status: "uploaded",
      uploadedMeetingId: "meet_123",
    })
  })

  it("uploads a spooled capture to MeetSum using authenticated multipart form data", async () => {
    const manifest = createCaptureManifest({
      title: "Retryable capture",
      startedAt: "2026-07-05T11:00:00.000Z",
      mediaPath: "retryable.webm",
      contentType: "audio/webm",
      sizeBytes: 3,
      metadata: buildDesktopCaptureMetadata({
        captureId: "cap_retryable",
        platform: "windows",
        uploadStatus: "retry",
      }),
      transcriptSegments: [
        {
          text: "Local transcript is ready.",
          startMs: 0,
          endMs: 1200,
          confidence: 0.9,
          language: "en",
        },
      ],
    })
    const fetchMock = vi.fn(async () =>
      Response.json({ meeting: { id: "meet_uploaded" } }, { status: 202 })
    )

    const result = await uploadDesktopCapture(manifest, {
      meetSumUrl: "https://meet.example.com/",
      apiKey: "ms_key",
      readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
      fetch: fetchMock,
    })

    expect(result).toEqual({ meetingId: "meet_uploaded", status: 202 })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.example.com/api/desktop-capture/ingest",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer ms_key" },
      })
    )

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = init.body as FormData
    expect(JSON.parse(body.get("meeting") as string)).toMatchObject({
      title: "Retryable capture",
      startedAt: "2026-07-05T11:00:00.000Z",
    })
    expect(JSON.parse(body.get("captureMetadata") as string)).toMatchObject({
      captureId: "cap_retryable",
      uploadStatus: "retry",
    })
    expect(JSON.parse(body.get("transcript") as string)).toEqual([
      expect.objectContaining({ text: "Local transcript is ready." }),
    ])
    expect(body.get("file")).toBeInstanceOf(File)
  })
})
