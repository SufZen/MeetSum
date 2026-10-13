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
      messages: [],
      other: ["LLM preference is anthropic but ANTHROPIC_API_KEY is not set; using Gemini"],
    })
    expect(providerWarnings([{ id: "gemini", configured: true }])).toEqual({ geminiFreeTier: false, messages: [], other: [] })
    expect(providerWarnings(undefined)).toEqual({ geminiFreeTier: false, messages: [], other: [] })
  })

  it("prefers warning codes over the English text", () => {
    const coded = [
      { ...payload[0], warningMessages: [{ code: "llm_warning_gemini_free_tier" }] },
      {
        ...payload[1],
        warningMessages: [{ code: "llm_warning_gemini_free_tier" }, { code: "llm_warning_anthropic_missing" }],
      },
    ]

    expect(providerWarnings(coded)).toEqual({
      geminiFreeTier: true,
      messages: [{ code: "llm_warning_anthropic_missing" }],
      other: [],
    })
  })

  it("renders status codes in Hebrew with env names as literal code", () => {
    const he = getDictionary("he")
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        {
          locale: "he",
          dir: "rtl",
          timeZone: "Asia/Jerusalem",
          messages: he,
        } as Omit<ComponentProps<typeof I18nProvider>, "children"> as ComponentProps<typeof I18nProvider>,
        createElement(ProviderHealthPanel, {
          providers: [
            {
              id: "gemini",
              label: "Gemini",
              labelId: "gemini",
              configured: false,
              detail: "Missing GOOGLE_GEMINI_API_KEY",
              detailMessage: { code: "missing_env", params: { env: "GOOGLE_GEMINI_API_KEY" } },
            },
            {
              id: "llm-router",
              label: "LLM routing",
              labelId: "llm-router",
              configured: false,
              detail: "No LLM provider configured: summaries use the heuristic fallback",
              detailMessage: { code: "llm_heuristic_only" },
            },
          ],
        })
      )
    )

    expect(html).not.toContain("Missing GOOGLE")
    expect(html).not.toContain("LLM routing")
    expect(html).not.toContain("heuristic fallback")
    expect(html).toContain(he.opsProviderLabelLlmRouter)
    expect(html).toContain('<code dir="ltr" class="font-mono text-[0.92em]">GOOGLE_GEMINI_API_KEY</code>')
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

    expect(html).toContain("GEMINI_TIER</code>=free")
    expect(html).toContain('role="status"')
    expect(html.match(/bg-warn-soft/g)).toHaveLength(2)
    expect(html).toContain(getDictionary("he").opsProviderHealthTitle)
  })
})
