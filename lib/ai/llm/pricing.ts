/**
 * LLM price table and cost estimation (A3). Prices are USD per million
 * tokens. `MEETSUM_LLM_PRICES_JSON` overrides or extends the table, e.g.
 * `{"gemini-3.8-flash":{"input":0.75,"output":3.75}}`.
 *
 * Usage convention: `inputTokens` excludes cached tokens. Anthropic reports it
 * that way; the Gemini provider subtracts `cachedContentTokenCount` from
 * `promptTokenCount` before returning usage.
 */
import type { CacheTtl } from "@/lib/ai/llm/config"
import type { LlmUsage } from "@/lib/ai/llm/types"

type Env = Record<string, string | undefined>

export type ModelPrice = {
  input: number
  output: number
  /** Cache read; undefined = billed at the input rate (no discount known). */
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  /**
   * Long-context tier: when the whole prompt (input + cache read + cache
   * write) exceeds `thresholdTokens`, the entire request uses these prices.
   */
  longContext?: { thresholdTokens: number } & Omit<ModelPrice, "longContext">
}

/**
 * Defaults (M5 user cost decisions, 2026-10). Flags:
 * - Gemini 3.8 Flash pricing ($0.75/$3.75) is promotional until 2026-12-31.
 * - Haiku cache prices and the 1.25x (5m) / 2x (1h) cache-write multipliers
 *   are assumptions to confirm.
 * - Gemini cache reads are billed at the input rate here (no discount
 *   assumed) until an explicit price is configured.
 */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
  },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    longContext: {
      thresholdTokens: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite5m: 0.625,
      cacheWrite1h: 1,
    },
  },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
}

function finitePrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function parsePrice(raw: unknown): ModelPrice | undefined {
  if (!raw || typeof raw !== "object") return undefined

  const record = raw as Record<string, unknown>
  const input = finitePrice(record.input)
  const output = finitePrice(record.output)

  if (input === undefined || output === undefined) return undefined

  const price: ModelPrice = { input, output }
  const cacheRead = finitePrice(record.cacheRead)
  const cacheWrite5m = finitePrice(record.cacheWrite5m)
  const cacheWrite1h = finitePrice(record.cacheWrite1h)

  if (cacheRead !== undefined) price.cacheRead = cacheRead
  if (cacheWrite5m !== undefined) price.cacheWrite5m = cacheWrite5m
  if (cacheWrite1h !== undefined) price.cacheWrite1h = cacheWrite1h
  return price
}

/** Effective price table: defaults, then legacy Gemini env prices, then JSON. */
export function getPriceTable(env: Env = process.env): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = { ...DEFAULT_PRICES }
  const geminiInput = finitePrice(Number(env.GOOGLE_GEMINI_PRICE_INPUT_PER_MTOK || Number.NaN))
  const geminiOutput = finitePrice(Number(env.GOOGLE_GEMINI_PRICE_OUTPUT_PER_MTOK || Number.NaN))
  const geminiSummaryModel = env.GOOGLE_GEMINI_SUMMARY_MODEL?.trim()

  if (geminiSummaryModel && geminiInput !== undefined && geminiOutput !== undefined) {
    table[geminiSummaryModel] = { input: geminiInput, output: geminiOutput }
  }

  const json = env.MEETSUM_LLM_PRICES_JSON?.trim()

  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown

      if (parsed && typeof parsed === "object") {
        for (const [model, raw] of Object.entries(parsed as Record<string, unknown>)) {
          const price = parsePrice(raw)

          if (price) table[model] = price
        }
      }
    } catch {
      // Invalid override JSON keeps the defaults.
    }
  }

  return table
}

export type CostOptions = { batch?: boolean; cacheTtl?: CacheTtl; env?: Env }

/**
 * Estimated USD cost of one call; `null` for an unknown model. Batch
 * requests are billed at 50%.
 */
export function estimateCostUsd(
  model: string,
  usage: LlmUsage,
  options: CostOptions = {}
): number | null {
  const table = getPriceTable(options.env)
  const base = table[model]

  if (!base) return null

  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const price =
    base.longContext && promptTokens > base.longContext.thresholdTokens ? base.longContext : base
  const cacheWritePrice =
    options.cacheTtl === "1h"
      ? (price.cacheWrite1h ?? price.input * 2)
      : (price.cacheWrite5m ?? price.input * 1.25)
  const cost =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * (price.cacheRead ?? price.input) +
    usage.cacheWriteTokens * cacheWritePrice
  const usd = (cost / 1_000_000) * (options.batch ? 0.5 : 1)

  return Math.round(usd * 1e8) / 1e8
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

export function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}
