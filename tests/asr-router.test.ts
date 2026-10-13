import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import {
  BREAKER_KEY_PREFIX,
  createCircuitBreaker,
  MemoryBreakerStore,
  RedisBreakerStore,
  type BreakerRedisClient,
} from "@/lib/ai/asr/breaker"
import { resolveAsrChain } from "@/lib/ai/asr/config"
import { TranscriptionUnavailableError } from "@/lib/ai/asr/errors"
import { getAsrChainConfig, getAsrRouterStatus, transcribeWithRouter } from "@/lib/ai/asr/router"
import {
  AsrChainError,
  AsrError,
  type AsrProvider,
  type AsrProviderId,
  type AsrRequest,
  type AsrResult,
} from "@/lib/ai/asr/types"
import { TranscriptionUnavailableError as LegacyUnavailableError } from "@/lib/ai/providers"

function request(overrides: Partial<AsrRequest> = {}): AsrRequest {
  return {
    language: "he",
    media: { kind: "object", storageKey: "k", contentType: "audio/ogg" },
    glossary: DEFAULT_ASR_GLOSSARY,
    diarize: true,
    ...overrides,
  }
}

function result(provider: AsrProviderId): AsrResult {
  return {
    provider,
    model: `${provider}-model`,
    language: "he",
    durationMs: 1000,
    segments: [
      {
        startMs: 0,
        endMs: 1000,
        text: "שלום",
        speaker: "Speaker 1",
        turnIndex: 0,
        words: [{ startMs: 0, endMs: 1000, text: "שלום" }],
      },
    ],
    speakers: [{ label: "Speaker 1", talkTimeMs: 1000, wordCount: 1, segmentCount: 1, firstStartMs: 0 }],
    diarization: "provider",
    cost: { usd: 0.01, basis: "gpu_seconds" },
    timings: {},
    glossaryReplacements: 0,
    warnings: [],
  }
}

type Behavior = AsrResult | AsrError | Error

function fakeProvider(id: AsrProviderId, behaviors: Behavior[], configured = true) {
  const queue = [...behaviors]
  const transcribe = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]

    if (next instanceof Error) throw next
    return next
  })
  const provider: AsrProvider = {
    id,
    model: `${id}-model`,
    isConfigured: () => configured,
    healthCheck: vi.fn(async () => ({ provider: id, configured, healthy: true })),
    transcribe,
  }

  return { provider, transcribe }
}

const serverError = (id: string) => new AsrError("HTTP 503", "server", id, true, 503)

let breaker: ReturnType<typeof createCircuitBreaker>

beforeEach(() => {
  breaker = createCircuitBreaker({ store: new MemoryBreakerStore(), threshold: 3, cooldownMs: 600_000 })
})

describe("resolveAsrChain", () => {
  it("defaults: Hebrew-first chain and Soniox-first for other languages", () => {
    expect(resolveAsrChain("he", {})).toEqual(["runpod-ivrit", "soniox", "local-whisper-chunked"])
    expect(resolveAsrChain("mixed", {})).toEqual(["runpod-ivrit", "soniox", "local-whisper-chunked"])
    expect(resolveAsrChain("iw", {})).toEqual(["runpod-ivrit", "soniox", "local-whisper-chunked"])
    expect(resolveAsrChain("en", {})).toEqual(["soniox", "runpod-ivrit", "local-whisper-chunked"])
  })

  it("honors explicit chains and only keeps Gemini when allowed", () => {
    expect(resolveAsrChain("he", { MEETSUM_ASR_CHAIN: "soniox, bogus, gemini-legacy, soniox" })).toEqual(["soniox"])
    expect(
      resolveAsrChain("he", { MEETSUM_ASR_CHAIN: "soniox,gemini-legacy", MEETSUM_ASR_ALLOW_GEMINI: "true" })
    ).toEqual(["soniox", "gemini-legacy"])
    expect(resolveAsrChain("pt", { MEETSUM_ASR_CHAIN_NON_HE: "local-whisper-chunked" })).toEqual(["local-whisper-chunked"])
    expect(resolveAsrChain("he", { MEETSUM_ASR_ALLOW_GEMINI: "true" }).at(-1)).toBe("gemini-legacy")
  })

  it("maps the deprecated MEETSUM_TRANSCRIPTION_PROVIDER", () => {
    expect(resolveAsrChain("he", { MEETSUM_TRANSCRIPTION_PROVIDER: "local-whisper" })).toEqual(["local-whisper-chunked"])
    expect(resolveAsrChain("he", { MEETSUM_TRANSCRIPTION_PROVIDER: "gemini" })).toEqual([
      "runpod-ivrit",
      "soniox",
      "local-whisper-chunked",
      "gemini-legacy",
    ])
    expect(resolveAsrChain("he", { MEETSUM_TRANSCRIPTION_PROVIDER: "auto" })).toEqual([
      "runpod-ivrit",
      "soniox",
      "local-whisper-chunked",
    ])
  })
})

