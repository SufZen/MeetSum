import { describe, expect, it } from "vitest"

import {
  computeDer,
  detectTurnsFormat,
  hungarian,
  parseAudacityLabels,
  parseJsonTurns,
  parseRttm,
  parseTurns,
  type SpeakerTurn,
} from "@/lib/ai/asr-eval/der"

const turn = (speaker: string, startMs: number, endMs: number): SpeakerTurn => ({
  speaker,
  startMs,
  endMs,
})

const reference = [turn("A", 0, 10_000), turn("B", 10_000, 20_000)]

describe("computeDer", () => {
  it("is 0 for a perfect hypothesis regardless of speaker names", () => {
    const result = computeDer(reference, [turn("x", 0, 10_000), turn("y", 10_000, 20_000)], {
      collarMs: 0,
    })

    expect(result).toEqual({
      der: 0,
      missMs: 0,
      falseAlarmMs: 0,
      confusionMs: 0,
      refSpeechMs: 20_000,
      refSpeakers: 2,
      hypSpeakers: 2,
    })
  })

  it("counts missed speech", () => {
    const result = computeDer(reference, [turn("x", 0, 10_000)], { collarMs: 0 })

    expect(result.missMs).toBe(10_000)
    expect(result.der).toBeCloseTo(0.5)
  })

  it("counts false alarms outside reference speech", () => {
    const result = computeDer(
      [turn("A", 0, 10_000)],
      [turn("x", 0, 10_000), turn("x", 15_000, 20_000)],
      { collarMs: 0 }
    )

    expect(result.falseAlarmMs).toBe(5_000)
    expect(result.der).toBeCloseTo(0.5)
  })

  it("counts confusion when one hypothesis speaker covers two reference speakers", () => {
    const result = computeDer(reference, [turn("x", 0, 20_000)], { collarMs: 0 })

    expect(result.confusionMs).toBe(10_000)
    expect(result.missMs).toBe(0)
    expect(result.der).toBeCloseTo(0.5)
  })

  it("uses the optimal mapping rather than first match", () => {
    const result = computeDer(
      [turn("A", 0, 3_000), turn("B", 3_000, 10_000)],
      [turn("x", 0, 10_000), turn("y", 0, 3_000)],
      { collarMs: 0 }
    )

    // Best mapping B→x (7 s), A→y (3 s): only the 3 s x false alarm remains.
    expect(result.confusionMs).toBe(0)
    expect(result.falseAlarmMs).toBe(3_000)
  })

  it("counts overlapped reference speech once per speaker", () => {
    const result = computeDer(
      [turn("A", 0, 10_000), turn("B", 5_000, 10_000)],
      [turn("x", 0, 10_000)],
      { collarMs: 0 }
    )

    expect(result.refSpeechMs).toBe(15_000)
    expect(result.missMs).toBe(5_000)
    expect(result.der).toBeCloseTo(5 / 15)
  })

  it("excludes the collar around reference boundaries", () => {
    const shifted = [turn("x", 0, 10_200), turn("y", 10_200, 20_000)]

    expect(computeDer(reference, shifted, { collarMs: 0 }).confusionMs).toBe(200)
    expect(computeDer(reference, shifted, { collarMs: 250 }).der).toBe(0)
  })

  it("defaults to a 250 ms collar", () => {
    const shifted = [turn("x", 0, 10_200), turn("y", 10_200, 20_000)]

    expect(computeDer(reference, shifted).der).toBe(0)
  })

  it("handles an empty reference", () => {
    expect(computeDer([], []).der).toBe(0)
    expect(computeDer([], [turn("x", 0, 1_000)]).der).toBe(1)
  })
})

describe("hungarian", () => {
  it("finds the minimum-cost assignment", () => {
    expect(
      hungarian([
        [4, 1, 3],
        [2, 0, 5],
        [3, 2, 2],
      ])
    ).toEqual([1, 0, 2])
  })
})

describe("turn parsers", () => {
  it("parses RTTM", () => {
    const text = [
      ";; comment",
      "SPEAKER clip1 1 0.000 2.500 <NA> <NA> dana <NA> <NA>",
      "SPEAKER clip1 1 2.500 1.250 <NA> <NA> avi <NA> <NA>",
    ].join("\n")

    expect(parseRttm(text)).toEqual([turn("dana", 0, 2_500), turn("avi", 2_500, 3_750)])
  })

  it("parses Audacity labels", () => {
    expect(parseAudacityLabels("0.0\t1.5\tDana Cohen\n1.5\t3\tAvi\n")).toEqual([
      turn("Dana Cohen", 0, 1_500),
      turn("Avi", 1_500, 3_000),
    ])
  })

  it("parses JSON arrays, {turns} and ASR {segments}", () => {
    expect(parseJsonTurns([{ speaker: "A", start: 0, end: 1.5 }])).toEqual([turn("A", 0, 1_500)])
    expect(parseJsonTurns({ turns: [{ speaker: "A", startMs: 10, endMs: 20 }] })).toEqual([
      turn("A", 10, 20),
    ])
    expect(
      parseJsonTurns({ segments: [{ speaker: "Speaker 1", startMs: 0, endMs: 5, text: "x" }] })
    ).toEqual([turn("Speaker 1", 0, 5)])
  })

  it("rejects malformed input", () => {
    expect(() => parseJsonTurns({})).toThrow(/expected an array/)
    expect(() => parseJsonTurns([{ start: 0, end: 1 }])).toThrow(/speaker is required/)
    expect(() => parseRttm("SPEAKER x 1 abc 1 <NA> <NA> a")).toThrow(/Invalid time/)
  })

  it("detects the format from the filename or content", () => {
    expect(detectTurnsFormat("a.rttm", "")).toBe("rttm")
    expect(detectTurnsFormat("a.json", "")).toBe("json")
    expect(detectTurnsFormat("a.txt", "0\t1\tA")).toBe("audacity")
    expect(detectTurnsFormat("a.txt", "SPEAKER a 1 0 1 <NA> <NA> A")).toBe("rttm")
    expect(detectTurnsFormat("turns", "[]")).toBe("json")
    expect(parseTurns("[]", "json")).toEqual([])
  })
})
