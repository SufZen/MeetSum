import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

/**
 * Settings → AI has one default-template control (LlmSettings, with built-in
 * and workspace templates). The legacy slug list in operational-pages was a
 * second control writing the same setting.
 */
describe("Settings → AI default template control", () => {
  it("has no legacy slug list next to LlmSettings", () => {
    const source = readFileSync("components/operational-pages.tsx", "utf8")

    expect(source).not.toContain('"general", "sales", "real-estate", "product", "operations", "legal"].map')
    expect(source).not.toContain('title="Default summary template"')
    expect(source).toContain("<LlmSettings")
  })
})
