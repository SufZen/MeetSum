import { describe, expect, it } from "vitest"

import { countFillers, ENGLISH_FILLERS, HEBREW_FILLERS } from "@/lib/analytics/fillers"
import { tokenize } from "@/lib/analytics/text"

const count = (text: string) => countFillers(tokenize(text))

describe("countFillers", () => {
  it("lists the documented Hebrew and English fillers", () => {
    expect(HEBREW_FILLERS).toEqual(
      expect.arrayContaining(["אה", "אממ", "כאילו", "בעצם", "יעני", "וואלה", "זאת אומרת", "איך אומרים", "כזה"])
    )
    expect(ENGLISH_FILLERS).toEqual(
      expect.arrayContaining(["um", "uh", "like", "you know", "basically", "actually", "i mean", "sort of", "kind of"])
    )
  })

  it.each([
    ["אה, אני חושבת שכאילו זה בסדר", 1],
    ["כאילו, זה בעצם מוכן", 2],
    ["זאת אומרת שצריך לבדוק", 1],
    ["זאתומרת", 1],
    ["איך אומרים, הלקוח לא מרוצה", 1],
    ["נו, יעני, סתם וואלה", 4],
    ["אממממ… אההה", 2],
    ["um so like you know we basically ship", 4],
    ["I mean it's kind of done, sort of", 3],
    ["Ummm, uhh", 2],
  ])("counts standalone fillers in %s", (text, expected) => {
    expect(count(text)).toBe(expected)
  })

  it("never counts a filler inside a longer word", () => {
    expect(count("שכאילו הכלכאילו")).toBe(0)
    expect(count("likely unlike actualize")).toBe(0)
    expect(count("אהבה נועם אמא")).toBe(0)
  })

  it("strips niqqud and punctuation before matching", () => {
    expect(count("בְּעֶצֶם!")).toBe(1)
    expect(count("(בעצם)")).toBe(1)
  })

  it("counts a multi-word filler once", () => {
    expect(count("you know")).toBe(1)
    expect(count("know you")).toBe(0)
  })
})
