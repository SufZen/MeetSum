/**
 * Gemini provider (A2), the default LLM provider. JSON mode with
 * `responseJsonSchema`, the shared system prompt as `systemInstruction`
 * (identical prefix across tasks, so implicit caching can apply), usage from
 * `usageMetadata`, and the same zod validation + repair as Claude.
 */
import { ApiError } from "@google/genai"

import { getCacheTtl, isGeminiLlmConfigured } from "@/lib/ai/llm/config"
import { createGeminiClient } from "@/lib/ai/llm/gemini-client"
import { estimateCostUsd } from "@/lib/ai/llm/pricing"
import { zodToProviderSchema } from "@/lib/ai/llm/schema"
import { completeWithRepair, type RawCompletion } from "@/lib/ai/llm/structured"
import { buildSharedSystem, buildUserInstructions } from "@/lib/ai/llm/system"
import {
  LlmError,
  type LlmProvider,
  type LlmStructuredRequest,
  type LlmUsage,
} from "@/lib/ai/llm/types"

type Env = Record<string, string | undefined>

const DEFAULT_MAX_OUTPUT_TOKENS = 8_000
const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
])

type GeminiResponse = {
  text?: string
  modelVersion?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
  candidates?: Array<{ finishReason?: string }>
}

/** The subset of the `@google/genai` client the provider uses. */
export type GeminiClientLike = {
  models: { generateContent(params: unknown): Promise<unknown> }
}

export type GeminiProviderOptions = {
  client?: GeminiClientLike
  env?: Env
}

export function mapGeminiError(error: unknown): LlmError {
  if (error instanceof LlmError) return error

  const message = error instanceof Error ? error.message : String(error)
  const make = (kind: LlmError["kind"], retryable: boolean) =>
    new LlmError(message, kind, "gemini", retryable)
  const status =
    error instanceof ApiError
      ? error.status
      : typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : undefined

  if (status !== undefined) {
    if (status === 401 || status === 403) return make("auth", false)
    if (status === 429) return make("rate_limit", true)
    if (status === 408 || status === 504) return make("timeout", true)
    if (status >= 500) return make("server", true)
    if (status >= 400) return make("bad_request", false)
  }
  if (error instanceof Error && error.name === "AbortError") return make("unknown", false)
  if (/timed? ?out|etimedout/i.test(message)) return make("timeout", true)
  if (/econnrefused|enotfound|econnreset|fetch failed|network/i.test(message)) {
    return make("server", true)
  }

  return make("unknown", false)
}

function usageOf(response: GeminiResponse): LlmUsage {
  const metadata = response.usageMetadata ?? {}
  const prompt = metadata.promptTokenCount ?? 0
  const cached = Math.min(metadata.cachedContentTokenCount ?? 0, prompt)

  return {
    inputTokens: prompt - cached,
    outputTokens: (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
}

/** Request body (exported for tests). */
export function buildGeminiParams<T>(
  req: LlmStructuredRequest<T>,
  model: string,
  repair?: string
) {
  return {
    model,
    contents: [
      { role: "user", parts: [{ text: buildUserInstructions(req.instructions, repair) }] },
    ],
    config: {
      systemInstruction: buildSharedSystem(req),
      responseMimeType: "application/json",
      responseJsonSchema: zodToProviderSchema(req.schema.zod),
      maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(req.signal ? { abortSignal: req.signal } : {}),
      // `attempts` counts the original request too.
      ...(req.maxRetries !== undefined
        ? { httpOptions: { retryOptions: { attempts: Math.max(1, req.maxRetries + 1) } } }
        : {}),
    },
  }
}

export function createGeminiProvider(options: GeminiProviderOptions = {}): LlmProvider {
  let client = options.client

  return {
    id: "gemini",
    isConfigured(env = options.env ?? process.env) {
      return Boolean(options.client) || isGeminiLlmConfigured(env)
    },
    async generate<T>(req: LlmStructuredRequest<T>, model: string) {
      const env = options.env ?? process.env
      const startedAt = Date.now()

      if (!client) {
        if (!isGeminiLlmConfigured(env)) {
          throw new LlmError("Gemini is not configured", "config", "gemini", false)
        }
        client = createGeminiClient() as unknown as GeminiClientLike
      }

      const sdk = client
      const call = async (repair?: string): Promise<RawCompletion> => {
        let response: GeminiResponse

        try {
          response = (await sdk.models.generateContent(
            buildGeminiParams(req, model, repair)
          )) as GeminiResponse
        } catch (error) {
          throw mapGeminiError(error)
        }

        const finishReason = response.candidates?.[0]?.finishReason

        if (response.promptFeedback?.blockReason || BLOCKED_FINISH_REASONS.has(finishReason ?? "")) {
          throw new LlmError(
            `Gemini blocked the request (${response.promptFeedback?.blockReason ?? finishReason})`,
            "refusal",
            "gemini",
            false
          )
        }
        if (finishReason === "MAX_TOKENS") {
          throw new LlmError("Gemini output was truncated (MAX_TOKENS)", "invalid_output", "gemini", false)
        }

        return {
          text: response.text ?? "",
          usage: usageOf(response),
          stopReason: finishReason,
        }
      }

      const parsed = await completeWithRepair(req, "gemini", call)

      return {
        value: parsed.value,
        provider: "gemini" as const,
        model,
        usage: parsed.usage,
        costUsd: estimateCostUsd(model, parsed.usage, {
          batch: req.batch,
          cacheTtl: getCacheTtl(env),
          env,
        }),
        latencyMs: Date.now() - startedAt,
        stopReason: parsed.stopReason,
      }
    },
  }
}
