import { describe, it, expect } from "vitest"

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
