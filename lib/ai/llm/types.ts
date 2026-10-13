/**
 * Provider-neutral LLM contract (docs/parity/m5.md, Step 0; owner: Package A).
 * Every structured LLM call (summary, title/tags/type, extraction, sentiment,
 * prep brief, follow-up, chat, eval judge) goes through `generateStructured`.
 */
import type { ZodType } from "zod"

export type LlmProviderId = "anthropic" | "gemini" | "heuristic"

export type LlmTask =
  | "summary"
  | "title_tags_type"
  | "extraction"
  | "sentiment"
  | "prep_brief"
  | "follow_up"
  | "chat"
  | "judge"

export type LlmUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type LlmRunContext = {
  workspaceId: string
  meetingId?: string
  jobId?: string
  promptVersion: string
  templateKey?: string
}

export type LlmStructuredRequest<T> = {
  task: LlmTask
  ctx: LlmRunContext
  language: "he" | "en" | string
  /** Transcript block; cached prefix (identical across tasks per model). */
  sharedContext?: string
  /** Task-specific; after the cache breakpoint. */
  instructions: string
  schema: { name: string; zod: ZodType<T> }
  maxOutputTokens?: number
  effort?: "low" | "medium" | "high"
  /** Force a provider/model (eval). */
  provider?: LlmProviderId
  model?: string
  /** Semantic errors -> one repair retry. */
  validate?: (value: T) => string[]
  signal?: AbortSignal
  /**
   * Transport retries per provider call (SDK default when unset). Interactive
   * tasks use 1 with a 60s `signal` (see `interactiveLlmOptions`).
   */
  maxRetries?: number
  batch?: boolean
  /**
   * Provider preference; defaults to the workspace `llmProviderPreference`
   * (then `MEETSUM_LLM_PROVIDER_DEFAULT`, then `auto`).
   */
  preference?: "auto" | "anthropic" | "gemini"
  /** Write `ai_runs` rows (default true). */
  record?: boolean
  /** Extra `ai_runs.metadata` (e.g. `languageCheck`). */
  runMetadata?: Record<string, unknown>
}

export type LlmErrorKind =
  | "config"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "server"
  | "bad_request"
  | "refusal"
  | "invalid_output"
  | "unknown"

export type LlmAttempt = {
  provider: LlmProviderId
  model: string
  ok: boolean
  kind?: LlmErrorKind
  error?: string
  latencyMs: number
}

export type LlmResult<T> = {
  value: T
  provider: LlmProviderId
  model: string
  usage: LlmUsage
  costUsd: number | null
  latencyMs: number
  attempts: LlmAttempt[]
  fallbackUsed: boolean
  stopReason?: string
  aiRunId?: string
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    readonly provider: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = "LlmError"
  }
}

/**
 * Loggable description of an LLM failure: error name, kind and provider
 * only. Messages are never included (parse and provider errors can carry
 * fragments of the model output or the prompt).
 */
export function describeLlmFailure(error: unknown): string {
  if (error instanceof LlmError) return `${error.name} (${error.kind}, ${error.provider})`
  if (error instanceof Error) return error.name || "Error"
  return "unknown error"
}

export type LlmProvider = {
  id: LlmProviderId
  isConfigured(env?: Record<string, string | undefined>): boolean
  generate<T>(
    req: LlmStructuredRequest<T>,
    model: string
  ): Promise<Omit<LlmResult<T>, "attempts" | "fallbackUsed" | "aiRunId">>
}

/** Configured providers and resolved routes (provider health, ops status). */
export type LlmStatus = {
  providers: Array<{ id: LlmProviderId; configured: boolean }>
  routes: Partial<Record<LlmTask, { provider: LlmProviderId; model: string }[]>>
  /** Preference the routes were resolved with. */
  preference?: "auto" | "anthropic" | "gemini"
  /** `GEMINI_TIER` (free tier content may be used for training/review). */
  geminiTier?: "free" | "paid"
  /** Configuration warnings to show in health/ops/settings. */
  warnings?: string[]
  /** True when no provider is configured (heuristic summaries only). */
  heuristicOnly?: boolean
}

/*
 * M6 streaming chat contract (docs/parity/m6.md, "Shared contracts"; Step 0,
 * additions only). Frozen after Step 0; `streamText` lives in `./stream`.
 */

export type LlmChatMessage = { role: "user" | "assistant"; content: string; cache?: boolean }

export type LlmStreamRequest = {
  task: "chat"
  ctx: LlmRunContext
  language: string
  system: { text: string; cache?: boolean }[]
  messages: LlmChatMessage[]
  maxOutputTokens?: number
  preference?: "auto" | "anthropic" | "gemini"
  provider?: LlmProviderId
  model?: string
  signal?: AbortSignal
  runMetadata?: Record<string, unknown>
}

export type LlmStreamEvent =
  | { type: "start"; provider: LlmProviderId; model: string }
  | { type: "delta"; text: string }
  | { type: "fallback"; from: LlmProviderId; to: LlmProviderId; reason: LlmErrorKind }
  | {
      type: "done"
      provider: LlmProviderId
      model: string
      text: string
      usage: LlmUsage
      costUsd: number | null
      stopReason?: string
      latencyMs: number
      aiRunId?: string
      attempts: LlmAttempt[]
    }
