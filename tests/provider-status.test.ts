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

  it("shows a visible privacy warning for the Gemini free tier (M5)", async () => {
    const { getProviderHealthStatus } = await import("@/lib/ai/provider-health")

    process.env.GOOGLE_GENAI_USE_VERTEXAI = "false"
    process.env.GOOGLE_GEMINI_API_KEY = "test-key"
    process.env.GEMINI_TIER = "free"

    const gemini = getProviderStatus().find((provider) => provider.id === "gemini")

    expect(gemini?.warning).toContain("may be used by Google")
    expect(gemini?.detail).toContain("free tier")
    expect(validateRuntimeEnvironment().warnings.join(" ")).toContain("GEMINI_TIER=free")
    expect(getProviderHealthStatus().configWarnings.join(" ")).toContain("GEMINI_TIER=free")

    process.env.GEMINI_TIER = "paid"
    expect(getProviderStatus().find((provider) => provider.id === "gemini")?.warning).toBeUndefined()
  })

  it("lists Claude as optional and the LLM route (M5)", () => {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "false"
    process.env.GOOGLE_GEMINI_API_KEY = "test-key"
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.MEETSUM_LLM_ROUTES
    delete process.env.GOOGLE_GEMINI_SUMMARY_MODEL
    delete process.env.GEMINI_MODEL

    const providers = getProviderStatus()

    expect(providers.find((provider) => provider.id === "anthropic")).toMatchObject({
      configured: false,
      detail: "Optional; missing ANTHROPIC_API_KEY",
    })
    expect(providers.find((provider) => provider.id === "llm-router")).toMatchObject({
      configured: true,
      detail: "Summary: gemini:gemini-3.8-flash",
    })
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
