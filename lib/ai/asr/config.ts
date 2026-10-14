import type { AsrProviderId } from "./types"

export type AsrEnv = Record<string, string | undefined>

export const ASR_PROVIDER_IDS: readonly AsrProviderId[] = [
  "runpod-ivrit",
  "modal-worker",
  "soniox",
  "local-whisper-chunked",
  "gemini-legacy",
]

export const DEFAULT_ASR_CHAIN: readonly AsrProviderId[] = [
  "runpod-ivrit",
  "modal-worker",
  "soniox",
  "local-whisper-chunked",
]

export const DEFAULT_ASR_CHAIN_NON_HE: readonly AsrProviderId[] = [
  "soniox",
  "runpod-ivrit",
  "modal-worker",
  "local-whisper-chunked",
]

export function envText(env: AsrEnv, name: string): string | undefined {
  const value = env[name]?.trim()

  return value ? value : undefined
}

export function envNumber(env: AsrEnv, name: string, fallback: number): number {
  const parsed = Number(env[name])

  return env[name]?.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function envFlag(env: AsrEnv, name: string, fallback = false): boolean {
  const value = env[name]?.trim().toLowerCase()

  if (!value) return fallback
  return value === "true" || value === "1" || value === "yes"
}

/** Hebrew (or mixed Hebrew/English) meetings take the Hebrew-first chain. */
export function isHebrewLanguage(language: string | undefined): boolean {
  const value = (language ?? "").trim().toLowerCase()

  return value === "he" || value === "iw" || value === "heb" || value === "mixed" || value.startsWith("he-")
}

/** Language code providers should receive (`mixed` is Hebrew + English). */
export function providerLanguage(language: string | undefined): string {
  const value = (language ?? "").trim().toLowerCase()

  if (isHebrewLanguage(value)) return "he"
  return value.split(/[-_]/)[0] || "he"
}

function parseChain(value: string): AsrProviderId[] {
  const ids: AsrProviderId[] = []

  for (const raw of value.split(",")) {
    const id = raw.trim().toLowerCase() as AsrProviderId

    if (ASR_PROVIDER_IDS.includes(id) && !ids.includes(id)) ids.push(id)
  }

  return ids
}

/**
 * Configured provider order for a meeting language (before filtering out
 * unconfigured providers). `MEETSUM_ASR_CHAIN` / `MEETSUM_ASR_CHAIN_NON_HE`
 * win; otherwise the deprecated `MEETSUM_TRANSCRIPTION_PROVIDER` is mapped
 * with its v0.6.0 meaning:
 *
 * - `local-whisper` → local Whisper only;
 * - `auto` → local Whisper, then Gemini (the v0.6.0 "local first, Gemini
 *   fallback"; Gemini drops out later when no key or Vertex is configured);
 * - `gemini` → the default chain plus Gemini.
 *
 * Otherwise Gemini is only kept when `MEETSUM_ASR_ALLOW_GEMINI=true`.
 */
export function resolveAsrChain(language: string | undefined, env: AsrEnv): AsrProviderId[] {
  const hebrew = isHebrewLanguage(language)
  const explicit = envText(env, hebrew ? "MEETSUM_ASR_CHAIN" : "MEETSUM_ASR_CHAIN_NON_HE")
  const legacy = envText(env, "MEETSUM_TRANSCRIPTION_PROVIDER")?.toLowerCase()
  let allowGemini = envFlag(env, "MEETSUM_ASR_ALLOW_GEMINI")
  let chain: AsrProviderId[]

  if (explicit) {
    chain = parseChain(explicit)
  } else if (legacy === "local-whisper") {
    chain = ["local-whisper-chunked"]
  } else if (legacy === "auto") {
    chain = ["local-whisper-chunked"]
    allowGemini = true
  } else {
    chain = [...(hebrew ? DEFAULT_ASR_CHAIN : DEFAULT_ASR_CHAIN_NON_HE)]

    if (legacy === "gemini") allowGemini = true
  }

  if (allowGemini && !chain.includes("gemini-legacy")) chain.push("gemini-legacy")
  if (!allowGemini) chain = chain.filter((id) => id !== "gemini-legacy")

  return chain
}

/** The deprecated selector, when set (`MEETSUM_ASR_CHAIN` replaces it). */
export function legacyTranscriptionProvider(env: AsrEnv): string | undefined {
  return envText(env, "MEETSUM_TRANSCRIPTION_PROVIDER")?.toLowerCase()
}
