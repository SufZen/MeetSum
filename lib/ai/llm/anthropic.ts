/**
 * Claude provider (A1) over `@anthropic-ai/sdk`. Optional: only configured
 * when `ANTHROPIC_API_KEY` is set (or a client is injected in tests).
 *
 * - The shared system block (preamble + style guide + transcript) carries
 *   `cache_control`, so a second task on the same meeting reads the cache.
 * - Structured output via `output_config.format` (json_schema); no prefill,
 *   no forced `tool_choice`, `thinking` omitted (adaptive).
 * - Sonnet/Opus non-batch calls opt into server-side refusal fallbacks.
 * - `stop_reason` is checked before content: `refusal` is a non-retryable
 *   `LlmError("refusal")` so the router moves to the next provider.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk"

import { getAnthropicConfig, getCacheTtl } from "@/lib/ai/llm/config"
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

export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01"
const STREAM_THRESHOLD_TOKENS = 16_000
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000

/** The subset of the SDK client the provider uses (tests inject a fake). */
export type AnthropicClientLike = Pick<Anthropic, "messages" | "beta">

export type AnthropicProviderOptions = {
  client?: AnthropicClientLike
  env?: Env
}

function isLargeModel(model: string): boolean {
  return /sonnet|opus/i.test(model)
}

function defaultEffort(model: string, task: string): "low" | "medium" | "high" {
  if (/haiku/i.test(model)) return "low"
  if (task === "judge" || /opus/i.test(model)) return "high"
  return "medium"
}

export function mapAnthropicError(error: unknown): LlmError {
  if (error instanceof LlmError) return error

  const message = error instanceof Error ? error.message : String(error)
  const make = (kind: LlmError["kind"], retryable: boolean) =>
    new LlmError(message, kind, "anthropic", retryable)

  if (error instanceof APIUserAbortError) return make("unknown", false)
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return make("auth", false)
  }
  if (error instanceof RateLimitError) return make("rate_limit", true)
  if (error instanceof APIConnectionTimeoutError) return make("timeout", true)
  if (error instanceof APIConnectionError) return make("server", true)
  if (
    error instanceof BadRequestError ||
    error instanceof UnprocessableEntityError ||
    error instanceof NotFoundError
  ) {
    return make("bad_request", false)
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : 0

    if (status === 401 || status === 403) return make("auth", false)
    if (status === 429) return make("rate_limit", true)
    if (status === 408) return make("timeout", true)
    if (status >= 500) return make("server", true)
    if (status >= 400) return make("bad_request", false)
  }

  return make("unknown", false)
}

type AnthropicMessage = {
  model?: string
  stop_reason?: string | null
  content?: Array<{ type: string; text?: string }>
  usage?: {
    input_tokens?: number | null
    output_tokens?: number | null
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  }
}

function usageOf(message: AnthropicMessage): LlmUsage {
  return {
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
    cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
  }
}

/** Request body (exported for tests and the eval batch path). */
export function buildAnthropicParams<T>(
  req: LlmStructuredRequest<T>,
  model: string,
  options: { env?: Env; repair?: string } = {}
) {
  const schema = zodToProviderSchema(req.schema.zod)

  return {
    model,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    system: [
      {
        type: "text" as const,
        text: buildSharedSystem(req),
        cache_control: { type: "ephemeral" as const, ttl: getCacheTtl(options.env) },
      },
    ],
    messages: [
      { role: "user" as const, content: buildUserInstructions(req.instructions, options.repair) },
    ],
    output_config: {
      format: { type: "json_schema" as const, schema },
      effort: req.effort ?? defaultEffort(model, req.task),
    },
  }
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): LlmProvider {
  let client = options.client

  const getClient = (env: Env): AnthropicClientLike => {
    if (client) return client

    const config = getAnthropicConfig(env)

    if (!config.apiKey) {
      throw new LlmError("ANTHROPIC_API_KEY is not set", "config", "anthropic", false)
    }

    client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      maxRetries: config.maxRetries,
      timeout: config.timeoutMs,
    })
    return client
  }

  return {
    id: "anthropic",
    isConfigured(env = options.env ?? process.env) {
      return Boolean(options.client) || Boolean(getAnthropicConfig(env).apiKey)
    },
    async generate<T>(req: LlmStructuredRequest<T>, model: string) {
      const env = options.env ?? process.env
      const startedAt = Date.now()
      const sdk = getClient(env)
      const config = getAnthropicConfig(env)
      const useBeta = config.serverFallback && !req.batch && isLargeModel(model)
      const stream = (req.maxOutputTokens ?? 0) > STREAM_THRESHOLD_TOKENS

      const call = async (repair?: string): Promise<RawCompletion> => {
        const params = buildAnthropicParams(req, model, { env, repair })
        const requestOptions = req.signal ? { signal: req.signal } : undefined
        let message: AnthropicMessage

        try {
          if (useBeta) {
            const betaParams = {
              ...params,
              betas: [SERVER_FALLBACK_BETA],
              fallbacks: "default" as const,
            }

            message = (stream
              ? await sdk.beta.messages.stream(betaParams as never, requestOptions).finalMessage()
              : await sdk.beta.messages.create(
                  betaParams as never,
                  requestOptions
                )) as unknown as AnthropicMessage
          } else {
            message = (stream
              ? await sdk.messages.stream(params as never, requestOptions).finalMessage()
              : await sdk.messages.create(params as never, requestOptions)) as unknown as AnthropicMessage
          }
        } catch (error) {
          throw mapAnthropicError(error)
        }

        if (message.stop_reason === "refusal") {
          throw new LlmError("Claude declined the request (refusal)", "refusal", "anthropic", false)
        }
        if (message.stop_reason === "max_tokens") {
          throw new LlmError(
            "Claude output was truncated (max_tokens)",
            "invalid_output",
            "anthropic",
            false
          )
        }

        return {
          text: (message.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join(""),
          usage: usageOf(message),
          stopReason: message.stop_reason ?? undefined,
          model: message.model,
        }
      }

      const parsed = await completeWithRepair(req, "anthropic", call)
      const answeredModel = parsed.model ?? model

      return {
        value: parsed.value,
        provider: "anthropic" as const,
        model: answeredModel,
        usage: parsed.usage,
        costUsd: estimateCostUsd(answeredModel, parsed.usage, {
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
