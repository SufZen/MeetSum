/**
 * Streaming chat over the M5 router task `chat` (docs/parity/m6.md, C1;
 * owner: Package C).
 *
 * - Routes from `resolveRoutes("chat", {preference})`: Gemini
 *   (`gemini-3.8-flash`) first by default, Claude first when the preference
 *   is `anthropic`; only configured providers are tried.
 * - Fallback to the next route happens only BEFORE the first delta (auth,
 *   rate limit, 5xx, timeout, refusal, ...). After a delta, a failure throws
 *   (the Ask service turns it into an `error` event).
 * - `ai_runs`: one completed row (task `llm.chat`, tokens, cache tokens,
 *   `estimateCostUsd`, prompt version, language check) plus one row per
 *   failed attempt. Attempt errors are sanitized descriptions (kind and
 *   provider), never provider messages, which can echo prompt text.
 * - `signal` aborts the provider call.
 * - `MEETSUM_LLM_REPLAY_DIR` (non-production only) replays recorded deltas.
 */
import { createAnthropicStreamer } from "@/lib/ai/llm/anthropic-stream"
import { getCacheTtl, getDefaultLlmPreference } from "@/lib/ai/llm/config"
import { createGeminiStreamer, type ChatStreamer } from "@/lib/ai/llm/gemini-stream"
import { estimateCostUsd } from "@/lib/ai/llm/pricing"
import { LlmChainError, resolveRoutes, type LlmRoute } from "@/lib/ai/llm/router"
import { recordLlmRun } from "@/lib/ai/llm/runs"
import { isReplayEnabled, replayStream } from "@/lib/ai/llm/stream-replay"
import {
  LlmError,
  type LlmAttempt,
  type LlmErrorKind,
  type LlmStreamEvent,
  type LlmStreamRequest,
  type LlmUsage,
} from "@/lib/ai/llm/types"
import { checkOutputLanguage } from "@/lib/intelligence/language-check"
import { getAppSettings } from "@/lib/settings/app-settings"

type StreamerMap = Record<LlmRoute["provider"], ChatStreamer>

let overrides: Partial<StreamerMap> | undefined
let defaults: StreamerMap | undefined

/** Test seam: inject streamers (e.g. over mocked SDK clients); `undefined` resets. */
export function setChatStreamersForTesting(streamers?: Partial<StreamerMap>) {
  overrides = streamers
  defaults = undefined
}

function getStreamers(): StreamerMap {
  defaults ??= { gemini: createGeminiStreamer(), anthropic: createAnthropicStreamer() }

  return { gemini: overrides?.gemini ?? defaults.gemini, anthropic: overrides?.anthropic ?? defaults.anthropic }
}

async function workspacePreference(workspaceId: string): Promise<"auto" | "anthropic" | "gemini"> {
  try {
    const preference = (await getAppSettings(workspaceId)).llmProviderPreference

    if (preference === "anthropic" || preference === "gemini") return preference
  } catch {
    // Settings unavailable (e.g. no database): fall back to the env default.
  }
  return getDefaultLlmPreference()
}

function toLlmError(error: unknown, provider: string): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof Error && error.name === "AbortError") return new LlmError("Aborted", "unknown", provider, false)
  return new LlmError("Provider stream failed", "unknown", provider, false)
}

/** Loggable, prompt-free description of a failed attempt. */
function attemptError(error: LlmError, aborted: boolean): string {
  return aborted ? "aborted" : `${error.kind} error from ${error.provider}`
}

function languageMetadata(text: string, language: string): Record<string, unknown> {
  const check = checkOutputLanguage(text, language)

  return check.checked ? { languageCheck: check.passed ? "passed" : "failed", languageRatio: check.ratio } : {}
}

