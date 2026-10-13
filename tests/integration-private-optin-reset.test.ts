import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

import { PATCH as patchVisibility } from "@/app/api/meetings/[id]/visibility/route"
import type { AuthContext } from "@/lib/auth/authz"
import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"
import { resetPrivateOptInForVisibilityChange } from "@/lib/integrations/core/prefs-reset"
import { setIntegrationStoreForTesting, type IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"

/**
 * M8 review fix #5: an `allow_private_push` opt-in set while the meeting was
 * workspace-visible must not silently allow integrations once the meeting
 * becomes private. Making a meeting private resets the opt-in, so the owner
 * has to opt in again knowingly (ownership changes are already covered: the
 * gate requires the opt-in to be set by the CURRENT owner).
 */

const BASE = "http://localhost"
let store: IntegrationStore

function stubVisibility(ctx: AuthContext) {
  return vi.spyOn(ctx.meetings, "updateMeetingVisibility").mockImplementation(async (id: string, visibility: MeetingVisibility) => {
    const meeting = (await ctx.meetings.getMeeting(id)) as MeetingRecord

    return { ...meeting, visibility }
  })
}

beforeEach(async () => {
  store = createMemoryIntegrationStore()
  setIntegrationStoreForTesting(store)
  setRouteCtx(undefined)
})

afterEach(() => {
  setIntegrationStoreForTesting(undefined)
})

describe("private opt-in reset on visibility change", () => {
  async function ctxWith(visibility: MeetingVisibility) {
    const ctx = await createTestCtx({ meetings: [testMeeting({ id: "m_mine", ownerUserId: "user_me", visibility })] })

    stubVisibility(ctx)
    setRouteCtx(ctx)
    return ctx
  }

  it("clears an opt-in set while the meeting was workspace-visible when it becomes private", async () => {
    await ctxWith("workspace")
    await store.upsertPrefs("ws_a", "m_mine", { allowPrivatePush: true, allowPrivateSetByUserId: "user_me", updatedByUserId: "user_me" })

    const response = await patchVisibility(
      jsonRequest(`${BASE}/api/meetings/m_mine/visibility`, "PATCH", { visibility: "private" }),
      routeParams({ id: "m_mine" })
    )

    expect(response.status).toBe(200)

    const prefs = await store.getPrefs("ws_a", "m_mine")

    expect(prefs?.allowPrivatePush).toBe(false)
    expect(
      evaluatePrivacyGate({ facts: { visibility: "private", ownerUserId: "user_me" }, origin: "manual", ...(prefs ? { prefs } : {}) })
    ).toEqual({ allowed: false, reason: "private_meeting" })
  })

  it("keeps the opt-in when the meeting stays shared or was already private", async () => {
    await ctxWith("link")
    await store.upsertPrefs("ws_a", "m_mine", { allowPrivatePush: true, allowPrivateSetByUserId: "user_me", updatedByUserId: "user_me" })

    await patchVisibility(jsonRequest(`${BASE}/api/meetings/m_mine/visibility`, "PATCH", { visibility: "workspace" }), routeParams({ id: "m_mine" }))
    expect((await store.getPrefs("ws_a", "m_mine"))?.allowPrivatePush).toBe(true)

    await resetPrivateOptInForVisibilityChange({ workspaceId: "ws_a", meetingId: "m_mine", from: "private", to: "private" }, store)
    expect((await store.getPrefs("ws_a", "m_mine"))?.allowPrivatePush).toBe(true)
  })

  it("keeps the email recap preference while clearing the opt-in", async () => {
    await store.upsertPrefs("ws_a", "m_mine", { allowPrivatePush: true, allowPrivateSetByUserId: "user_me", emailRecap: "on", updatedByUserId: "user_me" })

    await resetPrivateOptInForVisibilityChange({ workspaceId: "ws_a", meetingId: "m_mine", from: "workspace", to: "private" }, store)

    expect(await store.getPrefs("ws_a", "m_mine")).toMatchObject({ allowPrivatePush: false, emailRecap: "on" })
    expect((await store.getPrefs("ws_a", "m_mine"))?.allowPrivateSetByUserId).toBeUndefined()
  })

  it("does not create a prefs row for a meeting without one", async () => {
    await resetPrivateOptInForVisibilityChange({ workspaceId: "ws_a", meetingId: "m_none", from: "workspace", to: "private" }, store)

    expect(await store.getPrefs("ws_a", "m_none")).toBeUndefined()
  })
})
