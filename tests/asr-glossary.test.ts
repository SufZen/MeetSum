import { describe, expect, it } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import {
  applyGlossaryToWords,
  buildHotwords,
  buildInitialPrompt,
  hotwordTerms,
  mergeGlossary,
  normalizeGlossaryToken,
} from "@/lib/ai/asr/glossary"
import type { AsrGlossary, AsrWord } from "@/lib/ai/asr/types"

function words(...items: Array<[string, number, number, number?]>): AsrWord[] {
  return items.map(([text, startMs, endMs, confidence]) => ({
    text,
    startMs,
    endMs,
    ...(confidence !== undefined ? { confidence } : {}),
    speaker: "Speaker 1",
  }))
}

describe("mergeGlossary", () => {
  it("unions aliases and lets later glossaries override flags", () => {
    const merged = mergeGlossary(DEFAULT_ASR_GLOSSARY, {
      version: 1,
      terms: [
        { term: "supabase", aliases: ["סופא בייס"], hotword: false },
        { term: "Realization", aliases: ["ריאליזיישן"], hotword: true },
      ],
    })
    const supabase = merged.terms.find((term) => term.term.toLowerCase() === "supabase")

    expect(supabase?.hotword).toBe(false)
    expect(supabase?.aliases).toEqual(expect.arrayContaining(["סופרבייס", "סופבייס", "סופא בייס"]))
    expect(merged.terms.map((term) => term.term)).toContain("Realization")
    // Inputs are not mutated.
    expect(DEFAULT_ASR_GLOSSARY.terms[0].hotword).toBe(true)
  })
})

describe("hotwords", () => {
  const glossary: AsrGlossary = {
    version: 1,
    terms: [
      { term: "דנה", aliases: [], hotword: true },
      { term: "Supabase", aliases: [], hotword: true },
      { term: "supabase", aliases: [], hotword: true },
      { term: "Gemini", aliases: [], hotword: true },
      { term: "Hidden", aliases: [], hotword: false },
    ],
  }

  it("puts Latin terms first, dedups case-insensitively and skips non-hotwords", () => {
    expect(hotwordTerms(glossary)).toEqual(["Supabase", "Gemini", "דנה"])
    expect(buildHotwords(glossary)).toBe("Supabase, Gemini, דנה")
  })

  it("truncates to whole terms within maxChars", () => {
    expect(buildHotwords(glossary, { maxChars: 18 })).toBe("Supabase, Gemini")
    expect(buildHotwords(glossary, { maxChars: 5 })).toBe("")
  })

  it("builds the Hebrew initial prompt only when enabled", () => {
    expect(buildInitialPrompt(glossary, {})).toBeUndefined()
    expect(buildInitialPrompt(glossary, { MEETSUM_ASR_USE_INITIAL_PROMPT: "true" })).toBe(
      "בפגישה הוזכרו: Supabase, Gemini, דנה."
    )
  })
})

