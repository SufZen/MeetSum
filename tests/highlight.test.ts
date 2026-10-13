import { describe, expect, it } from "vitest"

import { dirForLanguage, highlightParts, normalizeRanges, strongDirection } from "@/lib/client/highlight"

describe("highlightParts", () => {
  it("marks the surface word of a Hebrew prefix match", () => {
    const text = "דנה: והתקציב עלה"

    expect(highlightParts(text, [[5, 12]], "rtl")).toEqual([
      { text: "דנה: ", mark: false, isolate: false, dir: "rtl" },
      { text: "והתקציב", mark: true, isolate: false, dir: "rtl" },
      { text: " עלה", mark: false, isolate: false, dir: "rtl" },
    ])
  })

  it("isolates an LTR mark inside an RTL container (and the reverse)", () => {
    const he = "המעבר ל-Supabase הושלם"
    const start = he.indexOf("Supabase")
    const parts = highlightParts(he, [[start, start + 8]], "rtl")

    expect(parts.find((part) => part.mark)).toEqual({ text: "Supabase", mark: true, isolate: true, dir: "ltr" })

    const en = "We moved the תקציב forward"
    const enStart = en.indexOf("תקציב")

    expect(highlightParts(en, [[enStart, enStart + 5]], "ltr").find((part) => part.mark)?.isolate).toBe(true)
  })

  it("isolates every strong mark in an auto container, never a neutral one", () => {
    const parts = highlightParts("Q3 1200", [[0, 2], [3, 7]], "auto")

    expect(parts.filter((part) => part.mark).map((part) => part.isolate)).toEqual([true, false])
  })

  it("merges overlapping, touching and unsorted ranges", () => {
    expect(normalizeRanges("abcdefghij", [[6, 8], [0, 3], [2, 5], [5, 6]])).toEqual([[0, 8]])
  })

  it("clamps and drops invalid ranges", () => {
    expect(normalizeRanges("abc", [[-5, 1], [2, 99], [2, 2], [3, 1], [Number.NaN, 2]])).toEqual([
      [0, 1],
      [2, 3],
    ])
  })

  it("never splits a surrogate pair", () => {
    const text = "a😀b"

    // 😀 is two UTF-16 units at 1..3; a range ending or starting inside it widens.
    expect(normalizeRanges(text, [[0, 2]])).toEqual([[0, 3]])
    expect(normalizeRanges(text, [[2, 4]])).toEqual([[1, 4]])

    const parts = highlightParts(text, [[2, 3]], "ltr")

    expect(parts.map((part) => part.text)).toEqual(["a", "😀", "b"])
    expect(parts.map((part) => part.text).join("")).toBe(text)
  })

  it("keeps HTML in snippets as inert text", () => {
    const text = 'x <img src=x onerror="alert(1)"> y'
    const parts = highlightParts(text, [[2, 6]], "ltr")

    expect(parts.map((part) => part.text).join("")).toBe(text)
    expect(parts[1]).toMatchObject({ text: "<img", mark: true })
  })

  it("returns the whole text as one part with no ranges", () => {
    expect(highlightParts("שלום", [], "rtl")).toEqual([{ text: "שלום", mark: false, isolate: false, dir: "rtl" }])
    expect(highlightParts("", [[0, 1]], "rtl")).toEqual([])
  })
})

describe("direction helpers", () => {
  it("reads the first strong character", () => {
    expect(strongDirection("12 תקציב")).toBe("rtl")
    expect(strongDirection("— Supabase")).toBe("ltr")
    expect(strongDirection("123 !")).toBeUndefined()
  })

  it("maps known languages and leaves mixed or unknown open", () => {
    expect(dirForLanguage("he")).toBe("rtl")
    expect(dirForLanguage("he-IL")).toBe("rtl")
    expect(dirForLanguage("en")).toBe("ltr")
    expect(dirForLanguage("pt")).toBe("ltr")
    expect(dirForLanguage("mixed")).toBeUndefined()
    expect(dirForLanguage(undefined)).toBeUndefined()
  })
})
