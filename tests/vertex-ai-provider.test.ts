import { afterEach, describe, expect, it, vi } from "vitest"

import { getProviderHealthStatus, validateProviderConfig } from "@/lib/ai/provider-health"

describe("provider health status", () => {
  it("reports developer API mode by default", () => {
    const status = getProviderHealthStatus()

    expect(status.ai.provider).toBe("gemini-developer-api")
    expect(status.ai.transcriptionMode).toBeDefined()
    expect(status.ai.model).toBeTruthy()
  })

  it("detects vertex-ai mode from env", () => {
    const original = process.env.GOOGLE_GENAI_USE_VERTEXAI
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true"

    const status = getProviderHealthStatus()

    expect(status.ai.provider).toBe("vertex-ai")

    process.env.GOOGLE_GENAI_USE_VERTEXAI = original
  })

  it("warns when vertex-ai env vars are missing", () => {
    const original = process.env.GOOGLE_GENAI_USE_VERTEXAI
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true"

    // Clear Vertex AI env vars
    const origProject = process.env.GOOGLE_CLOUD_PROJECT
    const origLocation = process.env.GOOGLE_CLOUD_LOCATION
    const origCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_CLOUD_LOCATION
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS

    const status = getProviderHealthStatus()

    expect(status.configWarnings.length).toBeGreaterThan(0)
    expect(status.configWarnings.some((w) => w.includes("GOOGLE_CLOUD_PROJECT"))).toBe(true)

    // Restore
    process.env.GOOGLE_GENAI_USE_VERTEXAI = original
    if (origProject) process.env.GOOGLE_CLOUD_PROJECT = origProject
    if (origLocation) process.env.GOOGLE_CLOUD_LOCATION = origLocation
    if (origCreds) process.env.GOOGLE_APPLICATION_CREDENTIALS = origCreds
  })

  it("validateProviderConfig returns issues when not configured", () => {
    const origKey = process.env.GOOGLE_GEMINI_API_KEY
    delete process.env.GOOGLE_GEMINI_API_KEY

    const issues = validateProviderConfig()

    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain("GOOGLE_GEMINI_API_KEY")

    if (origKey) process.env.GOOGLE_GEMINI_API_KEY = origKey
  })
})

describe("provider health model", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("prefers the canonical GOOGLE_GEMINI_SUMMARY_MODEL over the GEMINI_MODEL alias", () => {
    vi.stubEnv("GOOGLE_GEMINI_SUMMARY_MODEL", "gemini-canonical")
    vi.stubEnv("GEMINI_MODEL", "gemini-alias")

    expect(getProviderHealthStatus().ai.model).toBe("gemini-canonical")
  })

  it("falls back to the legacy GEMINI_MODEL alias", () => {
    vi.stubEnv("GOOGLE_GEMINI_SUMMARY_MODEL", undefined)
    vi.stubEnv("GEMINI_MODEL", "gemini-alias")

    expect(getProviderHealthStatus().ai.model).toBe("gemini-alias")
  })
})
