/**
 * Claude streaming chat (docs/parity/m6.md, C1). Optional: configured only
 * when `ANTHROPIC_API_KEY` is set (or a client is injected in tests).
 *
 * - System blocks with `cache: true` get `cache_control` (ephemeral, the
 *   `MEETSUM_LLM_CACHE_TTL` ttl); a message with `cache: true` gets it on its
 *   last block. Callers only flag the shared prefix and prior history, never
 *   this request's question.
 * - Text deltas come from `content_block_delta` events; usage and
 *   `stop_reason` from `finalMessage()`. `refusal` is an `LlmError("refusal")`.
 */
import Anthropic from "@anthropic-ai/sdk"

import { mapAnthropicError } from "@/lib/ai/llm/anthropic"
import { getAnthropicConfig, getCacheTtl } from "@/lib/ai/llm/config"
import { DEFAULT_CHAT_MAX_OUTPUT_TOKENS, type ChatStreamer } from "@/lib/ai/llm/gemini-stream"
import { LlmError, type LlmStreamRequest, type LlmUsage } from "@/lib/ai/llm/types"

type Env = Record<string, string | undefined>

type StreamEvent = { type: string; delta?: { type?: string; text?: string } }

type FinalMessage = {
  model?: string
  stop_reason?: string | null
  usage?: {
    input_tokens?: number | null
    output_tokens?: number | null
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  }
}

type MessageStreamLike = AsyncIterable<unknown> & { finalMessage(): Promise<unknown> }

/** The subset of the SDK client the streamer uses (tests inject a fake). */
export type AnthropicStreamClientLike = {
  messages: { stream(params: unknown, options?: unknown): MessageStreamLike }
}

function usageOf(message: FinalMessage): LlmUsage {
  return {
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
    cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
  }
}

/** Request body (exported for tests). */
export function buildAnthropicStreamParams(req: LlmStreamRequest, model: string, env?: Env) {
  const cacheControl = { type: "ephemeral" as const, ttl: getCacheTtl(env) }

  return {
    model,
    max_tokens: req.maxOutputTokens ?? DEFAULT_CHAT_MAX_OUTPUT_TOKENS,
    system: req.system.map((block) => ({
      type: "text" as const,
      text: block.text,
      ...(block.cache ? { cache_control: cacheControl } : {}),
    })),
    messages: req.messages.map((message) => ({
      role: message.role,
      content: [
        {
          type: "text" as const,
          text: message.content,
          ...(message.cache ? { cache_control: cacheControl } : {}),
        },
      ],
    })),
  }
}

export function createAnthropicStreamer(
  options: { client?: AnthropicStreamClientLike; env?: Env } = {}
): ChatStreamer {
  let client = options.client

  const getClient = (env: Env): AnthropicStreamClientLike => {
    if (client) return client

    const config = getAnthropicConfig(env)

    if (!config.apiKey) throw new LlmError("ANTHROPIC_API_KEY is not set", "config", "anthropic", false)
    client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      // Interactive: one transport retry; the route fallback handles the rest.
      maxRetries: 1,
      timeout: Math.min(config.timeoutMs, 120_000),
    }) as unknown as AnthropicStreamClientLike
    return client
  }

  return {
    id: "anthropic",
    isConfigured(env = options.env ?? process.env) {
      return Boolean(options.client) || Boolean(getAnthropicConfig(env).apiKey)
    },
    async *stream(req, model) {
      const env = options.env ?? process.env
      let message: FinalMessage

      try {
        const stream = getClient(env).messages.stream(
          buildAnthropicStreamParams(req, model, env),
          req.signal ? { signal: req.signal } : undefined
        )

        for await (const raw of stream) {
          const event = raw as StreamEvent

          if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            yield { type: "delta", text: event.delta.text }
          }
        }
        message = (await stream.finalMessage()) as FinalMessage
      } catch (error) {
        throw mapAnthropicError(error)
      }

      if (message.stop_reason === "refusal") {
        throw new LlmError("Claude declined the request (refusal)", "refusal", "anthropic", false)
      }

      yield { type: "final", usage: usageOf(message), stopReason: message.stop_reason ?? undefined, model: message.model }
    },
  }
}
