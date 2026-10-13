import { describe, expect, it } from "vitest"

import {
  CLAUDE_CANDIDATES,
  DEFAULT_CLAUDE_JUDGE,
  DEFAULT_GEMINI_CANDIDATES,
  DEFAULT_GEMINI_JUDGE,
  estimateCostUsd,
  evalPriceTable,
  parseModelSpec,
  resolveCandidates,
  resolveJudges,
} from "@/lib/ai/llm-eval/candidates"
import {
  combineVerdicts,
  decideRoute,
  matchActionItems,
  percentile,
  tally,
  titleOverlap,
  wilsonInterval,
  winRate,
} from "@/lib/ai/llm-eval/metrics"

const env = (values: Record<string, string> = {}) => values

describe("wilsonInterval", () => {
  it("matches reference values", () => {
    const interval = wilsonInterval(8, 10)

    expect(interval.low).toBeCloseTo(0.4902, 3)
    expect(interval.high).toBeCloseTo(0.9433, 3)
    expect(wilsonInterval(0, 10).low).toBe(0)
    expect(wilsonInterval(10, 10).high).toBe(1)
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 })
  })
})

describe("matchActionItems", () => {
  const reference = [
    { title: "להכין טיוטת term sheet", owner: "מיכל", dueOn: "2026-10-20" },
    { title: "לקבוע פגישת המשך", owner: "דנה כהן", dueOn: "2026-10-29" },
    { title: "Update the customers about the date", owner: "Sarah" },
  ]

  it("matches by title-token overlap with Hebrew prefixes peeled", () => {
    expect(titleOverlap("הכנת טיוטת ה-term sheet", "להכין טיוטת term sheet")).toBeGreaterThanOrEqual(0.5)
    expect(titleOverlap("לשלוח חשבונית", "לקבוע פגישת המשך")).toBe(0)
  })

  it("computes recall, precision, owner and due accuracy one-to-one", () => {
    const match = matchActionItems(
      [
        { title: "טיוטת term sheet", owner: "מיכל", dueOn: "2026-10-20" },
        { title: "קביעת פגישת המשך", owner: "דנה", dueOn: "2026-10-30" },
        { title: "פגישת המשך נוספת" },
        { title: "משהו אחר לגמרי" },
      ],
      reference
    )

    expect(match).toMatchObject({
      predicted: 4,
      reference: 3,
      matched: 2,
      ownerExpected: 2,
      ownerMatched: 2,
      dueExpected: 2,
      dueMatched: 1,
    })
    expect(match.recall).toBeCloseTo(2 / 3)
    expect(match.precision).toBe(0.5)
  })

  it("handles empty lists", () => {
    expect(matchActionItems([], [])).toMatchObject({ recall: 1, precision: 1 })
    expect(matchActionItems([], reference)).toMatchObject({ recall: 0 })
  })
})

describe("pairwise verdicts", () => {
  const C = "gemini:a"
  const B = "gemini:b"

  it("counts a consistent winner and turns inconsistent orders into ties", () => {
    expect(combineVerdicts("A", "B", C, B)).toBe(C)
    expect(combineVerdicts("B", "A", C, B)).toBe(B)
    expect(combineVerdicts("A", "A", C, B)).toBe("tie")
    expect(combineVerdicts("tie", "tie", C, B)).toBe("tie")
    expect(combineVerdicts("A", "tie", C, B)).toBe("tie")
    expect(combineVerdicts("A", undefined, C, B)).toBeUndefined()
  })

  it("scores ties as half a win", () => {
    const counts = tally([C, C, "tie", B], C)

    expect(counts).toEqual({ wins: 2, ties: 1, losses: 1 })
    expect(winRate(counts).rate).toBeCloseTo(2.5 / 4)
  })
})

describe("decideRoute", () => {
  const base = {
    challenger: "gemini:a",
    baseline: "gemini:b",
    quality: { wins: 30, ties: 4, losses: 6 },
    recallChallenger: 0.82,
    recallBaseline: 0.84,
    costChallenger: 0.03,
    costBaseline: 0.012,
  }

  it("adopts when quality, recall and cost all pass", () => {
    expect(decideRoute(base).outcome).toBe("adopt")
  })

  it("keeps the baseline when a criterion fails", () => {
    expect(decideRoute({ ...base, quality: { wins: 10, ties: 0, losses: 10 } }).outcome).toBe("keep_baseline")
    expect(decideRoute({ ...base, recallChallenger: 0.7 }).outcome).toBe("keep_baseline")
    expect(decideRoute({ ...base, costChallenger: 0.05 }).outcome).toBe("keep_baseline")
  })

  it("reports insufficient data when cost or verdicts are missing", () => {
    expect(decideRoute({ ...base, costChallenger: null }).outcome).toBe("insufficient_data")
    expect(decideRoute({ ...base, quality: { wins: 0, ties: 0, losses: 0 } }).outcome).toBe("insufficient_data")
  })
})

describe("candidates, judges and prices", () => {
  it("defaults to Gemini models and adds Claude only with a key", () => {
    expect(resolveCandidates(env())).toEqual(DEFAULT_GEMINI_CANDIDATES)
    expect(DEFAULT_GEMINI_CANDIDATES).toEqual(["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite"])
    expect(resolveCandidates(env({ ANTHROPIC_API_KEY: "k" }))).toEqual([...DEFAULT_GEMINI_CANDIDATES, ...CLAUDE_CANDIDATES])
    expect(resolveCandidates(env({ ANTHROPIC_API_KEY: "k" }), "gemini:x")).toEqual(["gemini:x"])
    expect(resolveJudges(env())).toEqual([DEFAULT_GEMINI_JUDGE])
    expect(resolveJudges(env({ ANTHROPIC_API_KEY: "k" }))).toEqual([DEFAULT_CLAUDE_JUDGE])
    expect(resolveJudges(env({ MEETSUM_EVAL_JUDGES: "anthropic:claude-opus-5-5,gemini:gemini-3.5-pro" }))).toHaveLength(2)
  })

  it("validates model specs", () => {
    expect(parseModelSpec("anthropic:claude-sonnet-5-5")).toEqual({
      spec: "anthropic:claude-sonnet-5-5",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    })
    expect(() => parseModelSpec("openai:gpt")).toThrow()
    expect(() => parseModelSpec("gemini:")).toThrow()
  })

  it("prices Claude by default and Gemini only when configured", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }

    expect(estimateCostUsd("claude-sonnet-5-5", usage, evalPriceTable(env()))).toBeCloseTo(3)
    expect(estimateCostUsd("gemini-3.8-flash", usage, evalPriceTable(env()))).toBeNull()
    const table = evalPriceTable(
      env({
        GOOGLE_GEMINI_PRICE_INPUT_PER_MTOK: "0.3",
        GOOGLE_GEMINI_PRICE_OUTPUT_PER_MTOK: "2.5",
        MEETSUM_LLM_PRICES_JSON: JSON.stringify({ "gemini-3.8-flash": { input: 0.5, output: 3 } }),
      })
    )

    expect(estimateCostUsd("gemini-3.5-flash", usage, table)).toBeCloseTo(0.55)
    expect(estimateCostUsd("gemini-3.8-flash", usage, table)).toBeCloseTo(0.8)
  })

  it("computes percentiles", () => {
    expect(percentile([5, 1, 3], 50)).toBe(3)
    expect(percentile([], 50)).toBeNull()
  })
})
