/**
 * v0.7.1: the deprecated `MEETSUM_TRANSCRIPTION_PROVIDER=auto` keeps its
 * v0.6.0 meaning (local Whisper, then Gemini when a Gemini key or Vertex is
 * configured) while `MEETSUM_ASR_CHAIN` is unset, and the boot warnings name
 * the deprecation and a single-provider Hebrew chain.
 */
import { describe, expect, it } from "vitest"

import { resolveAsrChain } from "@/lib/ai/asr/config"
import { getAsrBootWarnings, getEffectiveAsrChain } from "@/lib/ai/asr/router"

const LOCAL = { LOCAL_TRANSCRIPTION_URL: "http://laptop.example:8000" }
const GEMINI = { GOOGLE_GEMINI_API_KEY: "test-key" }
const VERTEX = {
  GOOGLE_GENAI_USE_VERTEXAI: "true",
  GOOGLE_CLOUD_PROJECT: "p",
  GOOGLE_CLOUD_LOCATION: "europe-west1",
  GOOGLE_APPLICATION_CREDENTIALS: "/secrets/sa.json",
}

describe("legacy MEETSUM_TRANSCRIPTION_PROVIDER=auto", () => {
  it("resolves to local Whisper then Gemini for every language", () => {
    for (const language of ["he", "mixed", "en", "pt"]) {
      expect(resolveAsrChain(language, { MEETSUM_TRANSCRIPTION_PROVIDER: "auto" }), language).toEqual([
        "local-whisper-chunked",
        "gemini-legacy",
      ])
    }
    expect(resolveAsrChain("he", { MEETSUM_TRANSCRIPTION_PROVIDER: " AUTO " })).toEqual(["local-whisper-chunked", "gemini-legacy"])
  })

  it("keeps the Gemini fallback of the v0.6.0 production env (Lemonade + Gemini key)", () => {
    const env = { MEETSUM_TRANSCRIPTION_PROVIDER: "auto", ...LOCAL, ...GEMINI }

    expect(getEffectiveAsrChain("he", { env })).toEqual(["local-whisper-chunked", "gemini-legacy"])
    expect(getEffectiveAsrChain("en", { env })).toEqual(["local-whisper-chunked", "gemini-legacy"])
  })

  it("uses Vertex as the Gemini configuration too", () => {
    expect(getEffectiveAsrChain("he", { env: { MEETSUM_TRANSCRIPTION_PROVIDER: "auto", ...LOCAL, ...VERTEX } })).toEqual([
      "local-whisper-chunked",
      "gemini-legacy",
    ])
  })

  it("drops Gemini when neither a key nor Vertex is configured", () => {
    expect(getEffectiveAsrChain("he", { env: { MEETSUM_TRANSCRIPTION_PROVIDER: "auto", ...LOCAL } })).toEqual([
      "local-whisper-chunked",
    ])
  })

  it("is ignored once MEETSUM_ASR_CHAIN is set", () => {
    const env = { MEETSUM_TRANSCRIPTION_PROVIDER: "auto", MEETSUM_ASR_CHAIN: "local-whisper-chunked" }

    expect(resolveAsrChain("he", env)).toEqual(["local-whisper-chunked"])
    expect(resolveAsrChain("he", { ...env, MEETSUM_ASR_ALLOW_GEMINI: "true" })).toEqual(["local-whisper-chunked", "gemini-legacy"])
  })

  it("an unset legacy variable still means the default chain without Gemini", () => {
    expect(resolveAsrChain("he", {})).not.toContain("gemini-legacy")
  })
})

describe("getAsrBootWarnings", () => {
  it("warns that MEETSUM_TRANSCRIPTION_PROVIDER is deprecated and names the replacement", () => {
    const warnings = getAsrBootWarnings({ MEETSUM_TRANSCRIPTION_PROVIDER: "auto", ...LOCAL, ...GEMINI })

    expect(warnings.some((warning) => /MEETSUM_TRANSCRIPTION_PROVIDER.*deprecated/.test(warning))).toBe(true)
    expect(warnings.join("\n")).toContain("MEETSUM_ASR_CHAIN=local-whisper-chunked")
    expect(warnings.join("\n")).toContain("MEETSUM_ASR_ALLOW_GEMINI=true")
    // Two configured providers: no single-provider warning.
    expect(warnings.some((warning) => /only one/.test(warning))).toBe(false)
  })

  it("says the legacy variable is ignored when MEETSUM_ASR_CHAIN is set", () => {
    const warnings = getAsrBootWarnings({
      MEETSUM_TRANSCRIPTION_PROVIDER: "auto",
      MEETSUM_ASR_CHAIN: "local-whisper-chunked",
      MEETSUM_ASR_ALLOW_GEMINI: "true",
      ...LOCAL,
      ...GEMINI,
    })

    expect(warnings.some((warning) => /ignored/.test(warning))).toBe(true)
  })

  it("warns when the Hebrew chain has only one configured provider", () => {
    const warnings = getAsrBootWarnings({ MEETSUM_ASR_CHAIN: "local-whisper-chunked", ...LOCAL })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/only one configured provider \(local-whisper-chunked\)/)
  })

  it("warns when no Hebrew provider is configured at all", () => {
    expect(getAsrBootWarnings({}).join("\n")).toMatch(/no configured provider/)
  })

  it("is quiet for a configured multi-provider chain and never prints secret values", () => {
    const env = { MEETSUM_ASR_CHAIN: "local-whisper-chunked", MEETSUM_ASR_ALLOW_GEMINI: "true", ...LOCAL, ...GEMINI }

    expect(getAsrBootWarnings(env)).toEqual([])
    expect(getAsrBootWarnings({ ...env, MEETSUM_TRANSCRIPTION_PROVIDER: "auto" }).join("\n")).not.toContain("test-key")
  })
})
