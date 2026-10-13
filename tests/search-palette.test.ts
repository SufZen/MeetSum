import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { defaultPaletteSelection } from "@/components/search/palette-selection"
import type { SearchMeetingGroup } from "@/lib/search/types"

/** Ctrl/Cmd+K palette behaviour found in the browser e2e (M6 review). */

const group = (id: string) => ({ meeting: { id }, score: 1, hits: [] }) as unknown as SearchMeetingGroup

describe("command palette", () => {
  it("selects the top meeting by default once results arrive, so Enter jumps to it", () => {
    expect(defaultPaletteSelection("תקציב", [group("m1"), group("m2")])).toBe("meeting:m1")
    expect(defaultPaletteSelection("תקציב", [])).toBe("__ask")
    expect(defaultPaletteSelection("", [])).toBe("__open")
  })

  it("names the input, drives the selection and clears the query whenever it opens", () => {
    const source = readFileSync("components/search/command-palette-dialog.tsx", "utf8")

    expect(source).toMatch(/<CommandInput[\s\S]*?aria-label=\{t\.searchPaletteTitle\}/)
    expect(source).toMatch(/<Command[^>]*value=\{selected\}[^>]*onValueChange=\{setSelected\}/)
    expect(source).toMatch(/if \(open !== wasOpen\) \{\s*setWasOpen\(open\)\s*if \(open\) \{\s*setValue\(""\)/)
  })
})
