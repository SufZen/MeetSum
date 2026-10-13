import { describe, expect, it } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { createLocalWhisperChunkedProvider, parseWhisperChunk } from "@/lib/ai/asr/providers/local-whisper-chunked"
import type { AsrRequest } from "@/lib/ai/asr/types"

import { fakeExecFile, json, loadFixture, mockFetch } from "./fixtures/asr/providers/fakes"

type Fixture = { _synthetic: boolean; withWords: Record<string, unknown>; segmentsOnly: Record<string, unknown> }
const fixture = loadFixture<Fixture>("local-whisper-chunk.json")
const env = { LOCAL_TRANSCRIPTION_URL: "http://asr.test:8771/" }

// 25 minutes with a silence at 550–552 s: cuts at 551 s and (hard) 1151 s.
const SILENCES = "silence_start: 550\nsilence_end: 552 | silence_duration: 2\n"

function request(overrides: Partial<AsrRequest> = {}): AsrRequest {
  return {
    language: "he",
    media: { kind: "file", path: "/tmp/upload.mp3", contentType: "audio/mpeg" },
    glossary: DEFAULT_ASR_GLOSSARY,
    diarize: true,
    ...overrides,
  }
}

function formFields(body: unknown): Array<[string, string]> {
  return [...(body as FormData).entries()]
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => [name, value as string])
}

describe("parseWhisperChunk", () => {
  it("offsets top-level words by the chunk start", () => {
    const parsed = parseWhisperChunk(fixture.withWords, { startMs: 600_000, endMs: 604_000 })

    expect(parsed.synthetic).toBe(false)
    expect(parsed.words[0]).toEqual({ startMs: 600_200, endMs: 600_700, text: "שלום", confidence: 0.97 })
  })

  it("synthesizes words from segments when word timings are missing", () => {
    const parsed = parseWhisperChunk(fixture.segmentsOnly, { startMs: 1000, endMs: 5000 })

    expect(parsed.synthetic).toBe(true)
    expect(parsed.words.map((word) => word.text)).toEqual(["שלום", "עולם"])
    expect(parsed.words[0].startMs).toBe(2000)
    expect(parsed.words[1].endMs).toBe(4000)
  })

  it("accepts plain text responses", () => {
    expect(parseWhisperChunk("שלום עולם", { startMs: 0, endMs: 2000 }).words).toHaveLength(2)
  })
})

describe("local Whisper chunked provider", () => {
  it("uses a synthetic fixture and is configured by LOCAL_TRANSCRIPTION_URL", () => {
    expect(fixture._synthetic).toBe(true)
    expect(createLocalWhisperChunkedProvider({ env: {} }).isConfigured()).toBe(false)
    expect(createLocalWhisperChunkedProvider({ env }).isConfigured()).toBe(true)
  })

  it("splits 25 minutes into 3 silence-aligned chunks with correct offsets", async () => {
    const fake = fakeExecFile({ durationMs: 1_500_000, silenceStderr: SILENCES })
    const http = mockFetch({ "POST /v1/audio/transcriptions": () => json(fixture.withWords) })
    const provider = createLocalWhisperChunkedProvider({ env, fetch: http.fetch, execFile: fake.execFile })
    const result = await provider.transcribe(request())

    const cuts = fake.calls.filter((call) => call.args.includes("-ss")).map((call) => call.args.slice(call.args.indexOf("-ss"), call.args.indexOf("-ss") + 4))

    expect(cuts).toEqual([
      ["-ss", "0.000", "-t", "551.000"],
      ["-ss", "551.000", "-t", "600.000"],
      ["-ss", "1151.000", "-t", "349.000"],
    ])
    expect(http.requests).toHaveLength(3)
    expect(http.requests[0].url).toBe("http://asr.test:8771/v1/audio/transcriptions")

    const firstWords = result.segments.flatMap((segment) => segment.words).filter((word) => word.text === "שלום")

    expect(firstWords.map((word) => word.startMs)).toEqual([200, 551_200, 1_151_200])
    expect(result.durationMs).toBe(1_500_000)
    expect(result.diarization).toBe("none")
    expect(new Set(result.segments.map((segment) => segment.speaker))).toEqual(new Set(["Speaker 1"]))
    expect(result.speakers).toHaveLength(1)
    expect(result.warnings).toContain("diarization_unavailable")
    expect(result.cost).toEqual({ usd: 0, basis: "none" })
    expect(result.timings.chunks).toBe(3)
    // One speaker, small gaps: each chunk is one segment (gap between chunks > 1.2 s).
    expect(result.segments.map((segment) => segment.text)).toEqual(Array(3).fill("שלום עולם. נבדוק את Supabase"))
  })

  it("sends verbose_json, word timestamps, language and hotwords", async () => {
    const http = mockFetch({ "POST /v1/audio/transcriptions": () => json(fixture.withWords) })
    const fake = fakeExecFile({ durationMs: 4000 })
    const provider = createLocalWhisperChunkedProvider({ env, fetch: http.fetch, execFile: fake.execFile })

    await provider.transcribe(request())

    const fields = formFields(http.requests[0].body)

    expect(fields).toEqual(
      expect.arrayContaining([
        ["model", "ivrit-ai/whisper-large-v3-turbo-ct2"],
        ["language", "he"],
        ["response_format", "verbose_json"],
        ["timestamp_granularities[]", "word"],
        ["hotwords", expect.stringContaining("Supabase")],
      ])
    )
    expect(fields.find(([name]) => name === "prompt")).toBeUndefined()
    // Short audio: no silencedetect and no chunk cutting.
    expect(fake.calls.some((call) => call.args.some((arg) => arg.startsWith("silencedetect")))).toBe(false)
    expect(fake.calls.some((call) => call.args.includes("-ss"))).toBe(false)
  })

  it("retries a failed chunk once", async () => {
    const http = mockFetch({
      "POST /v1/audio/transcriptions": [() => json({ detail: "boom" }, 502), () => json(fixture.withWords)],
    })
    const provider = createLocalWhisperChunkedProvider({ env, fetch: http.fetch, execFile: fakeExecFile({ durationMs: 4000 }).execFile })
    const result = await provider.transcribe(request())

    expect(http.requests).toHaveLength(2)
    expect(result.timings.chunkRetries).toBe(1)
  })

  it("fails after the retry also fails", async () => {
    const http = mockFetch({ "POST /v1/audio/transcriptions": () => json({ detail: "boom" }, 503) })
    const provider = createLocalWhisperChunkedProvider({ env, fetch: http.fetch, execFile: fakeExecFile({ durationMs: 4000 }).execFile })

    await expect(provider.transcribe(request())).rejects.toMatchObject({ kind: "server", retryable: true })
    expect(http.requests).toHaveLength(2)
  })

  it("flags synthetic word timings", async () => {
    const http = mockFetch({ "POST /v1/audio/transcriptions": () => json(fixture.segmentsOnly) })
    const provider = createLocalWhisperChunkedProvider({ env, fetch: http.fetch, execFile: fakeExecFile({ durationMs: 4000 }).execFile })
    const result = await provider.transcribe(request())

    expect(result.warnings).toEqual(["diarization_unavailable", "synthetic_word_timings"])
  })

  it("throws a config error without LOCAL_TRANSCRIPTION_URL", async () => {
    await expect(createLocalWhisperChunkedProvider({ env: {} }).transcribe(request())).rejects.toMatchObject({ kind: "config" })
  })
})
