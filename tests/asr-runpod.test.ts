import { describe, expect, it, vi } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { isMediaSpecific } from "@/lib/ai/asr/errors"
import { createRunpodIvritProvider, normalizeRunpodOutput } from "@/lib/ai/asr/providers/runpod-ivrit"
import { AsrError, type AsrRequest } from "@/lib/ai/asr/types"

import { fakeExecFile, json, loadFixture, mockFetch, recordingSleep } from "./fixtures/asr/providers/fakes"

type Status = Record<string, unknown>
const ivrit = loadFixture<{ _synthetic: boolean; run: Status; inProgress: Status; completed: Status }>("runpod-ivrit.json")
const meetsum = loadFixture<{ _synthetic: boolean; completed: Status }>("runpod-meetsum.json")

const env = {
  RUNPOD_API_KEY: "rp-test-key",
  RUNPOD_ASR_ENDPOINT_ID: "ep123",
  RUNPOD_API_BASE_URL: "https://runpod.test/v2",
}

function request(overrides: Partial<AsrRequest> = {}): AsrRequest {
  return {
    meetingId: "meet_1",
    workspaceId: "ws_1",
    language: "he",
    media: { kind: "object", storageKey: "meetings/meet_1/a.mp4", contentType: "video/mp4", filename: "a.mp4" },
    glossary: DEFAULT_ASR_GLOSSARY,
    diarize: true,
    ...overrides,
  }
}

function setup(options: { env?: Record<string, string>; routes?: Parameters<typeof mockFetch>[0]; durationMs?: number } = {}) {
  const fake = fakeExecFile({ durationMs: options.durationMs ?? 8400 })
  const sleeper = recordingSleep()
  const http = mockFetch(
    options.routes ?? {
      "POST /ep123/run": () => json(ivrit.run),
      "GET /ep123/status/job-ivrit-1": [() => json(ivrit.inProgress), () => json(ivrit.inProgress), () => json(ivrit.completed)],
    }
  )
  const download = vi.fn(async () => undefined)
  const provider = createRunpodIvritProvider({
    env: { ...env, ...options.env },
    fetch: http.fetch,
    execFile: fake.execFile,
    download,
    sleep: sleeper.sleep,
  })

  return { provider, http, sleeper, fake, download }
}

