/**
 * Gemini streaming chat (docs/parity/m6.md, C1), the default chat route.
 * `models.generateContentStream` with the system blocks joined into
 * `systemInstruction` (the cached prefix comes first, so Gemini's implicit
 * cache can apply) and usage from the final chunk's `usageMetadata`.
 */
import { isGeminiLlmConfigured } from "@/lib/ai/llm/config"
import { createGeminiClient } from "@/lib/ai/llm/gemini-client"
import { mapGeminiError } from "@/lib/ai/llm/gemini"
import { LlmError, type LlmStreamRequest, type LlmUsage } from "@/lib/ai/llm/types"

type Env = Record<string, string | undefined>

export const DEFAULT_CHAT_MAX_OUTPUT_TOKENS = 1_500

const BLOCKED_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"])

/** One chunk of a provider stream (provider-neutral). */
export type ChatStreamChunk =
  | { type: "delta"; text: string }
  | { type: "final"; usage: LlmUsage; stopReason?: string; model?: string }

/** A streaming chat provider. */
export type ChatStreamer = {
  id: "gemini" | "anthropic"
  isConfigured(env?: Env): boolean
  stream(req: LlmStreamRequest, model: string): AsyncIterable<ChatStreamChunk>
}

type GeminiStreamChunk = {
  text?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
  candidates?: Array<{ finishReason?: string }>
}

/** The subset of the `@google/genai` client the streamer uses. */
export type GeminiStreamClientLike = {
  models: { generateContentStream(params: unknown): Promise<AsyncIterable<unknown>> }
}

function usageOf(metadata: GeminiStreamChunk["usageMetadata"] = {}): LlmUsage {
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
export function buildGeminiStreamParams(req: LlmStreamRequest, model: string) {
  return {
    model,
    contents: req.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    config: {
      systemInstruction: req.system.map((block) => block.text).join("\n\n"),
      maxOutputTokens: req.maxOutputTokens ?? DEFAULT_CHAT_MAX_OUTPUT_TOKENS,
      ...(req.signal ? { abortSignal: req.signal } : {}),
      // Interactive: one transport retry; the route fallback handles the rest.
      httpOptions: { retryOptions: { attempts: 2 } },
    },
  }
}

export function createGeminiStreamer(options: { client?: GeminiStreamClientLike; env?: Env } = {}): ChatStreamer {
  let client = options.client

  return {
    id: "gemini",
    isConfigured(env = options.env ?? process.env) {
      return Boolean(options.client) || isGeminiLlmConfigured(env)
    },
    async *stream(req, model) {
      const env = options.env ?? process.env

      if (!client) {
        if (!isGeminiLlmConfigured(env)) throw new LlmError("Gemini is not configured", "config", "gemini", false)
        client = createGeminiClient() as unknown as GeminiStreamClientLike
      }

      let usage: LlmUsage = usageOf()
      let stopReason: string | undefined

      try {
        const stream = await client.models.generateContentStream(buildGeminiStreamParams(req, model))

        for await (const raw of stream) {
          const chunk = raw as GeminiStreamChunk
          const finishReason = chunk.candidates?.[0]?.finishReason

          if (chunk.promptFeedback?.blockReason || BLOCKED_FINISH_REASONS.has(finishReason ?? "")) {
            throw new LlmError("Gemini blocked the request", "refusal", "gemini", false)
          }
          if (chunk.usageMetadata) usage = usageOf(chunk.usageMetadata)
          if (finishReason) stopReason = finishReason
          if (req.signal?.aborted) throw new LlmError("Aborted", "unknown", "gemini", false)
          if (chunk.text) yield { type: "delta", text: chunk.text }
        }
      } catch (error) {
        throw mapGeminiError(error)
      }

      yield { type: "final", usage, stopReason }
    },
  }
}
