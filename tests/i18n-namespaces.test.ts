/**
 * M10 C (docs/parity/m10.md, lever 2): message namespaces. The namespaces
 * partition the dictionary exactly, keep he/en parity, a route's provider can
 * carry only its namespaces, and a component that needs a missing namespace
 * fails loudly in development.
 */
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { I18nProvider, useI18nNamespaces } from "@/components/i18n-provider"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { m9ShareMessages } from "@/lib/i18n/m9/share"
import { NAMESPACES, messagesFor, namespaceMessages } from "@/lib/i18n/namespaces"

describe("message namespaces", () => {
  it.each(["en", "he"] as const)("rebuild the whole %s dictionary", (locale) => {
    expect(messagesFor(locale, NAMESPACES)).toEqual(getDictionary(locale))
    expect(messagesFor(locale, "all")).toBe(getDictionary(locale))
  })

  it("keep he/en key parity per namespace (he may add `_two`)", () => {
    for (const ns of NAMESPACES) {
      const en = Object.keys(namespaceMessages("en", ns)).sort()
      const he = Object.keys(namespaceMessages("he", ns))
        .filter((key) => !key.endsWith("_two"))
        .sort()

      expect(he, ns).toEqual(en)
    }
  })

  it("give the share route only the share strings", () => {
    expect(messagesFor("he", ["share"])).toEqual(m9ShareMessages.he)
    expect(Object.keys(messagesFor("en", ["share"]))).not.toContain("navMeetings")
  })
})

function Probe({ ns }: { ns: string }) {
  return createElement("span", null, useI18nNamespaces(ns).t("sharePageLoading"))
}

function render(namespaces: readonly string[] | undefined, ns: string) {
  // `children` is passed as the third argument below.
  const props: ComponentProps<typeof I18nProvider> = {
    locale: "en",
    dir: "ltr",
    timeZone: "UTC",
    messages: messagesFor("en", ["share"]),
    namespaces,
    children: null,
  }

  return renderToStaticMarkup(createElement(I18nProvider, props, createElement(Probe, { ns })))
}

describe("useI18nNamespaces", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("reads a namespace the provider carries", () => {
    expect(render(["share"], "share")).toContain(m9ShareMessages.en.sharePageLoading)
    expect(render(undefined, "tasks")).toContain(m9ShareMessages.en.sharePageLoading)
  })

  it("throws in development when the provider lacks the namespace", () => {
    expect(() => render(["share"], "tasks")).toThrow(/missing namespace\(s\): tasks/)
  })

  it("reports instead of throwing in production", () => {
    const reportError = vi.fn()

    vi.stubEnv("NODE_ENV", "production")
    vi.stubGlobal("reportError", reportError)

    expect(() => render(["share"], "tasks")).not.toThrow()
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("tasks") }))
  })
})
