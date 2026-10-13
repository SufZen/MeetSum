import { describe, it, expect } from "vitest"

import { classifyHttpStatus, toAsrError, TranscriptionUnavailableError } from "@/lib/ai/asr/errors"
import { AsrError } from "@/lib/ai/asr/types"
import { classifyWhisperError } from "@/lib/ai/providers"

describe("classifyWhisperError", () => {
  it("classifies AbortError as timeout", () => {
    const error = new DOMException("The operation was aborted", "AbortError")
    expect(classifyWhisperError(error)).toBe("timeout")
  })

  it("classifies ETIMEDOUT as timeout", () => {
    expect(classifyWhisperError(new Error("connect ETIMEDOUT 10.0.0.1:8000"))).toBe(
      "timeout"
    )
  })

  it("classifies ECONNREFUSED as connection", () => {
    expect(
      classifyWhisperError(new Error("connect ECONNREFUSED 127.0.0.1:8000"))
    ).toBe("connection")
  })

  it("classifies fetch failed as connection", () => {
    expect(classifyWhisperError(new Error("fetch failed"))).toBe("connection")
  })

  it("classifies CUDA out of memory", () => {
    expect(
      classifyWhisperError(
        new Error("CUDA error: out of memory (CUDA_ERROR_OUT_OF_MEMORY)")
      )
    ).toBe("cuda_oom")
  })

  it("classifies OOM errors", () => {
    expect(classifyWhisperError(new Error("RuntimeError: OOM killer"))).toBe(
      "cuda_oom"
    )
  })

  it("classifies model load failure", () => {
    expect(
      classifyWhisperError(
        new Error("Model not found: ivrit-ai/whisper-large-v3")
      )
    ).toBe("model_load")
  })

  it("classifies HTTP 500 as server error", () => {
    expect(
      classifyWhisperError(
        new Error("Local Whisper transcription failed with 500: internal error")
      )
    ).toBe("server_error")
  })

  it("classifies HTTP 422 as client error", () => {
    expect(
      classifyWhisperError(
        new Error("Local Whisper transcription failed with 422: invalid format")
      )
    ).toBe("client_error")
  })

  it("returns unknown for unrecognized errors", () => {
    expect(classifyWhisperError(new Error("Something unexpected"))).toBe(
      "unknown"
    )
  })

  it("handles non-Error values", () => {
    expect(classifyWhisperError("timeout string error")).toBe("timeout")
    expect(classifyWhisperError(42)).toBe("unknown")
  })
})

describe("ASR error classification", () => {
  it("maps HTTP statuses to kinds and retryability", () => {
    expect(classifyHttpStatus(401)).toEqual({ kind: "auth", retryable: false })
    expect(classifyHttpStatus(403)).toEqual({ kind: "auth", retryable: false })
    expect(classifyHttpStatus(429)).toEqual({ kind: "rate_limit", retryable: true })
    expect(classifyHttpStatus(504)).toEqual({ kind: "timeout", retryable: true })
    expect(classifyHttpStatus(500)).toEqual({ kind: "server", retryable: true })
    expect(classifyHttpStatus(413)).toEqual({ kind: "config", retryable: false, mediaSpecific: true })
    expect(classifyHttpStatus(415)).toEqual({ kind: "config", retryable: false, mediaSpecific: true })
    expect(classifyHttpStatus(404)).toEqual({ kind: "unknown", retryable: false })
  })

  it("normalizes thrown values into AsrErrors", () => {
    expect(toAsrError(new DOMException("aborted", "AbortError"), "soniox")).toMatchObject({ kind: "timeout", retryable: true })
    expect(toAsrError(new Error("connect ECONNREFUSED 10.0.0.1"), "local-whisper-chunked")).toMatchObject({
      kind: "server",
      retryable: true,
      provider: "local-whisper-chunked",
    })
    expect(toAsrError(new Error("read ETIMEDOUT"), "x")).toMatchObject({ kind: "timeout" })
    expect(toAsrError(new TranscriptionUnavailableError("none"), "x")).toMatchObject({ kind: "config", retryable: false })
    expect(toAsrError("weird", "x")).toMatchObject({ kind: "unknown", retryable: true })

    const original = new AsrError("bad", "bad_input", "runpod-ivrit", false)

    expect(toAsrError(original, "other")).toBe(original)
  })
})
