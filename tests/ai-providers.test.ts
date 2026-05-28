import { describe, expect, it } from "vitest"

import {
  AutoTranscriptionProvider,
  getLocalWhisperProviderConfig,
  getTranscriptionProviderMode,
  isLocalWhisperConfigured,
  normalizeLocalWhisperResponse,
  type TranscriptionProvider,
} from "@/lib/ai/providers"
import type { MeetingRecord, TranscriptSegment } from "@/lib/meetings/repository"

const meeting: MeetingRecord = {
  id: "meet_hebrew",
  title: "Hebrew product review",
  source: "google_meet",
  language: "he",
  status: "media_uploaded",
  retention: "audio",
  startedAt: "2026-05-17T09:00:00.000Z",
  participants: ["Ran"],
}

function provider(
  id: string,
  segments: TranscriptSegment[],
  shouldFail = false
): TranscriptionProvider {
  return {
    id,
    model: `${id}-model`,
    async transcribe() {
      if (shouldFail) throw new Error(`${id} unavailable`)
      return segments
    },
  }
}

describe("AI transcription provider selection", () => {
  it("defaults transcription provider mode to auto", () => {
    expect(getTranscriptionProviderMode({})).toBe("auto")
  })

  it("normalizes supported transcription provider modes", () => {
    expect(
      getTranscriptionProviderMode({ MEETSUM_TRANSCRIPTION_PROVIDER: "local-whisper" })
    ).toBe("local-whisper")
    expect(getTranscriptionProviderMode({ MEETSUM_TRANSCRIPTION_PROVIDER: "auto" })).toBe(
      "auto"
    )
    expect(
      getTranscriptionProviderMode({ MEETSUM_TRANSCRIPTION_PROVIDER: "unexpected" })
    ).toBe("auto")
  })

  it("detects and normalizes local Whisper configuration", () => {
    const env = {
      LOCAL_TRANSCRIPTION_URL: "http://faster-whisper:8000/",
      LOCAL_TRANSCRIPTION_MODEL: "ivrit-ai/whisper-large-v3-turbo-ct2",
      LOCAL_TRANSCRIPTION_LANGUAGE: "he",
      LOCAL_TRANSCRIPTION_TIMEOUT_MS: "120000",
    }

    expect(isLocalWhisperConfigured(env)).toBe(true)
    expect(getLocalWhisperProviderConfig(env)).toEqual({
      baseUrl: "http://faster-whisper:8000",
      model: "ivrit-ai/whisper-large-v3-turbo-ct2",
      language: "he",
      timeoutMs: 120000,
    })
  })

  it("normalizes verbose local Whisper JSON segments into transcript segments", () => {
    const segments = normalizeLocalWhisperResponse(
      {
        segments: [
          {
            start: 1.25,
            end: 4.5,
            text: " שלום, צריך לבדוק את RealizeOS ",
            language: "he",
            confidence: 0.91,
          },
        ],
      },
      meeting
    )

    expect(segments).toEqual([
      expect.objectContaining({
        speaker: "Speaker 1",
        startMs: 1250,
        endMs: 4500,
        text: "שלום, צריך לבדוק את RealizeOS",
        language: "he",
        confidence: 0.91,
      }),
    ])
  })

  it("normalizes plain local Whisper text into a safe transcript segment", () => {
    const segments = normalizeLocalWhisperResponse("זה תמלול קצר בעברית", meeting)

    expect(segments).toEqual([
      expect.objectContaining({
        speaker: "Speaker 1",
        startMs: 0,
        endMs: 5000,
        text: "זה תמלול קצר בעברית",
        language: "he",
        confidence: 0.72,
      }),
    ])
  })

  it("auto provider falls back to Gemini and records the actual provider used", async () => {
    const fallbackSegments = [
      {
        id: "seg_fallback",
        speaker: "Speaker 1",
        startMs: 0,
        endMs: 5000,
        text: "Gemini fallback transcript",
        confidence: 0.8,
        language: "en",
      },
    ]
    const auto = new AutoTranscriptionProvider(
      provider("local-whisper", [], true),
      provider("gemini", fallbackSegments)
    )

    await expect(auto.transcribe(meeting)).resolves.toEqual(fallbackSegments)
    const lastRun = auto.getLastRun()
    expect(lastRun.provider).toBe("gemini")
    expect(lastRun.model).toBe("gemini-model")
    expect(lastRun.fallbackUsed).toBe(true)
    expect(lastRun.attemptedProvider).toBe("local-whisper")
    expect(lastRun.fallbackReason).toBe("local-whisper unavailable")
    expect(lastRun.fallbackCategory).toBe("unknown")
    expect(typeof lastRun.fallbackElapsedMs).toBe("number")
  })

  it("auto provider uses local Whisper first for Hebrew meetings", async () => {
    const localSegments = [
      {
        id: "seg_local",
        speaker: "Speaker 1",
        startMs: 0,
        endMs: 5000,
        text: "תמלול מקומי",
        confidence: 0.88,
        language: "he",
      },
    ]
    const auto = new AutoTranscriptionProvider(
      provider("local-whisper", localSegments),
      provider("gemini", [])
    )

    await expect(auto.transcribe(meeting)).resolves.toEqual(localSegments)
    expect(auto.getLastRun()).toEqual({
      provider: "local-whisper",
      model: "local-whisper-model",
    })
  })

  it("auto provider skips local Hebrew ASR for clearly non-Hebrew meetings", async () => {
    const englishMeeting = { ...meeting, language: "en" }
    const fallbackSegments = [
      {
        id: "seg_gemini",
        speaker: "Speaker 1",
        startMs: 0,
        endMs: 5000,
        text: "English transcript",
        confidence: 0.8,
        language: "en",
      },
    ]
    const auto = new AutoTranscriptionProvider(
      provider("local-whisper", []),
      provider("gemini", fallbackSegments)
    )

    await expect(auto.transcribe(englishMeeting)).resolves.toEqual(fallbackSegments)
    expect(auto.getLastRun()).toEqual({
      provider: "gemini",
      model: "gemini-model",
      fallbackUsed: false,
    })
  })
})
