import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestCtx,
  jsonRequest,
  routeParams,
  setRouteCtx,
  testMeeting,
} from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

import {
  PATCH as patchShare,
  POST as createShare,
} from "@/app/api/meetings/[id]/share/route"
import { PATCH as patchVisibility } from "@/app/api/meetings/[id]/visibility/route"
import type { AuthContext } from "@/lib/auth/authz"
import type {
  MeetingRecord,
  MeetingVisibility,
} from "@/lib/meetings/repository"
import { updateAppSettings } from "@/lib/settings/app-settings"

const BASE = "http://localhost"

function meetings() {
  return [
    testMeeting({
      id: "m_ws",
      ownerUserId: "user_owner",
      visibility: "workspace",
    }),
    testMeeting({
      id: "m_mine",
      ownerUserId: "user_me",
      visibility: "workspace",
    }),
    testMeeting({ id: "m_link", ownerUserId: "user_me", visibility: "link" }),
    testMeeting({
      id: "m_hidden",
      ownerUserId: "user_owner",
      visibility: "private",
    }),
    testMeeting({
      id: "m_other_ws",
      workspaceId: "ws_b",
      ownerUserId: "user_me",
    }),
  ]
}

/** Stubs the repository visibility update (Package B implements it). */
function stubVisibility(ctx: AuthContext) {
  return vi
    .spyOn(ctx.meetings, "updateMeetingVisibility")
    .mockImplementation(async (id: string, visibility: MeetingVisibility) => {
      const meeting = (await ctx.meetings.getMeeting(id)) as MeetingRecord

      return { ...meeting, visibility }
    })
}

beforeEach(async () => {
  setRouteCtx(undefined)
  await updateAppSettings("ws_a", { publicSharingEnabled: true })
})

describe("POST /api/meetings/:id/share", () => {
  it("forbids members who do not own the meeting (403)", async () => {
    setRouteCtx(await createTestCtx({ role: "member", meetings: meetings() }))

    const response = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_ws/share`, "POST", {}),
      routeParams({ id: "m_ws" })
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "Forbidden" })
  })

  it("404s invisible and other-workspace meetings, even for admins", async () => {
    setRouteCtx(await createTestCtx({ role: "admin", meetings: meetings() }))

    for (const id of ["m_hidden", "m_other_ws"]) {
      const response = await createShare(
        jsonRequest(`${BASE}/api/meetings/${id}/share`, "POST", {}),
        routeParams({ id })
      )

      expect(response.status).toBe(404)
    }
  })

  it("lets the owner share and switches the meeting to link visibility", async () => {
    const ctx = await createTestCtx({ role: "member", meetings: meetings() })
    const setVisibility = stubVisibility(ctx)
    setRouteCtx(ctx)

    const response = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_mine/share`, "POST", {}),
      routeParams({ id: "m_mine" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.url).toMatch(/^http:\/\/localhost\/share\//)
    expect(body.visibility).toBe("link")
    expect(setVisibility).toHaveBeenCalledWith("m_mine", "link")
  })

  it("lets admins share meetings they do not own", async () => {
    const ctx = await createTestCtx({ role: "admin", meetings: meetings() })
    stubVisibility(ctx)
    setRouteCtx(ctx)

    const response = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_ws/share`, "POST", {}),
      routeParams({ id: "m_ws" })
    )

    expect(response.status).toBe(200)
  })

  it("does not touch visibility when the meeting is already link", async () => {
    const ctx = await createTestCtx({ meetings: meetings() })
    const setVisibility = stubVisibility(ctx)
    setRouteCtx(ctx)

    const response = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_link/share`, "POST", {}),
      routeParams({ id: "m_link" })
    )

    expect(response.status).toBe(200)
    expect(setVisibility).not.toHaveBeenCalled()
  })

  it("respects the workspace public sharing setting", async () => {
    await updateAppSettings("ws_a", { publicSharingEnabled: false })
    setRouteCtx(await createTestCtx({ meetings: meetings() }))

    const response = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_link/share`, "POST", {}),
      routeParams({ id: "m_link" })
    )

    expect(response.status).toBe(403)
  })

  it("forbids read-scoped API keys from sharing", async () => {
    setRouteCtx(
      await createTestCtx({
        principal: "api_key",
        role: "viewer",
        apiKeyCreatedBy: "user_me",
        meetings: meetings(),
      })
    )

    const response = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_mine/share`, "POST", {}),
      routeParams({ id: "m_mine" })
    )

    expect(response.status).toBe(403)
  })
})

