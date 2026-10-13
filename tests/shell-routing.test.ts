/**
 * M9 D1: push vs replace, in-app link clicks, one-shot parameters, and the
 * server-side deep-link resolution of the shell page.
 */
import { describe, expect, it } from "vitest"

import { isPlainLeftClick, shellHistoryMode, withoutParams } from "@/lib/client/shell-navigation"
import { DEFAULT_SHELL_STATE, buildShellUrl, parseShellUrl, type ShellState } from "@/lib/client/shell-url"
import { resolveShellDeepLink } from "@/lib/client/shell-deep-link"

const state = (patch: Partial<ShellState> = {}): ShellState => ({ ...DEFAULT_SHELL_STATE, ...patch })

describe("shellHistoryMode", () => {
  it("pushes panel, meeting, settings section and admin tab changes", () => {
    expect(shellHistoryMode(state(), state({ panel: "settings" }))).toBe("push")
    expect(shellHistoryMode(state(), state({ meeting: "m_1" }))).toBe("push")
    expect(shellHistoryMode(state({ panel: "settings" }), state({ panel: "settings", section: "integrations" }))).toBe("push")
    expect(shellHistoryMode(state({ panel: "admin" }), state({ panel: "admin", adminTab: "audit" }))).toBe("push")
  })

  it("replaces tab and time changes", () => {
    expect(shellHistoryMode(state({ meeting: "m" }), state({ meeting: "m", tab: "transcript" }))).toBe("replace")
    expect(shellHistoryMode(state({ meeting: "m" }), state({ meeting: "m", t: 90 }))).toBe("replace")
  })

  it("does nothing for an identical state", () => {
    expect(shellHistoryMode(state({ meeting: "m" }), state({ meeting: "m" }))).toBe("none")
  })

  it("walks inbox → meeting → transcript → settings → integrations as history entries", () => {
    const steps: ShellState[] = [
      state(),
      state({ meeting: "m_1" }),
      state({ meeting: "m_1", tab: "transcript" }),
      state({ meeting: "m_1", tab: "transcript", panel: "settings" }),
      state({ meeting: "m_1", tab: "transcript", panel: "settings", section: "integrations" }),
    ]
    const modes = steps.slice(1).map((next, index) => shellHistoryMode(steps[index], next))

    expect(modes).toEqual(["push", "replace", "push", "push"])
    // Each step's URL round-trips (reload keeps the state).
    for (const step of steps) {
      expect(parseShellUrl(buildShellUrl("he", step).split("?")[1] ?? "")).toMatchObject({
        panel: step.panel,
        meeting: step.meeting,
        ...(step.panel === "settings" ? { section: step.section } : {}),
      })
    }
  })
})

describe("isPlainLeftClick", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }

  it("handles plain left clicks in-app", () => {
    expect(isPlainLeftClick(click)).toBe(true)
  })

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle", { button: 1 }],
    ["prevented", { defaultPrevented: true }],
  ])("keeps the browser default for %s clicks", (_label, patch) => {
    expect(isPlainLeftClick({ ...click, ...patch })).toBe(false)
  })
})

describe("withoutParams", () => {
  it("drops one-shot parameters and keeps the rest", () => {
    expect(withoutParams("?record=1&panel=meetings&q=x", ["record"])).toBe("?panel=meetings&q=x")
    expect(withoutParams("record=1", ["record"])).toBe("")
  })
})

describe("resolveShellDeepLink (server page)", () => {
  const page = [{ id: "m_1" }, { id: "m_2" }]
  const fetched: string[] = []
  const load = async (id: string) => {
    fetched.push(id)
    return id === "m_10" ? { id: "m_10" } : undefined
  }

  it("needs no fetch without a meeting or when it is on the first page", async () => {
    expect(await resolveShellDeepLink(parseShellUrl(""), page, load)).toEqual({ kind: "none" })
    expect(await resolveShellDeepLink(parseShellUrl("?meeting=m_2"), page, load)).toEqual({ kind: "listed", meetingId: "m_2" })
    expect(fetched).toEqual([])
  })

  it("fetches a meeting outside the first page through the visibility-checked loader", async () => {
    expect(await resolveShellDeepLink(parseShellUrl("?meeting=m_10&t=90"), page, load)).toEqual({
      kind: "fetched",
      meetingId: "m_10",
      meeting: { id: "m_10" },
    })
  })

  it("reports an invisible or missing meeting as unavailable instead of failing", async () => {
    expect(await resolveShellDeepLink(parseShellUrl("?meeting=m_private"), page, load)).toEqual({ kind: "unavailable", meetingId: "m_private" })
    expect(
      await resolveShellDeepLink(parseShellUrl("?meeting=m_err"), page, async () => {
        throw new Error("db down")
      })
    ).toEqual({ kind: "unavailable", meetingId: "m_err" })
  })
})
