import { describe, expect, it } from "vitest"

import {
  calculateWordErrorRate,
  normalizeTranscriptForWer,
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
})
