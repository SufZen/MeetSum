import { describe, expect, it } from "vitest"

import {
  detectTextLanguage,
  foldText,
  foldWithOffsets,
  hebrewPrefixVariants,
  MIN_STEM_LETTERS,
  normalizeForIndex,
  normalizeQuery,
  QUERY_STOPWORDS,
  tokenize,
} from "@/lib/search/hebrew-normalize"

const tokens = (text: string) => tokenize(foldText(text))

/** Every term a token contributes to the index: the raw token plus its variants. */
function indexTerms(text: string): Set<string> {
  const { norm, stems } = normalizeForIndex(text)

  return new Set([...norm.split(" "), ...stems.split(" ")].filter(Boolean))
}

/** A query matches indexed text when any query term (raw or variant) is an index term. */
function matches(query: string, text: string): boolean {
  const terms = indexTerms(text)

  return normalizeQuery(query).tokens.every((token) =>
    [token.raw, ...token.variants].some((term) => terms.has(term))
  )
}

describe("foldText", () => {
  it("strips niqqud and cantillation", () => {
    expect(foldText("תַּקְצִיב")).toBe("תקציב")
    expect(foldText("בְּרֵאשִׁ֖ית")).toBe("בראשית")
    expect(foldText("שָׂדֶה")).toBe("שדה")
  })

  it("folds final letters", () => {
    expect(foldText("ךםןףץ")).toBe("כמנפצ")
    expect(foldText("שלום")).toBe("שלומ")
  })

  it("removes geresh and gershayim inside or after Hebrew words", () => {
    expect(foldText("צה״ל")).toBe("צהל")
    expect(foldText('צה"ל')).toBe("צהל")
    expect(foldText('דו"ח')).toBe("דוח")
    expect(foldText("דו״ח")).toBe("דוח")
    expect(foldText("ג׳ירה")).toBe("גירה")
    expect(foldText("ג'ירה")).toBe("גירה")
    expect(foldText("ג’ירה")).toBe("גירה")
    expect(foldText('he said "ok"')).toBe('he said "ok"')
  })

  it("turns maqaf, paseq and sof pasuq into separators", () => {
    expect(foldText("בית־ספר")).toBe("בית ספר")
    expect(tokens("בית־ספר")).toEqual(["בית", "ספר"])
    expect(tokens("א׀ב׃ג")).toEqual(["א", "ב", "ג"].filter((t) => t !== "ב"))
  })

  it("lowercases Latin and drops thousands separators", () => {
    expect(foldText("Supabase API")).toBe("supabase api")
    expect(foldText("1,200 ₪")).toBe("1200 ₪")
    expect(foldText("1,200,000")).toBe("1200000")
    expect(foldText("1,2")).toBe("1,2")
  })

  it("keeps decimals and alphanumerics", () => {
    expect(tokens("3.5 Q3 v2")).toEqual(["3.5", "q3", "v2"])
  })

  it("drops a hyphen-attached prefix letter (ב-Supabase, ה-API)", () => {
    expect(tokens("עברנו ב-Supabase")).toEqual(["עברנו", "supabase"])
    expect(tokens("ה-API החדש")).toEqual(["api", "החדש"])
    expect(tokens("וב-2026")).toEqual(["2026"])
    expect(tokens("בית-ספר")).toEqual(["בית", "ספר"])
  })

  it("is idempotent", () => {
    for (const text of [
      "תַּקְצִיב ב-Supabase צה״ל 1,200 ₪ בית־ספר ג'ירה Q3",
      "ב-ב-X",
      "1,ב-200",
      "12,345,67",
      "שָׁלוֹם 👋 עולם",
    ]) {
      expect(foldText(foldText(text))).toBe(foldText(text))
    }
  })
})

describe("foldWithOffsets", () => {
  it("maps folded indices to the original text across niqqud", () => {
    const original = "תַּקְצִיב"
    const { folded, map } = foldWithOffsets(original)

    expect(folded).toBe("תקציב")
    expect(map).toHaveLength(folded.length)
    for (let index = 0; index < folded.length; index += 1) {
      const source = original[map[index]].replace(/[֑-ׇ]/g, "")
      const expected = folded[index] === "כ" ? "ך" : folded[index]

      expect([folded[index], expected]).toContain(source)
    }
  })

  it("maps across surrogate pairs", () => {
    const original = "😀 בתקציב"
    const { folded, map } = foldWithOffsets(original)

    expect(folded).toBe("😀 בתקציב")
    expect(map.slice(0, 3)).toEqual([0, 1, 2])
    expect(original.slice(map[3])).toBe("בתקציב")
  })

  it("maps removed characters away (gershayim, prefix hyphen)", () => {
    const original = "ב-Supabase צה״ל"
    const { folded, map } = foldWithOffsets(original)

    expect(folded).toBe("supabase צהל")
    expect(original[map[0]]).toBe("S")
    const tsadi = folded.indexOf("צ")

    expect(original.slice(map[tsadi], map[tsadi + 2] + 1)).toBe("צה״ל")
  })
})

