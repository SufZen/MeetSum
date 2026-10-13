import { describe, expect, it } from "vitest"

import {
  calculateCharErrorRate,
  calculateWordErrorRate,
  latinTokenWer,
  normalizeTranscriptForWer,
  termRecall,
} from "@/lib/ai/asr-evaluation"

describe("ASR evaluation helpers", () => {
  it("normalizes Hebrew and mixed transcript text for WER comparison", () => {
    expect(normalizeTranscriptForWer(" שלום, RealizeOS!  17% ")).toEqual([
      "שלום",
      "realizeos",
      "17",
    ])
  })

  it("calculates word error rate from substitutions, insertions, and deletions", () => {
    expect(calculateWordErrorRate("שלום עולם חדש", "שלום עולם")).toMatchObject({
      substitutions: 0,
      insertions: 0,
      deletions: 1,
      referenceWords: 3,
      wer: 1 / 3,
    })
  })

  it("strips niqqud without splitting words", () => {
    expect(normalizeTranscriptForWer("שָׁלוֹם עוֹלָם")).toEqual(["שלום", "עולם"])
    expect(calculateWordErrorRate("שָׁלוֹם עוֹלָם", "שלום עולם").wer).toBe(0)
  })

  it("keeps words with geresh, gershayim and ASCII quotes whole", () => {
    expect(normalizeTranscriptForWer("ג׳מיני צה״ל ג'מיני צה\"ל")).toEqual([
      "גמיני",
      "צהל",
      "גמיני",
      "צהל",
    ])
    expect(calculateWordErrorRate("צה״ל", 'צה"ל').wer).toBe(0)
    expect(calculateWordErrorRate("ג׳מיני", "גמיני").wer).toBe(0)
  })

  it("splits on maqaf, hyphen and slash", () => {
    expect(normalizeTranscriptForWer("בית־ספר due-diligence 24/7")).toEqual([
      "בית",
      "ספר",
      "due",
      "diligence",
      "24",
      "7",
    ])
  })

  it("handles mixed Hebrew/English prefixes", () => {
    expect(normalizeTranscriptForWer("ב-Supabase, וה-API.")).toEqual([
      "ב",
      "supabase",
      "וה",
      "api",
    ])
    expect(calculateWordErrorRate("דיברנו על ב-Supabase", "דיברנו על ב Supabase").wer).toBe(0)
  })

  it("returns 1 for a hypothesis against an empty reference and 0 for both empty", () => {
    expect(calculateWordErrorRate("", "משהו").wer).toBe(1)
    expect(calculateWordErrorRate("", "").wer).toBe(0)
  })

  it("calculates character error rate on normalized text", () => {
    const result = calculateCharErrorRate("שלום", "שלומ")

    expect(result).toMatchObject({ substitutions: 1, referenceChars: 4 })
    expect(result.cer).toBeCloseTo(0.25)
    expect(calculateCharErrorRate("שָׁלוֹם עוֹלָם", "שלום עולם").cer).toBe(0)
    expect(calculateCharErrorRate("abc", "").cer).toBe(1)
  })

  it("measures glossary term recall from the reference occurrences", () => {
    const result = termRecall(
      "עבדנו עם Supabase ו-Claude Code, ושוב Supabase",
      "עבדנו עם סופרבייס ו-Claude Code, ושוב Supabase",
      ["Supabase", "Claude Code", "Gemini"]
    )

    expect(result).toEqual({ expected: 3, found: 2, recall: 2 / 3, terms: 2 })
  })

  it("returns null recall when no glossary term occurs in the reference", () => {
    expect(termRecall("שלום", "שלום", ["Supabase"])).toEqual({
      expected: 0,
      found: 0,
      recall: null,
      terms: 0,
    })
  })

  it("does not count extra hypothesis occurrences beyond the reference", () => {
    expect(termRecall("Supabase", "Supabase Supabase", ["Supabase"]).recall).toBe(1)
  })

  it("computes WER over Latin tokens only", () => {
    const result = latinTokenWer(
      "פתחנו Supabase project עם RealizeOS",
      "פתחנו סופרבייס project עם RealizeOS"
    )

    expect(result.referenceWords).toBe(3)
    expect(result.deletions + result.substitutions).toBe(1)
    expect(result.wer).toBeCloseTo(1 / 3)
  })
})
