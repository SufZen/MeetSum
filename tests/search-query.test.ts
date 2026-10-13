import { describe, expect, it } from "vitest"

import { buildTsQuery, escapeLexeme, trgmQuery } from "@/lib/search/query"
import type { NormalizedQuery, QueryToken } from "@/lib/search/types"

function token(raw: string, variants: string[] = [], extra: Partial<QueryToken> = {}): QueryToken {
  return { raw, variants, script: /^[a-z]/.test(raw) ? "latin" : /^\d/.test(raw) ? "number" : "he", stop: false, ...extra }
}

function nq(tokens: QueryToken[], folded = tokens.map((t) => t.raw).join(" ")): NormalizedQuery {
  return { input: folded, folded, tokens }
}

describe("escapeLexeme", () => {
  it("quotes and escapes tsquery operators", () => {
    expect(escapeLexeme("a'b")).toBe("'a\\'b'")
    expect(escapeLexeme("x:y&z|w!v\\u")).toBe("'x\\:y\\&z\\|w\\!v\\\\u'")
  })
})

describe("buildTsQuery", () => {
  it("returns null without tokens", () => {
    expect(buildTsQuery(nq([]))).toBeNull()
  })

  it("groups raw and variants and ORs the groups", () => {
    expect(buildTsQuery(nq([token("והתקציב", ["התקציב", "תקציב"]), token("ai")]))).toBe(
      "('והתקציב':* | 'התקציב':* | 'תקציב':*) | ('ai')"
    )
  })

  it("applies :* only to lexemes of 3+ characters and never to numbers", () => {
    expect(buildTsQuery(nq([token("q3")]))).toBe("('q3')")
    expect(buildTsQuery(nq([token("1200")]))).toBe("('1200')")
    expect(buildTsQuery(nq([token("על")]))).toBe("('על')")
  })

  it("prunes stop tokens only when other tokens remain", () => {
    expect(buildTsQuery(nq([token("של", [], { stop: true }), token("תקציב")]))).toBe("('תקציב':*)")
    expect(buildTsQuery(nq([token("על", [], { stop: true })]))).toBe("('על')")
  })

  it("dedupes lexemes and survives injection-looking input", () => {
    const query = buildTsQuery(nq([token("x') | !('y"), token("x') | !('y")]))

    expect(query).toBe("('x\\') \\| \\!(\\'y':*)")
  })
})

describe("trgmQuery", () => {
  it("is the folded text when it has 3+ characters", () => {
    expect(trgmQuery(nq([token("תקציב")]))).toBe("תקציב")
    expect(trgmQuery(nq([token("ai")]))).toBeNull()
  })
})
