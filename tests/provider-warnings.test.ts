import { renderToStaticMarkup } from "react-dom/server"
import { createElement, type ComponentProps } from "react"
import { describe, expect, it } from "vitest"

import { I18nProvider } from "@/components/i18n-provider"
import { providerWarnings } from "@/components/intelligence/llm-settings"
import { ProviderHealthPanel } from "@/components/provider-health-panel"
import { GEMINI_FREE_TIER_WARNING } from "@/lib/ai/llm/config"
import { getDictionary } from "@/lib/i18n/dictionaries"

describe("provider warnings (GEMINI_TIER=free privacy warning)", () => {
  const payload = [
    { id: "gemini", label: "Gemini", configured: true, detail: "Default LLM", warning: GEMINI_FREE_TIER_WARNING },
    {
      id: "llm-router",
      label: "LLM routing",
      configured: true,
      detail: "Summary: gemini",
      warning: `${GEMINI_FREE_TIER_WARNING} LLM preference is anthropic but ANTHROPIC_API_KEY is not set; using Gemini`,
    },
    { id: "anthropic", label: "Claude", configured: false, detail: "Optional" },
  ]

  it("flags the free tier once and keeps other warnings", () => {
    expect(providerWarnings(payload)).toEqual({
      geminiFreeTier: true,
      other: ["LLM preference is anthropic but ANTHROPIC_API_KEY is not set; using Gemini"],
    })
    expect(providerWarnings([{ id: "gemini", configured: true }])).toEqual({ geminiFreeTier: false, other: [] })
    expect(providerWarnings(undefined)).toEqual({ geminiFreeTier: false, other: [] })
  })

  it("renders each provider's warning in the ops provider panel", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        {
          locale: "he",
          dir: "rtl",
          timeZone: "Asia/Jerusalem",
          messages: getDictionary("he"),
        } as Omit<ComponentProps<typeof I18nProvider>, "children"> as ComponentProps<typeof I18nProvider>,
        createElement(ProviderHealthPanel, { providers: payload })
      )
    )

    expect(html).toContain("GEMINI_TIER=free")
    expect(html).toContain('role="status"')
    expect(html.match(/bg-warn-soft/g)).toHaveLength(2)
    expect(html).toContain(getDictionary("he").opsProviderHealthTitle)
  })
})
