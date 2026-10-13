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

/**
 * M8 Step 0: the token-in-body Notion export is replaced by a stub behind
 * its final guard (`meeting:write`, no admin check). Package C rewrites this
 * test with the connection-backed export (docs/parity/m8.md, C1).
 */

const BASE = "http://localhost"
const fetchMock = vi.fn()

async function callExport(
  body: Record<string, unknown>,
  options: Parameters<typeof createTestCtx>[0] = {}
) {
  setRouteCtx(
    await createTestCtx({
      meetings: [testMeeting({ id: "m_shared", title: "Shared", visibility: "workspace" })],
      ...options,
    })
  )

  return exportNotion(
    jsonRequest(`${BASE}/api/meetings/m_shared/export/notion`, "POST", body),
    routeParams({ id: "m_shared" })
  )
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("NOTION_TOKEN", "secret_operator_token")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  setRouteCtx(undefined)
})

describe("POST /api/meetings/:id/export/notion (M8 Step 0 stub)", () => {
  it("rejects viewers (needs meeting:write)", async () => {
    const response = await callExport({ databaseId: "db_1" }, { role: "viewer" })

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("no longer requires an admin, and never uses a body token or NOTION_TOKEN", async () => {
    for (const role of ["member", "admin"] as const) {
      const response = await callExport({ databaseId: "db_1", token: "secret_user" }, { role })

      expect(response.status, role).toBe(501)
      expect(await response.json()).toEqual({ error: "not_implemented" })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
