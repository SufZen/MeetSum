/**
 * M9 C3 `GET/POST /api/onboarding` (docs/parity/m9.md): state per caller,
 * admin-only steps unavailable for members, skip/dismiss stored per user,
 * invalid actions 400, API keys 403 `user_required`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/google/oauth-tokens", () => ({
  getGoogleWorkspaceOAuthConnectionStatus: async () => ({ connected: false, scopes: undefined }),
}))
vi.mock("@/lib/workspaces/store", () => ({
  getWorkspaceStore: () => ({
    listMembers: async () => [{ userId: "a" }, { userId: "b" }],
    listInvitations: async () => [],
  }),
}))
vi.mock("@/lib/settings/asr-glossary", () => ({ getWorkspaceAsrGlossary: async () => ({ version: 1, terms: [] }) }))

import { GET, POST } from "@/app/api/onboarding/route"
import { createMemoryOnboardingProgressStore, setOnboardingProgressStoreForTesting } from "@/lib/onboarding/progress"
import type { OnboardingState } from "@/lib/onboarding/types"

const route = { params: Promise.resolve({}) }
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/onboarding", { method: "POST", body: JSON.stringify(body) }), route)

beforeEach(async () => {
  setOnboardingProgressStoreForTesting(createMemoryOnboardingProgressStore())
  setRouteCtx(await createTestCtx({ role: "owner", meetings: [] }))
})

afterEach(() => {
  setOnboardingProgressStoreForTesting(undefined)
  setRouteCtx(undefined)
})

describe("/api/onboarding", () => {
  it("returns live steps for an owner", async () => {
    const state = (await (await GET(new Request("http://localhost/api/onboarding"), route)).json()) as OnboardingState

    expect(state.steps.map((step) => [step.id, step.status])).toEqual([
      ["google", "todo"],
      ["invite", "done"],
      ["glossary", "todo"],
      ["upload", "todo"],
    ])
  })

  it("stores skips and dismissal for the caller only", async () => {
    const skipped = (await (await post({ action: "skip", step: "glossary" })).json()) as OnboardingState

    expect(skipped.steps.find((step) => step.id === "glossary")?.status).toBe("skipped")
    expect(((await (await post({ action: "dismiss" })).json()) as OnboardingState).dismissed).toBe(true)

    setRouteCtx(await createTestCtx({ role: "admin", userId: "someone_else", meetings: [] }))

    const other = (await (await GET(new Request("http://localhost/api/onboarding"), route)).json()) as OnboardingState

    expect(other.dismissed).toBe(false)
    expect(other.steps.find((step) => step.id === "glossary")?.status).toBe("todo")
  })

  it("shows admin-only steps as unavailable to members", async () => {
    setRouteCtx(await createTestCtx({ role: "member", meetings: [] }))

    const state = (await (await GET(new Request("http://localhost/api/onboarding"), route)).json()) as OnboardingState

    expect(state.steps.filter((step) => step.status === "unavailable").map((step) => step.id)).toEqual(["invite", "glossary"])
  })

  it("rejects invalid actions and API keys", async () => {
    expect((await post({ action: "skip", step: "nope" })).status).toBe(400)

    setRouteCtx(await createTestCtx({ principal: "api_key", role: "admin" }))

    for (const response of [await GET(new Request("http://localhost/api/onboarding"), route), await post({ action: "dismiss" })]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ reason: "user_required" })
    }
  })
})
