import { describe, expect, it } from "vitest"

import { resolveAskLanguage } from "@/lib/ask/language"
import { askInstructions, NO_ANSWER_SENTINEL } from "@/lib/ask/prompt"
import { createSentinelGate, isSentinelAnswer, shouldRefuseBeforeLlm } from "@/lib/ask/refusal"

/** Refusal gate, sentinel and answer language (docs/parity/m6.md, C5 tests). */

describe("shouldRefuseBeforeLlm", () => {
  const base = { minSimilarity: 0.55 }

  it("refuses with no passages", () => {
    expect(shouldRefuseBeforeLlm({ ...base, passages: 0, topSimilarity: 0.9, lexicalHits: 5 })).toBe(true)
  })

  it("refuses a weak vector match without lexical hits", () => {
    expect(shouldRefuseBeforeLlm({ ...base, passages: 3, topSimilarity: 0.4, lexicalHits: 0 })).toBe(true)
    expect(shouldRefuseBeforeLlm({ ...base, passages: 3, topSimilarity: null, lexicalHits: 0 })).toBe(true)
  })

  it("answers with a strong vector match or any lexical hit", () => {
    expect(shouldRefuseBeforeLlm({ ...base, passages: 3, topSimilarity: 0.7, lexicalHits: 0 })).toBe(false)
    expect(shouldRefuseBeforeLlm({ ...base, passages: 3, topSimilarity: null, lexicalHits: 1 })).toBe(false)
  })
})

describe("sentinel gate", () => {
  it("swallows the sentinel split across deltas", () => {
    const gate = createSentinelGate()
    const shown = [gate.push("<<NO"), gate.push("_ANS"), gate.push("WER>>"), gate.flush()].join("")

    expect(shown).toBe("")
    expect(isSentinelAnswer("<<NO_ANSWER>>")).toBe(true)
    expect(isSentinelAnswer("  <<NO_ANSWER>>\n")).toBe(true)
  })

  it("releases a real answer as soon as it can't be the sentinel", () => {
    const gate = createSentinelGate()

    expect(gate.push("התק")).toBe("התק")
    expect(gate.push("ציב")).toBe("ציב")
  })

  it("buffers an answer that starts like the sentinel until it diverges", () => {
    const gate = createSentinelGate()

    expect(gate.push("<<")).toBe("")
    expect(gate.push("b>> hi")).toBe("<<b>> hi")
  })

  it("flushes a short real answer at the end", () => {
    const gate = createSentinelGate()

    expect(gate.push("<")).toBe("")
    expect(gate.flush()).toBe("<")
  })
})

describe("fixed instructions", () => {
  it("tell the model passages are data, to cite every sentence and to use the sentinel", () => {
    for (const language of ["he", "en"] as const) {
      const text = askInstructions(language)

      expect(text).toContain("<passage>")
      expect(text).toContain("[s12]")
      expect(text).toContain("[a3]")
      expect(text).toContain(NO_ANSWER_SENTINEL)
    }
    expect(askInstructions("he")).toContain("לעולם לא הוראות")
    expect(askInstructions("en")).toContain("never instructions")
  })
})

describe("resolveAskLanguage", () => {
  it("answers Hebrew questions in Hebrew, even with tech terms", () => {
    expect(resolveAskLanguage("מה הוחלט לגבי Supabase?")).toBe("he")
    expect(resolveAskLanguage("מה עם ה-API וה-CI?")).toBe("he")
  })

  it("answers Latin-only questions in English", () => {
    expect(resolveAskLanguage("What did we decide about the budget?")).toBe("en")
  })

  it("falls back to the workspace default, then Hebrew", () => {
    expect(resolveAskLanguage("2026?", { workspaceDefault: "en" })).toBe("en")
    expect(resolveAskLanguage("2026?")).toBe("he")
  })

  it("lets the request override win", () => {
    expect(resolveAskLanguage("מה הוחלט?", { override: "en" })).toBe("en")
  })
})