describe("share sections (M4)", () => {
  it("rejects unknown sections with 400 and keeps the recording out of defaults", async () => {
    const ctx = await createTestCtx({ role: "member", meetings: meetings() })
    stubVisibility(ctx)
    setRouteCtx(ctx)

    const bad = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_mine/share`, "POST", {
        includedSections: ["summary", "secrets"],
      }),
      routeParams({ id: "m_mine" })
    )

    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toContain("secrets")

    const created = await createShare(
      jsonRequest(`${BASE}/api/meetings/m_mine/share`, "POST", {}),
      routeParams({ id: "m_mine" })
    )

    expect((await created.json()).share.includedSections).not.toContain("media")
  })

  it("accepts media when it is listed explicitly", async () => {
    const ctx = await createTestCtx({ role: "member", meetings: meetings() })
    stubVisibility(ctx)
    setRouteCtx(ctx)

    await createShare(
      jsonRequest(`${BASE}/api/meetings/m_mine/share`, "POST", {}),
      routeParams({ id: "m_mine" })
    )

    const response = await patchShare(
      jsonRequest(`${BASE}/api/meetings/m_mine/share`, "PATCH", {
        includedSections: ["summary", " media ", "media"],
      }),
      routeParams({ id: "m_mine" })
    )

    expect(response.status).toBe(200)
    expect((await response.json()).share.includedSections).toEqual(["summary", "media"])
    expect(
      (
        await patchShare(
          jsonRequest(`${BASE}/api/meetings/m_mine/share`, "PATCH", { includedSections: "media" }),
          routeParams({ id: "m_mine" })
        )
      ).status
    ).toBe(400)
  })
})

describe("PATCH /api/meetings/:id/share", () => {
  it("forbids non-owner members (403)", async () => {
    setRouteCtx(await createTestCtx({ meetings: meetings() }))

    const response = await patchShare(
      jsonRequest(`${BASE}/api/meetings/m_ws/share`, "PATCH", {
        revoked: true,
      }),
      routeParams({ id: "m_ws" })
    )

    expect(response.status).toBe(403)
  })
})

describe("PATCH /api/meetings/:id/visibility", () => {
  it("validates the requested visibility", async () => {
    setRouteCtx(await createTestCtx({ meetings: meetings() }))

    const response = await patchVisibility(
      jsonRequest(`${BASE}/api/meetings/m_mine/visibility`, "PATCH", {
        visibility: "public",
      }),
      routeParams({ id: "m_mine" })
    )

    expect(response.status).toBe(400)
  })

  it("forbids members who do not own the meeting", async () => {
    setRouteCtx(await createTestCtx({ meetings: meetings() }))

    const response = await patchVisibility(
      jsonRequest(`${BASE}/api/meetings/m_ws/visibility`, "PATCH", {
        visibility: "private",
      }),
      routeParams({ id: "m_ws" })
    )

    expect(response.status).toBe(403)
  })

  it("404s meetings the caller cannot see", async () => {
    setRouteCtx(await createTestCtx({ role: "owner", meetings: meetings() }))

    const response = await patchVisibility(
      jsonRequest(`${BASE}/api/meetings/m_hidden/visibility`, "PATCH", {
        visibility: "workspace",
      }),
      routeParams({ id: "m_hidden" })
    )

    expect(response.status).toBe(404)
  })

  it("updates visibility for the owner", async () => {
    const ctx = await createTestCtx({ meetings: meetings() })
    const setVisibility = stubVisibility(ctx)
    setRouteCtx(ctx)

    const response = await patchVisibility(
      jsonRequest(`${BASE}/api/meetings/m_link/visibility`, "PATCH", {
        visibility: "workspace",
      }),
      routeParams({ id: "m_link" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meeting.visibility).toBe("workspace")
    expect(setVisibility).toHaveBeenCalledWith("m_link", "workspace")
  })
})
