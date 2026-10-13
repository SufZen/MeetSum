import { describe, expect, it, vi } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { DEFAULT_ASR_CHAIN, resolveAsrChain } from "@/lib/ai/asr/config"
import { createModalWorkerProvider, getModalWorkerConfig } from "@/lib/ai/asr/providers/modal-worker"
import { getAsrChainConfig, getEffectiveAsrChain } from "@/lib/ai/asr/router"
import { AsrError, type AsrRequest } from "@/lib/ai/asr/types"

import { fakeExecFile, json, loadFixture, mockFetch, recordingSleep } from "./fixtures/asr/providers/fakes"

type Status = Record<string, unknown>
const fixture = loadFixture<{ _synthetic: boolean; submitted: Status; inProgress: Status; completed: Status }>(
  "modal-worker.json"
)

const TOKEN = "modal-secret-token-123"
const env = { MODAL_ASR_URL: "https://acme--meetsum-asr-web.modal.run/", MODAL_ASR_TOKEN: TOKEN }
const JOB = "fc-01MODALTEST"

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

function setup(options: { env?: Record<string, string>; routes?: Parameters<typeof mockFetch>[0] } = {}) {
  const sleeper = recordingSleep()
  const http = mockFetch(
    options.routes ?? {
      "POST /v1/jobs": () => json(fixture.submitted),
      [`GET /v1/jobs/${JOB}`]: [() => json(fixture.inProgress), () => json(fixture.completed)],
    }
  )
  const provider = createModalWorkerProvider({
    env: { ...env, ...options.env },
    fetch: http.fetch,
    execFile: fakeExecFile({ durationMs: 12_500 }).execFile,
    download: vi.fn(async () => undefined),
    sleep: sleeper.sleep,
  })

  return { provider, http, sleeper }
}

