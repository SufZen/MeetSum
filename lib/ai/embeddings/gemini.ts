/**
 * Gemini embeddings (`gemini-embedding-001`, docs/parity/m6.md A4):
 * `models.embedContent({model, contents, config: {taskType,
 * outputDimensionality, title?}})`, batches of `batchSize` with
 * `concurrency` in flight, retried per batch, then L2-normalized (reduced
 * MRL outputs are not pre-normalized). Cost = tokens × price / 1e6; tokens
 * are estimated when the API reports none (`usage.estimated`).
 *
 * Batching on Vertex is an assumption to verify: a response with a wrong
 * number of embeddings falls back to one request per input.
 */
import { createGeminiClient } from "@/lib/ai/llm/gemini-client"
import type { EmbeddingConfig } from "@/lib/ai/embeddings/config"
import { assertValidEmbeddingKey } from "@/lib/ai/embeddings/config"
import { withEmbeddingRetry, type RetryOptions } from "@/lib/ai/embeddings/retry"
import {
  EmbeddingError,
  type EmbeddingBatchResult,
  type EmbeddingInput,
  type EmbeddingProvider,
  type EmbeddingTask,
} from "@/lib/ai/embeddings/types"
import { estimateTokens } from "@/lib/intelligence/transcript-format"

type Env = Record<string, string | undefined>

export type GeminiEmbedResponse = {
  embeddings?: { values?: number[]; statistics?: { tokenCount?: number } }[]
}

export type GeminiEmbedClient = {
  models: {
    embedContent(params: {
      model: string
      contents: string[]
      config: { taskType: string; outputDimensionality: number; title?: string; abortSignal?: AbortSignal }
    }): Promise<GeminiEmbedResponse>
  }
}

export type GeminiEmbeddingDeps = {
  client?: () => GeminiEmbedClient
  sleep?: RetryOptions["sleep"]
  random?: RetryOptions["random"]
}

/** Gemini credentials (Developer API key, or the Vertex AI trio) are present. */
export function isGeminiEmbeddingConfigured(env: Env = process.env): boolean {
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    return Boolean(env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_LOCATION && env.GOOGLE_APPLICATION_CREDENTIALS)
  }

  return Boolean(env.GOOGLE_GEMINI_API_KEY)
}

export function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))

  return norm > 0 ? vector.map((value) => value / norm) : vector
}

type Batch = { start: number; inputs: EmbeddingInput[] }

/** Consecutive inputs with the same title, at most `size` each (a title applies to a whole request). */
function makeBatches(inputs: EmbeddingInput[], size: number, useTitle: boolean): Batch[] {
  const batches: Batch[] = []

  inputs.forEach((input, index) => {
    const last = batches[batches.length - 1]
    const title = useTitle ? input.title : undefined
    const lastTitle = useTitle ? last?.inputs[0]?.title : undefined

    if (last && last.inputs.length < size && lastTitle === title) last.inputs.push(input)
    else batches.push({ start: index, inputs: [input] })
  })

  return batches
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next

      next += 1
      results[index] = await fn(items[index])
    }
  })

  await Promise.all(workers)

  return results
}

export function createGeminiEmbeddingProvider(config: EmbeddingConfig, deps: GeminiEmbeddingDeps = {}): EmbeddingProvider {
  const key = assertValidEmbeddingKey({ model: config.model, dimensions: config.dimensions })
  let client: GeminiEmbedClient | undefined
  const getClient = () => (client ??= deps.client ? deps.client() : (createGeminiClient() as unknown as GeminiEmbedClient))

  async function request(batch: EmbeddingInput[], task: EmbeddingTask, signal?: AbortSignal) {
    const title = task === "RETRIEVAL_DOCUMENT" ? batch[0]?.title?.trim() : undefined

    return withEmbeddingRetry(
      (attemptSignal) =>
        getClient().models.embedContent({
          model: key.model,
          contents: batch.map((input) => input.text),
          config: {
            taskType: task,
            outputDimensionality: key.dimensions,
            ...(title ? { title } : {}),
            abortSignal: attemptSignal,
          },
        }),
      { maxRetries: config.maxRetries, timeoutMs: config.timeoutMs, signal, sleep: deps.sleep, random: deps.random }
    )
  }

  function vectorsOf(response: GeminiEmbedResponse, expected: number) {
    const embeddings = response.embeddings ?? []

    if (embeddings.length !== expected) return undefined

    return embeddings.map((embedding) => {
      const values = embedding.values ?? []

      if (values.length !== key.dimensions) {
        throw new EmbeddingError(
          `Embedding has ${values.length} dimensions, expected ${key.dimensions}`,
          "server",
          false
        )
      }

      return { vector: l2Normalize(values), tokens: embedding.statistics?.tokenCount }
    })
  }

  async function embedBatch(batch: Batch, task: EmbeddingTask, signal?: AbortSignal) {
    const { value, attempts } = await request(batch.inputs, task, signal)
    const vectors = vectorsOf(value, batch.inputs.length)

    if (vectors) return { vectors, attempts, requests: 1 }
    if (batch.inputs.length === 1) {
      throw new EmbeddingError("Embedding response has no vector", "server", false)
    }

    // Batching unsupported (Vertex assumption): one request per input.
    let total = attempts
    const single = []

    for (const input of batch.inputs) {
      const one = await request([input], task, signal)
      const [vector] = vectorsOf(one.value, 1) ?? []

      if (!vector) throw new EmbeddingError("Embedding response has no vector", "server", false)
      total += one.attempts
      single.push(vector)
    }

    return { vectors: single, attempts: total, requests: batch.inputs.length + 1 }
  }

  return {
    id: "gemini",
    key,
    isConfigured: (env?: Env) => isGeminiEmbeddingConfigured(env ?? process.env),
    async embed(inputs, opts): Promise<EmbeddingBatchResult> {
      const startedAt = Date.now()

      if (!inputs.length) {
        return { vectors: [], key, usage: { inputTokens: 0, estimated: false }, costUsd: 0, latencyMs: 0, attempts: 0 }
      }

      const batches = makeBatches(inputs, config.batchSize, opts.task === "RETRIEVAL_DOCUMENT")
      const results = await mapWithConcurrency(batches, config.concurrency, (batch) =>
        embedBatch(batch, opts.task, opts.signal)
      )
      const flat = results.flatMap((result) => result.vectors)
      const reported = flat.every((entry) => typeof entry.tokens === "number")
      const inputTokens = reported
        ? flat.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0)
        : inputs.reduce((sum, input) => sum + estimateTokens(input.text), 0)

      return {
        vectors: flat.map((entry) => entry.vector),
        key,
        usage: { inputTokens, estimated: !reported },
        costUsd: (inputTokens * config.pricePerMTok) / 1e6,
        latencyMs: Date.now() - startedAt,
        attempts: results.reduce((sum, result) => sum + result.attempts, 0),
      }
    },
  }
}
