import { afterEach, describe, expect, it } from "vitest"

import { validateRuntimeEnvironment } from "@/lib/ops/environment"
import { getProviderStatus } from "@/lib/ops/status"

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe("provider status", () => {
  it("shows local Whisper as an optional provider when configured", () => {
    process.env.LOCAL_TRANSCRIPTION_URL = "http://faster-whisper:8000"
    process.env.LOCAL_TRANSCRIPTION_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"

    expect(getProviderStatus()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local-whisper",
          label: "Local Hebrew ASR",
          configured: true,
          mode: "ivrit-ai/whisper-large-v3-turbo-ct2",
        }),
      ])
    )
  })

  it("warns about missing local Whisper only when that provider is selected", () => {
    process.env.MEETSUM_TRANSCRIPTION_PROVIDER = "local-whisper"
    delete process.env.LOCAL_TRANSCRIPTION_URL

    expect(validateRuntimeEnvironment().warnings).toContain(
      "Local Whisper transcription is selected but LOCAL_TRANSCRIPTION_URL is missing."
    )

    process.env.MEETSUM_TRANSCRIPTION_PROVIDER = "gemini"

    expect(validateRuntimeEnvironment().warnings).not.toContain(
      "Local Whisper transcription is selected but LOCAL_TRANSCRIPTION_URL is missing."
    )
  })
})
