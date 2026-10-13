/**
 * `ai_runs` persistence (A4). `insertAiRun` is the single writer (the job
 * processor's `recordAiRun` delegates to it); `recordLlmRun` writes one row
 * per failed attempt plus the completed row with tokens, cache tokens and
 * `cost_estimate`. Observability only: a failed insert never fails the
 * caller. Rows are written only with `MEETSUM_STORAGE=postgres`.
 */
import { getDatabasePool } from "@/lib/db/client"
import { LlmChainError } from "@/lib/ai/llm/router"
import {
  LlmError,
  type LlmAttempt,
  type LlmResult,
  type LlmRunContext,
  type LlmTask,
  type LlmUsage,
} from "@/lib/ai/llm/types"

export type AiRunInsert = {
  id?: string
  meetingId?: string
  workspaceId?: string
  task: string
  status: "completed" | "failed"
  provider: string
  model?: string
  /** Epoch ms. */
  startedAt: number
  /** Defaults to now - startedAt. */
  latencyMs?: number
  jobId?: string
  confidence?: number
  costEstimate?: number | null
  audioDurationMs?: number
  metadata?: Record<string, unknown>
  error?: string
  usage?: LlmUsage
  promptVersion?: string
  templateKey?: string
  batch?: boolean
}

export function newAiRunId() {
  return `airun_${crypto.randomUUID()}`
}

/** Inserts one `ai_runs` row; returns its id (also without postgres). */
export async function insertAiRun(row: AiRunInsert): Promise<string> {
  const id = row.id ?? newAiRunId()

  if (process.env.MEETSUM_STORAGE !== "postgres") return id

  try {
    await getDatabasePool().query(
      `
        insert into ai_runs (
          id, meeting_id, provider, task, status, metadata, model,
          latency_ms, confidence, started_at, completed_at, error, job_id,
          cost_estimate, audio_duration_ms, workspace_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          prompt_version, template_key, batch
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22)
      `,
      [
        id,
        row.meetingId ?? null,
        row.provider,
        row.task,
        row.status,
        JSON.stringify(row.metadata ?? {}),
        row.model ?? null,
        Math.round(row.latencyMs ?? Date.now() - row.startedAt),
        row.confidence ?? null,
        new Date(row.startedAt).toISOString(),
        row.error ?? null,
        row.jobId ?? null,
        row.costEstimate ?? null,
        row.audioDurationMs === undefined ? null : Math.round(row.audioDurationMs),
        row.workspaceId ?? null,
        row.usage?.inputTokens ?? null,
        row.usage?.outputTokens ?? null,
        row.usage?.cacheReadTokens ?? null,
        row.usage?.cacheWriteTokens ?? null,
        row.promptVersion ?? null,
        row.templateKey ?? null,
        row.batch ?? false,
      ]
    )
  } catch (error) {
    // ai_runs is observability; losing a row must not fail the pipeline.
    console.warn("Failed to record ai_run", error)
  }

  return id
}

/** `ai_runs.task` of an LLM call. */
export function llmRunTask(task: LlmTask) {
  return `llm.${task}`
}

export type LlmRunExtras = {
  languageCheck?: string
  batch?: boolean
  metadata?: Record<string, unknown>
}

function baseRow(ctx: LlmRunContext, task: LlmTask, extras: LlmRunExtras) {
  return {
    meetingId: ctx.meetingId,
    workspaceId: ctx.workspaceId,
    jobId: ctx.jobId,
    task: llmRunTask(task),
    promptVersion: ctx.promptVersion,
    templateKey: ctx.templateKey,
    batch: extras.batch ?? false,
  }
}

async function recordFailedAttempts(
  ctx: LlmRunContext,
  task: LlmTask,
  attempts: LlmAttempt[],
  extras: LlmRunExtras,
  endedAt: number
) {
  let cursor = endedAt - attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0)

  for (const attempt of attempts) {
    const startedAt = cursor

    cursor += attempt.latencyMs
    if (attempt.ok) continue

    await insertAiRun({
      ...baseRow(ctx, task, extras),
      status: "failed",
      provider: attempt.provider,
      model: attempt.model,
      startedAt,
      latencyMs: attempt.latencyMs,
      error: attempt.error,
      metadata: { kind: attempt.kind, ...extras.metadata },
    })
  }
}

/**
 * Records an LLM outcome: failed attempts first, then (on success) the
 * completed row. Returns the completed row id.
 */
export async function recordLlmRun<T>(
  ctx: LlmRunContext,
  task: LlmTask,
  outcome: Omit<LlmResult<T>, "aiRunId"> | unknown,
  extras: LlmRunExtras = {}
): Promise<string | undefined> {
  const endedAt = Date.now()

  if (outcome instanceof LlmError) {
    const attempts =
      outcome instanceof LlmChainError
        ? outcome.attempts
        : [
            {
              provider: (outcome.provider === "anthropic" || outcome.provider === "gemini"
                ? outcome.provider
                : "heuristic") as LlmAttempt["provider"],
              model: "",
              ok: false,
              kind: outcome.kind,
              error: outcome.message,
              latencyMs: 0,
            },
          ]

    await recordFailedAttempts(ctx, task, attempts, extras, endedAt)
    return undefined
  }

  const result = outcome as Omit<LlmResult<T>, "aiRunId">

  await recordFailedAttempts(ctx, task, result.attempts, extras, endedAt)

  return insertAiRun({
    ...baseRow(ctx, task, extras),
    status: "completed",
    provider: result.provider,
    model: result.model,
    startedAt: endedAt - result.latencyMs,
    latencyMs: result.latencyMs,
    costEstimate: result.costUsd,
    usage: result.usage,
    metadata: {
      attempts: result.attempts,
      fallbackUsed: result.fallbackUsed,
      stopReason: result.stopReason,
      ...(extras.languageCheck ? { languageCheck: extras.languageCheck } : {}),
      ...extras.metadata,
    },
  })
}