describe("tokenize", () => {
  it("keeps short tokens", () => {
    expect(tokens("על דו כן AI Q3 1,200 ₪")).toEqual(["על", "דו", "כנ", "ai", "q3", "1200"])
  })

  it("drops only bare one-letter prefix letters", () => {
    expect(tokens("ו ה ב כ ל מ ש")).toEqual([])
    expect(tokens("א ת")).toEqual(["א", "ת"])
    expect(tokens("a I")).toEqual(["a", "i"])
  })

  it("handles mixed Hebrew and English", () => {
    expect(tokens("עדכנו את ה-README ב-GitHub")).toEqual(["עדכנו", "את", "readme", "github"])
  })
})

describe("hebrewPrefixVariants", () => {
  it("strips prefixes and chains, longest remainder first", () => {
    expect(hebrewPrefixVariants("בתקציב")).toEqual(["תקציב"])
    expect(hebrewPrefixVariants("והתקציב")).toEqual(["התקציב", "תקציב"])
    expect(hebrewPrefixVariants("לתקציב")).toEqual(["תקציב"])
    expect(hebrewPrefixVariants("שבתקציב")).toEqual(["בתקציב", "תקציב"])
    expect(hebrewPrefixVariants("כשהתקציב")).toEqual(["שהתקציב", "התקציב", "תקציב"])
    expect(hebrewPrefixVariants("מהתקציב")).toEqual(["התקציב", "תקציב"])
    expect(hebrewPrefixVariants("ושבתקציב")).toEqual(["שבתקציב", "בתקציב", "תקציב"])
  })

  it("never leaves fewer than MIN_STEM_LETTERS letters and skips short tokens", () => {
    expect(MIN_STEM_LETTERS).toBe(3)
    expect(hebrewPrefixVariants("הדו")).toEqual([])
    expect(hebrewPrefixVariants("בבית")).toEqual(["בית"])
    expect(hebrewPrefixVariants("והדו")).toEqual(["הדו"])
    expect(hebrewPrefixVariants("תקציב")).toEqual([])
    expect(hebrewPrefixVariants("budget")).toEqual([])
  })

  it("emits at most three variants", () => {
    expect(hebrewPrefixVariants("וכשהתקציבים").length).toBeLessThanOrEqual(3)
  })
})

describe("normalizeForIndex / normalizeQuery", () => {
  it("indexes raw tokens and prefix-stripped variants separately", () => {
    const { norm, stems } = normalizeForIndex("והתקציב של Q3")

    expect(norm).toBe("והתקציב של q3")
    expect(stems.split(" ")).toEqual(["התקציב", "תקציב"])
  })

  it("stems Latin words of five letters or more", () => {
    expect(normalizeForIndex("companies meetings budgets reviewed").stems.split(" ")).toEqual([
      "company",
      "meeting",
      "budget",
      "review",
    ])
    expect(normalizeForIndex("bus class").stems).toBe("")
  })

  it("matches תקציב against prefixed forms and the reverse", () => {
    for (const text of ["בתקציב", "והתקציב", "לתקציב", "שבתקציב", "כשהתקציב", "מהתקציב"]) {
      expect(matches("תקציב", text)).toBe(true)
    }
    expect(matches("בתקציב", "תקציב")).toBe(true)
    expect(matches("תקציב", "התכנון")).toBe(false)
  })

  it("matches across niqqud, gershayim, finals and hyphen prefixes", () => {
    expect(matches("תַּקְצִיב", "התקציב")).toBe(true)
    expect(matches("דוח", "הגשנו את הדו״ח")).toBe(true)
    expect(matches('צה"ל', "צה״ל")).toBe(true)
    expect(matches("שלום", "שלומ")).toBe(true)
    expect(matches("supabase", "עברנו ב-Supabase")).toBe(true)
    expect(matches("ספר", "בית־ספר")).toBe(true)
  })

  it("keeps short and numeric query tokens and marks stopwords without dropping them", () => {
    const query = normalizeQuery("על AI ב-Q3 1,200 ₪")

    expect(query.folded).toBe("על ai q3 1200 ₪")
    expect(query.tokens.map((token) => token.raw)).toEqual(["על", "ai", "q3", "1200"])
    expect(query.tokens.map((token) => token.stop)).toEqual([true, false, false, false])
    expect(query.tokens.map((token) => token.script)).toEqual(["he", "latin", "latin", "number"])
    expect(QUERY_STOPWORDS.has("של")).toBe(true)
    expect(QUERY_STOPWORDS.has("the")).toBe(true)
    expect(normalizeForIndex("על השולחן").norm).toBe("על השולחנ")
  })

  it("labels mixed-script tokens", () => {
    expect(normalizeQuery("3.5").tokens[0].script).toBe("number")
    expect(normalizeQuery("APIב").tokens[0].script).toBe("mixed")
  })
})

describe("detectTextLanguage", () => {
  it("uses the Hebrew letter share", () => {
    expect(detectTextLanguage("דנה: התקציב של הרבעון")).toBe("he")
    expect(detectTextLanguage("We moved to Supabase")).toBe("en")
    expect(detectTextLanguage("עברנו ל-Supabase and Postgres")).toBe("mixed")
    expect(detectTextLanguage("1200")).toBe("en")
  })
})