export async function* streamText(req: LlmStreamRequest): AsyncGenerator<LlmStreamEvent> {
  if (isReplayEnabled()) {
    yield* replayStream(req)
    return
  }

  const streamers = getStreamers()
  const preference = req.preference ?? (await workspacePreference(req.ctx.workspaceId))
  const routes = resolveRoutes("chat", {
    preference,
    provider: req.provider,
    model: req.model,
    isConfigured: (provider) => streamers[provider].isConfigured(),
  })
  const attempts: LlmAttempt[] = []
  const metadata = { ...req.runMetadata, stream: true }

  if (!routes.length) {
    const error = new LlmChainError("No LLM provider is configured for chat", "config", "none", [])

    await recordLlmRun(req.ctx, "chat", error, { metadata })
    throw error
  }

  let lastError: LlmError | undefined

  for (const [index, route] of routes.entries()) {
    const startedAt = Date.now()
    let text = ""
    let emitted = false
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    let stopReason: string | undefined
    let answeredModel = route.model

    if (index > 0 && lastError) {
      yield { type: "fallback", from: routes[index - 1].provider, to: route.provider, reason: lastError.kind }
    }
    yield { type: "start", provider: route.provider, model: route.model }

    // Set once this attempt ends normally (done, error or fallback). Still
    // false in `finally` means the consumer stopped reading mid-stream
    // (`return()`, e.g. an SSE body cancel): record the attempt as aborted.
    let settled = false

    try {
      try {
        for await (const chunk of streamers[route.provider].stream(req, route.model)) {
          if (req.signal?.aborted) throw new LlmError("Aborted", "unknown", route.provider, false)
          if (chunk.type === "delta") {
            emitted = true
            text += chunk.text
            yield { type: "delta", text: chunk.text }
          } else {
            usage = chunk.usage
            stopReason = chunk.stopReason
            answeredModel = chunk.model ?? route.model
          }
        }
        if (req.signal?.aborted) throw new LlmError("Aborted", "unknown", route.provider, false)
      } catch (caught) {
        settled = true
        const error = toLlmError(caught, route.provider)
        const aborted = Boolean(req.signal?.aborted)

        lastError = error
        attempts.push({
          provider: route.provider,
          model: route.model,
          ok: false,
          kind: error.kind,
          error: attemptError(error, aborted),
          latencyMs: Date.now() - startedAt,
        })
        // After the first delta (or on abort) there is no fallback.
        if (emitted || aborted || index === routes.length - 1) {
          const chainError = new LlmChainError(
            emitted ? "Chat stream failed after the first delta" : "All chat routes failed",
            aborted ? "unknown" : error.kind,
            route.provider,
            attempts
          )

          await recordLlmRun(req.ctx, "chat", chainError, { metadata: { ...metadata, aborted, emitted } })
          throw chainError
        }
        continue
      }
      settled = true
    } finally {
      if (!settled) {
        attempts.push({
          provider: route.provider,
          model: route.model,
          ok: false,
          kind: "unknown",
          error: "aborted",
          latencyMs: Date.now() - startedAt,
        })
        await recordLlmRun(
          req.ctx,
          "chat",
          new LlmChainError("Chat stream closed by the consumer", "unknown", route.provider, attempts),
          { metadata: { ...metadata, aborted: true, emitted, closedByConsumer: true } }
        ).catch(() => undefined)
      }
    }

    const latencyMs = Date.now() - startedAt
    const costUsd = estimateCostUsd(answeredModel, usage, { cacheTtl: getCacheTtl(), env: process.env })

    attempts.push({ provider: route.provider, model: answeredModel, ok: true, latencyMs })

    const aiRunId = await recordLlmRun(
      req.ctx,
      "chat",
      {
        value: undefined,
        provider: route.provider,
        model: answeredModel,
        usage,
        costUsd,
        latencyMs,
        attempts,
        fallbackUsed: attempts.length > 1,
        stopReason,
      },
      { metadata: { ...metadata, ...languageMetadata(text, req.language) } }
    )

    yield {
      type: "done",
      provider: route.provider,
      model: answeredModel,
      text,
      usage,
      costUsd,
      stopReason,
      latencyMs,
      ...(aiRunId ? { aiRunId } : {}),
      attempts,
    }
    return
  }

  // Unreachable: the loop either returns or throws on the last route.
  throw new LlmChainError("All chat routes failed", (lastError?.kind ?? "unknown") as LlmErrorKind, "none", attempts)
}