describe("transcribeWithRouter", () => {
  it("returns the first provider's result without fallback", async () => {
    const runpod = fakeProvider("runpod-ivrit", [result("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.provider).toBe("runpod-ivrit")
    expect(routed.fallbackUsed).toBe(false)
    expect(routed.attempts).toEqual([expect.objectContaining({ provider: "runpod-ivrit", ok: true, cost: result("runpod-ivrit").cost })])
    expect(soniox.transcribe).not.toHaveBeenCalled()
  })

  it("falls back from a RunPod 5xx to Soniox and records both attempts", async () => {
    const runpod = fakeProvider("runpod-ivrit", [serverError("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.provider).toBe("soniox")
    expect(routed.fallbackUsed).toBe(true)
    expect(routed.attempts).toEqual([
      expect.objectContaining({ provider: "runpod-ivrit", ok: false, kind: "server", error: "HTTP 503" }),
      expect.objectContaining({ provider: "soniox", ok: true }),
    ])
  })

  it("opens the breaker after 3 consecutive retryable failures and then skips the provider", async () => {
    const runpod = fakeProvider("runpod-ivrit", [serverError("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const options = { env: {}, providers: [runpod.provider, soniox.provider], breaker }

    for (let index = 0; index < 3; index += 1) await transcribeWithRouter(request(), options)
    expect(runpod.transcribe).toHaveBeenCalledTimes(3)
    expect((await breaker.status("runpod-ivrit")).open).toBe(true)

    const routed = await transcribeWithRouter(request(), options)

    expect(runpod.transcribe).toHaveBeenCalledTimes(3)
    expect(routed.provider).toBe("soniox")
    expect(routed.fallbackUsed).toBe(true)
    expect(routed.attempts).toHaveLength(1)
    expect(routed.warnings).toContain("breaker_open:runpod-ivrit")
  })

  it("a success resets the failure count", async () => {
    const runpod = fakeProvider("runpod-ivrit", [
      serverError("runpod-ivrit"),
      serverError("runpod-ivrit"),
      result("runpod-ivrit"),
      serverError("runpod-ivrit"),
    ])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const options = { env: {}, providers: [runpod.provider, soniox.provider], breaker }

    for (let index = 0; index < 4; index += 1) await transcribeWithRouter(request(), options)
    expect((await breaker.status("runpod-ivrit")).open).toBe(false)
  })

  it("opens the breaker immediately on auth errors", async () => {
    const runpod = fakeProvider("runpod-ivrit", [new AsrError("HTTP 401", "auth", "runpod-ivrit", false, 401)])
    const soniox = fakeProvider("soniox", [result("soniox")])

    await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })
    const state = await breaker.status("runpod-ivrit")

    expect(state.open).toBe(true)
    expect(state.lastError).toBe("HTTP 401")
  })

  it("stops the chain on bad_input with a non-retryable chain error", async () => {
    const runpod = fakeProvider("runpod-ivrit", [new AsrError("cannot decode", "bad_input", "runpod-ivrit", false)])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const error = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(AsrChainError)
    expect(error).toMatchObject({ retryable: false, attempts: [expect.objectContaining({ kind: "bad_input" })] })
    expect(soniox.transcribe).not.toHaveBeenCalled()
    expect((await breaker.status("runpod-ivrit")).failures).toBe(0)
  })

  it("throws a retryable chain error when all providers fail and one was retryable", async () => {
    const runpod = fakeProvider("runpod-ivrit", [serverError("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [new AsrError("HTTP 401", "auth", "soniox", false, 401)])
    const error = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(AsrChainError)
    expect(error).toMatchObject({ retryable: true })
    expect((error as AsrChainError).attempts.map((attempt) => attempt.provider)).toEqual(["runpod-ivrit", "soniox"])
  })

  it("throws a non-retryable chain error when every failure is permanent", async () => {
    const soniox = fakeProvider("soniox", [new AsrError("HTTP 401", "auth", "soniox", false, 401)])

    await expect(transcribeWithRouter(request(), { env: {}, providers: [soniox.provider], breaker })).rejects.toMatchObject({
      name: "AsrChainError",
      retryable: false,
    })
  })

  it("treats unknown thrown errors as retryable failures", async () => {
    const runpod = fakeProvider("runpod-ivrit", [new Error("socket hang up")])

    await expect(transcribeWithRouter(request(), { env: {}, providers: [runpod.provider], breaker })).rejects.toMatchObject({
      retryable: true,
      attempts: [expect.objectContaining({ kind: "server" })],
    })
  })

  it("returns an empty result on no_speech", async () => {
    const runpod = fakeProvider("runpod-ivrit", [new AsrError("silence", "no_speech", "runpod-ivrit", false)])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.segments).toEqual([])
    expect(routed.warnings).toContain("no_speech")
    expect(soniox.transcribe).not.toHaveBeenCalled()
  })

  it("falls through an empty transcript of real-length audio to the next provider", async () => {
    const empty: AsrResult = { ...result("runpod-ivrit"), durationMs: 60_000, segments: [], speakers: [] }
    const runpod = fakeProvider("runpod-ivrit", [empty])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.provider).toBe("soniox")
    expect(routed.fallbackUsed).toBe(true)
    expect(routed.attempts).toEqual([
      expect.objectContaining({ provider: "runpod-ivrit", ok: false, kind: "no_speech" }),
      expect.objectContaining({ provider: "soniox", ok: true }),
    ])
    expect((await breaker.status("runpod-ivrit")).failures).toBe(0)
  })

  it("returns an empty result only when the last provider is empty too", async () => {
    const empty = (id: AsrProviderId): AsrResult => ({ ...result(id), durationMs: 60_000, segments: [], speakers: [] })
    const runpod = fakeProvider("runpod-ivrit", [empty("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [empty("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.provider).toBe("soniox")
    expect(routed.segments).toEqual([])
    expect(routed.attempts).toEqual([
      expect.objectContaining({ provider: "runpod-ivrit", ok: false, kind: "no_speech" }),
      expect.objectContaining({ provider: "soniox", ok: true }),
    ])
  })

  it("returns the earlier empty result when every later provider fails", async () => {
    const empty: AsrResult = { ...result("runpod-ivrit"), durationMs: 60_000, segments: [], speakers: [] }
    const runpod = fakeProvider("runpod-ivrit", [empty])
    const soniox = fakeProvider("soniox", [serverError("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.provider).toBe("runpod-ivrit")
    expect(routed.segments).toEqual([])
    expect(routed.fallbackUsed).toBe(false)
  })

  it("keeps a short empty clip as the final answer without trying other providers", async () => {
    const empty: AsrResult = { ...result("runpod-ivrit"), durationMs: 3000, segments: [], speakers: [] }
    const runpod = fakeProvider("runpod-ivrit", [empty])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.segments).toEqual([])
    expect(soniox.transcribe).not.toHaveBeenCalled()
  })

  it("continues past a provider payload limit (HTTP 413) without opening its breaker", async () => {
    const { markMediaSpecific } = await import("@/lib/ai/asr/errors")
    const tooLarge = markMediaSpecific(new AsrError("HTTP 413", "config", "runpod-ivrit", false, 413))
    const runpod = fakeProvider("runpod-ivrit", [tooLarge])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const routed = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })

    expect(routed.provider).toBe("soniox")
    expect((await breaker.status("runpod-ivrit")).open).toBe(false)
  })

  it("skips unconfigured providers and throws TranscriptionUnavailableError on an empty chain", async () => {
    const runpod = fakeProvider("runpod-ivrit", [result("runpod-ivrit")], false)
    const soniox = fakeProvider("soniox", [result("soniox")])

    await expect(
      transcribeWithRouter(request(), { env: {}, providers: [runpod.provider, soniox.provider], breaker })
    ).resolves.toMatchObject({ provider: "soniox", fallbackUsed: false })

    const error = await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider], breaker }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(TranscriptionUnavailableError)
    // Same class as the one lib/ai/providers exports (processor imports it from there).
    expect(error).toBeInstanceOf(LegacyUnavailableError)
  })

  it("orders non-Hebrew meetings Soniox first", async () => {
    const runpod = fakeProvider("runpod-ivrit", [result("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const routed = await transcribeWithRouter(request({ language: "en" }), {
      env: {},
      providers: [runpod.provider, soniox.provider],
      breaker,
    })

    expect(routed.provider).toBe("soniox")
  })

  it("uses Gemini only when MEETSUM_ASR_ALLOW_GEMINI=true", async () => {
    const gemini = fakeProvider("gemini-legacy", [result("gemini-legacy")])

    await expect(transcribeWithRouter(request(), { env: {}, providers: [gemini.provider], breaker })).rejects.toBeInstanceOf(
      TranscriptionUnavailableError
    )
    await expect(
      transcribeWithRouter(request(), { env: { MEETSUM_ASR_ALLOW_GEMINI: "true" }, providers: [gemini.provider], breaker })
    ).resolves.toMatchObject({ provider: "gemini-legacy" })
  })

  it("routes legacy local-whisper mode to the chunked local provider only", async () => {
    const runpod = fakeProvider("runpod-ivrit", [result("runpod-ivrit")])
    const local = fakeProvider("local-whisper-chunked", [result("local-whisper-chunked")])
    const routed = await transcribeWithRouter(request(), {
      env: { MEETSUM_TRANSCRIPTION_PROVIDER: "local-whisper" },
      providers: [runpod.provider, local.provider],
      breaker,
    })

    expect(routed.provider).toBe("local-whisper-chunked")
    expect(runpod.transcribe).not.toHaveBeenCalled()
  })

  it("reports a retryable chain error when every provider is circuit-open", async () => {
    const runpod = fakeProvider("runpod-ivrit", [new AsrError("HTTP 401", "auth", "runpod-ivrit", false, 401)])

    await transcribeWithRouter(request(), { env: {}, providers: [runpod.provider], breaker }).catch(() => undefined)
    await expect(transcribeWithRouter(request(), { env: {}, providers: [runpod.provider], breaker })).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("circuit-open"),
    })
  })

  it("default providers without env never touch the network", async () => {
    const fetchSpy = vi.fn()

    await expect(
      transcribeWithRouter(request(), { env: {}, fetch: fetchSpy as unknown as typeof fetch, breaker })
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("circuit breaker", () => {
  it("closes again after the cooldown", async () => {
    let clock = 0
    const timed = createCircuitBreaker({ store: new MemoryBreakerStore(() => clock), threshold: 1, cooldownMs: 1000, now: () => clock })

    await timed.recordFailure("soniox", new AsrError("x", "server", "soniox", true))
    expect((await timed.status("soniox")).open).toBe(true)
    clock = 1001
    expect((await timed.status("soniox")).open).toBe(false)
  })

  it("persists state in Redis under meetsum:asr:breaker:<id>", async () => {
    const data = new Map<string, string>()
    const client: BreakerRedisClient = {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value) => void data.set(key, value),
      del: async (key) => void data.delete(key),
    }
    const shared = createCircuitBreaker({ store: new RedisBreakerStore(async () => client), threshold: 2 })

    await shared.recordFailure("runpod-ivrit", serverError("runpod-ivrit"))
    expect(JSON.parse(data.get(`${BREAKER_KEY_PREFIX}runpod-ivrit`)!)).toMatchObject({ failures: 1 })
    await shared.recordFailure("runpod-ivrit", serverError("runpod-ivrit"))
    expect((await shared.status("runpod-ivrit")).open).toBe(true)
    await shared.recordSuccess("runpod-ivrit")
    expect(data.has(`${BREAKER_KEY_PREFIX}runpod-ivrit`)).toBe(false)
  })

  it("falls back to memory when Redis fails", async () => {
    const broken = createCircuitBreaker({
      store: new RedisBreakerStore(async () => {
        throw new Error("ECONNREFUSED")
      }),
      threshold: 1,
    })

    await broken.recordFailure("soniox", serverError("soniox"))
    expect((await broken.status("soniox")).open).toBe(true)
  })

  it("redacts presigned URLs and keys before storing lastError", async () => {
    const store = new MemoryBreakerStore()
    const redacting = createCircuitBreaker({ store, threshold: 3 })
    const leaky = "RunPod job failed: could not fetch https://media.example.com/asr-handoff/h1.ogg?X-Amz-Signature=secret123 api_key=sk-live-abc"

    await redacting.recordFailure("runpod-ivrit", new AsrError(leaky, "server", "runpod-ivrit", true))
    await redacting.recordFailure("soniox", new AsrError(`Soniox: ${leaky}`, "auth", "soniox", false))

    for (const id of ["runpod-ivrit", "soniox"] as const) {
      const stored = JSON.stringify(await store.get(id))

      expect(stored).toContain("https://media.example.com/asr-handoff/h1.ogg?[redacted]")
      expect(stored).not.toContain("secret123")
      expect(stored).not.toContain("sk-live-abc")
    }
  })

  it("ignores media-specific errors", async () => {
    const { markMediaSpecific } = await import("@/lib/ai/asr/errors")

    await breaker.recordFailure("runpod-ivrit", markMediaSpecific(new AsrError("too big", "config", "runpod-ivrit", false)))
    expect((await breaker.status("runpod-ivrit")).open).toBe(false)
  })
})

describe("router status", () => {
  it("reports chains, health (with timeout) and breaker state", async () => {
    const runpod = fakeProvider("runpod-ivrit", [result("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const local = fakeProvider("local-whisper-chunked", [result("local-whisper-chunked")], false)

    soniox.provider.healthCheck = () => new Promise(() => undefined)
    await breaker.recordFailure("runpod-ivrit", new AsrError("HTTP 401", "auth", "runpod-ivrit", false))

    const status = await getAsrRouterStatus({
      env: {},
      providers: [runpod.provider, soniox.provider, local.provider],
      breaker,
      healthTimeoutMs: 20,
    })

    expect(status.chain).toEqual(["runpod-ivrit", "soniox"])
    expect(status.nonHebrewChain).toEqual(["soniox", "runpod-ivrit"])
    expect(status.providers).toEqual([
      expect.objectContaining({ provider: "runpod-ivrit", configured: true, healthy: true, breakerOpenUntil: expect.any(String) }),
      expect.objectContaining({ provider: "soniox", configured: true, healthy: false, lastError: expect.stringContaining("Timed out") }),
      expect.objectContaining({ provider: "local-whisper-chunked", configured: false, healthy: null }),
    ])
  })

  it("redacts breaker and health lastError in the status payload", async () => {
    const runpod = fakeProvider("runpod-ivrit", [result("runpod-ivrit")])
    const soniox = fakeProvider("soniox", [result("soniox")])
    const leakyStore = new MemoryBreakerStore()

    await leakyStore.set(
      "runpod-ivrit",
      { failures: 1, lastError: "fetch https://s3.example.com/x.ogg?X-Amz-Signature=topsecret" },
      60_000
    )
    soniox.provider.healthCheck = async () => ({
      provider: "soniox",
      configured: true,
      healthy: false,
      lastError: "Soniox: https://api.example.com/v1?token=leaky",
    })

    const status = await getAsrRouterStatus({
      env: {},
      providers: [runpod.provider, soniox.provider],
      breaker: createCircuitBreaker({ store: leakyStore }),
    })
    const payload = JSON.stringify(status)

    expect(payload).not.toContain("topsecret")
    expect(payload).not.toContain("leaky")
    expect(payload).toContain("?[redacted]")
  })

  it("exposes a synchronous configuration view", () => {
    const config = getAsrChainConfig({ SONIOX_API_KEY: "x", LOCAL_TRANSCRIPTION_URL: "http://asr" })

    expect(config.chain).toEqual(["soniox", "local-whisper-chunked"])
    expect(config.providers.find((provider) => provider.id === "runpod-ivrit")?.configured).toBe(false)
  })
})
