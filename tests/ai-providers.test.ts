import { describe, expect, it } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { createCircuitBreaker } from "@/lib/ai/asr/breaker"
import type { AsrProvider, AsrResult } from "@/lib/ai/asr/types"
import {
  asrResultToTranscriptSegments,
  AsrRouterTranscriptionProvider,
  createSummaryProvider,
  getLocalWhisperProviderConfig,
  getTranscriptionProviderMode,
  HeuristicFallbackProvider,
  isLocalWhisperConfigured,
  PipelineSummaryProvider,
  TranscriptionUnavailableError,
} from "@/lib/ai/providers"
import type { MeetingRecord } from "@/lib/meetings/repository"

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
          kind: "original",
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

describe("summary provider adapter (M5)", () => {
  const meeting: MeetingRecord = {
    id: "meet_s",
    title: "Weekly",
    source: "upload",
    language: "he",
    status: "summarizing",
    retention: "audio",
    startedAt: "2026-10-15T07:00:00.000Z",
    participants: [],
    transcript: [{ id: "seg_1", speaker: "דנה", startMs: 0, endMs: 3_000, text: "יש בעיה עם הספק" }],
  }

  it("createSummaryProvider is the pipeline adapter with the new Gemini default", () => {
    const provider = createSummaryProvider()

    expect(provider).toBeInstanceOf(PipelineSummaryProvider)
    expect(provider.model).toBe(process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "gemini-3.8-flash")
  })

  it("the heuristic provider returns the V2 shape without chapters", async () => {
    const intelligence = await new HeuristicFallbackProvider().summarize(meeting, { language: "he" })

    expect(intelligence.version).toBe(2)
    expect(intelligence.generation).toMatchObject({
      provider: "heuristic",
      model: "heuristic-v1",
      language: "he",
      fallbackUsed: true,
    })
    expect(intelligence.chapters).toBeUndefined()
    expect(intelligence.items?.[0]).toMatchObject({
      kind: "risk",
      refs: [{ segmentId: "seg_1", startMs: 0 }],
    })
  })

  it("records the pipeline run in getLastRun", async () => {
    const provider = new PipelineSummaryProvider()
    const saved = {
      gemini: process.env.GOOGLE_GEMINI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      vertex: process.env.GOOGLE_GENAI_USE_VERTEXAI,
    }

    delete process.env.GOOGLE_GEMINI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI
    try {
      await provider.summarize(meeting)
    } finally {
      if (saved.gemini !== undefined) process.env.GOOGLE_GEMINI_API_KEY = saved.gemini
      if (saved.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = saved.anthropic
      if (saved.vertex !== undefined) process.env.GOOGLE_GENAI_USE_VERTEXAI = saved.vertex
    }

    expect(provider.getLastRun()).toMatchObject({
      provider: "heuristic",
      model: "heuristic-v1",
      fallbackUsed: true,
      pipeline: { promptVersion: "m5.1" },
    })
  })
})
