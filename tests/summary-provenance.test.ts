import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AiProvenance } from "@/components/ui/meeting-atoms"
import { summaryProvenance } from "@/lib/intelligence/provenance"

type Props = ComponentProps<typeof AiProvenance>

/** Cadence rule: the iris AI mark only on AI-written content. */
describe("summary provenance", () => {
  it("is ai only for an LLM summary without fallback", () => {
    expect(summaryProvenance({ provider: "gemini", fallbackUsed: false })).toBe("ai")
    expect(summaryProvenance({ provider: "anthropic" })).toBe("ai")
    expect(summaryProvenance({ provider: "heuristic", fallbackUsed: true })).toBe("auto")
    expect(summaryProvenance({ provider: "gemini", fallbackUsed: true })).toBe("auto")
    expect(summaryProvenance(undefined)).toBe("auto")
  })

  it("renders the automatic state without the AI mark or iris colour", () => {
    const auto = renderToStaticMarkup(
      createElement(AiProvenance, { state: "auto", dir: "rtl", label: "סיכום אוטומטי (ללא AI)" } as Props, "תוכן")
    )
    const ai = renderToStaticMarkup(createElement(AiProvenance, { state: "ai", dir: "rtl", label: "AI" } as Props, "x"))

    expect(ai).toContain("text-ai-text")
    expect(auto).not.toContain("text-ai-text")
    expect(auto).not.toContain("--prov")
  })
})
