/**
 * M9 Step 0: `lib/client/shell-url.ts` parse/build (Package D extends this
 * suite with routing and focus tests).
 */
import { describe, expect, expectTypeOf, it } from "vitest"

import type { MainPanelKey } from "@/components/main-sidebar"
import { DEFAULT_SHELL_STATE, SHELL_PANELS, buildShellUrl, parseShellUrl, type ShellPanel } from "@/lib/client/shell-url"

describe("shell-url", () => {
  it("keeps the panel list in sync with the sidebar's MainPanelKey", () => {
    expectTypeOf<ShellPanel>().toEqualTypeOf<MainPanelKey>()
    expect(SHELL_PANELS).toContain("settings")
  })

  it("parses defaults and rejects invalid values", () => {
    expect(parseShellUrl("")).toEqual(DEFAULT_SHELL_STATE)
    expect(parseShellUrl("?panel=nope&tab=x&adminTab=y&section=z&meeting=../etc")).toEqual(DEFAULT_SHELL_STATE)
  })

  it("parses a full state from a query string, URLSearchParams or a searchParams object", () => {
    const expected = { ...DEFAULT_SHELL_STATE, meeting: "m_1", tab: "transcript", t: 90 }

    expect(parseShellUrl("?meeting=m_1&tab=transcript&t=90")).toEqual(expected)
    expect(parseShellUrl(new URLSearchParams("meeting=m_1&tab=transcript&t=1:30"))).toEqual(expected)
    expect(parseShellUrl({ meeting: "m_1", tab: "transcript", t: "90" })).toEqual(expected)
  })

  it("keeps M8's ?panel=settings&section=integrations working", () => {
    expect(parseShellUrl("?panel=settings&section=integrations")).toMatchObject({ panel: "settings", section: "integrations" })
    expect(buildShellUrl("he", { panel: "settings", section: "integrations" })).toBe("/he?panel=settings&section=integrations")
  })

  it("omits defaults and preserves unknown parameters", () => {
    expect(buildShellUrl("he", {})).toBe("/he")
    expect(buildShellUrl("en", { panel: "meetings", meeting: "m_1", tab: "summary", t: 0 })).toBe("/en?meeting=m_1&t=0")
    expect(buildShellUrl("he", { panel: "admin", adminTab: "audit" }, "?panel=settings&integration_error=x&q=a")).toBe(
      "/he?panel=admin&adminTab=audit&integration_error=x&q=a"
    )
  })

  it("round-trips", () => {
    const state = { ...DEFAULT_SHELL_STATE, panel: "meetings" as const, meeting: "m_9", tab: "ask" as const, t: 12 }
    const url = buildShellUrl("he", state)

    expect(parseShellUrl(url.split("?")[1] ?? "")).toEqual(state)
  })
})
