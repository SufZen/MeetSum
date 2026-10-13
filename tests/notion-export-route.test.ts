import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }))

import { POST as exportNotion } from "@/app/api/meetings/[id]/export/notion/route"

const BASE = "http://localhost"
const fetchMock = vi.fn()

function meetings() {
  return [
    testMeeting({ id: "m_shared", title: "Shared", visibility: "workspace" }),
    testMeeting({
      id: "m_private",
      title: "Private",
      visibility: "private",
      ownerUserId: "user_owner",
    }),
  ]
}

async function callExport(
  meetingId: string,
  body: Record<string, unknown>,
  options: Parameters<typeof createTestCtx>[0] = {}
) {
  setRouteCtx(await createTestCtx({ meetings: meetings(), ...options }))

  return exportNotion(
    jsonRequest(`${BASE}/api/meetings/${meetingId}/export/notion`, "POST", body),
    routeParams({ id: meetingId })
  )
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ id: "page_1", url: "https://notion.so/page_1" }), {
      status: 200,
    })
  )
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("NOTION_TOKEN", "secret_operator_token")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  setRouteCtx(undefined)
})

describe("POST /api/meetings/:id/export/notion", () => {
  it("rejects viewers (needs meeting:write)", async () => {
    const response = await callExport(
      "m_shared",
      { databaseId: "db_1", token: "secret_user" },
      { role: "viewer" }
    )

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects members (needs integrations:manage)", async () => {
    const response = await callExport(
      "m_shared",
      { databaseId: "db_1", token: "secret_user" },
      { role: "member" }
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "Forbidden",
      permission: "integrations:manage",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("never falls back to the server NOTION_TOKEN", async () => {
    const response = await callExport("m_shared", { databaseId: "db_1" }, { role: "admin" })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("exports with the caller's own token for admins", async () => {
    const response = await callExport(
      "m_shared",
      { databaseId: "db_1", token: "secret_user" },
      { role: "admin" }
    )

    expect(response.status).toBe(201)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe("Bearer secret_user")
  })

  it("404s a private meeting the admin cannot see", async () => {
    const response = await callExport(
      "m_private",
      { databaseId: "db_1", token: "secret_user" },
      { role: "admin" }
    )

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("404s a meeting of another workspace", async () => {
    const response = await callExport(
      "m_shared",
      { databaseId: "db_1", token: "secret_user" },
      { role: "admin", workspaceId: "ws_b" }
    )

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