describe("applyGlossaryToWords", () => {
  it("rewrites an attached Hebrew prefix as ב-Term and keeps the word timing", () => {
    const input = words(["עוברים", 0, 400, 0.9], ["בסופבייס", 400, 1300, 0.71], ["השבוע", 1300, 1800, 0.95])
    const { words: output, replacements } = applyGlossaryToWords(input, DEFAULT_ASR_GLOSSARY)

    expect(replacements).toBe(1)
    expect(output.map((word) => word.text)).toEqual(["עוברים", "ב-Supabase", "השבוע"])
    expect(output[1]).toMatchObject({ startMs: 400, endMs: 1300, confidence: 0.71, speaker: "Speaker 1" })
  })

  it("never touches דוגמה or מגמה (short alias גמה is a strict whole word)", () => {
    const input = words(["זו", 0, 100], ["דוגמה", 100, 500], ["של", 500, 600], ["מגמה", 600, 900], ["וגמה", 900, 1000])
    const { words: output, replacements } = applyGlossaryToWords(input, DEFAULT_ASR_GLOSSARY)

    expect(replacements).toBe(0)
    expect(output.map((word) => word.text)).toEqual(["זו", "דוגמה", "של", "מגמה", "וגמה"])
  })

  it("still replaces the short alias as a whole word", () => {
    const { words: output } = applyGlossaryToWords(words(["מודל", 0, 300], ["גמה", 300, 600]), DEFAULT_ASR_GLOSSARY)

    expect(output.map((word) => word.text)).toEqual(["מודל", "Gemma"])
  })

  it("merges multi-word matches: first start, last end, minimum confidence", () => {
    const input = words(["עם", 0, 200, 0.99], ["קלוד", 200, 700, 0.81], ["קוד.", 700, 1300, 0.77], ["אחר", 1400, 1700, 0.9])
    const { words: output, replacements } = applyGlossaryToWords(input, DEFAULT_ASR_GLOSSARY)

    expect(replacements).toBe(1)
    expect(output.map((word) => word.text)).toEqual(["עם", "Claude Code.", "אחר"])
    expect(output[1]).toMatchObject({ startMs: 200, endMs: 1300, confidence: 0.77 })
  })

  it("does not merge across punctuation inside the span", () => {
    const { words: output } = applyGlossaryToWords(words(["קלוד,", 0, 300], ["קוד", 300, 600]), DEFAULT_ASR_GLOSSARY)

    expect(output.map((word) => word.text)).toEqual(["קלוד,", "קוד"])
  })

  it("keeps edge punctuation, ignores niqqud and unifies geresh", () => {
    const input = words(["(סופבייס,", 0, 300], ["גֶ׳מִינִי", 300, 600], ["ג'מיני?", 600, 900])
    const { words: output } = applyGlossaryToWords(input, DEFAULT_ASR_GLOSSARY)

    expect(output.map((word) => word.text)).toEqual(["(Supabase,", "Gemini", "Gemini?"])
  })

  it("re-cases Latin terms and counts only real changes", () => {
    const { words: output, replacements } = applyGlossaryToWords(
      words(["supabase", 0, 300], ["Supabase", 300, 600], ["vscode", 600, 900]),
      DEFAULT_ASR_GLOSSARY
    )

    expect(output.map((word) => word.text)).toEqual(["Supabase", "Supabase", "VSCode"])
    expect(replacements).toBe(2)
  })

  it("does no fuzzy matching", () => {
    const { words: output } = applyGlossaryToWords(
      words(["סופרבייסים", 0, 300], ["סופרביס", 300, 600], ["בסופרבייסים", 600, 900]),
      DEFAULT_ASR_GLOSSARY
    )

    expect(output.map((word) => word.text)).toEqual(["סופרבייסים", "סופרביס", "בסופרבייסים"])
  })

  it("supports stacked prefixes and a maqaf already present", () => {
    const { words: output } = applyGlossaryToWords(
      words(["וכשסופרבייס", 0, 300], ["ב-סופבייס", 300, 600]),
      DEFAULT_ASR_GLOSSARY
    )

    expect(output.map((word) => word.text)).toEqual(["וכש-Supabase", "ב-Supabase"])
  })

  it("honors caseSensitive terms", () => {
    const glossary: AsrGlossary = {
      version: 1,
      terms: [{ term: "ACME", aliases: ["Acme Corp"], hotword: true, caseSensitive: true }],
    }
    const { words: output } = applyGlossaryToWords(
      words(["acme", 0, 100], ["corp", 100, 200], ["Acme", 200, 300], ["Corp", 300, 400]),
      glossary
    )

    expect(output.map((word) => word.text)).toEqual(["acme", "corp", "ACME"])
  })

  it("normalizes tokens for matching", () => {
    expect(normalizeGlossaryToken("  \"שָׁלוֹם\", ")).toBe("שלום")
    expect(normalizeGlossaryToken("ג׳מיני")).toBe("ג'מיני")
    expect(normalizeGlossaryToken("SupaBase!")).toBe("supabase")
  })
})
