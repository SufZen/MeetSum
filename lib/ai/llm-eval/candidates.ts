/**
 * Eval candidates, judges and prices (M5 D8).
 *
 * Cost decision (owner): Gemini is the default provider and Claude optional.
 * By default the harness compares `gemini:gemini-3.8-flash` (challenger)
 * against `gemini:gemini-3.5-flash-lite` (cost baseline); Claude Haiku and
 * Sonnet join only when `ANTHROPIC_API_KEY` is set. `MEETSUM_EVAL_CANDIDATES`
 * / `--candidates` and `--baseline` override.
 */
import type { EvalModel, EvalProvider, ModelSpec } from "@/lib/ai/llm-eval/types"

/** Environment variables (a plain record, so tests can pass `{}`). */
export type EvalEnv = Readonly<Record<string, string | undefined>>

export const DEFAULT_GEMINI_CANDIDATES: ModelSpec[] = ["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite"]
export const DEFAULT_BASELINE: ModelSpec = "gemini:gemini-3.5-flash-lite"
export const CLAUDE_CANDIDATES: ModelSpec[] = ["anthropic:claude-haiku-5-5", "anthropic:claude-sonnet-5-5"]
export const DEFAULT_CLAUDE_JUDGE: ModelSpec = "anthropic:claude-opus-5-5"
export const DEFAULT_GEMINI_JUDGE: ModelSpec = "gemini:gemini-3.5-pro"

export function parseModelSpec(spec: string): EvalModel {
  const index = spec.indexOf(":")
  const provider = spec.slice(0, index)
  const model = spec.slice(index + 1).trim()

  if (index <= 0 || !model || (provider !== "anthropic" && provider !== "gemini")) {
    throw new Error(`Invalid model spec "${spec}" (expected anthropic:<model> or gemini:<model>)`)
  }

  return { spec: `${provider}:${model}`, provider: provider as EvalProvider, model }
}

function list(value: string | undefined): ModelSpec[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  return items?.length ? items.map((item) => parseModelSpec(item).spec) : undefined
}

export function hasAnthropicKey(env: EvalEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim())
}

/** Candidates for a live run: explicit list, else Gemini (+ Claude with a key). */
export function resolveCandidates(env: EvalEnv, explicit?: string): ModelSpec[] {
  return (
    list(explicit) ??
    list(env.MEETSUM_EVAL_CANDIDATES) ?? [
      ...DEFAULT_GEMINI_CANDIDATES,
      ...(hasAnthropicKey(env) ? CLAUDE_CANDIDATES : []),
    ]
  )
}

/** Judges: explicit, else Opus with a Claude key, else a Gemini Pro judge. */
export function resolveJudges(env: EvalEnv, explicit?: string): ModelSpec[] {
  return (
    list(explicit) ??
    list(env.MEETSUM_EVAL_JUDGES) ?? [hasAnthropicKey(env) ? DEFAULT_CLAUDE_JUDGE : DEFAULT_GEMINI_JUDGE]
  )
}

/** USD per million tokens. */
export type ModelPrice = { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/** Claude list prices from docs/parity/m5.md A3 (Haiku ≤100k tier). */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

function positive(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Number(value)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Price table: Claude defaults, the configured Gemini summary model from
 * `GOOGLE_GEMINI_PRICE_*`, then `MEETSUM_LLM_PRICES_JSON` overrides. Gemini
 * models without a configured price stay unknown (cost null).
 */
export function evalPriceTable(env: EvalEnv): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = { ...DEFAULT_PRICES }
  const geminiInput = positive(env.GOOGLE_GEMINI_PRICE_INPUT_PER_MTOK)
  const geminiOutput = positive(env.GOOGLE_GEMINI_PRICE_OUTPUT_PER_MTOK)

  if (geminiInput !== undefined && geminiOutput !== undefined) {
    table[env.GOOGLE_GEMINI_SUMMARY_MODEL?.trim() || "gemini-3.5-flash"] = { input: geminiInput, output: geminiOutput }
  }

  if (env.MEETSUM_LLM_PRICES_JSON) {
    try {
      const overrides = JSON.parse(env.MEETSUM_LLM_PRICES_JSON) as Record<string, Partial<ModelPrice>>

      for (const [model, price] of Object.entries(overrides)) {
        if (typeof price?.input === "number" && typeof price?.output === "number") {
          table[model] = { ...price, input: price.input, output: price.output }
        }
      }
    } catch {
      // Invalid JSON: keep defaults (the app's pricing module reports it).
    }
  }

  return table
}

export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  table: Record<string, ModelPrice>
): number | null {
  const price = table[model]

  if (!price) return null

  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * (price.cacheRead ?? price.input) +
      usage.cacheWriteTokens * (price.cacheWrite ?? price.input)) /
    1_000_000
  )
}
