import { describe, expect, it } from "vitest"

import { getSummaryTemplatePrompt, type SummaryTemplate } from "@/lib/ai/summary-templates"
import { DEFAULT_APP_SETTINGS } from "@/lib/settings/app-settings"

describe("summary template pipeline wiring", () => {
  it("default app settings use 'general' template", () => {
    expect(DEFAULT_APP_SETTINGS.summaryTemplate).toBe("general")
  })

  it("general template produces no addendum (preserves existing behavior)", () => {
    const addendum = getSummaryTemplatePrompt("general")
    expect(addendum).toBe("")
  })

  it("all non-general templates produce non-empty addendums", () => {
    const templates: SummaryTemplate[] = ["sales", "real-estate", "product", "operations", "legal"]

    for (const template of templates) {
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
    const templates: SummaryTemplate[] = ["sales", "real-estate", "product", "operations", "legal"]

    for (const template of templates) {
      const addendum = getSummaryTemplatePrompt(template)
      // Should not contain JSON or code that would confuse the LLM
      expect(addendum).not.toContain("{")
      expect(addendum).not.toContain("```")
      // Should be a natural language instruction
      expect(addendum).toContain("Pay special attention")
    }
  })
})
