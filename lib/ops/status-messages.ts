/**
 * Codes for provider / workspace status text (M9 follow-up). The server
 * status modules (lib/ops/status.ts, lib/ai/llm, lib/ai/provider-health,
 * lib/google/auth) return `{ code, params }`; components translate them with
 * these keys (`StatusMessageText`). The English `detail` / `warning` strings
 * stay in the API for older clients. Client-safe: no server imports.
 *
 * `params.env` holds environment variable names; the UI shows them as
 * literal `<code>` inside the translated sentence.
 */
export type StatusMessage = {
  code: StatusMessageCode
  params?: Record<string, string>
}

export const STATUS_MESSAGE_KEYS = {
  asr_chain: "opsStatusAsrChain",
  asr_none: "opsStatusAsrNone",
  runpod_configured: "opsStatusRunpodConfigured",
  modal_configured: "opsStatusModalConfigured",
  soniox_configured: "opsStatusSonioxConfigured",
  gemini_configured: "opsStatusGeminiConfigured",
  gemini_vertex_missing: "opsStatusGeminiVertexMissing",
  anthropic_configured: "opsStatusAnthropicConfigured",
  llm_routes: "opsStatusLlmRoutes",
  llm_heuristic_only: "opsStatusLlmHeuristicOnly",
  local_whisper_configured: "opsStatusLocalWhisperConfigured",
  local_whisper_missing: "opsStatusLocalWhisperMissing",
  realizeos_configured: "opsStatusRealizeosConfigured",
  local_gemma_configured: "opsStatusLocalGemmaConfigured",
  local_gemma_missing: "opsStatusLocalGemmaMissing",
  missing_env: "opsStatusMissingEnv",
  optional_missing_env: "opsStatusOptionalMissingEnv",
  workspace_auth_missing: "opsStatusWorkspaceAuthMissing",
  workspace_auth_user_oauth: "opsStatusWorkspaceAuthUserOauth",
  workspace_auth_keyless: "opsStatusWorkspaceAuthKeyless",
  workspace_auth_private_key: "opsStatusWorkspaceAuthPrivateKey",
  workspace_oauth_disconnected: "opsStatusWorkspaceOauthDisconnected",
  llm_warning_no_provider: "opsStatusLlmWarningNoProvider",
  llm_warning_gemini_free_tier: "intelGeminiFreeTierWarning",
  llm_warning_anthropic_missing: "opsStatusLlmWarningAnthropicMissing",
  config_vertex_project_missing: "opsStatusConfigVertexProjectMissing",
  config_vertex_location_missing: "opsStatusConfigVertexLocationMissing",
  config_vertex_credentials_missing: "opsStatusConfigVertexCredentialsMissing",
  config_gemini_key_missing: "opsStatusConfigGeminiKeyMissing",
  config_local_whisper_url_missing: "opsStatusConfigLocalWhisperUrlMissing",
  config_asr_none: "opsStatusConfigAsrNone",
  config_asr_inline_audio: "opsStatusConfigAsrInlineAudio",
} as const

export type StatusMessageCode = keyof typeof STATUS_MESSAGE_KEYS

/** Provider row labels by provider id (proper nouns keep their name). */
export const PROVIDER_LABEL_KEYS: Record<string, string> = {
  "asr-router": "opsProviderLabelAsrRouter",
  "runpod-ivrit": "opsProviderLabelRunpod",
  "modal-worker": "opsProviderLabelModal",
  "gemini-vertex": "opsProviderLabelGeminiVertex",
  anthropic: "opsProviderLabelAnthropic",
  "llm-router": "opsProviderLabelLlmRouter",
  "local-whisper": "opsProviderLabelLocalWhisper",
  "local-gemma": "opsProviderLabelLocalGemma",
}

export function statusMessage(code: StatusMessageCode, params?: Record<string, string>): StatusMessage {
  return params ? { code, params } : { code }
}
