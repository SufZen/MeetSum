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

describe("runtime environment secrets", () => {
  const productionEnv = (overrides: Record<string, string>) =>
    ({
      NODE_ENV: "production",
      MEETSUM_STORAGE: "postgres",
      DATABASE_URL: "postgres://user:pass@db:5432/meetings",
      MEETSUM_SESSION_SECRET: "a-long-random-session-secret-for-tests",
      WEBHOOK_SIGNING_SECRET: "a-long-random-webhook-secret-for-tests",
      ...overrides,
    }) as NodeJS.ProcessEnv

  it("accepts real-looking secrets in production", () => {
    expect(validateRuntimeEnvironment(productionEnv({})).fatal).toEqual([])
  })

  it.each(["dev-secret", "replace-with-long-random-webhook-secret"])(
    "rejects the placeholder WEBHOOK_SIGNING_SECRET %s in production",
    (value) => {
      const { fatal } = validateRuntimeEnvironment(
        productionEnv({ WEBHOOK_SIGNING_SECRET: value })
      )

      expect(fatal.join("\n")).toContain("WEBHOOK_SIGNING_SECRET")
    }
  )

  it("rejects the placeholder MEETSUM_SESSION_SECRET in production", () => {
    const { fatal } = validateRuntimeEnvironment(
      productionEnv({
        MEETSUM_SESSION_SECRET: "replace-with-long-random-session-secret",
      })
    )

    expect(fatal.join("\n")).toContain("MEETSUM_SESSION_SECRET")
  })

  it("allows placeholder secrets outside production", () => {
    const { fatal } = validateRuntimeEnvironment(
      productionEnv({
        NODE_ENV: "development",
        WEBHOOK_SIGNING_SECRET: "dev-secret",
      })
    )

    expect(fatal).toEqual([])
  })
})
