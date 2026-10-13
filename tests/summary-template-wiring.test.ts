import { describe, expect, it } from "vitest"

import { buildSummaryInstructions } from "@/lib/ai/prompts/summary"
import { getSummaryTemplatePrompt, type SummaryTemplate } from "@/lib/ai/summary-templates"
import { BUILT_IN_TEMPLATES } from "@/lib/ai/templates/builtins"
import { requestedTemplateKey, resolveTemplate } from "@/lib/ai/templates/registry"
import { DEFAULT_APP_SETTINGS } from "@/lib/settings/app-settings"

const LEGACY: SummaryTemplate[] = ["sales", "real-estate", "product", "operations", "legal"]

describe("summary template pipeline wiring", () => {
  it("default app settings use 'general' template", () => {
    expect(DEFAULT_APP_SETTINGS.summaryTemplate).toBe("general")
  })

  it("general template produces no addendum (preserves existing behavior)", () => {
    const addendum = getSummaryTemplatePrompt("general")
    expect(addendum).toBe("")
  })

  it("all non-general templates produce non-empty addendums", () => {
    for (const template of LEGACY) {
      const addendum = getSummaryTemplatePrompt(template)
      expect(addendum.length).toBeGreaterThan(50)
    }
  })

  it("sales template includes domain-specific guidance", () => {
    const prompt = getSummaryTemplatePrompt("sales")
    expect(prompt).toContain("sales call")
    expect(prompt).toContain("Lead qualification")
  })

  it("template addendum is suitable for prompt concatenation", () => {
    for (const template of LEGACY) {
      const addendum = getSummaryTemplatePrompt(template)
      // Should not contain JSON or code that would confuse the LLM
      expect(addendum).not.toContain("{")
      expect(addendum).not.toContain("```")
      // Should be a natural language instruction
      expect(addendum).toContain("Pay special attention")
    }
  })

  it("the shim serves the registry's English addenda", () => {
    for (const template of LEGACY) {
      expect(getSummaryTemplatePrompt(template)).toBe(BUILT_IN_TEMPLATES[template].promptAddendum.en)
    }
  })

  it("the workspace summaryTemplate reaches the summary instructions", async () => {
    const key = requestedTemplateKey({ workspaceTemplate: "sales" })
    const template = (await resolveTemplate("ws_1", key))!
    const prompt = buildSummaryInstructions({
      language: "en",
      template,
      meetingTitle: "Acme",
      startedAt: "2026-10-15T07:00:00.000Z",
      participants: [],
      durationMs: 1_800_000,
    })

    expect(prompt).toContain("Lead qualification")
    expect(prompt).toContain("customer_needs")
  })
})
