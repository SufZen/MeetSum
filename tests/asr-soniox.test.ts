import { describe, expect, it } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { createSonioxProvider, SONIOX_BAD_MEDIA, tokensToWords, type SonioxToken } from "@/lib/ai/asr/providers/soniox"
import type { AsrRequest } from "@/lib/ai/asr/types"

import { fakeExecFile, json, loadFixture, mockFetch, recordingSleep } from "./fixtures/asr/providers/fakes"

type Fixture = {
  _synthetic: boolean
  file: Record<string, unknown>
  created: Record<string, unknown>
  processing: Record<string, unknown>
  completed: Record<string, unknown>
  transcript: { tokens: SonioxToken[] }
}
const soniox = loadFixture<Fixture>("soniox.json")
const env = { SONIOX_API_KEY: "sx-test", SONIOX_API_BASE_URL: "https://soniox.test" }

function request(overrides: Partial<AsrRequest> = {}): AsrRequest {
  return {
    language: "he",
    media: { kind: "file", path: "/tmp/meeting.m4a", contentType: "audio/mp4" },
    glossary: DEFAULT_ASR_GLOSSARY,
    diarize: true,
    ...overrides,
  }
}

function routes(overrides: Parameters<typeof mockFetch>[0] = {}) {
  return {
    "POST /v1/files": () => json(soniox.file),
    "POST /v1/transcriptions": () => json(soniox.created),
    "GET /v1/transcriptions/tr_42/transcript": () => json(soniox.transcript),
    "GET /v1/transcriptions/tr_42": [() => json(soniox.processing), () => json(soniox.completed)],
    "DELETE /v1/transcriptions/tr_42": () => new Response(null, { status: 204 }),
    "DELETE /v1/files/file_abc123": () => new Response(null, { status: 204 }),
    ...overrides,
  }
}

function provider(http: ReturnType<typeof mockFetch>, extraEnv: Record<string, string> = {}) {
  return createSonioxProvider({
    env: { ...env, ...extraEnv },
    fetch: http.fetch,
    execFile: fakeExecFile({ durationMs: 9000 }).execFile,
    sleep: recordingSleep().sleep,
  })
}

describe("tokensToWords", () => {
  it("joins sub-word tokens; leading space starts a word; punctuation attaches", () => {
    const words = tokensToWords(soniox.transcript.tokens)

    expect(words.map((word) => word.text)).toEqual(["שלום,", "עוברים", "לסופבייס", "היום.", "Next.js", "works", "great"])
    expect(words[0]).toMatchObject({ startMs: 0, endMs: 440, speaker: "1", language: "he" })
    expect(words[0].confidence).toBeCloseTo((0.9 + 0.8 + 0.99) / 3, 6)
    expect(words[4]).toMatchObject({ speaker: "2", language: "en", startMs: 4000, endMs: 4600 })
  })

  it("skips special tokens and translation tokens", () => {
    expect(
      tokensToWords([
        { text: "<end>" },
        { text: "hola", start_ms: 0, end_ms: 100 },
        { text: " hello", start_ms: 0, end_ms: 100, translation_status: "translation" },
      ]).map((word) => word.text)
    ).toEqual(["hola"])
  })
})