describe("Modal worker provider", () => {
  it("uses a synthetic fixture and is configured only with URL + token", () => {
    expect(fixture._synthetic).toBe(true)
    expect(createModalWorkerProvider({ env: {} }).isConfigured()).toBe(false)
    expect(createModalWorkerProvider({ env: { MODAL_ASR_URL: env.MODAL_ASR_URL } }).isConfigured()).toBe(false)
    expect(createModalWorkerProvider({ env }).isConfigured()).toBe(true)
    expect(createModalWorkerProvider({ env }).id).toBe("modal-worker")
  })

  it("defaults the price to Modal's T4 rate and honours MODAL_PRICE_PER_SECOND", () => {
    expect(getModalWorkerConfig(env).pricePerSecond).toBe(0.000164)
    expect(getModalWorkerConfig({ ...env, MODAL_PRICE_PER_SECOND: "0.000222" }).pricePerSecond).toBe(0.000222)
  })

  it("throws a config error when not configured, without any network call", async () => {
    const http = mockFetch({})

    await expect(createModalWorkerProvider({ env: {}, fetch: http.fetch }).transcribe(request())).rejects.toMatchObject({
      kind: "config",
      retryable: false,
    })
    expect(http.requests).toHaveLength(0)
  })

  it("runs the lifecycle: blob handoff, submit meetsum-asr/v1, poll, normalize, GPU-seconds cost", async () => {
    const { provider, http, sleeper } = setup()
    const result = await provider.transcribe(request({ speakers: { min: 2, max: 4 } }))

    expect(http.requests[0]).toMatchObject({
      method: "POST",
      url: "https://acme--meetsum-asr-web.modal.run/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {
        input: {
          schema: "meetsum-asr/v1",
          audio: { type: "blob" },
          model: "ivrit-ai/whisper-large-v3-turbo-ct2",
          language: "he",
          diarize: true,
          min_speakers: 2,
          max_speakers: 4,
          word_timestamps: true,
        },
      },
    })
    expect(http.requests.slice(1).every((item) => item.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(sleeper.delays).toEqual([3000, 4500])
    expect(result.provider).toBe("modal-worker")
    expect(result.diarization).toBe("provider")
    expect(result.segments.map((segment) => segment.text)).toEqual(["בוקר טוב לכולם.", "היי, מה המצב?"])
    expect(result.speakers).toEqual([
      expect.objectContaining({ label: "Speaker 1", embedding: [0.1, 0.2, 0.3] }),
      expect.objectContaining({ label: "Speaker 2", embedding: [0.3, 0.2, 0.1] }),
    ])
    expect(result.cost).toEqual({ usd: 0.00656, basis: "gpu_seconds", billedSeconds: 40, unitPrice: 0.000164 })
    expect(result.durationMs).toBe(12_500)
  })

  it("uses the multilingual model and the meeting language for non-Hebrew meetings", async () => {
    const { provider, http } = setup({
      routes: { "POST /v1/jobs": () => json({ ...fixture.completed, output: { ...(fixture.completed.output as object), language: "en" } }) },
    })
    const result = await provider.transcribe(request({ language: "en" }))

    expect(http.requests[0].body).toMatchObject({ input: { model: "large-v3-turbo", language: "en" } })
    expect(result.language).toBe("en")
  })

  it("hands off via presigned URL and always deletes the handoff object", async () => {
    const remove = vi.fn(async () => undefined)
    const http = mockFetch({
      "POST /v1/jobs": () => json(fixture.submitted),
      [`GET /v1/jobs/${JOB}`]: () =>
        json({ id: JOB, status: "FAILED", error: "[bad_media] Failed to decode audio", error_kind: "bad_media" }),
    })
    const provider = createModalWorkerProvider({
      env: { ...env, S3_PUBLIC_ENDPOINT: "https://media.example.com" },
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 1000 }).execFile,
      download: async () => undefined,
      sleep: recordingSleep().sleep,
      handoff: {
        put: async () => ({ bucket: "b", key: "k", contentType: "audio/ogg", sizeBytes: 1 }),
        presign: async (key) => `https://media.example.com/meeting-media/${key}?X-Amz-Signature=abc`,
        remove,
        uuid: () => "m1",
      },
    })

    const error = await provider.transcribe(request()).catch((caught: unknown) => caught)

    expect((http.requests[0].body as { input: { audio: unknown } }).input.audio).toEqual({
      type: "url",
      url: "https://media.example.com/meeting-media/asr-handoff/m1.ogg?X-Amz-Signature=abc",
    })
    expect(error).toBeInstanceOf(AsrError)
    expect(error).toMatchObject({ kind: "bad_input", retryable: false, provider: "modal-worker" })
    expect(remove).toHaveBeenCalledWith("asr-handoff/m1.ogg")
  })

  it("deletes the handoff object on success too", async () => {
    const remove = vi.fn(async () => undefined)
    const http = mockFetch({ "POST /v1/jobs": () => json(fixture.completed) })
    const provider = createModalWorkerProvider({
      env: { ...env, MEETSUM_ASR_MEDIA_HANDOFF: "presigned", S3_PUBLIC_ENDPOINT: "https://media.example.com" },
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 1000 }).execFile,
      download: async () => undefined,
      handoff: {
        put: async () => ({ bucket: "b", key: "k", contentType: "audio/ogg", sizeBytes: 1 }),
        presign: async (key) => `https://media.example.com/${key}`,
        remove,
        uuid: () => "m2",
      },
    })

    await provider.transcribe(request())
    expect(remove).toHaveBeenCalledWith("asr-handoff/m2.ogg")
  })

  it("maps job failures: bad_media marker → bad_input, other errors retryable server", async () => {
    for (const [failure, kind, retryable] of [
      [{ error: "Worker error: RuntimeError: CUDA out of memory" }, "server", true],
      [{ error: "decode failed", error_kind: "bad_media" }, "bad_input", false],
      [{ error: "[bad_media] Failed to decode audio with ffmpeg" }, "bad_input", false],
      [{ error: "Invalid input (could not read request): bad" }, "config", false],
    ] as const) {
      const { provider } = setup({
        routes: {
          "POST /v1/jobs": () => json(fixture.submitted),
          [`GET /v1/jobs/${JOB}`]: () => json({ id: JOB, status: "FAILED", ...failure }),
        },
      })

      await expect(provider.transcribe(request()), failure.error).rejects.toMatchObject({ kind, retryable })
    }
  })

  it("maps HTTP errors (401 auth, 429/503 retryable after submit retries) and never leaks the token", async () => {
    for (const [status, kind, retryable, calls] of [
      [401, "auth", false, 1],
      [429, "rate_limit", true, 3],
      [503, "server", true, 3],
    ] as const) {
      const { provider, http } = setup({
        routes: { "POST /v1/jobs": () => json({ detail: `rejected Bearer ${TOKEN}` }, status) },
      })
      const error = (await provider.transcribe(request()).catch((caught: unknown) => caught)) as AsrError

      expect(error).toMatchObject({ kind, retryable, httpStatus: status })
      expect(error.message).not.toContain(TOKEN)
      expect(http.requests).toHaveLength(calls)
    }
  })

  it("retries a transient submit failure and then succeeds", async () => {
    const { provider, http, sleeper } = setup({
      routes: {
        "POST /v1/jobs": [
          () => {
            throw new TypeError("fetch failed")
          },
          () => json(fixture.completed),
        ],
      },
    })
    const result = await provider.transcribe(request())

    expect(result.segments).toHaveLength(2)
    expect(http.requests.filter((item) => item.method === "POST")).toHaveLength(2)
    expect(sleeper.delays[0]).toBe(1000)
  })

  it("cancels the job on timeout", async () => {
    let clock = 0
    const http = mockFetch({
      "POST /v1/jobs/": () => json({}),
      "POST /v1/jobs": () => json(fixture.submitted),
      [`GET /v1/jobs/${JOB}`]: () => json(fixture.inProgress),
    })
    const provider = createModalWorkerProvider({
      env: { ...env, MODAL_ASR_TIMEOUT_MS: "10000" },
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 1000 }).execFile,
      download: async () => undefined,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })

    await expect(provider.transcribe(request())).rejects.toMatchObject({ kind: "timeout", retryable: true })
    expect(http.requests.at(-1)).toMatchObject({
      method: "POST",
      url: `https://acme--meetsum-asr-web.modal.run/v1/jobs/${JOB}/cancel`,
    })
  })

  it("cancels the job when the request is aborted", async () => {
    const controller = new AbortController()
    const http = mockFetch({
      "POST /v1/jobs/": () => json({}),
      "POST /v1/jobs": () => json(fixture.submitted),
      [`GET /v1/jobs/${JOB}`]: () => {
        controller.abort()
        return json(fixture.inProgress)
      },
    })
    const provider = createModalWorkerProvider({
      env,
      fetch: http.fetch,
      execFile: fakeExecFile({ durationMs: 1000 }).execFile,
      download: async () => undefined,
      sleep: recordingSleep().sleep,
    })

    await expect(provider.transcribe(request({ signal: controller.signal }))).rejects.toMatchObject({ retryable: false })
    expect(http.requests.some((item) => item.url.endsWith(`/v1/jobs/${JOB}/cancel`))).toBe(true)
  })

  it("reports health from /health with the bearer token", async () => {
    const http = mockFetch({ "GET /health": () => json({ ok: true, gpu: "T4", model: "ivrit-ai/whisper-large-v3-turbo-ct2" }) })
    const health = await createModalWorkerProvider({ env, fetch: http.fetch }).healthCheck()

    expect(health).toMatchObject({ provider: "modal-worker", configured: true, healthy: true, detail: { gpu: "T4" } })
    expect(http.requests[0]).toMatchObject({
      url: "https://acme--meetsum-asr-web.modal.run/health",
      headers: { authorization: `Bearer ${TOKEN}` },
    })

    const down = mockFetch({ "GET /health": () => json({ detail: "unauthorized" }, 401) })

    await expect(createModalWorkerProvider({ env, fetch: down.fetch }).healthCheck()).resolves.toMatchObject({
      healthy: false,
      lastError: "HTTP 401",
    })
    await expect(createModalWorkerProvider({ env: {} }).healthCheck()).resolves.toMatchObject({
      configured: false,
      healthy: null,
    })
  })
})

