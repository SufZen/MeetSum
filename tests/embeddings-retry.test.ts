import { describe, expect, it, vi } from "vitest"

import { backoffDelayMs, classifyEmbeddingError, retryAfterMsOf, withEmbeddingRetry } from "@/lib/ai/embeddings/retry"

function httpError(status: number, headers?: Record<string, string>, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status, ...(headers ? { headers } : {}) })
}

const options = (sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})) => ({ maxRetries: 5, timeoutMs: 5_000, sleep, random: () => 1 })

describe("classifyEmbeddingError", () => {
  it("maps HTTP statuses to kinds and retry decisions", () => {
    expect(classifyEmbeddingError(httpError(400))).toMatchObject({ kind: "bad_request", retryable: false })
    expect(classifyEmbeddingError(httpError(401))).toMatchObject({ kind: "auth", retryable: false })
    expect(classifyEmbeddingError(httpError(403))).toMatchObject({ kind: "auth", retryable: false })
    expect(classifyEmbeddingError(httpError(429))).toMatchObject({ kind: "rate_limit", retryable: true })
    expect(classifyEmbeddingError(httpError(503))).toMatchObject({ kind: "server", retryable: true })
    expect(classifyEmbeddingError(new Error("fetch failed"))).toMatchObject({ kind: "timeout", retryable: true })
    expect(classifyEmbeddingError(new Error("weird"))).toMatchObject({ kind: "unknown", retryable: false })
  })

  it("reads Retry-After headers and Google retryDelay", () => {
    expect(retryAfterMsOf(httpError(429, { "retry-after": "3" }))).toBe(3_000)
    expect(retryAfterMsOf(httpError(429, undefined, '{"error":{"details":[{"retryDelay":"12s"}]}}'))).toBe(12_000)
    expect(retryAfterMsOf(httpError(429))).toBeUndefined()
  })
})

describe("backoffDelayMs", () => {
  it("uses full jitter over 500 ms × 2^n capped at 20 s", () => {
    expect(backoffDelayMs(0, undefined, () => 1)).toBe(500)
    expect(backoffDelayMs(3, undefined, () => 1)).toBe(4_000)
    expect(backoffDelayMs(10, undefined, () => 1)).toBe(20_000)
    expect(backoffDelayMs(3, undefined, () => 0.5)).toBe(2_000)
    expect(backoffDelayMs(3, 7_000, () => 1)).toBe(7_000)
  })
})

describe("withEmbeddingRetry", () => {
  it("honours Retry-After on 429", async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    const fn = vi.fn().mockRejectedValueOnce(httpError(429, { "retry-after": "2" })).mockResolvedValueOnce("ok")

    await expect(withEmbeddingRetry(fn, options(sleep))).resolves.toEqual({ value: "ok", attempts: 2 })
    expect(sleep).toHaveBeenCalledWith(2_000, undefined)
  })

  it("backs off exponentially on 5xx and gives up after maxRetries", async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    const fn = vi.fn().mockRejectedValue(httpError(500))

    await expect(withEmbeddingRetry(fn, { ...options(sleep), maxRetries: 3 })).rejects.toMatchObject({ kind: "server" })
    expect(fn).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1_000, 2_000])
  })

  it("never retries a 400", async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    const fn = vi.fn().mockRejectedValue(httpError(400))

    await expect(withEmbeddingRetry(fn, options(sleep))).rejects.toMatchObject({ kind: "bad_request", retryable: false })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("stops when the caller aborts, including during a backoff sleep", async () => {
    const controller = new AbortController()

    controller.abort()
    const fn = vi.fn()

    await expect(withEmbeddingRetry(fn, { ...options(), signal: controller.signal })).rejects.toMatchObject({
      name: "EmbeddingError",
      retryable: false,
    })
    expect(fn).not.toHaveBeenCalled()

    const live = new AbortController()
    const failing = vi.fn().mockRejectedValue(httpError(503))
    const pending = withEmbeddingRetry(failing, { maxRetries: 5, timeoutMs: 5_000, signal: live.signal, random: () => 1 })

    await new Promise((resolve) => setTimeout(resolve, 10))
    live.abort()
    await expect(pending).rejects.toMatchObject({ retryable: false })
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it("passes a per-attempt timeout signal and treats its expiry as a retryable timeout", async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    const fn = vi
      .fn()
      .mockImplementationOnce(
        (signal: AbortSignal) =>
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
      )
      .mockResolvedValueOnce("late ok")

    await expect(withEmbeddingRetry(fn, { maxRetries: 2, timeoutMs: 20, sleep, random: () => 1 })).resolves.toEqual({
      value: "late ok",
      attempts: 2,
    })
    expect(fn.mock.calls[0][0]).toBeInstanceOf(AbortSignal)
  })
})
