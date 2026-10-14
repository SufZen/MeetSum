/**
 * M10 C (docs/parity/m10.md, design-system leftovers): `ds:check --strict` is
 * green, every `allowLines` entry carries a one-line reason and still matches
 * a hit, and the 17 M9 findings stay fixed (sheet/sidebar/tooltip logical,
 * chart indicator colours inline).
 */
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { RULES, scan } from "../design-system/check.mjs"

type AllowLine = { file: string; pattern: string; reason: string }
type Rule = { allowLines?: AllowLine[] }

describe("design-system allowLines", () => {
  const rules = RULES as Record<string, Rule>

  it("give every entry a file, a pattern and a one-line reason", () => {
    for (const [rule, spec] of Object.entries(rules)) {
      for (const entry of spec.allowLines ?? []) {
        expect(entry.file, rule).toMatch(/^(components|app|lib|hooks)\//)
        expect(() => new RegExp(entry.pattern), `${rule}: ${entry.pattern}`).not.toThrow()
        expect(entry.reason.trim().length, `${rule}: ${entry.file}`).toBeGreaterThan(20)
        expect(entry.reason, `${rule}: ${entry.file}`).not.toMatch(/\n/)
      }
    }
  })

  it("allowlists only the recharts attribute selectors and the root error page", () => {
    const entries = Object.entries(rules).flatMap(([rule, spec]) =>
      (spec.allowLines ?? []).map((entry) => `${rule}:${entry.file}`)
    )

    expect(entries.sort()).toEqual(["client-message-import:app/global-error.tsx", "hex-literal:components/ui/chart.tsx"])
  })

  it("report 0 violations and no stale entry on the repository (ds:check --strict)", () => {
    const result = scan() as { total: number; allowlisted: number; staleAllowLines: string[] }

    expect(result.staleAllowLines).toEqual([])
    expect(result.total).toBe(0)
    expect(result.allowlisted).toBe(6)
  })
})

describe("the 17 M9 findings stay fixed", () => {
  it("sheet and sidebar take logical sides; physical values are deprecated aliases", async () => {
    const { logicalSheetSide } = await import("@/components/ui/sheet")

    expect(logicalSheetSide("left", "ltr")).toBe("start")
    expect(logicalSheetSide("left", "rtl")).toBe("end")
    expect(logicalSheetSide("right", "ltr")).toBe("end")
    expect(logicalSheetSide("right", "rtl")).toBe("start")
    expect(logicalSheetSide("end", "rtl")).toBe("end")
    expect(logicalSheetSide("bottom", "rtl")).toBe("bottom")
    expect(readFileSync("components/ui/sidebar.tsx", "utf8")).toContain('side: sideProp = "start"')
  })

  it("tooltip sides are logical, so the arrow needs no physical class", async () => {
    const { logicalTooltipSide } = await import("@/components/ui/tooltip")

    expect(logicalTooltipSide("left", "ltr")).toBe("inline-start")
    expect(logicalTooltipSide("left", "rtl")).toBe("inline-end")
    expect(logicalTooltipSide("right", "rtl")).toBe("inline-start")
    expect(logicalTooltipSide("top", "rtl")).toBe("top")
    expect(readFileSync("components/ui/tooltip.tsx", "utf8")).not.toMatch(/data-\[side=(left|right)\]/)
  })

  it("chart indicators use the series colour inline, not arbitrary colour utilities", () => {
    const chart = readFileSync("components/ui/chart.tsx", "utf8")

    expect(chart).not.toContain("border-(--color-border)")
    expect(chart).not.toContain("bg-(--color-bg)")
  })
})
