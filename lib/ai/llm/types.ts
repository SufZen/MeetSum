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
  batch?: boolean
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

export type LlmProvider = {
  id: LlmProviderId
  isConfigured(env?: NodeJS.ProcessEnv): boolean
  generate<T>(
    req: LlmStructuredRequest<T>,
    model: string
  ): Promise<Omit<LlmResult<T>, "attempts" | "fallbackUsed" | "aiRunId">>
}

/** Configured providers and resolved routes (provider health, ops status). */
export type LlmStatus = {
  providers: Array<{ id: LlmProviderId; configured: boolean }>
  routes: Partial<Record<LlmTask, { provider: LlmProviderId; model: string }[]>>
}