describe("RunPod ivrit provider", () => {
  it("uses synthetic fixtures", () => {
    expect(ivrit._synthetic).toBe(true)
    expect(meetsum._synthetic).toBe(true)
  })

  it("is configured only with key + endpoint", () => {
    expect(createRunpodIvritProvider({ env: {} }).isConfigured()).toBe(false)
    expect(createRunpodIvritProvider({ env: { RUNPOD_API_KEY: "x" } }).isConfigured()).toBe(false)
    expect(createRunpodIvritProvider({ env }).isConfigured()).toBe(true)
  })

  it("throws a config error when not configured, without any network call", async () => {
    const http = mockFetch({})

    await expect(createRunpodIvritProvider({ env: {}, fetch: http.fetch }).transcribe(request())).rejects.toMatchObject({
      kind: "config",
      retryable: false,
    })
    expect(http.requests).toHaveLength(0)
  })

  it("runs the full lifecycle: transcode, blob handoff, run, poll with backoff, normalize", async () => {
    const { provider, http, sleeper, fake } = setup()
    const result = await provider.transcribe(request())

    const run = http.requests[0]

    expect(run.url).toBe("https://runpod.test/v2/ep123/run")
    expect(run.headers.authorization).toBe("Bearer rp-test-key")
    expect(run.body).toMatchObject({
      input: {
        type: "blob",
        model: "ivrit-ai/whisper-large-v3-turbo-ct2",
        engine: "stable-whisper",
        streaming: false,
        transcribe_args: { language: "he", diarize: true, word_timestamps: true },
      },
    })
    const input = (run.body as { input: { data: string; transcribe_args: { hotwords: string } } }).input

    expect(Buffer.from(input.data, "base64").toString()).toBe("OggS-fake-audio")
    expect(input.transcribe_args.hotwords.startsWith("Supabase, Gemini")).toBe(true)
    expect(http.requests.filter((item) => item.url.includes("/status/"))).toHaveLength(3)
    expect(sleeper.delays).toEqual([2000, 3000, 4500])
    expect(fake.calls.map((call) => call.file)).toEqual(["ffmpeg", "ffprobe"])

    expect(result.provider).toBe("runpod-ivrit")
    expect(result.diarization).toBe("provider")
    expect(result.segments.map((segment) => [segment.speaker, segment.turnIndex, segment.text])).toEqual([
      ["Speaker 1", 0, "שלום לכולם, אני דנה."],
      ["Speaker 2", 1, "אנחנו עוברים ב-Supabase עם Claude Code"],
      ["Speaker 1", 2, "מעולה, דוגמה טובה."],
    ])
    expect(result.segments[1].words.find((word) => word.text === "Claude Code")).toMatchObject({
      startMs: 5000,
      endMs: 6200,
      confidence: 0.77,
      language: "en",
    })
    expect(result.glossaryReplacements).toBe(2)
    expect(result.speakers.map((speaker) => [speaker.label, speaker.segmentCount])).toEqual([
      ["Speaker 1", 2],
      ["Speaker 2", 1],
    ])
    expect(result.cost).toEqual({ usd: 0.00798, basis: "gpu_seconds", billedSeconds: 42, unitPrice: 0.00019 })
    expect(result.timings).toMatchObject({ queueMs: 2400, executionMs: 42000 })
    expect(result.durationMs).toBe(8400)
  })

  it("speaks meetsum-asr/v1 to our own worker and keeps voice embeddings", async () => {
    const { provider, http } = setup({
      env: { RUNPOD_ASR_WORKER: "meetsum" },
      routes: {
        "POST /ep123/run": () => json({ id: "job-meetsum-1", status: "IN_QUEUE" }),
        "GET /ep123/status/job-meetsum-1": () => json(meetsum.completed),
      },
    })
    const result = await provider.transcribe(request({ speakers: { min: 2, max: 4 } }))

    expect(http.requests[0].body).toMatchObject({
      input: {
        schema: "meetsum-asr/v1",
        audio: { type: "blob" },
        language: "he",
        diarize: true,
        min_speakers: 2,
        max_speakers: 4,
        word_timestamps: true,
      },
    })
    expect(result.segments.map((segment) => segment.text)).toEqual(["בוקר טוב לכולם.", "היי, מה המצב?"])
    expect(result.speakers).toEqual([
      expect.objectContaining({ label: "Speaker 1", embedding: [0.1, 0.2, 0.3], embeddingModel: "pyannote/speaker-diarization-community-1" }),
      expect.objectContaining({ label: "Speaker 2", embedding: [0.3, 0.2, 0.1] }),
    ])
    expect(result.durationMs).toBe(12_500)
    expect(result.cost.usd).toBeCloseTo(0.0057, 6)
  })

  it("uses the multilingual model with auto language for non-Hebrew meetings", async () => {
    const { provider, http } = setup({
      routes: { "POST /ep123/run": () => json({ ...ivrit.completed }) },
    })

    await provider.transcribe(request({ language: "en" }))
    const input = (http.requests[0].body as { input: { model: string; transcribe_args: Record<string, unknown> } }).input

    expect(input.model).toBe("large-v3-turbo")
    expect(input.transcribe_args.language).toBeUndefined()
  })

  it("hands off through a presigned URL and always deletes the handoff object", async () => {
    const remove = vi.fn(async () => undefined)
    const http = mockFetch({
      "POST /ep123/run": () => json(ivrit.run),
      "GET /ep123/status/job-ivrit-1": () => json({ id: "job-ivrit-1", status: "FAILED", error: "[bad_media] Failed to decode audio with ffmpeg", output: { error_kind: "bad_media" } }),
    })
    const provider = createRunpodIvritProvider({
      env: { ...env, S3_PUBLIC_ENDPOINT: "https://media.example.com" },
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 1000 }).execFile,
      download: async () => undefined,
      sleep: recordingSleep().sleep,
      handoff: {
        put: async () => ({ bucket: "b", key: "k", contentType: "audio/ogg", sizeBytes: 1 }),
        presign: async (key) => `https://media.example.com/meeting-media/${key}?X-Amz-Signature=abc`,
        remove,
        uuid: () => "h1",
      },
    })

    const error = await provider.transcribe(request()).catch((caught: unknown) => caught)

    expect((http.requests[0].body as { input: Record<string, unknown> }).input).toMatchObject({
      type: "url",
      url: "https://media.example.com/meeting-media/asr-handoff/h1.ogg?X-Amz-Signature=abc",
    })
    expect(error).toBeInstanceOf(AsrError)
    expect(error).toMatchObject({ kind: "bad_input", retryable: false })
    expect(remove).toHaveBeenCalledWith("asr-handoff/h1.ogg")
  })

  it("cancels the job on timeout", async () => {
    let clock = 0
    const http = mockFetch({
      "POST /ep123/run": () => json(ivrit.run),
      "GET /ep123/status/job-ivrit-1": () => json(ivrit.inProgress),
      "POST /ep123/cancel/job-ivrit-1": () => json({ id: "job-ivrit-1", status: "CANCELLED" }),
    })
    const provider = createRunpodIvritProvider({
      env: { ...env, RUNPOD_ASR_TIMEOUT_MS: "10000" },
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 1000 }).execFile,
      download: async () => undefined,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })

    await expect(provider.transcribe(request())).rejects.toMatchObject({ kind: "timeout", retryable: true })
    expect(http.requests.at(-1)).toMatchObject({ method: "POST", url: "https://runpod.test/v2/ep123/cancel/job-ivrit-1" })
  })

  it("cancels the job when the request is aborted", async () => {
    const controller = new AbortController()
    const http = mockFetch({
      "POST /ep123/run": () => json(ivrit.run),
      "GET /ep123/status/job-ivrit-1": () => {
        controller.abort()
        return json(ivrit.inProgress)
      },
      "POST /ep123/cancel/job-ivrit-1": () => json({}),
    })
    const provider = createRunpodIvritProvider({
      env,
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 1000 }).execFile,
      download: async () => undefined,
      sleep: recordingSleep().sleep,
    })

    await expect(provider.transcribe(request({ signal: controller.signal }))).rejects.toMatchObject({ retryable: false })
    expect(http.requests.some((item) => item.url.endsWith("/cancel/job-ivrit-1"))).toBe(true)
  })

  it("maps HTTP errors: 401 auth, 429 rate limit, 5xx retryable server", async () => {
    for (const [status, kind, retryable] of [
      [401, "auth", false],
      [429, "rate_limit", true],
      [503, "server", true],
    ] as const) {
      const { provider } = setup({ routes: { "POST /ep123/run": () => json({ error: "nope" }, status) } })

      await expect(provider.transcribe(request())).rejects.toMatchObject({ kind, retryable, httpStatus: status })
    }
  })

  it("maps HTTP 413 to a media-specific provider limit, not chain-stopping bad_input", async () => {
    const { provider } = setup({ routes: { "POST /ep123/run": () => json({ error: "payload too large" }, 413) } })
    const error = await provider.transcribe(request()).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ kind: "config", retryable: false, httpStatus: 413 })
    expect(isMediaSpecific(error as Error)).toBe(true)
  })

  it("keeps free-text decode errors retryable; only the bad_media marker is bad_input", async () => {
    for (const [failure, kind, retryable] of [
      [{ error: "Failed to load audio: ffmpeg decode error" }, "server", true],
      [{ error: "Invalid input (could not read request): bad" }, "server", true],
      [{ error: "decode failed", output: { error_kind: "bad_media" } }, "bad_input", false],
      [{ error: "[bad_media] Failed to decode audio with ffmpeg" }, "bad_input", false],
    ] as const) {
      const { provider } = setup({
        routes: {
          "POST /ep123/run": () => json(ivrit.run),
          "GET /ep123/status/job-ivrit-1": () => json({ id: "job-ivrit-1", status: "FAILED", ...failure }),
        },
      })

      await expect(provider.transcribe(request()), failure.error).rejects.toMatchObject({ kind, retryable })
    }
  })

  it("maps network failures to a retryable server error", async () => {
    const { provider } = setup({
      routes: {
        "POST /ep123/run": () => {
          throw new TypeError("fetch failed")
        },
      },
    })

    await expect(provider.transcribe(request())).rejects.toMatchObject({ kind: "server", retryable: true })
  })

  it("reports health from /health", async () => {
    const http = mockFetch({ "GET /ep123/health": () => json({ workers: { idle: 1, running: 0 }, jobs: { inQueue: 0 } }) })
    const health = await createRunpodIvritProvider({ env, fetch: http.fetch }).healthCheck()

    expect(health).toMatchObject({ provider: "runpod-ivrit", configured: true, healthy: true })
    expect(http.requests[0].headers.authorization).toBe("Bearer rp-test-key")
    await expect(createRunpodIvritProvider({ env: {} }).healthCheck()).resolves.toMatchObject({ configured: false, healthy: null })
  })
})

describe("normalizeRunpodOutput", () => {
  it("accepts {segments}, {result}, bare arrays and synthesizes missing words", () => {
    const segment = { start: 1, end: 2, text: " שלום עולם", speaker: "SPEAKER_00" }

    expect(normalizeRunpodOutput({ segments: [segment] }).words.map((word) => word.text)).toEqual(["שלום", "עולם"])
    expect(normalizeRunpodOutput({ result: [segment] }).syntheticWords).toBe(true)
    expect(normalizeRunpodOutput([[segment], [{ ...segment, start: 3, end: 4 }]]).words).toHaveLength(4)
    expect(normalizeRunpodOutput([segment]).words[0]).toMatchObject({ speaker: "SPEAKER_00", startMs: 1000 })
  })

  it("reports no diarization when segments carry no speakers", () => {
    const output = normalizeRunpodOutput({
      segments: [{ start: 0, end: 1, text: "hi", words: [{ word: " hi", start: 0, end: 1, probability: 0.9 }] }],
    })

    expect(output.diarized).toBe(false)
    expect(output.words[0]).toEqual({ startMs: 0, endMs: 1000, text: "hi", confidence: 0.9 })
  })
})
