import { describe, expect, it } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import {
  ASR_GLOSSARY_LIMITS,
  getAsrGlossary,
  parseAsrGlossary,
} from "@/lib/settings/asr-glossary"

describe("parseAsrGlossary", () => {
  it("accepts a valid glossary and normalizes strings", () => {
    const result = parseAsrGlossary({
      version: 1,
      terms: [
        { term: "  Supabase ", aliases: ["סופרבייס", "סופרבייס", "Supabase"], hotword: true },
        { term: "Realization", aliases: [], hotword: false, caseSensitive: true },
        { term: "n8n" },
      ],
    })

    expect(result).toEqual({
      ok: true,
      glossary: {
        version: 1,
        terms: [
          { term: "Supabase", aliases: ["סופרבייס"], hotword: true },
          { term: "Realization", aliases: [], hotword: false, caseSensitive: true },
          { term: "n8n", aliases: [], hotword: true },
        ],
      },
    })
  })

  it("accepts the built-in defaults", () => {
    expect(parseAsrGlossary(DEFAULT_ASR_GLOSSARY)).toEqual({
      ok: true,
      glossary: DEFAULT_ASR_GLOSSARY,
    })
  })

  it("rejects non-objects, wrong versions and missing terms", () => {
    expect(parseAsrGlossary(null)).toMatchObject({ ok: false })
    expect(parseAsrGlossary({ version: 2, terms: [] })).toEqual({
      ok: false,
      errors: [{ path: "version", message: "must be 1" }],
    })
    expect(parseAsrGlossary({ version: 1 })).toEqual({
      ok: false,
      errors: [{ path: "terms", message: "must be an array" }],
    })
  })

  it("enforces term, length and alias limits with field paths", () => {
    const tooMany = Array.from({ length: ASR_GLOSSARY_LIMITS.maxTerms + 1 }, (_, index) => ({
      term: `t${index}`,
    }))

    expect(parseAsrGlossary({ version: 1, terms: tooMany })).toMatchObject({
      ok: false,
      errors: [{ path: "terms" }],
    })

    const result = parseAsrGlossary({
      version: 1,
      terms: [
        { term: "x".repeat(ASR_GLOSSARY_LIMITS.maxChars + 1) },
        { term: "ok", aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) },
        { term: "fine", aliases: ["", 5] },
        { term: "flag", hotword: "yes" },
        { term: "OK" },
        { term: "ok" },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.errors.map((error) => error.path)).toEqual([
      "terms.0.term",
      "terms.1.aliases",
      "terms.2.aliases.0",
      "terms.2.aliases.1",
      "terms.3.hotword",
      "terms.5.term",
    ])
  })
})

describe("getAsrGlossary (stub)", () => {
  it("returns a copy of the defaults", async () => {
    const glossary = await getAsrGlossary("ws_a")

    expect(glossary).toEqual(DEFAULT_ASR_GLOSSARY)
    expect(glossary.terms).not.toBe(DEFAULT_ASR_GLOSSARY.terms)
  })
})
