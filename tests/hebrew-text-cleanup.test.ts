import { describe, expect, it } from "vitest"

import {
  cleanupTranscriptSegments,
  generateAutoTags,
  termRegex,
} from "@/lib/intelligence"
import type { TranscriptSegment } from "@/lib/meetings/repository"

let counter = 0

function seg(
  text: string,
  options: { speaker?: string; startMs?: number; endMs?: number } = {}
): TranscriptSegment {
  counter += 1
  const startMs = options.startMs ?? counter * 10_000
  return {
    id: `seg_${counter}`,
    speaker: options.speaker ?? "Ran",
    startMs,
    endMs: options.endMs ?? startMs + 1000,
    text,
  }
}

function clean(text: string) {
  return cleanupTranscriptSegments([seg(text)]).map((segment) => segment.text)[0]
}

describe("termRegex (Unicode word boundaries)", () => {
  const gemma = termRegex("גמה")

  it("matches a standalone Hebrew term", () => {
    expect(gemma.test("גמה")).toBe(true)
    expect(gemma.test("המודל גמה, החדש")).toBe(true)
    expect(gemma.test("(גמה)")).toBe(true)
  })

  it.each(["דוגמה", "מגמה", "דוגמא", "בגמה", "גמהּ", "גמות"])(
    "does not match inside %s",
    (word) => {
      expect(gemma.test(word)).toBe(false)
    }
  )

  it("does not match English substrings", () => {
    const api = termRegex("api", { ignoreCase: true })
    expect(api.test("rapid growth")).toBe(false)
    expect(api.test("the API works")).toBe(true)
  })

  it("is stable across repeated .test calls (non-global by default)", () => {
    const pattern = termRegex("שומעים אותי")
    const results = Array.from({ length: 4 }, () => pattern.test("שומעים אותי?"))
    expect(results).toEqual([true, true, true, true])
    expect(pattern.global).toBe(false)
    expect(pattern.unicode).toBe(true)
  })

  it("captures attached Hebrew prefixes when allowed", () => {
    const supabase = termRegex("סופרבייס", { allowHebrewPrefix: true })
    expect("בסופרבייס".match(supabase)?.groups?.prefix).toBe("ב")
    expect("וכשסופרבייס".match(supabase)?.groups?.prefix).toBe("וכש")
    expect("סופרבייס".match(supabase)?.groups?.prefix).toBeUndefined()
    expect(supabase.test("אבסופרבייס")).toBe(false)
  })
})

describe("technical term replacement", () => {
  it.each([
    ["סופרבייס", "Supabase"],
    ["בסופרבייס", "ב-Supabase"],
    ["ב-סופרבייס", "ב-Supabase"],
    ["הסופרבייס", "ה-Supabase"],
    ["וכשסופרבייס עלה", "וכש-Supabase עלה"],
    ["ג'מיני", "Gemini"],
    ["ג׳מיני", "Gemini"],
    ["לג'מיני", "ל-Gemini"],
    ["גמיני ו-Gemma", "Gemini ו-Gemma"],
    ["בקלוד קוד", "ב-Claude Code"],
    ["רילייזאוס", "RealizeOS"],
    ["לרילייז אוס", "ל-RealizeOS"],
    ["בויסקוד", "ב-VSCode"],
    ["ויסקוד", "VSCode"],
    ["אם סי פי", "MCP"],
    ["גמה", "Gemma"],
    ["המודל גמה.", "המודל Gemma."],
  ])("%s → %s", (input, expected) => {
    expect(clean(`צריך לבדוק ${input}`)).toBe(`צריך לבדוק ${expected}`)
  })

  it.each([
    "דוגמה טובה",
    "מגמה עולה",
    "דוגמא נוספת",
    "בגמה הזאת",
    "ואם סי פי",
    "סופרבייסים",
    "אבסופרבייס",
  ])("leaves %s untouched", (input) => {
    expect(clean(`יש לנו ${input} כאן`)).toBe(`יש לנו ${input} כאן`)
  })

  it("keeps numbers, dates and percentages next to replaced terms", () => {
    expect(clean("לבדוק בסופרבייס ב-23/04 עם 17% ו-37.27.182.247")).toBe(
      "לבדוק ב-Supabase ב-23/04 עם 17% ו-37.27.182.247"
    )
  })
})

