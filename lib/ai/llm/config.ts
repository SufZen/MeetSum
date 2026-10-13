/**
 * LLM environment configuration (owner: Package A). Pure reads of
 * `process.env` (or an injected env) so routing, health and tests agree.
 *
 * Cost decisions (M5): Gemini is the default provider; Claude is optional and
 * only used when `ANTHROPIC_API_KEY` is set. `gemini-3.5-flash` is deprecated,
 * so the summary default is `gemini-3.8-flash` and the cheap model for
 * extraction-style tasks is `gemini-3.5-flash-lite`.
 */
type Env = Record<string, string | undefined>

export const DEFAULT_GEMINI_SUMMARY_MODEL = "gemini-3.8-flash"
export const DEFAULT_GEMINI_FAST_MODEL = "gemini-3.5-flash-lite"
export const DEFAULT_ANTHROPIC_SUMMARY_MODEL = "claude-sonnet-5-5"
export const DEFAULT_ANTHROPIC_FAST_MODEL = "claude-haiku-5-5"
export const DEFAULT_ANTHROPIC_JUDGE_MODEL = "claude-opus-5-5"

export const DEFAULT_MAX_TRANSCRIPT_TOKENS = 300_000

export type GeminiTier = "free" | "paid"

export type CacheTtl = "5m" | "1h"

function envText(env: Env, key: string): string | undefined {
  const value = env[key]?.trim()

  return value ? value : undefined
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback

  return !/^(0|false|no|off)$/i.test(value.trim())
}

export function getGeminiModels(env: Env = process.env) {
  return {
    summary:
      envText(env, "GOOGLE_GEMINI_SUMMARY_MODEL") ??
      envText(env, "GEMINI_MODEL") ??
      DEFAULT_GEMINI_SUMMARY_MODEL,
    fast: envText(env, "GOOGLE_GEMINI_FAST_MODEL") ?? DEFAULT_GEMINI_FAST_MODEL,
  }
}

export function getAnthropicModels(env: Env = process.env) {
  return {
    summary: envText(env, "ANTHROPIC_MODEL_SUMMARY") ?? DEFAULT_ANTHROPIC_SUMMARY_MODEL,
    fast: envText(env, "ANTHROPIC_MODEL_FAST") ?? DEFAULT_ANTHROPIC_FAST_MODEL,
    judge: envText(env, "ANTHROPIC_MODEL_JUDGE") ?? DEFAULT_ANTHROPIC_JUDGE_MODEL,
  }
}

export function getAnthropicConfig(env: Env = process.env) {
  return {
    apiKey: envText(env, "ANTHROPIC_API_KEY"),
    baseURL: envText(env, "ANTHROPIC_BASE_URL"),
    maxRetries: positiveInt(env.ANTHROPIC_MAX_RETRIES, 3),
    timeoutMs: positiveInt(env.ANTHROPIC_TIMEOUT_MS, 600_000),
    serverFallback: flag(env.ANTHROPIC_SERVER_FALLBACK, true),
  }
}

export function isAnthropicConfigured(env: Env = process.env): boolean {
  return Boolean(envText(env, "ANTHROPIC_API_KEY"))
}

/** Gemini Developer API key, or a complete Vertex AI configuration. */
export function isGeminiLlmConfigured(env: Env = process.env): boolean {
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    return Boolean(
      envText(env, "GOOGLE_CLOUD_PROJECT") &&
        envText(env, "GOOGLE_CLOUD_LOCATION") &&
        envText(env, "GOOGLE_APPLICATION_CREDENTIALS")
    )
  }

  return Boolean(envText(env, "GOOGLE_GEMINI_API_KEY"))
}

/**
 * `GEMINI_TIER=free|paid` (default `paid`). On the free tier Google may use
 * submitted content to improve its products and humans may review it, so
 * health/ops status must show a visible warning.
 */
export function getGeminiTier(env: Env = process.env): GeminiTier {
  return envText(env, "GEMINI_TIER")?.toLowerCase() === "free" ? "free" : "paid"
}

export const GEMINI_FREE_TIER_WARNING =
  "GEMINI_TIER=free: meeting content sent to the Gemini free tier may be used by Google to improve its products and may be reviewed by humans. Use a paid (billing-enabled) key for confidential meetings."

export function getCacheTtl(env: Env = process.env): CacheTtl {
  return envText(env, "MEETSUM_LLM_CACHE_TTL") === "1h" ? "1h" : "5m"
}

export function getMaxTranscriptTokens(env: Env = process.env): number {
  return positiveInt(env.MEETSUM_LLM_MAX_TRANSCRIPT_TOKENS, DEFAULT_MAX_TRANSCRIPT_TOKENS) ||
    DEFAULT_MAX_TRANSCRIPT_TOKENS
}

export function isLanguageCheckEnabled(env: Env = process.env): boolean {
  return flag(env.MEETSUM_LLM_LANGUAGE_CHECK, true)
}

/** Instance default preference (`MEETSUM_LLM_PROVIDER_DEFAULT`, `auto`). */
export function getDefaultLlmPreference(env: Env = process.env): "auto" | "anthropic" | "gemini" {
  const value = envText(env, "MEETSUM_LLM_PROVIDER_DEFAULT")?.toLowerCase()

  return value === "anthropic" || value === "gemini" ? value : "auto"
}
