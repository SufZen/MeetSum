import { describe, expect, it } from "vitest"

import { DEFAULT_PRICES, estimateCostUsd, getPriceTable } from "@/lib/ai/llm/pricing"

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
})

describe("LLM pricing", () => {
  it("has the M5 default prices (USD per MTok)", () => {
    expect(DEFAULT_PRICES["gemini-3.8-flash"]).toMatchObject({ input: 0.75, output: 3.75 })
    expect(DEFAULT_PRICES["gemini-3.5-flash-lite"]).toMatchObject({ input: 0.3, output: 2.5 })
    expect(DEFAULT_PRICES["claude-haiku-5-5"]).toMatchObject({ input: 0.1, output: 0.5 })
    expect(DEFAULT_PRICES["claude-sonnet-5-5"]).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 })
    expect(DEFAULT_PRICES["claude-opus-5-5"]).toMatchObject({ input: 4, output: 20 })
  })

  it("prices input, output, cache reads and 5m cache writes", () => {
    // 1M in * 2 + 0.1M out * 10 + 1M read * 0.2 + 1M write * 2.5
    expect(
      estimateCostUsd("claude-sonnet-5-5", usage(1_000_000, 100_000, 1_000_000, 1_000_000), { env: {} })
    ).toBeCloseTo(5.7, 6)
  })

  it("uses the 1h cache-write price when the TTL is 1h", () => {
    expect(
      estimateCostUsd("claude-sonnet-5-5", usage(0, 0, 0, 1_000_000), { cacheTtl: "1h", env: {} })
    ).toBeCloseTo(4, 6)
  })

  it("switches Haiku to the long-context tier above 100k prompt tokens (whole request)", () => {
    expect(estimateCostUsd("claude-haiku-5-5", usage(100_000, 10_000), { env: {} })).toBeCloseTo(
      (100_000 * 0.1 + 10_000 * 0.5) / 1e6,
      8
    )
    // 60k input + 50k cache read = 110k prompt -> every token at the >100k tier
    expect(estimateCostUsd("claude-haiku-5-5", usage(60_000, 10_000, 50_000), { env: {} })).toBeCloseTo(
      (60_000 * 0.5 + 10_000 * 2.5 + 50_000 * 0.05) / 1e6,
      8
    )
  })

  it("halves the cost for batch requests", () => {
    const full = estimateCostUsd("claude-opus-5-5", usage(10_000, 2_000), { env: {} })!
    const batch = estimateCostUsd("claude-opus-5-5", usage(10_000, 2_000), { batch: true, env: {} })!

    expect(batch).toBeCloseTo(full / 2, 8)
  })

  it("prices Gemini cache reads at the input rate when no discount is configured", () => {
    expect(estimateCostUsd("gemini-3.8-flash", usage(1_000_000, 0, 1_000_000), { env: {} })).toBeCloseTo(1.5, 6)
  })

  it("returns null for an unknown model", () => {
    expect(estimateCostUsd("gemini-3.5-flash", usage(1, 1), { env: {} })).toBeNull()
  })

  it("accepts overrides from MEETSUM_LLM_PRICES_JSON and the legacy Gemini env prices", () => {
    const env = {
      MEETSUM_LLM_PRICES_JSON: JSON.stringify({ "custom-model": { input: 1, output: 2 } }),
      GOOGLE_GEMINI_SUMMARY_MODEL: "gemini-x",
      GOOGLE_GEMINI_PRICE_INPUT_PER_MTOK: "0.5",
      GOOGLE_GEMINI_PRICE_OUTPUT_PER_MTOK: "1.5",
    }

    expect(getPriceTable(env)["custom-model"]).toEqual({ input: 1, output: 2 })
    expect(estimateCostUsd("gemini-x", usage(1_000_000, 1_000_000), { env })).toBeCloseTo(2, 6)
    expect(getPriceTable({ MEETSUM_LLM_PRICES_JSON: "{not json" })["claude-opus-5-5"]).toBeDefined()
  })
})
