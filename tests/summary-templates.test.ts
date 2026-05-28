import { describe, expect, it } from "vitest"

import {
  getSummaryTemplatePrompt,
  SUMMARY_TEMPLATE_LABELS,
  type SummaryTemplate,
} from "@/lib/ai/summary-templates"

const ALL_TEMPLATES: SummaryTemplate[] = [
  "general",
  "sales",
  "real-estate",
  "product",
  "operations",
  "legal",
]

describe("summary templates", () => {
  it("returns a non-empty prompt for all non-general templates", () => {
    for (const template of ALL_TEMPLATES) {
      const prompt = getSummaryTemplatePrompt(template)

      if (template === "general") {
        expect(prompt).toBe("")
      } else {
        expect(prompt.length).toBeGreaterThan(50)
      }
    }
  })

  it("has labels for all templates", () => {
    for (const template of ALL_TEMPLATES) {
      expect(SUMMARY_TEMPLATE_LABELS[template]).toBeTruthy()
    }
  })

  it("sales template mentions lead qualification", () => {
    const prompt = getSummaryTemplatePrompt("sales")

    expect(prompt).toContain("Lead qualification")
    expect(prompt).toContain("Objections")
    expect(prompt).toContain("Competitor")
  })

  it("real-estate template preserves monetary amounts", () => {
    const prompt = getSummaryTemplatePrompt("real-estate")

    expect(prompt).toContain("monetary amounts")
    expect(prompt).toContain("Property details")
  })

  it("product template mentions sprint commitments", () => {
    const prompt = getSummaryTemplatePrompt("product")

    expect(prompt).toContain("Sprint")
    expect(prompt).toContain("Dependencies")
  })

  it("legal template flags uncertainty", () => {
    const prompt = getSummaryTemplatePrompt("legal")

    expect(prompt).toContain("uncertainty")
    expect(prompt).toContain("Regulatory")
  })
})