describe("Soniox provider", () => {
  it("uses synthetic fixtures and is configured only with a key", () => {
    expect(soniox._synthetic).toBe(true)
    expect(createSonioxProvider({ env: {} }).isConfigured()).toBe(false)
    expect(createSonioxProvider({ env }).isConfigured()).toBe(true)
  })

  it("uploads, creates with hints/diarization/context, polls, fetches tokens and deletes", async () => {
    const http = mockFetch(routes())
    const result = await provider(http).transcribe(request())
    const calls = http.requests.map((item) => `${item.method} ${new URL(item.url).pathname}`)

    expect(calls).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "GET /v1/transcriptions/tr_42",
      "GET /v1/transcriptions/tr_42",
      "GET /v1/transcriptions/tr_42/transcript",
      "DELETE /v1/transcriptions/tr_42",
      "DELETE /v1/files/file_abc123",
    ])
    expect(http.requests[0].headers.authorization).toBe("Bearer sx-test")
    expect(http.requests[0].body).toBeInstanceOf(FormData)
    expect(http.requests[1].body).toMatchObject({
      model: "stt-async-v3",
      file_id: "file_abc123",
      language_hints: ["he", "en"],
      enable_speaker_diarization: true,
      enable_language_identification: true,
      context: { terms: expect.arrayContaining(["Supabase", "Claude Code"]) },
    })

    expect(result.provider).toBe("soniox")
    expect(result.segments.map((segment) => [segment.speaker, segment.text])).toEqual([
      ["Speaker 1", "שלום, עוברים ל-Supabase היום."],
      ["Speaker 2", "Next.js works great"],
    ])
    expect(result.segments[1].language).toBe("en")
    expect(result.glossaryReplacements).toBe(1)
    expect(result.cost).toEqual({ usd: 0.00025, basis: "audio_hours", billedSeconds: 9, unitPrice: 0.1 })
  })

  it("deletes the transcription and file when processing fails", async () => {
    const http = mockFetch(
      routes({
        "GET /v1/transcriptions/tr_42": () => json({ id: "tr_42", status: "error", error_message: "Internal processing error" }),
      })
    )

    await expect(provider(http).transcribe(request())).rejects.toMatchObject({ kind: "server", retryable: true })
    expect(http.requests.filter((item) => item.method === "DELETE").map((item) => new URL(item.url).pathname)).toEqual([
      "/v1/transcriptions/tr_42",
      "/v1/files/file_abc123",
    ])
  })

  it("maps an undecodable audio error to bad_input and still deletes the file", async () => {
    const http = mockFetch(
      routes({
        "GET /v1/transcriptions/tr_42": () => json({ id: "tr_42", status: "error", error_message: "Audio could not be decoded" }),
      })
    )

    await expect(provider(http).transcribe(request())).rejects.toMatchObject({ kind: "bad_input", retryable: false })
    expect(http.requests.some((item) => item.method === "DELETE" && item.url.endsWith("/v1/files/file_abc123"))).toBe(true)
  })

  it("only treats explicit decode / unsupported-format phrases as bad_input", () => {
    for (const message of [
      "Audio could not be decoded",
      "Failed to decode audio",
      "Unsupported audio format",
      "The file is corrupted",
    ]) {
      expect(SONIOX_BAD_MEDIA.test(message), message).toBe(true)
    }
    for (const message of [
      "Audio duration exceeds the maximum allowed",
      "Invalid audio_url parameter",
      "Internal error while processing audio",
      "Format of the request is invalid",
    ]) {
      expect(SONIOX_BAD_MEDIA.test(message), message).toBe(false)
    }
  })

  it("keeps vague audio errors retryable so the router can fall through", async () => {
    const http = mockFetch(
      routes({
        "GET /v1/transcriptions/tr_42": () =>
          json({ id: "tr_42", status: "error", error_message: "Audio duration exceeds the maximum allowed" }),
      })
    )

    await expect(provider(http).transcribe(request())).rejects.toMatchObject({ kind: "server", retryable: true })
  })

  it("deletes the uploaded file when creating the transcription fails", async () => {
    const http = mockFetch(routes({ "POST /v1/transcriptions": () => json({ message: "bad key" }, 401) }))

    await expect(provider(http).transcribe(request())).rejects.toMatchObject({ kind: "auth" })
    expect(http.requests.map((item) => `${item.method} ${new URL(item.url).pathname}`)).toContain("DELETE /v1/files/file_abc123")
  })

  it("hints the meeting language plus English for other languages and omits empty context", async () => {
    const http = mockFetch(routes())

    await provider(http).transcribe(request({ language: "pt-BR", glossary: { version: 1, terms: [] }, diarize: false }))
    expect(http.requests[1].body).toMatchObject({ language_hints: ["pt", "en"], enable_speaker_diarization: false })
    expect((http.requests[1].body as Record<string, unknown>).context).toBeUndefined()
  })

  it("times out after SONIOX_TIMEOUT_MS", async () => {
    let clock = 0
    const http = mockFetch(routes({ "GET /v1/transcriptions/tr_42": () => json(soniox.processing) }))
    const slow = createSonioxProvider({
      env: { ...env, SONIOX_TIMEOUT_MS: "5000" },
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 9000 }).execFile,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })

    await expect(slow.transcribe(request())).rejects.toMatchObject({ kind: "timeout", retryable: true })
    expect(http.requests.filter((item) => item.method === "DELETE")).toHaveLength(2)
  })
})
