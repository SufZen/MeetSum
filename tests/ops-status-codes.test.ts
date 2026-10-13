/**
 * M9 follow-up: provider / workspace status returns codes and params, and
 * every code has he + en text, so the Hebrew UI shows no English status.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

import { getLlmStatus } from "@/lib/ai/llm"
import { getProviderHealthStatus } from "@/lib/ai/provider-health"
import { getWorkspaceAuthStatus } from "@/lib/google/auth"
import { dictionaries } from "@/lib/i18n/dictionaries"
import { PROVIDER_LABEL_KEYS, STATUS_MESSAGE_KEYS } from "@/lib/ops/status-messages"
import { getProviderStatus } from "@/lib/ops/status"

const ENV_KEYS = [
  "GOOGLE_GEMINI_API_KEY",
  "GEMINI_PROVIDER",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "ANTHROPIC_API_KEY",
  "RUNPOD_API_KEY",
  "RUNPOD_ASR_ENDPOINT_ID",
  "MODAL_ASR_URL",
  "MODAL_ASR_TOKEN",
  "SONIOX_API_KEY",
  "LOCAL_TRANSCRIPTION_URL",
  "REALIZEOS_API_URL",
  "LOCAL_GEMMA_URL",
  "GOOGLE_WORKSPACE_AUTH_STRATEGY",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_WORKSPACE_SERVICE_ACCOUNT",
  "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
  "GEMINI_TIER",
  "MEETSUM_LLM_PROVIDER_DEFAULT",
  "S3_PUBLIC_ENDPOINT",
]

function clearEnv() {
  for (const key of ENV_KEYS) vi.stubEnv(key, "")
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("status message keys", () => {
  it("every code and provider label has he and en text", () => {
    for (const key of [...Object.values(STATUS_MESSAGE_KEYS), ...Object.values(PROVIDER_LABEL_KEYS)]) {
      expect(dictionaries.en[key as keyof typeof dictionaries.en], key).toBeTruthy()
      expect(dictionaries.he[key as keyof typeof dictionaries.he], key).toBeTruthy()
    }
  })

  it("Hebrew status text has no English sentence outside {params}", () => {
    for (const key of Object.values(STATUS_MESSAGE_KEYS)) {
      const text = String(dictionaries.he[key as keyof typeof dictionaries.he]).replace(/\{\w+\}/g, "")

      expect(text, key).not.toMatch(/\b(?:configured|missing|optional|provider|using)\b/i)
    }
  })
})

describe("getProviderStatus codes", () => {
  it("returns a detail code (with env names as params) for every provider when nothing is configured", () => {
    clearEnv()

    const providers = getProviderStatus()

    for (const provider of providers) {
      expect(provider.detailMessage.code in STATUS_MESSAGE_KEYS, provider.id).toBe(true)
    }

    const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]))

    expect(byId["asr-router"].detailMessage).toEqual({ code: "asr_none" })
    expect(byId.gemini.detailMessage).toEqual({ code: "missing_env", params: { env: "GOOGLE_GEMINI_API_KEY" } })
    expect(byId.soniox.detailMessage).toEqual({ code: "optional_missing_env", params: { env: "SONIOX_API_KEY" } })
    expect(byId["llm-router"].detailMessage).toEqual({ code: "llm_heuristic_only" })
    expect(byId["llm-router"].warningMessages).toEqual([{ code: "llm_warning_no_provider" }])
    expect(byId.realizeos.detailMessage).toEqual({ code: "missing_env", params: { env: "REALIZEOS_API_URL" } })
    expect(byId["local-gemma"].detailMessage).toEqual({ code: "local_gemma_missing" })
    expect(byId.workspace.detailMessage).toEqual({ code: "workspace_auth_missing" })
  })

  it("configured providers carry their values as params", () => {
    clearEnv()
    vi.stubEnv("REALIZEOS_API_URL", "https://realizeos.example")
    vi.stubEnv("LOCAL_GEMMA_URL", "http://gemma.local")

    const byId = Object.fromEntries(getProviderStatus().map((provider) => [provider.id, provider]))

    expect(byId.realizeos.detailMessage).toEqual({ code: "realizeos_configured" })
    expect(byId["local-gemma"].detailMessage).toEqual({ code: "local_gemma_configured" })
  })
})

describe("other status modules", () => {
  it("getLlmStatus pairs each warning with a code", () => {
    clearEnv()

    const status = getLlmStatus({ preference: "anthropic" })

    expect(status.warningCodes).toEqual(["llm_warning_no_provider", "llm_warning_anthropic_missing"])
  })

  it("getWorkspaceAuthStatus returns a detail code", () => {
    clearEnv()
    expect(getWorkspaceAuthStatus("a@b.c").detailMessage).toEqual({ code: "workspace_auth_missing" })
    vi.stubEnv("GOOGLE_WORKSPACE_AUTH_STRATEGY", "user-oauth")
    expect(getWorkspaceAuthStatus("a@b.c").detailMessage).toEqual({ code: "workspace_auth_user_oauth" })
  })

  it("getProviderHealthStatus pairs config warnings with codes", () => {
    clearEnv()

    const health = getProviderHealthStatus()

    expect(health.configWarningMessages.map((message) => message.code)).toContain("config_asr_none")
    expect(health.configWarningMessages).toHaveLength(health.configWarnings.length)
  })
})
