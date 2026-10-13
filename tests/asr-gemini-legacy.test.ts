import { describe, expect, it, vi } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { createGeminiLegacyProvider } from "@/lib/ai/asr/providers/gemini-legacy"
import type { AsrRequest } from "@/lib/ai/asr/types"
import type { MeetingRecord } from "@/lib/meetings/repository"

const env = { GOOGLE_GEMINI_API_KEY: "g-test" }

function request(overrides: Partial<AsrRequest> = {}): AsrRequest {
  return {
    meetingId: "meet_1",
    workspaceId: "ws_1",
    language: "he",
    media: { kind: "object", storageKey: "meetings/meet_1/a.m4a", contentType: "audio/mp4", filename: "a.m4a", sizeBytes: 1000 },
    glossary: DEFAULT_ASR_GLOSSARY,
    diarize: true,
    ...overrides,
  }
}

const segments = [
  { id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 2000, text: "שלום לכולם", confidence: 0.8, language: "he" },
  { id: "s2", speaker: "Speaker 2", startMs: 2500, endMs: 4000, text: "[uncertain] עוברים לסופבייס", confidence: 0.6, language: "he" },
]

describe("Gemini legacy ASR provider", () => {
  it("wraps Gemini segments with synthetic words and LLM warnings", async () => {
    const transcribeSegments = vi.fn(async (meeting: MeetingRecord) => {
      void meeting
      return { segments, usage: { totalTokenCount: 250_000 } }
    })
    const provider = createGeminiLegacyProvider({
      env: { ...env, GOOGLE_GEMINI_AUDIO_PRICE_PER_MTOK: "2" },
      transcribeSegments,
    })
    const result = await provider.transcribe(request())

    expect(transcribeSegments.mock.calls[0][0]).toMatchObject({
      id: "meet_1",
      language: "he",
      workspaceId: "ws_1",
      mediaAssets: [expect.objectContaining({ storageKey: "meetings/meet_1/a.m4a", contentType: "audio/mp4" })],
    })
    expect(result.provider).toBe("gemini-legacy")
    expect(result.warnings).toEqual(expect.arrayContaining(["llm_transcript", "synthetic_word_timings"]))
    expect(result.segments.map((segment) => segment.text)).toEqual(["שלום לכולם", "עוברים ל-Supabase"])
    expect(result.segments[1].words.length).toBe(2)
    expect(result.cost).toEqual({ usd: 0.5, basis: "tokens", unitPrice: 2 })
  })

  it("reports a null cost without a configured token price", async () => {
    const provider = createGeminiLegacyProvider({ env, transcribeSegments: async () => ({ segments }) })

    await expect(provider.transcribe(request())).resolves.toMatchObject({ cost: { usd: null, basis: "none" } })
  })

  it("is configured from the Gemini env and rejects file media", async () => {
    expect(createGeminiLegacyProvider({ env: {} }).isConfigured()).toBe(false)
    expect(createGeminiLegacyProvider({ env }).isConfigured()).toBe(true)
    await expect(createGeminiLegacyProvider({ env: {} }).transcribe(request())).rejects.toMatchObject({ kind: "config" })
    await expect(
      createGeminiLegacyProvider({ env, transcribeSegments: async () => ({ segments }) }).transcribe(
        request({ media: { kind: "file", path: "/tmp/a.wav", contentType: "audio/wav" } })
      )
    ).rejects.toMatchObject({ kind: "config" })
  })

  it("normalizes thrown errors", async () => {
    const provider = createGeminiLegacyProvider({
      env,
      transcribeSegments: async () => {
        throw new Error("fetch failed")
      },
    })

    await expect(provider.transcribe(request())).rejects.toMatchObject({ kind: "server", retryable: true })
  })
})
