import {
  getGeminiProviderMode,
  getTranscriptionProviderMode,
  isGeminiConfigured,
  isLocalWhisperConfigured,
  type GeminiProviderMode,
  type TranscriptionProviderMode,
} from "@/lib/ai/providers"
import { getAsrChainConfig, type AsrChainConfig } from "@/lib/ai/asr/router"
import { getLlmStatus, type LlmStatus } from "@/lib/ai/llm"
import { getGeminiModels } from "@/lib/ai/llm/config"
import { statusMessage, type StatusMessage, type StatusMessageCode } from "@/lib/ops/status-messages"


export type ProviderHealthStatus = {
  ai: {
    provider: GeminiProviderMode
    configured: boolean
    model: string
    transcriptionMode: TranscriptionProviderMode
    localWhisperConfigured: boolean
  }
  /** M3 ASR router: effective chains and configured providers. */
  asr: AsrChainConfig
  /** M5 LLM layer: configured providers, routes, Gemini tier. */
  llm: LlmStatus
  /** English, for logs and API compatibility. */
  configWarnings: string[]
  /** `configWarnings` as codes, same order (the UI translates them). */
  configWarningMessages: StatusMessage[]
}

/**
 * Returns the current AI provider configuration and health status.
 * Does NOT make external API calls — this is a configuration check only.
 */
export function getProviderHealthStatus(): ProviderHealthStatus {
  const mode = getGeminiProviderMode()
  const configured = isGeminiConfigured()
  const transcriptionMode = getTranscriptionProviderMode()
  const localWhisperConfigured = isLocalWhisperConfigured()
  const warnings: string[] = []
  const messages: StatusMessage[] = []
  const warn = (text: string, code: StatusMessageCode, params?: Record<string, string>) => {
    warnings.push(text)
    messages.push(statusMessage(code, params))
  }

  // Validate Vertex AI env vars
  if (mode === "vertex-ai") {
    if (!process.env.GOOGLE_CLOUD_PROJECT) {
      warn("Vertex AI: GOOGLE_CLOUD_PROJECT is required", "config_vertex_project_missing", { env: "GOOGLE_CLOUD_PROJECT" })
    }

    if (!process.env.GOOGLE_CLOUD_LOCATION) {
      warn("Vertex AI: GOOGLE_CLOUD_LOCATION is required (defaulting to 'global')", "config_vertex_location_missing", {
        env: "GOOGLE_CLOUD_LOCATION",
      })
    }

    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      warn("Vertex AI: GOOGLE_APPLICATION_CREDENTIALS is required for service account auth", "config_vertex_credentials_missing", {
        env: "GOOGLE_APPLICATION_CREDENTIALS",
      })
    }
  } else if (!process.env.GOOGLE_GEMINI_API_KEY) {
    warn("Gemini Developer API: GOOGLE_GEMINI_API_KEY is not set", "config_gemini_key_missing", { env: "GOOGLE_GEMINI_API_KEY" })
  }

  // Validate transcription provider
  if (transcriptionMode === "local-whisper" && !localWhisperConfigured) {
    warn("Local Whisper selected but LOCAL_TRANSCRIPTION_URL is not configured", "config_local_whisper_url_missing", {
      env: "LOCAL_TRANSCRIPTION_URL",
    })
  }

  const asr = getAsrChainConfig()

  if (!asr.chain.length) {
    warn(
      "ASR: no transcription provider configured (RUNPOD_API_KEY + RUNPOD_ASR_ENDPOINT_ID, MODAL_ASR_URL + MODAL_ASR_TOKEN, SONIOX_API_KEY or LOCAL_TRANSCRIPTION_URL)",
      "config_asr_none",
      { env: "RUNPOD_API_KEY + RUNPOD_ASR_ENDPOINT_ID, MODAL_ASR_URL + MODAL_ASR_TOKEN, SONIOX_API_KEY, LOCAL_TRANSCRIPTION_URL" }
    )
  }
  if (
    asr.providers.some(
      (provider) => (provider.id === "runpod-ivrit" || provider.id === "modal-worker") && provider.configured
    ) &&
    !process.env.S3_PUBLIC_ENDPOINT?.trim() &&
    process.env.MEETSUM_ASR_MEDIA_HANDOFF?.trim() !== "blob"
  ) {
    warn(
      "ASR: S3_PUBLIC_ENDPOINT is not set; RunPod/Modal receive inline audio (≤ RUNPOD_MAX_BLOB_BYTES, ~38 min at 24 kbit/s)",
      "config_asr_inline_audio",
      { env: "S3_PUBLIC_ENDPOINT" }
    )
  }

  // GOOGLE_GEMINI_SUMMARY_MODEL is canonical; GEMINI_MODEL is a legacy alias.
  // Default gemini-3.8-flash (gemini-3.5-flash is deprecated).
  const model = getGeminiModels().summary
  const llm = getLlmStatus()

  // Includes the GEMINI_TIER=free privacy warning: never silent.
  warnings.push(...(llm.warnings ?? []))
  messages.push(...(llm.warningCodes ?? []).map((code) => statusMessage(code)))

  return {
    ai: {
      provider: mode,
      configured,
      model,
      transcriptionMode,
      localWhisperConfigured,
    },
    asr,
    llm,
    configWarnings: warnings,
    configWarningMessages: messages,
  }
}

/**
 * Validates the AI provider configuration at startup.
 * Returns an array of issues that should be logged.
 */
export function validateProviderConfig(): string[] {
  const issues: string[] = []
  const mode = getGeminiProviderMode()
  const configured = isGeminiConfigured()

  if (!configured) {
    issues.push(
      mode === "vertex-ai"
        ? "AI provider not configured: Set GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, and GOOGLE_APPLICATION_CREDENTIALS for Vertex AI"
        : "AI provider not configured: Set GOOGLE_GEMINI_API_KEY for Gemini Developer API"
    )
  }

  return issues
}