describe("router chain with modal-worker", () => {
  it("puts modal-worker after RunPod in the default Hebrew chain", () => {
    expect(DEFAULT_ASR_CHAIN).toEqual(["runpod-ivrit", "modal-worker", "soniox", "local-whisper-chunked"])
    expect(resolveAsrChain("he", {})).toEqual(["runpod-ivrit", "modal-worker", "soniox", "local-whisper-chunked"])
    expect(resolveAsrChain("he", { MEETSUM_ASR_CHAIN: "modal-worker,soniox" })).toEqual(["modal-worker", "soniox"])
  })

  it("includes modal-worker only when configured", () => {
    const configured = {
      ...env,
      RUNPOD_API_KEY: "rp",
      RUNPOD_ASR_ENDPOINT_ID: "ep",
      LOCAL_TRANSCRIPTION_URL: "http://asr.test",
    }

    expect(getEffectiveAsrChain("he", { env: configured })).toEqual(["runpod-ivrit", "modal-worker", "local-whisper-chunked"])
    expect(getEffectiveAsrChain("en", { env: configured })).toEqual(["runpod-ivrit", "modal-worker", "local-whisper-chunked"])
    expect(getEffectiveAsrChain("he", { env: { LOCAL_TRANSCRIPTION_URL: "http://asr.test" } })).toEqual([
      "local-whisper-chunked",
    ])
    expect(getAsrChainConfig(env).providers).toContainEqual({
      id: "modal-worker",
      model: "ivrit-ai/whisper-large-v3-turbo-ct2",
      configured: true,
    })
  })
})
