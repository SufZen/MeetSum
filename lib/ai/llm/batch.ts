/**
 * Claude Message Batches (A4), used by the eval harness only (judges at
 * -50%). Create, poll until `ended`, then read results keyed by `custom_id`.
 * Batch requests never use the server-side fallback beta.
 */
import Anthropic from "@anthropic-ai/sdk"

import { buildAnthropicParams } from "@/lib/ai/llm/anthropic"
import { getAnthropicConfig, getCacheTtl } from "@/lib/ai/llm/config"
import { estimateCostUsd } from "@/lib/ai/llm/pricing"
import { parseStructured } from "@/lib/ai/llm/structured"
import { LlmError, type LlmStructuredRequest, type LlmUsage } from "@/lib/ai/llm/types"

type BatchesApi = {
  create(params: { requests: Array<{ custom_id: string; params: unknown }> }): Promise<{ id: string }>
  retrieve(id: string): Promise<{ id: string; processing_status: string }>
  results(id: string): Promise<AsyncIterable<BatchResultLine>>
}

type BatchResultLine = {
  custom_id: string
  result:
    | {
        type: "succeeded"
        message: {
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
      }
    | { type: "errored" | "canceled" | "expired"; error?: unknown }
}

export type BatchItem<T> = { customId: string; req: LlmStructuredRequest<T>; model: string }

export type BatchItemResult<T> =
  | { customId: string; ok: true; value: T; model: string; usage: LlmUsage; costUsd: number | null }
  | { customId: string; ok: false; error: string }

export type RunBatchOptions = {
  client?: { messages: { batches: BatchesApi } }
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

function defaultClient() {
  const config = getAnthropicConfig()

  if (!config.apiKey) throw new LlmError("ANTHROPIC_API_KEY is not set", "config", "anthropic", false)

  return new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    maxRetries: config.maxRetries,
  }) as unknown as { messages: { batches: BatchesApi } }
}

export async function runMessageBatch<T>(
  items: BatchItem<T>[],
  options: RunBatchOptions = {}
): Promise<BatchItemResult<T>[]> {
  const client = options.client ?? defaultClient()
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + (options.timeoutMs ?? 24 * 60 * 60 * 1000)
  const byId = new Map(items.map((item) => [item.customId, item]))
  const batch = await client.messages.batches.create({
    requests: items.map((item) => ({
      custom_id: item.customId,
      params: buildAnthropicParams({ ...item.req, batch: true }, item.model),
    })),
  })

  let status = await client.messages.batches.retrieve(batch.id)

  while (status.processing_status !== "ended") {
    if (Date.now() > deadline) {
      throw new LlmError(`Message batch ${batch.id} timed out`, "timeout", "anthropic", true)
    }
    await sleep(options.pollIntervalMs ?? 30_000)
    status = await client.messages.batches.retrieve(batch.id)
  }

  const results: BatchItemResult<T>[] = []

  for await (const line of await client.messages.batches.results(batch.id)) {
    const item = byId.get(line.custom_id)

    if (!item) continue
    if (line.result.type !== "succeeded") {
      results.push({ customId: line.custom_id, ok: false, error: line.result.type })
      continue
    }

    const message = line.result.message

    if (message.stop_reason === "refusal") {
      results.push({ customId: line.custom_id, ok: false, error: "refusal" })
      continue
    }

    const text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
    const parsed = parseStructured(item.req, text)
    const usage: LlmUsage = {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
    }
    const model = message.model ?? item.model

    results.push(
      parsed.ok
        ? {
            customId: line.custom_id,
            ok: true,
            value: parsed.value,
            model,
            usage,
            costUsd: estimateCostUsd(model, usage, { batch: true, cacheTtl: getCacheTtl() }),
          }
        : { customId: line.custom_id, ok: false, error: parsed.errors.join("; ") }
    )
  }

  return results
}
