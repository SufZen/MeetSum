import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/** M6 UI guardrails: code splitting, Cadence rules and no HTML injection. */
const M6_DIRS = ["components/search", "components/ask", "lib/client"]

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name)) : /\.(tsx?|ts)$/.test(entry.name) ? [join(dir, entry.name)] : []
  )
}

describe("M6 UI guardrails", () => {
  it("has no Cadence violations (physical direction, raw palette, arbitrary colours or sizes)", () => {
    const output = execFileSync(
      process.execPath,
      ["design-system/check.mjs", "--json", ...M6_DIRS, "app/[locale]/search", "components/command-palette.tsx"],
      { encoding: "utf8" }
    )

    expect(JSON.parse(output).total).toBe(0)
  })

  it("never renders HTML from snippets or model output", () => {
    for (const file of [...filesIn("components/search"), ...filesIn("components/ask")]) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")

      expect(source, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/)
    }
  })

  it("loads the Ask panel and the palette dialog with next/dynamic", () => {
    const lazy = readFileSync("components/ask/lazy.tsx", "utf8")
    const palette = readFileSync("components/command-palette.tsx", "utf8")

    expect(lazy).toContain('import("@/components/ask/ask-panel")')
    expect(palette).toContain('import("@/components/search/command-palette-dialog")')

    for (const file of [
      "components/meeting-workspace.tsx",
      "components/room-detail-view.tsx",
      "components/ask-meeting-panel.tsx",
      "components/search/search-view.tsx",
    ]) {
      const source = readFileSync(file, "utf8")

      expect(source, file).not.toMatch(/from "@\/components\/ask\/ask-panel"/)
      expect(source, file).not.toMatch(/from "@\/components\/search\/command-palette-dialog"/)
    }
  })

  it("keeps the meeting workspace on the code-split Ask panel", () => {
    const source = readFileSync("components/meeting-workspace.tsx", "utf8")

    expect(source).toContain('from "@/components/ask-meeting-panel"')
    expect(readFileSync("components/ask-meeting-panel.tsx", "utf8")).toContain('from "@/components/ask/lazy"')
  })
})
