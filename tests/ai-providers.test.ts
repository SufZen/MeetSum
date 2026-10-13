import { describe, expect, it } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { createCircuitBreaker } from "@/lib/ai/asr/breaker"
import type { AsrProvider, AsrResult } from "@/lib/ai/asr/types"
import {
  asrResultToTranscriptSegments,
  AsrRouterTranscriptionProvider,
  AutoTranscriptionProvider,
  getLocalWhisperProviderConfig,
  getTranscriptionProviderMode,
  HeuristicFallbackProvider,
  isLocalWhisperConfigured,
  normalizeLocalWhisperResponse,
  TranscriptionUnavailableError,
  type TranscriptionProvider,
} from "@/lib/ai/providers"
import type { MeetingRecord, TranscriptSegment } from "@/lib/meetings/repository"

describe("HeuristicFallbackProvider honesty", () => {
  const base: MeetingRecord = {
    id: "meet_x",
    title: "No ASR configured",
    source: "upload",
    language: "he",
    status: "media_uploaded",
    retention: "audio",
    startedAt: "2026-06-10T09:00:00.000Z",
    participants: ["Ran"],
  }

  it("throws instead of fabricating a placeholder transcript", async () => {
    const provider = new HeuristicFallbackProvider()

    await expect(provider.transcribe(base)).rejects.toBeInstanceOf(
      TranscriptionUnavailableError
    )
  })

  it("passes through an already-imported transcript", async () => {
    const provider = new HeuristicFallbackProvider()
    const withTranscript: MeetingRecord = {
      ...base,
      transcript: [
        {
          id: "seg_1",
          speaker: "Ran",
          startMs: 0,
          endMs: 4000,
          text: "נדבר על התקציב",
          confidence: 0.9,
          language: "he",
        },
      ],
    }

    await expect(provider.transcribe(withTranscript)).resolves.toHaveLength(1)
  })
})

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

describe("ASR router adapter (deprecated TranscriptionProvider)", () => {
  const asrResult: AsrResult = {
    provider: "soniox",
    model: "stt-async-v3",
    language: "he",
    durationMs: 3000,
    segments: [
      {
        startMs: 0,
        endMs: 1500,
        text: "עוברים ל-Supabase",
        speaker: "Speaker 1",
        turnIndex: 0,
        confidence: 0.9,
        language: "he",
        words: [
          { startMs: 0, endMs: 600, text: "עוברים", confidence: 0.95, language: "he", speaker: "Speaker 1" },
          { startMs: 600, endMs: 1500, text: "ל-Supabase", confidence: 0.85, language: "en", speaker: "Speaker 1" },
        ],
      },
      {
        startMs: 2000,
        endMs: 3000,
        text: "מעולה",
        speaker: "Speaker 2",
        turnIndex: 1,
        language: "he",
        words: [{ startMs: 2000, endMs: 3000, text: "מעולה", language: "he" }],
      },
    ],
    speakers: [],
    diarization: "provider",
    cost: { usd: 0.0001, basis: "audio_hours" },
    timings: {},
    glossaryReplacements: 1,
    warnings: [],
  }

  it("converts router segments to transcript segments with words and turns", () => {
    const segments = asrResultToTranscriptSegments(asrResult)

    expect(segments[0]).toMatchObject({
      speaker: "Speaker 1",
      startMs: 0,
      endMs: 1500,
      text: "עוברים ל-Supabase",
      turnIndex: 0,
      source: "asr",
      language: "he",
      words: [
        { startMs: 0, endMs: 600, text: "עוברים", confidence: 0.95 },
        { startMs: 600, endMs: 1500, text: "ל-Supabase", confidence: 0.85, language: "en" },
      ],
    })
    expect(segments[0].words?.[0]).not.toHaveProperty("language")
    expect(segments[0].id).toMatch(/^seg_/)
    expect(segments[1].turnIndex).toBe(1)
  })

  it("transcribes a meeting's media through the router and records the fallback", async () => {
    const failing: AsrProvider = {
      id: "runpod-ivrit",
      model: "ivrit",
      isConfigured: () => true,
      healthCheck: async () => ({ provider: "runpod-ivrit", configured: true, healthy: true }),
      transcribe: async () => {
        const { AsrError } = await import("@/lib/ai/asr/types")
        throw new AsrError("HTTP 503", "server", "runpod-ivrit", true, 503)
      },
    }
    const requests: unknown[] = []
    const working: AsrProvider = {
      id: "soniox",
      model: "stt-async-v3",
      isConfigured: () => true,
      healthCheck: async () => ({ provider: "soniox", configured: true, healthy: true }),
      transcribe: async (req) => {
        requests.push(req)
        return asrResult
      },
    }
    const adapter = new AsrRouterTranscriptionProvider({
      env: {},
      providers: [failing, working],
      breaker: createCircuitBreaker(),
    })
    const meeting: MeetingRecord = {
      id: "meet_asr",
      title: "Router",
      source: "upload",
      language: "he",
      status: "media_uploaded",
      retention: "audio",
      startedAt: "2026-06-10T09:00:00.000Z",
      participants: [],
      workspaceId: "ws_1",
      mediaAssets: [
        {
          id: "asset_1",
          meetingId: "meet_asr",
          storageKey: "meetings/meet_asr/a.m4a",
          filename: "a.m4a",
          contentType: "audio/mp4",
          sizeBytes: 1234,
          retention: "audio",
          createdAt: "2026-06-10T09:00:00.000Z",
        },
      ],
    }

    const segments = await adapter.transcribe(meeting)

    expect(segments).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      meetingId: "meet_asr",
      workspaceId: "ws_1",
      language: "he",
      diarize: true,
      glossary: DEFAULT_ASR_GLOSSARY,
      media: { kind: "object", storageKey: "meetings/meet_asr/a.m4a", contentType: "audio/mp4", sizeBytes: 1234 },
    })
    expect(adapter.getLastRun()).toMatchObject({
      provider: "soniox",
      model: "stt-async-v3",
      fallbackUsed: true,
      attemptedProvider: "runpod-ivrit",
      fallbackReason: "HTTP 503",
    })
  })

  it("passes through an imported transcript when there is no media", async () => {
    const adapter = new AsrRouterTranscriptionProvider({ env: {}, providers: [] })
    const meeting: MeetingRecord = {
      id: "meet_t",
      title: "Imported",
      source: "upload",
      language: "he",
      status: "media_uploaded",
      retention: "audio",
      startedAt: "2026-06-10T09:00:00.000Z",
      participants: [],
      transcript: [{ id: "s", speaker: "Ran", startMs: 0, endMs: 1000, text: "שלום", language: "he" }],
    }

    await expect(adapter.transcribe(meeting)).resolves.toHaveLength(1)
    await expect(adapter.transcribe({ ...meeting, transcript: [] })).rejects.toBeInstanceOf(TranscriptionUnavailableError)
  })
})
