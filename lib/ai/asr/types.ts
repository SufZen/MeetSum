/**
 * Contract types for the M3 ASR engine (providers, router, results).
 * See docs/parity/m3.md — shared by the ASR engine, the job processor and the
 * speaker/transcript data layer.
 */

export type AsrProviderId =
  | "runpod-ivrit"
  | "soniox"
  | "local-whisper-chunked"
  | "gemini-legacy"

export type AsrMedia =
  | {
      kind: "object"
      storageKey: string
      contentType: string
      filename?: string
      sizeBytes?: number
    }
  | { kind: "file"; path: string; contentType: string }

export type GlossaryTerm = {
  term: string
  aliases: string[]
  hotword: boolean
  caseSensitive?: boolean
}

export type AsrGlossary = { version: 1; terms: GlossaryTerm[] }

export type AsrWord = {
  startMs: number
  endMs: number
  text: string
  confidence?: number
  speaker?: string
  language?: string
}

export type AsrSegment = {
  startMs: number
  endMs: number
  text: string
  speaker: string
  turnIndex: number
  confidence?: number
  language?: string
  words: AsrWord[]
}

export type AsrSpeaker = {
  label: string
  talkTimeMs: number
  wordCount: number
  segmentCount: number
  firstStartMs: number
  embedding?: number[]
  embeddingModel?: string
}

export type AsrCost = {
  usd: number | null
  basis: "gpu_seconds" | "audio_hours" | "tokens" | "none"
  billedSeconds?: number
  unitPrice?: number
}

export type AsrRequest = {
  meetingId?: string
  workspaceId?: string
  language: string
  media: AsrMedia
  glossary: AsrGlossary
  diarize: boolean
  speakers?: { min?: number; max?: number }
  signal?: AbortSignal
}

export type AsrResult = {
  provider: AsrProviderId
  model: string
  language: string
  durationMs: number
  segments: AsrSegment[]
  speakers: AsrSpeaker[]
  diarization: "provider" | "none"
  cost: AsrCost
  timings: Record<string, number>
  glossaryReplacements: number
  warnings: string[]
}

export type AsrErrorKind =
  | "config"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "server"
  | "bad_input"
  | "no_speech"
  | "unknown"

export class AsrError extends Error {
  constructor(
    message: string,
    readonly kind: AsrErrorKind,
    readonly provider: string,
    readonly retryable: boolean,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = "AsrError"
  }
}

export type AsrAttempt = {
  provider: AsrProviderId
  ok: boolean
  kind?: AsrErrorKind
  error?: string
  elapsedMs: number
  cost?: AsrCost
}

export type AsrRouterResult = AsrResult & {
  attempts: AsrAttempt[]
  fallbackUsed: boolean
}

export class AsrChainError extends Error {
  constructor(
    message: string,
    readonly attempts: AsrAttempt[],
    readonly retryable: boolean
  ) {
    super(message)
    this.name = "AsrChainError"
  }
}

export type AsrHealth = {
  provider: AsrProviderId
  configured: boolean
  healthy: boolean | null
  breakerOpenUntil?: string
  lastError?: string
  detail?: Record<string, unknown>
}

export type AsrProvider = {
  id: AsrProviderId
  model: string
  isConfigured(env?: NodeJS.ProcessEnv): boolean
  healthCheck(): Promise<AsrHealth>
  transcribe(req: AsrRequest): Promise<AsrResult>
}
