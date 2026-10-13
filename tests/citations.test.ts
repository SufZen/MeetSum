import { describe, expect, it } from "vitest"

import {
  normalizeForQuote,
  quoteMatchesSegment,
  resolveActionItemSource,
  resolveRefs,
} from "@/lib/intelligence/citations"
import { formatTranscriptForPrompt, formatTimestamp } from "@/lib/intelligence/transcript-format"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"

const segments: TranscriptSegment[] = [
  { id: "seg_b", speaker: "Speaker 2", speakerId: "spk2", startMs: 221_000, endMs: 230_000, text: "אני אשלח את הצעת המחיר עד יום ראשון." },
  { id: "seg_a", speaker: "Speaker 1", speakerId: "spk1", startMs: 5_000, endMs: 12_000, text: "סיכמנו להעביר את ה־API ל-Supabase." },
  { id: "seg_c", speaker: "Speaker 1", startMs: 3_725_000, endMs: 3_730_000, text: "  טוב,   נסגור כאן. " },
]

const speakers = [
  { id: "spk1", displayName: "דנה", label: "Speaker 1" },
  { id: "spk2", label: "Speaker 2" },
] as MeetingSpeaker[]

describe("transcript formatting", () => {
  const transcript = formatTranscriptForPrompt(segments, speakers)

  it("orders segments, assigns aliases and uses resolved speaker names", () => {
    expect(transcript.text.split("\n")).toEqual([
      "[s1 00:05 דנה] סיכמנו להעביר את ה־API ל-Supabase.",
      "[s2 03:41 Speaker 2] אני אשלח את הצעת המחיר עד יום ראשון.",
      "[s3 1:02:05 Speaker 1] טוב, נסגור כאן.",
    ])
    expect(transcript.aliasToSegment.get("s2")?.id).toBe("seg_b")
    expect(transcript.segmentToAlias.get("seg_c")).toBe("s3")
    expect(transcript.estimatedTokens).toBeGreaterThan(0)
  })

  it("formats timestamps", () => {
    expect(formatTimestamp(0)).toBe("00:00")
    expect(formatTimestamp(3_600_000)).toBe("1:00:00")
  })

  it("maps aliases to refs, dropping unknown aliases and duplicates", () => {
    expect(resolveRefs(["s2", "s99", "S1", "s2", "[s3]"], transcript)).toEqual([
      { segmentId: "seg_a", startMs: 5_000 },
      { segmentId: "seg_b", startMs: 221_000 },
      { segmentId: "seg_c", startMs: 3_725_000 },
    ])
  })

  it("normalizes quotes (niqqud, maqaf, gershayim, punctuation)", () => {
    expect(normalizeForQuote("הַ״API״ — ל־Supabase!")).toBe("הapi ל supabase")
    expect(quoteMatchesSegment("להעביר את ה-API", segments[1])).toBe(true)
    expect(quoteMatchesSegment("אשלח את הצעת המחיר", segments[0])).toBe(true)
  })

  it("drops a fabricated quote and keeps a verified one", () => {
    expect(resolveActionItemSource("s2", "אני אשלח את החוזה מחר", transcript)).toEqual({ quote: "" })
    expect(resolveActionItemSource("s2", "אשלח את הצעת המחיר", transcript)).toMatchObject({
      segment: { id: "seg_b" },
      quote: "אשלח את הצעת המחיר",
    })
    expect(resolveActionItemSource("s2", undefined, transcript).quote).toBe(segments[0].text)
    expect(resolveActionItemSource("s42", "x", transcript)).toEqual({ quote: "" })
  })
})
