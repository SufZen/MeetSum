import {
  getGeminiProviderMode,
  getTranscriptionProviderMode,
  isGeminiConfigured,
  isLocalWhisperConfigured,
  type GeminiProviderMode,
  type TranscriptionProviderMode,
} from "@/lib/ai/providers"


export type ProviderHealthStatus = {
  ai: {
    provider: GeminiProviderMode
    configured: boolean
    model: string
    transcriptionMode: TranscriptionProviderMode
    localWhisperConfigured: boolean
  }
  configWarnings: string[]
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

  // Validate Vertex AI env vars
  if (mode === "vertex-ai") {
    if (!process.env.GOOGLE_CLOUD_PROJECT) {
      warnings.push("Vertex AI: GOOGLE_CLOUD_PROJECT is required")
    }

    if (!process.env.GOOGLE_CLOUD_LOCATION) {
      warnings.push("Vertex AI: GOOGLE_CLOUD_LOCATION is required (defaulting to 'global')")
    }

    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      warnings.push("Vertex AI: GOOGLE_APPLICATION_CREDENTIALS is required for service account auth")
    }
  } else if (!process.env.GOOGLE_GEMINI_API_KEY) {
    warnings.push("Gemini Developer API: GOOGLE_GEMINI_API_KEY is not set")
  }

  // Validate transcription provider
  if (transcriptionMode === "local-whisper" && !localWhisperConfigured) {
    warnings.push("Local Whisper selected but WHISPER_API_URL is not configured")
  }

  const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash"

  return {
    ai: {
      provider: mode,
      configured,
      model,
      transcriptionMode,
      localWhisperConfigured,
    },
    configWarnings: warnings,
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
