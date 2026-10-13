/**
 * M9 Integration: the PDF route and the share page use A's zone chain
 * (users.time_zone → workspace setting → MEETSUM_DEFAULT_TIMEZONE →
 * Asia/Jerusalem), not the env fallback alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  userZones: {} as Record<string, string | null>,
  workspaceZones: {} as Record<string, string | null>,
  sessionUserId: null as string | null,
}))

vi.mock("@/lib/users/preferences", () => ({
  getUserPreferences: vi.fn(async (userId: string) => ({
    locale: null,
    timeZone: state.userZones[userId] ?? null,
    notifications: { muted: [] },
  })),
}))

vi.mock("@/lib/settings/app-settings", () => ({
  getAppSettings: vi.fn(async (workspaceId: string) => ({ timeZone: state.workspaceZones[workspaceId] ?? null })),
}))

vi.mock("@/lib/auth/authz", () => ({
  getServerAuthState: vi.fn(async () =>
    state.sessionUserId
      ? { status: "no_workspace", session: { user: { id: state.sessionUserId } } }
      : { status: "unauthenticated" }
  ),
}))

import { getShareTimeZone, resolveScopedTimeZone } from "@/lib/i18n/server"

beforeEach(() => {
  state.userZones = { u1: "Europe/Lisbon", u2: null }
  state.workspaceZones = { w1: "America/New_York", w2: null }
  state.sessionUserId = null
  vi.stubEnv("MEETSUM_DEFAULT_TIMEZONE", "Europe/Berlin")
})

describe("resolveScopedTimeZone", () => {
  it("prefers the user, then the workspace, then the env", async () => {
    expect(await resolveScopedTimeZone({ userId: "u1", workspaceId: "w1" })).toBe("Europe/Lisbon")
    expect(await resolveScopedTimeZone({ userId: "u2", workspaceId: "w1" })).toBe("America/New_York")
    expect(await resolveScopedTimeZone({ userId: null, workspaceId: "w2" })).toBe("Europe/Berlin")
  })

  it("falls back to Asia/Jerusalem when nothing is valid", async () => {
    vi.stubEnv("MEETSUM_DEFAULT_TIMEZONE", "Not/AZone")

    expect(await resolveScopedTimeZone({})).toBe("Asia/Jerusalem")
  })
})

describe("getShareTimeZone", () => {
  it("uses the shared meeting's workspace zone for an anonymous viewer", async () => {
    expect(await getShareTimeZone("w1")).toBe("America/New_York")
    expect(await getShareTimeZone(undefined)).toBe("Europe/Berlin")
  })
})