describe("filler handling", () => {
  it("drops a segment that is only filler", () => {
    expect(
      cleanupTranscriptSegments([
        seg("שומעים אותי? שומעים אותי?"),
        seg("Can you hear me?"),
        seg("can you hear me? yes"),
        seg("לא שומעים"),
      ])
    ).toEqual([])
  })

  it("keeps a segment with real content around the filler, unmodified", () => {
    const text = "שומעים אותי? אז נתחיל עם התקציב"
    expect(clean(text)).toBe(text)
    expect(clean("Can you hear me now, everyone?")).toBe(
      "Can you hear me now, everyone?"
    )
  })

  it("drops consecutive filler segments consistently (no lastIndex drift)", () => {
    const fillers = Array.from({ length: 5 }, () => seg("שומעים אותי?"))
    expect(cleanupTranscriptSegments(fillers)).toEqual([])
    expect(cleanupTranscriptSegments(fillers)).toEqual([])
  })

  it("keeps short answers that contain no filler", () => {
    expect(clean("כן.")).toBe("כן.")
    expect(clean("OK")).toBe("OK")
  })
})

describe("duplicate (echo) removal", () => {
  it("drops an identical segment from the same speaker within 2 s", () => {
    const result = cleanupTranscriptSegments([
      seg("צריך לשלוח את הסיכום", { startMs: 0, endMs: 2000 }),
      seg("צריך לשלוח את הסיכום", { startMs: 4000, endMs: 6000 }),
    ])
    expect(result).toHaveLength(1)
  })

  it("keeps the repeat when the gap is longer than 2 s", () => {
    const result = cleanupTranscriptSegments([
      seg("צריך לשלוח את הסיכום", { startMs: 0, endMs: 2000 }),
      seg("צריך לשלוח את הסיכום", { startMs: 4500, endMs: 6000 }),
    ])
    expect(result).toHaveLength(2)
  })

  it("keeps the same sentence from a different speaker", () => {
    const result = cleanupTranscriptSegments([
      seg("מסכים", { speaker: "Ran", startMs: 0, endMs: 500 }),
      seg("מסכים", { speaker: "Maya", startMs: 600, endMs: 900 }),
    ])
    expect(result).toHaveLength(2)
  })

  it("keeps a non-adjacent repetition", () => {
    const result = cleanupTranscriptSegments([
      seg("נעבור לנושא הבא", { startMs: 0, endMs: 1000 }),
      seg("מה עם התקציב", { startMs: 1100, endMs: 2000 }),
      seg("נעבור לנושא הבא", { startMs: 2100, endMs: 3000 }),
    ])
    expect(result).toHaveLength(3)
  })

  it("compares against the previous kept segment, skipping dropped fillers", () => {
    const result = cleanupTranscriptSegments([
      seg("בסופרבייס", { startMs: 0, endMs: 1000 }),
      seg("שומעים אותי?", { startMs: 1100, endMs: 1500 }),
      seg("ב-Supabase", { startMs: 1600, endMs: 2500 }),
    ])
    expect(result.map((segment) => segment.text)).toEqual(["ב-Supabase"])
  })
})

describe("word-bounded auto tags", () => {
  function tagsFor(text: string) {
    return generateAutoTags([seg(text)])
  }

  it("does not tag substrings", () => {
    expect(tagsFor("The bus stops at rapid intervals near the shops")).not.toEqual(
      expect.arrayContaining(["operations"])
    )
    expect(tagsFor("The bus stops at rapid intervals near the shops")).not.toContain(
      "technical"
    )
    expect(tagsFor("We discussed the clientele downtown")).not.toContain("sales")
  })

  it("tags whole English words and plurals", () => {
    expect(tagsFor("Our ops team reviewed the APIs")).toEqual(
      expect.arrayContaining(["operations", "technical"])
    )
    expect(tagsFor("Please send the follow-up and the invoices")).toEqual(
      expect.arrayContaining(["follow-up-needed", "finance"])
    )
  })

  it("tags Hebrew words with attached prefixes and inflections", () => {
    expect(tagsFor("נדבר עם הלקוחות על התקציב")).toEqual(
      expect.arrayContaining(["sales", "finance", "hebrew"])
    )
    expect(tagsFor('עסקת נדל"ן חדשה')).toContain("real-estate")
    expect(tagsFor("זה דחוף, צריך לשלוח היום")).toEqual(
      expect.arrayContaining(["urgent", "follow-up-needed"])
    )
  })

  it("tags transliterated technical terms after cleanup", () => {
    const cleaned = cleanupTranscriptSegments([seg("נבדוק את זה בסופרבייס ובגמיני")])
    expect(generateAutoTags(cleaned)).toContain("technical")
  })

  it("does not tag Gemma inside ordinary Hebrew words", () => {
    const cleaned = cleanupTranscriptSegments([seg("זו דוגמה למגמה ברורה")])
    expect(cleaned[0].text).toBe("זו דוגמה למגמה ברורה")
    expect(generateAutoTags(cleaned)).not.toContain("technical")
  })
})
